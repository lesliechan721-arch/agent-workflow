import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { validateDiagnostics } from '../skills/codex-subagent-guide/scripts/runtime/contracts.mjs';
import { field } from './fixtures/windows-qualification.mjs';

// Queue and output selection tests use real runtime modules and real files.
// Windows identity, ACL, directory-move and process-table calls are replaced;
// the native runtime suite owns their real OS behavior and worker lifecycle.
const originalExecFile = childProcess.execFile;
let commands, store, files, output, cli;
try {
  childProcess.execFile = Object.assign(() => {}, { [promisify.custom]: async (_command, _args, options) => {
    if (path.basename(_command).toLowerCase() === 'whoami.exe') return { stdout: '"fixture","S-1-5-21-123-456-789-1001"\r\n' };
    if (options.env.AW_SUBAGENT_NATIVE_OPERATION === 'processTable') return { stdout: JSON.stringify([
      { pid: process.pid, ppid: process.ppid, pgid: null, started: '123456789' },
    ]) };
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString('utf8'));
    if (input.source && input.destination) await fs.rename(input.source, input.destination);
    else if (!input.target && !input.resources && Object.keys(input).length) throw new Error('Unexpected native runtime operation.');
    return { stdout: JSON.stringify(Object.keys(input).length ? true : 'S-1-5-21-123-456-789-1001') };
  } });
  syncBuiltinESMExports();
  [commands, store, files, output, cli] = await Promise.all([
    import('../skills/codex-subagent-guide/scripts/runtime/commands.mjs'),
    import('../skills/codex-subagent-guide/scripts/runtime/store.mjs'),
    import('../skills/codex-subagent-guide/scripts/runtime/files.mjs'),
    import('../skills/codex-subagent-guide/scripts/runtime/output.mjs'),
    import('../skills/codex-subagent-guide/scripts/subagent.mjs'),
  ]);
} finally {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
}

const displayLimit = 32768;
const messageLimit = 24576;
const blockPattern = /<(message|input|result|diagnostic)(?:_\d+)?\b[^>]*>\n([\s\S]*?)\n<\/\1(?:_\d+)?>\n/g;
const blocks = (text, kind) => [...text.matchAll(blockPattern)].filter((match) => match[1] === ({ MESSAGE: 'message', INPUT: 'input', FINAL: 'result', DIAGNOSTIC: 'diagnostic' }[kind] ?? kind)).map((match) => match[2]);
const bounded = (response) => {
  assert.ok(Buffer.byteLength(response.text) + Buffer.byteLength(response.diagnostic ?? '') <= displayLimit);
  assert.ok(Buffer.byteLength(response.diagnostic ?? '') <= 1024);
};

function mockProcessObserver(t) {
  const nativeSpawn = childProcess.spawn;
  const observer = t.mock.method(childProcess, 'spawn', (command, ...args) => {
    if (command !== '/bin/ps') return nativeSpawn(command, ...args);
    const child = new EventEmitter(); child.stdout = Readable.from([Buffer.from(`${process.pid} ${process.ppid} ${process.pid} fixture-worker\n`)]);
    child.kill = () => {}; child.stdout.once('end', () => child.emit('close', 0)); return child;
  });
  syncBuiltinESMExports(); t.after(() => { observer.mock.restore(); syncBuiltinESMExports(); });
}

async function fixture(t, sharedContext) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-runtime-logic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const context = sharedContext ?? await store.storeContext({ homeRoot: directory });
  const run = await store.createRun(context, 'fixture', directory);
  // There is no worker in this suite. This cached identity is the native process
  // observation boundary for sendInput, which otherwise uses the real store.
  run.meta.worker = { pid: process.pid, started: process.platform === 'win32' ? '123456789' : 'fixture-worker' };
  context.table = [run.meta.worker];
  run.snapshot = { state: 'running', ready: true, sequence: 2, initialization: { environment: { status: 'available' }, capabilities: { communication: { status: 'enabled', transport: 'mcp', passiveDelivery: 'in-turn' }, resume: { status: 'unsupported' } } }, initializationSequence: 2 };
  await files.atomicJson(path.join(run.directory, 'owner.json'), run.meta);
  await files.atomicJson(path.join(run.directory, 'snapshot.json'), run.snapshot);
  await files.atomicJson(path.join(run.directory, 'observed.json'), { sequence: 2, initializationSequence: 2, terminalConsumed: false });
  await store.publishRun(context, run);
  return { context, run, request: { runs: [run.handle], timeoutMs: 0 },
    async messages(texts) {
      for (const [index, text] of texts.entries()) await files.atomicJson(path.join(run.directory, 'events', `${String(index).padStart(4, '0')}.json`), { type: 'message', text });
    },
    async complete(text = 'Complete final answer.') {
      run.meta.terminalAt = Date.now(); run.meta.localTreeStopped = true;
      run.snapshot = { ...run.snapshot, state: 'completed', sequence: 3 };
      await files.atomicJson(path.join(run.directory, 'owner.json'), run.meta);
      await files.atomicJson(path.join(run.directory, 'final.json'), { protocolVersion: 5, type: 'result', state: 'completed', generationStarted: true, backendExitCode: 0, text });
      await files.atomicJson(path.join(run.directory, 'snapshot.json'), run.snapshot);
    },
  };
}

