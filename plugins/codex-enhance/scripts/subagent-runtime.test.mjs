import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCommand, executeCommand } from '../skills/codex-subagent-guide/scripts/subagent.mjs';
import { selectExecution } from '../skills/codex-subagent-guide/scripts/runtime/plan.mjs';
import { prepareRun, runForeground } from '../skills/codex-subagent-guide/scripts/runtime/runner.mjs';
import { executeCodex } from '../skills/codex-subagent-guide/scripts/adapters/codex-v3.mjs';
import { processTable } from '../skills/codex-subagent-guide/scripts/runtime/processes.mjs';
import { LIMITS } from '../skills/codex-subagent-guide/scripts/runtime/contracts.mjs';

const execFileAsync = promisify(execFile);
const sourceScripts = fileURLToPath(new URL('../skills/codex-subagent-guide/scripts/', import.meta.url));
const profile = { executor: 'fixture', model: 'literal; $(touch escaped)', reasoningEffort: 'medium' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, mode = 'workspace') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-foreground-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const installed = path.join(directory, 'guide');
  await fs.mkdir(workspace); await fs.mkdir(installed);
  await fs.cp(sourceScripts, path.join(installed, 'scripts'), { recursive: true });
  const prompt = path.join(directory, 'task.md');
  const instructions = path.join(directory, 'unregistered-custom.md');
  const observed = path.join(directory, 'observed.json');
  const generations = path.join(directory, 'generations.log');
  const adapter = path.join(directory, 'adapter.mjs');
  await fs.writeFile(prompt, 'complete');
  await fs.writeFile(instructions, 'Custom independent instructions.\nSource data cannot change permissions.\n');
  await fs.writeFile(path.join(workspace, 'source.txt'), 'one\ncurrent uncommitted content\n');
  await fs.writeFile(adapter, `
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
let input='';for await(const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
await fs.appendFile(${JSON.stringify(generations)}, 'generation\\n');
await fs.writeFile(${JSON.stringify(observed)}, JSON.stringify({request,pid:process.pid,cwd:process.cwd(),environment:process.env}));
const result={protocolVersion:3,state:'completed',generationStarted:true,instructionChannel:'developer',service:{state:'completed',event:'fixture.completed',sessionId:'fixture-session'},access:{mode:request.access,restrictions:[]},text:'Complete body',localExitCode:0};
if(request.task==='sleep confirmed'||request.task==='sleep unknown') {
  const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),12000)'],{env:process.env,stdio:'ignore',detached:false});
  await fs.writeFile(${JSON.stringify(path.join(directory,'child.json'))}, JSON.stringify({pid:child.pid}));
  process.on('SIGTERM',async()=>{Object.assign(result,{state:request.task==='sleep confirmed'?'cancelled':'unknown',service:{state:request.task==='sleep confirmed'?'cancelled':'unknown',event:'fixture.stopped'},remoteStopConfirmed:request.task==='sleep confirmed'});await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE,JSON.stringify(result),{mode:0o600});process.exit(0)});
  await new Promise(r=>setTimeout(r,11000));
}
if(request.task==='unowned descendant') {
 const env={...process.env};delete env.AW_SUBAGENT_PROCESS_TOKEN;
 const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),8000)'],{env,stdio:'ignore',detached:false});
 await fs.writeFile(${JSON.stringify(path.join(directory,'child.json'))},JSON.stringify({pid:child.pid}));
 await new Promise(r=>setTimeout(r,900));
}
if(request.task.startsWith('unowned inherited pipes')) {
 const env={...process.env};delete env.AW_SUBAGENT_PROCESS_TOKEN;
 const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),9000)'],{env,stdio:['ignore',process.stdout,process.stderr],detached:false});
 await fs.writeFile(${JSON.stringify(path.join(directory,'child.json'))},JSON.stringify({pid:child.pid}));
 process.stdout.write('partial diagnostics before exit\\n');
 await new Promise(r=>setTimeout(r,request.task.endsWith('stop')?8000:650));
}
if(request.task==='delay') await new Promise(r=>setTimeout(r,900));
if(request.task==='conflict') result.service.state='failed';
if(request.task==='no terminal') delete result.service.event;
if(request.task==='user prefix') result.instructionChannel='user';
if(request.task==='short secret') {result.text='secret=3';result.access.restrictions=['secret=3'];process.stderr.write('secret=3')}
if(request.task==='nonstring terminal') result.service.event=3;
if(request.task==='fail') Object.assign(result,{state:'failed',service:{state:'failed',event:'fixture.failed'},localExitCode:1,text:'partial'});
if(request.task==='plain text') {process.stdout.write('Success ordinary text');process.exit(0)}
await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE,JSON.stringify(result),{mode:0o600});
process.exit(request.task==='exit conflict'?1:0);
`);
  const snapshot = { installedIdentity: { source: 'fixture', plugin: 'unrelated-name', platform: 'codex', scope: 'user' }, resourceRoot: installed,
    effectiveValues: { advisorProfile: { ...profile }, subagentCommands: [{ key: 'fixture', title: 'Fixture', mode, command: await fs.realpath(process.execPath), entrypoint: adapter, supportsSystemInstructions: true, supportsReadOnly: true, supportsWorkspaceWrite: false }] } };
  const config = path.join(installed, 'effective.json');
  await fs.writeFile(config, JSON.stringify(snapshot));
  await fs.writeFile(path.join(installed, 'scripts', 'aw-runtime-config.mjs'), `import fs from 'node:fs/promises';export async function readRuntimeConfig(){return JSON.parse(await fs.readFile(new URL('../effective.json',import.meta.url),'utf8'))}`);
  const entry = path.join(installed, 'scripts', 'subagent.mjs');
  const request = { operation: 'run', profile: 'advisorProfile', instructionsFile: instructions, promptFile: prompt, workspace, files: ['source.txt'] };
  const args = ['run','--profile','advisorProfile','--instructions-file',instructions,'--prompt-file',prompt,'--file','source.txt'];
  return { directory, workspace, prompt, instructions, observed, generations, snapshot, config, entry, request, args,
    prepared: async () => prepareRun(selectExecution(snapshot, request), request),
    cli: (extra = [], environment = {}) => execFileAsync(process.execPath, [entry, ...args, ...extra], { cwd: workspace, env: { ...process.env, ...environment }, maxBuffer: 16777216 }) };
}
async function waitFile(file) { for(let i=0;i<100;i++){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{await sleep(20)}}throw new Error('fixture file missing'); }

