import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { brotliDecompressSync } from 'node:zlib';
import { acquireClient, execute, prepareEnvironment, repoRoot } from './native-platform-runtime.mjs';

const version = '1.0.77';
const npmPackage = '@xai-official/grok';
const windowsPackage = '@xai-official/grok-win32-x64';
const packageIntegrity = 'sha512-zNGi+PGXR/cxL3URtxEIHX91Lm06jOb28ra98FWEO9keIJOO83Pr67rpmLtwufp7A51NvMM4Nm0Kh77/9l9rQg==';
const windowsIntegrity = 'sha512-suC0MKHxQ5fQt7bVpAqFl1pdUMS35AOZiecDi+dIUKhYhrB+3cjpyLXUeCnUyS+nqZNyMnHl2dZMZpYM+chKfw==';
const preload = new URL('./grok-windows-target-preload.mjs', import.meta.url).href;
const codes = new Set(['targetUnavailable', 'clientNotFound', 'clientProbeFailed', 'clientVersionUnknown',
  'clientVersionUnsupported', 'clientInstallInterfaceUnsupported', 'clientIdentityUnconfirmed',
  'nativeCliTimedOut', 'nativeCliFailed', 'nativeCliExecutableMissing', 'operationFailed']);
const facts = { schemaVersion: 1, version, cases: [], temporaryFilesRemoved: false };
const isSet = (value) => Array.isArray(value) && value.length === 1 && value[0] === 'grok';

async function optionalRead(file, encoding) {
  try { return await fs.readFile(file, encoding); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function confirmChildExit(pid) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { return error.code === 'ESRCH'; }
    await delay(20);
  }
  return false;
}

async function acquire(root) {
  const { launcher, acquisition, binDirectory } = await acquireClient('grok', path.join(root, 'acquisition'));
  const lock = JSON.parse(await fs.readFile(path.join(binDirectory, 'package-lock.json'), 'utf8'));
  const packageRoot = path.join(binDirectory, 'node_modules', npmPackage);
  const windowsRoot = path.join(binDirectory, 'node_modules', windowsPackage);
  const parent = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const windows = JSON.parse(await fs.readFile(path.join(windowsRoot, 'package.json'), 'utf8'));
  const locked = (name, integrity) => lock.packages?.[`node_modules/${name}`]?.integrity === integrity
    && lock.packages?.[`node_modules/${name}`]?.version === version;
  const entry = await fs.realpath(path.join(packageRoot, 'bin', 'grok'));
  if (!locked(npmPackage, packageIntegrity) || !locked(windowsPackage, windowsIntegrity)
      || acquisition.package !== npmPackage || parent.version !== version
      || parent.bin?.grok !== 'bin/grok' || parent.optionalDependencies?.[windowsPackage] !== version
      || windows.name !== windowsPackage || windows.version !== version
      || launcher.executable !== process.execPath || launcher.prefix.length !== 1 || launcher.prefix[0] !== entry) {
    throw new Error('officialPackageIdentityUnconfirmed');
  }
  const portableBinary = path.join(windowsRoot, 'bin', 'grok.exe');
  const bytes = await optionalRead(portableBinary) ?? brotliDecompressSync(await fs.readFile(portableBinary + '.br'));
  if (bytes.readUInt16LE(0) !== 0x5a4d || bytes.readUInt32LE(bytes.readUInt32LE(0x3c)) !== 0x4550
      || bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) {
    throw new Error('officialWindowsX64ImageUnconfirmed');
  }

  // Expose the verified, unchanged npm entry via AW's standard prefix shim.
  const shim = path.join(binDirectory, 'grok.cmd');
  const { renderNpmCmdShim } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
  await fs.writeFile(shim, renderNpmCmdShim(path.relative(binDirectory, entry)), { flag: 'wx' });
  return { entry, shim: await fs.realpath(shim), binDirectory, bytes };
}

