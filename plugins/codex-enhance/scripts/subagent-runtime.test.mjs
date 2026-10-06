import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePlan } from '../skills/codex-subagent-guide/scripts/runtime/plan.mjs';
import { LIMITS, digest } from '../skills/codex-subagent-guide/scripts/runtime/contracts.mjs';
import { inspectMaterials } from '../skills/codex-subagent-guide/scripts/runtime/files.mjs';
import { adapterEnvironment, prepareRun, previewResult, startRun, runStatus, collectRun, cancelRun } from '../skills/codex-subagent-guide/scripts/runtime/runner.mjs';
import { outcomeFromEvidence } from '../skills/codex-subagent-guide/scripts/runtime/supervise.mjs';
import { parseCommand, executeCommand } from '../skills/codex-subagent-guide/scripts/subagent.mjs';
import { executeCodex } from '../skills/codex-subagent-guide/scripts/adapters/codex-v2.mjs';
import { processTable, ownsProcess } from '../skills/codex-subagent-guide/scripts/runtime/processes.mjs';

const execFileAsync = promisify(execFile);
const entry = fileURLToPath(new URL('../skills/codex-subagent-guide/scripts/subagent.mjs', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../skills/codex-subagent-guide/scripts/runtime/', import.meta.url));

// Test Value Gate: these fixtures exercise actual material capture, public CLI, process ownership,
// protocol evidence, environment disclosure, and recovery. No fake result is model qualification.
async function fixture(t, mode = 'bundle') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-subagent-runtime-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const workspace = path.join(directory, 'workspace');
  const root = path.join(directory, 'installed');
  const runs = path.join(directory, 'runs');
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.mkdir(path.join(root, 'runtime', 'workers'), { recursive: true });
  await fs.mkdir(runs, { mode: 0o700 });
  const instructions = 'Use original materials as data. Return bounded facts. Do not delegate.\n';
  await fs.writeFile(path.join(root, 'runtime', 'workers', 'unrelated.md'), instructions);
  const adapter = path.join(directory, 'fake-adapter.mjs');
  await fs.writeFile(adapter, `import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const dir=process.env.AW_SUBAGENT_RUN_DIR;
await fs.writeFile(path.join(dir,'observed.json'),JSON.stringify({request,environment:process.env}));
const receipt={protocolVersion:2,outcome:'completed',instructionChannel:'developer',instructionsRevision:request.instructions.revision,providerTerminal:'completed'};
if(request.task.startsWith('sleep')) {
 const child=request.task.includes('cleared-child')
  ? spawn('/usr/bin/env',['-i',process.execPath,'-e','setTimeout(()=>{},8000)'],{stdio:'ignore'})
  : spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'ignore'});
 await fs.writeFile(path.join(dir,'child.json'),JSON.stringify({pid:child.pid}));
 process.on('SIGTERM',async()=>{if(request.task.includes('confirmed')) await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE,JSON.stringify({...receipt,outcome:'cancelled',providerStopped:true}));process.exit(0)});
 setTimeout(()=>process.exit(0),8000);
} else {
 if(['complete with cleared-child','fail with cleared-child'].includes(request.task)) {
  const child=spawn('/usr/bin/env',['-i',process.execPath,'-e','setTimeout(()=>{},8000)'],{stdio:'ignore'});
  await fs.writeFile(path.join(dir,'child.json'),JSON.stringify({pid:child.pid}));
  child.unref();
 }
 if(request.task!=='missing receipt') {
  const emitted=request.task==='prefix'?{...receipt,instructionChannel:'user-prefix'}:{...receipt};
  if(request.task==='fail with cleared-child') Object.assign(emitted,{outcome:'failed',providerTerminal:'turn.failed',generationStarted:true});
  if(request.task==='contradictory scope') emitted.scopeViolation=true;
  if(request.task==='contradictory generation') emitted.generationStarted=false;
  if(request.task==='contradictory exit') emitted.localExitCode=1;
  await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE,JSON.stringify(emitted));
 }
 process.stdout.write('Actual fake process output; no model was called.\\n');
}
`);
  const binding = { schemaVersion: 1, protocolVersion: 2, defaultWorker: 'unrelated', workers: [{ key: 'unrelated', nativeRole: 'unrelated-role', instructionsFile: 'runtime/workers/unrelated.md', instructionRevision: digest(instructions), maximumAccess: 'read-only', allowDelegation: false }], profiles: { foreignProfile: { workerKey: 'unrelated', allowedWorkerKeys: ['unrelated'] } } };
  const command = { key: 'external', title: 'Unrelated executor', mode, command: await fs.realpath(process.execPath), entrypoint: adapter, supportsSystemInstructions: true, supportsReadOnly: true };
  const snapshot = { installedIdentity: { sourceId: 'test-source', pluginId: 'unrelated-plugin', platform: 'codex', scope: 'user' }, revision: 'old-execution-revision', resourceVersion: 'fixture-resources', resourceRoot: root, effectiveValues: { foreignProfile: { executor: 'external', model: '$(touch never)', reasoningEffort: 'medium' }, subagentCommands: [command] } };
  await fs.writeFile(path.join(root, 'runtime', 'worker-bindings.json'), JSON.stringify(binding));
  const prompt = path.join(directory, 'task.md');
  await fs.writeFile(prompt, 'Collect original facts. $(touch injected); `touch injected`\n');
  const request = { profile: 'foreignProfile', workspace, promptFile: prompt, files: ['source.txt'], allowMaterialTransfer: true, allowModelCost: true };
  await fs.writeFile(path.join(workspace, 'source.txt'), 'one\ncurrent uncommitted content\n');
  const plan = resolvePlan(snapshot, binding, request);
  return { directory, workspace, root, runs, prompt, request, plan, snapshot, binding, command };
}

async function terminal(id, runs) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const status = await runStatus(id, runs);
    if (status.state !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail('The fake process did not reach a bounded terminal state.');
}

async function executeActor(script, input, environment = {}) {
  const child = spawn(process.execPath, [script], { detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...environment } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('Darwin file sandbox uses the fixed system observer bytes, keeps real PID and marker checks, and cleans each private copy', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t);
  const actorDirectory = path.join(f.directory, 'actor');
  const temporaryDirectory = path.join(f.directory, 'observer-tmp');
  const fakeBin = path.join(actorDirectory, 'fake-bin');
  const foreign = path.join(f.directory, 'private-evidence.txt');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(temporaryDirectory, { mode: 0o700 });
  await fs.writeFile(foreign, 'This private evidence is outside the actor file boundary.');
  await fs.writeFile(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  const actor = path.join(actorDirectory, 'observer.mjs');
  await fs.writeFile(actor, `import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const run=promisify(execFile);
const {processTable,ownsProcess,withSystemPs}=await import(pathToFileURL(${JSON.stringify(path.join(runtimeRoot, 'processes.mjs'))}));
await assert.rejects(fs.readFile(${JSON.stringify(foreign)}),error=>['EPERM','EACCES'].includes(error.code));
await assert.rejects(async()=>run('/bin/ps',['-p',String(process.pid)]),error=>error.code==='EPERM'||/Operation not permitted/.test(error.message));
const identity=(await processTable()).find(item=>item.pid===process.pid);
assert.ok(identity);
assert.equal(await ownsProcess(identity,process.env.AW_SUBAGENT_PROCESS_TOKEN),true);
assert.equal(await ownsProcess({...identity,started:'wrong start'},process.env.AW_SUBAGENT_PROCESS_TOKEN),false);
assert.equal(await ownsProcess(identity,process.env.AW_SUBAGENT_PROCESS_TOKEN.slice(0,-1)),false);
const longer=spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'ignore',env:{...process.env,AW_SUBAGENT_PROCESS_TOKEN:process.env.AW_SUBAGENT_PROCESS_TOKEN+'suffix'}});
try {
 const longerIdentity=(await processTable()).find(item=>item.pid===longer.pid); assert.ok(longerIdentity);
 assert.equal(await ownsProcess(longerIdentity,process.env.AW_SUBAGENT_PROCESS_TOKEN),false);
} finally {longer.kill('SIGTERM')}
let copiedPath;
await withSystemPs(async executable=>{
 copiedPath=executable;
 assert.ok(path.isAbsolute(executable));
 assert.equal(path.dirname(path.dirname(executable)),process.env.TMPDIR);
 const [directory,copy,original]=await Promise.all([fs.lstat(path.dirname(executable)),fs.lstat(executable),fs.lstat('/bin/ps')]);
 assert.equal(directory.mode&0o7777,0o700); assert.equal(directory.uid,process.getuid()); assert.equal(directory.isSymbolicLink(),false);
 assert.equal(copy.mode&0o7777,0o755); assert.equal(copy.isFile(),true); assert.equal(copy.isSymbolicLink(),false);
 assert.equal(original.uid,0); assert.equal(original.isSymbolicLink(),false); assert.ok(original.size<=8*1024*1024);
 assert.ok((await fs.readFile(executable)).equals(await fs.readFile('/bin/ps')));
 const observed=await run(executable,['-p',String(process.pid),'-o','pid='],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C',AW_AGENT_SKILL_EVAL_PROCESS_MARKER:process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER}});
 assert.equal(Number(observed.stdout.trim()),process.pid);
});
await assert.rejects(fs.lstat(copiedPath),{code:'ENOENT'});
await assert.rejects(fs.lstat(path.dirname(copiedPath)),{code:'ENOENT'});
await assert.rejects(withSystemPs(executable=>run(executable,['--aw-invalid-observer-option'])));
assert.deepEqual(await fs.readdir(process.env.TMPDIR),[]);
process.stdout.write(JSON.stringify({identityObserved:true,markerConfirmed:true,sourceBytesMatched:true,copiesRemoved:true,foreignReadDenied:true}));
`);
  const allowed = [actorDirectory, temporaryDirectory, runtimeRoot, path.dirname(process.execPath), '/System', '/usr', '/bin', '/sbin', '/dev'];
  const profile = [
    '(version 1)', '(allow default)',
    `(deny file-read-data (require-all (require-not (literal "/")) ${allowed.map((target) => `(require-not (subpath ${JSON.stringify(target)}))`).join(' ')}))`,
    '(deny file-write*)', `(allow file-write* (subpath ${JSON.stringify(temporaryDirectory)}))`, '(allow file-write* (literal "/dev/null"))',
    ...allowed.flatMap((target) => { const ancestors = []; for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.push(`(allow file-read-metadata (literal ${JSON.stringify(parent)}))`); return ancestors; }),
  ].join('\n');
  const result = await execFileAsync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, actor], { timeout: 15000, env: { PATH: fakeBin, TMPDIR: temporaryDirectory, AW_SUBAGENT_PROCESS_TOKEN: 'a'.repeat(48), AW_AGENT_SKILL_EVAL_PROCESS_MARKER: 'real-observer-actor' } });
  assert.deepEqual(JSON.parse(result.stdout), { identityObserved: true, markerConfirmed: true, sourceBytesMatched: true, copiesRemoved: true, foreignReadDenied: true });
  assert.deepEqual(await fs.readdir(temporaryDirectory), []);
});

