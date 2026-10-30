import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { fixture, supported, testTimeoutMs } from './fixtures/adapter-v5.mjs';

// Test Value Gate: run the installed adapter across two real local processes.
// Replace only the model backend, and inspect the actual session target, new
// input, private tool binding and capability events at its public JSONL edge.
for (const backend of ['codex', 'claude']) test(`${backend}: resume preserves the session and uses only the new message and bridge`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend);
  const first = f.start(); first.send(f.request);
  const session = await first.waitFor('session');
  assert.equal((await first.waitFor('ready')).initialization.capabilities.resume.status, 'enabled');
  assert.equal((await first.waitFor('result')).state, 'completed');
  assert.equal((await first.exit).code, 0);
  const before = await f.captured();
  const directory = path.join(path.dirname(f.request.runtime.directory), 'resumed-adapter');
  await fs.mkdir(directory, { mode: 0o700 });
  await protectPrivatePath(directory, 'directory');
  const request = { ...f.request, sessionId: session.sessionId, prompt: 'Only the follow-up message.', runtime: { ...f.request.runtime, directory } };
  const second = f.start(); second.send(request);
  assert.equal((await second.waitFor('session')).sessionId, session.sessionId);
  const result = await second.waitFor('result');
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.sessionId, session.sessionId);
  assert.equal((await second.exit).code, 0);
  const values = (await f.captured()).slice(before.length);
  if (backend === 'codex') {
    assert.equal(values.some((value) => value.input?.method === 'thread/start'), false);
    const resumed = values.find((value) => value.input?.method === 'thread/resume').input.params;
    assert.equal(resumed.threadId, session.sessionId);
    const oldConfig = before.find((value) => value.input?.method === 'thread/start').input.params.config;
    const key = `aw_parent_${request.run.id}`;
    assert.notDeepEqual(resumed.config.mcp_servers[key].args, oldConfig.mcp_servers[key].args);
    assert.equal(resumed.config.mcp_servers[key].tools.receive_parent.output_token_limit, 32768);
    assert.ok(resumed.config.mcp_servers[key].args.some((argument) => argument.startsWith(directory)));
    const inputs = values.filter((value) => value.input?.method === 'turn/start');
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0].input.params.input[0].text.startsWith(request.prompt));
    assert.equal(inputs[0].input.params.input[0].text.includes(f.request.prompt), false);
  } else {
    const args = values[0].args;
    assert.equal(args[args.indexOf('--resume') + 1], session.sessionId);
    assert.equal(args.includes('--fork-session'), false);
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    assert.ok(mcp.mcpServers[`aw_parent_${request.run.id}`].args.some((argument) => argument.startsWith(directory)));
    const inputs = values.filter((value) => value.input?.type === 'user');
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0].input.message.content[0].text.startsWith(request.prompt));
    assert.equal(inputs[0].input.message.content[0].text.includes(f.request.prompt), false);
  }
});

for (const scenario of ['resume rejection', 'resume mismatch', 'resume active']) test(`Codex: ${scenario} never falls back to a new thread or submits input`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', scenario);
  const run = f.start(); run.send({ ...f.request, sessionId: 'thread-fixture' });
  const result = await run.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(result.code, scenario === 'resume rejection' ? 'backendRequestRejected' : scenario === 'resume mismatch' ? 'backendSessionMismatch' : 'backendInputUnavailable');
  assert.equal((await run.exit).code, 0);
  const values = await f.captured();
  assert.equal(values.filter((value) => value.input?.method === 'thread/resume').length, 1);
  assert.equal(values.some((value) => ['thread/start', 'thread/fork', 'turn/start'].includes(value.input?.method)), false);
});

for (const [backend, args] of [['codex', ['--ephemeral']], ['claude', ['--no-session-persistence']], ['oracle', []]]) test(`${backend}: nonpersistent or one-shot execution reports unsupported without a session event`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend);
  const run = f.start(); run.send({ ...f.request, args });
  assert.deepEqual((await run.waitFor('ready')).initialization.capabilities.resume, { status: 'unsupported' });
  assert.equal((await run.waitFor('result')).state, 'completed'); await run.exit;
  assert.equal(run.frames.some((frame) => frame.type === 'session'), false);
});

for (const backend of ['codex', 'claude']) test(`${backend}: disabled resume keeps communication available and publishes no binding`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend);
  const run = f.start(); run.send({ ...f.request, resume: false });
  const ready = await run.waitFor('ready');
  assert.equal(ready.initialization.capabilities.communication.status, 'enabled');
  assert.equal(ready.initialization.capabilities.resume.status, 'disabled');
  assert.equal((await run.waitFor('result')).state, 'completed'); await run.exit;
  assert.equal(run.frames.some((frame) => frame.type === 'session'), false);
});

test('Claude: disabled persistence through the backend environment prevents resume before input', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'claude');
  f.environment.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1';
  const run = f.start(); run.send({ ...f.request, sessionId: 'session-fixture' });
  const result = await run.waitFor('result');
  assert.equal(result.code, 'resumeUnsupported'); assert.equal(result.generationStarted, false); await run.exit;
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});
