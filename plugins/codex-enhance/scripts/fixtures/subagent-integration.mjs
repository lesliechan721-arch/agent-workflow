import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { openRun, storeContext } from '../../skills/codex-subagent-guide/scripts/runtime/store.mjs';
import { guideRuntimeScripts } from './guide-runtime-resources.mjs';

const require = createRequire(import.meta.url);
const registeredEntry = require.resolve('../../skills/codex-subagent-guide/scripts/subagent.mjs');
const registeredWorker = require.resolve('../../skills/codex-subagent-guide/scripts/worker.mjs');
const registeredClock = require.resolve('./subagent-clock.mjs');
const registeredDiagnostics = require.resolve('./subagent-platform-diagnostics.mjs');
const sourceScripts = guideRuntimeScripts(new URL('../', import.meta.url));
const sourceEntry = path.join(sourceScripts, path.basename(registeredEntry));
const sourceWorker = path.join(sourceScripts, path.basename(registeredWorker));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const terminalPattern = /^(?:<result(?:_[0-9]+)?\b[^\n]*\bstate="(?:completed|failed|cancelled|unknown)"|deferred \S+ state=(?:completed|failed|cancelled|unknown)\b)/m;
const displayLimit = 8192;
const windows = process.platform === 'win32';
const batchObservationMs = windows ? 120000 : 5000;
const testTimeoutMs = windows ? 180000 : 35000;
const cleanupTimeoutMs = windows ? 45000 : 10000;

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
    ...(scenario.resultDiagnostics ? { diagnostics: scenario.resultDiagnostics } : {}),
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
    if (scenario.readyGate) { await phase('readyGateWaiting'); await signal('ready'); }
    await emit({ type: 'result', state: 'failed', generationStarted: false, backendExitCode: null,
      text: '', code: 'fixtureInitializationFailed', message: 'Fixture initialization failed.', ...(scenario.initialization ? { initialization: scenario.initialization } : {}), ...(scenario.diagnostics ? { diagnostics: scenario.diagnostics } : {}) });
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
  await emit({ type: 'ready', initialization: { environment: { status: 'available' }, capabilities: { communication: !frame.communication ? { status: 'disabled' } : scenario.communication === false || frame.mode === 'bundle' ? { status: 'unsupported' } : scenario.descriptor ?? { status: 'enabled', transport: 'mcp', passiveDelivery: 'in-turn' } } }, ...(scenario.diagnostics ? { diagnostics: scenario.diagnostics } : {}) });
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
const blockPattern = /^<((?:message|input|result|diagnostic)(?:_[0-9]+)?)([^>\n]*)>\n([\s\S]*?)\n<\/\1>\n/gm;
const decodeAttribute = (value) => value.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
function records(output) {
  return [...output.matchAll(blockPattern)].map((match) => ({
    kind: match[1].replace(/_[0-9]+$/, ''), text: match[3],
    attributes: Object.fromEntries([...match[2].matchAll(/([a-z_]+)="([^"]*)"/g)].map((entry) => [entry[1], decodeAttribute(entry[2])])),
  }));
}
function blocks(output, kind) {
  const name = kind === 'FINAL' ? 'result' : kind.toLowerCase();
  return records(output).filter((record) => record.kind === name).map((record) => record.text);
}
function field(output, key) {
  const controls = output.replace(blockPattern, '');
  const attribute = controls.match(new RegExp(`(?:^| )${key}=([^ \\n]+)`, 'm'))?.[1];
  if (attribute !== undefined) return attribute;
  if (key === 'run') {
    const handle = controls.match(/^(?:started|starting|start_failed|ready|queued|stopped|stopping|deferred|exported) (aw5-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22})(?=\s|$)/m)?.[1];
    if (handle) return handle;
  }
  for (const kind of ['result', 'input', 'message', 'diagnostic']) {
    const value = records(output).find((record) => record.kind === kind && Object.hasOwn(record.attributes, key))?.attributes[key];
    if (value !== undefined) return value;
  }
}
function bounded(result) {
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= displayLimit, 'Response exceeds 8192 bytes.');
  assert.ok(Buffer.byteLength(result.stderr) <= 1024, 'Diagnostics exceed 1024 bytes.');
}
function successful(result, command) {
  assert.equal(result.code, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  const expected = { start: /^started /m, send: /^queued /, wait: /^(?:ready |more=true$|<(?:message|input|result|diagnostic)|deferred |timeout$|settled$)/m,
    result: /^(?:<(?:message|input|result|diagnostic)|exported )/, stop: /^stopp(?:ed|ing) / };
  assert.match(result.stdout, expected[command]);
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
  await fs.cp(path.join(sourceScripts, '../assets'), path.join(installed, 'assets'), { recursive: true });
  await fs.access(path.join(installed, 'scripts', path.relative(sourceScripts, sourceWorker)));
  const adapter = path.join(directory, 'fake-adapter.mjs');
  await fs.writeFile(adapter, fakeAdapter);
  const clockPreload = path.join(directory, 'fixture-clock.mjs');
  await fs.copyFile(registeredClock, clockPreload);
  const diagnosticsPreload = path.join(directory, 'fixture-platform-diagnostics.mjs');
  await fs.copyFile(registeredDiagnostics, diagnosticsPreload);
  const diagnosticsArgs = process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1'
    ? ['--import', pathToFileURL(diagnosticsPreload).href] : [];
  const snapshot = { installedIdentity: { source: 'fixture', plugin: 'fixture', platform: 'codex', scope: 'user' }, resourceRoot: installed,
    effectiveValues: {
      subagentCommands: [{ key: 'fixture', adapter: 'custom', mode, command: await fs.realpath(process.execPath), entrypoint: adapter }] } };
  const config = path.join(installed, 'effective.json');
  const save = () => fs.writeFile(config, JSON.stringify(snapshot));
  await save();
  await fs.writeFile(path.join(installed, 'scripts', 'aw-runtime-config.mjs'),
    "import fs from 'node:fs/promises';export async function readRuntimeConfig({keys}){if(JSON.stringify(keys)!=='[\"subagentCommands\"]')throw new Error('Unexpected runtime keys');return JSON.parse(await fs.readFile(new URL('../effective.json',import.meta.url),'utf8'));}\n");
  const entry = path.join(installed, 'scripts', path.relative(sourceScripts, sourceEntry));
  // Windows native tools need their normal host environment. Normalize names so
  // the isolated paths below replace host values without mixed-case duplicates.
  const nativeEnvironment = process.platform === 'win32'
    ? Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value])) : {};
  const environment = { ...nativeEnvironment, PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, CODEX_HOME: directory,
    AW_HOME: directory, AW_CODEX_HOME: directory, AW_CLAUDE_HOME: directory,
    TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot };
  const handles = new Set();
  let nextScenario = 0, nextClock = 0, nextExport = 0;
  function command(args, { stdin, env = {}, cwd = workspace, breakOutput = false, keepStdinOpen = false, timeout = windows ? 120000 : 35000, signal = t.signal } = {}) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const began = performance.now();
      phase('commandBegin', { operation: args[0] });
      const child = spawn(process.execPath, [...diagnosticsArgs, entry, ...args], { cwd, env: { ...environment, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = [], diagnostics = [];
      const abort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.once('error', (error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error); });
      child.stdout.on('data', (chunk) => { output.push(chunk); });
      if (breakOutput) child.stdout.destroy();
      child.stderr.on('data', (chunk) => diagnostics.push(chunk));
      child.once('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        const stdout = Buffer.concat(output).toString('utf8');
        const handle = field(stdout, 'run');
        if (/^aw5-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22}$/.test(handle ?? '')) handles.add(handle);
        let nativeTiming;
        const stderr = Buffer.concat(diagnostics).toString('utf8').split('\n').filter((line) => {
          if (!line.startsWith('AW_SUBAGENT_NATIVE_TIMING ')) return true;
          nativeTiming = JSON.parse(line.slice('AW_SUBAGENT_NATIVE_TIMING '.length));
          return false;
        }).join('\n');
        const response = { code, stdout, stderr, elapsedMs: Math.round(performance.now() - began) };
        phase('commandEnd', { operation: args[0], code, commandElapsedMs: response.elapsedMs, nativeTiming, state: field(stdout, 'state'), communication: field(stdout, 'communication'), errorCode: field(stderr, 'code') ?? field(stdout, 'code'), failureDiagnostics: blocks(stderr + stdout, 'DIAGNOSTIC'), timedOut });
        if (signal.aborted) { reject(signal.reason); return; }
        if (timedOut) { reject(new Error(`Fixture command timed out: ${args[0]}\n${JSON.stringify(phases)}`)); return; }
        resolve(response);
      });
      child.stdin.on('error', () => {}); if (!keepStdinOpen) child.stdin.end(stdin);
    });
  }
  async function start(scenario = {}, { prompt = 'Assigned fixture task.', promptFile, extra = [], env = {}, stdin, cwd } = {}) {
    const runDirectory = path.join(directory, `scenario-${++nextScenario}`);
    const index = nextScenario;
    scenarios.push({ index, directory: runDirectory });
    await fs.mkdir(runDirectory);
    const scenarioFile = path.join(runDirectory, 'scenario.json');
    await fs.writeFile(scenarioFile, JSON.stringify(scenario));
    const input = promptFile === undefined ? ['--prompt', prompt] : ['--prompt-file', promptFile];
    const response = await command(['start', '--executor', 'fixture', '--workspace', workspace, ...input, ...extra],
      { env: { ...env, FIXTURE_SCENARIO_FILE: scenarioFile, FIXTURE_RUN_DIRECTORY: runDirectory, FIXTURE_GENERATIONS: generations }, stdin, cwd });
    const run = field(response.stdout, 'run');
    phase('startReturned', { scenario: index, code: response.code, state: field(response.stdout, 'state'), communication: field(response.stdout, 'communication') });
    return { ...response, run, runDirectory, scenario, showDiagnostics: extra.includes('--diagnostics'),
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
    assert.match(started.run ?? '', /^aw5-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22}$/, started.stdout + started.stderr);
    if (started.code === 0) { successful(started, 'start'); return; }
    assert.equal(started.code, 1, started.stdout + started.stderr);
    assert.match(started.stdout, /^starting aw5-/);
    assert.equal(field(started.stderr, 'code'), started.showDiagnostics ? 'startupNotReady' : undefined);
    t.diagnostic(`AW_SUBAGENT_PARENT_PHASE ${JSON.stringify({ phase: 'continueSamePendingRun', elapsedMs: started.elapsedMs })}`);
    if (started.scenario.readyGate) await started.releaseReady();
    await started.published();
    // Check the saved ready state without consuming public messages or ready.
    // Fast terminal cases retain their first original wait/result read.
    if (!started.scenario.finishImmediately) await eventually(async () => {
      return (await evidence(started.run)).snapshot.ready;
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
  // Private evidence supports controlled lifecycle injection and ready checks
  // that must not consume public messages or initialization notifications.
  async function evidence(run) {
    const value = await openRun(await storeContext({ temporaryRoot }), run);
    const read = async (name) => {
      try { return JSON.parse(await fs.readFile(path.join(value.directory, name), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    };
    return { ...value, snapshot: await read('snapshot.json'), result: await read('final.json') };
  }
  async function exportResult(run, { target = path.join(directory, `report-${++nextExport}.txt`), showDiagnostics = false, ...options } = {}) {
    const response = await command(['result', '--run', run, '--output-file', target, ...(showDiagnostics ? ['--diagnostics'] : [])], options);
    successful(response, 'result');
    const destination = path.resolve(options.cwd ?? workspace, target);
    const bytes = await fs.readFile(destination);
    assert.equal(response.stdout, `exported ${run} path=${JSON.stringify(destination)} bytes=${bytes.length} consumed=true\n`);
    return { ...response, report: bytes.toString('utf8'), target: destination };
  }
  t.after(async () => {
    const cleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
    phase('cleanupBegin', { timeoutMs: cleanupTimeoutMs });
    try {
      if (diagnostics) for (const scenario of scenarios) {
        const records = await fs.readFile(path.join(scenario.directory, 'phases.jsonl'), 'utf8').catch(() => '');
        for (const line of records.trim().split('\n').filter(Boolean)) t.diagnostic(`AW_SUBAGENT_ADAPTER_PHASE ${JSON.stringify({ scenario: scenario.index, ...JSON.parse(line) })}`);
      }
    }
    finally {
      try {
        for (const run of handles) {
          if (cleanupSignal.aborted) throw new Error('Fixture cleanup deadline exceeded.');
          // Crash/expiry tests can already have removed the handle. A returned
          // failure is allowed; a command that cannot finish is a cleanup error.
          await command(['stop', '--run', run], { signal: cleanupSignal, timeout: cleanupTimeoutMs });
        }
      }
      finally { await fs.rm(directory, { recursive: true, force: true }); phase('cleanupEnd'); }
    }
  }, { timeout: cleanupTimeoutMs + 5000 });
  return { directory, temporaryRoot, workspace, installed, generations, snapshot, config, save, command, start, initialized, clock, waitTerminal, evidence, exportResult, phase };
}


export { fixture, sleep, eventually, terminalPattern, windows, testTimeoutMs, blocks, field, records, bounded, successful };
