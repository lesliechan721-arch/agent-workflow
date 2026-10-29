import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createChildBridge, createChildChannel, invokeChildTool } from '../skills/codex-subagent-guide/scripts/runtime/adapter-channel.mjs';
import { executeAntigravity } from '../skills/codex-subagent-guide/scripts/adapters/antigravity-v5.mjs';
import { deferred } from '../skills/codex-subagent-guide/scripts/adapters/common.mjs';
import { antigravityArguments, checkAntigravityArguments } from '../skills/codex-subagent-guide/scripts/adapters/antigravity-arguments.mjs';
import { antigravityPermissionRules } from '../skills/codex-subagent-guide/scripts/adapters/antigravity-permissions.mjs';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const scripts = guideRuntimeScripts(import.meta.url);
const windows = process.platform === 'win32';
const testOptions = { skip: windows, timeout: 15000 };
const answer = 'Final Antigravity response.\n完整结果。';
const bridgeMessage = "消息 'quoted' \"double\" $HOME $(printf WRONG)\nsecond line";

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
  await fs.cp(path.join(scripts, '../assets'), path.join(root, 'assets'), { recursive: true });
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
const init = () => emit({event:'init',conversation_id:'conversation-fixture',init:{tools:scenario==='missing command tool'?[]:['run_command'],...(scenario==='strict permissions'?{permission_mode:'strict'}:{})}});
if (scenario === 'init early') init(); else setTimeout(init, 25);
const input = createInterface({input:process.stdin});
input.on('line',async line=>{
 const value=JSON.parse(line);
 await capture({input:value});

 if (scenario === 'disconnect') return process.exit(0);
 const step={conversation_id:'conversation-fixture',step_index:0,state:'DONE',step_type:'user_input'};
 if (scenario !== 'missing acceptance') {emit({event:'step_update',step_update:step});emit({event:'step_update',step_update:step});}
 if (scenario === 'auto late') {process.stderr.write('warning: --mode auto is not available ');setImmediate(()=>process.stderr.write('for this account; continuing in the default mode.\\n'));return;}
 if (scenario === 'hold') {
   const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(9),11000);setInterval(()=>{},1000)'],{stdio:'ignore'});
   await capture({descendant:child.pid});
   emit({event:'step_update',step_update:{...step,step_index:1,state:'ACTIVE',step_type:'agent_response',text_delta:'partial'}});
   return;
 }
 if (scenario === 'communication') {
  const command=value.message.content.split('\\n').find(line=>line.endsWith("'MESSAGE_TEXT'"));
  if (!command) return process.exit(8);
  if (!command.startsWith(process.execPath+' ')) return process.exit(8);
  const invocation=command.replace("'MESSAGE_TEXT'",${JSON.stringify(`'${bridgeMessage.replaceAll("'", "'\\''")}'`)});
  const messenger=spawn('/bin/sh',['-c',invocation],{stdio:['ignore','pipe','pipe']});
  let receipt='',error='';
  messenger.stdout.on('data',chunk=>receipt+=chunk); messenger.stderr.on('data',chunk=>error+=chunk);
  const code=await new Promise(resolve=>messenger.once('close',resolve));
  await capture({messageCommandExit:code,receipt,error});
  if (code!==0) return process.exit(8);
 }
 emit({event:'step_update',step_update:{...step,step_index:1,step_type:'agent_response',text_delta:'partial delta'}});
 if (scenario.startsWith('tool ') || scenario === 'unknown tool state') {
  emit({event:'step_update',step_update:{...step,step_index:2,step_type:'tool',state:'ACTIVE'}});
  emit({event:'step_update',step_update:{...step,step_index:2,step_type:'tool',state:scenario==='unknown tool state'?'FAILED':'ERROR'}});
 }
 if (scenario === 'no terminal') return process.exit(0);
 const result={event:'result',result:{conversation_id:scenario==='session mismatch'?'other-conversation':'conversation-fixture',status:scenario==='failure'||scenario==='tool error failure'?'ERROR':'SUCCESS',response:['tool denied empty','tool denied invalid','tool error empty'].includes(scenario)?'':scenario==='auto discussion'?'Auto is not supported; continuing in the default mode.':${JSON.stringify(answer)},num_turns:1}};
 if (scenario==='tool denied empty') result.result.denied_actions=[{action:'command',display_name:'RunCommand'}];
 if (scenario==='tool denied invalid') result.result.denied_actions={action:'command'};
 emit(result);
 if (scenario==='duplicate result') emit(result);
});
input.on('close',()=>setImmediate(()=>process.exit(scenario==='nonzero'?7:0)));
`, { mode: 0o700 });
  const request = {
    protocolVersion: 5, type: 'start', permissionMode: 'default', run: { id: randomBytes(16).toString('hex'), name: 'agy-fixture', deadlineAt: null },
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
  assert.deepEqual((await f.waitFor('ready')).initialization.capabilities.communication, { status: 'disabled' });
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

// Test Value Gate: the public adapter entry must prepare its installed template,
// allow only the exact script, and carry actual command bytes through the bridge.
for (const permissionMode of ['default', 'full-access']) test('Antigravity: '+permissionMode+' communication publishes enabled ready and sends through the actual command bridge', testOptions, async (t) => {
  const f = await fixture(t, 'communication');
  f.request.communication = true; f.request.permissionMode = permissionMode; f.request.args = [];
  f.send(f.request);
  assert.deepEqual((await f.waitFor('ready')).initialization.capabilities.communication, { status: 'enabled', transport: 'command', passiveDelivery: 'turn-boundary' });
  assert.equal((await f.waitFor('message')).text, bridgeMessage);
  assert.equal((await f.waitFor('result')).state, 'completed');
  assert.equal((await f.exit).code, 0);
  const values = await f.captured();
  assert.equal(values.filter((value) => value.input).length, 1);
  const invocation = values.find((value) => Object.hasOwn(value, 'messageCommandExit'));
  assert.equal(invocation.messageCommandExit, 0, invocation.error);
  assert.equal(invocation.receipt, 'send_parent: submitted\n');
  const settingsFile = path.join(f.home, '.gemini/antigravity-cli/settings.json');
  if (permissionMode === 'full-access') await assert.rejects(fs.access(settingsFile), { code: 'ENOENT' });
  else {
    const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.deepEqual(settings.permissions.allow, antigravityPermissionRules(process.execPath, f.request.runtime.toolkit.messageScript));
  }
});

test('Antigravity: conflicting permission options fail before backend, bridge, or settings creation', testOptions, async (t) => {
  const f = await fixture(t); f.request.communication = true; f.request.permissionMode = 'auto'; f.request.args = ['--dangerously-skip-permissions']; f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.code, 'adapterArgumentConflict'); assert.equal(result.generationStarted, false);
  assert.equal(result.backendExitCode, null); assert.equal(f.frames.some((frame) => frame.type === 'ready'), false);
  assert.deepEqual(await f.captured(), []);
  await assert.rejects(fs.access(path.join(f.directory, 'communication')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.home, '.gemini')), { code: 'ENOENT' });
  assert.equal((await f.exit).code, 0);
});

test('Antigravity: a conflicting exact command deny fails before native input', testOptions, async (t) => {
  const f = await fixture(t); f.request.communication = true;
  const settingsFile = path.join(f.home, '.gemini/antigravity-cli/settings.json');
  const contents = JSON.stringify({ permissions: { deny: ['command('+process.execPath+' '+f.request.runtime.toolkit.messageScript+')'] } })+'\n';
  await fs.mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(settingsFile, contents, { mode: 0o600 });
  f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.code, 'communicationPermissionDenied'); assert.equal(result.generationStarted, false);
  assert.equal(f.frames.some((frame) => frame.type === 'ready'), false);
  assert.deepEqual(await f.captured(), []);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), contents);
  assert.equal((await f.exit).code, 0);
});

for (const [scenario, code] of [['missing command tool', 'communicationToolUnavailable'], ['strict permissions', 'communicationPermissionDenied']]) test('Antigravity: '+scenario+' fails before ready or model input', testOptions, async (t) => {
  const f = await fixture(t, scenario); f.request.communication = true; f.request.permissionMode = 'full-access'; f.request.args = []; f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.code, code); assert.equal(result.generationStarted, false);
  assert.equal(f.frames.some((frame) => frame.type === 'ready'), false);
  assert.equal((await f.captured()).filter((value) => value.input).length, 0);
  assert.equal((await f.exit).code, 0);
});

for (const scenario of ['missing acceptance', 'disconnect', 'no terminal', 'nonzero', 'session mismatch', 'duplicate result', 'failure']) test(`Antigravity: ${scenario} cannot become successful`, testOptions, async (t) => {
  const f = await fixture(t, scenario); f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, scenario === 'failure' ? 'failed' : 'unknown', JSON.stringify(result));
  if (scenario === 'missing acceptance') assert.equal(result.code, 'backendInputAcceptanceInvalid');
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

// Test Value Gate: a late native auto rejection must stop the owned process
// and keep actual submission evidence. It must not resend under default mode.
test('Antigravity: late auto fallback retains generation evidence and sends no replacement input', testOptions, async (t) => {
  const f = await fixture(t, 'auto late');
  f.request.args = [];
  f.request.permissionMode = 'auto';
  f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.code, 'permissionModeUnavailable');
  assert.equal(result.state, 'unknown');
  assert.equal(result.generationStarted, true);
  assert.equal((await f.captured()).filter((value) => value.input).length, 1);
  assert.equal((await f.exit).code, 0);
});

// Test Value Gate: the real adapter and channel protect turn acceptance,
// shared receive allocation and terminal failures with a controlled agy stream.
// One separate file-bridge case covers the native transport and scanner wiring.
async function communicationFixture(t, { secondFails = false, staleSecondStep = false, fileBridge = false } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-agy-turns-'));
  const controller = new AbortController(), stopped = deferred(), done = deferred(), initial = deferred(), second = deferred();
  const stdout = new PassThrough(), inputs = [], messages = [];
  let exited = false, exitCode = null, step = -1, scheduler, running;
  const emit = (value) => stdout.write(`${JSON.stringify(value)}\n`);
  const backend = {
    child: { stdout }, done: done.promise,
    get exited() { return exited; }, get exitCode() { return exitCode; },
    async write(input) {
      inputs.push(input);
      const index = inputs.length;
      emit({ event: 'step_update', step_update: { conversation_id: 'same-conversation', step_index: staleSecondStep && index === 2 ? 0 : ++step, step_type: 'user_input', state: 'DONE' } });
      (index === 1 ? initial : second).resolve();
    },
    async end() { exited = true; exitCode = 0; done.resolve(); },
    async cleanup() { exited = true; exitCode = 0; done.resolve(); return true; },
  };
  const context = {
    request: { args: [], execution: {}, permissionMode: 'full-access', run: { deadlineAt: null }, runtime: { directory: root } },
    executable: { command: '/qualified/fake-agy', args: [] }, environment: { HOME: root }, runtime: { directory: root },
    signal: controller.signal, generationStarted: false, stopped, prompt: 'Initial task', diagnostics: [],
    abort(code) { this.errorCode = code; controller.abort(); void this.onStop?.(); },
    async prepareCommunication({ submitInput, canSubmitInput }) {
      const options = { emitParentMessage: async (text) => { messages.push(text); }, submitInput, canSubmitInput };
      if (fileBridge) {
        await protectPrivatePath(root, 'directory');
        this.bridge = await createChildBridge({
          directory: path.join(root, 'communication'), deadlineAt: null,
          toolkit: { command: process.execPath, module: path.join(scripts, 'runtime/adapter-channel.mjs'), messageScript: path.join(scripts, 'message.mjs'), mcpScript: path.join(scripts, 'message-mcp.mjs') },
          ...options,
        });
      } else {
        this.bridge = createChildChannel(options);
        // A channel caller supplies wake-ups; the file bridge owns its scanner.
        scheduler = setInterval(() => this.bridge.schedule(), 10);
      }
      return this.bridge;
    },
    async ready() {},
    async beginClosing(reason) { clearInterval(scheduler); await this.bridge.close(reason); },
    async spawn() {
      setImmediate(() => emit({ event: 'init', conversation_id: 'same-conversation', init: { tools: ['run_command'], permission_mode: 'always-proceed' } }));
      return backend;
    },
  };
  t.after(async () => {
    clearInterval(scheduler);
    controller.abort();
    try {
      await backend.cleanup();
      await running;
    } finally {
      try { await context.bridge?.close('cancelled'); }
      finally { stdout.destroy(); await fs.rm(root, { recursive: true, force: true }); }
    }
  });
  running = executeAntigravity(context);
  await Promise.race([initial.promise, running.then(() => { throw new Error('The adapter ended before the initial input.'); })]);
  const tool = (operation, options = {}) => fileBridge
    ? invokeChildTool({ bindingFile: context.bridge.script.args[2], operation, signal: controller.signal, ...options })
    : context.bridge.handleRequest({ operation, ...options });
  return {
    context, running, inputs, messages, second, tool, root, backendExited: () => exited,
    finish(number, overrides = {}) {
      emit({ event: 'step_update', step_update: { conversation_id: 'same-conversation', step_index: ++step, step_type: 'agent_response', state: 'DONE' } });
      emit({ event: 'result', result: { conversation_id: 'same-conversation', status: number === 2 && secondFails ? 'ERROR' : 'SUCCESS', response: number === 1 ? 'First turn answer' : secondFails ? 'Second turn failed' : 'Last confirmed answer\n完整结果', num_turns: number, ...overrides } });
    },
  };
}

// Test Value Gate: actual file scans must retain input while the adapter is
// active, then submit it when the confirmed native turn makes the backend ready.
test('Antigravity file bridge schedules queued input only at a confirmed turn boundary', { timeout: windows ? 90000 : 10000 }, async (t) => {
  const f = await communicationFixture(t, { fileBridge: true });
  const delivery = f.context.bridge.acceptInput({ id: 'a'.repeat(32), text: 'Automatic follow-up' });
  assert.equal((await f.tool('send', { text: 'Child question during the first turn' })).outcome, 'submitted');
  assert.equal(f.inputs.length, 1);
  assert.equal(f.context.bridge.hasPendingInput(), true);
  f.finish(1);
  await f.second.promise;
  assert.deepEqual(await delivery, { status: 'submitted' });
  assert.equal(f.inputs.length, 2);
  assert.match(f.inputs[1].message.content, /Automatic follow-up/);
  f.finish(2);
  assert.equal((await f.running).state, 'completed');
  assert.deepEqual(f.messages, ['Child question during the first turn']);
  assert.equal(f.backendExited(), true);
  await assert.rejects(fs.access(path.join(f.root, 'communication')), { code: 'ENOENT' });
});

for (const secondFails of [false, true]) test(`Antigravity communication preserves active receive and automatic second turn${secondFails ? ' failure' : ''}`, { timeout: 10000 }, async (t) => {
  const f = await communicationFixture(t, { secondFails });
  assert.equal((await f.tool('send', { text: 'Child question' })).outcome, 'submitted');
  const received = f.tool('receive', { timeoutMs: 1000 });
  const deliveryA = f.context.bridge.acceptInput({ id: 'a'.repeat(32), text: 'Reply A' });
  assert.deepEqual(await received, { outcome: 'received', text: 'Reply A' });
  assert.deepEqual(await deliveryA, { status: 'submitted' });
  assert.equal(f.inputs.length, 1);
  const deliveryB = f.context.bridge.acceptInput({ id: 'b'.repeat(32), text: 'Automatic B' });
  f.finish(1);
  await f.second.promise;
  assert.deepEqual(await deliveryB, { status: 'submitted' });
  assert.equal(f.inputs.length, 2);
  assert.match(f.inputs[1].message.content, /Automatic B/);
  assert.deepEqual(await f.tool('receive', { timeoutMs: 0 }), { outcome: 'timeout' });
  f.finish(2);
  const result = await f.running;
  assert.equal(result.state, secondFails ? 'failed' : 'completed');
  assert.equal(result.text, secondFails ? 'Second turn failed' : 'Last confirmed answer\n完整结果');
  assert.equal(result.sessionId, 'same-conversation');
  assert.deepEqual(f.messages, ['Child question']);
  assert.deepEqual(await f.context.bridge.acceptInput({ id: 'c'.repeat(32), text: 'Late' }), { status: 'notSubmitted', code: 'runClosed', message: 'The run is closed.' });
});

test('Antigravity does not accept an old user step as confirmation of a second input', { timeout: 10000 }, async (t) => {
  const f = await communicationFixture(t, { staleSecondStep: true });
  const delivery = f.context.bridge.acceptInput({ id: 'd'.repeat(32), text: 'Follow-up' });
  f.finish(1);
  await f.second.promise;
  assert.equal((await delivery).status, 'unknown');
  assert.equal((await f.running).state, 'unknown');
  assert.equal(f.context.errorCode, 'backendOutputInvalid');
  assert.equal(f.inputs.length, 2);
});

test('Antigravity auto preserves model prose about auto fallback', testOptions, async (t) => {
  const f = await fixture(t, 'auto discussion'); f.request.args = []; f.request.permissionMode = 'auto'; f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, 'completed');
  assert.equal(result.text, 'Auto is not supported; continuing in the default mode.');
  assert.equal((await f.exit).code, 0);
});

// Test Value Gate: foreign wire controls fail before either agy or its user
// permission preparation can run.
test('Antigravity: rejects misplaced Codex configuration before negotiation', testOptions, async (t) => {
  const f = await fixture(t);
  f.request.communication = true;
  f.request.codex = { cliSource: 'app', bypassHookTrust: true };
  f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.code, 'protocolInvalid');
  assert.equal(result.state, 'failed');
  assert.equal(result.generationStarted, false);
  assert.equal(result.initialization, undefined);
  assert.deepEqual(await f.captured(), []);
  assert.deepEqual(await fs.readdir(f.home), []);
  assert.equal((await f.exit).code, 0);
});

// Test Value Gate: the native tool ERROR event is distinct from malformed wire
// output. Service status, response and explicit denial evidence decide the run.
for (const [scenario, state, code] of [
  ['tool error recovered', 'completed', undefined],
  ['tool error failure', 'failed', 'backendFailed'],
  ['tool denied empty', 'failed', 'backendActionDenied'],
  ['tool error empty', 'unknown', 'serviceTerminalConflict'],
  ['tool denied invalid', 'unknown', 'backendOutputInvalid'],
  ['unknown tool state', 'unknown', 'backendOutputInvalid'],
]) test(`Antigravity native ${scenario} preserves the actual terminal outcome`, testOptions, async (t) => {
  const f = await fixture(t, scenario); f.send(f.request);
  const result = await f.waitFor('result');
  assert.equal(result.state, state, JSON.stringify(result));
  assert.equal(result.code, code);
  assert.equal(result.generationStarted, true);
  const denied = result.diagnostics?.filter((value) => value.code === 'backendActionDenied') ?? [];
  if (scenario === 'tool denied empty') {
    assert.deepEqual(denied, [{ code: 'backendActionDenied', message: 'Antigravity reported 1 denied tool action.' }]);
    assert.equal(f.frames.find((frame) => frame.type === 'closing').reason, 'failed');
  } else assert.deepEqual(denied, []);
  if (state === 'completed') assert.equal(result.text, answer);
  assert.equal((await f.captured()).filter((value) => value.input).length, 1);
  assert.equal((await f.exit).code, 0);
});


// Test Value Gate: an already queued parent message must not turn a denied,
// empty native result into another turn or prevent the bridge from closing.
test('Antigravity closes queued input after an empty denied terminal without submitting another turn', { timeout: 10000 }, async (t) => {
  const f = await communicationFixture(t);
  const queued = f.context.bridge.acceptInput({ id: 'e'.repeat(32), text: 'Queued follow-up must remain unsubmitted' });
  // If a faulty continuation starts, give it a successful result. The test
  // must still preserve the first terminal denial instead of hiding it.
  void f.second.promise.then(() => f.finish(2));
  f.finish(1, { response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
  const result = await f.running;
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.equal(result.code, 'backendActionDenied');
  assert.equal(result.text, '');
  assert.equal(f.context.generationStarted, true);
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(await queued, { status: 'notSubmitted', code: 'runClosed', message: 'The run is closed.' });
  assert.equal(f.context.bridge.hasPendingInput(), false);
  assert.equal(f.backendExited(), true);
  assert.deepEqual(await f.context.bridge.acceptInput({ id: 'f'.repeat(32), text: 'Queued follow-up must remain unsubmitted' }), { status: 'notSubmitted', code: 'runClosed', message: 'The run is closed.' });
  assert.equal(f.inputs.length, 1);
});
