import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseCommand, executeCommand } from '../skills/codex-subagent-guide/scripts/subagent.mjs';
import { selectExecution } from '../skills/codex-subagent-guide/scripts/runtime/plan.mjs';
import { prepareRun, runForeground, classifyResult } from '../skills/codex-subagent-guide/scripts/runtime/runner.mjs';
import { processTable } from '../skills/codex-subagent-guide/scripts/runtime/processes.mjs';
import { LIMITS, validateRequest } from '../skills/codex-subagent-guide/scripts/runtime/contracts.mjs';

const require = createRequire(import.meta.url);
const sourceScripts = path.dirname(require.resolve('../skills/codex-subagent-guide/scripts/resolve-files.mjs'));
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
function roleSource(skill) {
  // Production bundles keep canonical role text in the artifact source tree.
  const staged = path.join(pluginRoot, '.agents-plugin/artifact-sources/codex', `${skill}-skill`, '0');
  return existsSync(staged) ? staged : path.join(pluginRoot, 'skills', skill);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, mode = 'workspace') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-foreground-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const installed = path.join(directory, 'guide');
  await fs.mkdir(workspace); await fs.mkdir(installed);
  await fs.cp(sourceScripts, path.join(installed, 'scripts'), { recursive: true });
  const instructions = path.join(directory, 'instructions.md');
  const observed = path.join(directory, 'observed.json');
  const generations = path.join(directory, 'generations.log');
  const adapter = path.join(directory, 'adapter.mjs');
  await fs.writeFile(instructions, 'Explicit role instructions.\nDo not change project files.\n');
  await fs.writeFile(adapter, `
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
let input='';for await(const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const task=request.prompt;
await fs.appendFile(${JSON.stringify(generations)}, 'generation\\n');
await fs.writeFile(${JSON.stringify(observed)}, JSON.stringify({request,pid:process.pid,cwd:process.cwd(),argv:process.argv.slice(2),environment:process.env}));
const result={protocolVersion:4,state:'completed',generationStarted:true,backendExitCode:0,text:'Complete **body**'};
if(task==='sleep confirmed'||task==='sleep unknown'||task==='cancel before generation') {
  const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),12000)'],{env:process.env,stdio:'ignore',detached:false});
  await fs.writeFile(${JSON.stringify(path.join(directory,'child.json'))}, JSON.stringify({pid:child.pid}));
  process.on('SIGTERM',async()=>{Object.assign(result,{state:task==='sleep unknown'?'unknown':'cancelled',backendExitCode:null,remoteStopConfirmed:task==='sleep confirmed',generationStarted:task==='cancel before generation'?false:true});await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE,JSON.stringify(result),{mode:0o600});process.exit(0)});
  await new Promise(r=>setTimeout(r,11000));
}
if(task.startsWith('unowned')) {
 const env={...process.env};delete env.AW_SUBAGENT_PROCESS_TOKEN;
 const pipes=task.includes('pipes');
 const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),9000)'],{env,stdio:pipes?['ignore',process.stdout,process.stderr]:'ignore',detached:false});
 await fs.writeFile(${JSON.stringify(path.join(directory,'child.json'))},JSON.stringify({pid:child.pid}));
 if(pipes) process.stdout.write('partial diagnostics before exit\\n');
 await new Promise(r=>setTimeout(r,task.endsWith('stop')?8000:650));
}
if(task==='delay') await new Promise(r=>setTimeout(r,900));
if(task==='backend conflict') result.backendExitCode=1;
if(task==='no terminal') {process.stdout.write('ordinary success text');process.exit(0)}
if(task==='v3 result') result.protocolVersion=3;
if(task==='fail') Object.assign(result,{state:'failed',backendExitCode:1,text:'partial',code:'fixtureFailed'});
if(task==='preflight') Object.assign(result,{state:'failed',generationStarted:false,backendExitCode:null,text:'',code:'fixtureInputFailed'});
if(task==='unknown generation') Object.assign(result,{state:'unknown',generationStarted:null,backendExitCode:null,text:'partial'});
if(task==='secret') {result.text='secret='+process.env.SERVICE_DATA;result.message='secret='+process.env.SERVICE_DATA;process.stderr.write('secret='+process.env.SERVICE_DATA)}
if(task==='escaped secret') {
 const payload=JSON.stringify({serviceData:process.env.SERVICE_DATA});
 Object.assign(result,{state:'failed',backendExitCode:1,code:'fixtureFailed',text:payload,message:payload,sessionId:payload,model:payload});
 process.stdout.write(payload);process.stderr.write(payload);
}
if(task==='text overflow') result.text='x'.repeat(${LIMITS.outputBytes + 1});
if(task==='diagnostic overflow') {process.stdout.write('x'.repeat(${LIMITS.logBytes + 1}));await new Promise(r=>setTimeout(r,1000))}
if(task==='result overflow') {await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE,'x'.repeat(${LIMITS.resultBytes + 1}),{mode:0o600});process.exit(0)}
await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE,JSON.stringify(result),{mode:0o600});
process.exit(task==='exit conflict'?1:0);
`);
  const snapshot = { installedIdentity: { source: 'fixture', plugin: 'fixture', platform: 'codex', scope: 'user' }, resourceRoot: installed,
    effectiveValues: { advisorProfile: { executor: 'fixture' }, subagentCommands: [{ key: 'fixture', title: 'Fixture', adapter: 'custom', mode, command: await fs.realpath(process.execPath), entrypoint: adapter }] } };
  const config = path.join(installed, 'effective.json');
  await fs.writeFile(config, JSON.stringify(snapshot));
  await fs.writeFile(path.join(installed, 'scripts', 'aw-runtime-config.mjs'), `import fs from 'node:fs/promises';export async function readRuntimeConfig(){return JSON.parse(await fs.readFile(new URL('../effective.json',import.meta.url),'utf8'))}`);
  const entry = path.join(installed, 'scripts', 'subagent.mjs');
  const request = { operation: 'run', profile: 'advisorProfile', prompt: 'complete', workspace, files: [] };
  const environment = { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, AW_HOME: directory, AW_CODEX_HOME: directory, AW_CLAUDE_HOME: directory };
  const cli = ({ extra = [], env = {}, prompt = 'complete', stdin, cwd = workspace } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'run', '--profile', 'advisorProfile', '--prompt', prompt, '--workspace', workspace, ...extra], { cwd, env: { ...environment, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], diagnostics = [];
    child.stdout.on('data', (chunk) => output.push(chunk)); child.stderr.on('data', (chunk) => diagnostics.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(diagnostics).toString('utf8') }));
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
  });
  return { directory, workspace, installed, instructions, observed, generations, snapshot, config, entry, request, environment, cli,
    save: () => fs.writeFile(config, JSON.stringify(snapshot)),
    prepared: (changes = {}, options = {}) => prepareRun(selectExecution(snapshot, { ...request, ...changes }), { ...request, ...changes }, { environment, ...options }) };
}
async function waitFile(file) { for(let i=0;i<150;i++){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{await sleep(20)}}throw new Error('fixture file missing'); }

