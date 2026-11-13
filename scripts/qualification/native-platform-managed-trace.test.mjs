import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const enableName = 'AW_NATIVE_QUALIFICATION_MANAGED_TRACE';
const previousEnable = process.env[enableName];
delete process.env[enableName];
const { createManagedTraceRunner, createManagedTraceWriter, managedTraceConfiguration, managedTraceInstalled } =
  await import('./native-platform-managed-trace.mjs');
if (previousEnable !== undefined) process.env[enableName] = previousEnable;

const PUBLIC_MARKER = 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-managed-trace-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'client-entry');
  const other = path.join(root, 'other-entry');
  await fs.writeFile(entry, 'fixture'); await fs.writeFile(other, 'fixture');
  await fs.mkdir(path.join(root, 'sub'));
  return { root, entry, other, alias: `${root}${path.sep}sub${path.sep}..${path.sep}client-entry` };
}

// Test Value Gate: time only the selected system executable while retaining the
// original Promise, errors, budget and nonselected-call privacy boundary.
test('samples completed Windows Codex PowerShell queries in the eight unmatched rows', async (t) => {
  const { root, entry, other } = await fixture(t);
  const system = path.join(root, 'system');
  const query = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await fs.mkdir(path.dirname(query), { recursive: true }); await fs.writeFile(query, 'query-fixture');
  const invocation = Object.freeze({ command: query, args: ['private-encoded-command'], env: { private: 'not-recorded' }, timeoutMs: 1234 });
  for (const outcome of ['success', 'nonzero', 'reject', 'sync-throw']) {
    const records = []; const result = { exitCode: outcome === 'nonzero' ? 3 : 0, stdout: 'not-recorded', stderr: 'not-recorded' };
    const error = new Error('not-recorded');
    let settle; let reject;
    const original = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    let calls = 0;
    const wrapped = createManagedTraceRunner((received) => {
      calls += 1; assert.equal(received, invocation);
      if (outcome === 'sync-throw') throw error;
      return original;
    }, { entries: [entry], client: 'codex', platform: 'win32', env: { SystemRoot: system }, emit: record => records.push(record) });
    if (outcome === 'sync-throw') assert.throws(() => wrapped(invocation), received => received === error);
    else {
      const returned = wrapped(invocation); assert.equal(returned, original); assert.equal(records.length, 0);
      if (outcome === 'reject') { reject(error); await assert.rejects(returned, received => received === error); }
      else { settle(result); assert.equal(await returned, result); }
    }
    assert.equal(calls, 1); assert.equal(records.length, 1);
    const record = records[0]; assert.equal(record.phase, 'unmatched'); assert.equal(record.commandRole, 'windows-system-powershell');
    assert.equal(record.threw, ['reject','sync-throw'].includes(outcome));
    assert.equal(record.exitCode, ['reject','sync-throw'].includes(outcome) ? null : result.exitCode);
    assert(record.elapsedMs >= 0); assert.match(record.startTime, /^\d{4}-/u); assert.match(record.finishTime, /^\d{4}-/u);
    assert(!JSON.stringify(record).includes('not-recorded')); assert(!JSON.stringify(record).includes('private-encoded-command'));
  }
  for (const [client, platform, systemRoot, command, selected] of [
    ['codex','win32',system,query,true], ['pi','win32',system,query,false], ['codex','linux',system,query,false],
    ['codex','win32',path.join(root,'missing'),query,false], ['codex','win32',system,other,false],
  ]) {
    const records=[]; const original=Promise.resolve({exitCode:0});
    const wrapped=createManagedTraceRunner(() => original, { entries:[entry],client,platform,env:{SystemRoot:systemRoot},emit:record=>records.push(record) });
    for(let i=0;i<12;i++) { assert.equal(wrapped({command,args:[]}),original); await original; }
    assert.equal(records.length,8); assert.equal(records.every(record=>record.commandRole==='windows-system-powershell'),selected);
    if(!selected) assert(records.every(record=>Object.entries(record).every(([key,value])=>key==='phase'||typeof value==='boolean')));
  }
});

