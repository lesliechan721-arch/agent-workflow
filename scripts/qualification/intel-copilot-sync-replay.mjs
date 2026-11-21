import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { acquireClient, execute, prepareEnvironment, readManagedTrace, repoRoot, sha256 } from './native-platform-runtime.mjs';
import { runComponentQualification } from './native-platform-public-components.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';
import { checkSettled, nativePackage, nativePath, readInstalled, targetOf } from './native-platform-public-state.mjs';

const baseline = '871f79eae41720333dfc3e129b6235855659b1d1';
const entryDigest = '0ea824a86be5757533fdb092eff7050871bd7a711a46babde0ffe0e44ac5ad88';
const binaryDigest = '32545e11374d317783d4e7baef31a57e87019e44dabda6b1d524122d49e07d66';
const run = promisify(execFile);
const commandNames = new Set([
  'target.set', 'dev.catalog.create', 'dev.catalog.build', 'dev.plugin.create', 'source.add', 'source.sync',
  'plugin.install', 'plugin.sync', 'plugin.status', 'plugin.remove',
]);
const codes = new Set([
  'processCleanupUnconfirmed', 'pluginProcessCleanupFailed', 'nativeCliTimedOut', 'nativeCliFailed',
  'nativeCliExecutableMissing', 'operationInterrupted', 'operationPlanStale', 'nativeObservationUnconfirmed',
  'nativeObservationFailed', 'platformMutationFailed', 'targetUnavailable', 'commandFailed', 'platformComponentsUnmet',
]);
const outcomes = new Set(['success', 'blocked', 'partial', 'failed']);
const nativeOperations = new Set(['version', 'help', 'plugin-list', 'marketplace-list', 'marketplace-add', 'plugin-install', 'plugin-remove', 'other']);
const cleanupKinds = new Set(['group-signal-refused', 'group-exit-check-failed', 'group-still-running', 'cleanup-deadline',
  'marker-lookup-failed', 'identity-lookup-failed', 'termination-verification-failed', 'termination-audit-failed',
  'marker-unreadable', 'descendant-still-running', 'other']);
const errno = new Set(['EPERM', 'ESRCH', 'EACCES', 'ETIMEDOUT', 'ENOENT', 'EAGAIN', 'ABORT_ERR']);
const kinds = ['skill', 'agent', 'mcp', 'hook', 'instruction'];
const mixedId = 'matrix/mixed-components';
const fixtures = new Map([
  ...kinds.map(kind => ['matrix/single-' + kind, [kind]]),
  [mixedId, kinds], ['matrix/hook-only', ['hook']],
]);

function receiptFor(response, command) {
  try {
    const receipt = JSON.parse(response?.stdout);
    return receipt.schemaVersion === 2 && receipt.command === command && outcomes.has(receipt.status) ? receipt : undefined;
  } catch { return undefined; }
}

function responseFacts(response, receipt) {
  const { exitCode, timedOut, cancelled, maxBufferExceeded, terminationReason } = response ?? {};
  return {
    exitCode, timedOut, cancelled, maxBufferExceeded, terminationReason,
    status: receipt?.status, diagnostics: receipt?.diagnostics?.map(item => codes.has(item.code) ? item.code : 'other').slice(0, 16),
    remainingTargets: Array.isArray(receipt?.data?.remainingTargets) ? receipt.data.remainingTargets.length : undefined,
    outputs: ['none', 'changed', 'unknown', 'partial'].includes(receipt?.data?.changes?.outputs) ? receipt.data.changes.outputs : undefined,
  };
}

function observationFacts(error) {
  return (error.publicAwProcessDiagnostics ?? []).slice(0, 2).map(entry => ({
    stage: entry.stage, reason: entry.reason, lookupReason: entry.lookupFailure?.reason,
    attempts: entry.markerLookupAttempts, markerLookupSucceeded: entry.markerLookupSucceeded,
    queries: entry.queries?.slice(0, 8).map(query => ({
      kind: query.kind, completion: query.completion, reason: query.failureReason,
      elapsedMs: Number.isFinite(query.settledAt - query.startedAt) ? query.settledAt - query.startedAt : undefined,
      budgetMs: query.deadline - query.startedAt,
    })),
  }));
}