// Test Value Gate: real copied entry/child protect prompt bytes, optional role composition,
// caller-relative paths, installed defaults, backend argv isolation and private cleanup.
test('copied CLI preserves prompt and optional instruction text, with text stdout', async (t) => {
  const f = await fixture(t);
  const prompt = '  多行 "quote"\n$(touch escaped); `literal`\n';
  let result = await f.cli({ prompt });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /^COMPLETED · advisorProfile → fixture · workspace\n\nComplete \*\*body\*\*/);
  assert.equal(result.stderr, ''); assert.throws(() => JSON.parse(result.stdout));
  let observed = await waitFile(f.observed);
  assert.equal(observed.request.prompt, prompt); assert.equal(observed.request.protocolVersion, 4);
  assert.deepEqual(observed.request.execution, { profile: 'advisorProfile', executor: 'fixture' });
  assert.equal(Object.hasOwn(observed.request, 'fileSelectors'), false);
  assert.equal(Object.hasOwn(observed.request, 'fileResolver'), false);
  assert.deepEqual(observed.argv, []); assert.equal(observed.cwd, f.workspace);
  assert.equal(await fs.stat(observed.environment.AW_SUBAGENT_TEMP_DIR).catch(() => undefined), undefined);
  assert.equal(await fs.stat(path.join(f.workspace, 'escaped')).catch(() => undefined), undefined);
  const linked = path.join(f.directory, 'role-link'); await fs.symlink(f.instructions, linked);
  result = await f.cli({ prompt, cwd: f.directory, extra: ['--instructions-file', 'role-link'] });
  assert.equal(result.code, 0, result.stderr); observed = await waitFile(f.observed);
  const instructions = await fs.readFile(f.instructions, 'utf8');
  assert.ok(observed.request.prompt.includes(instructions)); assert.ok(observed.request.prompt.endsWith(prompt));
  assert.ok(observed.request.prompt.indexOf(instructions) < observed.request.prompt.indexOf(prompt));
  assert.equal(Object.hasOwn(observed.request, 'instructions'), false);
});

