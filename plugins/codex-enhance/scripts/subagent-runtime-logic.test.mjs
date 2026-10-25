import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

// Queue and output selection tests use real runtime modules and real files.
// Only Windows PowerShell identity, ACL and directory-move calls are replaced;
// the native runtime suite owns their real OS behavior and worker lifecycle.
const originalExecFile = childProcess.execFile;
let commands, store, files, output, cli;
try {
  childProcess.execFile = Object.assign(() => {}, { [promisify.custom]: async (_command, _args, options) => {
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

const displayLimit = 8192;
const messageLimit = 4096;
const blockPattern = /^BEGIN_(MESSAGE|INPUT|FINAL|DIAGNOSTIC):([a-f0-9]{8})\n([\s\S]*?)\nEND_\1:\2\n/gm;
const blocks = (text, kind) => [...text.matchAll(blockPattern)].filter((match) => match[1] === kind).map((match) => match[3]);
const field = (text, key) => text.replace(blockPattern, '').match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];
const bounded = (response) => {
  assert.ok(Buffer.byteLength(response.text) + Buffer.byteLength(response.diagnostic ?? '') <= displayLimit);
  assert.ok(Buffer.byteLength(response.diagnostic ?? '') <= 1024);
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-runtime-logic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const context = await store.storeContext({ temporaryRoot: directory });
  const run = await store.createRun(context, 'fixture', directory);
  // There is no worker in this suite. This cached identity is the native process
  // observation boundary for sendInput, which otherwise uses the real store.
  run.meta.worker = { pid: process.pid, started: 'fixture-worker' };
  context.table = [run.meta.worker];
  run.snapshot = { state: 'running', sequence: 2, communicationSupported: true, communicationSequence: 2 };
  await files.atomicJson(path.join(run.directory, 'owner.json'), run.meta);
  await files.atomicJson(path.join(run.directory, 'snapshot.json'), run.snapshot);
  await files.atomicJson(path.join(run.directory, 'observed.json'), { sequence: 2, communicationSequence: 2, terminalConsumed: false });
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

// Test Value Gate: parent sends must cross the actual sendInput/outbox path above
// both removed quotas. Closing must retain every queued input as a delivery gap.
test('parent outbox accepts more than 64 full messages and preserves every pending input on close', async (t) => {
  const f = await fixture(t);
  const messages = Array.from({ length: 66 }, (_, index) => `${String(index).padStart(2, '0')}:` + 'x'.repeat(messageLimit - 3));
  for (const text of messages) {
    const sent = await commands.sendInput(f.context, { ...f.request, text });
    assert.equal(sent.exitCode, 0, sent.text); assert.equal(field(sent.text, 'delivery'), 'queued');
  }
  const names = await store.recordFiles(f.run, 'outbox');
  const queued = await Promise.all(names.map((name) => store.readRecord(f.run, 'outbox', name)));
  assert.deepEqual(queued.map((input) => input.text), messages);
  assert.equal(new Set(queued.map((input) => input.id)).size, messages.length);
  assert.ok(queued.every((input) => input.phase === 'queued'));
  assert.ok(queued.reduce((bytes, input) => bytes + Buffer.byteLength(input.text), 0) > 256 * 1024);
  await f.complete();
  const result = await commands.readResult(f.context, { ...f.request, export: true });
  assert.equal(result.exitCode, 0);
  const text = await output.collectReport(result.report, result.token, Infinity);
  assert.deepEqual(blocks(text, 'INPUT'), messages);
  assert.equal(field(text, 'delivery_gaps'), '66');
  assert.equal((text.match(/^delivery: notSubmitted$/gm) ?? []).length, messages.length);
  assert.deepEqual(await store.recordFiles(f.run, 'outbox'), []);
  await result.afterOutput();
});

// Test Value Gate: large unread queues must survive default overflow intact and
// export in full. Successful consumption leaves only the rereadable fixed final.
test('large unread queues export completely after a non-consuming resultTooLarge error', async (t) => {
  const f = await fixture(t);
  const messages = Array.from({ length: 66 }, (_, index) => `${String(index).padStart(2, '0')}:` + 'x'.repeat(messageLimit - 3));
  await f.messages(messages); await f.complete('Short final answer.');
  await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, communicationSequence: 0, terminalConsumed: false });
  const before = await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8');
  const tooLarge = await commands.readResult(f.context, f.request);
  assert.equal(tooLarge.exitCode, 1); bounded(tooLarge);
  assert.equal(field(tooLarge.text, 'code'), 'resultTooLarge');
  assert.equal(field(tooLarge.text, 'output_limit_bytes'), String(displayLimit));
  assert.ok(Number(field(tooLarge.text, 'result_bytes')) > displayLimit);
  assert.deepEqual(blocks(tooLarge.text, 'MESSAGE'), []); assert.deepEqual(blocks(tooLarge.text, 'FINAL'), []);
  assert.equal(await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8'), before);
  assert.equal((await store.recordFiles(f.run, 'events')).length, messages.length);
  const exported = await commands.readResult(f.context, { ...f.request, export: true });
  assert.equal(exported.exitCode, 0);
  const text = await output.collectReport(exported.report, exported.token, Infinity);
  assert.deepEqual(blocks(text, 'MESSAGE'), messages); assert.deepEqual(blocks(text, 'FINAL'), ['Short final answer.']);
  assert.equal(field(text, 'communication'), 'true');
  assert.equal(Buffer.byteLength(text), Number(field(tooLarge.text, 'result_bytes')));
  assert.ok(Buffer.byteLength(text) > 256 * 1024); assert.doesNotMatch(text, /^expires_at:/m);
  // Constructing a report is read-only; the CLI owns when stdout has succeeded.
  assert.equal((await store.recordFiles(f.run, 'events')).length, messages.length);
  await exported.afterOutput();
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'wait: settled\n');
  const reread = await commands.readResult(f.context, f.request);
  assert.equal(reread.exitCode, 0); assert.deepEqual(blocks(reread.text, 'MESSAGE'), []);
  assert.equal(field(reread.text, 'communication'), undefined);
  assert.deepEqual(blocks(reread.text, 'FINAL'), ['Short final answer.']);
});

// Test Value Gate: a fitting final must be included in the first terminal wait,
// rather than deferred because of unused diagnostic capacity.
test('wait includes a 7300-byte final when the complete response fits without diagnostics', async (t) => {
  const f = await fixture(t);
  const finalText = 'x'.repeat(7300);
  await f.complete(finalText);
  const terminal = await commands.waitRuns(f.context, f.request);
  assert.equal(terminal.exitCode, 0); bounded(terminal); assert.equal(terminal.diagnostic, '');
  assert.equal(field(terminal.text, 'result'), undefined);
  assert.deepEqual(blocks(terminal.text, 'FINAL'), [finalText]);
  assert.ok(Buffer.byteLength(terminal.text) > displayLimit - 1024);
  const result = await commands.readResult(f.context, f.request);
  assert.equal(result.exitCode, 0); bounded(result); assert.equal(result.diagnostic, '');
  assert.deepEqual(blocks(result.text, 'FINAL'), [finalText]);
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'wait: settled\n');
});

// Test Value Gate: wait must consume only whole selected messages and deliver an
// oversized terminal notification once, while keeping its fixed final exportable.
test('wait preserves whole events across batches and defers an oversized final only once', async (t) => {
  const f = await fixture(t);
  const messages = ['甲'.repeat(1365) + 'x', 'y'.repeat(messageLimit), 'z'.repeat(messageLimit)];
  const finalText = '答案\n'.repeat(3000);
  await f.messages(messages); await f.complete(finalText);
  await files.atomicJson(path.join(f.run.directory, 'observed.json'), { sequence: 1, communicationSequence: 0, terminalConsumed: false });
  const received = []; let deferred = 0;
  for (let index = 0; index < 6 && received.length < messages.length; index++) {
    const response = await commands.waitRuns(f.context, f.request);
    assert.equal(response.exitCode, 0); bounded(response); received.push(...blocks(response.text, 'MESSAGE'));
    if (field(response.text, 'result') === 'deferred') {
      deferred++;
      assert.equal(field(response.text, 'deferred_reason'), 'outputLimit');
      assert.equal(field(response.text, 'communication'), 'true');
      assert.ok(Number(field(response.text, 'result_bytes')) > displayLimit);
      assert.deepEqual(blocks(response.text, 'FINAL'), []); assert.doesNotMatch(response.text, /^expires_at:/m);
    }
    if (received.length < messages.length) assert.equal(field(response.text, 'more'), 'true');
    assert.equal((await store.recordFiles(f.run, 'events')).length, messages.length - received.length);
  }
  assert.deepEqual(received, messages); assert.equal(deferred, 1);
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'wait: settled\n');
  const exported = await commands.readResult(f.context, { ...f.request, export: true });
  assert.equal(exported.exitCode, 0);
  const text = await output.collectReport(exported.report, exported.token, Infinity);
  assert.deepEqual(blocks(text, 'FINAL'), [finalText]); assert.deepEqual(blocks(text, 'MESSAGE'), []);
  await exported.afterOutput();
});

