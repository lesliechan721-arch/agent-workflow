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
  let output = '"本机\\用户","S-1-5-21-123-456-789-1001"\r\n';
  const api = await windowsHostFixture(t, async (command, args, options) => {
    assert.equal(command, path.join(process.env[Object.keys(process.env).find((key) => key.toLowerCase() === 'systemroot')], 'System32', 'whoami.exe'));
    assert.deepEqual(args, ['/user', '/fo', 'csv', '/nh']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 15000);
    calls++;
    if (calls === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
    return { stdout: output };
  });
  const first = api.currentUserIdentity();
  const concurrent = api.currentUserIdentity();
  const rejected = Promise.all([
    assert.rejects(first, { code: 'platformOperationFailed' }),
    assert.rejects(concurrent, { code: 'platformOperationFailed' }),
  ]);
  rejectFirst(failure);
  await rejected;
  for (const invalid of ['', 'S-1-5-21-123-456-789-1001', '"account","not-a-sid"', `${output}${output}`]) {
    output = invalid;
    await assert.rejects(api.currentUserIdentity(), { code: 'userIdentityUnavailable' });
  }
  output = '"本机\\用户","S-1-5-21-123-456-789-1001"\r\n';
  const [owner, other] = await Promise.all([api.currentUserIdentity(), api.currentUserIdentity()]);
  assert.deepEqual(owner, { kind: 'windows', sid: 'S-1-5-21-123-456-789-1001' });
  owner.sid = 'changed';
  assert.equal((await api.currentUserIdentity()).sid, other.sid);
  assert.equal(calls, 6);
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

// Test Value Gate: multi-run reads and expiration scans must use a bounded
// native batch, recheck each invocation, and retain unhealthy neighbors.
test('multi-run reads batch verification and isolate unsafe or missing owners', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-multi-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let unsafe;
  let calls = 0;
  const api = windowsHostFixture(t, async (_command, _args, options) => {
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString());
    calls++;
    if (options.env.AW_SUBAGENT_NATIVE_OPERATION === 'processTable') return { stdout: JSON.stringify([{ pid: process.pid, ppid: process.ppid, started: '1' }]) };
    if (input.resources?.some(({ target }) => target === unsafe)) throw new Error('unsafe ACL');
    return { stdout: 'true' };
  });
  const owner = await api.currentUserIdentity();
  const { openRuns, scanExpired } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  const handles = [];
  for (const id of ['a', 'b', 'c'].map((value) => value.repeat(32))) {
    await fs.mkdir(path.join(root, id));
    const meta = { schema: 5, id, key: 'd'.repeat(32), name: 'fixture', token: 'e'.repeat(48), owner, processes: [], terminalAt: Date.now() };
    await fs.writeFile(path.join(root, id, 'owner.json'), JSON.stringify(meta));
    handles.push(`aw5-${id}-${meta.key}`);
  }
  const context = { root, owner };
  let results = await openRuns(context, handles);
  assert.ok(handles.every((handle) => results.get(handle).run?.handle === handle));
  assert.equal(calls, 1);
  results = await openRuns(context, [...handles, handles[0].slice(0, -32) + 'f'.repeat(32), 'invalid']);
  assert.ok(handles.every((handle) => results.get(handle).run?.handle === handle));
  assert.equal([...results.values()].filter(({ error }) => error?.code === 'runUnavailable').length, 2);
  assert.equal(calls, 2, 'A later read must get fresh native evidence.');
  calls = 0;
  assert.equal(await scanExpired(context), false);
  assert.equal(calls, 2, 'Root enumeration and all owner records require two native calls.');
  unsafe = path.join(root, 'b'.repeat(32), 'owner.json');
  calls = 0;
  results = await openRuns(context, handles);
  assert.equal(results.get(handles[1]).error.code, 'runUnavailable');
  assert.equal(results.get(handles[0]).run.handle, handles[0]);
  assert.equal(results.get(handles[2]).run.handle, handles[2]);
  assert.equal(calls, 4, 'A rejected batch falls back to independent checks.');
  assert.equal(await scanExpired(context), true);
  assert.ok(await fs.stat(unsafe));
  unsafe = undefined;
  await fs.unlink(path.join(root, 'b'.repeat(32), 'owner.json'));
  results = await openRuns(context, handles);
  assert.equal(results.get(handles[1]).error.code, 'runUnavailable');
  assert.ok(results.get(handles[0]).run && results.get(handles[2]).run);
  const expiredOwner = path.join(root, 'a'.repeat(32), 'owner.json');
  const expired = JSON.parse(await fs.readFile(expiredOwner, 'utf8'));
  Object.assign(expired, { terminalAt: Date.now() - 3600001, worker: { pid: 2147483647, started: '2' }, localTreeStopped: true });
  await fs.writeFile(expiredOwner, JSON.stringify(expired));
  assert.equal(await scanExpired(context), true);
  assert.equal(await fs.stat(path.dirname(expiredOwner)).catch(() => null), null);
  assert.ok(await fs.stat(path.join(root, 'b'.repeat(32))));
  assert.ok(await fs.stat(path.join(root, 'c'.repeat(32))));
  t.diagnostic('Windows native ACL calls for 3 healthy runs: open 3 -> 1; expiration scan 4 -> 2; every read revalidates.');
});