// Test Value Gate: short handles must locate the same owned run and reject a
// different key or unsafe path without accepting the previous handle format.
test('short run handles retain independent lookup and key validation', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run.handle.length, 38);
  assert.match(f.run.handle, /^aw5-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(f.run.meta.id, 'base64url').length, 8);
  assert.equal(Buffer.from(f.run.meta.key, 'base64url').length, 16);
  assert.deepEqual(store.parseHandle(f.run.handle), { id: f.run.meta.id, key: f.run.meta.key });
  assert.equal((await store.openRun(f.context, f.run.handle)).directory, f.run.directory);
  const differentKey = `${f.run.meta.key[0] === 'A' ? 'B' : 'A'}${f.run.meta.key.slice(1)}`;
  await assert.rejects(store.openRun(f.context, `aw5-${f.run.meta.id}-${differentKey}`), { code: 'runUnavailable' });
  for (const invalid of [`aw5-${'a'.repeat(32)}-${'b'.repeat(32)}`, `aw5-${'../'.repeat(3)}aa-${f.run.meta.key}`, f.run.handle + 'x']) {
    assert.throws(() => store.parseHandle(invalid), { code: 'runUnavailable' });
  }
});

// Test Value Gate: queues have no cumulative quota; each retained input gap is
// reported once per report even when its delivery event is also unread.
test('queued inputs preserve original text and fixed delivery gaps without duplicate blocks', async (t) => {
  const f = await fixture(t);
  const messages = Array.from({ length: 66 }, (_, index) => `${index}:` + 'x'.repeat(4000));
  for (const text of messages) {
    const response = await commands.sendInput(f.context, { ...f.request, text });
    assert.equal(response.exitCode, 0);
    assert.equal(response.text, `queued ${f.run.handle}\n`);
    assert.equal(field(response.text, 'delivery'), 'queued');
  }
  await f.complete();
  const destination = path.join(f.run.directory, 'export.txt');
  const exported = await commands.readResult(f.context, { ...f.request, outputFile: destination });
  assert.equal(exported.exitCode, 0);
  const text = await fs.readFile(destination, 'utf8');
  assert.deepEqual(blocks(text, 'INPUT'), messages);
  assert.match(exported.text, new RegExp(`bytes=${Buffer.byteLength(text)} consumed=true\n$`));
  assert.deepEqual(await store.recordFiles(f.run, 'outbox'), []);
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'settled\n');
});

// Test Value Gate: ordinary overflow must preserve unread messages; direct file
// export writes a complete report before consuming the exact frozen event list.
test('large reports require a file and preserve all messages until complete export', async (t) => {
  const f = await fixture(t);
  const messages = ['甲'.repeat(8191) + 'xxx', 'y'.repeat(messageLimit), 'z'.repeat(messageLimit)];
  await f.messages(messages); await f.complete('Complete answer.');
  const before = await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8');
  const limited = await commands.readResult(f.context, f.request);
  assert.equal(limited.exitCode, 1); bounded(limited);
  assert.equal(limited.text, ''); assert.match(limited.diagnostic, /code="resultTooLarge"/);
  assert.match(limited.diagnostic, /--output-file/); assert.doesNotMatch(limited.diagnostic, /--export/);
  assert.equal(await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8'), before);
  assert.equal((await store.recordFiles(f.run, 'events')).length, 3);
  const destination = path.join(f.run.directory, 'complete 中文.txt');
  const exported = await commands.readResult(f.context, { ...f.request, outputFile: destination });
  assert.equal(exported.exitCode, 0);
  const text = await fs.readFile(destination, 'utf8');
  assert.deepEqual(blocks(text, 'MESSAGE'), messages); assert.deepEqual(blocks(text, 'FINAL'), ['Complete answer.']);
  assert.equal(exported.text, `exported ${f.run.handle} path=${JSON.stringify(destination)} bytes=${Buffer.byteLength(text)} consumed=true\n`);
  if (process.platform !== 'win32') assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'settled\n');
  const reread = await commands.readResult(f.context, f.request);
  assert.deepEqual(blocks(reread.text, 'MESSAGE'), []); assert.deepEqual(blocks(reread.text, 'FINAL'), ['Complete answer.']);
});