// Test Value Gate: preflight reserves a real consume-error diagnostic. Overflow
// and failed deletion preserve unread records and their observation position.
test('default result reserves consume-error bytes and retains messages after deletion failure', async (t) => {
  const f = await fixture(t);
  const message = 'z'.repeat(messageLimit);
  await f.messages([message]); await f.complete('a');
  const finalFile = path.join(f.run.directory, 'final.json');
  const originalFinal = await files.readJson(finalFile);
  const baseline = await commands.readResult(f.context, f.request);
  assert.equal(baseline.exitCode, 0);
  const baselineBytes = Buffer.byteLength(baseline.text);
  const reportSize = async (bytes) => {
    const finalText = 'a'.repeat(bytes - baselineBytes + 1);
    await files.atomicJson(finalFile, { ...originalFinal, text: finalText });
    return finalText;
  };
  const before = await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8');
  await reportSize(displayLimit);
  const tooLarge = await commands.readResult(f.context, f.request);
  assert.equal(tooLarge.exitCode, 1); bounded(tooLarge);
  assert.equal(field(tooLarge.text, 'code'), 'resultTooLarge');
  assert.equal(field(tooLarge.text, 'result_bytes'), String(displayLimit));
  assert.deepEqual(blocks(tooLarge.text, 'MESSAGE'), []); assert.deepEqual(blocks(tooLarge.text, 'FINAL'), []);
  const finalText = await reportSize(displayLimit - 128);
  const failed = await commands.readResult(f.context, f.request);
  assert.equal(failed.exitCode, 0); assert.equal(Buffer.byteLength(failed.text), displayLimit - 128);
  const unlink = fs.unlink;
  const denied = t.mock.method(fs, 'unlink', async (target, ...options) => {
    if (path.dirname(target) === path.join(f.run.directory, 'events')) throw Object.assign(new Error('Fixture event deletion denied.'), { code: 'EACCES' });
    return unlink.call(fs, target, ...options);
  });
  try { await assert.rejects(failed.afterOutput(), { code: 'resultConsumeFailed' }); }
  finally { denied.mock.restore(); }
  bounded({ text: failed.text, diagnostic: output.diagnostic('resultConsumeFailed') });
  assert.equal(await fs.readFile(path.join(f.run.directory, 'observed.json'), 'utf8'), before);
  assert.deepEqual(blocks(failed.text, 'MESSAGE'), [message]);
  const recovered = await commands.readResult(f.context, f.request);
  assert.equal(recovered.exitCode, 0); bounded(recovered);
  assert.deepEqual(blocks(recovered.text, 'MESSAGE'), [message]); assert.deepEqual(blocks(recovered.text, 'FINAL'), [finalText]);
  await recovered.afterOutput();
  assert.equal((await commands.waitRuns(f.context, f.request)).text, 'wait: settled\n');
});

