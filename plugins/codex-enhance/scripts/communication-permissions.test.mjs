import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { executeCodex } from '../skills/codex-subagent-guide/scripts/adapters/codex-v5.mjs';
import { claudeArguments, executeClaude, negotiateClaudeCommunication } from '../skills/codex-subagent-guide/scripts/adapters/claude-code-v5.mjs';
import { deferred } from '../skills/codex-subagent-guide/scripts/adapters/common.mjs';

const id = 'communication1';
const server = `aw_parent_${id}`;
const tools = [`mcp__${server}__send_parent`, `mcp__${server}__receive_parent`];
const request = (overrides = {}) => ({ args: [], execution: {}, communication: true, permissionMode: 'default', workspace: process.cwd(), run: { id }, codex: { cliSource: 'cli', bypassHookTrust: false }, ...overrides });

async function codexRun(overrides = {}, inherited = {}, rejection) {
  const stdout = new PassThrough(), done = deferred(), controller = new AbortController();
  const frames = [];
  let exited = false;
  const emit = (frame) => stdout.write(`${JSON.stringify(frame)}\n`);
  const backend = {
    child: { stdout }, done: done.promise,
    get exited() { return exited; }, get exitCode() { return exited ? 0 : null; },
    async write(frame) {
      frames.push(structuredClone(frame));
      const reply = (result) => emit({ id: frame.id, result });
      if (frame.method === 'initialize' || frame.method === 'thread/unsubscribe') reply({});
      else if (frame.method === 'config/read') reply({ config: inherited });
      else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
        if (rejection) emit({ id: frame.id, error: { code: -32602, message: 'Unsupported tool configuration.' } });
        else reply({ thread: { id: 'same-thread' } });
      } else if (frame.method === 'turn/start') {
        reply({ turn: { id: 'turn' } });
        emit({ method: 'turn/started', params: { threadId: 'same-thread', turn: { id: 'turn' } } });
        emit({ method: 'turn/completed', params: { threadId: 'same-thread', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Done.' }] } } });
      }
    },
    async end() { exited = true; stdout.end(); done.resolve(); },
  };
  const { environment = {}, ...options } = overrides;
  const selected = request(options);
  const context = {
    request: selected, environment, diagnostics: [], executable: { command: '/fake/codex' },
    signal: controller.signal, stopped: deferred(), prompt: 'Task.',
    abort(code) { this.errorCode = code; controller.abort(); done.resolve(); },
    async prepareCommunication() { if (selected.communication) return { mcpServer: { command: '/fixed/node', args: ['/fixed/message-mcp.mjs', '--bridge', 'current'] } }; },
    async spawn() { return backend; }, async bindSession() {}, async ready() {}, async beginClosing() {},
  };
  let result, error;
  try { result = await executeCodex(context); } catch (value) { error = value; }
  return { frames, result, error };
}

function binding(frames) {
  const frame = frames.find((value) => value.method === 'thread/start' || value.method === 'thread/resume');
  return frame.params.config.mcp_servers?.[server] ?? frame.params.config[`mcp_servers.${server}`];
}

async function claudeRun(selected) {
  const stdout = new PassThrough(), done = deferred(), controller = new AbortController();
  const inputs = [];
  let exited = false, argv;
  const emit = (frame) => stdout.write(`${JSON.stringify(frame)}\n`);
  const backend = {
    child: { stdout }, done: done.promise,
    get exited() { return exited; }, get exitCode() { return exited ? 0 : null; },
    async write(frame) {
      inputs.push(frame);
      emit({ type: 'system', subtype: 'init', session_id: selected.sessionId ?? 'same-session' });
      emit({ type: 'user', uuid: frame.uuid });
      emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: selected.sessionId ?? 'same-session', result: 'Done.' });
    },
    async end() { exited = true; stdout.end(); done.resolve(); },
  };
  const context = {
    request: selected, executable: { command: '/fixed/claude' }, signal: controller.signal, stopped: deferred(), prompt: 'Task.',
    abort(code) { this.errorCode = code; controller.abort(); done.resolve(); },
    async prepareCommunication() { return { mcpServer: { command: '/fixed/node', args: ['current-bridge'] } }; },
    async spawn(_command, args) { assert.equal(inputs.length, 0); argv = args; return backend; },
    async ready() {}, async beginClosing() {}, async bindSession() {},
  };
  await negotiateClaudeCommunication(context);
  const result = await executeClaude(context);
  return { argv, inputs, result };
}

