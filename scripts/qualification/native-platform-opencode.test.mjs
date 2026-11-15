import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getOpenCodeDistribution, sha256 } from './native-platform-runtime.mjs';
import { assertOpenCodeQueryResult, copyOpenCodeExecutable } from './native-platform-opencode.mjs';

// Test Value Gate: selecting the postinstall placeholder or a floating optional
// dependency cannot provide the fixed native executable required by this runner.
test('OpenCode selects exact official optional packages, including Windows entry names', () => {
  for (const [platform, suffix] of [['linux', 'linux'], ['darwin', 'darwin'], ['win32', 'windows']]) {
    for (const arch of ['x64', 'arm64']) {
      const packageName = `@opencode/cli-${suffix}-${arch}`;
      const parent = { name: '@opencode/cli', version: '2.0.0', bin: { opencode: 'bin/opencode.exe' }, optionalDependencies: { [packageName]: '2.0.0' } };
      assert.deepEqual(getOpenCodeDistribution(parent, { platform, arch }), {
        packageName, version: '2.0.0', entry: platform === 'win32' ? 'bin/opencode.exe' : 'bin/opencode' });
      assert.throws(() => getOpenCodeDistribution({ ...parent, optionalDependencies: { [packageName]: '^2.0.0' } }, { platform, arch }), /distribution-unavailable/);
      assert.throws(() => getOpenCodeDistribution({ ...parent, name: '@foreign/cli' }, { platform, arch }), /distribution-unavailable/);
      assert.throws(() => getOpenCodeDistribution({ ...parent, version: '2.0.1' }, { platform, arch }), /distribution-unavailable/);
    }
  }
  assert.throws(() => getOpenCodeDistribution({}, { platform: 'freebsd', arch: 'x64' }), /distribution-unavailable/);
});

// Test Value Gate: acquisition and scope use separate roots. Copying only the
// selected executable must preserve its bytes without opening an arbitrary root.
test('OpenCode private executable copy stays inside its scope and preserves acquired bytes', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-opencode-copy-')));
  try {
    const acquisition = path.join(root, 'acquisition');
    const scope = path.join(root, 'scope');
    await fs.mkdir(acquisition); await fs.mkdir(scope);
    const source = path.join(acquisition, 'official-native-entry');
    const bytes = Buffer.from('fixed-native-entry-bytes');
    await fs.writeFile(source, bytes);
    const copied = await copyOpenCodeExecutable({ root: scope, launcher: { executable: source, prefix: [] } });
    assert.equal(copied.evidence.copiedSha256, sha256(bytes));
    assert.equal(copied.evidence.sourceSha256, sha256(bytes));
    assert(!path.relative(scope, copied.executable).startsWith('..'));
    assert.deepEqual(await fs.readFile(copied.executable), bytes);
    assert.deepEqual(await fs.readFile(source), bytes);
    await assert.rejects(copyOpenCodeExecutable({ root: scope, launcher: { executable: source, prefix: ['wrapper'] } }), /native-entry-required/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

function result(windows = false) {
  return { exitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false,
    stdoutTruncated: false, stderrTruncated: false, terminationReason: 'complete',
    containmentMode: windows ? 'verified-observed' : 'observed',
    gradingEvidenceAccepted: windows, descendantCleanupGuaranteed: windows };
}

function receipt(windows = false) {
  return { schemaVersion: 1, kind: 'opencode-fixed-local-plugin-query', status: 'passed', process: {
    inheritedMarkerPresent: true,
    markerEnvironmentVariable: windows ? 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER' : 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER',
    helperCreatesIndependentProcessGroup: false, readyObserved: true, activationRequested: true,
    activationResponseStatus: 204, activationSettled: true, apiRequested: true, apiResponseStatus: 200,
    stdinEofSent: true, serverClosed: true, serverExitCode: 0, serverSignal: null,
    fallbackTermUsed: false, fallbackKillUsed: false, groupDrainChecked: !windows },
    skillObservation: { status: 'unverified', reason: 'http-status', httpStatus: 404 } };
}

// Test Value Gate: ordinary POSIX observation is not provider grading, while
// Windows must retain its actual Job contract rather than copy POSIX flags.
test('OpenCode validates actual POSIX and Windows process contracts independently', () => {
  for (const windows of [false, true]) {
    const host = { platform: windows ? 'win32' : 'darwin' };
    assert.doesNotThrow(() => assertOpenCodeQueryResult(result(windows), receipt(windows), host));
    for (const changed of [{ timedOut: true }, { cancelled: true }, { maxBufferExceeded: true }, { terminationReason: 'timeout' },
      { gradingEvidenceAccepted: !windows }, { descendantCleanupGuaranteed: !windows }]) {
      assert.throws(() => assertOpenCodeQueryResult({ ...result(windows), ...changed }, receipt(windows), host), error => error.opencodeProcessFailure === true);
    }
    for (const changed of [{ inheritedMarkerPresent: false }, { fallbackTermUsed: true }, { fallbackKillUsed: true }, { serverSignal: 'SIGTERM' }, { serverExitCode: 1 }]) {
      const value = receipt(windows); Object.assign(value.process, changed);
      assert.throws(() => assertOpenCodeQueryResult(result(windows), value, host), error => error.opencodeProcessFailure === true);
    }
  }
});

// Test Value Gate: an unavailable optional Skill API must stay nonblocking;
// explicit Native failures and returned current-content mismatches remain failures.
test('OpenCode preserves plugin and consumer-content failures without requiring optional discovery', () => {
  const host = { platform: 'linux' };
  assert.doesNotThrow(() => assertOpenCodeQueryResult(result(), receipt(), host));
  for (const reason of ['scope-fixture-plugin-failed', 'scope-native-skill-registry-mismatch']) {
    const value = { ...receipt(), status: 'failed', reason };
    assert.throws(() => assertOpenCodeQueryResult({ ...result(), exitCode: 1 }, value, host), error => error.message === reason && !error.opencodeProcessFailure);
  }
  const value = { ...receipt(), status: 'failed', reason: 'scope-skill-api-timeout' };
  assert.throws(() => assertOpenCodeQueryResult({ ...result(), exitCode: 1 }, value, host), error => error.opencodeProcessFailure === true);
  const inconsistent = { ...receipt(), skillObservation: { status: 'failed' } };
  assert.throws(() => assertOpenCodeQueryResult(result(), inconsistent, host), /scope-native-skill-registry-mismatch/);
});
