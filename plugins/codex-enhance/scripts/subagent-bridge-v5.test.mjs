import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createChildBridge, invokeChildTool } from '../skills/codex-subagent-guide/scripts/runtime/adapter-channel.mjs';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';

const require = createRequire(import.meta.url);
const messageScript = require.resolve('../skills/codex-subagent-guide/scripts/message.mjs');
const mcpScript = require.resolve('../skills/codex-subagent-guide/scripts/message-mcp.mjs');
const scripts = path.dirname(messageScript);
const windows = process.platform === 'win32';
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const id = (value) => value.toString(16).padStart(32, '0');
async function until(predicate, milliseconds = 3000) {
  const expires = Date.now() + milliseconds;
  while (!await predicate()) { if (Date.now() >= expires) throw new Error('The fixture condition was not reached.'); await pause(10); }
}

function caseDiagnostics(t) {
  const began = performance.now(); const events = [];
  return {
    note(phase, values = {}) {
      const event = { phase, elapsedMs: Math.round(performance.now() - began), ...values };
      events.push(event);
      if (process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') t.diagnostic(`AW_SUBAGENT_COMMUNICATION_TEST ${JSON.stringify(event)}`);
    },
    snapshot(values = {}) { return JSON.stringify({ events, ...values }); },
  };
}

// Test Value Gate: run installed helper entrypoints in private temporary resources.
// Observe messages and deliveries to protect one scheduler across MCP, scripts,
// automatic submission, cancellation, and resource cleanup without real models.
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-child-bridge-'));
  await protectPrivatePath(root, 'directory');
  let bridge;
  t.after(async () => { try { await bridge?.close('completed'); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  const installed = path.join(root, 'moved install', 'scripts');
  await fs.mkdir(path.join(installed, 'runtime'), { recursive: true });
  await fs.mkdir(path.join(installed, 'file-selection'));
  for (const name of ['runtime/adapter-channel.mjs', 'runtime/contracts.mjs', 'runtime/files.mjs', 'runtime/platform.mjs', 'file-selection/contracts.mjs']) await fs.copyFile(path.join(scripts, name), path.join(installed, name));
  for (const entry of [messageScript, mcpScript]) await fs.copyFile(entry, path.join(installed, path.basename(entry)));
  const toolkit = { module: path.join(installed, 'runtime/adapter-channel.mjs'), command: process.execPath, messageScript: path.join(installed, 'message.mjs'), mcpScript: path.join(installed, 'message-mcp.mjs') };
  const messages = [];
  bridge = await createChildBridge({ directory: path.join(root, 'bridge'), deadlineAt: null, toolkit, emitParentMessage: async (text) => { messages.push(text); }, ...options });
  const bindingFile = bridge.script.args[2];
  const invoke = (operation, values = {}) => invokeChildTool({ bindingFile, operation, ...values });
  const env = { ...process.env, HOME: root, AW_HOME: root, AW_CODEX_HOME: root, AW_CLAUDE_HOME: root };
  const execute = (args, input) => new Promise((resolve, reject) => {
    const child = spawn(bridge.script.command, [...bridge.script.args, ...args], { shell: false, cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('The child script did not exit.')); }, 5000);
    const stdout = []; const stderr = [];
    child.stdout.on('data', (bytes) => stdout.push(bytes)); child.stderr.on('data', (bytes) => stderr.push(bytes));
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }); });
    child.stdin.end(input);
  });
  return { root, bridge, bindingFile, messages, invoke, execute, env };
}

test('generated script preserves text, rejects invalid input, and leaves no tool history', async (t) => {
  const f = await fixture(t);
  const text = ' 父输入\r\n😀 " ` $()\nEND_MESSAGE:00000000\n';
  const sent = await f.execute(['send', '--text', '-'], text);
  assert.equal(sent.code, 0); assert.equal(sent.stdout, 'send_parent: submitted\n'); assert.deepEqual(f.messages, [text]);
  const receipt = f.bridge.acceptInput({ id: id(1), text });
  const received = await f.execute(['receive', '--timeout-ms', '1000']);
  assert.equal(received.code, 0);
  const boundary = /^receive_parent: received\nBEGIN_MESSAGE:([0-9a-f]{8})\n/.exec(received.stdout)?.[1];
  assert.ok(boundary); assert.equal(received.stdout, `receive_parent: received\nBEGIN_MESSAGE:${boundary}\n${text}\nEND_MESSAGE:${boundary}\n`);
  assert.deepEqual(await receipt, { status: 'submitted' });
  for (const args of [['send', '--text', ' '], ['send', '--text', '😀'.repeat(1025)], ['receive', '--timeout-ms', '-1'], ['receive', '--timeout-ms', '1800001'], ['send', '--text', 'x', '--from', 'other']]) {
    const failure = await f.execute(args); assert.equal(failure.code, 2); assert.equal(failure.stdout, ''); assert.match(failure.stderr, /code: /);
  }
  assert.deepEqual(f.messages, [text]);
  assert.deepEqual((await fs.readdir(path.dirname(f.bindingFile))).sort(), ['binding.json']);
});

