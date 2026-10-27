import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { antigravityArguments, checkAntigravityArguments } from '../skills/codex-subagent-guide/scripts/adapters/antigravity-arguments.mjs';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const scripts = guideRuntimeScripts(import.meta.url);
const windows = process.platform === 'win32';
const testOptions = { skip: windows, timeout: 15000 };
const answer = 'Final Antigravity response.\n完整结果。';

// Test Value Gate: the production argument helper protects AW session, input,
// output and deadline controls before a task can reach the external backend.
test('Antigravity options preserve ordinary settings and reject control overrides', () => {
  const request = { args: ['--agent', 'reviewer', '--mode=plan', '--sandbox=false', '--add-dir', '/one', '--add-dir=/two'], execution: { model: 'chosen-model', reasoningEffort: 'xhigh' } };
  assert.deepEqual(antigravityArguments(request), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0', ...request.args,
    '--model', 'chosen-model', '--effort', 'xhigh',
  ]);
  assert.doesNotThrow(() => checkAntigravityArguments({ args: ['--model=raw-model', '--effort', 'max', '--dangerously-skip-permissions=false'], execution: {} }));
  for (const args of [
    ['--input-format=text'], ['--output-format', 'json'], ['--print-timeout=0'], ['--print', 'task'], ['-phello'],
    ['--continue'], ['--conversation=id'], ['--project', 'other'], ['--new-project'], ['--remote-control'],
    ['--cwd=/other'], ['--gemini_dir=/other'], ['--help'], ['--version'], ['mcp', 'list'], ['--', 'prompt'],
    ['--sandbox', 'false'], ['--agent'], ['--model', '--continue'], ['--mode=invalid'], ['--effort=ultra'],
    ['--unknown=value'], ['--model=one', '--model=two'],
  ]) assert.throws(() => checkAntigravityArguments({ args, execution: {} }), { code: /^(adapterArgumentConflict|parameterUnavailable)$/ });
  for (const args of [['--model=duplicate'], ['--effort', 'high']]) assert.throws(() => checkAntigravityArguments({ ...request, args }), { code: 'adapterArgumentConflict' });
  assert.throws(() => checkAntigravityArguments({ args: [], execution: { reasoningEffort: 'ultra' } }), { code: 'parameterUnavailable' });
});