// Test Value Gate: the full 128-run scan must stay below Windows' environment
// variable limit with long Unicode paths instead of falling back per owner.
test('large owner scans bound each encoded native input without losing resources', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-owner-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '长路径'.repeat(20));
  await fs.mkdir(root);
  const payloads = [];
  const api = windowsHostFixture(t, async (_command, _args, options) => {
    const encoded = options.env.AW_SUBAGENT_PLATFORM_INPUT;
    assert.ok(encoded.length < 32767, 'A native input must fit the Windows environment variable.');
    const input = JSON.parse(Buffer.from(encoded, 'base64').toString());
    payloads.push(input);
    return { stdout: 'true' };
  });
  const owner = await api.currentUserIdentity();
  const ownerFiles = [];
  for (let index = 0; index < 128; index++) {
    const id = index.toString(16).padStart(32, '0');
    await fs.mkdir(path.join(root, id));
    const target = path.join(root, id, 'owner.json');
    ownerFiles.push(target);
    await fs.writeFile(target, JSON.stringify({ schema: 5, id, key: 'a'.repeat(32), name: 'fixture', token: 'b'.repeat(48), owner, processes: [], terminalAt: Date.now() }));
  }
  const { scanExpired } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  assert.equal(await scanExpired({ root, owner }), false);
  assert.ok(payloads.length > 2 && payloads.length < 32, `Expected bounded batches, received ${payloads.length} native calls.`);
  assert.deepEqual(payloads.flatMap(({ resources }) => resources.filter(({ kind }) => kind === 'file').map(({ target }) => target)).sort(), ownerFiles.sort());
  assert.equal((await fs.readdir(root)).length, 128);
  t.diagnostic(`Windows native ACL calls for 128 healthy owners with long Unicode paths: 129 -> ${payloads.length}; every encoded input < 32767 characters.`);
});

// Test Value Gate: wait must revalidate after sleeping. A newly unsafe target
// must fail independently while a healthy target's unread message is delivered.
test('multi-target wait rechecks permissions after a polling delay', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-wait-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = 'a'.repeat(32), second = 'b'.repeat(32);
  let batches = 0;
  const api = windowsHostFixture(t, async (_command, _args, options) => {
    if (options.env.AW_SUBAGENT_NATIVE_OPERATION === 'processTable') return { stdout: JSON.stringify([{ pid: process.pid, ppid: process.ppid, started: '1' }]) };
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString());
    if (input.resources?.length === 5) {
      batches++;
      if (batches === 2) await fs.writeFile(path.join(root, first, 'events', 'message.json'), JSON.stringify({ type: 'message', text: 'Healthy target message.' }));
    }
    if (batches >= 2 && input.resources?.some(({ target }) => target === path.join(root, second, 'owner.json'))) throw new Error('changed ACL');
    return { stdout: 'true' };
  });
  const owner = await api.currentUserIdentity();
  const handles = [];
  for (const id of [first, second]) {
    const directory = path.join(root, id);
    await fs.mkdir(directory);
    await fs.mkdir(path.join(directory, 'events'));
    const meta = { schema: 5, id, key: 'c'.repeat(32), name: 'fixture', token: 'd'.repeat(48), owner, processes: [], terminalAt: null, worker: { pid: process.pid, started: '1' } };
    await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(meta));
    await fs.writeFile(path.join(directory, 'snapshot.json'), JSON.stringify({ state: 'running', sequence: 2, ready: true, initialization: null, initializationSequence: 0 }));
    await fs.writeFile(path.join(directory, 'observed.json'), JSON.stringify({ sequence: 2, initializationSequence: 0, terminalConsumed: false }));
    handles.push(`aw5-${id}-${meta.key}`);
  }
  const { waitRuns } = await import('../skills/codex-subagent-guide/scripts/runtime/commands.mjs');
  const result = await waitRuns({ root, owner }, { runs: handles, timeoutMs: 5000 });
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /Healthy target message\./);
  assert.match(result.diagnostic, /<diagnostic [^>]*code="runUnavailable"/);
  assert.doesNotMatch(result.text, /runUnavailable/);
  assert.equal(batches, 2);
  assert.deepEqual(await fs.readdir(path.join(root, first, 'events')), []);
  assert.ok(await fs.stat(path.join(root, second, 'owner.json')));
});

