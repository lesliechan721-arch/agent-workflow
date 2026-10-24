import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRun, observeRun, openRun, storeContext, workerAlive } from '../skills/codex-subagent-guide/scripts/runtime/store.mjs';
import { protectPrivatePath, verifyPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const require = createRequire(import.meta.url);
const registeredEntry = require.resolve('../skills/codex-subagent-guide/scripts/subagent.mjs');
const registeredWorker = require.resolve('../skills/codex-subagent-guide/scripts/worker.mjs');
const registeredClock = require.resolve('./fixtures/subagent-clock.mjs');
const sourceScripts = guideRuntimeScripts(import.meta.url);
const sourceEntry = path.join(sourceScripts, path.basename(registeredEntry));
const sourceWorker = path.join(sourceScripts, path.basename(registeredWorker));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const terminalPattern = /^state: (completed|failed|cancelled|unknown)$/m;
const displayLimit = 8192;
const messageLimit = 4096;
const windows = process.platform === 'win32';
const batchObservationMs = windows ? 120000 : 5000;

// This external v5 adapter owns a separate, bounded local backend process. Every
// completion uses the observed backend exit code. No model runs in these tests.
const fakeAdapter = String.raw`
import fs from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
const scenario = JSON.parse(await fs.readFile(process.env.FIXTURE_SCENARIO_FILE, 'utf8'));
const root = process.env.FIXTURE_RUN_DIRECTORY;
const hardStop = setTimeout(() => process.exit(3), scenario.adapterLifetimeMs ?? (process.platform === 'win32' ? 905000 : 95000));
process.stdout.on('error', () => process.exit(0));
let backend, backendExit, ready = false, finishing = false;
const watchers = new Set();
const phase = (name) => fs.appendFile(root + '/phases.jsonl', JSON.stringify({ phase: name, time: Date.now() }) + '\n');
const signal = (name) => new Promise((resolve, reject) => {
  const watcher = watch(root, () => { void check(); });
  watchers.add(watcher);
  const close = () => { watcher.close(); watchers.delete(watcher); };
  async function check() {
    try { await fs.stat(root + '/' + name); close(); resolve(); }
    catch (error) { if (error.code !== 'ENOENT') { close(); reject(error); } }
  }
  watcher.once('error', (error) => { close(); reject(error); });
  void check();
});
const emit = (event) => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify({ protocolVersion: 5, ...event }) + '\n', (error) => error ? reject(error) : resolve());
});
async function finish(stopped = false) {
  if (finishing) return;
  finishing = true;
  for (const watcher of watchers) watcher.close();
  watchers.clear();
  await phase('finishing');
  let backendExitCode = null;
  if (backend) {
    if (backend.connected) backend.send(stopped ? 'cancel' : 'finish');
    backendExitCode = await backendExit;
  }
  await phase('backendExited');
  if (ready) await emit({ type: 'closing', reason: stopped ? 'cancelled' : 'completed' });
  const state = stopped ? 'cancelled' : scenario.state ?? 'completed';
  const finalText = scenario.secretOutput ? JSON.stringify({ serviceData: process.env.SERVICE_DATA }) : scenario.finalText ?? 'Complete final answer.';
  if (scenario.secretOutput) process.stderr.write(finalText);
  await emit({ type: 'result', state, generationStarted: ready, backendExitCode,
    text: stopped ? '' : finalText,
    ...(state === 'completed' ? {} : { code: stopped ? 'fixtureStopped' : 'fixtureFailed' }),
    ...(stopped ? { remoteStopConfirmed: true } : {}) });
  await fs.writeFile(root + '/finished.json', JSON.stringify({ backendExitCode }));
  await phase('resultSent');
  clearTimeout(hardStop);
  process.exit(0);
}
async function start(frame) {
  await phase('startReceived');
  await fs.appendFile(process.env.FIXTURE_GENERATIONS, 'generation\n');
  const environment = Object.fromEntries(['SOURCE', 'SERVICE_DATA', 'EMPTY', 'EMPTY_REFERENCE', 'ORDINARY_HOST',
    'AW_PLUGIN_CONTEXT', 'AW_SUBAGENT_TEMP_DIR'].map((key) => [key, process.env[key]]));
  const observed = { request: frame, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), environment };
  if (scenario.initializationFailure) {
    await fs.writeFile(root + '/observed.json', JSON.stringify(observed));
    await emit({ type: 'result', state: 'failed', generationStarted: false, backendExitCode: null,
      text: '', code: 'fixtureInitializationFailed', message: 'Fixture initialization failed.' });
    process.exit(0);
  }
  if (scenario.scratchText) {
    observed.scratchFile = path.join(frame.runtime.directory, 'fixture-scratch', 'raw-input.txt');
    await fs.mkdir(path.dirname(observed.scratchFile), { recursive: true });
    await fs.writeFile(observed.scratchFile, scenario.scratchText, { mode: 0o600 });
  }
  backend = spawn(process.execPath, ['-e', "setTimeout(()=>process.exit(4),Number(process.argv[1]));process.on('message',()=>process.exit(0));process.on('disconnect',()=>process.exit(0))", String(scenario.backendLifetimeMs ?? (process.platform === 'win32' ? 900000 : 90000))],
    { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false });
  backendExit = new Promise((resolve) => backend.once('close', resolve));
  observed.backendPid = backend.pid;
  await fs.writeFile(root + '/observed.json', JSON.stringify(observed));
  await phase('backendStarted');
  if (scenario.readyGate) { await phase('readyGateWaiting'); await signal('ready'); }
  if (scenario.readyDelay) await new Promise((resolve) => setTimeout(resolve, scenario.readyDelay));
  if (finishing) return;
  await emit({ type: 'ready', communicationSupported: scenario.communication ?? true });
  ready = true;
  await phase('readySent');
  for (const text of scenario.messages ?? []) await emit({ type: 'message', text });
  await fs.writeFile(root + '/published.json', '{}');
  await phase('published');
  if (scenario.finishImmediately) { await finish(); return; }
  void signal('finish').then(() => finish()).catch(() => process.exit(2));
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.type === 'start') { void start(frame).catch(() => process.exit(2)); continue; }
  if (frame.type === 'stop') { void finish(true).catch(() => process.exit(2)); continue; }
  if (frame.type === 'message') {
    await fs.appendFile(root + '/inputs.jsonl', JSON.stringify(frame) + '\n');
    const status = scenario.delivery ?? 'submitted';
    await emit({ type: 'delivery', id: frame.id, status,
      ...(status === 'submitted' ? {} : { code: 'fixtureDeliveryUnknown', message: 'Fixture input submission is unknown.' }) });
    if (scenario.echo) await emit({ type: 'message', text: frame.text });
  }
}
if (!finishing) await finish(true).catch(() => {});
`;

async function eventually(read, description, milliseconds = windows ? 30000 : 5000) {
  const end = Date.now() + milliseconds;
  let latest;
  do {
    try { const value = await read(); if (value) return value; }
    catch (error) { latest = error; }
    await sleep(25);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${description}.`, { cause: latest });
}
const blockPattern = /^BEGIN_(MESSAGE|INPUT|FINAL|DIAGNOSTIC):([a-f0-9]{8})\n([\s\S]*?)\nEND_\1:\2\n/gm;
function blocks(output, kind) {
  return [...output.matchAll(blockPattern)].filter((match) => match[1] === kind).map((match) => match[3]);
}
function field(output, key) {
  return output.replace(blockPattern, '').match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1];
}
function bounded(result) {
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= displayLimit, 'Response exceeds 8192 bytes.');
  assert.ok(Buffer.byteLength(result.stderr) <= 1024, 'Diagnostics exceed 1024 bytes.');
}
function successful(result, command) {
  assert.equal(result.code, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`^${command}: `));
}

async function fixture(t, mode = 'workspace', { diagnostics = false } = {}) {
  const began = performance.now();
  const phases = []; const scenarios = [];
  function phase(name, values = {}) {
    const value = { phase: name, elapsedMs: Math.round(performance.now() - began), ...values };
    phases.push(value);
    if (diagnostics || process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') t.diagnostic(`AW_SUBAGENT_PARENT_PHASE ${JSON.stringify(value)}`);
  }
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-parent-runtime-test-'));
  const temporaryRoot = path.join(directory, 'temporary');
  const workspace = path.join(directory, 'workspace 中文');
  const installed = path.join(directory, 'installed guide 中文');
  const generations = path.join(directory, 'generations.log');
  await Promise.all([fs.mkdir(temporaryRoot), fs.mkdir(workspace), fs.mkdir(installed)]);
  await fs.cp(sourceScripts, path.join(installed, 'scripts'), { recursive: true });
  await fs.access(path.join(installed, 'scripts', path.relative(sourceScripts, sourceWorker)));
  const adapter = path.join(directory, 'fake-adapter.mjs');
  await fs.writeFile(adapter, fakeAdapter);
  const clockPreload = path.join(directory, 'fixture-clock.mjs');
  await fs.copyFile(registeredClock, clockPreload);
  const snapshot = { installedIdentity: { source: 'fixture', plugin: 'fixture', platform: 'codex', scope: 'user' }, resourceRoot: installed,
    effectiveValues: { advisorProfile: { executor: 'fixture' }, generalTaskProfile: { executor: 'fixture' },
      subagentCommands: [{ key: 'fixture', title: 'Fixture', adapter: 'custom', mode, command: await fs.realpath(process.execPath), entrypoint: adapter }] } };
  const config = path.join(installed, 'effective.json');
  const save = () => fs.writeFile(config, JSON.stringify(snapshot));
  await save();
  await fs.writeFile(path.join(installed, 'scripts', 'aw-runtime-config.mjs'),
    "import fs from 'node:fs/promises';export async function readRuntimeConfig(){return JSON.parse(await fs.readFile(new URL('../effective.json',import.meta.url),'utf8'));}\n");
  const entry = path.join(installed, 'scripts', path.relative(sourceScripts, sourceEntry));
  // Windows native tools need their normal host environment. Normalize names so
  // the isolated paths below replace host values without mixed-case duplicates.
  const nativeEnvironment = process.platform === 'win32'
    ? Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value])) : {};
  const environment = { ...nativeEnvironment, PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, CODEX_HOME: directory,
    AW_HOME: directory, AW_CODEX_HOME: directory, AW_CLAUDE_HOME: directory,
    TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot };
  const handles = new Set();
  let nextScenario = 0, nextClock = 0;
  function command(args, { stdin, env = {}, cwd = workspace, breakOutput = false, timeout = windows ? 120000 : 35000, nodeArgs = [] } = {}) {
    return new Promise((resolve, reject) => {
      const began = performance.now();
      phase('commandBegin', { operation: args[0] });
      const child = spawn(process.execPath, [...nodeArgs, entry, ...args], { cwd, env: { ...environment, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = [], diagnostics = [];
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', (chunk) => { output.push(chunk); if (breakOutput) child.stdout.destroy(); });
      child.stderr.on('data', (chunk) => diagnostics.push(chunk));
      child.once('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(output).toString('utf8');
        for (const match of stdout.matchAll(/^run: ([\x21-\x7e]+)$/gm)) handles.add(match[1]);
        const response = { code, stdout, stderr: Buffer.concat(diagnostics).toString('utf8'), elapsedMs: Math.round(performance.now() - began) };
        phase('commandEnd', { operation: args[0], code, commandElapsedMs: response.elapsedMs, state: field(stdout, 'state'), communication: field(stdout, 'communication'), errorCode: field(stdout, 'code'), timedOut });
        if (timedOut) { reject(new Error(`Fixture command timed out: ${args[0]}\n${JSON.stringify(phases)}`)); return; }
        resolve(response);
      });
      child.stdin.on('error', () => {}); child.stdin.end(stdin);
    });
  }
  async function start(scenario = {}, { prompt = 'Assigned fixture task.', extra = [], env = {}, stdin, cwd } = {}) {
    const runDirectory = path.join(directory, `scenario-${++nextScenario}`);
    const index = nextScenario;
    scenarios.push({ index, directory: runDirectory });
    await fs.mkdir(runDirectory);
    const scenarioFile = path.join(runDirectory, 'scenario.json');
    await fs.writeFile(scenarioFile, JSON.stringify(scenario));
    const response = await command(['start', '--profile', 'advisorProfile', '--workspace', workspace, '--prompt', prompt, ...extra],
      { env: { ...env, FIXTURE_SCENARIO_FILE: scenarioFile, FIXTURE_RUN_DIRECTORY: runDirectory, FIXTURE_GENERATIONS: generations }, stdin, cwd });
    const run = field(response.stdout, 'run');
    phase('startReturned', { scenario: index, code: response.code, state: field(response.stdout, 'state'), communication: field(response.stdout, 'communication') });
    return { ...response, run, runDirectory, scenario,
      observed: () => eventually(async () => JSON.parse(await fs.readFile(path.join(runDirectory, 'observed.json'), 'utf8')), 'adapter start'),
      published: () => eventually(() => fs.stat(path.join(runDirectory, 'published.json')), 'adapter ready and messages', windows ? 120000 : 15000),
      releaseReady: async () => { phase('releaseReady', { scenario: index }); await fs.writeFile(path.join(runDirectory, 'ready'), ''); },
      finish: async () => { phase('finishRequested', { scenario: index }); await fs.writeFile(path.join(runDirectory, 'finish'), ''); },
      finished: () => eventually(() => fs.stat(path.join(runDirectory, 'finished.json')), 'adapter final and backend exit', windows ? 120000 : 15000),
      inputs: (count) => eventually(async () => {
        const entries = (await fs.readFile(path.join(runDirectory, 'inputs.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
        return entries.length >= count && entries;
      }, 'parent input submission', batchObservationMs),
    };
  }
  async function initialized(started) {
    assert.match(started.run ?? '', /^aw5-[a-f0-9]{32}-[a-f0-9]{32}$/);
    if (started.code === 0) { successful(started, 'start'); return; }
    assert.equal(started.code, 1, started.stdout + started.stderr);
    assert.match(started.stdout, /^start: notReady\n/);
    assert.equal(field(started.stdout, 'state'), 'starting');
    assert.equal(field(started.stdout, 'communication'), 'pending');
    assert.equal(field(started.stdout, 'code'), 'startupNotReady');
    t.diagnostic(`AW_SUBAGENT_PARENT_PHASE ${JSON.stringify({ phase: 'continueSamePendingRun', elapsedMs: started.elapsedMs })}`);
    if (started.scenario.readyGate) await started.releaseReady();
    await started.published();
    // A resultNotReady response reports the real running state without consuming
    // messages. Fast terminal cases retain their first original wait/result read.
    if (!started.scenario.finishImmediately) await eventually(async () => {
      const response = await command(['result', '--run', started.run]);
      assert.equal(field(response.stdout, 'code'), 'resultNotReady', response.stdout + response.stderr);
      assert.equal(response.code, 1); bounded(response);
      const state = field(response.stdout, 'state');
      assert.ok(['starting', 'running'].includes(state), response.stdout);
      return state === 'running';
    }, 'same run reaching running state', windows ? 120000 : 15000);
    phase('pendingRunInitialized');
  }
  async function clock(roles, { stepMs, now = Date.now() } = {}) {
    const file = path.join(directory, `clock-${++nextClock}.json`);
    const origin = now; const settings = { roles, now: origin, ...(stepMs ? { stepMs } : {}) };
    await fs.writeFile(file, JSON.stringify(settings));
    const acknowledgements = async () => Promise.all((await fs.readdir(directory)).filter((name) => name.startsWith(path.basename(file) + '.') && name.endsWith('.ack'))
      .map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))));
    return { origin, environment: { NODE_OPTIONS: `--no-warnings --import=${pathToFileURL(clockPreload).href}`, FIXTURE_CLOCK_FILE: file }, acknowledgements,
      async advance(milliseconds) {
        settings.now += milliseconds; await fs.writeFile(file, JSON.stringify(settings));
        if (roles.includes('worker')) await eventually(async () => (await acknowledgements()).some((value) => value.role === 'worker' && value.now === settings.now), 'worker clock acknowledgement');
        phase('simulatedClockAdvance', { simulatedElapsedMs: settings.now - origin });
      } };
  }
  async function waitTerminal(run) {
    const results = [];
    for (let index = 0; index < 20; index++) {
      const result = await command(['wait', '--run', run, '--timeout-ms', '1000']);
      successful(result, 'wait'); bounded(result); results.push(result);
      if (terminalPattern.test(result.stdout)) return results;
    }
    throw new Error('Fixture run did not reach a terminal state.');
  }
  // Private evidence is used only for targeted crash, expiry and damaged-cache injection.
  async function evidence(run) {
    return openRun(await storeContext({ temporaryRoot }), run);
  }
  t.after(async () => {
    try {
      if (diagnostics) for (const scenario of scenarios) {
        const records = await fs.readFile(path.join(scenario.directory, 'phases.jsonl'), 'utf8').catch(() => '');
        for (const line of records.trim().split('\n').filter(Boolean)) t.diagnostic(`AW_SUBAGENT_ADAPTER_PHASE ${JSON.stringify({ scenario: scenario.index, ...JSON.parse(line) })}`);
      }
    }
    finally {
      try { for (const run of handles) await command(['stop', '--run', run]).catch(() => {}); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  });
  return { directory, temporaryRoot, workspace, installed, generations, snapshot, config, save, command, start, initialized, clock, waitTerminal, evidence, phase };
}

// Test Value Gate: a copied installation must preserve caller text, argv, installed
// helpers and captured configuration after the short start command exits.
test('installed start preserves UTF-8 input, environment and one captured execution', async (t) => {
  const f = await fixture(t, 'bundle');
  const clock = await f.clock(['start'], { stepMs: 1000 });
  const instructions = 'Explicit fixture role.\r\n保留指令。\n';
  await fs.writeFile(path.join(f.directory, 'instructions.md'), instructions);
  Object.assign(f.snapshot.effectiveValues.subagentCommands[0], {
    args: ['--region', 'literal; $(touch escaped)', ''], env: { SOURCE: 'replacement', EMPTY: '' },
    envFrom: { SERVICE_DATA: 'SOURCE', EMPTY_REFERENCE: 'EMPTY_HOST' },
  });
  await f.save();
  const prompt = '  原始任务 🧪\r\n$(touch escaped); `literal`\n';
  const selectors = [' missing/**/*.ts , docs/absent.md ', '!**/*.test.ts', ' missing/**/*.ts , docs/absent.md '];
  const started = await f.start({ communication: false, readyGate: true }, { prompt: '-', stdin: Buffer.from(prompt), cwd: f.directory,
    extra: ['--name', 'api-review_2.1', '--instructions-file', 'instructions.md', '--model', 'explicit-model', '--reasoning-effort', 'high',
      ...selectors.flatMap((selector) => ['--file', selector])],
    env: { ...clock.environment, SOURCE: 'host-value', EMPTY_HOST: '', ORDINARY_HOST: 'inherited', AW_PLUGIN_CONTEXT: 'private', AW_SUBAGENT_TEMP_DIR: 'foreign' } });
  await f.initialized(started);
  const observations = await clock.acknowledgements();
  assert.equal(observations.length, 1); assert.equal(observations[0].now - clock.origin, 10000);
  assert.equal(field(started.stdout, 'agent'), 'api-review_2.1');
  if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'false');
  assert.deepEqual(blocks(started.stdout, 'FINAL'), []);
  const observed = await started.observed();
  assert.equal(observed.request.protocolVersion, 5); assert.equal(observed.request.type, 'start');
  assert.equal(observed.request.run.deadlineAt, null); assert.equal(observed.request.run.name, 'api-review_2.1');
  assert.ok(observed.request.prompt.includes(instructions)); assert.ok(observed.request.prompt.endsWith(prompt));
  assert.deepEqual(observed.request.execution, { profile: 'advisorProfile', executor: 'fixture', model: 'explicit-model', reasoningEffort: 'high' });
  assert.deepEqual(observed.request.fileSelectors, selectors);
  assert.deepEqual(observed.request.fileResolver, { command: process.execPath, args: [path.join(f.installed, 'scripts/resolve-files.mjs')] });
  assert.ok(Object.values(observed.request.runtime.toolkit).every((value) => value === process.execPath || value.startsWith(f.installed + path.sep)));
  assert.equal(observed.cwd, f.workspace); assert.deepEqual(observed.argv, []);
  assert.deepEqual(observed.request.args, f.snapshot.effectiveValues.subagentCommands[0].args);
  assert.equal(observed.environment.SOURCE, 'replacement'); assert.equal(observed.environment.SERVICE_DATA, 'host-value');
  assert.equal(observed.environment.EMPTY, ''); assert.equal(observed.environment.EMPTY_REFERENCE, '');
  assert.equal(observed.environment.ORDINARY_HOST, 'inherited'); assert.equal(observed.environment.AW_PLUGIN_CONTEXT, undefined);
  assert.notEqual(observed.environment.AW_SUBAGENT_TEMP_DIR, 'foreign');
  assert.equal(JSON.stringify(observed.request).includes('host-value'), false);
  assert.equal(await fs.stat(path.join(f.workspace, 'escaped')).catch(() => null), null);
  await fs.writeFile(path.join(f.directory, 'instructions.md'), 'changed role');
  f.snapshot.effectiveValues.advisorProfile.executor = 'native'; await f.save();
  const initialized = await f.command(['wait', '--run', started.run, '--timeout-ms', '0']);
  successful(initialized, 'wait');
  if (started.code === 1) assert.equal(field(initialized.stdout, 'communication'), 'false');
  await started.finish(); await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: result must select the complete report, consume all unread
// notifications, preserve duplicate bodies and retain only the fixed final result.
test('result consumes every unread message once and only the fixed final result can be reread', async (t) => {
  const f = await fixture(t);
  const messages = ['相同正文\n', '相同正文\n', 'state: completed\nBEGIN_FINAL:deadbeef\n原文\nEND_FINAL:deadbeef\n'];
  const finalText = '  完成 🧪\r\n保留最后换行。\n';
  const started = await f.start({ messages, finalText, echo: true }, { extra: ['--name', 'same-name'] });
  await f.initialized(started); if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'true');
  await started.published();
  const notReady = await f.command(['result', '--run', started.run]);
  assert.equal(notReady.code, 1); assert.equal(field(notReady.stdout, 'code'), 'resultNotReady');
  const reply = '  父输入 🧪\r\n第二行。\n';
  for (let index = 0; index < 2; index++) {
    const sent = await f.command(['send', '--run', started.run, '--text', '-'], { stdin: Buffer.from(reply) });
    successful(sent, 'send'); assert.equal(field(sent.stdout, 'delivery'), 'queued');
  }
  const inputs = await started.inputs(2);
  assert.deepEqual(inputs.map((input) => input.text), [reply, reply]); assert.notEqual(inputs[0].id, inputs[1].id);
  await started.finish();
  await eventually(() => fs.stat(path.join(started.runDirectory, 'finished.json')), 'fixture completion');
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]); return response.code === 0 && response;
  }, 'fixed result');
  successful(result, 'result'); bounded(result);
  if (started.code === 1) assert.equal(field(result.stdout, 'communication'), 'true');
  assert.deepEqual(blocks(result.stdout, 'MESSAGE'), [...messages, reply, reply]);
  assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
  assert.equal((result.stdout.match(/^agent: /gm) ?? []).length, 1);
  assert.equal((result.stdout.match(/^run: /gm) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /^(expires_at|body_bytes|result: included):/m);
  const reread = await f.command(['result', '--run', started.run, '--export']);
  successful(reread, 'result'); assert.deepEqual(blocks(reread.stdout, 'MESSAGE'), []);
  assert.deepEqual(blocks(reread.stdout, 'FINAL'), [finalText]);
  const settled = await f.command(['wait', '--run', started.run]);
  successful(settled, 'wait'); assert.equal(settled.stdout, 'wait: settled\n');
  const closed = await f.command(['send', '--run', started.run, '--text', 'late']);
  assert.equal(closed.code, 1); assert.equal(field(closed.stdout, 'code'), 'runClosed');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: large unread queues must not reintroduce the removed cumulative
// byte/count quota, and default result overflow must not consume any event.
test('large unread queues export completely after a non-consuming resultTooLarge error', async (t) => {
  const f = await fixture(t);
  const messages = Array.from({ length: 66 }, (_, index) => `${String(index).padStart(2, '0')}:` + 'x'.repeat(messageLimit - 3));
  const started = await f.start({ messages, finalText: 'Short final answer.' });
  await f.initialized(started); await started.published(); await started.finish();
  await eventually(() => fs.stat(path.join(started.runDirectory, 'finished.json')), 'large queue completion', batchObservationMs);
  const tooLarge = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]); return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'large fixed result', batchObservationMs);
  assert.equal(tooLarge.code, 1); bounded(tooLarge);
  assert.equal(field(tooLarge.stdout, 'code'), 'resultTooLarge');
  assert.equal(field(tooLarge.stdout, 'output_limit_bytes'), String(displayLimit));
  assert.ok(Number(field(tooLarge.stdout, 'result_bytes')) > displayLimit);
  assert.deepEqual(blocks(tooLarge.stdout, 'MESSAGE'), []); assert.deepEqual(blocks(tooLarge.stdout, 'FINAL'), []);
  const exported = await f.command(['result', '--run', started.run, '--export']);
  successful(exported, 'result'); assert.deepEqual(blocks(exported.stdout, 'MESSAGE'), messages);
  assert.deepEqual(blocks(exported.stdout, 'FINAL'), ['Short final answer.']);
  assert.ok(Buffer.byteLength(exported.stdout) > 256 * 1024); assert.doesNotMatch(exported.stdout, /^expires_at:/m);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
  const reread = await f.command(['result', '--run', started.run]);
  successful(reread, 'result'); assert.deepEqual(blocks(reread.stdout, 'MESSAGE'), []);
});

// Test Value Gate: submitted parent input must not spend a cumulative count or
// byte allowance, and repeated sends must stay within the original generation.
test('more than 64 parent messages exceeding the old total byte quota stay accepted', async (t) => {
  const f = await fixture(t);
  const started = await f.start();
  await f.initialized(started);
  const messages = Array.from({ length: 66 }, (_, index) => `${String(index).padStart(2, '0')}:` + 'x'.repeat(messageLimit - 3));
  for (const text of messages) successful(await f.command(['send', '--run', started.run, '--text', text]), 'send');
  assert.deepEqual((await started.inputs(messages.length)).map((input) => input.text), messages);
  await started.finish(); await f.waitTerminal(started.run);
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: referenced environment values must remain redacted in final
// output and diagnostics, including their JSON-escaped representation.
test('referenced environment secrets stay redacted in actual parent output', async (t) => {
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentCommands[0].envFrom = { SERVICE_DATA: 'SOURCE' }; await f.save();
  const secret = 'fixture\n"quoted"\\path.[x]+';
  const started = await f.start({ secretOutput: true, state: 'failed' }, { env: { SOURCE: secret } });
  await f.initialized(started); await started.finish();
  const responses = await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result');
  for (const output of [started, ...responses, result].flatMap((response) => [response.stdout, response.stderr])) {
    assert.equal(output.includes(secret), false); assert.equal(output.includes(JSON.stringify(secret).slice(1, -1)), false);
  }
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['{"serviceData":"[redacted]"}']);
  assert.equal((await started.observed()).environment.SERVICE_DATA, secret);
});

// Test Value Gate: a result that fits the actual response budget must be included
// in the first terminal wait, without reserving unused stderr capacity.
test('wait includes a 7300-byte final when the complete response fits without diagnostics', async (t) => {
  const f = await fixture(t);
  const finalText = 'x'.repeat(7300);
  const started = await f.start({ finalText, finishImmediately: true });
  await f.initialized(started);
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  successful(terminal, 'wait'); bounded(terminal);
  assert.equal(terminal.stderr, '');
  assert.equal(field(terminal.stdout, 'result'), undefined);
  assert.deepEqual(blocks(terminal.stdout, 'FINAL'), [finalText]);
  assert.ok(Buffer.byteLength(terminal.stdout) > displayLimit - 1024);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); bounded(result); assert.equal(result.stderr, '');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: adapter scratch must be removed after its processes stop while
// unread process messages and the fixed final remain available to their consumer.
test('stopped adapter scratch is deleted while unread messages and final remain readable', async (t) => {
  const f = await fixture(t);
  const scratchText = 'Raw task copy.\r\n运行期间保存的原文 🧪\n';
  const messages = ['Unread question.\n', '未读过程消息。\r\n'];
  const finalText = 'The retained final answer.\n';
  const started = await f.start({ scratchText, messages, finalText });
  await f.initialized(started); await started.published();
  const observed = await started.observed();
  assert.equal(await fs.readFile(observed.scratchFile, 'utf8'), scratchText);
  await started.finish();
  await eventually(() => {
    for (const pid of [observed.pid, observed.backendPid]) {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return true;
  }, 'adapter and backend exit');
  await eventually(async () => {
    try { await fs.lstat(observed.scratchFile); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }, 'stopped adapter scratch removal', 10000);
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]); return response.code === 0 && response;
  }, 'retained final and unread messages');
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(result.stdout, 'MESSAGE'), messages); assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
  const reread = await f.command(['result', '--run', started.run]);
  successful(reread, 'result'); assert.deepEqual(blocks(reread.stdout, 'MESSAGE'), []);
  assert.deepEqual(blocks(reread.stdout, 'FINAL'), [finalText]);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: wait must select whole messages within its byte budget and keep
// unselected events readable; a large final creates one deferred notification.
test('wait preserves whole events across batches and defers an oversized final only once', async (t) => {
  const f = await fixture(t);
  const messages = ['甲'.repeat(1365) + 'x', 'y'.repeat(messageLimit), 'z'.repeat(messageLimit)];
  const finalText = '答案\n'.repeat(3000);
  const started = await f.start({ messages, finalText });
  await f.initialized(started); await started.published();
  const received = [];
  for (let index = 0; index < 6 && received.length < messages.length; index++) {
    const response = await f.command(['wait', '--run', started.run, '--timeout-ms', '0']);
    successful(response, 'wait'); bounded(response); received.push(...blocks(response.stdout, 'MESSAGE'));
    if (received.length < messages.length) assert.equal(field(response.stdout, 'more'), 'true');
  }
  assert.deepEqual(received, messages);
  await started.finish();
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'result'), 'deferred');
  assert.equal(field(terminal.stdout, 'deferred_reason'), 'outputLimit');
  assert.ok(Number(field(terminal.stdout, 'result_bytes')) > displayLimit);
  assert.deepEqual(blocks(terminal.stdout, 'FINAL'), []); assert.doesNotMatch(terminal.stdout, /^expires_at:/m);
  const settled = await f.command(['wait', '--run', started.run, '--timeout-ms', '0']);
  assert.equal(settled.stdout, 'wait: settled\n');
  const result = await f.command(['result', '--run', started.run]);
  assert.equal(result.code, 1); bounded(result); assert.equal(field(result.stdout, 'code'), 'resultTooLarge');
  const exported = await f.command(['result', '--run', started.run, '--export']);
  successful(exported, 'result'); assert.deepEqual(blocks(exported.stdout, 'FINAL'), [finalText]);
  assert.deepEqual(blocks(exported.stdout, 'MESSAGE'), []);
});

// Test Value Gate: one wait window must observe all targets and continue reading
// valid targets when another handle is unavailable, without replaying old results.
test('multi-target wait wakes for B and does not replay the settled A result', async (t) => {
  const f = await fixture(t);
  const a = await f.start({ finishImmediately: true, finalText: 'A complete.' }, { extra: ['--name', 'duplicate'] });
  const b = await f.start({ echo: true }, { extra: ['--name', 'duplicate'] });
  await f.initialized(a); await f.initialized(b); await f.waitTerminal(a.run);
  const baseline = await f.command(['wait', '--run', b.run, '--timeout-ms', '0']);
  successful(baseline, 'wait'); assert.deepEqual(blocks(baseline.stdout, 'MESSAGE'), []);
  const pendingWait = f.command(['wait', '--run', a.run, '--run', b.run]);
  successful(await f.command(['send', '--run', b.run, '--text', 'B changed.']), 'send');
  const changed = await pendingWait;
  successful(changed, 'wait'); bounded(changed);
  assert.deepEqual(blocks(changed.stdout, 'MESSAGE'), ['B changed.']);
  assert.equal(field(changed.stdout, 'run'), b.run); assert.deepEqual(blocks(changed.stdout, 'FINAL'), []);
  const timeout = await f.command(['wait', '--run', a.run, '--run', b.run, '--timeout-ms', '0']);
  assert.equal(timeout.stdout, 'wait: timeout\n');
  successful(await f.command(['send', '--run', b.run, '--text', 'Still readable.']), 'send'); await b.inputs(2);
  const mixed = await f.command(['wait', '--run', 'unavailable', '--run', b.run, '--timeout-ms', '1000']);
  assert.equal(mixed.code, 1); bounded(mixed); assert.match(mixed.stdout, /^wait: changed\n/);
  assert.match(mixed.stdout, /^code: runUnavailable$/m); assert.deepEqual(blocks(mixed.stdout, 'MESSAGE'), ['Still readable.']);
  successful(await f.command(['stop', '--run', b.run]), 'stop');
  const terminal = (await f.waitTerminal(b.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'cancelled');
  assert.equal((await f.command(['wait', '--run', a.run, '--run', b.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: unsupported capability and an explicit deadline must remain
// independent from the parent wait window and never launch a second backend.
test('unsupported communication rejects send and explicit deadline stops one backend', async (t) => {
  const f = await fixture(t);
  const clock = await f.clock(['worker']);
  const deadlineMs = 1200;
  const started = await f.start({ communication: false }, { extra: ['--deadline-ms', String(deadlineMs)], env: clock.environment });
  await f.initialized(started); if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'false');
  const observed = await started.observed();
  assert.equal(observed.request.run.deadlineAt, clock.origin + deadlineMs);
  await clock.advance(deadlineMs - 1);
  const rejected = await f.command(['send', '--run', started.run, '--text', 'Do not submit.']);
  assert.equal(rejected.code, 1); assert.equal(field(rejected.stdout, 'code'), 'communicationUnsupported');
  assert.equal(field(rejected.stdout, 'state'), 'running');
  assert.equal((await started.observed()).request.run.deadlineAt, clock.origin + deadlineMs);
  await clock.advance(1);
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'cancelled');
  assert.equal(field(terminal.stdout, 'remote_stop_confirmed'), 'true');
  assert.throws(() => process.kill(observed.backendPid, 0), { code: 'ESRCH' });
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: atomic Windows root publication must not replace a competing
// private directory, alter an unsafe directory, or delete a foreign file. Run
// the real native move at the collision boundary; POSIX rename differs here.
test('Windows root publication preserves a competing existing directory or file', { skip: !windows, timeout: 120000 }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-root-publication-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const kind of ['privateDirectory', 'inheritedDirectory', 'file']) {
    const isolated = path.join(temporary, kind);
    await fs.mkdir(isolated);
    const context = await storeContext({ temporaryRoot: isolated });
    const mkdtemp = fs.mkdtemp; const rmdir = fs.rmdir;
    let staging, inserted, sourceRetained = false;
    fs.mkdtemp = async (prefix, ...options) => {
      const created = await mkdtemp(prefix, ...options);
      if (prefix !== `${context.root}-`) return created;
      assert.equal(inserted, undefined);
      staging = created;
      if (kind === 'file') await fs.writeFile(context.root, 'Foreign fixture content.');
      else {
        await fs.mkdir(context.root);
        if (kind === 'privateDirectory') await protectPrivatePath(context.root, 'directory');
      }
      inserted = await fs.lstat(context.root, { bigint: true });
      return created;
    };
    fs.rmdir = async (directory, ...options) => {
      if (directory === staging) {
        const unpublished = await fs.lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        sourceRetained = unpublished?.isDirectory() === true;
      }
      return rmdir(directory, ...options);
    };
    try {
      if (kind === 'privateDirectory') {
        const run = await createRun(context, 'competing-root', temporary);
        assert.equal(run.meta.name, 'competing-root');
      } else await assert.rejects(createRun(context, 'foreign-root', temporary));
    } finally { fs.mkdtemp = mkdtemp; fs.rmdir = rmdir; }
    assert.ok(inserted, 'The publication collision was not exercised.');
    assert.equal(sourceRetained, true, 'Native publication moved the source over an existing resource.');
    const preserved = await fs.lstat(context.root, { bigint: true });
    assert.equal(preserved.dev, inserted.dev); assert.equal(preserved.ino, inserted.ino);
    if (kind === 'file') assert.equal(await fs.readFile(context.root, 'utf8'), 'Foreign fixture content.');
    if (kind === 'inheritedDirectory') {
      assert.deepEqual(await fs.readdir(context.root), []);
      await assert.rejects(verifyPrivatePath(context.root, 'directory', context.owner), 'An unsafe existing directory was taken over.');
    }
    assert.deepEqual(await fs.readdir(isolated), [path.basename(context.root)], 'An unpublished staging directory was left behind.');
    if (process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') {
      t.diagnostic(`AW_SUBAGENT_COMMUNICATION_TEST ${JSON.stringify({ phase: 'rootPublicationCollision', kind, publicationRefused: sourceRetained, preserved: true })}`);
    }
  }
});

// Test Value Gate: pending is not false; late ready must survive fast closing and
// be delivered with the first subsequent state or terminal observation.
test('late ready capability survives terminal snapshot merging', { timeout: windows ? 120000 : 35000 }, async (t) => {
  const f = await fixture(t, 'workspace', { diagnostics: true });
  const clock = await f.clock(['start'], { stepMs: 1000 });
  const largeFinal = 'Late capability final.\n'.repeat(1000);
  const [forWait, forResult] = await Promise.all([
    f.start({ communication: false, readyGate: true, finishImmediately: true }, { env: clock.environment }),
    f.start({ communication: true, readyGate: true, finishImmediately: true, finalText: largeFinal }, { env: clock.environment }),
  ]);
  for (const [index, started] of [forWait, forResult].entries()) {
    const diagnostic = JSON.stringify({ phase: 'lateReadyStart', case: index === 0 ? 'communicationFalse' : 'communicationTrue',
      code: started.code, elapsedMs: started.elapsedMs, stdout: started.stdout, stderr: started.stderr });
    if (process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') t.diagnostic(`AW_SUBAGENT_COMMUNICATION_TEST ${diagnostic}`);
    assert.equal(started.code, 1, diagnostic); assert.match(started.stdout, /^start: notReady\n/, diagnostic);
    assert.equal(field(started.stdout, 'state'), 'starting'); assert.equal(field(started.stdout, 'communication'), 'pending');
    assert.equal(field(started.stdout, 'code'), 'startupNotReady');
  }
  const observations = await clock.acknowledgements();
  assert.equal(observations.length, 2);
  assert.ok(observations.every((value) => value.role === 'start' && value.now - clock.origin === 10000), JSON.stringify(observations));
  f.phase('initializationWindowSimulated', { simulatedElapsedMs: 10000, runs: 2 });
  await Promise.all([forWait.releaseReady(), forResult.releaseReady()]);
  await Promise.all([forWait.finished(), forResult.finished()]);
  const responses = await f.waitTerminal(forWait.run);
  assert.ok(responses.some((response) => field(response.stdout, 'communication') === 'false'));
  const result = await f.command(['result', '--run', forWait.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'communication'), undefined);
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  const tooLarge = await eventually(async () => {
    const response = await f.command(['result', '--run', forResult.run]);
    return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'late ready large final');
  assert.equal(tooLarge.code, 1); assert.equal(field(tooLarge.stdout, 'code'), 'resultTooLarge');
  const exported = await f.command(['result', '--run', forResult.run, '--export']);
  successful(exported, 'result'); assert.equal(field(exported.stdout, 'communication'), 'true');
  assert.deepEqual(blocks(exported.stdout, 'FINAL'), [largeFinal]);
  const reread = await f.command(['result', '--run', forResult.run, '--export']);
  successful(reread, 'result'); assert.equal(field(reread.stdout, 'communication'), undefined);
  assert.equal((await f.command(['wait', '--run', forResult.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: failed initialization must preserve unknown capability and a
// readable failure, rather than treating missing ready as communication=false.
test('initialization failure has pending capability and a readable failed final', async (t) => {
  const f = await fixture(t);
  const started = await f.start({ initializationFailure: true });
  assert.equal(started.code, 1); assert.equal(field(started.stdout, 'communication'), 'pending');
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'failed'); assert.equal(field(terminal.stdout, 'communication'), 'pending');
  assert.equal(field(terminal.stdout, 'generation_started'), 'false');
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'text_status'), 'missing');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['']);
});

// Test Value Gate: a completed task must retain unknown input delivery in its fixed
// result even after a parent has consumed the corresponding process notification.
test('completed result preserves unresolved input delivery without replaying notifications', async (t) => {
  const f = await fixture(t);
  const started = await f.start({ delivery: 'unknown' });
  await f.initialized(started);
  const input = '  追加检查。\r\nDo not retry automatically.\n';
  successful(await f.command(['send', '--run', started.run, '--text', '-'], { stdin: Buffer.from(input) }), 'send');
  await started.inputs(1);
  const notification = await f.command(['wait', '--run', started.run, '--timeout-ms', '1000']);
  successful(notification, 'wait');
  assert.equal(field(notification.stdout, 'delivery'), 'unknown');
  assert.deepEqual(blocks(notification.stdout, 'INPUT'), [input]);
  await started.finish(); await f.waitTerminal(started.run);
  for (let index = 0; index < 2; index++) {
    const result = await f.command(['result', '--run', started.run]);
    successful(result, 'result');
    assert.equal(field(result.stdout, 'state'), 'completed'); assert.equal(field(result.stdout, 'delivery_gaps'), '1');
    assert.equal(field(result.stdout, 'delivery'), 'unknown'); assert.deepEqual(blocks(result.stdout, 'INPUT'), [input]);
    assert.ok(result.stdout.indexOf('BEGIN_INPUT:') < result.stdout.indexOf('BEGIN_FINAL:'));
  }
  assert.equal((await started.inputs(1)).length, 1);
});

// Test Value Gate: an OS-visible broken output pipe must leave unread messages
// untouched even when export has started writing a large final report.
test('export output failure does not consume unread messages', async (t) => {
  const f = await fixture(t);
  const messages = ['Message before a broken pipe.', 'Another unread message.'];
  const finalText = 'x'.repeat(3 * 1024 * 1024);
  const started = await f.start({ messages, finalText });
  await f.initialized(started); await started.published(); await started.finish();
  await eventually(() => fs.stat(path.join(started.runDirectory, 'finished.json')), 'large final completion');
  // A default read checks readiness without consuming this oversized report.
  await eventually(async () => field((await f.command(['result', '--run', started.run])).stdout, 'code') === 'resultTooLarge', 'large final cache');
  const failed = await f.command(['result', '--run', started.run, '--export'], { breakOutput: true });
  assert.notEqual(failed.code, 0);
  const recovered = await f.command(['result', '--run', started.run, '--export']);
  successful(recovered, 'result'); assert.deepEqual(blocks(recovered.stdout, 'MESSAGE'), messages);
  assert.deepEqual(blocks(recovered.stdout, 'FINAL'), [finalText]);
});

// Test Value Gate: a final published between the first missing-file read and its
// existence check must be readable even while the cached worker identity is alive.
test('worker final published between missing-file probes remains readable', async (t) => {
  const f = await fixture(t);
  const finalText = 'Committed between final-file probes.\r\n保留原文。\n';
  const started = await f.start({ finalText });
  await f.initialized(started);
  const context = await storeContext({ temporaryRoot: f.temporaryRoot });
  const run = await openRun(context, started.run);
  assert.equal(await workerAlive(context, run.meta), true);
  const finalFile = path.join(run.directory, 'final.json');
  const ownerFile = path.join(run.directory, 'owner.json');
  const originalLstat = fs.lstat;
  let missingChecks = 0, visibleChecks = 0, committed, observed;
  fs.lstat = async (target, ...options) => {
    try {
      const stat = await originalLstat.call(fs, target, ...options);
      if (target === finalFile && committed) visibleChecks += 1;
      return stat;
    } catch (error) {
      if (target === finalFile && error.code === 'ENOENT' && ++missingChecks === 1) {
        // Preserve this real ENOENT, then let the real worker finish before the
        // parent's existence check. Its process-table observation stays cached.
        await started.finish();
        committed = await eventually(async () => {
          const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
          if (owner.terminalAt === null) return false;
          return { owner, result: JSON.parse(await fs.readFile(finalFile, 'utf8')) };
        }, 'worker final publication between file probes');
        assert.equal(await workerAlive(context, run.meta), true);
      }
      throw error;
    }
  };
  try { observed = await observeRun(context, run); }
  finally { fs.lstat = originalLstat; }
  assert.equal(missingChecks, 1); assert.ok(visibleChecks >= 1);
  assert.equal(committed.result.state, 'completed'); assert.equal(committed.result.text, finalText);
  assert.deepEqual(observed.result, committed.result); assert.equal(observed.snapshot.state, 'completed');
  assert.deepEqual(JSON.parse(await fs.readFile(finalFile, 'utf8')), committed.result);
  assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).terminalAt, committed.owner.terminalAt);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
});

// Test Value Gate: a worker may commit and exit after both parent-side missing-file
// observations. Lost-worker recovery must preserve that real final and its TTL.
test('late worker final publication survives a parent lost-worker observation', async (t) => {
  const f = await fixture(t);
  const finalText = 'Saved successful answer.\r\n保留最终正文。\n';
  const started = await f.start({ finalText });
  await f.initialized(started);
  const context = await storeContext({ temporaryRoot: f.temporaryRoot });
  const run = await openRun(context, started.run);
  const finalFile = path.join(run.directory, 'final.json');
  const ownerFile = path.join(run.directory, 'owner.json');
  const originalLstat = fs.lstat;
  let missingChecks = 0, committed, observed;
  fs.lstat = async (target, ...options) => {
    try { return await originalLstat.call(fs, target, ...options); }
    catch (error) {
      if (target === finalFile && error.code === 'ENOENT' && ++missingChecks === 2) {
        // Keep the already observed ENOENT while the real worker publishes its
        // final and owner metadata, then exits. The parent next observes its exit.
        await started.finish();
        committed = await eventually(async () => {
          try { process.kill(run.meta.worker.pid, 0); return false; }
          catch (exitError) { if (exitError.code !== 'ESRCH') throw exitError; }
          const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
          if (owner.terminalAt === null) return false;
          return { owner, result: JSON.parse(await fs.readFile(finalFile, 'utf8')) };
        }, 'normal worker final publication and exit');
      }
      throw error;
    }
  };
  try { observed = await observeRun(context, run); }
  finally { fs.lstat = originalLstat; }
  assert.ok(committed, 'The missing-file observation must overlap normal worker publication.');
  assert.equal(committed.result.state, 'completed'); assert.equal(committed.result.text, finalText);
  assert.deepEqual(observed.result, committed.result);
  assert.equal(observed.meta.terminalAt, committed.owner.terminalAt);
  assert.deepEqual(JSON.parse(await fs.readFile(finalFile, 'utf8')), committed.result);
  assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).terminalAt, committed.owner.terminalAt);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
});

// Test Value Gate: a default report must reserve enough room for a late consume
// error; preflight overflow and a failed delete must both preserve unread records.
test('default result reserves consume-error bytes and retains messages after deletion failure', async (t) => {
  const f = await fixture(t);
  const message = 'z'.repeat(messageLimit);
  const started = await f.start({ messages: [message], finalText: 'a' });
  await f.initialized(started); await started.published(); await started.finish();
  await eventually(() => fs.stat(path.join(started.runDirectory, 'finished.json')), 'fixture final publication');
  const run = await f.evidence(started.run);
  const preload = path.join(f.directory, 'deny-event-consumption.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs/promises';import path from 'node:path';
const unlink=fs.unlink;fs.unlink=async(target,...options)=>{
  if(typeof target==='string'&&path.dirname(target)===process.env.FIXTURE_DENIED_DIRECTORY){
    throw Object.assign(new Error('Fixture event deletion denied.'),{code:'EACCES'});
  }
  return unlink.call(fs,target,...options);
};\n`);
  const injected = { nodeArgs: ['--import', pathToFileURL(preload).href], env: { FIXTURE_DENIED_DIRECTORY: path.join(run.directory, 'events') } };
  const baseline = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run], injected);
    return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'readable fixed final');
  assert.equal(baseline.code, 1); assert.equal(field(baseline.stderr, 'code'), 'resultConsumeFailed');
  const baselineBytes = Buffer.byteLength(baseline.stdout);
  const finalFile = path.join(run.directory, 'final.json');
  const originalFinal = JSON.parse(await fs.readFile(finalFile, 'utf8'));
  async function reportSize(bytes) {
    const finalText = 'a'.repeat(bytes - baselineBytes + 1);
    await fs.writeFile(finalFile, JSON.stringify({ ...originalFinal, text: finalText }));
    return finalText;
  }
  // Calibrate from a real public response, not from the renderer's budget helper.
  // Token lengths and all other fields stay fixed; only the ASCII final grows.
  await reportSize(displayLimit);
  const tooLarge = await f.command(['result', '--run', started.run], injected);
  assert.equal(tooLarge.code, 1);
  bounded(tooLarge);
  assert.equal(field(tooLarge.stdout, 'code'), 'resultTooLarge');
  assert.equal(field(tooLarge.stdout, 'result_bytes'), String(displayLimit));
  assert.deepEqual(blocks(tooLarge.stdout, 'MESSAGE'), []); assert.deepEqual(blocks(tooLarge.stdout, 'FINAL'), []);
  const finalText = await reportSize(displayLimit - 128);
  const consumeFailed = await f.command(['result', '--run', started.run], injected);
  assert.equal(consumeFailed.code, 1); bounded(consumeFailed);
  assert.equal(field(consumeFailed.stderr, 'code'), 'resultConsumeFailed');
  assert.equal(Buffer.byteLength(consumeFailed.stdout), displayLimit - 128);
  assert.deepEqual(blocks(consumeFailed.stdout, 'MESSAGE'), [message]);
  const recovered = await f.command(['result', '--run', started.run]);
  successful(recovered, 'result'); bounded(recovered);
  assert.deepEqual(blocks(recovered.stdout, 'MESSAGE'), [message]); assert.deepEqual(blocks(recovered.stdout, 'FINAL'), [finalText]);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: worker loss must become one fixed unknown without generating