// Test Value Gate: raw file selection belongs to the installed consumer, and preview must
// neither inspect missing material paths nor start a resolver/backend.
test('bundle preserves raw selectors and installed helper without scanning; preview launches nothing', async (t) => {
  const f = await fixture(t, 'bundle');
  const files = [' missing/**/*.ts , docs/absent.md ', '!**/*.test.ts', ' missing/**/*.ts , docs/absent.md ', '../outside'];
  const extra = files.flatMap((value) => ['--file', value]);
  let result = await f.cli({ extra: [...extra, '--preview'] });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /^PREVIEW/); assert.match(result.stdout, /未展开/);
  assert.equal(await fs.stat(f.generations).catch(() => undefined), undefined);
  result = await f.cli({ extra }); assert.equal(result.code, 0, result.stderr);
  const observed = await waitFile(f.observed);
  assert.deepEqual(observed.request.fileSelectors, files); assert.equal(observed.request.workspace, f.workspace); assert.equal(observed.cwd, f.workspace);
  assert.deepEqual(observed.request.fileResolver, { command: process.execPath, args: [path.join(f.installed, 'scripts', 'resolve-files.mjs')] });
  assert.deepEqual((await f.prepared()).request.fileSelectors, []);
});

// Test Value Gate: shared Advisor/Explore roles must reach the external invocation without
// native-only renderer additions, and a profile name must never cause implicit role loading.
test('external Advisor and Explore use only explicit shared role text', async (t) => {
  const f = await fixture(t);
  for (const [profile, skill, role] of [['advisorProfile', 'codex-advisor', 'advisor'], ['generalTaskProfile', 'codex-explore', 'explore']]) {
    f.snapshot.effectiveValues[profile] = { executor: 'fixture' }; await f.save();
    const instructions = await fs.readFile(path.join(roleSource(skill), 'assets', `${role}-instructions.md`), 'utf8');
    await fs.writeFile(f.instructions, instructions);
    const request = { ...f.request, profile, prompt: `assigned ${role} task` };
    let result = await executeCommand(request, { readRuntimeConfig: async () => f.snapshot, environment: f.environment, temporaryRoot: f.directory });
    assert.equal(result.exitCode, 0); assert.equal((await waitFile(f.observed)).request.prompt, request.prompt);
    result = await executeCommand({ ...request, instructionsFile: f.instructions }, { readRuntimeConfig: async () => f.snapshot, environment: f.environment, temporaryRoot: f.directory });
    assert.equal(result.exitCode, 0);
    const prompt = (await waitFile(f.observed)).request.prompt;
    assert.equal(prompt, `执行指令：\n${instructions}\n\n本次任务：\n${request.prompt}`);
  }
});