function innerFailureFacts(trace, ordinal) {
  return (trace?.records ?? []).filter(row => row?.ordinal === ordinal && ['native', 'plugin-script'].includes(row.kind))
    .slice(0, 32).map(row => ({
      kind: row.kind, operation: nativeOperations.has(row.operation) ? row.operation : undefined,
      reason: ['exit', 'timeout', 'aborted', 'spawn'].includes(row.reason) ? row.reason : undefined,
      exitCode: Number.isSafeInteger(row.exitCode) ? row.exitCode : undefined,
      elapsedMs: Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0 ? row.elapsedMs : undefined,
      causeCode: errno.has(row.causeCode) ? row.causeCode : undefined,
      cleanup: cleanupKinds.has(row.cleanup?.kind) ? {
        kind: row.cleanup.kind, code: errno.has(row.cleanup.code) ? row.cleanup.code : undefined,
        signal: ['SIGTERM', 'SIGKILL'].includes(row.cleanup.signal) ? row.cleanup.signal : undefined,
      } : undefined,
    }));
}

async function verifyHost() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ARCH !== 'X64'
    || process.platform !== 'darwin' || process.arch !== 'x64'
    || !os.release().startsWith('24.') || process.version !== 'v24.19.0') {
    throw new Error('requires-github-macos-15-intel-node-24.19.0');
  }
  const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], { env: { LC_ALL: 'C' }, timeout: 2_000 })
    .catch(error => {
      if (error.code !== 1 || !/(?:unknown oid|No such file or directory)/iu.test(error.stderr ?? '')) throw error;
      return { stdout: '0' };
    });
  assert.equal(stdout.trim(), '0');
}

async function captureFiles(receipt, options) {
  const root = path.dirname(options.env.AW_HOME);
  const ctx = { root, platform: 'copilot', scope: 'user' };
  const result = {};
  for (const [id, types] of fixtures) {
    const target = targetOf(receipt, ctx, id);
    const packageRoot = nativePackage(target);
    result[id] = Object.fromEntries(await Promise.all(types.map(async kind => {
      const name = kind === 'skill' ? id.split('/')[1] + '-skill' : 'sample-' + kind;
      const file = nativePath(ctx, { id }, kind, packageRoot, name);
      return [kind, await readInstalled(ctx, file, '')];
    })));
  }
  return result;
}

function digestFacts(files) {
  return Object.fromEntries(Object.entries(files).map(([id, kinds]) => [id,
    Object.fromEntries(Object.entries(kinds).map(([kind, fact]) => [kind, fact.sha256]))]));
}

function digestFixture(record) {
  if (!record || !fixtures.has(record.id) || record.error) return undefined;
  return { id: record.id, files: Object.fromEntries(record.installed
    .filter(file => kinds.includes(file.kind) && /^[a-f0-9]{64}$/u.test(file.sha256))
    .map(file => [file.kind, file.sha256])) };
}

