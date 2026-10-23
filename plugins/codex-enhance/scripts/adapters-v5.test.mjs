import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { createChildBridge, invokeChildTool } from '../skills/codex-subagent-guide/scripts/runtime/adapter-channel.mjs';
import { executeClaude } from '../skills/codex-subagent-guide/scripts/adapters/claude-code-v5.mjs';
import { assertOracleFileSelectionSupported } from '../skills/codex-subagent-guide/scripts/adapters/oracle-arguments.mjs';
import { deferred } from '../skills/codex-subagent-guide/scripts/adapters/common.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const require = createRequire(import.meta.url);
const registeredEntries = {
  codex: require.resolve('../skills/codex-subagent-guide/scripts/adapters/codex-v5.mjs'),
  claude: require.resolve('../skills/codex-subagent-guide/scripts/adapters/claude-code-v5.mjs'),
  oracle: require.resolve('../skills/codex-subagent-guide/scripts/adapters/oracle-v5.mjs'),
  message: require.resolve('../skills/codex-subagent-guide/scripts/message.mjs'),
  mcp: require.resolve('../skills/codex-subagent-guide/scripts/message-mcp.mjs'),
};
const scripts = guideRuntimeScripts(import.meta.url);
const registeredScripts = path.dirname(registeredEntries.message);
const sourceEntries = Object.fromEntries(Object.entries(registeredEntries)
  .map(([key, entry]) => [key, path.join(scripts, path.relative(registeredScripts, entry))]));
const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const windows = process.platform === 'win32';
const supported = ['darwin', 'linux', 'win32'].includes(process.platform);
const testTimeoutMs = windows ? 120000 : 15000;
const explicitDeadlineMs = windows ? 30000 : 500;
const answer = 'Complete **answer**.\n第二行。';