// Test Value Gate: unsupported inputs and mode errors must fail before any adapter starts.
test('workspace file rejection precedes prompt, instruction and selector validation; old interfaces reject', async (t) => {
  const f = await fixture(t);
  for (const value of ['', '!', '\0']) {
    if (value === '\0') { await assert.rejects(f.prepared({ files: [value], prompt: '', instructionsFile: 'missing' }), { code: 'filesNotAllowedInWorkspace' }); continue; }
    const result = await f.cli({ prompt: '', extra: ['--file', value, '--instructions-file', 'missing'] });
    assert.equal(result.code, 2); assert.match(result.stderr, /^filesNotAllowedInWorkspace:/); assert.equal(result.stdout, '');
  }
  for (const extra of [['--access', 'read-only'], ['--prompt-file', 'task'], ['--json'], ['--worker', 'old']]) {
    const result = await f.cli({ extra }); assert.equal(result.code, 2); assert.match(result.stderr, /^argumentsInvalid:/);
  }
  assert.throws(() => parseCommand(['run', '--profile', 'advisorProfile', '--prompt', 'one', '--prompt=two']), { code: 'promptDuplicate' });
  assert.throws(() => parseCommand(['run', '--profile', 'advisorProfile']), { code: 'argumentsRequired' });
  assert.throws(() => parseCommand(['resume']), { code: 'operationUnsupported' });
  assert.equal(await fs.stat(f.generations).catch(() => undefined), undefined);
  const fBundle = await fixture(t, 'bundle');
  for (const value of ['', ',,,', '!', ' , !   ,']) await assert.rejects(fBundle.prepared({ files: [value] }), { code: 'fileSelectionInputInvalid' });
});

// Test Value Gate: bounded strict UTF-8 input protects noninteractive EOF, no truncation,
// optional-but-explicit instruction failure and the separate two-input limits.
test('stdin and instruction boundaries reject invalid input without starting the adapter', async (t) => {
  const f = await fixture(t);
  const prompt = '  stdin 中文\nsecond line\n';
  const result = await f.cli({ prompt: '-', stdin: Buffer.from(prompt) });
  assert.equal(result.code, 0, result.stderr); assert.equal((await waitFile(f.observed)).request.prompt, prompt);
  const before = await fs.readFile(f.generations, 'utf8');
  for (const bytes of [Buffer.from('  \n'), Buffer.from([0xff]), Buffer.from([0]), Buffer.alloc(LIMITS.taskBytes + 1, 120)]) {
    const rejected = await f.cli({ prompt: '-', stdin: bytes }); assert.equal(rejected.code, 2); assert.equal(rejected.stdout, '');
  }
  const tty = Readable.from([]); tty.isTTY = true;
  await assert.rejects(f.prepared({ prompt: '-' }, { stdin: tty }), { code: 'stdinInteractive' });
  for (const bytes of [Buffer.from('  '), Buffer.from([0xff]), Buffer.alloc(LIMITS.instructionBytes + 1, 120)]) {
    await fs.writeFile(f.instructions, bytes);
    await assert.rejects(f.prepared({ instructionsFile: f.instructions }));
  }
  await assert.rejects(f.prepared({ instructionsFile: '-' }), { code: 'instructionsInvalid' });
  await assert.rejects(f.prepared({ instructionsFile: 'missing-file' }), { code: 'pathMissing' });
  await fs.writeFile(f.instructions, 'x'.repeat(LIMITS.instructionBytes));
  const prepared = await f.prepared({ instructionsFile: f.instructions, prompt: 'y'.repeat(LIMITS.taskBytes) });
  assert.ok(Buffer.byteLength(prepared.request.prompt) > LIMITS.taskBytes);
  assert.equal(await fs.readFile(f.generations, 'utf8'), before);
});