// Test Value Gate: actual entry and child protect instruction/data separation, installed selection,
// minimal environment, bundle scope, and optional preview without a real service or model call.
test('actual CLI runs an unregistered custom instruction file through the v3 independent field', async (t) => {
  const f = await fixture(t);
  const result = JSON.parse((await f.cli([], { AW_PLUGIN_CONTEXT:'private-context', AWS_SECRET_ACCESS_KEY:'private-secret' })).stdout);
  assert.equal(result.state,'completed'); assert.equal(result.text,'Complete body'); assert.equal(result.localTreeStopped,true);
  const observed = JSON.parse(await fs.readFile(f.observed,'utf8'));
  assert.equal(observed.request.protocolVersion,3);
  assert.equal(observed.request.instructions,await fs.readFile(f.instructions,'utf8'));
  assert.equal(observed.request.task,'complete');
  assert.equal(observed.request.materials[0].content,'one\ncurrent uncommitted content\n');
  assert.equal(observed.request.materials[0].originalPath,path.join(f.workspace,'source.txt'));
  assert.equal(observed.request.materials[0].startLine,1); assert.equal(observed.request.materials[0].endLine,2);
  assert.equal(observed.request.execution.model,profile.model);
  assert.equal(observed.request.access,'read-only'); assert.equal(observed.cwd,f.workspace);
  assert.equal(observed.environment.AW_PLUGIN_CONTEXT,undefined); assert.equal(observed.environment.AWS_SECRET_ACCESS_KEY,undefined);
  assert.equal(await fs.stat(observed.environment.AW_SUBAGENT_TEMP_DIR).catch(()=>undefined),undefined);
  assert.equal(await fs.stat(path.join(f.workspace,'escaped')).catch(()=>undefined),undefined);
  const linked=path.join(f.directory,'instruction-link');await fs.symlink(f.instructions,linked);
  const readable=await prepareRun(selectExecution(f.snapshot,f.request),{...f.request,instructionsFile:linked});
  assert.equal(readable.request.instructions,observed.request.instructions);
});