async function readCase(root, repo, client, row, delayedProbe) {
  await fs.mkdir(root);
  const env = await prepareEnvironment(root);
  const grokBin = path.join(env.GROK_HOME, 'bin');
  await fs.mkdir(grokBin);
  // Prepare the same official binary in each private Grok home. This removes
  // archive extraction from the startup comparison and avoids package writes.
  await fs.writeFile(path.join(grokBin, 'grok.exe'), client.bytes, { flag: 'wx' });
  env.PATH = [client.binDirectory, path.dirname(process.execPath), path.join(env.SystemRoot, 'System32')].join(path.delimiter);
  env.GROK_DIAG_ENTRY = client.entry;
  env.GROK_DIAG_TRACE = path.join(root, 'probe.ndjson');
  if (delayedProbe) {
    env.GROK_DIAG_DELAY = delayedProbe;
    env.GROK_DIAG_GATE = path.join(root, 'gate');
  }
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const prefFile = path.join(env.AW_HOME, 'deployment-preferences.json');
  if (await optionalRead(prefFile) !== undefined) throw new Error('preferencesNotInitiallyAbsent');
  const started = performance.now();
  try {
    const aw = await execute({ executable: process.execPath,
      prefix: ['--import', preload, path.join(repo, 'packages', 'cli', 'dist', 'index.js')] },
    ['target', 'set', 'grok', '--context', 'user', '--json'], { cwd, env, timeoutMs: 40_000 });
    row.exitCode = aw.exitCode;
    row.cleanupConfirmed = aw.terminationReason === 'complete' && Number.isInteger(aw.exitCode) && aw.exitCode !== 250;
    if (!row.cleanupConfirmed) row.reasonCodes.push('publicAwCompletionUnconfirmed');
    const reply = JSON.parse(aw.stdout);
    row.status = ['success', 'blocked', 'failed', 'partial'].includes(reply.status) ? reply.status : null;
    if (reply.schemaVersion !== 2 || reply.command !== 'target.set') row.reasonCodes.push('publicReceiptIdentityUnconfirmed');
    const target = reply.data?.availability?.find(({ id }) => id === 'grok');
    const product = target?.installations?.find(({ entry }) => entry?.kind === 'cli'
      && typeof entry.executable === 'string' && path.relative(client.shim, entry.executable) === '');
    row.availability = ['available', 'unknown', 'unsupported', 'missing'].includes(target?.availability) ? target.availability : null;
    row.version = product?.version === version ? version : null;
    if (!product) row.reasonCodes.push('publicClientIdentityUnconfirmed');
    if (row.status === 'success' && (target?.selected !== true || reply.data.preferencesChanged !== true)
        || row.status === 'blocked' && (target?.selected !== false || reply.data.preferencesChanged !== false)) {
      row.reasonCodes.push('publicSelectionUnconfirmed');
    }
    row.reasonCodes.push(...new Set([...(reply.diagnostics ?? []).map(({ code }) => code),
      ...(product?.reasonCodes ?? [])].filter((code) => codes.has(code))));
  } catch {
    row.reasonCodes.push('publicReceiptUnavailable');
  } finally {
    row.elapsedMs = Math.round(performance.now() - started);
    const saved = await optionalRead(prefFile, 'utf8');
    row.preferences = saved === undefined ? 'absent' : 'unexpected';
    if (saved !== undefined) {
      const pref = JSON.parse(saved);
      if (pref.schemaVersion === 2 && pref.kind === 'aw-deployment-preferences' && isSet(pref.targets)
          && Array.isArray(pref.exclusions) && pref.exclusions.length === 0) row.preferences = 'grok-saved';
    }
    const trace = await optionalRead(env.GROK_DIAG_TRACE, 'utf8');
    row.probes = trace?.trim().split('\n').map((line) => JSON.parse(line)) ?? [];
    if (delayedProbe) {
      const gate = await optionalRead(env.GROK_DIAG_GATE, 'utf8');
      const state = /^started\n([1-9]\d{0,9})\n(continued\n)?$/u.exec(gate ?? '');
      row.delay = state ? state[2] ? 'continued' : 'started' : 'unconfirmed';
      row.delayChildExitConfirmed = Boolean(state && await confirmChildExit(Number(state[1])));
      if (!row.delayChildExitConfirmed) row.reasonCodes.push('delayChildExitUnconfirmed');
    }
  }
}

