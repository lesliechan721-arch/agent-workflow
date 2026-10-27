import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { createChildBridge, invokeChildTool } from '../skills/codex-subagent-guide/scripts/runtime/adapter-channel.mjs';
import { executeClaude, negotiateClaudeCommunication, claudeArguments } from '../skills/codex-subagent-guide/scripts/adapters/claude-code-v5.mjs';
import { deferred } from '../skills/codex-subagent-guide/scripts/adapters/common.mjs';
import { fixture, windows, supported, testTimeoutMs, answer, scripts, sourceEntries } from './fixtures/adapter-v5.mjs';

for (const backend of ['codex', 'claude', 'oracle']) test(`${backend}: installed v5 preserves input, configuration and real exit`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend);
  f.request.execution = { ...f.request.execution, model: 'chosen-model', reasoningEffort: 'high' };
  f.request.args = backend === 'codex' ? ['-c', 'shell_environment_policy.inherit="all"', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] : backend === 'claude' ? ['--permission-mode', 'default', '--settings', '{"env":{"SETTING":"value"}}'] : ['--engine', 'api'];
  if (backend === 'oracle' && !windows) f.request.fileSelectors = ['main.ts', 'main.ts'];
  const run = f.start(); run.send(f.request);
  assert.equal((await run.waitFor('ready')).communication.status, backend === 'oracle' ? 'unsupported' : 'enabled');
  const result = await run.waitFor('result');
  const closed = await run.exit;
  assert.equal(closed.code, 0, closed.diagnostic);
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.backendExitCode, 0);
  assert.equal(result.generationStarted, true);
  assert.equal(result.text, answer);
  assert.equal(run.frames.filter((frame) => frame.type === 'result').length, 1);
  assert.equal(run.frames.at(-1).type, 'result');
  assert.ok(run.frames.findIndex((frame) => frame.type === 'closing') > 0);
  const captured = await f.captured();
  assert.equal(captured[0].cwd, f.workspace);
  assert.equal(captured[0].environment.HOME, f.home);
  assert.equal(captured[0].environment.NORMAL_SETTING, 'preserved setting');
  assert.equal(captured[0].environment.OPENAI_API_KEY, 'synthetic-test-key');
  if (backend === 'codex') {
    const start = captured.find((value) => value.input?.method === 'thread/start').input.params;
    assert.equal(start.config.model, 'chosen-model'); assert.equal(start.config.sandbox_mode, 'workspace-write'); assert.equal(start.config.approval_policy, 'on-request');
    const turn = captured.find((value) => value.input?.method === 'turn/start').input.params;
    assert.equal(turn.effort, 'high'); assert.ok(turn.input[0].text.startsWith(f.request.prompt));
    assert.equal(start.config.shell_environment_policy.inherit, 'all');
  } else if (backend === 'claude') {
    const prompt = captured.find((value) => value.input?.type === 'user').input.message.content[0].text;
    assert.ok(prompt.startsWith(f.request.prompt)); assert.ok(captured[0].args.includes('--permission-mode')); assert.ok(captured[0].args.includes('--mcp-config'));
  } else {
    assert.equal(captured[1].input, f.request.prompt);
    assert.equal(captured[0].args.filter((argument) => argument === '--file').length, f.request.fileSelectors.length);
    assert.equal(captured[0].args.filter((argument) => argument === 'main.ts').length, f.request.fileSelectors.length);
  }
  assert.equal(closed.diagnostic, '');
});

for (const backend of ['codex', 'claude']) test(`${backend}: parent input uses the same live backend without active receive`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend, 'parent input');
  const run = f.start(); run.send(f.request); await run.waitFor('ready');
  const text = '父消息\n保持原文 ` $()';
  run.send({ type: 'message', id: 'a'.repeat(32), text });
  const delivery = await run.waitFor('delivery');
  assert.equal(delivery.id, 'a'.repeat(32)); assert.equal(delivery.status, 'submitted');
  const result = await run.waitFor('result');
  assert.equal(result.state, 'completed', JSON.stringify(result)); assert.equal((await run.exit).code, 0);
  const values = await f.captured();
  const inputs = values.filter((value) => backend === 'codex' ? value.input?.method === 'turn/steer' : value.input?.type === 'user');
  const input = inputs.at(-1).input;
  const actual = backend === 'codex' ? input.params.input[0].text : input.message.content[0].text;
  assert.ok(actual.endsWith(text));
  if (backend === 'codex') assert.equal(inputs.length, 1);
  else assert.equal(inputs.length, 2);
});