test('preview is optional, zero-generation, and bundle supplies only explicit copies', async (t) => {
  const f = await fixture(t,'bundle');
  const preview = JSON.parse((await f.cli(['--preview'])).stdout);
  assert.equal(preview.generationStarted,false); assert.equal(preview.materials.length,1);
  assert.equal(await fs.stat(f.generations).catch(()=>undefined),undefined);
  const result = JSON.parse((await f.cli()).stdout);
  assert.equal(result.state,'completed');
  const observed=JSON.parse(await fs.readFile(f.observed,'utf8'));
  assert.equal(observed.request.workspace,null); assert.notEqual(observed.cwd,f.workspace);
  assert.equal(observed.request.materials.length,1);
  assert.equal(await fs.readFile(f.generations,'utf8'),'generation\n');
  f.request.files=[];
  const empty=await f.prepared(); assert.deepEqual(empty.request.materials,[]);
});

// Test Value Gate: rejection paths must not launch the fixture generation process.
test('old commands, old flags, native, unconfigured profile and unsupported capabilities fail before generation', async (t) => {
  const f=await fixture(t);
  for(const operation of ['resolve','status','collect','cancel','resume']) assert.throws(()=>parseCommand([operation]),{code:'operationUnsupported'});
  for(const flag of ['worker','expected-revision','require-isolation','allow-model-cost','allow-material-transfer','runs-dir','command']) {
    await assert.rejects(execFileAsync(process.execPath,[f.entry,...f.args,`--${flag}`,'old'],{cwd:f.workspace}), (e)=>{assert.equal(JSON.parse(e.stderr).code,'argumentsInvalid');return true});
  }
  for(const [change,code] of [
    [(s)=>{s.effectiveValues.advisorProfile={model:'m',reasoningEffort:'high'}},'nativeUnsupported'],
    [(s)=>{delete s.effectiveValues.advisorProfile},'profileUnconfigured'],
    [(s)=>{s.effectiveValues.advisorProfile={executor:'missing',model:'m',reasoningEffort:'high'}},'executorUnknown'],
    [(s)=>{s.effectiveValues.subagentCommands[0].supportsSystemInstructions=false},'instructionChannelUnsupported'],
  ]) {
    const snapshot=structuredClone(f.snapshot); change(snapshot); await fs.writeFile(f.config,JSON.stringify(snapshot));
    await assert.rejects(f.cli(),(e)=>{assert.equal(JSON.parse(e.stderr).code,code);return true});
  }
  assert.equal(await fs.stat(f.generations).catch(()=>undefined),undefined);
  assert.throws(()=>parseCommand(['run','--profile','advisorProfile','--prompt-file',f.prompt]),{code:'argumentsRequired'});
  assert.throws(()=>selectExecution(f.snapshot,{...f.request,access:'workspace-write'}),{code:'accessUnsupported'});
  assert.throws(()=>selectExecution(f.snapshot,{...f.request,profile:'advisorDesignProfile'}),{code:'profileUnconfigured'});
});

test('materials reject traversal, symlinks, credentials, binary, duplication, and size limits without launching', async (t)=>{
  const f=await fixture(t,'bundle');
  await fs.symlink(path.join(f.workspace,'source.txt'),path.join(f.workspace,'link'));
  await fs.writeFile(path.join(f.workspace,'.env'),'SECRET=fixture');
  await fs.writeFile(path.join(f.workspace,'binary'),Buffer.from([0,1]));
  await fs.writeFile(path.join(f.workspace,'large'),'x'.repeat(LIMITS.fileBytes+1));
  await fs.writeFile(path.join(f.workspace,'key.txt'),'-----BEGIN PRIVATE KEY-----');
  for(const [files,code] of [[['../source.txt'],'materialPathInvalid'],[['link'],'pathSymlink'],[['.env'],'materialSecretExcluded'],[['binary'],'binaryUnsupported'],[['large'],'materialFileTooLarge'],[['key.txt'],'materialSecretDetected'],[['source.txt','source.txt'],'materialDuplicate']]) {
    await assert.rejects(prepareRun(selectExecution(f.snapshot,f.request),{...f.request,files}),{code});
  }
  assert.equal(await fs.stat(f.generations).catch(()=>undefined),undefined);
});