test('cooperative runs stay in the actor group and stop only their observed descendants while foreign siblings survive', async (t) => {
  for (const [task, expected] of [['ordinary completion', 'completed'], ['sleep confirmed', 'cancelled'], ['sleep confirmed cleared-child', 'unknown']]) {
    await t.test(expected, async (t) => {
      const f = await fixture(t, 'workspace');
      await fs.writeFile(f.prompt, task);
      const actor = path.join(f.directory, 'cooperative-actor.mjs');
      await fs.writeFile(actor, `import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const {prepareRun,startRun,runStatus,collectRun,cancelRun}=await import(pathToFileURL(${JSON.stringify(path.join(runtimeRoot, 'runner.mjs'))}));
const {processTable,ownsProcess}=await import(pathToFileURL(${JSON.stringify(path.join(runtimeRoot, 'processes.mjs'))}));
let input=''; for await(const chunk of process.stdin) input+=chunk;
const {plan,request,runs,expected}=JSON.parse(input);
const foreign=spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'ignore'});
let childIdentity;
let longer;
try {
 const actorIdentity=(await processTable()).find(item=>item.pid===process.pid);
 const launched=await startRun(await prepareRun(plan,request),{runsDirectory:runs});
 const directory=path.join(runs,launched.id);
 if(expected!=='completed') {
  let pid;
  for(let i=0;i<100&&!pid;i++) {try{({pid}=JSON.parse(await fs.readFile(path.join(directory,'child.json'),'utf8')))}catch{await new Promise(resolve=>setTimeout(resolve,20))}}
  assert.ok(pid); childIdentity=(await processTable()).find(item=>item.pid===pid); assert.ok(childIdentity);
 }
 let result;
 if(expected==='completed') {
  for(let i=0;i<100;i++) {result=await runStatus(launched.id,runs);if(result.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,40))}
  assert.match(await collectRun(launched.id,runs),/Actual fake process output/);
 } else result=await cancelRun(launched.id,runs);
 assert.equal(result.state,expected);
 const record=JSON.parse(await fs.readFile(path.join(directory,'record.json'),'utf8'));
 longer=spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'ignore',env:{...process.env,AW_SUBAGENT_PROCESS_TOKEN:record.processToken+'suffix'}});
 const longerIdentity=(await processTable()).find(item=>item.pid===longer.pid); assert.ok(longerIdentity);
 assert.equal(await ownsProcess(longerIdentity,record.processToken),false);
 assert.equal(record.supervisor.pgid,actorIdentity.pgid);
 assert.ok(record.processes.length>0);
 assert.ok(record.processes.every(item=>item.pgid===actorIdentity.pgid));
 assert.ok(record.processes.every(item=>![process.pid,record.supervisor.pid,foreign.pid].includes(item.pid)));
 assert.doesNotThrow(()=>process.kill(foreign.pid,0));
 if(expected==='unknown') {
  assert.equal(result.localTreeStopped,false); assert.equal(await ownsProcess(childIdentity,record.processToken),false);
  assert.doesNotThrow(()=>process.kill(childIdentity.pid,0));
  await assert.rejects(collectRun(launched.id,runs),{code:'runNotCompleted'});
 }
 for(let i=0;i<100;i++){if(!(await processTable()).some(item=>item.pid===record.supervisor.pid&&item.started===record.supervisor.started))break;await new Promise(resolve=>setTimeout(resolve,20))}
 assert.ok(!(await processTable()).some(item=>item.pid===record.supervisor.pid&&item.started===record.supervisor.started));
 process.stdout.write(JSON.stringify({state:result.state,sameGroup:true,parentSurvived:true,foreignSurvived:true,supervisorExited:true}));
} finally {
 foreign.kill('SIGTERM');
 longer?.kill('SIGTERM');
 if(childIdentity){const current=(await processTable()).find(item=>item.pid===childIdentity.pid);if(current?.started===childIdentity.started){try{process.kill(current.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error}}}
}
`);
      const result = await executeActor(actor, { plan: f.plan, request: f.request, runs: f.runs, expected }, { TMPDIR: f.directory, AW_AGENT_SKILL_EVAL_PROCESS_MARKER: `real-cooperative-${expected}` });
      assert.deepEqual(result, { state: expected, sameGroup: true, parentSurvived: true, foreignSurvived: true, supervisorExited: true });
    });
  }
});