// Test Value Gate: real adapter and backend processes protect actual JSONL,
// input acceptance, configuration, exit evidence, cancellation and install closure.
async function fixture(t, backend = 'codex', scenario = 'success') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-v5-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const installed = path.join(directory, 'installed');
  await fs.cp(scripts, installed, { recursive: true });
  const installedEntry = (source) => path.join(installed, path.relative(scripts, source));
  const selection = path.join(installed, 'file-selection/selection.mjs');
  if (process.env.AW_PLUGIN_EVENT !== 'test') {
    const bundled = await build({ entryPoints: [selection], nodePaths: [path.join(packageRoot, 'node_modules')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, legalComments: 'inline', logLevel: 'silent', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    await fs.writeFile(selection, bundled.outputFiles[0].contents);
  }
  const workspace = path.join(directory, 'workspace');
  const home = path.join(directory, 'home');
  const runtime = path.join(directory, 'adapter');
  const bin = path.join(directory, 'bin');
  for (const target of [workspace, home, runtime, bin]) await fs.mkdir(target, { mode: 0o700 });
  await protectPrivatePath(runtime, 'directory');
  await fs.writeFile(path.join(workspace, 'main.ts'), 'export const value = 1;\n');
  const capture = path.join(directory, 'capture.jsonl');
  const fakePackage = path.join(bin, 'node_modules', 'aw-fake-backend');
  if (windows) {
    await fs.mkdir(fakePackage, { recursive: true });
    await fs.writeFile(path.join(fakePackage, 'package.json'), JSON.stringify({
      name: 'aw-fake-backend', private: true, type: 'module', bin: { [backend]: 'backend.mjs' },
    }));
    // A standard npm shim is data for resolveSafeCommand. It is never run by
    // cmd.exe; the verified package bin is passed directly to Node.
    const target = 'node_modules\\aw-fake-backend\\backend.mjs';
    const shim = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, ''].join('\r\n');
    await fs.writeFile(path.join(bin, `${backend}.cmd`), shim);
  }
  const executable = windows ? path.join(fakePackage, 'backend.mjs') : path.join(bin, backend);
  await fs.writeFile(executable, `#!${process.execPath}
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2), scenario = process.env.FIXTURE_CASE, backend = process.env.FIXTURE_BACKEND;
const answer = ${JSON.stringify(answer)};
const capture = async (value) => fs.appendFile(process.env.FIXTURE_CAPTURE, JSON.stringify(value)+'\\n');
await capture({args,cwd:process.cwd(),environment:{HOME:process.env.HOME,NORMAL_SETTING:process.env.NORMAL_SETTING,OPENAI_API_KEY:process.env.OPENAI_API_KEY,marker:process.env.AW_SUBAGENT_PROCESS_TOKEN}});
setTimeout(()=>process.exit(9),${windows ? 90000 : 12000}).unref();
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
if (backend === 'oracle') {
 let input=''; for await(const chunk of process.stdin) input+=chunk;
 await capture({input});
 if(scenario==='hold') await new Promise(resolve=>setTimeout(resolve,${windows ? 75000 : 8000}));
 if(scenario!=='no terminal') await fs.writeFile(args[args.indexOf('--write-output')+1],answer);
 process.stdout.write('Request accepted.\\n');
 process.exit(scenario==='nonzero'?7:0);
}
let count=0, timer, active, parentSeen=false, steeringCount=0;
const finish=()=> {
 if(scenario==='no terminal'){process.exit(0);return;}
 if(scenario==='diagnostic overflow')process.stderr.write(Buffer.alloc(8388609,120));
 if(backend==='codex') {
  const turn={id:active,status:scenario==='failure'?'failed':'completed',items:[{id:'answer-'+active,type:'agentMessage',phase:'final_answer',text:answer}]};
  emit({method:'item/completed',params:{threadId:'thread-fixture',turnId:active,item:turn.items[0]}});
  emit({method:'turn/completed',params:{threadId:'thread-fixture',turn}});
  active=undefined;
 } else emit({type:'result',subtype:scenario==='failure'?'error_during_execution':'success',is_error:scenario==='failure',num_turns:1,session_id:'session-fixture',result:answer});
};
const input=createInterface({input:process.stdin});
input.on('line',async line=>{
 const value=JSON.parse(line);await capture({input:value});
 if(backend==='codex'){
  const respond=result=>emit({id:value.id,result});
  if(value.method==='initialize')respond({});
  else if(value.method==='thread/start') {
   if(scenario==='initialization failure')emit({id:value.id,error:{code:-32602,message:'invalid explicit configuration'}});
   else respond({thread:{id:'thread-fixture'},model:'model-fixture'});
  } else if(value.method==='turn/start') {
   count++;active='turn-'+count;respond({turn:{id:active,status:'inProgress',items:[]}});
   emit({method:'turn/started',params:{threadId:'thread-fixture',turn:{id:active}}});
   if(scenario==='child tool'){
    const spec=args.find(arg=>/^mcp_servers\\..*\\.args=/.test(arg));
    const mcp=JSON.parse(spec.slice(spec.indexOf('=')+1));
    const child=spawn(process.execPath,[path.join(path.dirname(mcp[0]),'message.mjs'),...mcp.slice(1),'send','--text','Child question 父消息?'],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);
    await new Promise(resolve=>child.once('close',resolve));await capture({toolOutput:output});return;
   }
   if(scenario==='approval'){emit({id:'approval-request',method:'item/commandExecution/requestApproval',params:{}});return;}
   if(scenario==='hold'||scenario==='many inputs'&&count===1||scenario==='parent input'&&count===1||scenario==='turn race'&&count===1||scenario==='lost response'&&count===1)return;
   timer=setTimeout(finish,80);
  } else if(value.method==='turn/steer') {
   parentSeen=true;steeringCount++;
   if(scenario==='many inputs'&&steeringCount<80){respond({turnId:active});return;}
   if(scenario==='lost response'){process.exit(0);return;}
   if(scenario==='turn race'){
    finish();emit({id:value.id,error:{code:-32602,message:'no active turn to steer'}});
   }else {respond({turnId:active});timer=setTimeout(finish,80);}
  } else if(value.method==='turn/interrupt'){clearTimeout(timer);respond({});}
  else if(value.method==='thread/unsubscribe')respond({status:'unsubscribed'});
 }else{
  if(value.type==='user') {
   count++;
   emit({type:'system',subtype:'init',session_id:'session-fixture',model:'model-fixture'});
   emit({type:'user',uuid:value.uuid,message:value.message,session_id:'session-fixture'});
   emit({type:'assistant',message:{role:'assistant',content:[]}});
   if(scenario!=='hold')timer=setTimeout(finish,scenario==='parent input'&&count===1?160:80);
  }else if(value.type==='control_request'){clearTimeout(timer);emit({type:'control_response',request_id:value.request_id,response:{subtype:'success'}});}
 }
});
input.on('close',()=>{clearTimeout(timer);setTimeout(()=>process.exit(scenario==='nonzero'?7:0),25);});
`, { mode: 0o700 });
  const nativeEnvironment = windows ? process.env : {};
  const systemRoot = Object.entries(nativeEnvironment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  const nativePath = windows ? [systemRoot && path.join(systemRoot, 'System32'), systemRoot].filter(Boolean) : ['/usr/bin', '/bin'];
  const environment = {
    ...nativeEnvironment,
    PATH: [bin, path.dirname(process.execPath), ...nativePath].join(path.delimiter), HOME: home, LANG: 'C.UTF-8',
    ...(windows ? { USERPROFILE: home, TEMP: directory, TMP: directory } : {}),
    OPENAI_API_KEY: 'synthetic-test-key', NORMAL_SETTING: 'preserved setting', AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'),
    FIXTURE_CASE: scenario, FIXTURE_BACKEND: backend, FIXTURE_CAPTURE: capture,
  };
  const request = {
    protocolVersion: 5, type: 'start', run: { id: randomBytes(16).toString('hex'), name: 'agent-fixture', deadlineAt: null },
    execution: { profile: 'generalTaskProfile', executor: 'fixture' }, mode: backend === 'oracle' ? 'bundle' : 'workspace',
    workspace, prompt: ' 原始任务\nQuotes: " ` $() \\n\n', args: [],
    runtime: { directory: runtime, toolkit: { command: process.execPath, module: path.join(installed, 'runtime/adapter-channel.mjs'), messageScript: installedEntry(sourceEntries.message), mcpScript: installedEntry(sourceEntries.mcp) } },
  };
  if (backend === 'oracle') Object.assign(request, { fileSelectors: [], fileResolver: { command: process.execPath, args: [path.join(installed, 'resolve-files.mjs')] } });
  const entry = installedEntry(sourceEntries[backend]);
  const start = () => {
    const child = spawn(process.execPath, [entry], { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: !windows });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const frames = [];
    let diagnostic = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { diagnostic += chunk; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => frames.push(JSON.parse(line)));
    const exit = new Promise((resolve) => child.once('close', (code) => resolve({ code, frames, diagnostic })));
    const send = (value) => child.stdin.write(`${JSON.stringify({ protocolVersion: 5, ...value })}\n`);
    const waitFor = async (type, count = 1) => {
      const stop = Date.now() + (windows ? 90000 : 6000);
      while (frames.filter((frame) => frame.type === type).length < count) {
        if (child.exitCode !== null || Date.now() > stop) assert.fail(`Missing ${type}; frames=${JSON.stringify(frames)}; diagnostic=${diagnostic}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return frames.filter((frame) => frame.type === type).at(-1);
    };
    return { child, send, waitFor, frames, exit };
  };
  const captured = async () => (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  return { request, start, captured, capture, workspace, home };
}

for (const backend of ['codex', 'claude', 'oracle']) test(`${backend}: installed v5 preserves input, configuration and real exit`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend);
  f.request.execution = { ...f.request.execution, model: 'chosen-model', reasoningEffort: 'high' };
  f.request.args = backend === 'codex' ? ['-c', 'shell_environment_policy.inherit="all"', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] : backend === 'claude' ? ['--permission-mode', 'default', '--settings', '{"env":{"SETTING":"value"}}'] : ['--engine', 'api'];
  if (backend === 'oracle' && !windows) f.request.fileSelectors = ['main.ts', 'main.ts'];
  const run = f.start(); run.send(f.request);
  assert.equal((await run.waitFor('ready')).communicationSupported, backend !== 'oracle');
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
    assert.equal(start.model, 'chosen-model'); assert.equal(start.sandbox, 'workspace-write'); assert.equal(start.approvalPolicy, 'on-request');
    const turn = captured.find((value) => value.input?.method === 'turn/start').input.params;
    assert.equal(turn.effort, 'high'); assert.ok(turn.input[0].text.startsWith(f.request.prompt));
    assert.ok(captured[0].args.includes('shell_environment_policy.inherit="all"'));
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
    request: { args: [], execution: {}, prompt: 'Ask the parent for a value.', run: { id: 'e'.repeat(32) } },
    signal: controller.signal, stopped,
    abort(code) { this.errorCode = code; controller.abort(); stopped.resolve(); },
    async ready() {},
    async beginClosing(reason) { await this.bridge.close(reason); },
    async createBridge(submitInput, canSubmitInput) {
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

test('Codex: a rejected steer at a turn boundary starts one next turn', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'turn race'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  run.send({ type: 'message', id: 'b'.repeat(32), text: 'Continue the same task.' });
  assert.equal((await run.waitFor('delivery')).status, 'submitted');
  assert.equal((await run.waitFor('result')).state, 'completed'); await run.exit;
  const values = await f.captured();
  assert.equal(values.filter((value) => value.input?.method === 'thread/start').length, 1);
  assert.equal(values.filter((value) => value.input?.method === 'turn/start').length, 2);
});

test('Codex: a lost submission response stays unknown and is not replayed', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'lost response'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  run.send({ type: 'message', id: 'c'.repeat(32), text: 'Additional input.' });
  assert.equal((await run.waitFor('delivery')).status, 'unknown');
  assert.equal((await run.waitFor('result')).state, 'unknown'); await run.exit;
  const values = await f.captured();
  assert.equal(values.filter((value) => value.input?.method === 'turn/steer').length, 1);
  assert.equal(values.filter((value) => value.input?.method === 'turn/start').length, 1);
});

for (const backend of ['codex', 'claude']) for (const scenario of ['no terminal', 'nonzero', 'diagnostic overflow']) test(`${backend}: ${scenario} cannot become completed`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend, scenario); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'unknown');
  if (scenario === 'nonzero') assert.equal(result.backendExitCode, 7);
  if (scenario === 'diagnostic overflow') assert.equal(result.code, 'adapterDiagnosticTooLarge');
  assert.equal((await run.exit).code, 0);
});

for (const backend of ['codex', 'claude']) for (const stop of ['requested', 'eof', 'deadline']) test(`${backend}: ${stop} stops a backend while generation waits`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend, 'hold');
  if (stop === 'deadline') f.request.run.deadlineAt = Date.now() + explicitDeadlineMs;
  const run = f.start(); run.send(f.request); await run.waitFor('ready');
  if (stop === 'requested') run.send({ type: 'stop', reason: 'requested' });
  if (stop === 'eof') run.child.stdin.end();
  const result = await run.waitFor('result');
  assert.notEqual(result.state, 'completed');
  assert.equal(result.code, stop === 'deadline' ? 'adapterDeadlineExceeded' : stop === 'eof' ? 'channelClosed' : 'remoteStopUnconfirmed');
  assert.equal((await run.exit).code, 0);
});

test('Codex: a fixed 30-day deadline stays open until an explicit stop', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'hold');
  f.request.run.deadlineAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const run = f.start(); run.send(f.request); await run.waitFor('ready');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(run.frames.some((frame) => frame.type === 'closing' || frame.type === 'result'), false);
  run.send({ type: 'stop', reason: 'requested' });
  const result = await run.waitFor('result');
  assert.equal(result.code, 'remoteStopUnconfirmed');
  const closed = await run.exit;
  assert.equal(closed.code, 0);
  assert.doesNotMatch(closed.diagnostic, /TimeoutOverflowWarning/);
});

test('Codex: explicit unmappable options fail before starting the backend', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t); f.request.args = ['--profile', 'custom-profile'];
  const run = f.start(); run.send(f.request); const result = await run.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false); assert.equal(result.code, 'parameterUnavailable');
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false); await run.exit;
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('Codex: initialization failure has no false communication capability', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'initialization failure'); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false); assert.equal((await run.exit).code, 0);
});


test('Codex: more than 64 parent messages retain each delivery without replay', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'many inputs'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  for (let index = 0; index < 80; index++) run.send({ type: 'message', id: index.toString(16).padStart(32, '0'), text: 'Repeated input 重复正文.' });
  await run.waitFor('delivery', 80);
  assert.equal((await run.waitFor('result')).state, 'completed'); await run.exit;
  assert.equal(run.frames.filter((frame) => frame.type === 'delivery' && frame.status === 'submitted').length, 80);
  const values = await f.captured(); assert.equal(values.filter((value) => value.input?.method === 'turn/steer').length, 80);
});

test('Codex: installed child tools emit one parent message before automatic input', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'child tool'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  assert.equal((await run.waitFor('message')).text, 'Child question 父消息?');
  run.send({ type: 'message', id: 'd'.repeat(32), text: 'Continue with the accepted scope.' });
  assert.equal((await run.waitFor('delivery')).status, 'submitted');
  assert.equal((await run.waitFor('result')).state, 'completed'); await run.exit;
  assert.equal(run.frames.filter((frame) => frame.type === 'message').length, 1);
  const values = await f.captured(); assert.match(values.find((value) => value.toolOutput).toolOutput, /send_parent: submitted/);
});

test('Codex: approval requests cannot be silently granted', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'approval'); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'unknown'); assert.equal(result.code, 'backendApprovalRequired'); await run.exit;
  const values = await f.captured(); const response = values.find((value) => value.input?.id === 'approval-request')?.input;
  assert.ok(response?.error); assert.equal(Object.hasOwn(response, 'result'), false);
});


// Protect pre-submission refusal of known incompatible native selection. The
// installed wire path additionally proves no backend exit or ready is invented.
test('Oracle: Windows file selection fails before starting the backend', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.doesNotThrow(() => assertOracleFileSelectionSupported([], platform));
    if (platform === 'win32') assert.throws(() => assertOracleFileSelectionSupported(['main.ts'], platform), { code: 'fileSelectionUnsupported' });
    else assert.doesNotThrow(() => assertOracleFileSelectionSupported(['main.ts', 'main.ts'], platform));
  }
  if (!windows) return;
  const f = await fixture(t, 'oracle');
  f.request.fileSelectors = ['main.ts'];
  const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result');
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'fileSelectionUnsupported');
  assert.equal(result.generationStarted, false);
  assert.equal(result.backendExitCode, null);
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false);
  assert.equal((await run.exit).code, 0);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

for (const scenario of ['no terminal', 'nonzero']) test(`Oracle: ${scenario} cannot replace the final-file and process evidence`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'oracle', scenario); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'unknown');
  if (scenario === 'nonzero') assert.equal(result.backendExitCode, 7);
  assert.equal((await run.exit).code, 0);
});

for (const stop of ['requested', 'eof', 'deadline']) test(`Oracle: unsupported communication still responds to ${stop}`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'oracle', 'hold'); if (stop === 'deadline') f.request.run.deadlineAt = Date.now() + explicitDeadlineMs;
  const run = f.start(); run.send(f.request); assert.equal((await run.waitFor('ready')).communicationSupported, false);
  if (stop === 'requested') run.send({ type: 'stop', reason: 'requested' });
  if (stop === 'eof') run.child.stdin.end();
  const result = await run.waitFor('result'); assert.notEqual(result.state, 'completed');
  assert.equal(result.code, stop === 'deadline' ? 'adapterDeadlineExceeded' : stop === 'eof' ? 'channelClosed' : 'remoteStopUnconfirmed');
  assert.equal((await run.exit).code, 0);
});

test('A connection without start cannot succeed or launch a backend', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t); const run = f.start(); run.child.stdin.end();
  const result = await run.exit; assert.equal(result.code, 1); assert.deepEqual(result.frames, []); assert.match(result.diagnostic, /protocolInvalid/);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('Oracle: parent messages after ready(false) cause a protocol failure', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'oracle', 'hold'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  run.send({ type: 'message', id: 'e'.repeat(32), text: 'This channel does not accept input.' });
  const result = await run.waitFor('result'); assert.notEqual(result.state, 'completed'); assert.equal(result.code, 'protocolInvalid');
  assert.equal(run.frames.some((frame) => frame.type === 'delivery'), false); assert.equal((await run.exit).code, 0);
});