// Test Value Gate: generic host references, empty values, no secret JSON and unmodifiable
// control variables protect backend environment correctness and diagnostic disclosure.
test('host env is inherited, references use original snapshot, and all referenced values are redacted', async (t) => {
  const f = await fixture(t, 'bundle');
  Object.assign(f.snapshot.effectiveValues.subagentCommands[0], { args: ['--region', 'literal; $(touch escaped)', ''], env: { SOURCE: 'replacement', EMPTY: '' }, envFrom: { SERVICE_DATA: 'SOURCE', EMPTY_REFERENCE: 'EMPTY_HOST' } });
  await f.save();
  const result = await f.cli({ prompt: 'secret', env: { SOURCE: 's3', EMPTY_HOST: '', ORDINARY_HOST: 'inherited', HTTPS_PROXY: 'proxy-value', AW_PLUGIN_CONTEXT: 'private', AW_PLUGIN_RENDERER: 'private', AW_SUBAGENT_TEMP_DIR: 'foreign', AW_AGENT_SKILL_EVAL_PROCESS_MARKER: 'eval-owner' } });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /secret=\[redacted\]/); assert.equal(result.stdout.includes('s3'), false);
  const observed = await waitFile(f.observed);
  assert.equal(observed.environment.SOURCE, 'replacement'); assert.equal(observed.environment.SERVICE_DATA, 's3');
  assert.equal(observed.environment.EMPTY, ''); assert.equal(observed.environment.EMPTY_REFERENCE, '');
  assert.equal(observed.environment.ORDINARY_HOST, 'inherited'); assert.equal(observed.environment.HTTPS_PROXY, 'proxy-value');
  assert.equal(observed.environment.AW_PLUGIN_CONTEXT, undefined); assert.equal(observed.environment.AW_PLUGIN_RENDERER, undefined);
  assert.equal(observed.environment.AW_AGENT_SKILL_EVAL_PROCESS_MARKER, 'eval-owner'); assert.notEqual(observed.environment.AW_SUBAGENT_TEMP_DIR, 'foreign');
  assert.equal(JSON.stringify(observed.request).includes('s3'), false); assert.deepEqual(observed.request.args, f.snapshot.effectiveValues.subagentCommands[0].args); assert.deepEqual(observed.argv, []);
  const preview = await f.cli({ extra: ['--preview'], env: { SOURCE: 's3', EMPTY_HOST: '' } });
  assert.equal(preview.code, 0); assert.equal(preview.stdout.includes('s3'), false); assert.equal(preview.stdout.includes('replacement'), false);
  const internal = await runForeground(await f.prepared({ prompt: 'secret' }, { environment: { ...f.environment, SOURCE: '3', EMPTY_HOST: '' } }), { temporaryRoot: f.directory });
  assert.equal(internal.protocolVersion, 4); assert.equal(internal.text, 'secret=[redacted]'); assert.equal(internal.diagnostics, 'secret=[redacted]');
  await assert.rejects(f.prepared(), { code: 'environmentSourceMissing' });
  for (const changes of [{ env: null }, { env: { SERVICE_DATA: 'literal' } }, { env: { AW_SUBAGENT_RESULT_FILE: 'foreign' } }, { env: { AW_PLUGIN_CONTEXT: 'foreign' } }, { env: { AW_AGENT_SKILL_EVAL_PROCESS_MARKER: 'foreign' } }]) {
    const snapshot = structuredClone(f.snapshot); Object.assign(snapshot.effectiveValues.subagentCommands[0], changes);
    assert.throws(() => selectExecution(snapshot, f.request), { code: changes.env?.SERVICE_DATA ? 'environmentConflict' : 'environmentInvalid' });
  }
});

// Test Value Gate: ordinary JSON fields can carry escaped referenced credentials.
// Exercise real adapter pipes, the v4 result and the public failure text together.
test('runner redacts raw and JSON-escaped references in actual error output', async (t) => {
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentCommands[0].envFrom = { SERVICE_DATA: 'SOURCE', OVERLAP: 'OVERLAPPING_SOURCE' };
  await f.save();
  const secret = 'local-fixture\n"quoted"\\path.[x]+', escaped = JSON.stringify(secret).slice(1, -1);
  const env = { SOURCE: secret, OVERLAPPING_SOURCE: 'quoted' };
  const result = await f.cli({ prompt: 'escaped secret', env });
  assert.equal(result.code, 1); assert.match(result.stdout, /^FAILED · /);
  for (const output of [result.stdout, result.stderr]) {
    assert.equal(output.includes(secret), false); assert.equal(output.includes(escaped), false);
    assert.match(output, /\[redacted\]/);
  }
  const captured = await waitFile(f.observed);
  assert.equal(captured.environment.SERVICE_DATA, secret);
  assert.equal(JSON.stringify(captured.request).includes(escaped), false);
  const internal = await runForeground(await f.prepared({ prompt: 'escaped secret' }, { environment: { ...f.environment, ...env } }), { temporaryRoot: f.directory });
  assert.equal(internal.state, 'failed');
  for (const key of ['text', 'message', 'sessionId', 'model']) assert.equal(internal[key], '{"serviceData":"[redacted]"}');
  assert.equal(internal.diagnostics, '{"serviceData":"[redacted]"}{"serviceData":"[redacted]"}');
});