function expected(row, outcome) {
  const versionProbes = row.probes?.filter(({ probe }) => probe === 'version') ?? [];
  const pluginHelp = row.probes?.filter(({ probe }) => probe === 'pluginHelp') ?? [];
  const listHelp = row.probes?.filter(({ probe }) => probe === 'listHelp') ?? [];
  const complete = (probe) => probe?.reason === 'complete' && probe.exitCode === 0;
  const timedOut = (probe) => probe?.reason === 'timeout' && probe.exitCode === 124;
  if (!row.cleanupConfirmed || !row.probes?.every(({ cleanupConfirmed }) => cleanupConfirmed)
      || row.reasonCodes.some((code) => code.endsWith('Unconfirmed') || code === 'publicReceiptUnavailable')
      || versionProbes.length !== 1) return false;
  if (outcome === 'versionBlocked') {
    return row.exitCode === 3 && row.status === 'blocked' && row.availability === 'unknown'
      && row.preferences === 'absent' && row.version === null && row.delay === 'started'
      && timedOut(versionProbes[0]) && pluginHelp.length === 0 && listHelp.length === 0
      && row.reasonCodes.includes('targetUnavailable');
  }
  if (outcome === 'helpBlocked') {
    return row.exitCode === 3 && row.status === 'blocked' && row.availability === 'unknown'
      && row.preferences === 'absent' && row.version === version && row.delay === 'started'
      && complete(versionProbes[0]) && versionProbes[0].version === version
      && pluginHelp.length === 1 && timedOut(pluginHelp[0]) && listHelp.length === 0
      && row.reasonCodes.includes('targetUnavailable');
  }
  return row.exitCode === 0 && row.status === 'success' && row.availability === 'available'
    && row.preferences === 'grok-saved' && row.version === version && complete(versionProbes[0])
    && versionProbes[0].version === version
    && pluginHelp.length === 1 && complete(pluginHelp[0]) && listHelp.length === 1 && complete(listHelp[0])
    && (outcome !== 'versionSaved' || row.delay === 'continued' && versionProbes[0].elapsedMs >= 6_500);
}

const [baseline, report] = process.argv.slice(2);
let root;
let stage = 'diagnosticAdmissionFailed';
try {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.GITHUB_ACTIONS !== 'true'
      || !baseline || !report || !process.env.RUNNER_TEMP) throw new Error(stage);
  root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'awgd-'));
  stage = 'officialPackageAcquisitionFailed';
  const client = await acquire(root);
  for (const [revision, scenario, delayedProbe, outcome] of [
    ['baseline', 'normal', undefined, 'saved'],
    ['candidate', 'normal', undefined, 'saved'],
    ['baseline', 'artificialVersionDelay', 'version', 'versionBlocked'],
    ['candidate', 'artificialVersionDelay', 'version', 'versionSaved'],
    ['candidate', 'artificialManagementHelpDelay', 'pluginHelp', 'helpBlocked'],
  ]) {
    const row = { revision, scenario, reasonCodes: [] };
    facts.cases.push(row);
    try {
      await readCase(path.join(root, String(facts.cases.length)), revision === 'baseline' ? path.resolve(baseline) : repoRoot,
        client, row, delayedProbe);
      if (!expected(row, outcome)) row.reasonCodes.push('unexpectedCaseResult');
    } catch {
      row.reasonCodes.push('caseEvidenceUnavailable');
    }
  }
} catch {
  facts.reasonCode = stage;
} finally {
  if (root) {
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      try { await fs.lstat(root); }
      catch (error) { if (error.code === 'ENOENT') facts.temporaryFilesRemoved = true; }
    } catch { /* The report retains the failed cleanup state. */ }
  }
  if (!facts.temporaryFilesRemoved && !facts.reasonCode) facts.reasonCode = 'temporaryCleanupUnconfirmed';
}
if (report) {
  try { await fs.writeFile(path.resolve(report), JSON.stringify(facts, null, 2) + '\n', { flag: 'wx' }); }
  catch { facts.reasonCode = 'reportWriteFailed'; }
}
if (facts.reasonCode || facts.cases.some(({ reasonCodes }) => reasonCodes.includes('unexpectedCaseResult')
  || reasonCodes.includes('caseEvidenceUnavailable'))) {
  console.error(facts.reasonCode ?? 'diagnosticCaseFailed');
  process.exitCode = 1;
}
