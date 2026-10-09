import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { selectExecution } from '../skills/codex-subagent-guide/scripts/runtime/plan.mjs';
import { oracleArguments } from '../skills/codex-subagent-guide/scripts/adapters/oracle-arguments.mjs';

const require = createRequire(import.meta.url);
const sourceScripts = path.dirname(require.resolve('../skills/codex-subagent-guide/scripts/resolve-files.mjs'));
const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const supported = ['darwin', 'linux'].includes(process.platform);
const entries = {
  codex: require.resolve('../skills/codex-subagent-guide/scripts/adapters/codex-v4.mjs'),
  claude: require.resolve('../skills/codex-subagent-guide/scripts/adapters/claude-code-v4.mjs'),
  oracle: require.resolve('../skills/codex-subagent-guide/scripts/adapters/oracle-v4.mjs'),
};
const answer = 'Complete **answer**.\n第二行。';

// Test Value Gate: these fake executables protect the real argv/stdin/env/cwd
// boundary and prevent acceptance, exit 0, or partial output becoming success.
async function fixture(t, backend = 'codex', scenario = 'success') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-v4-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const guide = path.join(directory, 'moved-guide');
  await fs.cp(sourceScripts, path.join(guide, 'scripts'), { recursive: true });
  const selection = path.join(guide, 'scripts/file-selection/selection.mjs');
  // The installed runtime must work without the development node_modules tree.
  if (process.env.AW_PLUGIN_EVENT !== 'test') {
    const bundled = await build({ entryPoints: [selection], nodePaths: [path.join(packageRoot, 'node_modules')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, legalComments: 'inline', logLevel: 'silent', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    await fs.writeFile(selection, bundled.outputFiles[0].contents);
  }
  const workspace = path.join(directory, 'workspace');
  const home = path.join(directory, 'home');
  const runDirectory = path.join(directory, 'run');
  const bin = path.join(directory, 'bin');
  for (const value of [workspace, home, runDirectory, bin]) await fs.mkdir(value, { mode: 0o700 });
  await fs.writeFile(path.join(workspace, 'main.ts'), 'export const value = 1;\n');
  const capture = path.join(directory, 'capture.json');
  const calls = path.join(directory, 'calls.log');
  const resultFile = path.join(runDirectory, 'result.json');
  const program = `#!${process.execPath}
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
await fs.appendFile(process.env.FIXTURE_CALLS, 'call\\n');
await fs.writeFile(process.env.FIXTURE_CAPTURE, JSON.stringify({args,input,cwd:process.cwd(),environment:{HOME:process.env.HOME,NORMAL_SETTING:process.env.NORMAL_SETTING,OPENAI_API_KEY:process.env.OPENAI_API_KEY,marker:process.env.AW_SUBAGENT_PROCESS_TOKEN}}));
const scenario = process.env.FIXTURE_CASE;
const backend = process.env.FIXTURE_BACKEND;
const answer = ${JSON.stringify(answer)};
if (scenario === 'interrupt') { await new Promise(resolve => setTimeout(resolve, 8000)); process.exit(1); }
if (scenario === 'authentication error') { process.stderr.write('Authentication rejected: '+process.env.OPENAI_API_KEY+'\\n'); process.exit(1); }
if (scenario === 'diagnostic overflow') { process.stdout.write(Buffer.alloc(8388609, 120)); await new Promise(resolve => setTimeout(resolve, 1000)); process.exit(1); }
const output = args[args.indexOf(backend === 'codex' ? '--output-last-message' : '--write-output') + 1];
if (backend === 'codex') {
  const events = [{type:'thread.started',thread_id:'fixture-thread'},{type:'turn.started'}];
  if (scenario === 'failure') events.push({type:'turn.failed',error:{message:'model unavailable'}});
  else {
    const final = scenario === 'answer overflow' ? 'x'.repeat(4194305) : answer;
    await fs.writeFile(output, scenario === 'mismatch' ? 'different answer' : final);
    events.push({type:'item.completed',item:{id:'a',type:'agent_message',text:final}});
    if (scenario !== 'no terminal') events.push({type:'turn.completed',usage:{input_tokens:8,output_tokens:4}});
    if (scenario === 'conflicting terminal') events.push({type:'turn.failed',error:{message:'late failure'}});
  }
  for (const event of events) process.stdout.write(JSON.stringify(event)+'\\n');
} else if (backend === 'claude') {
  const value = scenario === 'failure' ? {type:'result',subtype:'error_max_budget_usd',is_error:true,num_turns:1,session_id:'fixture-session',errors:['budget exceeded']} : {type:'result',subtype:'success',is_error:false,num_turns:1,session_id:'fixture-session',result:answer};
  if (scenario === 'invalid terminal') delete value.subtype;
  if (scenario === 'empty answer') value.result = '   ';
  process.stdout.write(JSON.stringify(value));
} else {
  process.stdout.write('Request accepted. Session is ready.\\n');
  if (scenario !== 'no terminal') await fs.writeFile(output, answer);
}
process.exit(scenario === 'failure' || scenario === 'nonzero' ? 1 : 0);
`;
  await fs.writeFile(path.join(bin, backend), program, { mode: 0o700 });
  const environment = {
    PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home,
    LANG: 'C.UTF-8', NORMAL_SETTING: 'preserved setting', OPENAI_API_KEY: 'synthetic-test-key',
    AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'), AW_SUBAGENT_TEMP_DIR: runDirectory, AW_SUBAGENT_RESULT_FILE: resultFile,
    FIXTURE_CASE: scenario, FIXTURE_BACKEND: backend, FIXTURE_CAPTURE: capture, FIXTURE_CALLS: calls,
  };
  const request = { protocolVersion: 4, execution: { profile: 'generalTaskProfile', executor: 'fixture' }, mode: backend === 'oracle' ? 'bundle' : 'workspace', workspace, prompt: ' 原始任务\nQuotes: " ` $() \\n\n', args: [] };
  if (backend === 'oracle') Object.assign(request, { fileSelectors: [], fileResolver: { command: process.execPath, args: [path.join(guide, 'scripts/resolve-files.mjs')] } });
  const entry = path.join(guide, 'scripts/adapters', path.basename(entries[backend]));
  return { directory, guide, workspace, home, runDirectory, bin, capture, calls, resultFile, environment, request, entry };
}

async function run(f, { signalAfterCapture = false } = {}) {
  const child = spawn(process.execPath, [f.entry], { env: f.environment, cwd: f.workspace, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise((resolve) => child.once('close', resolve));
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(f.request));
  if (signalAfterCapture) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.access(f.capture); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    child.kill('SIGTERM');
  }
  const code = await completion;
  const result = JSON.parse(await fs.readFile(f.resultFile, 'utf8'));
  let capture;
  try { capture = JSON.parse(await fs.readFile(f.capture, 'utf8')); } catch {}
  return { code, result, capture, stdout, stderr };
}

for (const backend of Object.keys(entries)) {
  test(`${backend}: moved adapter uses one prompt and normal backend configuration`, { skip: !supported }, async (t) => {
    const f = await fixture(t, backend);
    f.request.args = backend === 'codex' ? ['--config', 'features.hooks=true', '--sandbox', 'workspace-write'] : backend === 'claude' ? ['--allowedTools', 'Read', 'Bash', '--plugin-dir', '/explicit/plugin'] : ['--engine', 'api', '--background'];
    const { code, result, capture, stdout, stderr } = await run(f);
    assert.equal(code, 0, JSON.stringify(result)); assert.equal(result.state, 'completed'); assert.equal(result.generationStarted, true); assert.equal(result.backendExitCode, 0); assert.equal(result.text, answer);
    assert.equal(capture.input, f.request.prompt); assert.equal(capture.cwd, f.workspace);
    assert.deepEqual(capture.environment, { HOME: f.home, NORMAL_SETTING: 'preserved setting', OPENAI_API_KEY: 'synthetic-test-key', marker: f.environment.AW_SUBAGENT_PROCESS_TOKEN });
    const outputFile = path.join(f.runDirectory, `${backend}-answer.md`);
    const expected = backend === 'codex' ? ['exec', '--json', '--output-last-message', outputFile, ...f.request.args, '-'] : backend === 'claude' ? ['--print', '--output-format', 'json', ...f.request.args] : ['--prompt', '-', '--wait', '--write-output', outputFile, ...f.request.args];
    assert.deepEqual(capture.args, expected);
    assert.equal(await fs.readFile(f.calls, 'utf8'), 'call\n');
    assert.equal(stdout, ''); assert.equal(stderr, '');
    assert.equal((await fs.stat(f.resultFile)).mode & 0o077, 0);
    assert.equal((await fs.readdir(f.runDirectory)).some((name) => name.endsWith('.tmp')), false);
  });
}

test('Oracle preserves every raw selector and never runs the supplied helper', { skip: !supported }, async (t) => {
  const f = await fixture(t, 'oracle');
  f.request.fileSelectors = ['  *.ts,!**/*.test.ts  ', 'main.ts', 'main.ts', '!missing/**'];
  const helper = path.join(f.guide, 'scripts/resolve-files.mjs');
  await fs.writeFile(helper, "throw new Error('Oracle must not run helper');\n");
  const { result, capture } = await run(f);
  assert.equal(result.state, 'completed');
  assert.deepEqual(capture.args.slice(5), f.request.fileSelectors.flatMap((value) => ['--file', value]));
  assert.deepEqual((await fs.readdir(f.runDirectory)).sort(), ['oracle-answer.md', 'result.json']);
});

for (const backend of ['codex', 'claude', 'oracle']) {
  test(`${backend}: explicit model and effort map once`, { skip: !supported }, async (t) => {
    const f = await fixture(t, backend);
    Object.assign(f.request.execution, { model: 'fixture-model', reasoningEffort: 'high' });
    if (backend === 'oracle') f.request.args = ['--engine', 'api'];
    const { capture, result } = await run(f);
    assert.equal(result.state, 'completed');
    assert.equal(capture.args[capture.args.indexOf('--model') + 1], 'fixture-model');
    if (backend === 'codex') assert.ok(capture.args.includes('model_reasoning_effort="high"'));
    else assert.equal(capture.args[capture.args.indexOf(backend === 'claude' ? '--effort' : '--reasoning-effort') + 1], 'high');
  });
  test(`${backend}: args can own omitted model and effort`, { skip: !supported }, async (t) => {
    const f = await fixture(t, backend);
    f.request.args = backend === 'codex' ? ['-mfixture-model', '-cmodel_reasoning_effort="high"'] : backend === 'claude' ? ['--model=fixture-model', '--effort=high'] : ['-eapi', '-mfixture-model', '--reasoning-effort=high'];
    const { capture, result } = await run(f);
    assert.equal(result.state, 'completed');
    assert.ok(f.request.args.every((argument) => capture.args.includes(argument)));
  });
}

const conflicts = {
  codex: [['-oother.md'], ['--json=false'], ['--cd', '/other'], ['resume'], ['--help'], ['--model=other'], ['-c', '"model_reasoning_effort"="low"']],
  claude: [['-pother'], ['--output-format=stream-json'], ['-rprevious'], ['--input-format', 'stream-json'], ['--model', 'other'], ['--effort=low'], ['--cloud'], ['--cloud', 'session_fixture'], ['--cloud=session_fixture'], ['--remote', 'session_fixture'], ['--remote=session_fixture'], ['--environment', 'ccpool_fixture'], ['--environment=ccpool_fixture'], ['--teleport'], ['--teleport', 'session_fixture'], ['--teleport=session_fixture']],
  oracle: [['-fmain.ts'], ['--include=main.ts'], ['--files', 'main.ts'], ['--path=main.ts'], ['--paths=main.ts'], ['--message=other'], ['--no-wait'], ['--models', 'a,b'], ['--browser-follow-up', 'another prompt'], ['--browser-tab', 'current'], ['--render'], ['--followup', 'old'], ['--model=other'], ['--reasoning-effort=low'], ['--browser-thinking-time=pro']],
};
for (const [backend, values] of Object.entries(conflicts)) {
  test(`${backend}: owned controls and aliases fail before backend startup`, { skip: !supported }, async (t) => {
    for (const args of values) {
      const f = await fixture(t, backend);
      f.request.args = args;
      Object.assign(f.request.execution, { model: 'fixture-model', reasoningEffort: 'high' });
      const { result, capture, code } = await run(f);
      assert.equal(code, 1, JSON.stringify(args)); assert.equal(result.state, 'failed', JSON.stringify(args));
      assert.equal(result.code, 'adapterArgumentConflict', JSON.stringify(args)); assert.equal(result.generationStarted, false); assert.equal(capture, undefined);
      await assert.rejects(fs.readFile(f.calls, 'utf8'), { code: 'ENOENT' });
    }
  });
}

// Test Value Gate: configured convenience fields must reach the real backend argv
// without changing the Adapter v4 execution selection or its omitted defaults.
function selectExecutor(executor, execution = {}) {
  const profile = 'generalTaskProfile';
  return selectExecution({ installedIdentity: {}, resourceRoot: sourceScripts,
    effectiveValues: { [profile]: { executor: 'fixture', ...execution },
      subagentCommands: [{ key: 'fixture', title: 'Fixture', ...executor }] },
  }, { profile });
}

test('executor fields compile to backend arguments and reject duplicate controls', () => {
  assert.deepEqual(selectExecutor({ adapter: 'oracle', oracleEngine: 'browser' }).executor.args, ['--engine', 'browser']);
  assert.deepEqual(selectExecutor({ adapter: 'codex', codexProfile: 'review profile' }).executor.args, ['--profile', 'review profile']);
  for (const adapter of ['oracle', 'codex']) assert.deepEqual(selectExecutor({ adapter }).executor.args, []);
  for (const [adapter, fields, options] of [
    ['oracle', { oracleEngine: 'browser' }, [['--engine', 'browser'], ['--engine=api'], ['-ebrowser'], ['--mode=browser'], ['--browser']]],
    ['codex', { codexProfile: 'review' }, [['--profile', 'review'], ['--profile=review'], ['-preview'], ['-p', 'review']]],
  ]) for (const args of options) {
    assert.throws(() => selectExecutor({ adapter, ...fields, args }), { code: 'adapterArgumentConflict' });
  }
  for (const executor of [
    { adapter: 'codex', oracleEngine: 'browser' }, { adapter: 'oracle', codexProfile: 'review' },
    { adapter: 'claude-code', oracleEngine: 'api' }, { adapter: 'oracle', oracleEngine: 'auto' },
    ...['', '  ', '\0', 'x'.repeat(4097)].map((codexProfile) => ({ adapter: 'codex', codexProfile })),
  ]) assert.throws(() => selectExecutor(executor), { code: 'executorInvalid' });
  assert.deepEqual(selectExecutor({ adapter: 'codex', codexProfile: 'review', args: ['--config', '--profile'] }).executor.args,
    ['--config', '--profile', '--profile', 'review']);
});

test('Codex profile reaches the backend with explicit AW model and effort', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const plan = selectExecutor({ adapter: 'codex', codexProfile: 'review profile' }, { model: 'fixture-model', reasoningEffort: 'high' });
  Object.assign(f.request, { args: plan.executor.args, execution: plan.execution });
  const { result, capture } = await run(f);
  assert.equal(result.state, 'completed');
  assert.deepEqual(capture.args.slice(4), ['--profile', 'review profile', '--model', 'fixture-model', '--config', 'model_reasoning_effort="high"', '-']);
  assert.equal(f.request.execution.profile, 'generalTaskProfile');
});

// Required Oracle option values may begin with '-'; they must not select an
// engine or conflict with AW-owned controls when the backend consumes a value.
test('Oracle required option values do not become adapter controls', () => {
  const args = ['--slug', '--browser', '--browser-chrome-profile', '--model', '--perf-trace-path', '--reasoning-effort'];
  const plan = selectExecutor({ adapter: 'oracle', oracleEngine: 'api', args }, { model: 'fixture-model', reasoningEffort: 'high' });
  const request = { args: plan.executor.args, execution: plan.execution, fileSelectors: [] };
  assert.deepEqual(oracleArguments(request, '/answer.md'), ['--prompt', '-', '--wait', '--write-output', '/answer.md',
    ...args, '--engine', 'api', '--model', 'fixture-model', '--reasoning-effort', 'high']);
  const legacy = ['--slug', '--browser', '--engine', 'api'];
  assert.deepEqual(oracleArguments({ args: legacy, execution: {}, fileSelectors: [] }, '/answer.md').slice(5), legacy);
  assert.throws(() => oracleArguments({ ...request, args: ['--slug', '--browser'] }, '/answer.md'), { code: 'parameterUnavailable' });
  assert.throws(() => selectExecutor({ adapter: 'oracle', oracleEngine: 'api', args: [...args, '--browser'] }), { code: 'adapterArgumentConflict' });
  assert.throws(() => oracleArguments({ ...request, args: [...request.args, '--reasoning-effort', 'low'] }, '/answer.md'), { code: 'adapterArgumentConflict' });
});

test('Oracle browser maps effort values and aliases without an API effort', { skip: !supported }, async (t) => {
  const mappings = { low: 'light', medium: 'standard', high: 'extended', xhigh: 'extra-high', pro: 'pro', heavy: 'heavy',
    light: 'light', standard: 'standard', extended: 'extended', 'extra-high': 'extra-high', instant: 'light',
    ' EXTRA_HIGH ': 'extra-high', extrahigh: 'extra-high', 'extra high': 'extra-high' };
  const selectors = [['--engine', 'browser'], ['--engine=browser'], ['-ebrowser'], ['--mode', 'browser'], ['--browser']];
  for (const [index, [reasoningEffort, expected]] of Object.entries(mappings).entries()) {
    const f = await fixture(t, 'oracle');
    f.request.args = index === 0 ? selectExecutor({ adapter: 'oracle', oracleEngine: 'browser' }).executor.args : selectors[index % selectors.length];
    f.request.execution.reasoningEffort = reasoningEffort;
    const { result, capture } = await run(f);
    assert.equal(result.state, 'completed', reasoningEffort);
    assert.deepEqual(capture.args.slice(-2), ['--browser-thinking-time', expected]);
    assert.equal(capture.args.includes('--reasoning-effort'), false);
  }
});

test('Oracle unsupported effort and ambiguous engine fail before any backend starts', { skip: !supported }, async (t) => {
  const cases = [
    { args: [], environment: { ORACLE_ENGINE: 'browser' } }, { args: [], environment: { ORACLE_ENGINE: 'api' } },
    ...['max', 'ultra', 'unknown'].map((reasoningEffort) => ({ args: ['--engine=browser'], reasoningEffort })),
    { args: ['--browser'], model: 'Gemini-3.1-pro' },
    ...[['--model', 'gemini-3.1-pro'], ['--model=gemini-3.1-pro'], ['-mgemini-3.1-pro']].map((args) => ({ args: ['--browser', ...args] })),
  ];
  for (const value of cases) {
    const f = await fixture(t, 'oracle');
    f.request.args = value.args;
    f.request.execution.reasoningEffort = value.reasoningEffort ?? 'high';
    if (value.model) f.request.execution.model = value.model;
    Object.assign(f.environment, value.environment);
    const { result, capture } = await run(f);
    assert.equal(result.state, 'failed'); assert.equal(result.code, 'parameterUnavailable');
    assert.equal(result.generationStarted, false); assert.equal(capture, undefined);
    await assert.rejects(fs.readFile(f.calls), { code: 'ENOENT' });
  }
});

test('Oracle preserves omitted effort and API values, and refuses conflicting engine selectors', { skip: !supported }, async (t) => {
  for (const args of [['--engine=api', '--browser'], ['-eapi', '--mode=browser'], ['--engine', 'browser', '--engine', 'api']]) {
    const f = await fixture(t, 'oracle'); f.request.args = args;
    const { result, capture } = await run(f);
    assert.equal(result.code, 'adapterArgumentConflict'); assert.equal(result.generationStarted, false); assert.equal(capture, undefined);
  }
  for (const args of [[], ['--browser', '-mgemini-3.1-pro'], ['--browser', '--browser-thinking-time=pro'], ['--engine=browser', '--mode=browser']]) {
    const f = await fixture(t, 'oracle'); f.request.args = args; f.environment.ORACLE_ENGINE = 'browser';
    const { result, capture } = await run(f);
    assert.equal(result.state, 'completed'); assert.deepEqual(capture.args.slice(5), args);
  }
  const f = await fixture(t, 'oracle');
  f.request.args = selectExecutor({ adapter: 'oracle', oracleEngine: 'api' }).executor.args;
  f.request.execution.reasoningEffort = 'pro';
  const { result, capture } = await run(f);
  assert.equal(result.state, 'completed'); assert.deepEqual(capture.args.slice(-2), ['--reasoning-effort', 'pro']);
  assert.equal(capture.args.includes('--reasoning-mode'), false);
});

for (const [backend, scenarios] of Object.entries({ codex: ['no terminal', 'mismatch', 'conflicting terminal', 'nonzero', 'answer overflow', 'diagnostic overflow'], claude: ['invalid terminal', 'empty answer', 'nonzero'], oracle: ['no terminal', 'nonzero'] })) {
  test(`${backend}: missing, conflicting or incomplete terminal is unknown`, { skip: !supported }, async (t) => {
    for (const scenario of scenarios) {
      const f = await fixture(t, backend, scenario);
      const { result, code } = await run(f);
      assert.equal(code, 1, scenario); assert.equal(result.state, 'unknown', scenario); assert.notEqual(result.generationStarted, false, scenario);
      assert.equal(await fs.readFile(f.calls, 'utf8'), 'call\n');
    }
  });
}

for (const backend of ['codex', 'claude']) {
  test(`${backend}: actual failure terminal remains failed`, { skip: !supported }, async (t) => {
    const f = await fixture(t, backend, 'failure');
    const { result, code } = await run(f);
    assert.equal(code, 1); assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, true); assert.equal(result.backendExitCode, 1); assert.equal(result.code, 'backendFailed');
  });
}

