import { execFile } from 'node:child_process';
import { Hash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { computeTreeDigest } from '../build/build-cache.mjs';
import { prepareEnvironment } from './native-platform-runtime.mjs';

const run = promisify(execFile);
const sourceId = 'official';
const referenceFixtureRevision = '53e39d212bab59251a88eeb3372c00ed1d63da6a';
const buildArtifactRoots = ['agent-skill-eval', 'cli', 'plugin-core'].flatMap((name) => [
  `packages/${name}/dist`,
  `packages/${name}/package.json`,
]);
const sha256DigestPattern = /^sha256:[\da-f]{64}$/u;
// Public roots from the install-timing qualification fixture.
const userRootPool = [
  'official/agent-content-toolkit',
  'official/agent-subagent',
  'official/browser-use',
  'official/codex-enhance',
  'official/dev-workflow',
  'official/frontend-design',
  'official/git-toolkit',
  'official/human-content',
];
const projectRoots = ['official/aw-development-toolkit', 'official/aw-skill-eval-runner'];
const targets = ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'gemini', 'generic', 'grok', 'opencode', 'pi'];
const plugins = ['human-content', 'agent-subagent'];
const usage = `Usage: node scripts/qualification/plugin-install-latency.mjs --build-root <built checkout>
  --catalog <local snapshot directory> --target <target> --plugin <plugin> [--output <JSON file>]
  [--build-revision <commit>] [--expected-active-digest <sha256:digest>]
  [--expected-build-digest <sha256:digest>]

Use the same snapshot for every sample. Each invocation activates it in a new
isolated home and prepares and executes one User install through the TUI.
The report records buildArtifactDigest from the CLI, Plugin Core and Agent
Skill Eval dist trees and package manifests. An expected build digest is
checked before loading the build.
The target client is discovered on PATH. The report is written to stdout
when --output is omitted. A measured blocked or partial receipt is reported
in JSON. Exit 1 indicates a qualification runner error.

Targets: ${targets.join(', ')}
Plugins: ${plugins.join(', ')}
`;

function readOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      'build-root': { type: 'string' },
      'build-revision': { type: 'string' },
      catalog: { type: 'string' },
      target: { type: 'string' },
      plugin: { type: 'string' },
      output: { type: 'string' },
      'expected-active-digest': { type: 'string' },
      'expected-build-digest': { type: 'string' },
    },
  });
  if (values.help) return null;
  if (!values['build-root'] || !values.catalog || !targets.includes(values.target) || !plugins.includes(values.plugin)) {
    throw new Error('Supply a built checkout, local Catalog, supported target and fixture plugin. See --help.');
  }
  const expectedActiveDigest = values['expected-active-digest'];
  if (expectedActiveDigest !== undefined && !sha256DigestPattern.test(expectedActiveDigest)) {
    throw new Error('--expected-active-digest must be a SHA-256 digest.');
  }
  const expectedBuildDigest = values['expected-build-digest'];
  if (expectedBuildDigest !== undefined && !sha256DigestPattern.test(expectedBuildDigest)) {
    throw new Error('--expected-build-digest must be a SHA-256 digest.');
  }
  const buildRevision = values['build-revision'];
  if (buildRevision !== undefined && !/^(?:[\da-f]{40}|[\da-f]{64})$/u.test(buildRevision)) {
    throw new Error('--build-revision must be a full Git commit ID.');
  }
  return {
    buildRoot: path.resolve(values['build-root']),
    buildRevision,
    catalog: path.resolve(values.catalog),
    target: values.target,
    plugin: values.plugin,
    expectedActiveDigest,
    expectedBuildDigest,
    output: values.output ? path.resolve(values.output) : null,
  };
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function intent(roots, logicalIdentity) {
  return {
    schemaVersion: 3,
    kind: 'aw-plugin-intents',
    sources: { [sourceId]: { logicalIdentity } },
    roots: roots.map((pluginId) => ({ pluginId })),
  };
}

function stageEvidence() {
  return { ms: null, transportScans: 0, nativeRunnerCalls: 0, nativeCalls: 0, commands: {},
    providerCalls: { path: 0, git: 0, gitRefProbe: 0 } };
}

function diagnostic(value) {
  return { code: value.code, ...(value.message ? { message: value.message } : {}) };
}