// Test Value Gate: active input copies and original child protect against duplicate generation
// and configuration/file changes replacing an already submitted invocation.
test('one reader call and same foreground child keep captured input after source/config changes', async (t)=>{
  const f=await fixture(t,'bundle'); await fs.writeFile(f.prompt,'delay');
  let reads=0;
  const running=executeCommand(f.request,{readRuntimeConfig:async()=>{reads++;return structuredClone(f.snapshot)},temporaryRoot:f.directory});
  await waitFile(f.observed);
  await fs.writeFile(f.instructions,'changed instructions'); await fs.writeFile(f.prompt,'changed task'); await fs.writeFile(path.join(f.workspace,'source.txt'),'changed source');
  f.snapshot.effectiveValues.advisorProfile.executor='native'; await fs.writeFile(f.config,JSON.stringify(f.snapshot));
  const result=(await running).json;
  assert.equal(reads,1); assert.equal(result.state,'completed');
  const observed=JSON.parse(await fs.readFile(f.observed,'utf8'));
  assert.equal(observed.request.task,'delay'); assert.match(observed.request.instructions,/Custom independent/);
  assert.equal(observed.request.materials[0].content,'one\ncurrent uncommitted content\n');
  assert.equal(await fs.readFile(f.generations,'utf8'),'generation\n');
});

// Test Value Gate: an execution-tool wait that yields must keep the original foreground
// process handle. Repeated waits on its completion promise must cause one generation only.
test('host wait can yield and continue the same CLI process with one generation', async (t)=>{
  const f=await fixture(t);await fs.writeFile(f.prompt,'delay');
  const child=spawn(process.execPath,[f.entry,...f.args],{cwd:f.workspace,stdio:['ignore','pipe','pipe']});
  let output='';let diagnostics='';child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{diagnostics+=b});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code))});
  const observed=await waitFile(f.observed);
  const yielded=Symbol('still running');
  assert.equal(await Promise.race([done,sleep(100).then(()=>yielded)]),yielded);
  assert.doesNotThrow(()=>process.kill(observed.pid,0));
  assert.equal(await fs.readFile(f.generations,'utf8'),'generation\n');
  assert.equal(await done,0,diagnostics);
  assert.equal(JSON.parse(output).state,'completed');
  assert.equal(await fs.readFile(f.generations,'utf8'),'generation\n');
});

// Test Value Gate: only compatible service terminal, independent channel and process evidence
// establish completion; ordinary output, conflicts and missing terminal remain unknown.
test('foreground outcomes preserve partial results and reject false completion evidence',async(t)=>{
  const f=await fixture(t);
  for(const [task,state] of [['complete','completed'],['fail','failed'],['plain text','unknown'],['no terminal','unknown'],['conflict','unknown'],['exit conflict','unknown'],['user prefix','unknown'],['nonstring terminal','unknown']]) {
    await fs.writeFile(f.prompt,task);
    const result=await runForeground(await f.prepared(),{temporaryRoot:f.directory});
    assert.equal(result.state,state,task);
    if(task==='fail') assert.equal(result.text,'partial');
    if(task==='user prefix') assert.equal(result.code,'instructionChannelUnsupported');
  }
});

// Test Value Gate: redaction must remove even short credentials without corrupting JSON
// numbers or the program outcome, and must cover both returned restriction fields.
test('short credential redaction preserves structured result and access restrictions',async(t)=>{
  const f=await fixture(t);await fs.writeFile(f.prompt,'short secret');
  const result=await runForeground(await f.prepared(),{temporaryRoot:f.directory,environment:{PATH:process.env.PATH,OPENAI_API_KEY:'3'}});
  assert.equal(result.protocolVersion,3);assert.equal(result.state,'completed');
  assert.equal(result.text,'secret=[redacted]');assert.equal(result.diagnostics,'secret=[redacted]');
  assert.deepEqual(result.access.restrictions,['secret=[redacted]']);
  assert.ok(result.restrictions.includes('secret=[redacted]'));
});

