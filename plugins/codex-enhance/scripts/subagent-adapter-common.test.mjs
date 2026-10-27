import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { renderCommunicationInstructions, summarizeDiagnostics } from '../skills/codex-subagent-guide/scripts/adapters/common.mjs';
import { validateFrame } from '../skills/codex-subagent-guide/scripts/runtime/protocol.mjs';
import { createChildBridge } from '../skills/codex-subagent-guide/scripts/runtime/adapter-channel.mjs';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const scripts = guideRuntimeScripts(import.meta.url);
const require = createRequire(import.meta.url);
const entry = require.resolve('./fixtures/adapter-common.mjs');
const now = Date.UTC(2026, 0, 1);
const month = 30 * 24 * 60 * 60 * 1000;
const testTimeoutMs = process.platform === 'win32' ? 30000 : 10000;

// Test Value Gate: a real adapterMain JSONL connection protects shared stop
// classification and timer boundaries without repeating native backend startup.
async function fixture(t, { deadlineAt = null, communication = true, args = [], codex } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-common-'));
  const workspace = path.join(root, 'workspace');
  const directory = path.join(root, 'runtime');
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'),
      FIXTURE_NOW: String(now),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const frames = [];
  const waiters = new Set();
  const clockWaiters = new Map();
  let diagnostic = '';
  let closed = false;
  let sequence = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostic += chunk; });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    frames.push(JSON.parse(line));
    for (const check of waiters) check();
  });
  child.on('message', (message) => {
    clockWaiters.get(message.id)?.(message);
    clockWaiters.delete(message.id);
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      closed = true;
      for (const check of waiters) check();
      resolve({ code, diagnostic });
    });
  });
  t.after(async () => {
    if (!closed) child.kill('SIGKILL');
    child.stdin.destroy();
    if (child.connected) child.disconnect();
    await exit;
    child.stdout.destroy(); child.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });
  const send = (frame) => child.stdin.write(`${JSON.stringify({ protocolVersion: 5, ...frame })}\n`);
  const waitFor = (type) => new Promise((resolve, reject) => {
    let timer;
    const finish = (error, frame) => {
      clearTimeout(timer); waiters.delete(check);
      if (error) reject(error); else resolve(frame);
    };
    const check = () => {
      const frame = frames.find((value) => value.type === type);
      if (frame) finish(null, frame);
      else if (closed) finish(new Error(`Missing ${type}: ${diagnostic}`));
    };
    waiters.add(check);
    timer = setTimeout(() => finish(new Error(`Missing ${type}: ${diagnostic}`)), testTimeoutMs);
    check();
  });
  const advance = (milliseconds = 0) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { clockWaiters.delete(id); reject(new Error(`Clock did not advance: ${diagnostic}`)); }, testTimeoutMs);
    clockWaiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.send({ id, milliseconds });
  });
  const finish = async () => {
    const result = await waitFor('result');
    child.stdin.destroy();
    if (child.connected) child.disconnect();
    const closed = await exit;
    assert.equal(closed.code, 0, closed.diagnostic);
    assert.equal(frames.filter((frame) => frame.type === 'result').length, 1);
    assert.equal(frames.at(-1).type, 'result');
    return result;
  };
  send({
    type: 'start', run: { id: randomBytes(16).toString('hex'), name: 'lifecycle-fixture', deadlineAt },
    execution: { executor: 'fixture' }, mode: 'workspace', workspace,
    prompt: 'Wait for the lifecycle stop.', args, communication, ...(codex === undefined ? {} : { codex }),
    runtime: { directory, toolkit: {
      command: process.execPath, module: path.join(scripts, 'runtime/adapter-channel.mjs'),
      messageScript: path.join(scripts, 'message.mjs'), mcpScript: path.join(scripts, 'message-mcp.mjs'),
    } },
  });
  return { child, frames, send, waitFor, advance, finish, directory, diagnostics: () => diagnostic };
}