// Test Value Gate: fitting terminal text must be delivered, while oversized
// terminal notifications are consumed once without removing the fixed result.
test('wait drains complete message batches and defers only oversized terminal notifications', async (t) => {
  const f = await fixture(t);
  const messages = ['x'.repeat(messageLimit), 'y'.repeat(messageLimit), 'z'.repeat(messageLimit)];
  await f.messages(messages); await f.complete('大答案\n'.repeat(12000));
  await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, initializationSequence: 0, terminalConsumed: false });
  const seen = []; let deferred = 0;
  for (let index = 0; index < 6; index++) {
    const response = await commands.waitRuns(f.context, f.request); bounded(response);
    assert.equal(response.exitCode, 0); seen.push(...blocks(response.text, 'MESSAGE'));
    if (response.text.startsWith('settled')) break;
    if (response.text.includes(`deferred ${f.run.handle}`)) { deferred++; assert.match(response.text, /state=completed communication=true/); }
    if (seen.length < messages.length) assert.match(response.text, /^more=true\n/);
  }
  assert.deepEqual(seen, messages); assert.equal(deferred, 1);
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'settled\n');
  assert.ok(await fs.stat(path.join(f.run.directory, 'final.json')));
  const fitting = await fixture(t); await fitting.complete('a'.repeat(7300));
  const response = await commands.waitRuns(fitting.context, fitting.request); bounded(response);
  assert.deepEqual(blocks(response.text, 'FINAL'), ['a'.repeat(7300)]);
  assert.doesNotMatch(response.text, /deferred/);
});

// Test Value Gate: a closing sequence alone must not end wait or consume ready;
// ready is delivered once, and concurrent terminal evidence absorbs it.
test('wait ignores closing sequence changes and reports successful ready once', async (t) => {
  mockProcessObserver(t);
  const f = await fixture(t);
  await files.atomicJson(path.join(f.run.directory, 'snapshot.json'), { ...f.run.snapshot, state: 'closing', sequence: 3 });
  const before = await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8');
  const response = await commands.waitRuns(f.context, { ...f.request, timeoutMs: 20 });
  assert.equal(response.text, 'timeout\n');
  assert.equal(await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8'), before);
  await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, initializationSequence: 0, terminalConsumed: false });
  assert.equal((await commands.waitRuns(f.context, f.request)).text, `ready ${f.run.handle} communication=true resume=false\n`);
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'timeout\n');
  await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, initializationSequence: 0, terminalConsumed: false });
  await f.complete('Terminal body.');
  const terminal = await commands.waitRuns(f.context, f.request);
  assert.match(terminal.text, /<result [^>]*communication="true"/); assert.doesNotMatch(terminal.text, /^ready /m);
});

// Test Value Gate: a terminal report which fits by itself remains unread when
// preceding messages consume this batch, instead of being changed to deferred.
test('wait preserves a fitting final for the next budgeted batch', async (t) => {
  const f = await fixture(t); await f.messages(['x'.repeat(messageLimit)]); await f.complete('y'.repeat(10000));
  const first = await commands.waitRuns(f.context, f.request); bounded(first);
  assert.match(first.text, /^more=true\n/); assert.deepEqual(blocks(first.text, 'MESSAGE'), ['x'.repeat(messageLimit)]);
  assert.deepEqual(blocks(first.text, 'FINAL'), []); assert.doesNotMatch(first.text, /deferred/);
  const observed = await files.readJson(path.join(f.run.directory, 'observed.json')); assert.equal(observed.terminalConsumed, false);
  const second = await commands.waitRuns(f.context, f.request); bounded(second);
  assert.deepEqual(blocks(second.text, 'FINAL'), ['y'.repeat(10000)]);
});