test('missing installed toolkit fails bridge setup before communication can be declared ready', async (t) => {
  await assert.rejects(fixture(t, { toolkit: {
    module: path.join(scripts, 'runtime/adapter-channel.mjs'), command: process.execPath,
    messageScript: path.join(scripts, 'does-not-exist.mjs'), mcpScript,
  } }), { code: 'pathMissing' });
});

test('single-message byte boundary and queues remain usable beyond 64 inputs and sends', async (t) => {
  const f = await fixture(t);
  const text = '😀'.repeat(1024);
  assert.equal((await f.invoke('send', { text })).outcome, 'submitted');
  const deliveries = [];
  for (let index = 0; index < 80; index++) deliveries.push(f.bridge.acceptInput({ id: id(index), text: index === 0 ? text : 'same text' }));
  assert.equal(f.bridge.hasPendingInput(), true);
  for (let index = 0; index < 80; index++) {
    assert.equal((await f.invoke('send', { text: 'same text' })).outcome, 'submitted');
    const received = await f.invoke('receive', { timeoutMs: 0 });
    assert.equal(received.outcome, 'received'); assert.equal(received.text, index === 0 ? text : 'same text');
  }
  assert.equal((await Promise.all(deliveries)).every((delivery) => delivery.status === 'submitted'), true);
  assert.equal(f.bridge.hasPendingInput(), false); assert.equal(f.messages.length, 81);
  await assert.rejects(f.invoke('send', { text: `${text}x` }), { code: 'messageTooLarge' });
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
});

test('explicit receive and automatic input share allocation without replay', async (t) => {
  const diagnostic = caseDiagnostics(t);
  const automatic = []; let finishSubmission;
  const f = await fixture(t, { submitInput: (message) => new Promise((resolve) => { automatic.push(message); finishSubmission = resolve; diagnostic.note('automaticSubmissionStarted'); }) });
  diagnostic.note('fixtureReady');
  const first = f.bridge.acceptInput({ id: id(1), text: 'automatic only' });
  await until(() => automatic.length === 1);
  assert.equal(f.bridge.hasPendingInput(), true);
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
  // Native Windows tool round trips measured 3.8 seconds. Keep both calls
  // overlapping, and use the public duplicate response to identify the waiter.
  const timeoutMs = windows ? 10000 : 1000;
  const responses = new Map();
  const receivers = [0, 1].map((index) => {
    diagnostic.note('receiveInvoked', { index, timeoutMs });
    return f.invoke('receive', { timeoutMs }).then((response) => {
      responses.set(index, response); diagnostic.note('receiveResolved', { index, response });
      return { index, response };
    });
  });
  const duplicate = await Promise.race(receivers);
  assert.equal(duplicate.response.code, 'receiveAlreadyPending', diagnostic.snapshot({ responses: [...responses] }));
  const receivingIndex = 1 - duplicate.index;
  assert.equal(responses.has(receivingIndex), false, diagnostic.snapshot({ responses: [...responses] }));
  const second = f.bridge.acceptInput({ id: id(2), text: 'explicit only' });
  const received = (await receivers[receivingIndex]).response;
  assert.equal(received.outcome, 'received'); assert.equal(received.text, 'explicit only'); assert.deepEqual(await second, { status: 'submitted' });
  finishSubmission({ status: 'unknown', code: 'backendUncertain' });
  assert.deepEqual(await first, { status: 'unknown', code: 'backendUncertain' });
  assert.equal(automatic.length, 1); assert.equal(f.bridge.hasPendingInput(), false);
});

test('parent input before receive stays available until the backend can submit immediately', async (t) => {
  let backendReady = false; const automatic = [];
  const f = await fixture(t, {
    canSubmitInput: () => backendReady,
    submitInput: async (message) => { automatic.push(message); return { status: 'submitted' }; },
  });
  const explicit = f.bridge.acceptInput({ id: id(1), text: 'early parent reply' });
  await pause(25);
  const received = await f.invoke('receive', { timeoutMs: 200 });
  assert.equal(received.outcome, 'received'); assert.equal(received.text, 'early parent reply');
  assert.deepEqual(await explicit, { status: 'submitted' }); assert.deepEqual(automatic, []);
  const nextTurn = f.bridge.acceptInput({ id: id(2), text: 'next turn input' });
  await pause(25); assert.equal(f.bridge.hasPendingInput(), true);
  backendReady = true;
  await until(() => automatic.length === 1);
  assert.deepEqual(await nextTurn, { status: 'submitted' });
  assert.deepEqual(automatic, [{ id: id(2), text: 'next turn input' }]);
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
  backendReady = false;
  const notAttempted = f.bridge.acceptInput({ id: id(3), text: 'still queued' });
  await pause(25); await f.bridge.close('cancelled');
  assert.equal((await notAttempted).status, 'notSubmitted'); assert.equal(automatic.length, 1);
});