// Test Value Gate: select actual installed descriptors while rejecting old configuration,
// fixed-mode overrides and unsupported profiles instead of choosing another executor.
test('v4 exact selection permits external defaults and rejects invalid native/registry/built-in shape', async (t) => {
  const f = await fixture(t);
  for (const [adapter, mode, filename] of [['codex', 'workspace', 'codex-v4.mjs'], ['claude-code', 'workspace', 'claude-code-v4.mjs'], ['oracle', 'bundle', 'oracle-v4.mjs']]) {
    const snapshot = structuredClone(f.snapshot); snapshot.effectiveValues.subagentCommands[0] = { key: 'fixture', title: 'Fixture', adapter };
    const selected = selectExecution(snapshot, f.request);
    assert.equal(selected.mode, mode); assert.equal(selected.command, process.execPath); assert.equal(selected.entrypoint, path.join(f.installed, 'scripts', 'adapters', filename));
    snapshot.effectiveValues.subagentCommands[0].mode = mode === 'bundle' ? 'workspace' : 'bundle';
    assert.throws(() => selectExecution(snapshot, f.request), { code: 'executorInvalid' });
    snapshot.effectiveValues.subagentCommands[0] = { key: 'fixture', title: 'Fixture', adapter, command: process.execPath };
    assert.throws(() => selectExecution(snapshot, f.request), { code: 'executorInvalid' });
  }
  for (const [change, code] of [
    [(s) => { s.effectiveValues.advisorProfile = {}; }, 'profileInvalid'],
    [(s) => { s.effectiveValues.advisorProfile = { model: 'm', reasoningEffort: 'high' }; }, 'nativeUnsupported'],
    [(s) => { delete s.effectiveValues.advisorProfile; }, 'profileUnconfigured'],
    [(s) => { s.effectiveValues.advisorProfile.executor = 'missing'; }, 'executorUnknown'],
    [(s) => { s.effectiveValues.subagentCommands[0].supportsReadOnly = true; }, 'executorInvalid'],
    [(s) => { delete s.effectiveValues.subagentCommands[0].adapter; }, 'executorInvalid'],
  ]) { const snapshot = structuredClone(f.snapshot); change(snapshot); assert.throws(() => selectExecution(snapshot, f.request), { code }); }
  const selected = selectExecution(f.snapshot, { ...f.request, model: 'explicit', reasoningEffort: 'high' });
  assert.deepEqual(selected.execution, { profile: 'advisorProfile', executor: 'fixture', model: 'explicit', reasoningEffort: 'high' });
});

// Test Value Gate: wire mode and terminal conflicts must remain unknown rather than accept
// v3 or wrapper exit/text as proof of completion.
test('v4 wire rejects file fields in workspace and completion requires compatible local evidence', async (t) => {
  const f = await fixture(t); const request = (await f.prepared()).request;
  for (const fields of [{ fileSelectors: [] }, { fileResolver: { command: process.execPath, args: ['/helper'] } }, { files: [] }, { access: 'read-only' }]) assert.throws(() => validateRequest({ ...request, ...fields }), { code: 'protocolInvalid' });
  for (const [prompt, state] of [['complete', 'completed'], ['fail', 'failed'], ['preflight', 'failed'], ['unknown generation', 'unknown'], ['no terminal', 'unknown'], ['v3 result', 'unknown'], ['backend conflict', 'unknown'], ['exit conflict', 'unknown'], ['text overflow', 'unknown'], ['result overflow', 'unknown'], ['diagnostic overflow', 'unknown']]) {
    const result = await runForeground(await f.prepared({ prompt }), { temporaryRoot: f.directory });
    assert.equal(result.state, state, prompt); if (prompt === 'fail') assert.equal(result.text, 'partial');
    if (prompt === 'preflight') assert.equal(result.generationStarted, false);
    if (prompt === 'no terminal') assert.equal(result.generationStarted, null);
    if (prompt === 'diagnostic overflow') assert.equal(result.code, 'adapterOutputTooLarge');
  }
  const completed = { protocolVersion: 4, state: 'completed', generationStarted: true, backendExitCode: 0, text: 'answer' };
  assert.equal(classifyResult(completed, { adapterExitCode: 0, localTreeStopped: false, interrupted: false }).state, 'unknown');
  assert.equal(classifyResult(completed, { adapterExitCode: 0, localTreeStopped: true, interrupted: true }).state, 'unknown');
});