// Test Value Gate: syntax rejection must happen before run lookup or mutation;
// name, integer and obsolete-command boundaries belong to the public parser.
test('parseCommand rejects obsolete commands, malformed names, sizes and duplicate options', () => {
  const start = ['start', '--executor', 'fixture', '--prompt', 'task'];
  const invalid = [
    ['run'], ['poll'], ['resume'], ['cleanup'], ['start', '--profile', 'advisorProfile', '--prompt', 'task'], [...start, '--executor', 'other'], [...start, '--preview'], [...start, '--communication', 'true'],
    ...['中文', ' spaced', '../path', '.leading', 'x'.repeat(65)].map((name) => [...start, '--name', name]),
    ...['0', '-1', '1.5', '9007199254740991'].map((value) => [...start, '--deadline-ms', value]),
    ['result', '--run', 'handle', '--output-file', 'must-not-exist'], ['result', '--run', 'handle', '--export', 'must-not-exist'],
    ['result', '--run', 'handle', '--run', 'second'], [...start, '--prompt', 'second'],
    ['wait', '--run', 'handle', '--timeout-ms', '-1'], ['wait', '--run', 'handle', '--timeout-ms', '1800001'],
    ['wait', ...Array.from({ length: 17 }, (_, index) => ['--run', `run-${index}`]).flat()],
  ];
  for (const args of invalid) assert.throws(() => cli.parseCommand(args), { name: 'RuntimeError' }, args.join(' '));
  assert.equal(cli.parseCommand([...start, '--name', 'x'.repeat(64)]).name.length, 64);
  assert.equal(cli.parseCommand(['wait', '--run', 'handle', '--timeout-ms', '0']).timeoutMs, 0);
  assert.equal(cli.parseCommand(['wait', '--run', 'handle', '--timeout-ms', '1800000']).timeoutMs, 1800000);
});

