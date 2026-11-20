import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeTreeDigest } from '../build/build-cache.mjs';
import { acquireClient, isolatedEnvironment, processManagementInfo, repoRoot } from './native-platform-runtime.mjs';
import { cloudCatalog as frozenCatalog } from './plugin-install-latency-catalog.mjs';
import { verifySample } from './plugin-install-latency-matrix.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const packages = ['agent-skill-eval', 'cli', 'plugin-core'];
const buildArtifactRoots = packages.flatMap((name) => [`packages/${name}/dist`, `packages/${name}/package.json`]);
const runtimeResources = ['packages/plugin-core/schemas', 'packages/cli/authoring/assets'];
const nativeClients = ['codex', 'pi', 'claude'];
const batch = {
  targets: ['claude', 'pi', 'codex', 'generic'],
  plugins: ['human-content', 'frontend-design', 'decision-kit'],
  declarations: 'empty', entry: 'tui',
};
const selectors = {
  query: { name: 'SHARED_NATIVE_PROBE_PLATFORMS', file: 'platforms/discovery' },
  scan: { name: 'INSTALL_POSIX_MARKER_SCAN_PLATFORMS', file: 'utils/native-cli' },
};
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

async function gitRevision(object) {
  const { stdout } = await exec('git', ['rev-parse', '--verify', object], { cwd: repoRoot });
  return stdout.trim();
}