// Replace only the external Claude stream. The real executor and bridge must
// keep an early reply available to an explicit receive during the active turn.
for (const order of ['parent first', 'receive first']) test(`Claude: ${order} reaches active-turn receive once`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-claude-receive-'));
  await protectPrivatePath(root, 'directory');
  const controller = new AbortController();
  const done = deferred(); const stopped = deferred(); const initial = deferred();
  const stdout = new PassThrough(); const inputs = [];
  const backend = {
    child: { stdout }, done: done.promise, exited: false, exitCode: 0,
    async write(value) {
      if (value.type !== 'user') return;
      inputs.push(value); initial.resolve();
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({ type: 'user', uuid: value.uuid })}\n`);
        stdout.write(`${JSON.stringify({ type: 'assistant' })}\n`);
      });
    },
    async end() { this.exited = true; stdout.end(); done.resolve(); },
  };
  const context = {
    prompt: 'Ask the parent for a value.',
    request: { args: [], execution: {}, prompt: 'Ask the parent for a value.', run: { id: 'e'.repeat(32) } },
    signal: controller.signal, stopped,
    abort(code) { this.errorCode = code; controller.abort(); stopped.resolve(); },
    async ready() {},
    async beginClosing(reason) { await this.bridge.close(reason); },
    async prepareCommunication({ submitInput, canSubmitInput }) {
      this.bridge = await createChildBridge({
        directory: path.join(root, 'communication'), deadlineAt: null,
        toolkit: { module: path.join(scripts, 'runtime/adapter-channel.mjs'), command: process.execPath, messageScript: sourceEntries.message, mcpScript: sourceEntries.mcp },
        emitParentMessage: async () => {}, submitInput, canSubmitInput,
      });
      return this.bridge;
    },
    async spawn() { return backend; },
  };
  const running = executeClaude(context);
  t.after(async () => {
    controller.abort(); stopped.resolve(); await backend.end();
    await context.bridge?.close('cancelled'); await running;
    await fs.rm(root, { recursive: true, force: true });
  });
  await initial.promise;
  const text = 'The parent answer. 父回复。';
  const receive = () => invokeChildTool({ bindingFile: context.bridge.script.args[2], operation: 'receive', timeoutMs: 100 });
  let delivery, received;
  if (order === 'parent first') {
    delivery = context.bridge.acceptInput({ id: 'f'.repeat(32), text });
    received = receive();
  } else {
    received = receive();
    await new Promise((resolve) => setImmediate(resolve));
    delivery = context.bridge.acceptInput({ id: 'f'.repeat(32), text });
  }
  assert.deepEqual(await received, { outcome: 'received', text });
  assert.deepEqual(await delivery, { status: 'submitted' });
  assert.equal(inputs.length, 1);
  stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'session-fixture', result: answer })}\n`);
  assert.equal((await running).state, 'completed');
  assert.equal(inputs.length, 1);
});

test('Codex: more than 64 parent messages retain each delivery without replay', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'many inputs'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  for (let index = 0; index < 80; index++) run.send({ type: 'message', id: index.toString(16).padStart(32, '0'), text: 'Repeated input 重复正文.' });
  await run.waitFor('delivery', 80);
  assert.equal((await run.waitFor('result')).state, 'completed'); await run.exit;
  assert.equal(run.frames.filter((frame) => frame.type === 'delivery' && frame.status === 'submitted').length, 80);
  const values = await f.captured(); assert.equal(values.filter((value) => value.input?.method === 'turn/steer').length, 80);
});