function receiptEvidence(receipt) {
  return {
    ok: receipt.ok,
    declarationChanged: receipt.declarationChanged,
    outputsMayHaveChanged: receipt.outputsMayHaveChanged,
    selection: receipt.selection,
    errors: receipt.errors.map(diagnostic),
    blockers: receipt.blockers.map(diagnostic),
    recoveryActions: receipt.recoveryActions,
    targets: receipt.targetResults.map((target) => ({
      pluginId: target.pluginId,
      agent: target.agent,
      scope: target.scope,
      execution: target.execution,
      observation: target.observation,
      content: target.content,
      delivery: target.delivery,
      blockers: target.blockers.map(diagnostic),
      recoveryActions: target.recoveryActions,
      backendDiagnostics: (target.deploymentReceipts ?? target.backend?.deploymentReceipts ?? [])
        .flatMap((deployment) => (deployment.diagnostics ?? []).map(diagnostic)),
    })),
  };
}

const commandWords = new Set([
  '--version', '-v', 'version', '--help', '-h', 'help', 'plugin', 'plugins', 'marketplace', 'marketplaces',
  'extensions', 'extension', 'list', 'ls', 'add', 'install', 'update', 'inspect', 'enable', 'disable',
  'config', 'get', 'api', 'GET', 'skills', 'serve',
]);

function commandLabel({ command, args }) {
  const words = args.filter((arg) => commandWords.has(arg)).slice(0, 4);
  return [path.basename(command), ...words].join(' ');
}

