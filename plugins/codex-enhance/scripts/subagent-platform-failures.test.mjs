import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { promisify } from 'node:util';
import { useWindowsNativeFixture, windowsNativeSpawn } from './fixtures/windows-native-host.mjs';
import { safeError } from '../skills/codex-subagent-guide/scripts/runtime/contracts.mjs';

// Replace only the native host boundary before the runtime captures execFile.
// This file runs in its own Node test process; the native platform tests use the
// real host. The same runtime instance observes failure, recovery, and caching.
let executeNative;
useWindowsNativeFixture();
const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
let api;
try {
  childProcess.execFile = Object.assign(() => {}, { [promisify.custom]: (...args) => executeNative(...args) });
  childProcess.spawn = windowsNativeSpawn((...args) => executeNative(...args), originalSpawn);
  syncBuiltinESMExports();
  api = await import('../skills/codex-subagent-guide/scripts/runtime/platform.mjs');
} finally {
  childProcess.execFile = originalExecFile;
  childProcess.spawn = originalSpawn;
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

const sourceIdentity = { sourceId: 'fixture', sourceIdentity: 'fixture-source', pluginId: 'fixture/codex-enhance', pluginName: 'codex-enhance',
  pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'guide', skillKey: 'codex-subagent-guide' };

async function ownedExecution(root, owner, id, overrides = {}) {
  const executionId = id.repeat(2);
  const entryDirectory = path.join(root, id);
  const containerDirectory = path.join(entryDirectory, 'executions');
  const directory = path.join(containerDirectory, executionId);
  await fs.mkdir(directory, { recursive: true });
  for (const part of ['events', 'outbox', 'gaps', 'adapter']) await fs.mkdir(path.join(directory, part));
  const meta = { schema: 5, id, key: 'd'.repeat(22), name: 'fixture', executionId, installedIdentity: sourceIdentity,
    token: 'e'.repeat(48), owner, processes: [], terminalAt: Date.now(), ...overrides };
  const { key, name, installedIdentity } = meta;
  await fs.writeFile(path.join(entryDirectory, 'current.json'), JSON.stringify({ schema: 5, id, key, name, installedIdentity, owner, executionId }));
  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(meta));
  return { directory, entryDirectory, containerDirectory, meta, handle: `aw5-${id}-${key}` };
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
    assert.ok(budget > 15000 && budget <= 30000, 'PowerShell needs cold-start headroom and a bounded timeout.');
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

// Test Value Gate: entry and execution ownership must be checked on every
// read, including after previously valid native ACL evidence changes.
test('owned run reads verify entry and concrete execution without caching ownership', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-owner-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let reject = false;
  const verifications = [];
  const api = windowsHostFixture(t, async (_command, _args, options, request) => {
    const input = request.input;
    if (!input.resources) return { stdout: JSON.stringify('S-1-5-21-123-456-789-1001') };
    verifications.push(input);
    if (reject) throw new Error('unsafe native resource');
    return { result: true };
  });
  const owner = await api.currentUserIdentity();
  const run = await ownedExecution(root, owner, 'a'.repeat(11));
  const { readOwner } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  assert.deepEqual((await readOwner({ root, owner }, run.meta.id)).meta, run.meta);
  const targets = new Set(verifications.flatMap(({ resources }) => resources.map(({ target }) => target)));
  for (const target of [root, run.entryDirectory, path.join(run.entryDirectory, 'current.json'), run.containerDirectory, run.directory, path.join(run.directory, 'owner.json')]) assert.ok(targets.has(target));
  for (const input of verifications) assert.equal(input.chain.length, new Set(input.chain).size);
  const initial = verifications.length;
  reject = true;
  await assert.rejects(readOwner({ root, owner }, run.meta.id), { code: 'runUnavailable' });
  assert.ok(verifications.length > initial, 'Later reads obtain fresh ACL evidence.');
});

