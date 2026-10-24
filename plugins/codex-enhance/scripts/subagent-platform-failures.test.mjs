import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { promisify } from 'node:util';
import { safeError } from '../skills/codex-subagent-guide/scripts/runtime/contracts.mjs';

// Replace only the native host boundary before the runtime captures execFile.
// This file runs in its own Node test process; the native platform tests use the
// real host. The same runtime instance observes failure, recovery, and caching.
let executeNative;
const originalExecFile = childProcess.execFile;
let api;
try {
  childProcess.execFile = Object.assign(() => {}, { [promisify.custom]: (...args) => executeNative(...args) });
  syncBuiltinESMExports();
  api = await import('../skills/codex-subagent-guide/scripts/runtime/platform.mjs');
} finally {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
}

function windowsHostFixture(t, execute) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const systemRootKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'systemroot') ?? 'SystemRoot';
  const systemRoot = process.env[systemRootKey];
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    if (systemRoot === undefined) delete process.env[systemRootKey];
    else process.env[systemRootKey] = systemRoot;
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env[systemRootKey] = path.resolve(os.tmpdir(), 'aw-test-windows-system');
  executeNative = execute;
  return api;
}

// Test Value Gate: one transient identity failure must not poison later callers.
// Concurrent callers share the attempt, while successful identity reads stay cached.
test('identity initialization recovers after a shared native failure', async (t) => {
  const failure = new Error('private host diagnostic');
  let calls = 0; let rejectFirst;
  const api = await windowsHostFixture(t, async () => {
    calls++;
    if (calls === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
    return { stdout: JSON.stringify('S-1-5-21-123-456-789-1001') };
  });
  const first = api.currentUserIdentity();
  const concurrent = api.currentUserIdentity();
  const rejected = Promise.all([
    assert.rejects(first, { code: 'platformOperationFailed' }),
    assert.rejects(concurrent, { code: 'platformOperationFailed' }),
  ]);
  rejectFirst(failure);
  await rejected;
  const [owner, other] = await Promise.all([api.currentUserIdentity(), api.currentUserIdentity()]);
  assert.deepEqual(owner, { kind: 'windows', sid: 'S-1-5-21-123-456-789-1001' });
  owner.sid = 'changed';
  assert.equal((await api.currentUserIdentity()).sid, other.sid);
  assert.equal(calls, 2);
});

// Test Value Gate: native failures must retain actionable categories without
// exposing the host command, input, environment, stdout, or stderr to consumers.
test('Windows host failures retain only safe execution and parse diagnostics', async (t) => {
  const secret = 'PRIVATE_HOST_INPUT';
  const cases = [
    { error: { code: 'ENOENT' }, reason: 'launchFailed', phase: 'execute', systemCode: 'ENOENT' },
    { error: { code: 7, signal: null, killed: false }, reason: 'processExit', phase: 'execute', exitCode: 7 },
    { error: { code: null, signal: 'SIGTERM', killed: true }, reason: 'timeout', phase: 'execute', signal: 'SIGTERM', killed: true },
    { error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, reason: 'outputLimit', phase: 'execute', systemCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true },
    { error: { code: secret, signal: secret }, reason: 'executionFailed', phase: 'execute' },
    { stdout: secret, reason: 'invalidJson', phase: 'parse' },
  ];
  let selected; let budget;
  const api = await windowsHostFixture(t, async (command, args, options) => {
    budget = options.timeout;
    if (selected.error) throw Object.assign(new Error(secret), { cmd: secret, stdout: secret, stderr: secret, ...selected.error });
    return { stdout: selected.stdout };
  });
  for (const scenario of cases) {
    selected = scenario;
    await assert.rejects(api.windowsOperation(secret, { privateInput: secret }), (error) => {
      assert.equal(error.code, 'platformOperationFailed');
      const exposed = safeError(error);
      assert.equal(JSON.stringify(exposed).includes(secret), false);
      const details = JSON.parse(exposed.message.slice(exposed.message.indexOf('{')));
      assert.equal(details.operation, 'windowsOperation');
      assert.equal(details.phase, scenario.phase);
      assert.equal(details.reason, scenario.reason);
      assert.equal(details.timeoutMs, budget);
      assert.ok(Number.isSafeInteger(details.elapsedMs) && details.elapsedMs >= 0);
      assert.equal(details.exitCode, scenario.exitCode ?? null);
      assert.equal(details.systemCode, scenario.systemCode ?? null);
      assert.equal(details.signal, scenario.signal ?? null);
      assert.equal(details.killed, scenario.killed ?? false);
      assert.ok(Buffer.byteLength(exposed.message) < 768);
      return true;
    });
  }
});

// Test Value Gate: opening an owned run checks shared path segments once in
// one native round trip, while still rejecting an unverifiable owner record.
test('owned run reads batch native verification without caching ownership', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-owner-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'a'.repeat(32);
  const directory = path.join(root, id);
  await fs.mkdir(directory);
  let calls = 0;
  let reject = false;
  const verifications = [];
  const api = windowsHostFixture(t, async (_command, _args, options) => {
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString());
    if (!input.resources) return { stdout: JSON.stringify('S-1-5-21-123-456-789-1001') };
    calls++;
    verifications.push(input);
    if (reject) throw new Error('unsafe native resource');
    return { stdout: 'true' };
  });
  const owner = await api.currentUserIdentity();
  const meta = { schema: 5, id, key: 'b'.repeat(32), name: 'fixture', token: 'c'.repeat(48), owner, processes: [], terminalAt: null };
  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(meta));
  const { readOwner } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  assert.deepEqual((await readOwner({ root, owner }, id)).meta, meta);
  assert.equal(calls, 1);
  const expectedChain = [];
  for (let target = path.join(directory, 'owner.json');; target = path.dirname(target)) {
    expectedChain.unshift(target);
    if (target === path.dirname(target)) break;
  }
  assert.deepEqual(verifications[0].chain, expectedChain);
  assert.deepEqual(verifications[0].resources.map(({ target }) => target), [root, directory, path.join(directory, 'owner.json')]);
  t.diagnostic(`Windows reparse checks per owned run read: ${3 * expectedChain.length - 3} -> ${expectedChain.length}; native hosts: 1`);
  reject = true;
  await assert.rejects(readOwner({ root, owner }, id), { code: 'runUnavailable' });
  assert.equal(calls, 2);
  assert.deepEqual(verifications[1], verifications[0]);
});