// Test Value Gate: run creation keeps every resource private while avoiding a
// separate native host for each sibling directory and initial JSON file.
test('run creation batches private resources before publishing initial state', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-create-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const operations = [];
  const api = windowsHostFixture(t, async (_command, _args, options) => {
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString());
    if (Object.keys(input).length === 0) return { stdout: JSON.stringify('S-1-5-21-123-456-789-1001') };
    operations.push(input);
    return { stdout: 'true' };
  });
  const owner = await api.currentUserIdentity();
  const { createRun, readOwner } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  const run = await createRun({ root, owner }, 'fixture', root);
  assert.equal(operations.length, 4);
  assert.deepEqual(operations.map((input) => input.resources.length), [1, 1, 4, 3]);
  assert.deepEqual(operations[2].resources.map(({ target }) => path.basename(target)), ['events', 'outbox', 'gaps', 'adapter']);
  assert.ok(operations[3].resources.every(({ target, kind }) => target.endsWith('.tmp') && kind === 'file'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run.directory, 'snapshot.json'), 'utf8')), run.snapshot);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run.directory, 'observed.json'), 'utf8')), { sequence: 0, initializationSequence: 0, terminalConsumed: false });
  assert.equal((await fs.readdir(run.directory)).some((name) => name.endsWith('.tmp')), false);
  assert.deepEqual((await readOwner({ root, owner }, run.meta.id)).meta, run.meta);
  assert.equal(operations.length, 5);
  t.diagnostic('Windows native hosts per createRun with an existing root: 9 -> 4; the next read verifies ownership again');
});

// Test Value Gate: failed ACL protection must publish none of the staged files.
// Later rename failure preserves each completed atomic publication and foreign nodes.
test('batched JSON publication preserves old state on protection failure and cleans its temporary files', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-json-batch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reject = true;
  windowsHostFixture(t, async () => {
    if (reject) throw new Error('private ACL failure');
    return { stdout: 'true' };
  });
  const { atomicJsonFiles } = await import('../skills/codex-subagent-guide/scripts/runtime/files.mjs');
  const first = path.join(directory, 'first.json');
  const second = path.join(directory, 'second.json');
  await fs.writeFile(first, '{"old":1}\n');
  await fs.writeFile(second, '{"old":2}\n');
  const entries = [{ target: first, value: { new: 1 } }, { target: second, value: { new: 2 } }];
  await assert.rejects(atomicJsonFiles(entries), { code: 'platformOperationFailed' });
  assert.deepEqual(JSON.parse(await fs.readFile(first, 'utf8')), { old: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(second, 'utf8')), { old: 2 });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['first.json', 'second.json']);
  reject = false;
  await fs.unlink(second);
  await fs.mkdir(second);
  await fs.writeFile(path.join(second, 'foreign'), 'preserve');
  await assert.rejects(atomicJsonFiles(entries));
  assert.deepEqual(JSON.parse(await fs.readFile(first, 'utf8')), { new: 1 });
  assert.equal(await fs.readFile(path.join(second, 'foreign'), 'utf8'), 'preserve');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['first.json', 'second.json']);
});

// Test Value Gate: a temporary Windows sharing failure must not terminate a run
// or expose a missing/partial old file while the replacement is retried.
test('atomic JSON replacement recovers from transient Windows sharing failures', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-json-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  windowsHostFixture(t, async (_command, _args, options) => {
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString());
    return { stdout: Object.keys(input).length ? 'true' : JSON.stringify('S-1-5-21-123-456-789-1001') };
  });
  const { atomicJson } = await import('../skills/codex-subagent-guide/scripts/runtime/files.mjs');
  const target = path.join(directory, 'owner.json');
  const rename = fs.rename;
  t.after(() => { fs.rename = rename; });
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    await fs.writeFile(target, '{"old":true}\n');
    let conflicts = 0;
    fs.rename = async (source, destination) => {
      assert.equal(destination, target);
      assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { old: true });
      assert.deepEqual(JSON.parse(await fs.readFile(source, 'utf8')), { replacement: code });
      if (++conflicts <= 2) throw Object.assign(new Error('File is occupied.'), { code, syscall: 'rename', path: source, dest: destination });
      return rename(source, destination);
    };
    await atomicJson(target, { replacement: code });
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { replacement: code });
    assert.deepEqual(await fs.readdir(directory), ['owner.json']);
  }
});