// Test Value Gate: multi-run reads retain healthy neighbors after owner damage;
// scans are silent and delete only expired owned concrete executions.
test('multi-run reads isolate unsafe owners and scans silently preserve damaged neighbors', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-multi-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let unsafe;
  const verifications = [];
  const api = windowsHostFixture(t, async (_command, _args, options, request) => {
    const input = request.input;
    if (request.operation === 'processTable') return { result: [{ pid: process.pid, ppid: process.ppid, pgid: null, started: '1' }] };
    if (input.resources) verifications.push(input.resources);
    if (input.resources?.some(({ target }) => target === unsafe)) throw new Error('unsafe ACL');
    return { result: true };
  });
  const owner = await api.currentUserIdentity();
  const { openRuns, scanExpired } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  const runs = [];
  for (const id of ['a', 'b', 'c'].map((value) => value.repeat(11))) runs.push(await ownedExecution(root, owner, id));
  const handles = runs.map(({ handle }) => handle);
  const context = { root, owner, retentionHours: 1, sourceIdentity };
  let results = await openRuns(context, handles);
  assert.ok(handles.every((handle) => results.get(handle).run?.handle === handle));
  assert.ok(verifications.some((resources) => resources.filter(({ target }) => target.endsWith('/owner.json') || target.endsWith('\\owner.json')).length > 1), 'Foreground multi-run verification remains batched.');
  const initial = verifications.length;
  results = await openRuns(context, [...handles, handles[0].slice(0, -22) + 'f'.repeat(22), 'invalid']);
  assert.ok(handles.every((handle) => results.get(handle).run?.handle === handle));
  assert.equal([...results.values()].filter(({ error }) => error?.code === 'runUnavailable').length, 2);
  assert.ok(verifications.length > initial);
  unsafe = path.join(runs[1].directory, 'owner.json');
  results = await openRuns(context, handles);
  assert.equal(results.get(handles[1]).error.code, 'runUnavailable');
  assert.ok(results.get(handles[0]).run && results.get(handles[2]).run);
  assert.equal(await scanExpired(context), undefined);
  assert.ok(await fs.stat(unsafe));
  unsafe = undefined;
  await fs.unlink(path.join(runs[1].directory, 'owner.json'));
  results = await openRuns(context, handles);
  assert.equal(results.get(handles[1]).error.code, 'runUnavailable');
  assert.ok(results.get(handles[0]).run && results.get(handles[2]).run);
  Object.assign(runs[0].meta, { terminalAt: Date.now() - 3600001, worker: { pid: 2147483647, started: '2' }, localTreeStopped: true });
  await fs.writeFile(path.join(runs[0].directory, 'owner.json'), JSON.stringify(runs[0].meta));
  assert.equal(await scanExpired(context), undefined);
  assert.equal(await fs.stat(runs[0].directory).catch(() => null), null);
  assert.ok(await fs.stat(runs[0].entryDirectory));
  assert.ok(await fs.stat(runs[1].directory));
  assert.ok(await fs.stat(runs[2].directory));
});

// Test Value Gate: 128 candidate runs with long Unicode paths must fit each
// native transport input and leave a 129th run outside this bounded scan.
test('large owner scans bound native stdin batches and the number of runs', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-owner-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '长路径'.repeat(20));
  await fs.mkdir(root);
  const payloads = [];
  const api = windowsHostFixture(t, async (_command, _args, options, request) => {
    assert.equal(request.schemaVersion, 1);
    assert.equal(options.env.AW_SUBAGENT_PLATFORM_INPUT, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(request.input)) <= 18 * 1024, 'ACL work keeps its bounded batch size.');
    const input = request.input;
    payloads.push(input);
    return { result: true };
  });
  const owner = await api.currentUserIdentity();
  const runs = [];
  for (let index = 0; index < 129; index++) runs.push(await ownedExecution(root, owner, index.toString(16).padStart(11, '0')));
  const { scanExpired } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  assert.equal(await scanExpired({ root, owner, retentionHours: 24, sourceIdentity }), undefined);
  const observed = new Set(payloads.flatMap(({ resources = [] }) => resources.filter(({ kind, target }) => kind === 'file' && path.basename(target) === 'owner.json').map(({ target }) => target)));
  assert.equal(observed.size, 128);
  assert.ok([...observed].every((target) => runs.some((run) => target === path.join(run.directory, 'owner.json'))));
  assert.equal((await fs.readdir(root)).length, 129);
});