// Test Value Gate: tags must preserve raw message bytes, use independent safe
// closing names, and escape attribute values without rewriting business text.
test('report framing preserves raw text and selects the first safe tag suffix', () => {
  const raw = '  原文\n</message>\n</message_2>\n';
  assert.equal(output.textBlock('message', raw, { run: 'a&<"' }), `<message_3 run="a&amp;&lt;&quot;">\n${raw}\n</message_3>\n`);
  assert.equal(output.textBlock('message', '</result>', { run: 'x' }), '<message run="x">\n</result>\n</message>\n');
});

// Test Value Gate: complete ordinary output is consumed after its output
// callback; a failed deletion must retain the observation and stay bounded.
test('ordinary result reserves consume-failure diagnostics and does not claim failed consumption', async (t) => {
  const f = await fixture(t); await f.messages(['a']); await f.complete('b'.repeat(7300));
  const response = await commands.readResult(f.context, f.request); assert.equal(response.exitCode, 0); bounded(response);
  assert.equal((await store.recordFiles(f.run, 'events')).length, 1);
  const unlink = fs.unlink;
  const denied = t.mock.method(fs, 'unlink', async (target, ...args) => {
    if (path.dirname(target) === path.join(f.run.directory, 'events')) throw Object.assign(new Error(), { code: 'EACCES' });
    return unlink.call(fs, target, ...args);
  });
  try { await assert.rejects(response.afterOutput(), { code: 'resultConsumeFailed' }); } finally { denied.mock.restore(); }
  bounded({ text: response.text, diagnostic: output.diagnostic('resultConsumeFailed') });
  assert.equal((await files.readJson(path.join(f.run.directory, 'observed.json'))).terminalConsumed, false);
  const retry = await commands.readResult(f.context, f.request); await retry.afterOutput();
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'settled\n');
});

// Test Value Gate: export must never overwrite caller files; create, write and
// close failures retain unread records and disclose any incomplete output.
test('file export preserves unread messages on create, write and close failures', async (t) => {
  const f = await fixture(t); await f.messages(['Unread']); await f.complete('Final');
  const destination = path.join(f.run.directory, 'output.txt');
  await fs.writeFile(destination, 'Existing');
  const exists = await commands.readResult(f.context, { ...f.request, outputFile: destination });
  assert.equal(exists.exitCode, 1); assert.match(exists.diagnostic, /code="resultOutputExists"/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'Existing');
  await fs.unlink(destination);
  for (const failure of ['write', 'close']) {
    const open = fs.open;
    const denied = t.mock.method(fs, 'open', async (target, ...args) => {
      const handle = await open.call(fs, target, ...args);
      if (target === destination) {
        const original = handle[failure].bind(handle);
        handle[failure] = async (...values) => { if (failure === 'close') await original(...values); throw new Error('Injected I/O failure.'); };
      }
      return handle;
    });
    let response;
    try { response = await commands.readResult(f.context, { ...f.request, outputFile: destination }); } finally { denied.mock.restore(); }
    assert.equal(response.exitCode, 1); assert.equal(response.text, '');
    assert.match(response.diagnostic, /code="resultOutputFailed"/); assert.match(response.diagnostic, /complete=false bytes=/);
    assert.equal((await store.recordFiles(f.run, 'events')).length, 1); assert.ok(await fs.stat(destination));
    await fs.unlink(destination);
  }
});

// Test Value Gate: a complete export survives partial consumption failure and
// reports consumed=false, so callers can recover without losing the output.
test('complete file export reports consumption failure without deleting the file', async (t) => {
  const f = await fixture(t); await f.messages(['Retained message']); await f.complete('Retained final');
  const destination = path.join(f.run.directory, 'complete.txt'); const unlink = fs.unlink;
  const denied = t.mock.method(fs, 'unlink', async (target, ...args) => {
    if (path.dirname(target) === path.join(f.run.directory, 'events')) throw new Error('Injected deletion failure.');
    return unlink.call(fs, target, ...args);
  });
  let response;
  try { response = await commands.readResult(f.context, { ...f.request, outputFile: destination }); } finally { denied.mock.restore(); }
  assert.equal(response.exitCode, 1); assert.match(response.text, /consumed=false\n$/); assert.match(response.diagnostic, /code="resultConsumeFailed"/);
  assert.deepEqual(blocks(await fs.readFile(destination, 'utf8'), 'MESSAGE'), ['Retained message']);
  assert.equal((await store.recordFiles(f.run, 'events')).length, 1);
});