// Test Value Gate: a copied installed adapter talks to a real, isolated backend
// process. Only the external agy boundary is replaced; JSONL, input, exit and
// owned-process cleanup use the production implementation.
async function fixture(t, scenario = 'success') {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-antigravity-'));
  const installed = path.join(root, 'installed');
  await fs.cp(scripts, installed, { recursive: true });
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const directory = path.join(root, 'runtime');
  const bin = path.join(root, 'bin');
  for (const target of [workspace, home, directory, bin]) await fs.mkdir(target, { mode: 0o700 });
  await protectPrivatePath(directory, 'directory');
  const capture = path.join(root, 'capture.jsonl');
  await fs.writeFile(path.join(bin, 'agy'), `#!${process.execPath}
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const scenario = process.env.FIXTURE_SCENARIO;
const capture = value => fs.appendFile(process.env.FIXTURE_CAPTURE, JSON.stringify(value)+'\\n');
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
await capture({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME});
setTimeout(()=>process.exit(9),12000).unref();
const init = () => emit({event:'init',conversation_id:'conversation-fixture',init:{tools:['run_command']}});
if (scenario === 'init early') init();
const input = createInterface({input:process.stdin});
input.on('line',async line=>{
 const value=JSON.parse(line);
 await capture({input:value});
 if (scenario !== 'init early') init();
 if (scenario === 'disconnect') return process.exit(0);
 const step={conversation_id:'conversation-fixture',step_index:0,state:'DONE',step_type:'user_input'};
 if (scenario !== 'missing acceptance') {emit({event:'step_update',step_update:step});emit({event:'step_update',step_update:step});}
 if (scenario === 'hold') {
   const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(9),11000);setInterval(()=>{},1000)'],{stdio:'ignore'});
   await capture({descendant:child.pid});
   emit({event:'step_update',step_update:{...step,step_index:1,state:'ACTIVE',step_type:'agent_response',text_delta:'partial'}});
   return;
 }
 emit({event:'step_update',step_update:{...step,step_index:1,step_type:'agent_response',text_delta:'partial delta'}});
 if (scenario === 'no terminal') return process.exit(0);
 const result={event:'result',result:{conversation_id:scenario==='session mismatch'?'other-conversation':'conversation-fixture',status:scenario==='failure'?'ERROR':'SUCCESS',response:${JSON.stringify(answer)},num_turns:1}};
 emit(result);
 if (scenario==='duplicate result') emit(result);
});
input.on('close',()=>setImmediate(()=>process.exit(scenario==='nonzero'?7:0)));
`, { mode: 0o700 });
  const request = {
    protocolVersion: 5, type: 'start', run: { id: randomBytes(16).toString('hex'), name: 'agy-fixture', deadlineAt: null },
    execution: { executor: 'fixture', model: 'chosen-model', reasoningEffort: 'high' }, mode: 'workspace', workspace,
    prompt: ' 原始任务\nKeep "quotes", `$()` and Unicode。\n', args: ['--mode', 'plan', '--sandbox'], communication: false,
    runtime: { directory, toolkit: { command: process.execPath, module: path.join(installed, 'runtime/adapter-channel.mjs'), messageScript: path.join(installed, 'message.mjs'), mcpScript: path.join(installed, 'message-mcp.mjs') } },
  };
  const environment = {
    PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home, TMPDIR: root,
    LANG: 'C.UTF-8', AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'), FIXTURE_CAPTURE: capture, FIXTURE_SCENARIO: scenario,
  };
  const child = spawn(process.execPath, [path.join(installed, 'adapters/antigravity-v5.mjs')], { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const frames = [], waiters = new Set();
  let diagnostic = '', closed = false;
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { diagnostic += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => { frames.push(JSON.parse(line)); for (const check of waiters) check(); });
  const exit = new Promise((resolve) => child.once('close', (code) => { closed = true; for (const check of waiters) check(); resolve({ code, diagnostic }); }));
  t.after(async () => {
    if (!closed) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await exit;
    await fs.rm(root, { recursive: true, force: true });
  });
  const send = (value) => child.stdin.write(`${JSON.stringify({ protocolVersion: 5, ...value })}\n`);
  const waitFor = (type) => new Promise((resolve, reject) => {
    let timer;
    const finish = (error, frame) => { clearTimeout(timer); waiters.delete(check); if (error) reject(error); else resolve(frame); };
    const check = () => {
      const frame = frames.find((value) => value.type === type);
      if (frame) finish(null, frame);
      else if (closed) finish(new Error(`Missing ${type}: ${JSON.stringify(frames)} ${diagnostic}`));
    };
    waiters.add(check); timer = setTimeout(() => finish(new Error(`Missing ${type}: ${JSON.stringify(frames)} ${diagnostic}`)), 10000); check();
  });
  const captured = async () => {
    try { const contents = await fs.readFile(capture, 'utf8'); return contents.split('\n').slice(0, -1).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const waitForCaptured = async (predicate) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const match = (await captured()).find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The backend did not reach the expected state.');
  };
  return { request, directory, workspace, home, frames, send, waitFor, captured, waitForCaptured, exit };
}

for (const scenario of ['init early', 'success']) test(`Antigravity: communication=false completes with ${scenario === 'init early' ? 'early' : 'late'} init and preserves the task`, testOptions, async (t) => {
  const f = await fixture(t, scenario); f.send(f.request);
  assert.deepEqual((await f.waitFor('ready')).communication, { status: 'disabled' });
  const result = await f.waitFor('result');
  assert.equal(result.state, 'completed', JSON.stringify(result)); assert.equal(result.text, answer);
  assert.equal(result.backendExitCode, 0); assert.equal(result.generationStarted, true);
  assert.equal((await f.exit).code, 0);
  const values = await f.captured();
  assert.equal(values[0].cwd, f.workspace); assert.equal(values[0].home, f.home);
  assert.deepEqual(values[0].args, antigravityArguments(f.request));
  assert.deepEqual(values.filter((value) => value.input).map((value) => value.input), [{ event: 'user', message: { content: f.request.prompt } }]);
  await assert.rejects(fs.access(path.join(f.directory, 'communication')), { code: 'ENOENT' });
  assert.equal(f.frames.filter((frame) => frame.type === 'result').length, 1);
  assert.ok(f.frames.findIndex((frame) => frame.type === 'closing') < f.frames.findIndex((frame) => frame.type === 'result'));
});

test('Antigravity: unqualified communication fails before backend or bridge creation', testOptions, async (t) => {
  const f = await fixture(t); f.request.communication = true; f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.code, 'antigravityCommunicationUnverified'); assert.equal(result.generationStarted, false);
  assert.equal(result.backendExitCode, null); assert.equal(f.frames.some((frame) => frame.type === 'ready'), false);
  assert.deepEqual(await f.captured(), []);
  await assert.rejects(fs.access(path.join(f.directory, 'communication')), { code: 'ENOENT' });
  assert.equal((await f.exit).code, 0);
});

for (const scenario of ['missing acceptance', 'disconnect', 'no terminal', 'nonzero', 'session mismatch', 'duplicate result', 'failure']) test(`Antigravity: ${scenario} cannot become successful`, testOptions, async (t) => {
  const f = await fixture(t, scenario); f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, scenario === 'failure' ? 'failed' : 'unknown', JSON.stringify(result));
  if (scenario === 'missing acceptance') assert.equal(f.frames.find((frame) => frame.type === 'closing').reason, 'failed');
  if (scenario === 'nonzero') assert.equal(result.backendExitCode, 7);
  if (scenario === 'disconnect') assert.equal(result.generationStarted, null);
  assert.equal((await f.exit).code, 0);
  assert.equal((await f.captured()).filter((value) => value.input).length, 1);
});

for (const reason of ['requested', 'deadline']) test(`Antigravity: ${reason} stops only the owned backend tree and preserves unknown remote status`, testOptions, async (t) => {
  const f = await fixture(t, 'hold');
  if (reason === 'deadline') f.request.run.deadlineAt = Date.now() + 1800;
  f.send(f.request); await f.waitFor('ready');
  const descendant = (await f.waitForCaptured((value) => value.descendant)).descendant;
  const root = (await f.captured())[0].pid;
  if (reason === 'requested') f.send({ type: 'stop', reason: 'requested' });
  const result = await f.waitFor('result');
  assert.equal(result.state, 'unknown'); assert.equal(result.remoteStopConfirmed, false);
  assert.equal(result.code, reason === 'deadline' ? 'adapterDeadlineExceeded' : 'remoteStopUnconfirmed');
  assert.equal((await f.exit).code, 0);
  for (const pid of [root, descendant]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const values = await f.captured();
  assert.equal(values.filter((value) => value.input).length, 1);
  assert.ok(values.filter((value) => value.input).every((value) => value.input.event === 'user'));
});