async function sample(input, env, project) {
  const { buildRoot, catalog, target, plugin, expectedActiveDigest, expectedBuildDigest } = input;
  const pluginId = `${sourceId}/${plugin}`;
  const stages = { sync: { ms: null, providerCalls: { path: 0, git: 0, gitRefProbe: 0 } },
    load: stageEvidence(), review: stageEvidence(),
    execute: stageEvidence(), discovery: stageEvidence() };
  const report = {
    schemaVersion: 1,
    host: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
    referenceFixtureRevision,
    target,
    plugin,
    scope: 'user',
    userRoots: userRootPool.filter((id) => id !== pluginId),
    projectRoots,
    stages,
    recoveryStages: [],
    clients: [],
    preview: null,
    result: null,
    error: null,
  };
  let phase = 'setup';
  let controller;
  const restore = [];
  const fromBuild = (relative) => import(pathToFileURL(path.join(buildRoot, 'packages/cli/dist/src', relative)));
  const timed = async (name, operation) => {
    phase = name;
    const start = performance.now();
    try {
      return await operation();
    } finally {
      stages[name].ms = Math.round(performance.now() - start);
    }
  };

  try {
    const hasGitMetadata = await fs.lstat(path.join(buildRoot, '.git')).then(() => true, (error) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (hasGitMetadata) {
      const { stdout } = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: buildRoot, env });
      report.buildRevision = stdout.trim();
      report.buildRevisionSource = 'checkout';
      if (input.buildRevision && input.buildRevision !== report.buildRevision) {
        throw new Error(`Expected build revision ${input.buildRevision}, got ${report.buildRevision}.`);
      }
    } else {
      report.buildRevision = input.buildRevision ?? null;
      report.buildRevisionSource = input.buildRevision ? 'argument' : null;
    }
    report.buildArtifactDigest = `sha256:${await computeTreeDigest(buildRoot, buildArtifactRoots)}`;
    if (expectedBuildDigest && expectedBuildDigest !== report.buildArtifactDigest) {
      throw new Error(`Expected build digest ${expectedBuildDigest}, got ${report.buildArtifactDigest}.`);
    }
    const [
      { createCliExecutionContext }, { createConsoleTuiV4Controller },
      { getDefaultNativeCliRunner, retainNativeCliRunnerBackend }, { discoverPlatform },
      { syncCatalogSourceGeneration }, { readCatalogGenerationState }, { readCliPackageInfo },
      { catalogPathProviderInternal }, { catalogGitProviderInternal },
    ] = await Promise.all([
      fromBuild('commands/runtime.js'), fromBuild('tui/controller-runtime.js'),
      fromBuild('utils/native-cli.js'), fromBuild('platforms/discovery.js'),
      fromBuild('utils/catalog-generation-service.js'), fromBuild('utils/catalog-generation-state.js'),
      fromBuild('utils/local-marketplace.js'), fromBuild('utils/path-catalog-provider.js'),
      fromBuild('utils/git-catalog-provider.js'),
    ]);
    report.buildVersion = (await readCliPackageInfo()).version;
    const catalogPath = await fs.realpath(catalog);
    const manifest = JSON.parse(await fs.readFile(path.join(catalogPath, 'catalog-manifest.json'), 'utf8'));
    report.catalogVersion = manifest.catalogVersion;
    report.catalogPlugins = manifest.entries.length;

    // These are the same provider boundaries observed by the existing perf suite.
    for (const [provider, method, counter] of [
      [catalogPathProviderInternal, 'resolve', 'path'],
      [catalogGitProviderInternal, 'resolve', 'git'],
      [catalogGitProviderInternal, 'probeRef', 'gitRefProbe'],
    ]) {
      const original = provider[method];
      provider[method] = function (...args) {
        if (stages[phase]) stages[phase].providerCalls[counter]++;
        return Reflect.apply(original, this, args);
      };
      restore.push(() => { provider[method] = original; });
    }

    await writeJson(path.join(env.AW_HOME, 'catalog-sources.json'), {
      schemaVersion: 2,
      sources: [{ id: sourceId, type: 'path', path: catalogPath, primary: true, autoCheck: false }],
    });
    await timed('sync', () => syncCatalogSourceGeneration({
      sourceId, cwd: project, env, cliVersion: report.buildVersion, impactConfirmed: true,
    }));
    phase = 'setup';
    if (stages.sync.providerCalls.path === 0) throw new Error('Local Catalog provider was not observed during fixture sync.');
    const active = (await readCatalogGenerationState(env)).sources[sourceId]?.active;
    if (!active) throw new Error('Local Catalog sync produced no Active snapshot.');
    report.activeDigest = active.snapshotDigest;
    report.catalogLogicalIdentity = active.logicalIdentity;
    if (expectedActiveDigest && expectedActiveDigest !== active.snapshotDigest) {
      throw new Error(`Expected Active digest ${expectedActiveDigest}, got ${active.snapshotDigest}.`);
    }

    // Bind public roots to the actual local snapshot identity.
    await fs.mkdir(path.join(project, '.agent-workflows'));
    await Promise.all([
      writeJson(path.join(env.AW_HOME, 'plugin-intents.json'), intent(report.userRoots, active.logicalIdentity)),
      writeJson(path.join(project, '.agent-workflows', 'plugin-intents.json'), intent(projectRoots, active.logicalIdentity)),
      writeJson(path.join(env.AW_HOME, 'deployment-preferences.json'), {
        schemaVersion: 2, kind: 'aw-deployment-preferences', targets: [target], exclusions: [],
      }),
    ]);

    // A completed Core transport digest is the hash of the whole snapshot.
    // Match the actual Active digest at the hashing boundary for all builds.
    const originalDigest = Hash.prototype.digest;
    const expectedHex = active.snapshotDigest.slice('sha256:'.length);
    Hash.prototype.digest = function (...args) {
      const result = Reflect.apply(originalDigest, this, args);
      if (result === expectedHex && stages[phase]) stages[phase].transportScans++;
      return result;
    };
    restore.push(() => { Hash.prototype.digest = originalDigest; });

    const nativeRunner = getDefaultNativeCliRunner();
    const countedRunner = retainNativeCliRunnerBackend((invocation) => {
      const evidence = stages[phase];
      if (!evidence) return nativeRunner(invocation);
      evidence.nativeRunnerCalls++;
      return nativeRunner({
        ...invocation,
        onSpawn(child) {
          const label = commandLabel(invocation);
          evidence.nativeCalls++;
          evidence.commands[label] = (evidence.commands[label] ?? 0) + 1;
          invocation.onSpawn?.(child);
        },
      });
    }, nativeRunner);
    controller = createConsoleTuiV4Controller(createCliExecutionContext({
      cwd: project, env, nativeCliRunner: countedRunner,
      reporter: { event: async () => {}, notice: async () => {} },
      debugLogger: { async log({ type, data }) {
        if (type !== 'performance:stage' || !data?.name?.startsWith('recovery.')
          || (phase !== 'review' && phase !== 'execute')) return;
        const { transportScans, nativeCalls } = stages[phase];
        report.recoveryStages.push({
          operation: phase,
          name: data.name,
          event: data.phase,
          durationMs: data.durationMs,
          transportScans,
          nativeCalls,
        });
      } },
    }));
    await timed('load', () => controller.load());
    if (controller.snapshot.phase !== 'ready') {
      throw new Error(`TUI failed to load: ${controller.snapshot.loadError?.code ?? controller.snapshot.phase}.`);
    }
    const plan = await timed('review', () => controller.prepareScopedTask({
      kind: 'recovery', command: 'install', scope: 'user', selectors: [pluginId],
    }));
    report.preview = receiptEvidence(plan.plan.receipt);
    const outcome = await timed('execute', () => controller.executeScopedTask(plan));
    if (outcome.kind !== 'recovery') {
      if (outcome.kind === 'recoveryReview') await controller.discardScopedPlan(outcome.plan);
      throw new Error(`Warm install returned ${outcome.kind} and did not finish in one Review.`);
    }
    report.result = receiptEvidence(outcome.receipt);
    const { inventoryRecoveryActions } = await fromBuild('commands/public-lifecycle-result.js');
    const diagnostics = outcome.receipt.targetResults.flatMap((item) => [...item.blockers, ...(item.reasons ?? [])]);
    report.result.manualRecoveryActions = inventoryRecoveryActions(diagnostics);
    const discovery = await timed('discovery', () => discoverPlatform(target, { cwd: project, env, runner: countedRunner }));
    report.clientAvailability = discovery.availability;
    report.clientDiagnostics = discovery.diagnostics.map(diagnostic);
    report.clients = discovery.installations.map((entry) => ({
      product: entry.product,
      version: entry.version,
      availability: entry.availability,
      executable: entry.entry?.kind === 'cli' ? entry.entry.executable : null,
    }));
    phase = 'verification';
    if (!stages.review.transportScans) throw new Error('No complete Active transport digest was observed during Review.');
    if ([stages.review, stages.execute].some((stage) => Object.values(stage.providerCalls).some(Boolean))) {
      throw new Error('The warm install called a Catalog provider.');
    }
  } catch (error) {
    report.error = { phase, code: error.code ?? error.name, message: error.message };
  } finally {
    phase = 'teardown';
    try {
      await controller?.dispose();
    } catch (error) {
      report.error ??= { phase, code: error.code ?? error.name, message: error.message };
    } finally {
      for (const dispose of restore.reverse()) dispose();
    }
  }
  const { review, execute } = stages;
  report.reviewMs = review.ms;
  report.executeMs = execute.ms;
  report.wallMs = review.ms === null || execute.ms === null ? null : review.ms + execute.ms;
  report.transportScans = { review: review.transportScans, execute: execute.transportScans,
    total: review.transportScans + execute.transportScans };
  report.nativeCalls = review.nativeCalls + execute.nativeCalls;
  report.nativeRunnerCalls = review.nativeRunnerCalls + execute.nativeRunnerCalls;
  report.providerCalls = { review: review.providerCalls, execute: execute.providerCalls };
  return report;
}