// Test Value Gate: unsupported forms must fail before any store or stdin work.
test('parse rejects missing, mixed, repeated, stdin and removed options', () => {
  const invalid = [
    ['start', '--executor', 'x'], ['send', '--run', 'x'],
    ['start', '--executor', 'x', '--prompt', '-'], ['start', '--executor', 'x', '--prompt-file', '-'],
    ['send', '--run', 'x', '--text', '-'], ['send', '--run', 'x', '--text-file', '-'],
    ['start', '--executor', 'x', '--prompt', 'task', '--prompt-file', 'file'],
    ['send', '--run', 'x', '--text', 'text', '--text-file', 'file'],
    ['result', '--run', 'x', '--export'], ['result', '--run', 'x', '--output-file', 'file', '--export'],
    ['result', '--run', 'x', '--details'], ['result', '--run', 'x', '--output-file', 'a', '--output-file', 'b'],
    ['start', '--executor', 'x', '--prompt-file', 'a', '--prompt-file', 'b'],
    ['send', '--run', 'x', '--text', 'a', '--text', 'b'], ['wait', '--run', 'x', '--text', 'a'],
  ];
  for (const args of invalid) assert.throws(() => cli.parseCommand(args), { code: 'argumentsInvalid' }, args.join(' '));
  assert.equal(cli.parseCommand(['start', '--executor', 'x', '--prompt-file', './-']).promptFile, './-');
  assert.equal(cli.parseCommand(['wait', '--run', 'x', '--run', 'x', '--timeout-ms', '0']).timeoutMs, 0);
});

// Test Value Gate: help must work without configuration or task side effects,
// and diagnostics must be an explicit per-command display option.
test('command help bypasses required task inputs and diagnostics parses for every operation', async () => {
  const overview = await cli.executeCommand(cli.parseCommand(['--help']));
  assert.equal(overview.exitCode, 0);
  for (const operation of ['start', 'send', 'wait', 'result', 'stop']) {
    const help = await cli.executeCommand(cli.parseCommand([operation, '--help']));
    assert.equal(help.exitCode, 0);
    assert.notEqual(help.text, overview.text);
    assert.match(help.text, new RegExp(`Usage: ${operation} `));
    assert.deepEqual(cli.parseCommand([operation, '-h']), cli.parseCommand([operation, '--help']));
    const args = operation === 'start' ? ['--executor', 'x', '--prompt', 'task']
      : operation === 'send' ? ['--run', 'x', '--text', 'input'] : ['--run', 'x'];
    assert.equal(cli.parseCommand([operation, ...args, '--diagnostics']).showDiagnostics, true);
    assert.throws(() => cli.parseCommand([operation, ...args, '--diagnostics', '--diagnostics']), { code: 'argumentsInvalid' });
  }
  assert.throws(() => cli.parseCommand(['wait', '--unknown']), (error) => error.code === 'argumentsInvalid' && error.message.includes('wait --help'));
});