// Test Value Gate: input/config capture and a yielded host wait must continue one child and
// one submission without replacing an already accepted task.
test('one installed reader and one foreground call survive source/config changes and host yield', async (t) => {
  const f = await fixture(t, 'bundle'); let reads = 0;
  const request = { ...f.request, prompt: 'delay', instructionsFile: f.instructions, files: ['missing-glob*'] };
  const running = executeCommand(request, { readRuntimeConfig: async () => { reads++; return structuredClone(f.snapshot); }, temporaryRoot: f.directory, environment: f.environment });
  await waitFile(f.observed); await fs.writeFile(f.instructions, 'changed role');
  f.snapshot.effectiveValues.advisorProfile.executor = 'native'; await f.save();
  const yielded = Symbol('still running'); assert.equal(await Promise.race([running, sleep(50).then(() => yielded)]), yielded);
  const result = await running; assert.equal(result.exitCode, 0); assert.equal(reads, 1);
  const observed = await waitFile(f.observed); assert.match(observed.request.prompt, /Explicit role instructions/); assert.ok(observed.request.prompt.endsWith('delay'));
  assert.deepEqual(observed.request.fileSelectors, ['missing-glob*']); assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: cancellation/timeout must stop owned descendants while preserving unknown
// remote stop and never launching a replacement generation.
test('stop and deadline clean owned descendants with correct remote uncertainty', async (t) => {
  for (const [prompt, state, deadline] of [['sleep confirmed', 'cancelled', false], ['sleep unknown', 'unknown', false], ['cancel before generation', 'cancelled', false], ['sleep unknown', 'unknown', true]]) await t.test(prompt + (deadline ? ' deadline' : ''), async (t) => {
    const f = await fixture(t); const controller = new AbortController();
    const running = runForeground(await f.prepared({ prompt }), { temporaryRoot: f.directory, signal: controller.signal, ...(deadline ? { deadlineMs: 800 } : {}) });
    const { pid } = await waitFile(path.join(f.directory, 'child.json'));
    if (!deadline) { await sleep(300); controller.abort(); }
    const result = await running;
    assert.equal(result.state, state); assert.equal(result.localTreeStopped, true); assert.equal(result.stopRequested, true);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
  });
});

// Test Value Gate: unmarked related children remain outside signal ownership, and inherited
// pipes cannot block the caller forever or allow a false completed result.
test('unmarked descendants and inherited pipes remain unknown with bounded return and retained resources', async (t) => {
  for (const prompt of ['unowned descendant', 'unowned pipes', 'unowned pipes stop']) await t.test(prompt, async (t) => {
    const f = await fixture(t); const controller = new AbortController(); const started = Date.now();
    const running = runForeground(await f.prepared({ prompt }), { temporaryRoot: f.directory, signal: controller.signal, deadlineMs: 1200 });
    const { pid } = await waitFile(path.join(f.directory, 'child.json'));
    const original = (await processTable()).find((row) => row.pid === pid); assert.ok(original);
    t.after(async () => { const current = (await processTable()).find((row) => row.pid === pid); if (current?.started === original.started) { process.kill(pid, 'SIGTERM'); await sleep(100); } });
    if (prompt.endsWith('stop')) { await sleep(300); controller.abort(); }
    const result = await running;
    assert.ok(Date.now() - started < 5000); assert.equal(result.state, 'unknown'); assert.equal(result.localTreeStopped, false);
    assert.doesNotThrow(() => process.kill(pid, 0)); assert.ok(result.temporaryDirectory); await fs.stat(result.temporaryDirectory);
    if (prompt.includes('pipes')) assert.match(result.diagnostics, /partial diagnostics/);
  });
});