for (const stop of ['requested', 'eof', 'deadline']) test(`adapterMain: ${stop} stops an active run without communication`, { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { deadlineAt: stop === 'deadline' ? now + 1000 : null });
  assert.deepEqual((await run.waitFor('ready')).initialization.capabilities.communication, { status: 'unsupported' });
  if (stop === 'requested') run.send({ type: 'stop', reason: 'requested' });
  else if (stop === 'eof') run.child.stdin.end();
  else {
    assert.equal((await run.advance(999)).aborted, false);
    await run.advance(1);
  }
  const closing = await run.waitFor('closing');
  assert.equal(closing.reason, stop === 'eof' ? 'error' : 'cancelled');
  assert.equal((await run.advance()).stopCalls, 1);
  const result = await run.finish();
  assert.equal(result.state, 'unknown');
  assert.equal(result.generationStarted, true);
  assert.equal(result.remoteStopConfirmed, false);
  assert.equal(result.code, stop === 'deadline' ? 'adapterDeadlineExceeded' : stop === 'eof' ? 'channelClosed' : 'remoteStopUnconfirmed');
  assert.equal(run.frames.filter((frame) => frame.type === 'closing').length, 1);
});

test('adapterMain: a 30-day deadline stays open across the timer limit and expires at its fixed time', { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { deadlineAt: now + month });
  await run.waitFor('ready');
  assert.equal((await run.advance(2147483647)).aborted, false);
  assert.equal((await run.advance(month - 2147483647 - 1)).aborted, false);
  assert.deepEqual(run.frames.map((frame) => frame.type), ['ready']);
  await run.advance(1);
  assert.equal((await run.finish()).code, 'adapterDeadlineExceeded');
  assert.doesNotMatch(run.diagnostics(), /TimeoutOverflowWarning/);
});

// Test Value Gate: disabling communication must retain environment checks
// while skipping communication queries and retain the exact initial prompt without bridge side effects.
test('adapterMain: disabled communication checks the executable and skips communication queries and bridge allocation', { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { communication: false, args: ['negotiationMustFail'] });
  assert.deepEqual((await run.waitFor('ready')).initialization.capabilities.communication, { status: 'disabled' });
  const observed = JSON.parse(await fs.readFile(path.join(run.directory, 'initialization.json'), 'utf8'));
  assert.equal(observed.prompt, 'Wait for the lifecycle stop.');
  assert.equal(observed.bridgeCreated, false);
  await fs.access(path.join(run.directory, 'environment-checked.json'));
  assert.equal(await fs.stat(path.join(run.directory, 'queried.json')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(run.directory, 'communication')).catch(() => null), null);
  run.send({ type: 'stop', reason: 'requested' }); await run.finish();
});

test('adapterMain: capability errors fail before ready or model submission', { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { args: ['negotiationMustFail'] });
  const result = await run.finish();
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(result.code, 'communicationQueryFailed');
  assert.deepEqual(result.initialization, { environment: { status: 'available' }, capabilities: {} });
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false);
  assert.equal(await fs.stat(path.join(run.directory, 'communication')).catch(() => null), null);
});

for (const communication of [true, false]) test(`adapterMain: unavailable environment fails before model input with communication ${communication}`, { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { communication, args: ['environmentMissing'] });
  const result = await run.finish();
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(result.code, 'executableNotFound');
  assert.deepEqual(result.initialization, { environment: { status: 'unavailable', code: 'executableNotFound' }, capabilities: {} });
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false);
  assert.equal(await fs.stat(path.join(run.directory, 'initialization.json')).catch(() => null), null);
});

test('adapterMain: failed communication preparation preserves the environment without enabling communication', { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { args: ['preparationMustFail'] });
  const result = await run.finish();
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(result.code, 'bridgeInvalid');
  assert.deepEqual(result.initialization, { environment: { status: 'available' }, capabilities: {} });
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false);
});