async function qualify(root, report, clientPath, entry) {
  const commands = report.commands = [];
  let checkpoint = 0;
  let before;
  let afterUpgrade;

  async function observed(launcher, args, options, recovery = false) {
    const name = args.slice(0, args[0] === 'dev' ? 3 : 2).join('.');
    const command = commandNames.has(name) ? name : 'other';
    const record = { ordinal: commands.length + 1, command, recovery: recovery || undefined };
    if (command === 'plugin.sync') record.checkpoint = ++checkpoint === 1 ? 'no-change' : 'mixed-upgrade';
    commands.push(record);
    const traceFile = path.join(root, 'trace-' + record.ordinal + '.jsonl');
    const preload = new URL('./intel-copilot-sync-replay-preload.mjs', import.meta.url).href;
    const traced = { ...launcher, prefix: ['--import', preload, ...launcher.prefix] };
    const env = { ...options.env, AW_INTEL_COPILOT_REPLAY_TRACE: traceFile,
      AW_INTEL_COPILOT_REPLAY_ORDINAL: String(record.ordinal), AW_INTEL_COPILOT_REPLAY_ENTRY: entry };
    const started = performance.now();
    let response;
    let receipt;
    try {
      response = await executePublicAw(traced, args, { ...options, env });
      receipt = receiptFor(response, command);
      Object.assign(record, responseFacts(response, receipt));
    } catch (error) {
      Object.assign(record, responseFacts(error.result, receiptFor(error.result, command)), {
        error: error.name === 'ProviderProcessCleanupError' ? 'process-observation-failed' : 'execution-failed',
        process: observationFacts(error),
      });
      if (command === 'plugin.sync') report.failureReadback = 'process-unconfirmed';
      throw error;
    } finally {
      record.elapsedMs = Math.round(performance.now() - started);
      const trace = await readManagedTrace(traceFile);
      const failures = innerFailureFacts(trace, record.ordinal);
      if (failures.length) record.innerFailures = failures;
      if (trace?.state && trace.state !== 'captured' && trace.state !== 'not-created') record.trace = trace.state;
    }
    return { response, receipt };
  }

  const matrix = await runComponentQualification({ platform: 'copilot', scope: 'user', suite: 'matrix', clientPath }, {
    async executeAw(launcher, args, options) {
      const { response, receipt } = await observed(launcher, args, options);
      const [group, action] = args;
      if (group !== 'plugin') return response;
      if (action === 'sync' && response.exitCode !== 0 && receipt && response.terminationReason === 'complete') {
        // Read existing state once after a completed business failure. Preserve original receipt.
        try {
          const recovery = await observed(launcher, ['plugin', 'status', '--context', 'user', '--json'], options, true);
          const current = recovery.receipt?.data;
          report.failureReadback = { inSync: current?.inSync, allSatisfied: current?.allSatisfied, pending: current?.counts?.pending };
          if (recovery.response.exitCode === 0 && before) {
            try {
              report.failureReadback.files = digestFacts(await captureFiles(recovery.receipt, options));
            } catch { report.failureReadback.fileState = 'incomplete'; }
          }
        } catch { report.failureReadback = 'readback-failed'; }
      }
      if (response.exitCode !== 0 || !receipt) return response;
      try {
        if (action === 'status' && !before && checkpoint === 0) {
          checkSettled(receipt);
          before = await captureFiles(receipt, options);
          report.initialFiles = digestFacts(before);
        } else if (action === 'sync' && checkpoint === 1) {
          assert.equal(receipt.data.remainingTargets.length, 0);
          assert.equal(receipt.data.changes.outputs, 'none');
          const root = path.dirname(options.env.AW_HOME);
          for (const file of Object.values(before).flatMap(Object.values)) {
            assert.equal((await readInstalled({ root }, path.join(root, file.path), '')).sha256, file.sha256);
          }
          report.noChangeFiles = 'unchanged';
        } else if (action === 'status' && checkpoint === 2 && !afterUpgrade) {
          checkSettled(receipt);
          afterUpgrade = await captureFiles(receipt, options);
          report.upgradeFiles = digestFacts(afterUpgrade);
          for (const [id, digests] of Object.entries(report.initialFiles)) {
            if (id === mixedId) assert.notDeepEqual(report.upgradeFiles[id], digests);
            else assert.deepEqual(report.upgradeFiles[id], digests);
          }
        }
      } catch {
        report.contentCheckFailure = action === 'sync' ? 'no-change-content' : checkpoint === 2 ? 'upgrade-content' : 'initial-content';
        throw new Error('copilot-matrix-content-check-failed');
      }
      return response;
    },
  });

  report.candidateSha256 = matrix.candidateSha256;
  report.matrixStatus = matrix.status;
  report.sevenFixtures = matrix.cases.map(digestFixture).filter(Boolean);
  report.mixedUpgrade = digestFixture(matrix.updated);
  report.reinstalled = digestFixture(matrix.reinstalled);
  report.removals = matrix.removals?.length ?? 0;
  assert.equal(matrix.status, 'passed');
  assert.equal(report.sevenFixtures.length, fixtures.size);
  assert.equal(report.removals, fixtures.size);
  assert.equal(checkpoint, 2);
  assert.equal(report.noChangeFiles, 'unchanged');
  assert.deepEqual(Object.fromEntries(report.sevenFixtures.map(item => [item.id, item.files])), report.initialFiles);
  assert.deepEqual(report.mixedUpgrade?.files, report.upgradeFiles?.[mixedId]);
  assert.deepEqual(report.reinstalled, report.mixedUpgrade);
}