// Test Value Gate: successful runs stay quiet, startup warnings are not repeated,
// late warnings remain visible, and explicit diagnostics can recover full evidence.
test('result display filters routine diagnostics and retains new warnings', async (t) => {
  const f = await fixture(t);
  const normal = ['codexExecutableSelected', 'communicationPermissionExisting', 'communicationPermissionAdded', 'profileFieldIrrelevant', 'hookTrustBypassed']
    .map((code) => ({ code, message: `Routine ${code}.` }));
  const warning = { code: 'profileFieldIgnored', field: 'features.unknown', message: 'Unsupported override.' };
  const late = { code: 'backendActionDenied', message: 'A tool action was denied.' };
  await f.complete();
  await files.atomicJson(path.join(f.run.directory, 'snapshot.json'), { ...f.run.snapshot, diagnostics: [...normal, warning] });
  await files.atomicJson(path.join(f.run.directory, 'final.json'), { protocolVersion: 5, type: 'result', state: 'completed',
    generationStarted: true, backendExitCode: 0, text: 'Retained answer.', diagnostics: [late, late] });
  const result = await commands.readResult(f.context, f.request);
  assert.deepEqual(blocks(result.text, 'DIAGNOSTIC'), [late.message]);
  assert.deepEqual(blocks(result.text, 'FINAL'), ['Retained answer.']);
  // A fast terminal read must also deliver ready warnings that were never read.
  await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, initializationSequence: 0, terminalConsumed: false });
  const first = await commands.readResult(f.context, f.request);
  assert.deepEqual(blocks(first.text, 'DIAGNOSTIC'), [warning.message, late.message]);
  const waited = await commands.waitRuns(f.context, f.request);
  assert.deepEqual(blocks(waited.text, 'DIAGNOSTIC'), [warning.message, late.message]);
  assert.deepEqual(blocks((await commands.readResult(f.context, f.request)).text, 'DIAGNOSTIC'), [late.message]);
  const detailed = await commands.readResult(f.context, { ...f.request, showDiagnostics: true });
  assert.deepEqual(blocks(detailed.text, 'DIAGNOSTIC'), [...normal, warning, late].map((entry) => entry.message));
  const destination = path.join(f.run.directory, 'diagnostics.txt');
  assert.equal((await commands.readResult(f.context, { ...f.request, showDiagnostics: true, outputFile: destination })).exitCode, 0);
  assert.equal(await fs.readFile(destination, 'utf8'), detailed.text);
});

// Test Value Gate: user files must be read strictly once, preserve BOM and raw
// text, reject special types, and use the caller directory before any mutation.
test('input files preserve UTF-8 and reject invalid content or node types', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-input-files-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'input.txt');
  for (const [bytes, code] of [[Buffer.from([0xff]), 'inputFileInvalid'], [Buffer.from([0]), 'inputFileInvalid'], [Buffer.from('  '), 'inputFileInvalid'], [Buffer.alloc(messageLimit + 1, 120), 'messageTooLarge']]) {
    await fs.writeFile(target, bytes);
    await assert.rejects(files.readInputFile('input.txt', messageLimit, 'messageTooLarge', directory), { code });
  }
  const text = '\ufeff  原文\n\n'; await fs.writeFile(target, text);
  assert.equal(await files.readInputFile('input.txt', messageLimit, 'messageTooLarge', directory), text);
  await assert.rejects(files.readInputFile(directory, messageLimit, 'messageTooLarge'), { code: 'inputFileInvalid' });
  await assert.rejects(files.readInputFile(path.join(directory, 'missing'), messageLimit, 'messageTooLarge'), { code: 'inputFileReadFailed' });
  if (process.platform !== 'win32') {
    const link = path.join(directory, 'link'); await fs.symlink(target, link);
    await assert.rejects(files.readInputFile(link, messageLimit, 'messageTooLarge'), { code: 'inputFileInvalid' });
  }
  await fs.writeFile(path.join(directory, '-'), '-'); assert.equal(await files.readInputFile('./-', messageLimit, 'messageTooLarge', directory), '-');
});

// Test Value Gate: a corrupt event or a failed delete in one run must not block
// another requested run, and failed notification saves cannot claim delivery.
test('wait isolates read, event deletion and observation failures across requested runs', async (t) => {
  const broken = await fixture(t); const healthy = await fixture(t, broken.context);
  await broken.complete('Broken final'); await healthy.complete('Healthy final');
  await files.atomicJson(path.join(broken.run.directory, 'events', 'bad.json'), { type: 'message', text: 42 });
  const isolated = await commands.waitRuns(broken.context, { runs: [broken.run.handle, healthy.run.handle], timeoutMs: 0 });
  assert.equal(isolated.exitCode, 1); bounded(isolated);
  assert.ok(blocks(isolated.text, 'FINAL').includes('Healthy final')); assert.match(isolated.diagnostic, /code="runStateUnavailable"/);
  assert.ok(await fs.stat(path.join(broken.run.directory, 'events', 'bad.json')));
  await fs.unlink(path.join(broken.run.directory, 'events', 'bad.json'));
  const f = await fixture(t); await f.messages(['Must remain unread']); await f.complete('Saved final');
  const unlink = fs.unlink;
  const failedDelete = t.mock.method(fs, 'unlink', async (target, ...args) => {
    if (path.dirname(target) === path.join(f.run.directory, 'events')) throw new Error('Injected deletion failure.');
    return unlink.call(fs, target, ...args);
  });
  let response;
  try { response = await commands.waitRuns(f.context, f.request); } finally { failedDelete.mock.restore(); }
  assert.equal(response.exitCode, 1); bounded(response); assert.deepEqual(blocks(response.text, 'MESSAGE'), []);
  assert.match(response.text, /^more=true\n/); assert.equal((await store.recordFiles(f.run, 'events')).length, 1);
  const pending = await fixture(t); await pending.complete('Notification must remain unread');
  const rename = fs.rename;
  const failedSave = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === path.join(pending.run.directory, 'observed.json')) throw Object.assign(new Error('Injected save failure.'), { code: 'EACCES' });
    return rename.call(fs, source, target);
  });
  try { response = await commands.waitRuns(pending.context, pending.request); } finally { failedSave.mock.restore(); }
  assert.equal(response.exitCode, 1); bounded(response); assert.deepEqual(blocks(response.text, 'FINAL'), []);
  assert.equal((await files.readJson(path.join(pending.run.directory, 'observed.json'))).terminalConsumed, false);
  assert.deepEqual(blocks((await commands.waitRuns(pending.context, pending.request)).text, 'FINAL'), ['Notification must remain unread']);
});