// Test Value Gate: rendered prompts must contain the actual registered entry
// names and omit an unavailable active receive entry. Prose quality needs Eval.
test('installed communication template selects actual tools across capability combinations', async () => {
  for (const passiveDelivery of ['in-turn', 'turn-boundary', 'none']) for (const activeReceive of [true, false]) {
    if (passiveDelivery === 'none' && !activeReceive) continue;
    const communication = { status: 'enabled', transport: 'mcp', passiveDelivery, activeReceive };
    const prompt = await renderCommunicationInstructions(communication, undefined, { sendTool: 'mcp__private__send_parent', receiveTool: 'mcp__private__receive_parent' }, pathToFileURL(path.join(scripts, '../assets/communication-instructions.md')));
    assert.ok(prompt.includes('`mcp__private__send_parent`'));
    assert.equal(prompt.includes('`mcp__private__receive_parent`'), activeReceive);
    assert.equal(prompt.includes('@@'), false);
    assert.equal(prompt.includes('<!-- aw:'), false);
  }
  await assert.rejects(renderCommunicationInstructions({ status: 'enabled', transport: 'command', passiveDelivery: 'turn-boundary', activeReceive: true }, { script: { command: process.execPath, args: ['private-script'] } }, {}, pathToFileURL(path.join(scripts, '../assets/communication-instructions.md'))), { code: 'communicationShellUnsupported' });
  await assert.rejects(renderCommunicationInstructions({ status: 'enabled', transport: 'mcp', passiveDelivery: 'none', activeReceive: true }, undefined, {}, new URL('file:///missing-aw-resource/communication-instructions.md')), { code: 'runtimeResourceMissing' });
});

// Test Value Gate: the mode is an internal command-only selector. Invalid
// bindings must fail before a prompt can direct a child to a different channel.
test('communication instruction bindings reject invalid text modes and MCP combinations', async () => {
  const communication = { status: 'enabled', transport: 'command', passiveDelivery: 'turn-boundary', activeReceive: true };
  const bridge = { script: { command: process.execPath, args: ['private-script'] } };
  const template = pathToFileURL(path.join(scripts, '../assets/communication-instructions.md'));
  for (const sendTextMode of [undefined, null, false, '', 'stdin', 'other', [], {}]) {
    await assert.rejects(renderCommunicationInstructions(communication, bridge, { shell: 'posix', sendTextMode }, template), { code: 'runtimeResourceInvalid' });
  }
  await assert.rejects(renderCommunicationInstructions({ ...communication, transport: 'mcp' }, bridge, { sendTextMode: 'argument' }, template), { code: 'runtimeResourceInvalid' });
  await assert.rejects(renderCommunicationInstructions(communication, bridge, { shell: 'posix', sendTextMode: 'argument', extra: true }, template), { code: 'runtimeResourceInvalid' });
});

// Test Value Gate: execute generated shell commands against the real message
// script and bridge. Quoted paths and message bytes must remain literal, and
// the default stdin form must retain the single-hyphen message use case.
for (const [sendTextMode, message] of [
  [undefined, "默认 'quotes' $HOME $(printf WRONG)\n第二行"],
  ['argument', "参数 'quotes' $HOME $(printf WRONG)\n第二行"],
  [undefined, '-'],
]) test('generated communication command preserves literal bytes with '+(sendTextMode ?? 'stdin')+' input'+(message === '-' ? ' and the hyphen sentinel' : ''), { skip: process.platform === 'win32', timeout: 10000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-command-binding-'));
  await protectPrivatePath(root, 'directory');
  const installed = path.join(root, "scripts 'quotes' $literal $(not-run)");
  await fs.cp(scripts, installed, { recursive: true });
  const messages = [];
  const bridge = await createChildBridge({
    directory: path.join(root, "channel 'quotes' $literal $(not-run)"), deadlineAt: null,
    toolkit: { command: process.execPath, module: path.join(installed, 'runtime/adapter-channel.mjs'), messageScript: path.join(installed, 'message.mjs'), mcpScript: path.join(installed, 'message-mcp.mjs') },
    emitParentMessage: async (text) => { messages.push(text); },
  });
  t.after(async () => { await bridge.close('completed'); await fs.rm(root, { recursive: true, force: true }); });
  const bindings = { shell: 'posix', ...(sendTextMode ? { sendTextMode } : {}) };
  const prompt = await renderCommunicationInstructions({ status: 'enabled', transport: 'command', passiveDelivery: 'none', activeReceive: true }, bridge, bindings, pathToFileURL(path.join(scripts, '../assets/communication-instructions.md')));
  let command = prompt.match(/\x60\x60\x60text\n([^\n]+)\n\x60\x60\x60/)[1];
  if (sendTextMode === 'argument') command = command.replace("'MESSAGE_TEXT'", "'"+message.replaceAll("'", "'\\''")+"'");
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sendTextMode === 'argument' ? '' : message);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.equal(await exit, 0, stderr);
  assert.equal(stdout, 'send_parent: submitted\n');
  assert.deepEqual(messages, [message]);
});