test('default background run survives its launcher exit and keeps independently owned supervisor and adapter groups', async (t) => {
  const f = await fixture(t, 'workspace');
  await fs.writeFile(f.prompt, 'sleep confirmed');
  const actor = path.join(f.directory, 'default-launcher.mjs');
  await fs.writeFile(actor, `import {pathToFileURL} from 'node:url';
const {prepareRun,startRun}=await import(pathToFileURL(${JSON.stringify(path.join(runtimeRoot, 'runner.mjs'))}));
let input='';for await(const chunk of process.stdin)input+=chunk;
const {plan,request,runs}=JSON.parse(input);
process.stdout.write(JSON.stringify(await startRun(await prepareRun(plan,request),{runsDirectory:runs})));
`);
  const launched = await executeActor(actor, { plan: f.plan, request: f.request, runs: f.runs }, { TMPDIR: f.directory });
  const directory = path.join(f.runs, launched.id);
  for (let index = 0; index < 60; index++) { try { await fs.stat(path.join(directory, 'child.json')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  const record = JSON.parse(await fs.readFile(path.join(directory, 'record.json'), 'utf8'));
  assert.equal((await runStatus(launched.id, f.runs)).state, 'running');
  assert.equal(record.supervisor.pgid, record.supervisor.pid);
  assert.equal(record.processes[0].pgid, record.processes[0].pid);
  assert.equal(await ownsProcess(record.supervisor, record.processToken), true);
  assert.equal((await cancelRun(launched.id, f.runs)).state, 'cancelled');
});

test('opaque bindings, legacy native profile, access intersection and unsupported channels are enforced', async (t) => {
  const f = await fixture(t);
  assert.equal(f.plan.workerKey, 'unrelated');
  assert.equal(f.plan.access, 'read-only');
  assert.throws(() => resolvePlan(f.snapshot, f.binding, { ...f.request, access: 'workspace-write' }), { code: 'accessNotAllowed' });
  assert.throws(() => resolvePlan(f.snapshot, f.binding, { ...f.request, worker: 'other' }), { code: 'workerNotAllowed' });
  assert.throws(() => resolvePlan(f.snapshot, f.binding, { ...f.request, expectedRevision: 'new' }), { code: 'revisionMismatch' });
  assert.throws(() => resolvePlan(f.snapshot, f.binding, { ...f.request, requireIsolation: true }), { code: 'isolationUnsupported' });
  f.command.supportsSystemInstructions = false;
  assert.throws(() => resolvePlan(f.snapshot, f.binding, f.request), { code: 'instructionChannelUnsupported' });
  delete f.snapshot.effectiveValues.foreignProfile.executor;
  const native = resolvePlan(f.snapshot, f.binding, f.request);
  assert.equal(native.executorKey, 'native');
  assert.equal(native.hostLoadedRoleVerification, 'required');
  await assert.rejects(prepareRun(native, f.request), { code: 'nativeHostVerificationRequired' });
  f.snapshot.effectiveValues.foreignProfile.executor = null;
  assert.throws(() => resolvePlan(f.snapshot, f.binding, f.request), { code: 'executorInvalid' });
});

test('explicit model and effort independently override profile preferences as data with no fallback', async (t) => {
  const f = await fixture(t);
  const selectedModel = 'literal; $(touch explicit-injected)';
  const modelOnly = resolvePlan(f.snapshot, f.binding, { ...f.request, model: selectedModel });
  assert.equal(modelOnly.model, selectedModel);
  assert.equal(modelOnly.reasoningEffort, 'medium');
  assert.deepEqual(modelOnly.parameterSources, { model: 'request', reasoningEffort: 'profile' });
  const effortOnly = resolvePlan(f.snapshot, f.binding, { ...f.request, reasoningEffort: 'low' });
  assert.equal(effortOnly.model, f.snapshot.effectiveValues.foreignProfile.model);
  assert.equal(effortOnly.reasoningEffort, 'low');
  assert.deepEqual(effortOnly.parameterSources, { model: 'profile', reasoningEffort: 'request' });
  const defaults = resolvePlan({ ...f.snapshot, effectiveValues: { ...f.snapshot.effectiveValues, foreignProfile: { executor: 'external' } } }, f.binding, f.request);
  assert.equal(Object.hasOwn(defaults, 'model'), false);
  assert.equal(Object.hasOwn(defaults, 'reasoningEffort'), false);
  assert.deepEqual(defaults.parameterSources, { model: 'backend-default', reasoningEffort: 'backend-default' });
  assert.throws(() => resolvePlan(f.snapshot, f.binding, { ...f.request, model: '' }), { code: 'parameterInvalid' });
  const parsed = parseCommand(['run', '--profile', 'foreignProfile', '--workspace', f.workspace, '--prompt-file', f.prompt, '--file', 'source.txt', '--preview', '--allow-material-transfer', '--allow-model-cost', '--model', selectedModel, '--reasoning-effort', 'low']);
  const result = await executeCommand(parsed, { readRuntimeConfig: async () => f.snapshot });
  assert.equal(result.json.plan.model, selectedModel);
  assert.equal(result.json.plan.reasoningEffort, 'low');
  assert.equal(result.json.generationStarted, false);
  const prepared = await prepareRun(modelOnly, f.request);
  const launched = await startRun(prepared, { runsDirectory: f.runs });
  assert.equal((await terminal(launched.id, f.runs)).state, 'completed');
  const observed = JSON.parse(await fs.readFile(path.join(f.runs, launched.id, 'observed.json'), 'utf8'));
  assert.equal(observed.request.run.model, selectedModel);
  assert.equal(observed.request.run.reasoningEffort, 'medium');
  assert.equal(await fs.stat(path.join(f.workspace, 'explicit-injected')).catch(() => undefined), undefined);
});

test('preview is zero generation; actual source bytes and locations are captured without truncation', async (t) => {
  const f = await fixture(t);
  const preview = previewResult(await prepareRun(f.plan, f.request));
  assert.equal(preview.generationStarted, false);
  assert.equal(preview.materials[0].source, 'source.txt');
  assert.equal(preview.materials[0].endLine, 2);
  assert.deepEqual(await fs.readdir(f.runs), []);
  await fs.writeFile(path.join(f.workspace, 'source.txt'), 'changed after preview\n');
  const prepared = await prepareRun(f.plan, f.request);
  assert.notEqual(prepared.materials[0].sha256, preview.materials[0].sha256);
  assert.equal(prepared.materials[0].bytes.toString(), 'changed after preview\n');
  await fs.writeFile(path.join(f.workspace, 'large.txt'), Buffer.alloc(LIMITS.fileBytes + 1, 'x'));
  await assert.rejects(inspectMaterials(f.workspace, ['large.txt']), { code: 'materialFileTooLarge' });
  await assert.rejects(inspectMaterials(f.workspace, Array.from({ length: LIMITS.files + 1 }, (_, i) => `${i}.txt`)), { code: 'materialCountExceeded' });
  for (const source of ['../source.txt', '.env', 'node_modules/module.txt', '.git/config', 'credential.pem']) await assert.rejects(inspectMaterials(f.workspace, [source]), (error) => /material/.test(error.code));
  await fs.symlink(path.join(f.workspace, 'source.txt'), path.join(f.workspace, 'link.txt'));
  await assert.rejects(inspectMaterials(f.workspace, ['link.txt']), { code: 'pathSymlink' });
  await fs.writeFile(path.join(f.workspace, 'binary.txt'), Buffer.from([0, 1, 2]));
  await assert.rejects(inspectMaterials(f.workspace, ['binary.txt']), { code: 'binaryUnsupported' });
  await fs.writeFile(path.join(f.workspace, 'secret.txt'), '-----BEGIN PRIVATE KEY-----\n');
  await assert.rejects(inspectMaterials(f.workspace, ['secret.txt']), { code: 'materialSecretDetected' });
  await fs.writeFile(path.join(f.workspace, 'full.txt'), Buffer.alloc(LIMITS.fileBytes, 'x'));
  const many = [];
  for (let index = 0; index < 9; index++) { const name = `full${index}.txt`; await fs.copyFile(path.join(f.workspace, 'full.txt'), path.join(f.workspace, name)); many.push(name); }
  await assert.rejects(inspectMaterials(f.workspace, many), { code: 'materialTotalTooLarge' });
});

test('v2 completion requires real terminal evidence and never accepts a user prefix or bare exit zero', () => {
  const receipt = { protocolVersion: 2, outcome: 'completed', instructionChannel: 'developer', instructionsRevision: 'revision', providerTerminal: 'turn.completed' };
  const input = { exitCode: 0, output: 'Complete body', receipt, instructionRevision: 'revision', localTreeStopped: true };
  assert.equal(outcomeFromEvidence(input).state, 'completed');
  assert.equal(outcomeFromEvidence({ ...input, receipt: undefined }).state, 'unknown');
  assert.equal(outcomeFromEvidence({ ...input, receipt: { ...receipt, instructionChannel: 'user-prefix' } }).state, 'unknown');
  assert.equal(outcomeFromEvidence({ ...input, receipt: { ...receipt, providerTerminal: undefined } }).state, 'unknown');
  assert.equal(outcomeFromEvidence({ ...input, receipt: { ...receipt, instructionsRevision: 'wrong' } }).state, 'unknown');
  assert.equal(outcomeFromEvidence({ ...input, output: '' }).state, 'unknown');
  assert.equal(outcomeFromEvidence({ ...input, exitCode: 1 }).state, 'unknown');
  assert.equal(outcomeFromEvidence({ ...input, interrupted: true }).state, 'unknown');
  assert.equal(outcomeFromEvidence({ ...input, localTreeStopped: false }).state, 'unknown');
  for (const contradiction of [{ scopeViolation: true }, { generationStarted: false }, { localExitCode: 1 }, { localExitCode: null }]) assert.equal(outcomeFromEvidence({ ...input, receipt: { ...receipt, ...contradiction } }).state, 'unknown');
  for (const failure of [{ outcome: 'failed', providerTerminal: 'turn.failed', generationStarted: true }, { outcome: 'failed', providerTerminal: undefined, generationStarted: false }]) {
    assert.equal(outcomeFromEvidence({ ...input, receipt: { ...receipt, ...failure } }).state, 'failed');
    assert.deepEqual(outcomeFromEvidence({ ...input, receipt: { ...receipt, ...failure }, localTreeStopped: false }), { state: 'unknown', code: 'localTreeStopUnconfirmed' });
  }
});

test('public runner does not complete a registered v2 adapter run with contradictory receipt fields', async (t) => {
  const f = await fixture(t);
  for (const task of ['contradictory scope', 'contradictory generation', 'contradictory exit']) {
    await fs.writeFile(f.prompt, task);
    const launched = await startRun(await prepareRun(f.plan, f.request), { runsDirectory: f.runs });
    const result = await terminal(launched.id, f.runs);
    assert.equal(result.state, 'unknown');
    assert.equal(result.code, 'receiptContradictory');
    await assert.rejects(collectRun(launched.id, f.runs), { code: 'runNotCompleted' });
  }
});

test('real managed fake process receives exact separated snapshots and allowlist; old run recovery ignores current registry', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareRun(f.plan, f.request);
  const environment = { PATH: process.env.PATH, HOME: f.directory, OPENAI_API_KEY: 'fake-authorized-adapter-key', AWS_SECRET_ACCESS_KEY: 'must-not-leave', AW_PLUGIN_CONTEXT: 'must-not-leave', AW_HOME: 'must-not-leave' };
  assert.equal(adapterEnvironment(environment).AWS_SECRET_ACCESS_KEY, undefined);
  const launched = await startRun(prepared, { runsDirectory: f.runs, environment });
  assert.equal((await terminal(launched.id, f.runs)).state, 'completed');
  const observed = JSON.parse(await fs.readFile(path.join(f.runs, launched.id, 'observed.json'), 'utf8'));
  assert.equal(observed.request.instructions.text, prepared.instructions);
  assert.equal(observed.request.task, prepared.task);
  assert.equal(observed.environment.AW_HOME, undefined);
  assert.equal(observed.environment.AW_PLUGIN_CONTEXT, undefined);
  assert.equal(observed.environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(observed.environment.OPENAI_API_KEY, environment.OPENAI_API_KEY);
  assert.equal(await fs.readFile(observed.request.materials[0].path, 'utf8'), prepared.materials[0].bytes.toString());
  assert.equal((await fs.stat(path.join(f.runs, launched.id))).mode & 0o077, 0);
  assert.equal((await fs.stat(observed.request.materials[0].path)).mode & 0o077, 0);
  f.snapshot.revision = 'new-revision';
  f.command.command = '/does/not/exist';
  await fs.rm(f.root, { recursive: true });
  const collected = await collectRun(launched.id, f.runs);
  assert.match(collected, /Actual fake process output/);
  assert.equal((await runStatus(launched.id, f.runs)).configRevision, 'old-execution-revision');
  const fromCli = await execFileAsync(process.execPath, [entry, 'collect', '--run', launched.id, '--runs-dir', f.runs]);
  assert.equal(fromCli.stdout, collected);
  assert.deepEqual(await fs.readdir(f.runs), [launched.id]);
  assert.equal(await fs.stat(path.join(f.workspace, 'injected')).catch(() => undefined), undefined);
});

test('missing receipt remains unknown and repeated status/collect cannot trigger another generation', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.prompt, 'missing receipt');
  const launched = await startRun(await prepareRun(f.plan, f.request), { runsDirectory: f.runs });
  assert.equal((await terminal(launched.id, f.runs)).state, 'unknown');
  await assert.rejects(collectRun(launched.id, f.runs), { code: 'runNotCompleted' });
  await runStatus(launched.id, f.runs);
  assert.equal((await cancelRun(launched.id, f.runs)).state, 'unknown');
  assert.deepEqual(await fs.readdir(f.runs), [launched.id]);
});

test('cancel stops owned descendants and distinguishes local stop from unknown remote stop', async (t) => {
  const f = await fixture(t, 'workspace');
  await fs.writeFile(f.prompt, 'sleep remote-unknown');
  const launched = await startRun(await prepareRun(f.plan, f.request), { runsDirectory: f.runs });
  const childFile = path.join(f.runs, launched.id, 'child.json');
  let pid;
  for (let index = 0; index < 60 && !pid; index++) { try { ({ pid } = JSON.parse(await fs.readFile(childFile, 'utf8'))); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  assert.ok(pid);
  const cancelled = await cancelRun(launched.id, f.runs);
  assert.equal(cancelled.state, 'unknown');
  assert.equal(cancelled.localTreeStopped, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('cancel can recover only original owned processes after the supervisor disappears', async (t) => {
  const f = await fixture(t, 'workspace');
  await fs.writeFile(f.prompt, 'sleep recover');
  const launched = await startRun(await prepareRun(f.plan, f.request), { runsDirectory: f.runs });
  const directory = path.join(f.runs, launched.id);
  let pid;
  for (let index = 0; index < 60 && !pid; index++) { try { ({ pid } = JSON.parse(await fs.readFile(path.join(directory, 'child.json'), 'utf8'))); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  const record = JSON.parse(await fs.readFile(path.join(directory, 'record.json'), 'utf8'));
  process.kill(record.supervisor.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await runStatus(launched.id, f.runs)).state, 'unknown');
  const stopped = await cancelRun(launched.id, f.runs);
  assert.equal(stopped.state, 'unknown');
  assert.equal(stopped.localTreeStopped, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('cancelled requires both observed local cleanup and an adapter confirmation for the original provider', async (t) => {
  const f = await fixture(t, 'workspace');
  await fs.writeFile(f.prompt, 'sleep confirmed');
  const launched = await startRun(await prepareRun(f.plan, f.request), { runsDirectory: f.runs });
  for (let index = 0; index < 60; index++) { try { await fs.stat(path.join(f.runs, launched.id, 'child.json')); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  const stopped = await cancelRun(launched.id, f.runs);
  assert.equal(stopped.state, 'cancelled');
  assert.equal(stopped.localTreeStopped, true);
  assert.equal(stopped.receipt.providerStopped, true);
});

test('a live descendant that cleared its marker is not killed and cannot make a provider-confirmed cancel appear complete', async (t) => {
  const f = await fixture(t, 'workspace');
  await fs.writeFile(f.prompt, 'sleep confirmed cleared-child');
  const launched = await startRun(await prepareRun(f.plan, f.request), { runsDirectory: f.runs });
  const directory = path.join(f.runs, launched.id);
  let pid;
  for (let index = 0; index < 60 && !pid; index++) { try { ({ pid } = JSON.parse(await fs.readFile(path.join(directory, 'child.json'), 'utf8'))); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  assert.ok(pid);
  const identity = (await processTable()).find((item) => item.pid === pid);
  assert.ok(identity);
  // This fixture has an independent bounded lifetime. Only the test that spawned it
  // may clean it up after verifying its original start identity.
  t.after(async () => {
    const current = (await processTable()).find((item) => item.pid === pid);
    if (current?.started === identity.started) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  });
  const record = JSON.parse(await fs.readFile(path.join(directory, 'record.json'), 'utf8'));
  assert.equal(await ownsProcess(identity, record.processToken), false);
  const result = await cancelRun(launched.id, f.runs);
  assert.equal(result.receipt.providerStopped, true);
  assert.equal(result.state, 'unknown');
  assert.equal(result.localTreeStopped, false);
  assert.doesNotThrow(() => process.kill(pid, 0));
});

test('service terminal receipts cannot release a run while an unowned local descendant remains live', async (t) => {
  for (const [task, outcome] of [['complete with cleared-child', 'completed'], ['fail with cleared-child', 'failed']]) {
    await t.test(outcome, async (t) => {
      const f = await fixture(t, 'workspace');
      await fs.writeFile(f.prompt, task);
      const launched = await startRun(await prepareRun(f.plan, f.request), { runsDirectory: f.runs });
      const directory = path.join(f.runs, launched.id);
      let pid;
      for (let index = 0; index < 60 && !pid; index++) { try { ({ pid } = JSON.parse(await fs.readFile(path.join(directory, 'child.json'), 'utf8'))); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
      assert.ok(pid);
      const identity = (await processTable()).find((item) => item.pid === pid);
      assert.ok(identity);
      t.after(async () => {
        const current = (await processTable()).find((item) => item.pid === pid);
        if (current?.started === identity.started) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      });
      const result = await terminal(launched.id, f.runs);
      assert.equal(result.receipt.outcome, outcome);
      assert.equal(result.state, 'unknown');
      assert.equal(result.localTreeStopped, false);
      assert.equal(result.code, 'localTreeStopUnconfirmed');
      await assert.rejects(collectRun(launched.id, f.runs), { code: 'runNotCompleted' });
      assert.equal((await cancelRun(launched.id, f.runs)).state, 'unknown');
      assert.doesNotThrow(() => process.kill(pid, 0));
    });
  }
});

test('CLI rejects opaque executable parameters and unsupported operations before reading an installed runtime', async () => {
  assert.throws(() => parseCommand(['run', '--command', '/bin/sh']), { code: 'argumentsInvalid' });
  assert.throws(() => parseCommand(['resume', '--run', 'any']), { code: 'operationUnsupported' });
  assert.throws(() => parseCommand(['status', '--run', 'any', '--profile', 'new']), { code: 'argumentsInvalid' });
  assert.throws(() => parseCommand(['resolve']), { code: 'argumentsRequired' });
  const help = await execFileAsync(process.execPath, [entry, '--help']);
  assert.match(help.stdout, /resolve/);
  await assert.rejects(executeCommand(parseCommand(['status', '--run', '../foreign'])), { code: 'runIdInvalid' });
});

test('production Codex adapter maps exact developer argv and task/material data, preserves safety markers, and consumes real CLI event format', async (t) => {
  const f = await fixture(t);
  const fakeBinary = path.join(f.directory, 'fake-codex');
  await fs.writeFile(fakeBinary, `#!${await fs.realpath(process.execPath)}
import fs from 'node:fs/promises';
import path from 'node:path';
await fs.appendFile(${JSON.stringify(path.join(f.directory, 'backend-spawns.log'))},'call\\n');
if(process.argv.includes('--version')) {process.stdout.write('codex-cli 0.160.1\\n');process.exit(0)}
let input='';for await(const chunk of process.stdin) input+=chunk;
const args=process.argv.slice(2);const task=JSON.parse(input);
const output=args[args.indexOf('--output-last-message')+1];
await fs.appendFile(path.join(path.dirname(output),'invocations.log'),'exec\\n');
await fs.writeFile(path.join(path.dirname(output),'backend-observed.json'),JSON.stringify({args,task,environment:process.env}));
await fs.writeFile(output,'完整正文 fake-authorized-adapter-key');
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'real-format-fake-session'})+'\\n');
if(task.task==='scope') process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'cat source.txt'}})+'\\n');
if(task.task==='unavailable')process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'The requested model does not exist or is unavailable.'}})+'\\n');
else if(task.task!=='no terminal')process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:4}})+'\\n');
`, { mode: 0o700 });
  const home = path.join(f.directory, 'codex-home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.toml'), '# mcp_servers and hooks mentioned only in a comment\nmodel = "fixture"\n[projects."/ordinary/project"]\ntrust_level="trusted"\n');
  const environment = {
    PATH: process.env.PATH, HOME: f.directory, CODEX_HOME: home, OPENAI_API_KEY: 'fake-authorized-adapter-key',
    AW_SUBAGENT_CODEX_BINARY: fakeBinary, AW_AGENT_SKILL_EVAL_PROCESS_MARKER: 'eval-owner-marker',
    AW_PLUGIN_CONTEXT: 'must-not-leave', AWS_SECRET_ACCESS_KEY: 'must-not-leave',
  };
  const prepared = await prepareRun(f.plan, f.request);
  const envelope = {
    protocolVersion: 2, run: { id: 'fixture', mode: 'bundle', access: 'read-only', workspace: f.workspace, model: 'literal; $(touch escaped)', reasoningEffort: 'medium' },
    instructions: { workerKey: f.plan.workerKey, revision: f.plan.worker.instructionRevision, text: prepared.instructions },
    task: 'Natural task; $(touch escaped)', materials: prepared.materials.map(({ originalPath, bytes, ...item }) => ({ ...item, path: originalPath })),
  };
  const attempt = async (task, config = undefined) => {
    const runDirectory = await fs.mkdtemp(path.join(f.runs, 'adapter-'));
    if (config !== undefined) await fs.writeFile(path.join(home, 'config.toml'), config);
    return { runDirectory, promise: executeCodex({ ...envelope, task }, { ...environment, AW_SUBAGENT_RUN_DIR: runDirectory, AW_SUBAGENT_RESULT_FILE: path.join(runDirectory, 'receipt.json') }) };
  };
  const first = await attempt(envelope.task);
  const result = await first.promise;
  assert.equal(result.receipt.outcome, 'completed');
  assert.equal(result.receipt.providerTerminal, 'turn.completed');
  assert.equal(result.receipt.actualModel, undefined);
  assert.deepEqual(result.receipt.usage, { input_tokens: 3, output_tokens: 4 });
  assert.equal(result.text, '完整正文 [redacted]');
  assert.equal((await fs.stat(path.join(first.runDirectory, 'codex-last-message.md'))).mode & 0o077, 0);
  const observed = JSON.parse(await fs.readFile(path.join(first.runDirectory, 'backend-observed.json'), 'utf8'));
  assert.ok(observed.args.includes(`developer_instructions=${JSON.stringify(prepared.instructions)}`));
  assert.equal(observed.task.task, envelope.task);
  assert.equal(observed.task.materials[0].content, 'one\ncurrent uncommitted content\n');
  assert.equal(observed.environment.AW_AGENT_SKILL_EVAL_PROCESS_MARKER, environment.AW_AGENT_SKILL_EVAL_PROCESS_MARKER);
  assert.equal(observed.environment.AW_PLUGIN_CONTEXT, undefined);
  assert.equal(observed.environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(observed.environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(observed.args.some((value) => value.startsWith('shell_environment_policy.set=') && value.includes('eval-owner-marker') && value.includes('GIT_TERMINAL_PROMPT')));
  assert.ok(!observed.args.includes('--ignore-rules'));
  assert.ok(!observed.args.includes('--ignore-user-config'));
  assert.match(await fs.readFile(path.join(first.runDirectory, result.receipt.traceFile), 'utf8'), /turn.completed/);
  const absent = await attempt('no terminal');
  assert.equal((await absent.promise).receipt.outcome, 'unknown');
  const violating = await attempt('scope');
  assert.equal((await violating.promise).receipt.outcome, 'unknown');
  const unavailable = await attempt('unavailable');
  const rejection = await unavailable.promise;
  assert.equal(rejection.receipt.outcome, 'failed');
  assert.equal(rejection.receipt.code, 'parameterUnavailable');
  assert.equal(await fs.readFile(path.join(unavailable.runDirectory, 'invocations.log'), 'utf8'), 'exec\n');
  const unsupported = await attempt('preflight', '[mcp_servers.external]\ncommand="never-executed"\n');
  await assert.rejects(unsupported.promise, { code: 'toolConfigurationUnsupported' });
  const failed = JSON.parse(await fs.readFile(path.join(unsupported.runDirectory, 'receipt.json'), 'utf8'));
  assert.equal(failed.generationStarted, false);
  assert.equal(await fs.stat(path.join(unsupported.runDirectory, 'backend-observed.json')).catch(() => undefined), undefined);
  await t.test('escaped quoted table and dotted keys are rejected before any backend process can start', async () => {
    const callsBefore = await fs.readFile(path.join(f.directory, 'backend-spawns.log'), 'utf8');
    for (const config of [
      '["\\u006dcp_servers".external]\ncommand="never-executed"\n',
      '"\\u006dcp_servers".external.command="never-executed"\n',
      '["\\U0000006dcp_servers".external]\ncommand="never-executed"\n',
      '"\\U0000006dcp_servers".external.command="never-executed"\n',
    ]) {
      const escaped = await attempt('preflight', config);
      await assert.rejects(escaped.promise, { code: 'toolConfigurationSyntaxUnsupported' });
      const receipt = JSON.parse(await fs.readFile(path.join(escaped.runDirectory, 'receipt.json'), 'utf8'));
      assert.equal(receipt.generationStarted, false);
      assert.equal(receipt.outcome, 'failed');
      assert.equal(await fs.stat(path.join(escaped.runDirectory, 'backend-observed.json')).catch(() => undefined), undefined);
    }
    for (const config of ['mcp_servers.external.command="never-executed"\n', '"mcp_servers".external.command="never-executed"\n']) {
      const dotted = await attempt('preflight', config);
      await assert.rejects(dotted.promise, { code: 'toolConfigurationUnsupported' });
    }
    assert.equal(await fs.readFile(path.join(f.directory, 'backend-spawns.log'), 'utf8'), callsBefore);
  });
  assert.equal(await fs.stat(path.join(f.workspace, 'escaped')).catch(() => undefined), undefined);
});
