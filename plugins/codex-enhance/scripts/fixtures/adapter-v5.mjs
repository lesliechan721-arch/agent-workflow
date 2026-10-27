import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { protectPrivatePath } from '../../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { guideRuntimeScripts } from './guide-runtime-resources.mjs';

const require = createRequire(import.meta.url);
const registeredEntries = {
  codex: require.resolve('../../skills/codex-subagent-guide/scripts/adapters/codex-v5.mjs'),
  claude: require.resolve('../../skills/codex-subagent-guide/scripts/adapters/claude-code-v5.mjs'),
  oracle: require.resolve('../../skills/codex-subagent-guide/scripts/adapters/oracle-v5.mjs'),
  message: require.resolve('../../skills/codex-subagent-guide/scripts/message.mjs'),
  mcp: require.resolve('../../skills/codex-subagent-guide/scripts/message-mcp.mjs'),
};
const scripts = guideRuntimeScripts(new URL('../', import.meta.url));
const registeredScripts = path.dirname(registeredEntries.message);
const sourceEntries = Object.fromEntries(Object.entries(registeredEntries)
  .map(([key, entry]) => [key, path.join(scripts, path.relative(registeredScripts, entry))]));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const supported = ['darwin', 'linux', 'win32'].includes(process.platform);
const testTimeoutMs = windows ? 120000 : 15000;
const answer = 'Complete **answer**.\n第二行。';