// Test Value Gate: retry exhaustion must preserve old state, clean staging, and
// return the original error; unrelated failures are not retried.
test('atomic JSON replacement bounds Windows retries and preserves permanent failures', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-json-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  windowsHostFixture(t, async (_command, _args, options) => {
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString());
    return { stdout: Object.keys(input).length ? 'true' : JSON.stringify('S-1-5-21-123-456-789-1001') };
  });
  const { atomicJson } = await import('../skills/codex-subagent-guide/scripts/runtime/files.mjs');
  const target = path.join(directory, 'owner.json');
  const rename = fs.rename;
  t.after(() => { fs.rename = rename; });
  for (const code of ['EPERM', 'ENOSPC', 'EXDEV']) {
    await fs.writeFile(target, '{"old":true}\n');
    const error = Object.assign(new Error('Cannot publish.'), { code });
    let attempts = 0;
    fs.rename = async () => { attempts++; throw error; };
    await assert.rejects(atomicJson(target, { replacement: true }), (actual) => actual === error);
    assert.ok(code === 'EPERM' ? attempts > 1 && attempts <= 10 : attempts === 1);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { old: true });
    assert.deepEqual(await fs.readdir(directory), ['owner.json']);
  }
});

// Test Value Gate: file diagnostics identify an operation and runtime resource
// without publishing host paths, arbitrary filenames, messages, or stacks.
test('file failure diagnostics expose only allowlisted operations and resource categories', async () => {
  const { fileFailureDiagnostic } = await import('../skills/codex-subagent-guide/scripts/runtime/files.mjs');
  const directory = path.resolve(os.tmpdir(), 'PRIVATE_RUN');
  const error = Object.assign(new Error('PRIVATE_MESSAGE'), {
    code: 'EPERM', syscall: 'rename', path: path.join(directory, 'owner.json.0123456789abcdef.tmp'),
    dest: path.join(directory, 'owner.json'), stack: 'PRIVATE_STACK',
  });
  assert.deepEqual(JSON.parse(fileFailureDiagnostic(error, directory)), {
    operation: 'workerFile', syscall: 'rename', source: 'owner.json.tmp', destination: 'owner.json',
  });
  for (const target of [path.join(directory, 'PRIVATE_FILE'), path.join(directory, 'adapter', 'PRIVATE_FILE'), path.join(directory + '-other', 'owner.json')]) {
    const diagnostic = fileFailureDiagnostic({ ...error, path: target, dest: target }, directory);
    assert.equal(diagnostic.includes('PRIVATE'), false);
    assert.ok(Buffer.byteLength(diagnostic) < 768);
  }
  assert.equal(fileFailureDiagnostic({ ...error, syscall: 'PRIVATE_CALL' }, directory), undefined);
});

// Test Value Gate: scratch cleanup must stop on a native tree-check failure,
// recheck the next attempt, and use one native tree walk for nested resources.
test('scratch cleanup batches native tree checks and retains files when verification fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-tree-batch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scratch = path.join(directory, 'adapter');
  const nested = path.join(scratch, 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(scratch, 'first'), 'one');
  await fs.writeFile(path.join(nested, 'second'), 'two');
  let rejectTree = true;
  const operations = [];
  const api = windowsHostFixture(t, async (_command, _args, options) => {
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString());
    operations.push(input);
    if (rejectTree && !input.resources) throw new Error('unsafe descendant');
    return { stdout: 'true' };
  });
  const { removeScratch } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  const run = { directory, meta: { localTreeStopped: true, owner: await api.currentUserIdentity() } };
  await assert.rejects(removeScratch(run), { code: 'platformOperationFailed' });
  assert.equal(await fs.readFile(path.join(nested, 'second'), 'utf8'), 'two');
  assert.equal(operations.length, 2);
  rejectTree = false;
  assert.equal(await removeScratch(run), true);
  assert.equal(operations.length, 4);
  assert.equal(operations[1].chain.at(-1), scratch);
  assert.deepEqual(operations.slice(2), operations.slice(0, 2));
  assert.equal(await fs.lstat(scratch).catch(() => null), null);
  t.diagnostic('Windows native hosts per nested scratch removal: owner/ACL verification 1; descendant checks 3 -> 1');
});