// Test Value Gate: a delivery event and its fixed gap share one storage ID;
// including both queues must never duplicate the input in the same result.
test('result deduplicates delivery events and fixed input gaps by record ID', async (t) => {
  const f = await fixture(t); await f.complete();
  await files.atomicJson(path.join(f.run.directory, 'gaps', 'gap.json'), { text: 'Input raw\n', status: 'unknown', code: 'inputDeliveryUnknown' });
  await files.atomicJson(path.join(f.run.directory, 'events', 'event.json'), { type: 'delivery', gap: 'gap.json' });
  const response = await commands.readResult(f.context, f.request);
  assert.equal(response.exitCode, 0); assert.deepEqual(blocks(response.text, 'INPUT'), ['Input raw\n']);
  assert.ok(response.text.indexOf('<input ') < response.text.indexOf('<result '));
});

// Test Value Gate: many legal short initialization diagnostics must not make a
// deferred notification permanently exceed the ordinary wait display budget.
test('deferred terminal evidence remains deliverable with a full legal diagnostic list', async (t) => {
  const f = await fixture(t);
  f.run.snapshot.diagnostics = Array.from({ length: 64 }, (_, index) => ({ code: `warning00${String(index).padStart(2, '0')}`, message: 'x' }));
  await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, initializationSequence: 0, terminalConsumed: false });
  await f.complete('x'.repeat(40000));
  const response = await commands.waitRuns(f.context, f.request); bounded(response);
  assert.match(response.text, new RegExp(`^deferred ${f.run.handle} state=completed communication=true resume=false\\n`));
  for (const entry of f.run.snapshot.diagnostics) assert.ok(response.text.includes(`code="${entry.code}"`));
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'settled\n');
});

// Test Value Gate: corrupt terminal event/gap JSON, including a later I/O read
// failure, must leave that run unread while healthy runs still deliver in order.
test('wait isolates terminal candidate and freeze reads for bad runs in either position', async (t) => {
  for (const [position, kind] of [['first', 'event'], ['last', 'event'], ['first', 'gap'], ['last', 'gap'], ['last', 'laterRead']]) {
    const broken = await fixture(t), healthy = await fixture(t, broken.context);
    await broken.complete('Bad terminal'); await healthy.messages(['Healthy process message']); await healthy.complete('Healthy terminal');
    const target = path.join(broken.run.directory, kind === 'event' ? 'events' : 'gaps', 'bad.json');
    if (kind === 'laterRead') await files.atomicJson(target, { text: 'Original input', status: 'unknown', code: 'inputDeliveryUnknown' });
    else await fs.writeFile(target, '{broken');
    const originalOpen = fs.open; let reads = 0;
    const failure = kind === 'laterRead' ? t.mock.method(fs, 'open', async (selected, ...args) => {
      if (selected === target && ++reads >= 2) throw Object.assign(new Error('Injected later read failure.'), { code: 'EACCES' });
      return originalOpen.call(fs, selected, ...args);
    }) : undefined;
    let response;
    try { response = await commands.waitRuns(broken.context, { runs: position === 'first' ? [broken.run.handle, healthy.run.handle] : [healthy.run.handle, broken.run.handle], timeoutMs: 0 }); }
    finally { failure?.mock.restore(); }
    assert.equal(response.exitCode, 1, `${position}/${kind}`); bounded(response);
    assert.ok(blocks(response.text, 'FINAL').includes('Healthy terminal'), `${position}/${kind}`);
    assert.deepEqual(blocks(response.text, 'MESSAGE'), ['Healthy process message']);
    assert.match(response.diagnostic, kind === 'laterRead' ? /code="EACCES"/ : /code="jsonInvalid"/);
    assert.equal((await files.readJson(path.join(healthy.run.directory, 'observed.json'))).terminalConsumed, true);
    assert.equal((await files.readJson(path.join(broken.run.directory, 'observed.json'))).terminalConsumed, false);
    assert.deepEqual(await store.recordFiles(healthy.run, 'events'), []); assert.ok(await fs.stat(target));
  }
});