// Test Value Gate: private diagnostics retain the exact invocation, including
// stdin exchange and cancellation, and return/reject the original native objects.
test('passes one original invocation and returns the same successful or nonzero result', async (t) => {
  const { entry } = await fixture(t);
  const input = Object.freeze({ initial: 'private input', onStdout() { return { end: true }; } });
  const invocation = Object.freeze({ command: entry, args: Object.freeze(['install', 'fixture']), input,
    env: Object.freeze({ [PUBLIC_MARKER]: 'public-value' }), signal: new AbortController().signal, timeoutMs: 1234 });
  for (const exitCode of [0, 7]) {
    const result = Object.freeze({ exitCode, stdout: 'private output', stderr: 'native stderr' });
    const records = [];
    let calls = 0;
    const wrapped = createManagedTraceRunner(async (received) => {
      calls += 1; assert.equal(received, invocation); assert.equal(received.input, input); return result;
    }, { entries: [entry], client: 'pi', env: { [PUBLIC_MARKER]: 'public-value' }, emit: (record) => records.push(record) });
    assert.equal(await wrapped(invocation), result); assert.equal(calls, 1);
    assert.deepEqual(records.map((record) => record.phase), ['start', 'finish']);
    assert.equal(records[0].parentPid, process.pid); assert.equal(records[0].operationId, records[1].operationId);
    assert.equal(records[0].startTime, records[1].startTime); assert.match(records[1].finishTime, /^\d{4}-/u);
    assert.equal(records[0].publicMarkerProvided, true); assert.equal(records[1].exitCode, exitCode);
    assert.equal(records[1].threw, false); assert(!('stdout' in records[1]));
    assert.equal('stderr' in records[1], exitCode !== 0);
    if (exitCode !== 0) assert.equal(records[1].stderr, result.stderr);
    assert(!('childPid' in records[0])); assert(!('nativeMarkerPresent' in records[0]));
    assert(!('env' in records[0])); assert(!('input' in records[0]));
  }
});

test('throws the original error and captures safe exit, timeout, and cleanup metadata only', async (t) => {
  const { entry } = await fixture(t);
  const invocation = { command: entry, args: ['install', 'fixture'] };
  for (const reason of ['exit', 'timeout', 'aborted']) {
    const cleanupError = new Error();
    Object.defineProperty(cleanupError, 'message', { get() { throw new Error('cleanup message must not be read'); } });
    const error = Object.assign(new Error(), { exitCode: 9, stderr: 'native failure', reason,
      cause: { code: 'ENOENT' }, cleanupError,
      operationDiagnostic: { code: 'nativeCliFailed', safeMessage: 'The platform CLI exited unsuccessfully.' } });
    Object.defineProperty(error, 'message', { get() { throw new Error('error message must not be read'); } });
    const records = [];
    const wrapped = createManagedTraceRunner(async (received) => { assert.equal(received, invocation); throw error; },
      { entries: [entry], client: 'codex', env: {}, emit: (record) => records.push(record) });
    await assert.rejects(wrapped(invocation), (received) => received === error);
    const finish = records[1];
    assert.equal(finish.threw, true); assert.equal(finish.exitCode, 9); assert.equal(finish.reason, reason);
    assert.deepEqual(finish.cause, { code: 'ENOENT' }); assert.deepEqual(finish.operationDiagnostic, error.operationDiagnostic);
    assert.equal(finish.cleanupError, true); assert.equal(finish.stderr, 'native failure'); assert(!('stdout' in finish));
    assert(!('message' in finish));
  }
});

test('matches only real whitelist files in command or args[0] and directly delegates other promises', async (t) => {
  const { entry, other, alias } = await fixture(t);
  const records = [];
  const result = { exitCode: 0, stdout: '', stderr: '' };
  const pending = Promise.resolve(result);
  let received;
  const wrapped = createManagedTraceRunner((invocation) => { received = invocation; return pending; },
    { entries: [entry], client: 'pi', env: {}, emit: (record) => records.push(record) });
  for (const { invocation, matched } of [
    { invocation: { command: entry, args: [] }, matched: true },
    { invocation: { command: alias, args: [] }, matched: true },
    { invocation: { command: process.execPath, args: [entry, '--version'] }, matched: true },
    { invocation: { command: other, args: [] }, matched: false },
    { invocation: { command: process.execPath, args: ['unrelated', entry] }, matched: false },
    { invocation: { command: entry, args: [1] }, matched: false },
    { invocation: { command: entry }, matched: false },
    ...(process.platform === 'win32' ? [{ invocation: { command: entry.toUpperCase(), args: [] }, matched: true }] : []),
  ]) {
    const count = records.length;
    const returned = wrapped(invocation);
    if (!matched) assert.equal(returned, pending);
    assert.equal(await returned, result); assert.equal(received, invocation);
    assert.equal(records.length - count, matched ? 2 : 1);
    if (!matched) {
      assert.equal(records.at(-1).phase, 'unmatched');
      assert(Object.entries(records.at(-1)).every(([key, value]) => key === 'phase' || typeof value === 'boolean'));
    }
  }
});