// Test Value Gate: observe the real adapter's first-input RPC boundary. Private
// tool grants must preserve unrelated config and the receive output budget.
test('Codex grants only both current communication tools before start and resume input', async () => {
  for (const sessionId of [undefined, 'same-thread']) {
    const run = await codexRun({ sessionId, args: ['-c', 'mcp_servers.other={command="other",tools={keep={approval_mode="prompt"}}}', '-c', 'sandbox_mode="read-only"'] });
    assert.equal(run.result?.state, 'completed');
    assert.deepEqual(binding(run.frames).tools, { send_parent: { approval_mode: 'approve' }, receive_parent: { approval_mode: 'approve', output_token_limit: 32768 } });
    const thread = run.frames.find((value) => ['thread/start', 'thread/resume'].includes(value.method));
    assert.equal(thread.params.config.mcp_servers.other.tools.keep.approval_mode, 'prompt');
    assert.equal(thread.params.config.sandbox_mode, 'read-only');
    assert.equal(thread.params.config.approval_policy, undefined);
    assert.ok(run.frames.indexOf(thread) < run.frames.findIndex((value) => value.method === 'turn/start'));
  }
});

// Test Value Gate: resolved full access skips grants, while single-field never,
// auto, and explicit sandbox restrictions must retain the narrow grants.
test('Codex skips tool approval overrides only for resolved full access or disabled communication', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-communication-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'full.config.toml'), 'approval_policy="never"\nsandbox_mode="danger-full-access"\n');
  for (const [overrides, inherited, full] of [
    [{ permissionMode: 'full-access' }, {}, true],
    [{ args: ['--dangerously-bypass-approvals-and-sandbox'] }, {}, true],
    [{ codex: { cliSource: 'cli', bypassHookTrust: false, profile: 'full' }, environment: { CODEX_HOME: root } }, {}, true],
    [{}, { approval_policy: 'never', sandbox_mode: 'danger-full-access' }, true],
    [{ sessionId: 'same-thread' }, { approval_policy: 'never', sandbox_mode: 'danger-full-access' }, false],
    [{ sessionId: 'same-thread', args: ['--dangerously-bypass-approvals-and-sandbox'] }, {}, true],
    [{ args: ['-a', 'never'] }, { sandbox_mode: 'danger-full-access' }, true],
    [{ args: ['-a', 'never'] }, {}, false],
    [{ permissionMode: 'auto' }, { sandbox_mode: 'danger-full-access' }, false],
    [{ args: ['-s', 'read-only'] }, { approval_policy: 'never', sandbox_mode: 'danger-full-access' }, false],
  ]) {
    const run = await codexRun(overrides, inherited);
    assert.equal(run.result?.state, 'completed', run.error?.stack);
    const config = binding(run.frames).tools;
    assert.equal(config.receive_parent.output_token_limit, 32768);
    assert.equal(config.receive_parent.approval_mode, full ? undefined : 'approve');
    assert.equal(config.send_parent?.approval_mode, full ? undefined : 'approve');
  }
  const disabled = await codexRun({ communication: false, args: ['-c', `mcp_servers.${server}={command="user-tool"}`] });
  assert.equal(disabled.result?.state, 'completed');
  assert.equal(binding(disabled.frames).command, 'user-tool');
  assert.equal(disabled.frames.some((value) => value.method === 'config/read'), false);
});

test('Codex preserves rejected communication config without sending or retrying model input', async () => {
  const run = await codexRun({}, {}, true);
  assert.equal(run.error?.code, 'backendRequestRejected');
  assert.equal(run.frames.filter((value) => value.method === 'thread/start').length, 1);
  assert.equal(run.frames.some((value) => value.method === 'turn/start'), false);
});