// Test Value Gate: wait must revalidate after sleeping. A newly unsafe target
// must fail independently while a healthy target's unread message is delivered.
test('multi-target wait rechecks permissions after a polling delay', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-wait-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runs = [];
  let batches = 0;
  const api = windowsHostFixture(t, async (_command, _args, options, request) => {
    if (request.operation === 'processTable') return { result: [{ pid: process.pid, ppid: process.ppid, pgid: null, started: '1' }] };
    const input = request.input;
    if (input.resources?.filter(({ target }) => path.basename(target) === 'current.json').length === 2) {
      batches++;
      if (batches === 2) await fs.writeFile(path.join(runs[0].directory, 'events', 'message.json'), JSON.stringify({ type: 'message', text: 'Healthy target message.' }));
    }
    if (batches >= 2 && input.resources?.some(({ target }) => target === path.join(runs[1].directory, 'owner.json'))) throw new Error('changed ACL');
    return { result: true };
  });
  const owner = await api.currentUserIdentity();
  for (const id of ['a'.repeat(11), 'b'.repeat(11)]) {
    const run = await ownedExecution(root, owner, id, { terminalAt: null, worker: { pid: process.pid, started: '1' } });
    await fs.writeFile(path.join(run.directory, 'snapshot.json'), JSON.stringify({ state: 'running', sequence: 2, ready: true, initialization: null, initializationSequence: 0 }));
    await fs.writeFile(path.join(run.directory, 'observed.json'), JSON.stringify({ sequence: 2, initializationSequence: 0, terminalConsumed: false }));
    runs.push(run);
  }
  const { waitRuns } = await import('../skills/codex-subagent-guide/scripts/runtime/commands.mjs');
  const result = await waitRuns({ root, owner }, { runs: runs.map(({ handle }) => handle), timeoutMs: 5000 });
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /Healthy target message\./);
  assert.match(result.diagnostic, /<diagnostic [^>]*code="runUnavailable"/);
  assert.doesNotMatch(result.text, /runUnavailable/);
  assert.equal(batches, 2);
  assert.deepEqual(await fs.readdir(path.join(runs[0].directory, 'events')), []);
  assert.ok(await fs.stat(path.join(runs[1].directory, 'owner.json')));
});

// Test Value Gate: creation must protect each resource before exposing a valid
// entry, and keep initial JSON publication atomic across the new directory levels.
test('run creation protects prepared resources before entry publication', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-create-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const operations = [];
  const api = windowsHostFixture(t, async (_command, _args, options, request) => {
    const input = request.input;
    if (Object.keys(input).length === 0) return { stdout: JSON.stringify('S-1-5-21-123-456-789-1001') };
    operations.push(input);
    return { result: true };
  });
  const owner = await api.currentUserIdentity();
  const { createRun, readOwner, publishRun } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  const context = { root, owner, sourceIdentity };
  const run = await createRun(context, 'fixture', root, sourceIdentity);
  await assert.rejects(readOwner(context, run.meta.id), { code: 'runUnavailable' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run.directory, 'snapshot.json'), 'utf8')), run.snapshot);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run.directory, 'observed.json'), 'utf8')), { sequence: 0, initializationSequence: 0, terminalConsumed: false });
  assert.equal((await fs.readdir(run.directory)).some((name) => name.endsWith('.tmp')), false);
  assert.ok(operations.some((input) => input.resources?.length === 4 && input.resources.every(({ kind }) => kind === 'directory')));
  assert.ok(operations.some((input) => input.resources?.length === 3 && input.resources.every(({ target, kind }) => target.endsWith('.tmp') && kind === 'file')));
  await publishRun(context, run);
  assert.deepEqual((await readOwner(context, run.meta.id)).meta, run.meta);
  const protectedTargets = new Set(operations.flatMap(({ resources = [] }) => resources.map(({ target }) => target)));
  for (const target of [run.entryDirectory, run.containerDirectory, run.directory]) assert.ok(protectedTargets.has(target));
});