test('missing backend is a confirmed failure before generation', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.bin, 'codex')); f.environment.PATH = f.bin;
  const { result, capture } = await run(f);
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false); assert.equal(result.code, 'backendExecutableMissing'); assert.equal(capture, undefined);
});

test('unconfirmed backend error retains a bounded, redacted actual diagnostic', { skip: !supported }, async (t) => {
  const f = await fixture(t, 'oracle', 'authentication error');
  const { result } = await run(f);
  assert.equal(result.state, 'unknown'); assert.equal(result.generationStarted, null);
  assert.equal(result.message, 'Authentication rejected: [redacted]');
  assert.equal(await fs.readFile(f.calls, 'utf8'), 'call\n');
});

test('workspace file fields and v3 requests never start a backend', { skip: !supported }, async (t) => {
  for (const patch of [{ fileSelectors: [] }, { fileResolver: { command: process.execPath, args: ['/tmp/helper.mjs'] } }, { files: [] }, { protocolVersion: 3 }]) {
    const f = await fixture(t); Object.assign(f.request, patch);
    const { result, capture } = await run(f);
    assert.equal(result.state, 'unknown'); assert.equal(result.code, 'protocolInvalid'); assert.equal(result.generationStarted, false); assert.equal(capture, undefined);
  }
});

test('Oracle suppressed ignore read error fails before model submission', { skip: !supported }, async (t) => {
  const f = await fixture(t, 'oracle');
  const ignore = path.join(f.workspace, '.gitignore');
  await fs.writeFile(ignore, '*.ts\n', { mode: 0o000 });
  t.after(() => fs.chmod(ignore, 0o600).catch(() => {}));
  f.request.fileSelectors = ['**/*.ts'];
  const { result, capture } = await run(f);
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false); assert.equal(result.code, 'fileSelectionReadFailed'); assert.equal(capture, undefined);
});

test('interrupt leaves remote stop unknown and never resubmits', { skip: !supported }, async (t) => {
  const f = await fixture(t, 'oracle', 'interrupt');
  const { result, code } = await run(f, { signalAfterCapture: true });
  assert.equal(code, 1); assert.equal(result.state, 'unknown'); assert.equal(result.remoteStopConfirmed, false); assert.equal(result.generationStarted, null);
  assert.equal(await fs.readFile(f.calls, 'utf8'), 'call\n');
});