// Test Value Gate: real stdin and instruction helpers must reject blank, binary,
// interactive and oversized input before creating any temporary run resources.
test('command input validation rejects invalid stdin and instruction files before side effects', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-runtime-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const temporaryRoot = path.join(directory, 'temporary'); await fs.mkdir(temporaryRoot);
  const snapshot = { installedIdentity: { plugin: 'fixture' }, resourceRoot: directory,
    effectiveValues: {
      subagentCommands: [{ key: 'fixture', adapter: 'custom', mode: 'workspace', command: process.execPath }] } };
  const dependencies = { temporaryRoot, readRuntimeConfig: async () => snapshot };
  const start = ['start', '--executor', 'fixture', '--workspace', directory, '--prompt', '-'];
  for (const [bytes, code] of [[Buffer.from(' \r\n'), 'inputEmpty'], [Buffer.from([0xff]), 'binaryUnsupported'],
    [Buffer.from([0]), 'binaryUnsupported'], [Buffer.alloc(262145, 120), 'taskTooLarge']]) {
    await assert.rejects(cli.executeCommand(cli.parseCommand(start), { ...dependencies, stdin: Readable.from([bytes]) }), { code });
  }
  await assert.rejects(files.readStdin({ isTTY: true }), { code: 'stdinInteractive' });
  const instructions = path.join(directory, 'instructions.md');
  for (const [bytes, code] of [[Buffer.from('  '), 'inputEmpty'], [Buffer.from([0xff]), 'binaryUnsupported'], [Buffer.alloc(262145, 120), 'instructionsTooLarge']]) {
    await fs.writeFile(instructions, bytes);
    const args = [...start.slice(0, -1), 'task', '--instructions-file', instructions];
    await assert.rejects(cli.executeCommand(cli.parseCommand(args), dependencies), { code });
  }
  for (const [bytes, code] of [[Buffer.from(' \r\n'), 'messageInvalid'], [Buffer.from([0xff]), 'binaryUnsupported'],
    [Buffer.from([0]), 'binaryUnsupported'], [Buffer.alloc(messageLimit + 1, 120), 'messageTooLarge']]) {
    const request = cli.parseCommand(['send', '--run', 'handle', '--text', '-']);
    await assert.rejects(cli.executeCommand(request, { ...dependencies, stdin: Readable.from([bytes]) }), { code });
  }
  const maximumMessage = await cli.executeCommand(cli.parseCommand(['send', '--run', 'handle', '--text', '-']), {
    ...dependencies, stdin: Readable.from([Buffer.alloc(messageLimit, 120)]),
  });
  assert.equal(maximumMessage.exitCode, 1); assert.equal(field(maximumMessage.text, 'code'), 'runUnavailable');
  await assert.rejects(cli.executeCommand(cli.parseCommand([...start, '--file', '']), dependencies), { code: 'filesNotAllowedInWorkspace' });
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});