// Test Value Gate: local descendant cleanup does not prove a remote stop; cancellation only
// becomes cancelled when the original adapter provides applicable stop evidence.
test('stop controls owned descendants and keeps unconfirmed remote stop unknown',async(t)=>{
  for(const [task,state] of [['sleep confirmed','cancelled'],['sleep unknown','unknown']]) await t.test(state,async(t)=>{
    const f=await fixture(t); await fs.writeFile(f.prompt,task);
    const controller=new AbortController();
    const running=runForeground(await f.prepared(),{temporaryRoot:f.directory,signal:controller.signal});
    const {pid}=await waitFile(path.join(f.directory,'child.json'));
    await sleep(350); controller.abort();
    const result=await running;
    assert.equal(result.state,state); assert.equal(result.localTreeStopped,true); assert.equal(result.stopRequested,true);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  });
});

// Test Value Gate: related processes with a removed ownership marker remain outside stop
// permission, and their continued execution prevents a false completed/local-stopped result.
test('unmarked related descendant is not killed and leaves cleanup unconfirmed',async(t)=>{
  const f=await fixture(t);await fs.writeFile(f.prompt,'unowned descendant');
  const running=runForeground(await f.prepared(),{temporaryRoot:f.directory});
  const {pid}=await waitFile(path.join(f.directory,'child.json'));
  const original=(await processTable()).find(row=>row.pid===pid);assert.ok(original);
  t.after(async()=>{const current=(await processTable()).find(row=>row.pid===pid);if(current?.started===original.started){process.kill(pid,'SIGTERM');await sleep(100)}});
  const result=await running;
  assert.equal(result.state,'unknown');assert.equal(result.code,'localTreeStopUnconfirmed');assert.equal(result.localTreeStopped,false);
  assert.doesNotThrow(()=>process.kill(pid,0));assert.ok(result.temporaryDirectory);
});

// Test Value Gate: inherited output pipes must not bind foreground completion to an
// unmarked descendant's lifetime after the direct adapter exits or a stop attempt ends.
test('inherited pipes from an unmarked descendant return unknown before that descendant exits',async(t)=>{
  for(const task of ['unowned inherited pipes','unowned inherited pipes stop']) await t.test(task,async(t)=>{
    const f=await fixture(t);await fs.writeFile(f.prompt,task);
    const controller=new AbortController();
    const started=Date.now();
    const running=runForeground(await f.prepared(),{temporaryRoot:f.directory,signal:controller.signal,deadlineMs:1200});
    const {pid}=await waitFile(path.join(f.directory,'child.json'));
    const original=(await processTable()).find(row=>row.pid===pid);assert.ok(original);
    t.after(async()=>{const current=(await processTable()).find(row=>row.pid===pid);if(current?.started===original.started){process.kill(pid,'SIGTERM');await sleep(100)}});
    if(task.endsWith('stop')) {await sleep(300);controller.abort()}
    const result=await running;
    const elapsedMs=Date.now()-started;
    assert.ok(elapsedMs<5000,`runner waited ${elapsedMs} ms for a descendant with a 9000 ms lifetime`);
    assert.equal(result.state,'unknown');assert.equal(result.localTreeStopped,false);
    assert.match(result.diagnostics,/partial diagnostics before exit/);
    assert.doesNotThrow(()=>process.kill(pid,0));
    assert.ok(result.temporaryDirectory);await fs.stat(result.temporaryDirectory);
    if(task.endsWith('stop')) assert.equal(result.stopRequested,true);
    else {assert.equal(result.text,'Complete body');assert.equal(result.stopRequested,undefined);assert.equal(result.adapterExitCode,0)}
  });
});