// new work, and repeat observations must preserve the first expiry origin.
test('lost worker result is fixed once and expires without regenerating work', async (t) => {
  const f = await fixture(t);
  const started = await f.start({ messages: ['Saved process message.'] });
  await f.initialized(started); await started.published();
  const before = await f.evidence(started.run);
  process.kill(before.meta.worker.pid, 'SIGKILL');
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]); return response.code === 0 && response;
  }, 'lost-worker result');
  assert.equal(field(result.stdout, 'state'), 'unknown'); assert.equal(field(result.stdout, 'code'), 'workerLost');
  assert.equal(field(result.stdout, 'generation_started'), 'null');
  assert.deepEqual(blocks(result.stdout, 'MESSAGE'), ['Saved process message.']); assert.deepEqual(blocks(result.stdout, 'FINAL'), ['']);
  const first = await f.evidence(started.run);
  assert.ok(Number.isSafeInteger(first.meta.terminalAt));
  const reread = await f.command(['result', '--run', started.run]);
  successful(reread, 'result'); assert.equal(field(reread.stdout, 'code'), 'workerLost');
  assert.deepEqual(blocks(reread.stdout, 'MESSAGE'), []);
  assert.equal((await f.evidence(started.run)).meta.terminalAt, first.meta.terminalAt);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
  const clock = await f.clock(['result'], { now: first.meta.terminalAt });
  await clock.advance(3599999);
  successful(await f.command(['result', '--run', started.run], { env: clock.environment }), 'result');
  assert.equal((await f.evidence(started.run)).meta.terminalAt, first.meta.terminalAt);
  await clock.advance(1);
  const expired = await f.command(['result', '--run', started.run, '--export'], { env: clock.environment });
  assert.equal(expired.code, 1); assert.match(expired.stdout, /^code: (runExpired|runUnavailable)$/m);
  assert.deepEqual(blocks(expired.stdout, 'FINAL'), []);
});