// Test Value Gate: missed selection must be distinguishable from an unused
// runner, without recording nonselected invocation data or changing promises.
test('bounds unmatched diagnostics to eight fixed metadata records', async (t) => {
  const { entry, other } = await fixture(t);
  const records = [];
  const pending = Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  const wrapped = createManagedTraceRunner(() => pending,
    { entries: [entry], client: 'codex', env: {}, emit: (record) => records.push(record) });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(wrapped({ command: other, args: ['private-argument'], env: { TOKEN: 'secret' } }), pending);
  }
  assert.equal(records.length, 8);
  assert.deepEqual(records[0], { phase: 'unmatched', commandAbsolute: true, commandResolved: true,
    firstArgumentAbsolute: false, firstArgumentResolved: false, commandCaseInsensitiveMatch: false,
    argumentCaseInsensitiveMatch: false, argumentsAreStrings: true });
  assert(!JSON.stringify(records).includes(other)); assert(!JSON.stringify(records).includes('secret'));
});

// Test Value Gate: retained logical argv and failure details must not expose
// markers, including UUIDs generated inside the native backend after this seam.
test('removes environment markers and unknown UUIDs before truncation without changing native data', async (t) => {
  const { entry } = await fixture(t);
  const hostName = 'AW_MANAGED_TRACE_TEST_MARKER';
  const previousHost = process.env[hostName];
  process.env[hostName] = 'host-secret-value';
  t.after(() => { if (previousHost === undefined) delete process.env[hostName]; else process.env[hostName] = previousHost; });
  const secrets = ['host-secret-value', 'preload-secret-value', 'initial-secret-value', 'option-secret-value',
    '12345678-abcd-4abc-9abc-0123456789ab', 'ABCDEF12-3456-7890-ABCD-1234567890AB'];
  const args = [secrets.join('/'), 'a'.repeat(1100), ...Array.from({ length: 20 }, (_, index) => `arg${index}`)];
  const invocation = Object.freeze({ command: entry, args: Object.freeze(args),
    env: Object.freeze({ [PUBLIC_MARKER]: secrets[1], some_marker: secrets[3] }) });
  const error = Object.freeze({ exitCode: 1, reason: `exit-${secrets[4]}`, stderr: `${secrets.join('/')}\n${'e'.repeat(5000)}`,
    cause: { code: `CUSTOM-${secrets[2]}` }, operationDiagnostic: { code: 'nativeCliFailed', safeMessage: secrets.join('/') } });
  const records = [];
  const wrapped = createManagedTraceRunner(async (received) => { assert.equal(received, invocation); throw error; },
    { entries: [entry], client: 'codex', env: { [PUBLIC_MARKER]: secrets[1], INITIAL_MARKER: secrets[2] },
      emit: (record) => records.push(record) });
  await assert.rejects(wrapped(invocation), (received) => received === error);
  assert.equal(records[0].args.length, 16); assert.equal(records[0].args[1].length, 1024);
  assert.equal(records[1].stderr.length, 4000); assert.equal(invocation.args.length, 22);
  const encoded = JSON.stringify(records);
  for (const secret of secrets) assert(!encoded.includes(secret));
});

test('captures bounded successful stdout only for exact Codex marketplace list', async (t) => {
  const { entry } = await fixture(t);
  for (const { client, command, args, capture, exitCode = 0 } of [
    { client: 'codex', command: entry, args: ['plugin', 'marketplace', 'list', '--json'], capture: true },
    { client: 'codex', command: process.execPath, args: [entry, 'plugin', 'marketplace', 'list', '--json'], capture: true },
    { client: 'codex', command: entry, args: ['plugin', 'list', '--json'], capture: false },
    { client: 'pi', command: entry, args: ['plugin', 'marketplace', 'list', '--json'], capture: false },
    { client: 'codex', command: entry, args: ['plugin', 'marketplace', 'list', '--json'], capture: false, exitCode: 7 },
  ]) {
    const records = [];
    const result = Object.freeze({ exitCode, stdout: `registry-output-secret${'r'.repeat(5000)}`, stderr: 'native stderr' });
    const wrapped = createManagedTraceRunner(async () => result,
      { entries: [entry], client, env: { REGISTRY_MARKER: 'registry-output-secret' }, emit: (record) => records.push(record) });
    assert.equal(await wrapped({ command, args }), result);
    assert.equal('stdout' in records[1], capture);
    if (capture) assert.equal(records[1].stdout, 'r'.repeat(4000));
    assert.equal('stderr' in records[1], exitCode !== 0); assert.equal(records[0].publicMarkerProvided, false);
  }
});