function readPlatformList(text, declaration) {
  const matches = [...text.matchAll(new RegExp('^' + declaration + ' = \\[([^\\]\\n]*)\\];$', 'gmu'))];
  if (matches.length !== 1) throw new Error('unexpected-selector-declaration');
  const entries = matches[0][1].trim();
  const platforms = entries ? entries.split(',').map(entry => {
    const match = /^(['"])(darwin|linux|win32)\1$/u.exec(entry.trim());
    if (!match) throw new Error('unexpected-selector-platform');
    return match[2];
  }) : [];
  if (new Set(platforms).size !== platforms.length) throw new Error('duplicate-selector-platform');
  return { line: matches[0][0], platforms };
}

async function readSelectors() {
  return Promise.all(Object.entries(selectors).map(async ([key, { name, file }]) => {
    const sourcePath = `packages/cli/src/${file}.ts`;
    const bundledPath = `packages/cli/dist/src/${file}.js`;
    const source = await fs.readFile(path.join(repoRoot, sourcePath), 'utf8');
    const bundled = await fs.readFile(path.join(repoRoot, bundledPath), 'utf8');
    const sourceList = readPlatformList(source, `const ${name}: readonly NodeJS\\.Platform\\[\\]`);
    const bundledList = readPlatformList(bundled, `const ${name}`);
    if (JSON.stringify(sourceList.platforms) !== JSON.stringify(bundledList.platforms)) throw new Error(`stale-${key}-selector-build`);
    return { key, sourcePath, bundledPath, source, bundled, platforms: sourceList.platforms,
      sourceLine: sourceList.line, bundledLine: bundledList.line };
  }));
}

// Each arm uses the same complete build and installed dependencies. Change only
// its private copies of the source selectors and their emitted declarations.
async function makeArm(root, identity, definitions, enabled) {
  // The source checkout's runtime config reader takes priority over its emitted
  // copy. Keeping that sidecar in every arm makes the installed bytes comparable.
  for (const relative of [...buildArtifactRoots, ...runtimeResources]) {
    await fs.cp(path.join(repoRoot, relative), path.join(root, relative), { recursive: true, verbatimSymlinks: true });
  }
  for (const modules of ['node_modules', ...packages.map(name => `packages/${name}/node_modules`)]) {
    await fs.symlink(path.join(repoRoot, modules), path.join(root, modules), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const overrides = {};
  for (const { key, sourcePath, bundledPath, source, bundled, sourceLine, bundledLine, platforms } of definitions) {
    if (platforms.includes(process.platform) === enabled.includes(key)) continue;
    const selected = enabled.includes(key) ? [...platforms, process.platform] : platforms.filter(platform => platform !== process.platform);
    for (const [relative, text, line] of [[sourcePath, source, sourceLine], [bundledPath, bundled, bundledLine]]) {
      const changed = text.replace(line, line.slice(0, line.indexOf(' = ')) + ' = ' + JSON.stringify(selected) + ';');
      const file = path.join(root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, changed);
      overrides[relative] = hash(changed);
    }
  }
  return { ...identity, buildRoot: root, readCap: 4, selectorOverrides: overrides,
    runtimeResourcesDigest: `sha256:${await computeTreeDigest(root, runtimeResources)}`,
    artifactDigest: `sha256:${await computeTreeDigest(root, buildArtifactRoots)}` };
}

async function runPrivate(script, args, log, env = process.env) {
  const output = await fs.open(log, 'wx', 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(here, script), ...args], {
        env, cwd: repoRoot, stdio: ['ignore', output.fd, output.fd], windowsHide: true,
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await output.close();
  }
}

function diagnostics(rows) {
  return (rows ?? []).map(({ code }) => code).filter((code) => typeof code === 'string' && /^[\w-]{1,64}$/u.test(code));
}

function receiptEvidence(receipt) {
  if (!receipt) return null;
  return {
    ok: receipt.ok, errors: diagnostics(receipt.errors), blockers: diagnostics(receipt.blockers),
    targets: receipt.targets.map(({ pluginId, agent, scope, execution, observation, content, blockers, backendDiagnostics }) => ({
      pluginId, agent, scope, execution, observation, content, blockers: diagnostics(blockers), backendDiagnostics: diagnostics(backendDiagnostics),
    })),
  };
}

function sampleEvidence(report) {
  const owner = (value) => value && ({ pluginId: value.pluginId, platform: value.platform, scope: value.scope,
    sourceIdentity: value.sourceIdentity, contentDigest: value.nativeProjection?.contentDigest });
  const nativeState = report.completeReceipt?.targetResults?.map((target) => ({
    pluginId: target.pluginId, agent: target.agent,
    placements: (target.deploymentReceipts ?? target.backend?.deploymentReceipts ?? []).flatMap(({ after }) => after ? [{
      ownership: after.ownership, registration: after.registration, packageVersion: after.packageVersion,
      activation: after.configuration?.activation, consumerActivation: after.consumers?.map(({ activation }) => activation),
    }] : []),
  }));
  return {
    buildRevision: report.buildRevision, buildArtifactDigest: report.buildArtifactDigest, activeDigest: report.activeDigest,
    clientVersions: report.measuredClientVersions, error: report.error && { phase: report.error.phase, code: report.error.code },
    preview: receiptEvidence(report.preview), result: receiptEvidence(report.result),
    declarations: report.declarations && Object.fromEntries(Object.entries(report.declarations)
      .map(([scope, entry]) => [scope, entry.roots.map(({ pluginId }) => pluginId)])),
    skills: report.skillOutputs?.outputs.map(({ path, skill, files, owner: evidence }) => ({ path, skill, files, owner: owner(evidence) })),
    roles: report.installedRoleDigests, nativeState,
    nativePackages: report.nativePackages?.map(({ pluginId, agent, scope, package: relative, owner: evidence, manifests }) => ({
      pluginId, agent, scope, package: relative, owner: owner(evidence), versions: manifests.map(({ version }) => version),
    })),
  };
}

function publicIssues(issues) {
  return issues.map((issue) => issue.startsWith('runner error ') ? 'Worker reported an error'
    : issue.startsWith('sample unavailable or malformed ') ? 'Sample unavailable or malformed' : issue);
}

async function publishCampaign(raw, output, details) {
  const { plan, ...schedule } = await readJson(path.join(raw, 'plan.json'));
  const { catalog, arms, ...publicPlan } = plan;
  await writeJson(path.join(output, 'plan.json'), {
    ...schedule, plan: { ...publicPlan, arms: Object.fromEntries(Object.entries(arms)
      .map(([name, { buildRoot, ...arm }]) => [name, arm])) }, ...details,
  });
  const { samples, ...decision } = await readJson(path.join(raw, 'summary.json'));
  const publicSamples = [];
  for (const sample of samples) {
    const { raw: file, issues, ...summary } = sample;
    const report = file && await readJson(path.join(raw, path.basename(file))).catch(() => null);
    publicSamples.push({ ...summary, issues: publicIssues(issues), evidence: report ? sampleEvidence(report) : null });
  }
  await writeJson(path.join(output, 'summary.json'), { ...decision, samples: publicSamples });
  console.log(`Paired matrix ${decision.outcome}; ${samples.length} scheduled samples recorded.`);
}

async function main([catalogInput, outputInput, flag, ...extra]) {
  if (catalogInput === '--help') {
    console.log('Usage: node scripts/qualification/plugin-install-latency-cloud.mjs <frozen Catalog> <new public evidence directory> [--plan-only]');
    return;
  }
  if (!catalogInput || !outputInput || flag && flag !== '--plan-only' || extra.length) throw new Error('invalid-cloud-arguments');
  if (!['linux', 'win32'].includes(process.platform)) throw new Error('cloud-qualification-requires-linux-or-windows');
  const catalog = await fs.realpath(catalogInput);
  const output = path.resolve(outputInput);
  await fs.mkdir(output, { mode: 0o700 });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-install-cloud-'));
  let phase = 'inputs';
  try {
    const manifest = await fs.readFile(path.join(catalog, 'catalog-manifest.json'));
    if (hash(manifest) !== frozenCatalog.manifestDigest) throw new Error('unexpected-catalog-manifest');
    const processManagement = await processManagementInfo();
    const definitions = await readSelectors();
    const revision = await gitRevision('HEAD');
    if (process.env.EXPECTED_SOURCE_SHA && process.env.EXPECTED_SOURCE_SHA !== revision) throw new Error('unexpected-source-commit');
    const identity = { revision, sourceTree: await gitRevision('HEAD^{tree}') };
    const baseline = await makeArm(path.join(scratch, 'baseline'), identity, definitions, []);
    const checkoutResourcesDigest = `sha256:${await computeTreeDigest(repoRoot, runtimeResources)}`;
    if (baseline.runtimeResourcesDigest !== checkoutResourcesDigest) throw new Error('baseline-runtime-resources-mismatch');

    phase = 'acquisition';
    const clientVersions = {};
    const acquisitions = {};
    const directories = [];
    for (const client of nativeClients) {
      console.log(`Acquiring fixed public ${client} CLI.`);
      const { launcher, binDirectory, acquisition } = await acquireClient(client, path.join(scratch, client));
      clientVersions[client] = acquisition.version;
      acquisitions[client] = acquisition;
      if (client === 'pi' && process.platform === 'win32') {
        // AW resolves a verified .cmd next to the prefix's node_modules, so
        // the npm install's nested node_modules/.bin launcher is unsuitable.
        const { preparePublicClientPath } = await import('./native-platform-public-aw.mjs');
        const entry = await preparePublicClientPath({ platform: client, clientBin: binDirectory, launcher,
          project: repoRoot, env: isolatedEnvironment(scratch) });
        directories.push(path.dirname(entry));
      } else {
        directories.push(client === 'pi' ? path.join(binDirectory, 'node_modules', '.bin') : path.dirname(launcher.executable));
      }
    }
    // Windows ignores PATH key case and Node accepts only one variant.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    env.PATH = [...directories, path.dirname(process.execPath), process.env.PATH ?? process.env.Path].filter(Boolean).join(path.delimiter);
    const host = { platform: process.platform, arch: process.arch, release: os.release(), nodeVersion: process.version,
      availableParallelism: os.availableParallelism() };
    const plan = { mode: 'dedup', platform: process.platform, markerScans: false, catalog,
      activeDigest: frozenCatalog.activeDigest, clientVersions, scopes: ['user'], scenarios: { batch }, arms: { baseline } };

    phase = 'preflight';
    console.log('Verifying an untimed baseline batch with the real installed clients.');
    const preflight = path.join(scratch, 'preflight.json');
    const args = ['--output', preflight, '--build-root', baseline.buildRoot, '--build-revision', revision,
      '--expected-build-digest', baseline.artifactDigest, '--catalog', catalog, '--expected-active-digest', plan.activeDigest,
      '--entry', batch.entry, '--declarations', batch.declarations,
      ...batch.plugins.flatMap((plugin) => ['--plugin', plugin]), ...batch.targets.flatMap((target) => ['--target', target])];
    const preflightExit = await runPrivate('plugin-install-latency.mjs', args, path.join(scratch, 'preflight.log'), env);
    const report = await readJson(preflight);
    const { issues, metrics } = verifySample(report, { plan, scenario: batch, arm: baseline, host, caseName: 'batch' });
    await writeJson(path.join(output, 'preflight.json'), {
      exit: preflightExit, issues: publicIssues(issues), psStarts: metrics?.psStarts,
      markerScans: metrics?.posixMarkerScans, windowsJobHelperStarts: metrics?.windowsJobHelperStarts,
      catalog: frozenCatalog, processManagement, acquisitions, evidence: sampleEvidence(report),
    });
    if (preflightExit.code !== 0 || issues.length) throw new Error('baseline-preflight-failed');
    if (host.platform === 'win32' && !metrics.windowsJobHelperStarts) throw new Error('windows-job-helper-not-observed');
    plan.markerScans = host.platform === 'linux' && metrics.psStarts > 0;

    phase = 'build-variants';
    const variants = plan.markerScans ? { query: ['query'], scan: ['scan'], combined: ['query', 'scan'] } : { query: ['query'] };
    for (const [name, enabled] of Object.entries(variants)) {
      const arm = await makeArm(path.join(scratch, name), identity, definitions, enabled);
      if (arm.runtimeResourcesDigest !== baseline.runtimeResourcesDigest) throw new Error('variant-runtime-resources-mismatch');
      plan.arms[name] = arm;
    }
    const input = path.join(scratch, 'input.json');
    await writeJson(input, plan);
    phase = 'paired-matrix';
    const raw = path.join(scratch, 'matrix');
    const result = await runPrivate('plugin-install-latency-matrix.mjs', [input, raw, ...(flag ? [flag] : [])], path.join(scratch, 'matrix.log'), env);
    await publishCampaign(raw, output, { catalog: frozenCatalog, processManagement, acquisitions,
      scope: 'Hosted Linux/Windows 3×4 with Codex, Claude, Pi and Generic; Antigravity omitted without a qualified matching hosted CLI.' });
    if (result.code !== 0) process.exitCode = 1;
  } catch (error) {
    const code = [error.code, error.message].find((value) => typeof value === 'string' && /^[\w-]{1,64}$/u.test(value)) ?? 'qualification-error';
    await writeJson(path.join(output, 'failure.json'), { phase, code, download: error.evidence?.download });
    throw new Error(`${phase} failed (${code}); see the public evidence artifact.`);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