// Test Value Gate: inspect native argv rather than source text. Existing rule
// groups and unrelated MCP/settings arguments must survive one merged allow.
test('Claude merges both allowedTools spellings into one list for start and resume', () => {
  const settings = '{"permissions":{"allow":["Read"]}}';
  const original = ['--allowedTools=Read,Bash(git status)', '--allowed-tools', 'Edit', 'Bash(echo one,two)', '--settings', settings, '--mcp-config', '{"mcpServers":{"other":{"command":"other"}}}'];
  for (const sessionId of [undefined, 'same-session']) {
    const args = claudeArguments(request({ args: original, sessionId }), { command: '/fixed/node', args: ['current-bridge'] });
    const allows = args.filter((value) => value === '--allowedTools' || value.startsWith('--allowedTools=') || value === '--allowed-tools');
    assert.equal(allows.length, 1);
    const start = args.indexOf('--allowedTools');
    assert.deepEqual(args.slice(start + 1, start + 7), ['Read,Bash(git status)', 'Edit', 'Bash(echo one,two)', ...tools]);
    assert.equal(args[args.indexOf('--settings') + 1], settings);
    assert.ok(args.includes(original.at(-1)));
    assert.deepEqual(original, ['--allowedTools=Read,Bash(git status)', '--allowed-tools', 'Edit', 'Bash(echo one,two)', '--settings', settings, '--mcp-config', '{"mcpServers":{"other":{"command":"other"}}}']);
  }
});

test('Claude skips communication preflight and grants for full access and disabled communication', async () => {
  for (const overrides of [
    { permissionMode: 'full-access' },
    { args: ['--dangerously-skip-permissions'] },
    { args: ['--permission-mode=bypassPermissions'] },
  ]) {
    const value = request({ ...overrides, args: [...(overrides.args ?? []), '--settings', '/missing/settings', '--disallowedTools', tools[0]] });
    assert.equal((await negotiateClaudeCommunication({ request: value })).supported, true);
    assert.equal(claudeArguments(value, { command: '/fixed/node' }).includes('--allowedTools'), false);
  }
  const disabled = request({ communication: false, args: ['--settings', '/missing/settings'] });
  assert.equal((await negotiateClaudeCommunication({ request: disabled })).supported, false);
  assert.equal(claudeArguments(disabled, { command: '/fixed/node' }).includes('--allowedTools'), false);
  for (const args of [[], ['--allow-dangerously-skip-permissions'], ['--permission-mode', 'auto']]) {
    const ordinary = claudeArguments(request({ args }), { command: '/fixed/node' });
    assert.ok(ordinary.includes(tools[0]));
    assert.ok(ordinary.includes(tools[1]));
  }
});

test('Claude rejects explicit ask and deny conflicts and resolves explicit settings before spawning', async () => {
  for (const kind of ['deny', 'ask']) {
    const value = request({ args: ['--settings', JSON.stringify({ permissions: { [kind]: [`mcp__${server}__*`] } })] });
    await assert.rejects(negotiateClaudeCommunication({ request: value }), { code: kind === 'deny' ? 'communicationToolDenied' : 'communicationToolApprovalRequired' });
  }
  for (const sessionId of [undefined, 'same-session']) {
    const full = await claudeRun(request({ sessionId, args: ['--settings', JSON.stringify({ permissions: { defaultMode: 'bypassPermissions', ask: [tools[1]] } })] }));
    assert.equal(full.result.state, 'completed');
    assert.equal(full.argv.includes('--allowedTools'), false);
    assert.ok(full.argv.includes('--mcp-config'));
    const ordinary = await claudeRun(request({ sessionId, args: ['--settings', JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }), '--permission-mode', 'default'] }));
    assert.equal(ordinary.result.state, 'completed');
    assert.ok(ordinary.argv.includes(tools[0]));
    assert.ok(ordinary.argv.includes(tools[1]));
  }
});