// Test Value Gate: a disabled run must reach the real adapter process and backend
// with the exact caller prompt and no AW bridge directory or tool configuration.
for (const backend of ['codex', 'claude', 'oracle']) test(`${backend}: communication disabled preserves the ordinary task`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend);
  f.request.communication = false;
  const run = f.start(); run.send(f.request);
  assert.deepEqual((await run.waitFor('ready')).communication, { status: 'disabled' });
  const result = await run.waitFor('result');
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal((await run.exit).code, 0);
  const captured = await f.captured();
  assert.equal(captured[0].communicationDirectory, false);
  assert.equal(captured[0].args.some((value) => value === '--mcp-config' || value.includes('aw_parent_')), false);
  const first = captured.find((value) => backend === 'codex' ? value.input?.method === 'turn/start' : backend === 'claude' ? value.input?.type === 'user' : typeof value.input === 'string');
  const prompt = backend === 'codex' ? first.input.params.input[0].text : backend === 'claude' ? first.input.message.content[0].text : first.input;
  assert.equal(prompt, f.request.prompt);
});

// Test Value Gate: the public negotiation method must apply documented whole
// tool-name deny matching and parse only the actual restriction option values.
test('Claude: explicit deny rules match required MCP names without guessing other permissions', async () => {
  const id = 'f'.repeat(32); const server = `mcp__aw_parent_${id}`;
  const send = `${server}__send_parent`; const receive = `${server}__receive_parent`;
  const request = (args) => ({ args, execution: {}, run: { id }, workspace: process.cwd() });
  for (const args of [
    ['--disallowedTools', send], ['--disallowed-tools', receive],
    [`--disallowedTools=${server}`], ['--disallowed-tools', `${server}__*`],
    ['--disallowedTools', 'mcp__*'], ['--disallowedTools', '*'],
    ['--disallowedTools', 'mcp__aw_parent_*__send_parent'],
    ['--disallowedTools', `Read,${send},Bash(git status)`],
    ['--disallowed-tools', `Read ${receive} Bash(git status)`],
    ['--disallowedTools', 'Read', receive, 'Bash(git status)'],
    ['--disallowedTools=Read', '--disallowed-tools', receive],
  ]) {
    const value = request(args); claudeArguments(value);
    await assert.rejects(negotiateClaudeCommunication({ request: value }), { code: 'communicationToolDenied' });
  }
  for (const args of [
    ['--disallowedTools', 'mcp__other_server__*'], ['--disallowedTools', `${send}_extra`],
    ['--disallowedTools', `Bash(echo ${send})`], ['--disallowedTools', `${send}(text:one blocked value)`],
    ['--allowedTools', 'Read'], ['--tools', ''], ['--append-system-prompt', `--disallowedTools ${send}`],
  ]) {
    const value = request(args); claudeArguments(value);
    assert.equal((await negotiateClaudeCommunication({ request: value })).supported, true);
  }
});

// Test Value Gate: real adapterMain must reject a known deny before backend or
// model input, while communication=false passes the original policy unchanged.
for (const source of ['argv', 'inline settings', 'settings file']) test(`Claude: ${source} denial fails before submission and remains valid with communication disabled`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'claude');
  const rule = `mcp__aw_parent_${f.request.run.id}__*`;
  const settings = JSON.stringify({ permissions: { deny: [rule] }, env: { PRIVATE_VALUE: 'SYNTHETIC_VALUE_NEVER_REPORT' } });
  if (source === 'argv') f.request.args = ['--disallowedTools', `Read,${rule}`];
  else if (source === 'inline settings') f.request.args = [`--settings=${settings}`];
  else {
    await fs.writeFile(path.join(f.workspace, 'explicit settings.json'), settings);
    f.request.args = ['--settings', 'explicit settings.json'];
  }
  const original = [...f.request.args];
  const denied = f.start(); denied.send(f.request);
  const result = await denied.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(result.code, 'communicationToolDenied');
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_VALUE_NEVER_REPORT'), false);
  assert.equal(denied.frames.some((frame) => frame.type === 'ready'), false);
  assert.equal((await denied.exit).code, 0);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.request.runtime.directory, 'communication')), { code: 'ENOENT' });
  f.request.communication = false;
  const ordinary = f.start(); ordinary.send(f.request);
  assert.deepEqual((await ordinary.waitFor('ready')).communication, { status: 'disabled' });
  assert.equal((await ordinary.waitFor('result')).state, 'completed');
  assert.equal((await ordinary.exit).code, 0);
  const captured = await f.captured();
  assert.deepEqual(captured[0].args.slice(-original.length), original);
});