// Test Value Gate: expired ownership and stopped-process evidence must permit
// cleanup even when cached content is damaged; read-only help must not scan.
test('ordinary calls clean expired damaged content while help and invalid flags stay read-only', async (t) => {
  const f = await fixture(t);
  const started = await f.start({ finishImmediately: true });
  await f.initialized(started); await f.waitTerminal(started.run);
  const run = await f.evidence(started.run);
  await eventually(() => {
    try { process.kill(run.meta.worker.pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'worker exit');
  const clock = await f.clock(['--help', 'result'], { now: run.meta.terminalAt });
  await clock.advance(3600000);
  await fs.writeFile(path.join(run.directory, 'final.json'), '{damaged cached content');
  assert.equal((await f.command(['--help'], { env: clock.environment })).code, 0); await fs.stat(run.directory);
  assert.equal((await f.command(['result', '--run', started.run, '--output-file', 'unused'], { env: clock.environment })).code, 2); await fs.stat(run.directory);
  const expired = await f.command(['result', '--run', started.run], { env: clock.environment });
  assert.equal(expired.code, 1); assert.deepEqual(blocks(expired.stdout, 'FINAL'), []);
  assert.equal(await fs.stat(run.directory).catch(() => null), null);
});

// Test Value Gate: syntax validation and help must have no run/scan side effects;
// obsolete flags and name-based addressing must not start or consume any task.
test('invalid input rejects obsolete commands, names and malformed sizes before side effects', async (t) => {
  const f = await fixture(t);
  const invalid = [
    ['run'], ['poll'], ['resume'], ['cleanup'],
    ['start', '--profile', 'advisorProfile', '--prompt', 'task', '--workspace', f.workspace, '--preview'],
    ['start', '--profile', 'advisorProfile', '--prompt', 'task', '--workspace', f.workspace, '--communication', 'true'],
    ...['中文', ' spaced', '../path', '.leading', 'x'.repeat(65)].map((name) => ['start', '--profile', 'advisorProfile', '--prompt', 'task', '--workspace', f.workspace, '--name', name]),
    ...['0', '-1', '1.5', '9007199254740991'].map((value) => ['start', '--profile', 'advisorProfile', '--prompt', 'task', '--workspace', f.workspace, '--deadline-ms', value]),
    ['result', '--run', 'handle', '--output-file', 'must-not-exist'], ['result', '--run', 'handle', '--export', 'must-not-exist'],
    ['result', '--run', 'handle', '--run', 'second'],
    ['wait', '--run', 'handle', '--timeout-ms', '-1'], ['wait', '--run', 'handle', '--timeout-ms', '1800001'],
    ['wait', ...Array.from({ length: 17 }, (_, index) => ['--run', `run-${index}`]).flat()],
  ];
  for (const args of invalid) assert.equal((await f.command(args)).code, 2, args.join(' '));
  for (const bytes of [Buffer.from(' \r\n'), Buffer.from([0xff]), Buffer.from([0]), Buffer.alloc(262145, 120)]) {
    const rejected = await f.command(['start', '--profile', 'advisorProfile', '--workspace', f.workspace, '--prompt', '-'], { stdin: bytes });
    assert.equal(rejected.code, 2);
  }
  const instructions = path.join(f.directory, 'invalid-instructions.md');
  for (const bytes of [Buffer.from('  '), Buffer.from([0xff]), Buffer.alloc(262145, 120)]) {
    await fs.writeFile(instructions, bytes);
    const rejected = await f.command(['start', '--profile', 'advisorProfile', '--workspace', f.workspace, '--prompt', 'task', '--instructions-file', instructions]);
    assert.equal(rejected.code, 2);
  }
  const workspaceFiles = await f.command(['start', '--profile', 'advisorProfile', '--workspace', f.workspace, '--prompt', 'task', '--file', 'missing/**/*.ts']);
  assert.equal(workspaceFiles.code, 2);
  assert.equal((await f.command(['--help'])).code, 0);
  assert.equal(await fs.stat(f.generations).catch(() => null), null); assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
  assert.equal(await fs.stat(path.join(f.workspace, 'must-not-exist')).catch(() => null), null);
  const started = await f.start({}, { extra: ['--name', 'real-name'] });
  await f.initialized(started);
  const named = await f.command(['send', '--run', 'real-name', '--text', 'wrong target']);
  assert.equal(named.code, 1); assert.equal(field(named.stdout, 'code'), 'runUnavailable');
  for (const bytes of [Buffer.from(' \r\n'), Buffer.from([0xff]), Buffer.from([0]), Buffer.alloc(messageLimit + 1, 120)]) {
    const rejected = await f.command(['send', '--run', started.run, '--text', '-'], { stdin: bytes }); assert.equal(rejected.code, 2);
  }
  const accepted = await f.command(['send', '--run', started.run, '--text', 'x'.repeat(messageLimit)]);
  successful(accepted, 'send'); await started.inputs(1);
});

// Test Value Gate: caller wait time must not impose a task deadline. Advance
// separate caller/worker clocks, while keeping real messages and process exits.
test('default run survives simulated time and a caller wait timeout', async (t) => {
  const f = await fixture(t);
  const workerClock = await f.clock(['worker']);
  const started = await f.start({ echo: true }, { env: workerClock.environment });
  await f.initialized(started);
  assert.equal((await started.observed()).request.run.deadlineAt, null);
  successful(await f.command(['wait', '--run', started.run, '--timeout-ms', '0']), 'wait');
  const callerClock = await f.clock(['wait'], { stepMs: 100000 });
  const timeout = await f.command(['wait', '--run', started.run], { env: callerClock.environment });
  assert.equal(timeout.code, 0); assert.equal(timeout.stdout, 'wait: timeout\n');
  const [acknowledged] = await callerClock.acknowledgements();
  assert.equal(acknowledged.now - callerClock.origin, 600000);
  await workerClock.advance(1800001);
  const input = 'Input after a simulated former default deadline.';
  successful(await f.command(['send', '--run', started.run, '--text', input]), 'send');
  const changed = await f.command(['wait', '--run', started.run]);
  successful(changed, 'wait'); assert.equal(field(changed.stdout, 'state'), 'running');
  assert.deepEqual(blocks(changed.stdout, 'MESSAGE'), [input]);
  assert.deepEqual((await started.inputs(1)).map((message) => message.text), [input]);
  const pending = await f.command(['result', '--run', started.run]);
  assert.equal(pending.code, 1); assert.equal(field(pending.stdout, 'code'), 'resultNotReady');
  assert.equal((await started.observed()).request.run.deadlineAt, null);
  await started.finish(); await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
  t.diagnostic('Simulated caller_wait_ms=600000 worker_elapsed_ms=1800001; native elapsed qualification is separate.');
});

const longRunSetting = process.env.AW_SUBAGENT_LONG_RUN_MS;
const longRunMilliseconds = longRunSetting === undefined ? null : Number(longRunSetting);
const validLongRun = Number.isSafeInteger(longRunMilliseconds) && longRunMilliseconds > 1800000 && longRunMilliseconds <= 86400000;

// Test Value Gate: the removed 30-minute default deadline requires native elapsed
// time evidence. This opt-in qualification leaves the real worker idle beyond that
// boundary, then verifies the same run can receive input and return its result.
test('long-running default run stays open beyond 30 minutes', {
  skip: longRunSetting === undefined ? 'Set AW_SUBAGENT_LONG_RUN_MS above 1800000 to run native long-duration qualification.' : false,
  timeout: (validLongRun ? longRunMilliseconds : 0) + (windows ? 360000 : 90000),
}, async (t) => {
  assert.ok(validLongRun && /^\d+$/.test(longRunSetting), 'AW_SUBAGENT_LONG_RUN_MS must be an integer from 1800001 through 86400000.');
  const f = await fixture(t);
  const started = await f.start({ echo: true,
    backendLifetimeMs: longRunMilliseconds + (windows ? 300000 : 60000),
    adapterLifetimeMs: longRunMilliseconds + (windows ? 305000 : 65000) });
  await f.initialized(started);
  if (started.code === 0) { assert.equal(field(started.stdout, 'state'), 'running'); assert.equal(field(started.stdout, 'communication'), 'true'); }
  assert.equal((await started.observed()).request.run.deadlineAt, null);
  const began = performance.now();
  while (performance.now() - began < longRunMilliseconds) {
    await sleep(Math.min(60000, longRunMilliseconds - (performance.now() - began)));
    t.diagnostic(`Long-run qualification elapsed_ms=${Math.floor(performance.now() - began)}.`);
  }
  const elapsedMilliseconds = performance.now() - began;
  assert.ok(elapsedMilliseconds >= longRunMilliseconds);
  const input = 'Input after the former default deadline.\r\n保留同一次任务。\n';
  const sent = await f.command(['send', '--run', started.run, '--text', '-'], { stdin: Buffer.from(input) });
  successful(sent, 'send'); assert.equal(field(sent.stdout, 'delivery'), 'queued');
  const changed = await f.command(['wait', '--run', started.run]);
  successful(changed, 'wait'); bounded(changed);
  assert.equal(field(changed.stdout, 'state'), 'running'); assert.deepEqual(blocks(changed.stdout, 'MESSAGE'), [input]);
  const stillRunning = await f.command(['result', '--run', started.run]);
  assert.equal(stillRunning.code, 1); assert.equal(field(stillRunning.stdout, 'code'), 'resultNotReady');
  assert.deepEqual((await started.inputs(1)).map((message) => message.text), [input]);
  await started.finish(); await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
  t.diagnostic(`AW_SUBAGENT_LONG_RUN ${JSON.stringify({ requestedMs: longRunMilliseconds, elapsedMs: Math.floor(elapsedMilliseconds), state: 'completed', generations: 1 })}`);
});