// Test Value Gate: the aggregate size of legal diagnostics and long fields must
// not prevent one ready/final/deferred notification or make subsequent waits spin.
test('wait budgets complete diagnostic lists with long fields for ready, final and deferred', async (t) => {
  mockProcessObserver(t);
  for (const [state, count, size] of [['ready', 64, 100], ['final', 20, 400], ['deferred', 64, 100]]) {
    const f = await fixture(t);
    const diagnostics = Array.from({ length: count }, (_, index) => ({ code: `warning${index}`, message: 'Backend reported a profile limit. ' + 'x'.repeat(size - 34), ...(index === 0 ? { field: 'features.' + 'f'.repeat(500) } : {}) }));
    validateDiagnostics(diagnostics);
    f.run.snapshot.diagnostics = diagnostics;
    await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, initializationSequence: 0, terminalConsumed: false });
    if (state === 'ready') await files.atomicJson(path.join(f.run.directory, 'snapshot.json'), f.run.snapshot);
    else await f.complete(state === 'deferred' ? 'x'.repeat(40000) : 'Small final');
    const response = await commands.waitRuns(f.context, f.request); bounded(response); assert.equal(response.exitCode, 0);
    if (state === 'ready') assert.match(response.text, new RegExp(`^ready ${f.run.handle} communication=true resume=false\n`));
    else if (state === 'deferred') assert.match(response.text, new RegExp(`^deferred ${f.run.handle} state=completed communication=true resume=false\n`));
    else assert.deepEqual(blocks(response.text, 'FINAL'), ['Small final']);
    assert.doesNotMatch(response.text, /code="diagnosticOmitted"/); assert.match(response.text, /Backend reported a profile limit/);
    for (const entry of diagnostics) assert.ok(response.text.includes(`code="${entry.code}"`));
    assert.equal((await commands.waitRuns(f.context, f.request)).text, state === 'ready' ? 'timeout\n' : 'settled\n');
  }
});

// Test Value Gate: the response-wide budget also includes more and errors from
// another run; these controls must not leave a large ready notice undeliverable.
test('large ready diagnostics drain across runs and remain deliverable beside a read error', async (t) => {
  mockProcessObserver(t);
  for (const broken of [false, true]) {
    const first = await fixture(t), second = await fixture(t, first.context);
    const diagnostics = Array.from({ length: 64 }, (_, index) => ({ code: `warning${index}`, message: 'Backend reported a profile limit. ' + 'x'.repeat(160) }));
    for (const f of [first, second]) {
      await files.atomicJson(path.join(f.run.directory, 'snapshot.json'), { ...f.run.snapshot, diagnostics });
      await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, initializationSequence: 0, terminalConsumed: false });
    }
    if (broken) { await second.complete('Broken terminal'); await fs.writeFile(path.join(second.run.directory, 'events', 'bad.json'), '{broken'); }
    const request = { runs: [first.run.handle, second.run.handle], timeoutMs: 0 };
    const response = await commands.waitRuns(first.context, request); bounded(response);
    assert.equal(response.exitCode, broken ? 1 : 0); assert.match(response.text, new RegExp(`ready ${first.run.handle} communication=true resume=false\n`));
    assert.doesNotMatch(response.text, /code="diagnosticOmitted"/);
    if (broken) assert.match(response.diagnostic, /code="jsonInvalid"/);
    const next = await commands.waitRuns(first.context, request); bounded(next);
    assert.doesNotMatch(next.text, new RegExp(`ready ${first.run.handle}`));
    if (!broken) assert.match(next.text, new RegExp(`ready ${second.run.handle} communication=true resume=false\n`));
  }
});