// Test Value Gate: failed ACL protection must publish none of the staged files.
// Later rename failure preserves each completed atomic publication and foreign nodes.
test('batched JSON publication preserves old state on protection failure and cleans its temporary files', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-json-batch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reject = true;
  windowsHostFixture(t, async () => {
    if (reject) throw new Error('private ACL failure');
    return { result: true };
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
  windowsHostFixture(t, async (_command, _args, options, request) => {
    const input = request.input;
    return { result: true };
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
  windowsHostFixture(t, async (_command, _args, options, request) => {
    const input = request.input;
    return { result: true };
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
  const api = windowsHostFixture(t, async (_command, _args, options, request) => {
    const input = request.input;
    operations.push(input);
    if (rejectTree && !input.resources) throw new Error('unsafe descendant');
    return { result: true };
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

// Test Value Gate: required native operations accept only the tool prepared by
// AW. Missing or mismatched context cannot launch a helper or select a fallback.
test('native operations reject absent or invalid AW context and keep the selected tool fixed', async () => {
  const entry = new URL('../skills/codex-subagent-guide/scripts/runtime/windows-native.mjs', import.meta.url).href;
  const execute = promisify(originalExecFile);
  const tool = { state: 'ready', protocol: 'aw.windows-job.v1', executable: path.resolve('fixture-native/aw-windows-job.exe'), sha256: `sha256:${'1'.repeat(64)}` };
  const context = (value) => JSON.stringify({ schemaVersion: 1, tools: { 'windows-job': value } });
  const script = `import { windowsNativeOperation } from ${JSON.stringify(entry)};
try { await windowsNativeOperation('pathCheck', { target: process.cwd(), kind: 'directory' }); process.exitCode = 1; }
catch (error) { process.stdout.write(error.code); }`;
  for (const raw of [undefined, '{', '{}', JSON.stringify({ schemaVersion: 1, tools: {} }), context({ ...tool, protocol: 'other.v1' }), context({ state: 'unavailable', protocol: tool.protocol, code: 'nativeCacheMiss' })]) {
    const environment = { ...process.env };
    if (raw === undefined) delete environment.AW_NATIVE_TOOL_CONTEXT;
    else environment.AW_NATIVE_TOOL_CONTEXT = raw;
    const result = await execute(process.execPath, ['--input-type=module', '--eval', script], { env: environment });
    assert.equal(result.stdout, 'platformUnavailable');
  }
  const selected = await execute(process.execPath, ['--input-type=module', '--eval', `
import { windowsJobExecutable } from ${JSON.stringify(entry)};
const first = await windowsJobExecutable();
process.env.AW_NATIVE_TOOL_CONTEXT = '{}';
process.stdout.write(JSON.stringify([first, await windowsJobExecutable()]));`], { env: { ...process.env, AW_NATIVE_TOOL_CONTEXT: context(tool) } });
  assert.deepEqual(JSON.parse(selected.stdout), [tool.executable, tool.executable]);
});

// Test Value Gate: only the fixed versioned input/output contract can authorize
// a filesystem, process or Job result. Failed exits never supply valid evidence.
test('native protocol bounds input and output and rejects invalid success evidence', async (t) => {
  const { windowsNativeOperation } = await import('../skills/codex-subagent-guide/scripts/runtime/windows-native.mjs');
  let response = { result: true };
  let calls = 0;
  const target = path.resolve(os.tmpdir());
  windowsHostFixture(t, async (command, args, options, request) => {
    calls++;
    assert.equal(path.basename(command), 'aw-windows-job.exe');
    assert.deepEqual(args, ['--operation']);
    assert.equal(options.shell, false);
    assert.equal(options.env.AW_SUBAGENT_PLATFORM_INPUT, undefined);
    assert.equal(request.schemaVersion, 1);
    return response;
  });
  assert.equal(await windowsNativeOperation('pathCheck', { target, kind: 'directory' }), true);
  for (const input of [() => windowsNativeOperation('script', {}), () => windowsNativeOperation('pathCheck', { target, kind: 'directory', script: 'PRIVATE' }), () => windowsNativeOperation('rootPublish', { source: `${path.parse(target).root}${'a'.repeat(256 * 1024)}`, destination: target })]) await assert.rejects(input, { code: 'platformOperationFailed' });
  assert.equal(calls, 1, 'Invalid or oversized input must not launch a helper.');
  for (const [scenario, reason] of [
    [{ stdout: '{"schemaVersion":2,"result":true}' }, 'invalidResult'],
    [{ stdout: '{"schemaVersion":1,"result":true,"extra":1}' }, 'invalidResult'],
    [{ result: false }, 'invalidResult'],
    [{ stdout: '{"schemaVersion":1,"result":true}\n{}' }, 'invalidJson'],
    [{ stdout: Buffer.from([0xff]) }, 'invalidJson'],
    [{ stdout: 'x'.repeat(8 * 1024 * 1024 + 1) }, 'outputLimit'],
    [{ result: true, code: 7 }, 'processExit'],
    [{ error: new Error('PRIVATE_NATIVE_ERROR') }, 'launchFailed'],
  ]) {
    response = scenario;
    await assert.rejects(windowsNativeOperation('pathCheck', { target, kind: 'directory' }), (error) => {
      assert.equal(error.code, 'platformOperationFailed');
      assert.match(error.message, new RegExp(`"reason":"${reason}"`));
      assert.equal(error.message.includes('PRIVATE'), false);
      return true;
    });
  }
  for (const result of [[{ pid: process.pid, ppid: process.ppid, pgid: null, started: 12 }], [{ pid: process.pid, ppid: process.ppid, pgid: 1, started: '10' }], []]) {
    response = { result };
    await assert.rejects(windowsNativeOperation('processTable', { requiredPids: [process.pid] }), { code: 'platformOperationFailed' });
  }
});

// Test Value Gate: the finite protocol deadline must reject an unresponsive
// helper and terminate it, so an operation cannot wait indefinitely.
test('native protocol terminates an operation at its deadline', async (t) => {
  const { windowsNativeOperation } = await import('../skills/codex-subagent-guide/scripts/runtime/windows-native.mjs');
  let launched;
  const started = new Promise((resolve) => { launched = resolve; });
  windowsHostFixture(t, async () => { launched(); return new Promise(() => {}); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operation = windowsNativeOperation('processTable', { requiredPids: [process.pid] });
  await started;
  const rejected = assert.rejects(operation, (error) => error.code === 'platformOperationFailed' && error.message.includes('"reason":"timeout"'));
  t.mock.timers.tick(30000);
  await rejected;
});

// Test Value Gate: failure to read an owned PID cannot prove it exited. The
// worker observation and expiry paths must retain state and never signal it.
test('required process identities remain mandatory through observation and expiry caches', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-required-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requiredPid = 424242;
  const requests = [];
  let inaccessible = false;
  const api = windowsHostFixture(t, async (_command, _args, _options, request) => {
    if (request.operation === 'processTable') {
      requests.push(request.input.requiredPids);
      if (inaccessible && request.input.requiredPids.includes(requiredPid)) throw new Error('Access denied.');
      return { result: [{ pid: process.pid, ppid: process.ppid, pgid: null, started: '10' }] };
    }
    assert.notEqual(request.operation, 'processStop');
    return { result: true };
  });
  const owner = await api.currentUserIdentity();
  const { workerAlive, removeExpired } = await import('../skills/codex-subagent-guide/scripts/runtime/store.mjs');
  const { observeTree, stopOwnedTree } = await import('../skills/codex-subagent-guide/scripts/runtime/processes.mjs');
  const context = { root, owner, retentionHours: 1, sourceIdentity };
  assert.equal(await workerAlive(context, { worker: { pid: process.pid, started: '10' } }), true);
  inaccessible = true;
  const run = await ownedExecution(root, owner, 'a'.repeat(11), { worker: { pid: requiredPid, started: '10' }, localTreeStopped: true, terminalAt: Date.now() - 3600001 });
  await assert.rejects(workerAlive(context, run.meta), { code: 'runObservationFailed' });
  await assert.rejects(removeExpired(context, run), { code: 'runObservationFailed' });
  const known = [{ ...run.meta.worker, ownership: run.meta.token, owner }];
  await assert.rejects(observeTree(requiredPid, known, run.meta.token), { code: 'platformOperationFailed' });
  await assert.rejects(stopOwnedTree(requiredPid, known, run.meta.token), { code: 'platformOperationFailed' });
  assert.ok(requests.slice(1).every((pids) => pids.includes(process.pid) && pids.includes(requiredPid)));
  assert.ok(await fs.stat(path.join(run.directory, 'owner.json')));
});
