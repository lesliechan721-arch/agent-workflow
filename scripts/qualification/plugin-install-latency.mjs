import { execFile } from 'node:child_process';
import { Hash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { computeTreeDigest } from '../build/build-cache.mjs';
import { prepareEnvironment } from './native-platform-runtime.mjs';
import { commandLabel, observePortableWrites, observeProcesses, readNativePackages, readSkillOutputs } from './plugin-install-latency-observation.mjs';

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
const targets = ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'generic', 'grok', 'opencode', 'pi'];
const namePattern = /^[a-z0-9][a-z0-9-]*$/u;
const usage = `Usage: node scripts/qualification/plugin-install-latency.mjs --build-root <built checkout>
  --catalog <local snapshot directory> --target <target>... --plugin <plugin>... [--output <JSON file>]
  [--entry tui|cli] [--declarations populated|empty] [--source <id=local snapshot directory>...]
  [--build-revision <commit>] [--expected-active-digest <sha256:digest>]
  [--expected-build-digest <sha256:digest>]

Repeat --plugin and --target for a batch. Bare plugin names select the official
source from --catalog. Use source/name for another local snapshot from --source.
Each invocation activates the snapshots in an isolated home and prepares and
executes one User install. TUI and populated declarations are the defaults.
The report records buildArtifactDigest from the CLI, Plugin Core and Agent
Skill Eval dist trees and package manifests. An expected build digest is
checked before loading the build. The expected Active digest binds --catalog.
Target clients are discovered on PATH. The report is written to stdout
when --output is omitted. A measured blocked or partial receipt is reported
in JSON. Exit 1 indicates a qualification runner error.

Targets: ${targets.join(', ')}
`;

function readOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      'build-root': { type: 'string' },
      'build-revision': { type: 'string' },
      catalog: { type: 'string' },
      target: { type: 'string', multiple: true },
      plugin: { type: 'string', multiple: true },
      source: { type: 'string', multiple: true, default: [] },
      entry: { type: 'string', default: 'tui' },
      declarations: { type: 'string', default: 'populated' },
      output: { type: 'string' },
      'expected-active-digest': { type: 'string' },
      'expected-build-digest': { type: 'string' },
    },
  });
  if (values.help) return null;
  if (!values['build-root'] || !values.catalog || !values.target?.length || !values.plugin?.length
    || values.target.some((target) => !targets.includes(target))) {
    throw new Error('Supply a built checkout, local Catalog, targets and plugins. See --help.');
  }
  if (!['tui', 'cli'].includes(values.entry) || !['populated', 'empty'].includes(values.declarations)) {
    throw new Error('Choose a supported entry and declarations fixture. See --help.');
  }
  const catalogs = { [sourceId]: path.resolve(values.catalog) };
  for (const source of values.source) {
    const delimiter = source.indexOf('=');
    const id = source.slice(0, delimiter);
    if (delimiter < 1 || delimiter === source.length - 1 || !namePattern.test(id) || Object.hasOwn(catalogs, id)) {
      throw new Error('Each --source must supply a unique source ID and local path in id=path form.');
    }
    catalogs[id] = path.resolve(source.slice(delimiter + 1));
  }
  const selectors = values.plugin.map((plugin) => plugin.includes('/') ? plugin : `${sourceId}/${plugin}`);
  for (const selector of selectors) {
    const [id, plugin, extra] = selector.split('/');
    if (!namePattern.test(plugin) || !Object.hasOwn(catalogs, id) || extra !== undefined) {
      throw new Error('Each --plugin must name a plugin in a configured local source.');
    }
  }
  if (new Set(values.target).size !== values.target.length || new Set(selectors).size !== selectors.length) {
    throw new Error('Supply each target and plugin only once.');
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
    catalogs,
    measuredTargets: values.target,
    selectors,
    entry: values.entry,
    declarations: values.declarations,
    expectedActiveDigest,
    expectedBuildDigest,
    output: values.output ? path.resolve(values.output) : null,
  };
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, (_key, entry) =>
    entry instanceof Set ? { $set: [...entry] } : entry instanceof Map ? { $map: [...entry] } : entry, 2)}\n`);
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
  return { ms: null, transportScans: 0, nativeRunnerCalls: 0, nativeCalls: 0, commands: {}, processes: [],
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

async function sample(input, env, project) {
  const { buildRoot, measuredTargets, selectors, expectedActiveDigest, expectedBuildDigest } = input;
  const populated = input.declarations === 'populated';
  const stages = { sync: stageEvidence(), load: stageEvidence(), review: stageEvidence(),
    execute: stageEvidence(), discovery: stageEvidence() };
  const report = {
    schemaVersion: 1,
    host: { platform: process.platform, arch: process.arch, nodeVersion: process.version,
      availableParallelism: os.availableParallelism(), loadAverage: os.loadavg(), freeMemoryBytes: os.freemem() },
    referenceFixtureRevision,
    target: measuredTargets[0],
    plugin: selectors[0].split('/')[1],
    measuredTargets,
    batchRoots: selectors,
    entry: input.entry,
    declarationsFixture: input.declarations,
    scope: 'user',
    userRoots: populated ? userRootPool.filter((id) => !selectors.includes(id)).slice(0, 7) : [],
    projectRoots: populated ? projectRoots : [],
    stages,
    recoveryStages: [],
    portableWrites: [],
    clients: [],
    preview: null,
    result: null,
    error: null,
  };
  let phase = 'setup';
  let controller;
  let measuredReceipt;
  const restore = [];
  const isolatedRoot = path.dirname(project);
  const fromBuild = (relative) => import(pathToFileURL(path.join(buildRoot, 'packages/cli/dist/src', relative)));
  const startTiming = (name) => {
    phase = name;
    stages[name].startedMs = performance.now();
    return process.cpuUsage();
  };
  const finishTiming = (name, startCpu) => {
    Object.assign(stages[name], {
      ms: Math.round(performance.now() - stages[name].startedMs),
      cpuMicroseconds: process.cpuUsage(startCpu),
    });
  };
  const timed = async (name, operation) => {
    const startCpu = startTiming(name);
    try {
      return await operation();
    } finally {
      finishTiming(name, startCpu);
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
    const catalogs = {};
    report.sources = {};
    for (const [id, directory] of Object.entries(input.catalogs)) {
      const catalogPath = await fs.realpath(directory);
      const manifest = JSON.parse(await fs.readFile(path.join(catalogPath, 'catalog-manifest.json'), 'utf8'));
      catalogs[id] = { path: catalogPath, entries: manifest.entries };
      report.sources[id] = { catalogVersion: manifest.catalogVersion, plugins: manifest.entries.length };
    }
    report.catalogVersion = report.sources[sourceId].catalogVersion;
    report.catalogPlugins = report.sources[sourceId].plugins;

    restore.push(observeProcesses(() => stages[phase]));
    if (measuredTargets.includes('generic')) {
      restore.push(observePortableWrites(buildRoot, isolatedRoot, () => phase, report.portableWrites));
    }

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
      sources: Object.entries(catalogs).map(([id, catalog]) => ({
        id, type: 'path', path: catalog.path, primary: id === sourceId, autoCheck: false,
      })),
    });
    await timed('sync', async () => {
      for (const id of Object.keys(catalogs)) {
        await syncCatalogSourceGeneration({ sourceId: id, cwd: project, env, cliVersion: report.buildVersion, impactConfirmed: true });
      }
    });
    phase = 'setup';
    if (stages.sync.providerCalls.path === 0) throw new Error('Local Catalog provider was not observed during fixture sync.');
    const state = await readCatalogGenerationState(env);
    for (const id of Object.keys(catalogs)) {
      const active = state.sources[id]?.active;
      if (!active) throw new Error(`Local Catalog sync produced no Active snapshot for ${id}.`);
      report.sources[id].activeDigest = active.snapshotDigest;
      report.sources[id].logicalIdentity = active.logicalIdentity;
    }
    report.activeDigest = report.sources[sourceId].activeDigest;
    report.catalogLogicalIdentity = report.sources[sourceId].logicalIdentity;
    if (expectedActiveDigest && expectedActiveDigest !== report.activeDigest) {
      throw new Error(`Expected Active digest ${expectedActiveDigest}, got ${report.activeDigest}.`);
    }

    // Bind public roots to the actual local snapshot identity.
    await fs.mkdir(path.join(project, '.agent-workflows'));
    await Promise.all([
      writeJson(path.join(env.AW_HOME, 'plugin-intents.json'), intent(report.userRoots, report.catalogLogicalIdentity)),
      writeJson(path.join(project, '.agent-workflows', 'plugin-intents.json'), intent(report.projectRoots, report.catalogLogicalIdentity)),
      writeJson(path.join(env.AW_HOME, 'deployment-preferences.json'), {
        schemaVersion: 2, kind: 'aw-deployment-preferences', targets: measuredTargets, exclusions: [],
      }),
    ]);

    // A completed Core transport digest is the hash of the whole snapshot.
    // Match the actual Active digest at the hashing boundary for all builds.
    const originalDigest = Hash.prototype.digest;
    const expectedHex = new Set(Object.values(report.sources).map((source) => source.activeDigest.slice('sha256:'.length)));
    Hash.prototype.digest = function (...args) {
      const result = Reflect.apply(originalDigest, this, args);
      if (expectedHex.has(result) && stages[phase]) stages[phase].transportScans++;
      return result;
    };
    restore.push(() => { Hash.prototype.digest = originalDigest; });

    const nativeRunner = getDefaultNativeCliRunner();
    const countedRunner = retainNativeCliRunnerBackend(async (invocation) => {
      const evidence = stages[phase];
      if (!evidence) return nativeRunner(invocation);
      evidence.nativeRunnerCalls++;
      let spawnedProcess;
      try {
        return await nativeRunner({
          ...invocation,
          onSpawn(child) {
            const label = commandLabel(invocation);
            spawnedProcess = evidence.processes.findLast((call) => call.pid === child.pid);
            if (spawnedProcess) spawnedProcess.nativeLabel = label;
            evidence.nativeCalls++;
            evidence.commands[label] = (evidence.commands[label] ?? 0) + 1;
            invocation.onSpawn?.(child);
          },
        });
      } catch (error) {
        if (spawnedProcess) {
          spawnedProcess.nativeError = error.reason ?? error.code ?? error.name;
          if (error.cleanupError) spawnedProcess.cleanupUnconfirmed = true;
        }
        throw error;
      }
    }, nativeRunner);

    let cliTiming;
    const runtime = {
      cwd: project, env, nativeCliRunner: countedRunner,
      reporter: { event: async () => {}, notice: async () => {} },
      debugLogger: { async log({ type, data }) {
        if (type !== 'performance:stage' || (phase !== 'review' && phase !== 'execute')) return;
        if (input.entry === 'cli' && phase === 'review' && data?.name === 'recovery.lock.wait' && data.phase === 'start') {
          finishTiming('review', cliTiming);
          cliTiming = startTiming('execute');
        }
        if (!/^(recovery|status)\./u.test(data?.name ?? '')) return;
        const { transportScans, nativeCalls } = stages[phase];
        report.recoveryStages.push({
          operation: phase,
          observedAtMs: performance.now(),
          name: data.name,
          event: data.phase,
          durationMs: data.durationMs,
          transportScans,
          nativeCalls,
        });
      } },
    };
    if (input.entry === 'cli') {
      const { runCli } = await fromBuild('index.js');
      let stdout = '';
      let stderr = '';
      const argv = ['plugin', 'install', ...selectors, '--scope', 'user', '--yes', '--json',
        ...measuredTargets.flatMap((target) => ['--target', target])];
      cliTiming = startTiming('review');
      try {
        report.cli = { exitCode: await runCli(argv, { ...runtime, interactive: false,
          io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } } }), argv, stderr };
      } finally {
        finishTiming(phase, cliTiming);
      }
      measuredReceipt = JSON.parse(stdout);
      report.result = {
        ok: measuredReceipt.status === 'success',
        diagnostics: measuredReceipt.diagnostics,
        targets: (measuredReceipt.data?.targetResults ?? []).map((target) => ({ ...target, agent: target.target })),
      };
    } else {
      controller = createConsoleTuiV4Controller(createCliExecutionContext(runtime));
      await timed('load', () => controller.load());
      if (controller.snapshot.phase !== 'ready') {
        throw new Error(`TUI failed to load: ${controller.snapshot.loadError?.code ?? controller.snapshot.phase}.`);
      }
      const plan = await timed('review', () => controller.prepareScopedTask({
        kind: 'recovery', command: 'install', scope: 'user', selectors,
      }));
      report.preview = receiptEvidence(plan.plan.receipt);
      report.completePreviewReceipt = structuredClone(plan.plan.receipt);
      const outcome = await timed('execute', () => controller.executeScopedTask(plan));
      if (outcome.kind !== 'recovery') {
        if (outcome.kind === 'recoveryReview') await controller.discardScopedPlan(outcome.plan);
        throw new Error(`Warm install returned ${outcome.kind} and did not finish in one Review.`);
      }
      measuredReceipt = outcome.receipt;
      report.result = receiptEvidence(measuredReceipt);
      const { inventoryRecoveryActions } = await fromBuild('commands/public-lifecycle-result.js');
      const diagnostics = measuredReceipt.targetResults.flatMap((item) => [...item.blockers, ...(item.reasons ?? [])]);
      report.result.manualRecoveryActions = inventoryRecoveryActions(diagnostics);
    }
    report.completeReceipt = measuredReceipt;
    const discoveries = await timed('discovery', () => Promise.all(measuredTargets.map(async (target) => {
      const discovery = await discoverPlatform(target, { cwd: project, env, runner: countedRunner });
      return [target, discovery];
    })));
    const [, discovery] = discoveries[0];
    report.clientAvailability = discovery.availability;
    report.clientDiagnostics = discovery.diagnostics.map(diagnostic);
    report.measuredClients = Object.fromEntries(discoveries.map(([target, value]) => [target, value.installations.map((entry) => ({
      product: entry.product, version: entry.version, availability: entry.availability,
      executable: entry.entry?.kind === 'cli' ? entry.entry.executable : null,
    }))]));
    report.clients = report.measuredClients[measuredTargets[0]];
    report.measuredClientVersions = Object.fromEntries(Object.entries(report.measuredClients).map(([target, clients]) =>
      [target, clients.map((entry) => entry.version)]));
    phase = 'verification';
    report.declarations = {
      user: JSON.parse(await fs.readFile(path.join(env.AW_HOME, 'plugin-intents.json'), 'utf8')),
      project: JSON.parse(await fs.readFile(path.join(project, '.agent-workflows', 'plugin-intents.json'), 'utf8')),
    };
    report.skillOutputs = await readSkillOutputs(catalogs,
      [...new Set([...selectors, ...report.result.targets.map((target) => target.pluginId)])], isolatedRoot);
    report.nativePackages = await readNativePackages(measuredReceipt.targetResults ?? measuredReceipt.data?.targetResults ?? [], isolatedRoot);
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
  report.host.workerPeakRssKiB = process.resourceUsage().maxRSS;
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
    await writeJson(path.join(root, 'sample.json'), report);
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
    await run(process.execPath, [fileURLToPath(import.meta.url), '--worker', JSON.stringify(input)], { cwd: project, env });
    const rawReport = await fs.readFile(path.join(root, 'sample.json'), 'utf8');
    const report = JSON.parse(rawReport);
    if (input.output) await fs.writeFile(input.output, rawReport);
    else process.stdout.write(rawReport);
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