async function main() {
  if (process.argv[2] === '--worker') {
    const project = process.cwd();
    const root = path.dirname(project);
    if (!path.basename(root).startsWith('aw-install-latency-') || path.basename(project) !== 'project'
      || process.env.AW_HOME !== path.join(root, 'aw') || process.env.HOME !== path.join(root, 'home')) {
      throw new Error('The qualification worker requires the temporary project and homes created by the launcher.');
    }
    const input = JSON.parse(process.argv[3]);
    const report = await sample(input, process.env, project);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const input = readOptions(process.argv.slice(2));
  if (!input) {
    process.stdout.write(usage);
    return;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-install-latency-')));
  try {
    const env = await prepareEnvironment(root);
    delete env.CI;
    env.TERM = 'xterm-256color';
    env.OPENCODE_DISABLE_AUTOUPDATE = '1';
    env.OPENCODE_DISABLE_MODELS_FETCH = '1';
    env.PATH = env.PATH.split(path.delimiter).filter((directory) => path.isAbsolute(directory)).join(path.delimiter);
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    await run('git', ['init', '--quiet'], { cwd: project, env });
    const { stdout } = await run(process.execPath, [fileURLToPath(import.meta.url), '--worker', JSON.stringify(input)], {
      cwd: project, env, maxBuffer: 2 * 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    if (input.output) await writeJson(input.output, report);
    else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.error) {
      console.error(`Qualification failed during ${report.error.phase}: ${report.error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