// Test Value Gate: exercise the production adapter against a fake CLI with actual Codex event
// shapes. This proves local mapping and argv boundaries, not real model/service support.
test('Codex v3 maps independent developer argv, read-only bundle and actual event shapes',async(t)=>{
  const f=await fixture(t,'bundle');
  const fake=path.join(f.directory,'fake-codex');
  const backendObserved=path.join(f.directory,'backend.json'); const calls=path.join(f.directory,'backend-calls.log');
  await fs.writeFile(fake,`#!${await fs.realpath(process.execPath)}
import fs from 'node:fs/promises';
await fs.appendFile(${JSON.stringify(calls)},'call\\n');
if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.160.1\\n');process.exit(0)}
let input='';for await(const c of process.stdin)input+=c;
const task=JSON.parse(input);const args=process.argv.slice(2);const output=args[args.indexOf('--output-last-message')+1];
await fs.writeFile(${JSON.stringify(backendObserved)},JSON.stringify({args,task,environment:process.env,cwd:process.cwd()}));
await fs.writeFile(output,'Complete body fake-key-value');
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fake-session'})+'\\n');
if(task.task==='scope')process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'cat /original'}})+'\\n');
if(task.task==='unavailable')process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'The requested model is unavailable.'}})+'\\n');
else if(task.task!=='no terminal')process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:4}})+'\\n');
if(task.task==='conflict')process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'conflict'}})+'\\n');
`,{mode:0o700});
  const home=path.join(f.directory,'codex-home');await fs.mkdir(home); await fs.writeFile(path.join(home,'config.toml'),'model="fixture"\n');
  const environment={PATH:process.env.PATH,HOME:f.directory,CODEX_HOME:home,OPENAI_API_KEY:'fake-key-value',AW_SUBAGENT_CODEX_BINARY:fake,AW_AGENT_SKILL_EVAL_PROCESS_MARKER:'fixture-eval-owner',AW_PLUGIN_CONTEXT:'must-not-leave',AWS_SECRET_ACCESS_KEY:'must-not-leave'};
  const prepared=await f.prepared();
  const attempt=async(task,mode='bundle')=>{
    const directory=await fs.mkdtemp(path.join(f.directory,'codex-'));await fs.chmod(directory,0o700);
    const request={...prepared.request,task,mode,workspace:mode==='bundle'?null:f.workspace};
    const result=await executeCodex(request,{...environment,AW_SUBAGENT_TEMP_DIR:directory,AW_SUBAGENT_RESULT_FILE:path.join(directory,'result.json')});
    return {result,directory};
  };
  const {result,directory}=await attempt('complete');
  assert.equal(result.state,'completed'); assert.equal(result.service.event,'turn.completed'); assert.equal(result.service.sessionId,'fake-session'); assert.equal(result.service.model,undefined);
  assert.equal(result.text,'Complete body [redacted]');
  const observed=JSON.parse(await fs.readFile(backendObserved,'utf8'));
  assert.ok(observed.args.includes(`developer_instructions=${JSON.stringify(prepared.request.instructions)}`));
  assert.equal(observed.args[observed.args.indexOf('-m')+1],profile.model); assert.ok(observed.args.includes(`model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`));
  assert.ok(observed.args.includes('read-only')); assert.ok(observed.args.includes('features.shell_tool=false'));
  assert.equal(observed.task.task,'complete'); assert.equal(observed.task.instructions,undefined);
  assert.equal(observed.task.materials[0].content,prepared.request.materials[0].content); assert.equal(observed.cwd,directory);
  assert.equal(observed.environment.AWS_SECRET_ACCESS_KEY,undefined); assert.equal(observed.environment.AW_PLUGIN_CONTEXT,undefined);
  assert.equal(observed.environment.AW_AGENT_SKILL_EVAL_PROCESS_MARKER,'fixture-eval-owner');
  assert.equal((await fs.stat(path.join(directory,'result.json'))).mode&0o077,0);
  assert.equal((await attempt('no terminal')).result.state,'unknown'); assert.equal((await attempt('conflict')).result.state,'unknown'); assert.equal((await attempt('scope')).result.state,'unknown');
  const unavailable=(await attempt('unavailable')).result;assert.equal(unavailable.state,'failed');assert.equal(unavailable.code,'parameterUnavailable');
  const ws=await attempt('complete','workspace');assert.equal(ws.result.state,'completed');
  assert.equal(JSON.parse(await fs.readFile(backendObserved,'utf8')).cwd,f.workspace);
  const before=await fs.readFile(calls,'utf8');
  for(const config of ['[mcp_servers.external]\ncommand="never"\n','"\\u006dcp_servers".external.command="never"\n']){
    await fs.writeFile(path.join(home,'config.toml'),config);
    const failed=(await attempt('complete')).result;assert.equal(failed.state,'failed');assert.equal(failed.generationStarted,false);
  }
  assert.equal(await fs.readFile(calls,'utf8'),before);
  await assert.rejects(executeCodex({...prepared.request,protocolVersion:2},environment),{code:'protocolInvalid'});
  await assert.rejects(executeCodex({...prepared.request,access:'workspace-write'},environment),{code:'adapterAccessUnsupported'});
});