test('keeps successful results and original throws when emit fails', async (t) => {
  const { entry } = await fixture(t);
  const invocation = { command: entry, args: [] };
  const result = Object.freeze({ exitCode: 0, stdout: 'original', stderr: '' });
  const error = new Error('original failure');
  for (const thrown of [false, true]) {
    let calls = 0;
    const wrapped = createManagedTraceRunner((received) => {
      calls += 1; assert.equal(received, invocation);
      if (thrown) throw error;
      return Promise.resolve(result);
    }, { entries: [entry], client: 'pi', env: {}, emit() { throw new Error('emit failure'); } });
    if (thrown) await assert.rejects(wrapped(invocation), (received) => received === error);
    else assert.equal(await wrapped(invocation), result);
    assert.equal(calls, 1);
  }
});

// Test Value Gate: trace IO failure and exhaustion cannot overwrite existing
// files, exceed the private JSONL budget, or replace a real runner result.
test('owns a new private JSONL file and enforces record and byte limits', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'count.jsonl');
  const writer = createManagedTraceWriter(file); t.after(writer.close);
  for (let index = 0; index < 100; index += 1) assert.equal(writer.emit({ index }), index < 96);
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 96); assert.equal(lines.at(-1).index, 95);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const byteFile = path.join(root, 'bytes.jsonl');
  const byteWriter = createManagedTraceWriter(byteFile); t.after(byteWriter.close);
  assert.equal(byteWriter.emit({ text: 'x'.repeat(256 * 1024) }), false);
  assert.equal(byteWriter.emit({ text: '界'.repeat(30000) }), true);
  assert.equal(byteWriter.emit({ text: '界'.repeat(30000) }), true);
  assert.equal(byteWriter.emit({ text: '界'.repeat(30000) }), false);
  const bytes = await fs.readFile(byteFile); assert(bytes.length <= 256 * 1024);
  assert.equal(bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line)).length, 2);
});

test('leaves existing content unchanged and keeps native results when the writer fails', async (t) => {
  const { root, entry } = await fixture(t);
  const existing = path.join(root, 'existing.jsonl'); await fs.writeFile(existing, 'foreign-content');
  const writer = createManagedTraceWriter(existing); t.after(writer.close);
  assert.equal(writer.emit({ phase: 'start' }), false); assert.equal(await fs.readFile(existing, 'utf8'), 'foreign-content');
  const unavailable = createManagedTraceWriter(path.join(root, 'missing-directory', 'trace.jsonl')); t.after(unavailable.close);
  const result = Object.freeze({ exitCode: 0, stdout: 'original', stderr: '' });
  const wrapped = createManagedTraceRunner(async () => result,
    { entries: [entry], client: 'pi', env: {}, emit: unavailable.emit });
  assert.equal(await wrapped({ command: entry, args: [] }), result);
});

test('does not install by default and requires every hosted guard', async (t) => {
  assert.equal(managedTraceInstalled, false); assert.equal(managedTraceConfiguration({}), undefined);
  const { root, entry } = await fixture(t);
  const valid = { GITHUB_ACTIONS: 'true', AW_NATIVE_QUALIFICATION_MANAGED_TRACE: '1',
    AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'codex',
    AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([entry]),
    AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: path.join(root, 'trace.jsonl') };
  assert.deepEqual(managedTraceConfiguration(valid, 'linux'), { entries: [entry], client: 'codex', file: valid.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE });
  assert.equal(managedTraceConfiguration({ ...valid, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'pi' }, 'win32').client, 'pi');
  for (const name of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[name]; assert.equal(managedTraceConfiguration(missing, 'linux'), undefined);
  }
  for (const change of [
    { GITHUB_ACTIONS: 'false' }, { AW_NATIVE_QUALIFICATION_MANAGED_TRACE: 'true' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'grok' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: 'invalid-json' }, { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: '[]' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: '["relative-entry"]' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([root]) },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([path.join(root, 'missing')]) },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: 'relative-trace.jsonl' },
  ]) assert.equal(managedTraceConfiguration({ ...valid, ...change }, 'linux'), undefined);
  for (const client of ['claude', 'gemini', 'copilot']) {
    assert.equal(managedTraceConfiguration({ ...valid, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: client }, 'darwin').client, client);
  }
  assert.equal(managedTraceConfiguration(valid, 'freebsd'), undefined);
});