test('initialization diagnostics summarize field groups within the ready frame budget', () => {
  const diagnostics = Array.from({ length: 100 }, (_, index) => ({ code: 'profileFieldIgnored', field: `features.unknown_${index}`, message: 'Unsupported field; SYNTHETIC_SECRET is omitted.' }));
  const summary = summarizeDiagnostics(diagnostics, { API_TOKEN: 'SYNTHETIC_SECRET' });
  const frame = { protocolVersion: 5, type: 'ready', initialization: { environment: { status: 'available' }, capabilities: { communication: { status: 'unsupported' } } }, diagnostics: summary };
  validateFrame(frame, 'adapter');
  assert.equal(JSON.stringify(frame).includes('SYNTHETIC_SECRET'), false);
  assert.equal(summary[0].code, 'diagnosticsSummarized');
  assert.match(summary[0].message, /^100 /);
  assert.equal(summary.find((entry) => entry.field === 'features')?.code, 'profileFieldIgnored');
});

// Test Value Gate: redaction may expand a valid diagnostic past either byte
// limit. Keep its code with an omission notice, but reject invalid raw input.
test('initialization diagnostics handle redaction expansion without accepting invalid input', () => {
  const diagnostic = { code: 'profileFieldIgnored', field: `features.base${'f'.repeat(499)}`, message: `base${'m'.repeat(2044)}` };
  const summary = summarizeDiagnostics([diagnostic], { API_TOKEN: 'base' });
  validateFrame({ protocolVersion: 5, type: 'ready', initialization: { environment: { status: 'available' }, capabilities: { communication: { status: 'unsupported' } } }, diagnostics: summary }, 'adapter');
  assert.equal(summary[0].code, diagnostic.code);
  assert.equal(summary[0].field, undefined);
  assert.match(summary[0].message, /message omitted/);
  assert.match(summary[0].message, /field path omitted/);
  assert.equal(JSON.stringify(summary).includes('base'), false);
  assert.equal(Buffer.byteLength(diagnostic.message), 2048);
  assert.equal(Buffer.byteLength(diagnostic.field), 512);
  const fieldOnly = summarizeDiagnostics([{ ...diagnostic, message: 'Keep this safe diagnostic.' }], { API_TOKEN: 'base' });
  assert.ok(fieldOnly[0].message.includes('Keep this safe diagnostic.'));
  assert.equal(fieldOnly[0].field, undefined);
  const expanded = summarizeDiagnostics(Array.from({ length: 8 }, () => ({ code: diagnostic.code, message: 'base'.repeat(50) })), { API_TOKEN: 'base' });
  assert.equal(expanded[0].code, 'diagnosticsSummarized');
  assert.match(expanded[0].message, /^8\b/);
  validateFrame({ protocolVersion: 5, type: 'ready', initialization: { environment: { status: 'available' }, capabilities: { communication: { status: 'unsupported' } } }, diagnostics: expanded }, 'adapter');
  const reducible = 'long-protected-value'.repeat(110);
  for (const invalid of [{ ...diagnostic, code: 'invalid-code' }, { ...diagnostic, message: reducible }, { ...diagnostic, field: 'f'.repeat(513) }, { ...diagnostic, field: 'features.\ninvalid' }]) {
    assert.throws(() => summarizeDiagnostics([invalid], { API_TOKEN: reducible }), { code: 'protocolInvalid' });
  }
});

// Test Value Gate: custom adapters using the common helper retain the same
// prohibition on Codex-only controls as other non-Codex adapters.
test('common custom adapter rejects misplaced Codex configuration before negotiation', async (t) => {
  const f = await fixture(t, { codex: { cliSource: 'app', bypassHookTrust: true } });
  const result = await f.finish();
  assert.equal(result.code, 'protocolInvalid');
  assert.equal(result.state, 'failed');
  assert.equal(result.generationStarted, false);
  assert.equal(result.initialization, undefined);
  assert.equal(f.frames.some((frame) => frame.type === 'ready'), false);
});