async function readCapturedSoFar(capture) {
  let contents;
  try { contents = await fs.readFile(capture, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // appendFile can be observed before its last JSONL record is complete.
  // Only newline-terminated records are ready for parsing.
  const lines = contents.split('\n');
  lines.pop();
  return lines.map((line) => JSON.parse(line));
}

async function waitForCaptured(capture, predicate) {
  const deadline = Date.now() + (windows ? 90000 : 6000);
  while (Date.now() < deadline) {
    const values = await readCapturedSoFar(capture);
    if (values.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The backend did not receive its initial input.');
}

// Test Value Gate: real adapter and backend processes protect actual JSONL,
// input acceptance, configuration, exit evidence, cancellation and install closure.
async function fixture(t, backend = 'codex', scenario = 'success') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-v5-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const installed = path.join(directory, 'installed', 'scripts');
  await fs.cp(scripts, installed, { recursive: true });
  await fs.cp(path.join(scripts, '../assets'), path.join(installed, '../assets'), { recursive: true });
  const installedEntry = (source) => path.join(installed, path.relative(scripts, source));
  if (process.env.AW_PLUGIN_EVENT !== 'test') for (const relative of ['file-selection/selection.mjs', 'adapters/codex-profile.mjs']) {
    const selection = path.join(installed, relative);
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
if(backend==='codex' && args.length===1 && args[0]==='--version'){process.stdout.write('codex-cli 0.153.0\\n');process.exit(0);}
const answer = ${JSON.stringify(answer)};
const capture = async (value) => fs.appendFile(process.env.FIXTURE_CAPTURE, JSON.stringify(value)+'\\n');
await capture({args,cwd:process.cwd(),communicationDirectory:await fs.stat(path.join(process.env.FIXTURE_RUNTIME,'communication')).then(()=>true,()=>false),environment:{HOME:process.env.HOME,NORMAL_SETTING:process.env.NORMAL_SETTING,OPENAI_API_KEY:process.env.OPENAI_API_KEY,marker:process.env.AW_SUBAGENT_PROCESS_TOKEN}});
setTimeout(()=>process.exit(9),${windows ? 90000 : 12000}).unref();
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
if (backend === 'oracle') {
 if(scenario==='hold')process.on('SIGINT',async()=>{await capture({signal:'SIGINT'});process.exit(0);});
 let input=''; for await(const chunk of process.stdin) input+=chunk;
 await capture({input});
 if(scenario==='hold') await new Promise(resolve=>setTimeout(resolve,${windows ? 75000 : 8000}));
 if(scenario!=='no terminal') await fs.writeFile(args[args.indexOf('--write-output')+1],answer);
 process.stdout.write('Request accepted.\\n');
 process.exit(scenario==='nonzero'?7:0);
}
let count=0, timer, active, steeringCount=0, releaseTool, communicationServer;
const toolCompleted=new Promise(resolve=>{releaseTool=resolve;});
const finish=async()=> {
 if(scenario==='no terminal'){process.exit(0);return;}
 // Complete the overflow write before publishing success. process.exit on EOF
 // can otherwise truncate this pipe and leave the test below its threshold.
 if(scenario==='diagnostic overflow')await new Promise(resolve=>process.stderr.write(Buffer.alloc(8388609,120),resolve));
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
   communicationServer = Object.entries(value.params.config?.mcp_servers ?? {}).find(([key]) => key.startsWith('aw_parent_'))?.[1];
   if(scenario==='initialization failure')emit({id:value.id,error:{code:-32602,message:'invalid explicit configuration'}});
   else respond({thread:{id:'thread-fixture'},model:'model-fixture'});
  } else if(value.method==='turn/start') {
   count++;active='turn-'+count;respond({turn:{id:active,status:'inProgress',items:[]}});
   emit({method:'turn/started',params:{threadId:'thread-fixture',turn:{id:active}}});
   if(scenario==='child tool'){
    const mcp=communicationServer.args;
    const child=spawn(process.execPath,[path.join(path.dirname(mcp[0]),'message.mjs'),...mcp.slice(1),'send','--text','Child question 父消息?'],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);
    const toolExitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    await capture({toolOutput:output,toolExitCode});releaseTool();return;
   }
   if(scenario==='approval'){emit({id:'approval-request',method:'item/commandExecution/requestApproval',params:{}});return;}
   if(scenario==='hold'||scenario==='many inputs'&&count===1||scenario==='parent input'&&count===1||scenario==='turn race'&&count===1||scenario==='lost response'&&count===1)return;
   queueMicrotask(finish);
  } else if(value.method==='turn/steer') {
   steeringCount++;
   if(scenario==='many inputs'&&steeringCount<80){respond({turnId:active});return;}
   if(scenario==='lost response'){process.exit(0);return;}
   if(scenario==='child tool'){
    respond({turnId:active});
    // A steer can be accepted while a tool is running. The turn cannot
    // complete until that tool has returned its actual result.
    await toolCompleted;finish();
   }else if(scenario==='turn race'){
    finish();emit({id:value.id,error:{code:-32602,message:'no active turn to steer'}});
   }else {respond({turnId:active});queueMicrotask(finish);}
  } else if(value.method==='turn/interrupt'){clearTimeout(timer);respond({});}
  else if(value.method==='thread/unsubscribe')respond({status:'unsubscribed'});
 }else{
  if(value.type==='user') {
   count++;
   emit({type:'system',subtype:'init',session_id:'session-fixture',model:'model-fixture'});
   emit({type:'user',uuid:value.uuid,message:value.message,session_id:'session-fixture'});
   emit({type:'assistant',message:{role:'assistant',content:[]}});
   if(scenario!=='hold'){
    if(scenario==='parent input'&&count===1)timer=setTimeout(finish,160);
    else queueMicrotask(finish);
   }
  }else if(value.type==='control_request'){clearTimeout(timer);emit({type:'control_response',request_id:value.request_id,response:{subtype:'success'}});}
 }
});
input.on('close',()=>{clearTimeout(timer);setImmediate(()=>process.exit(scenario==='nonzero'?7:0));});
`, { mode: 0o700 });
  const nativeEnvironment = windows ? process.env : {};
  const systemRoot = Object.entries(nativeEnvironment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  const nativePath = windows ? [systemRoot && path.join(systemRoot, 'System32'), systemRoot].filter(Boolean) : ['/usr/bin', '/bin'];
  const environment = {
    ...nativeEnvironment,
    PATH: [bin, path.dirname(process.execPath), ...nativePath].join(path.delimiter), HOME: home, LANG: 'C.UTF-8',
    ...(windows ? { USERPROFILE: home, TEMP: directory, TMP: directory } : {}),
    OPENAI_API_KEY: 'synthetic-test-key', NORMAL_SETTING: 'preserved setting', AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'),
    FIXTURE_CASE: scenario, FIXTURE_BACKEND: backend, FIXTURE_CAPTURE: capture, FIXTURE_RUNTIME: runtime,
  };
  const request = {
    protocolVersion: 5, type: 'start', communication: true, ...(backend === 'codex' ? { codex: { cliSource: 'auto', bypassHookTrust: false } } : {}), run: { id: randomBytes(16).toString('hex'), name: 'agent-fixture', deadlineAt: null },
    execution: { executor: 'fixture' }, mode: backend === 'oracle' ? 'bundle' : 'workspace',
    workspace, prompt: ' 原始任务\nQuotes: " ` $() \\n\n', args: [],
    runtime: { directory: runtime, toolkit: { command: process.execPath, module: path.join(installed, 'runtime/adapter-channel.mjs'), messageScript: installedEntry(sourceEntries.message), mcpScript: installedEntry(sourceEntries.mcp) } },
  };
  if (backend === 'oracle') Object.assign(request, { fileSelectors: [], fileResolver: { command: process.execPath, args: [path.join(installed, 'resolve-files.mjs')] } });
  const entry = installedEntry(sourceEntries[backend]);
  const start = () => {
    const child = spawn(process.execPath, [entry], { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: !windows });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const frames = [];
    const frameWaiters = new Set();
    let closed = false;
    let diagnostic = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { diagnostic += chunk; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { frames.push(JSON.parse(line)); for (const notify of frameWaiters) notify(); });
    const exit = new Promise((resolve) => child.once('close', (code) => {
      closed = true; for (const notify of frameWaiters) notify(); resolve({ code, frames, diagnostic });
    }));
    const send = (value) => child.stdin.write(`${JSON.stringify({ protocolVersion: 5, ...value })}\n`);
    const waitFor = (type, count = 1) => new Promise((resolve, reject) => {
      let timer;
      const finish = (error, frame) => {
        clearTimeout(timer); frameWaiters.delete(check);
        if (error) reject(error); else resolve(frame);
      };
      const missing = () => new Error(`Missing ${type}; frames=${JSON.stringify(frames)}; diagnostic=${diagnostic}`);
      const check = () => {
        const matching = frames.filter((frame) => frame.type === type);
        if (matching.length >= count) finish(null, matching.at(-1));
        else if (closed) finish(missing());
      };
      frameWaiters.add(check);
      timer = setTimeout(() => finish(missing()), windows ? 90000 : 6000);
      check();
    });
    return { child, send, waitFor, frames, exit };
  };
  const captured = async () => (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  return { request, start, captured, waitForCaptured: (predicate) => waitForCaptured(capture, predicate), capture, workspace, home };
}


export { fixture, windows, supported, testTimeoutMs, answer, scripts, sourceEntries, readCapturedSoFar, waitForCaptured };