const { values } = parseArgs({ options: { output: { type: 'string' }, 'source-commit': { type: 'string' } } });
if (!values.output) {
  process.stderr.write('Provide --output for the Intel Copilot replay JSON report.\n');
  process.exitCode = 2;
} else {
  const sourceCommit = values['source-commit'] ?? baseline;
  const report = { schemaVersion: 1, kind: 'intel-copilot-user-sync-replay',
    host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
    status: 'failed' };
  let root;
  let stage = 'host';
  const started = performance.now();
  try {
    await verifyHost();
    stage = 'source';
    assert.match(sourceCommit, /^[a-f0-9]{40}$/u);
    await run('/usr/bin/git', ['diff', '--quiet', sourceCommit, '--', 'packages', 'plugins', 'package.json', 'pnpm-lock.yaml',
      'scripts/qualification', ':!scripts/qualification/intel-copilot-sync-replay.mjs',
      ':!scripts/qualification/intel-copilot-sync-replay-preload.mjs'], { cwd: repoRoot, timeout: 10_000 });
    const untracked = await run('/usr/bin/git', ['ls-files', '--others', '--exclude-standard', '--', 'packages', 'plugins'],
      { cwd: repoRoot, timeout: 10_000 });
    assert.equal(untracked.stdout, '');
    report.sourceCommit = sourceCommit;
    stage = 'acquisition';
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-intel-copilot-sync-')));
    const { launcher, binDirectory, acquisition } = await acquireClient('copilot', root);
    assert.equal(acquisition.version, '1.0.95');
    assert.equal(acquisition.entrySha256, entryDigest);
    assert.equal(launcher.executable, process.execPath);
    assert.equal(launcher.prefix.length, 1);
    const entry = launcher.prefix[0];
    const binary = path.join(binDirectory, 'node_modules/@github/copilot-darwin-x64/copilot');
    assert.equal(sha256(await fs.readFile(binary)), binaryDigest);
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.symlink(entry, path.join(bin, 'copilot'));
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    const clientPath = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    stage = 'version';
    const env = { ...await prepareEnvironment(root), PATH: clientPath };
    const result = await execute(launcher, ['--version'], { cwd: root, env, nativeClient: 'copilot', timeoutMs: 5_000 });
    report.versionProbe = responseFacts(result);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^GitHub Copilot CLI 1\.0\.95\.?(?:\r?\n|$)/u);
    report.client = { package: '@github/copilot', version: '1.0.95', entryDigest, binaryDigest };
    stage = 'matrix';
    await qualify(root, report, clientPath, entry);
    report.status = 'passed';
  } catch (error) {
    report.failure = stage;
    if (error.name === 'ProviderProcessCleanupError') report.process = observationFacts(error);
    process.exitCode = 1;
  } finally {
    if (root) {
      try { await fs.rm(root, { recursive: true, force: true }); }
      catch { report.status = 'failed'; report.cleanupFailed = true; process.exitCode = 1; }
    }
    report.elapsedMs = Math.round(performance.now() - started);
    try { await fs.writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch { process.stderr.write('Could not write Intel Copilot replay JSON report.\n'); process.exitCode = 1; }
  }
}