test('close wakes default receive, cancels submission, resolves queued inputs, and removes resources', async (t) => {
  let observedSignal;
  const automatic = await fixture(t, { submitInput: (_message, { signal }) => { observedSignal = signal; return new Promise(() => {}); } });
  const pending = automatic.bridge.acceptInput({ id: id(1), text: 'attempted' });
  const queued = automatic.bridge.acceptInput({ id: id(2), text: 'queued' });
  await until(() => observedSignal !== undefined);
  const started = Date.now(); await automatic.bridge.close('cancelled');
  assert.ok(Date.now() - started < 2000); assert.equal(observedSignal.aborted, true);
  assert.equal((await pending).status, 'unknown'); assert.equal((await queued).status, 'notSubmitted');
  assert.equal((await automatic.bridge.acceptInput({ id: id(3), text: 'late' })).code, 'runClosed');
  assert.equal(automatic.bridge.hasPendingInput(), false);
  await assert.rejects(fs.stat(path.dirname(automatic.bindingFile)), { code: 'ENOENT' });
  await automatic.bridge.close('cancelled');
  const explicit = await fixture(t);
  const receiving = explicit.invoke('receive');
  await until(async () => (await fs.readdir(path.dirname(explicit.bindingFile))).some((name) => name.endsWith('.request.json')));
  await explicit.bridge.close('completed');
  assert.equal((await receiving).outcome, 'closed');
});

test('fixed explicit deadline wakes receive, while null leaves the bridge open', async (t) => {
  const f = await fixture(t, { deadlineAt: Date.now() + 250 });
  assert.equal((await f.invoke('receive')).outcome, 'closed');
  const open = await fixture(t);
  await pause(40);
  assert.equal((await open.invoke('send', { text: 'still open' })).outcome, 'submitted');
});

test('an abandoned receive releases the shared receiver instead of blocking later tools', async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  const abandoned = f.invoke('receive', { signal: controller.signal });
  await until(async () => (await fs.readdir(path.dirname(f.bindingFile))).some((name) => name.endsWith('.request.json')));
  await pause(25); controller.abort();
  assert.equal((await abandoned).outcome, 'closed');
  await until(async () => (await fs.readdir(path.dirname(f.bindingFile))).length === 1);
  await pause(25);
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
  const delivered = f.bridge.acceptInput({ id: id(1), text: 'next receiver' });
  assert.equal((await f.invoke('receive', { timeoutMs: 1800000 })).text, 'next receiver');
  assert.deepEqual(await delivered, { status: 'submitted' });
});

test('generated MCP process supports concurrent receive/send and rejects extra tool identity', async (t) => {
  const diagnostic = caseDiagnostics(t);
  const f = await fixture(t);
  diagnostic.note('fixtureReady');
  const child = spawn(f.bridge.mcpServer.command, f.bridge.mcpServer.args, { shell: false, cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map(); let buffer = ''; let diagnostics = '';
  const responseWindow = windows ? 10000 : 3000;
  const timer = setTimeout(() => { diagnostic.note('mcpWatchdogExpired'); child.kill(); }, windows ? 30000 : 8000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  child.once('exit', (code, signal) => diagnostic.note('mcpExited', { code, signal }));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (data) => { diagnostics += data; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); responses.set(response.id, response); diagnostic.note('mcpResponse', { response }); }
  });
  const request = (id, method, params) => { diagnostic.note('mcpRequest', { id, method, tool: params?.name }); return child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); };
  request(1, 'initialize', { protocolVersion: '2025-03-26' }); request(2, 'tools/list', {});
  await until(() => responses.has(1) && responses.has(2), responseWindow);
  assert.equal(responses.get(1).result.protocolVersion, '2025-03-26');
  assert.deepEqual(responses.get(2).result.tools.map((tool) => tool.name), ['send_parent', 'receive_parent']);
  request(3, 'tools/call', { name: 'receive_parent', arguments: {} });
  request(4, 'tools/call', { name: 'send_parent', arguments: { text: '子问题😀' } });
  try { await until(() => responses.has(4), responseWindow); }
  catch (error) {
    diagnostic.note('sendResponseWaitFailed', { childExitCode: child.exitCode, childSignal: child.signalCode, diagnostics });
    throw new Error(`${error.message}\n${diagnostic.snapshot({ responses: [...responses.values()], messages: f.messages, diagnostics })}`, { cause: error });
  }
  assert.equal(responses.has(3), false); assert.deepEqual(f.messages, ['子问题😀']);
  request(5, 'tools/call', { name: 'send_parent', arguments: { text: 'wrong', from: 'other' } });
  await until(() => responses.has(5), responseWindow); assert.equal(responses.get(5).result.isError, true); assert.equal(f.messages.length, 1);
  const delivered = f.bridge.acceptInput({ id: id(1), text: '父答复\r\n😀' });
  await until(() => responses.has(3), responseWindow); assert.match(responses.get(3).result.content[0].text, /^receive_parent: received\n/); assert.match(responses.get(3).result.content[0].text, /父答复\r\n😀/);
  assert.deepEqual(await delivered, { status: 'submitted' });
  request(6, 'tools/call', { name: 'receive_parent', arguments: {} });
  const exited = once(child, 'exit'); child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(diagnostics, '');
});
