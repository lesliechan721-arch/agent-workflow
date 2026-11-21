#!/usr/bin/env node
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// node scripts/qualification/windows-renderer-race.mjs [cli-dist] [abort|cleanup-failed]
const defaultDist = fileURLToPath(new URL('../../packages/cli/dist/', import.meta.url));
const waitWord = new Int32Array(new SharedArrayBuffer(4));
const cases = ['complete', 'interrupt-running', 'interrupt-before-events'];
const knownSignals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);
const knownErrnos = new Set(['EACCES', 'ENOENT', 'EPERM', 'ESRCH', 'EINVAL', 'ENOSYS', 'UNKNOWN']);
const errno = (error) => knownErrnos.has(error?.code) ? error.code : null;
const exitCode = (value) => Number.isSafeInteger(value) ? value : null;
const signalCode = (value) => knownSignals.has(value) ? value : null;
const hashFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

const renderer = `
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const file = (name) => new URL(name, import.meta.url);
writeFileSync(file('starting'), String(process.pid));
renameSync(file('starting'), file('started'));
const deadline = Date.now() + 14_000;
while (!existsSync(file('release')) && Date.now() < deadline) await delay(10);
if (existsSync(file('release'))) writeFileSync(file('finished'), 'complete');
else process.exitCode = 2;
`;

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return 'unobserved';
  try { process.kill(pid, 0); return 'live'; }
  catch (error) { return error?.code === 'ESRCH' ? 'exited' : 'unconfirmed'; }
}

async function waitFor(read, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await delay(10);
  } while (performance.now() < deadline);
  return undefined;
}

function waitForHelperExit(pid) {
  const deadline = performance.now() + 5_000;
  // No await or asynchronous child observer can deliver callbacks on this stack.
  do {
    const state = processState(pid);
    if (state !== 'live') return state;
    Atomics.wait(waitWord, 0, 0, 4);
  } while (performance.now() < deadline);
  return 'live';
}

function fixtureEnvironment(root) {
  const system = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'AW_NATIVE_TOOL_CONTEXT'];
  const env = Object.fromEntries(system.filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  const paths = [path.dirname(process.execPath)];
  if (env.SystemRoot && path.isAbsolute(env.SystemRoot)) paths.push(path.join(env.SystemRoot, 'System32'));
  return { ...env, PATH: paths.join(path.delimiter),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    AW_HOME: path.join(home, 'aw'), TEMP: temp, TMP: temp, TMPDIR: temp };
}

function observeHelper(trial) {
  const prototype = ChildProcess.prototype;
  const emitDescriptor = Object.getOwnPropertyDescriptor(prototype, 'emit');
  const killDescriptor = Object.getOwnPropertyDescriptor(prototype, 'kill');
  const emit = prototype.emit;
  const kill = prototype.kill;
  const current = (child) => trial.helperPid !== null && child.pid === trial.helperPid;
  prototype.emit = function (event, ...values) {
    if (current(this) && (event === 'exit' || event === 'close')) {
      trial.record(event, { exitCode: exitCode(values[0]), signal: signalCode(values[1]) });
    } else if (current(this) && event === 'error') trial.record('child-error', { errno: errno(values[0]) });
    return Reflect.apply(emit, this, [event, ...values]);
  };
  prototype.kill = function (...args) {
    if (!current(this)) return Reflect.apply(kill, this, args);
    try {
      const accepted = Reflect.apply(kill, this, args);
      trial.record('helper-kill', { accepted });
      return accepted;
    } catch (error) {
      trial.record('kill-error', { errno: errno(error) });
      throw error;
    }
  };
  return () => {
    if (emitDescriptor) Object.defineProperty(prototype, 'emit', emitDescriptor);
    else delete prototype.emit;
    if (killDescriptor) Object.defineProperty(prototype, 'kill', killDescriptor);
    else delete prototype.kill;
  };
}

async function fixturePid(file) {
  try {
    const pid = Number(await readFile(file, 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? pid : undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function runnerRejection(error, original, readDiagnostic) {
  const code = readDiagnostic(error)?.code;
  const cleanupFailed = code === 'pluginProcessCleanupFailed' || code === 'processCleanupUnconfirmed';
  const detail = error?.message === 'Windows Job helper did not accept termination.' ? 'kill-not-accepted'
    : error?.message === 'Windows Job helper exit could not be confirmed.' ? 'close-deadline' : null;
  return { kind: error === original ? 'abort' : cleanupFailed ? 'cleanup-failed' : 'runner-error',
    diagnostic: cleanupFailed ? code : null, detail, errno: errno(error) };
}

async function runCase(root, name, runner, readDiagnostic) {
  await mkdir(root);
  const env = fixtureEnvironment(root);
  await Promise.all([env.AW_HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP].map((dir) => mkdir(dir, { recursive: true })));
  const entry = path.join(root, 'renderer.mjs');
  const started = path.join(root, 'started');
  const release = path.join(root, 'release');
  const finished = path.join(root, 'finished');
  await writeFile(entry, renderer);
  const begin = performance.now();
  const events = [];
  const trial = { name, helperPid: null, rendererPid: null, events,
    record: (event, facts = {}) => events.push({ event, elapsedMs: Math.round(performance.now() - begin), ...facts }) };
  const restore = observeHelper(trial);
  const controller = new AbortController();
  const abortReason = new DOMException('Controlled renderer interruption.', 'AbortError');
  const abort = () => { trial.record('abort'); controller.abort(abortReason); };
  const snapshot = () => ({ helper: processState(trial.helperPid), renderer: processState(trial.rendererPid),
    finished: existsSync(finished), exitDelivered: events.some(({ event }) => event === 'exit'),
    closeDelivered: events.some(({ event }) => event === 'close') });
  let outcome;
  const pending = runner.run({ command: process.execPath, args: [entry], cwd: root, env }, {
    signal: controller.signal, timeoutMs: 16_000, onSpawn({ pid }) {
      trial.helperPid = pid;
      trial.record('spawn');
    },
  }).then((value) => ({ kind: 'returned', exitCode: exitCode(value.exitCode), signal: signalCode(value.signal), timedOut: value.timedOut }),
    (error) => runnerRejection(error, abortReason, readDiagnostic)).then((result) => {
    outcome = result;
    trial.record('runner-settled');
    return result;
  });
  let beforeAbort = null;
  let setup = 'ready';
  try {
    trial.rendererPid = await waitFor(async () => await fixturePid(started) ?? (outcome ? 'settled' : undefined), 8_000);
    if (!Number.isSafeInteger(trial.rendererPid)) {
      trial.rendererPid = null;
      setup = 'renderer-start-unobserved';
    } else if (trial.rendererPid === trial.helperPid || processState(trial.helperPid) !== 'live'
      || processState(trial.rendererPid) !== 'live') {
      setup = 'owned-processes-not-live';
    } else {
      trial.record('renderer-started');
      if (name !== 'interrupt-running') writeFileSync(release, 'finish');
      if (name === 'interrupt-before-events') {
        waitForHelperExit(trial.helperPid);
        beforeAbort = snapshot();
        if (beforeAbort.helper !== 'exited' || beforeAbort.renderer !== 'exited' || !beforeAbort.finished
          || beforeAbort.exitDelivered || beforeAbort.closeDelivered) setup = 'race-window-unobserved';
      } else if (name === 'interrupt-running') beforeAbort = snapshot();
      if (setup === 'ready' && name !== 'complete') abort();
    }
  } catch (error) {
    setup = 'fixture-observation-failed';
    trial.record('fixture-error', { errno: errno(error) });
  } finally {
    if (setup !== 'ready' && !outcome && !controller.signal.aborted) abort();
    await pending;
    await waitFor(() => trial.helperPid === null || events.some(({ event }) => event === 'close')
      && processState(trial.helperPid) === 'exited' && processState(trial.rendererPid) === 'exited', 5_000);
    restore();
  }
  const after = snapshot();
  return { name, helperPid: trial.helperPid, rendererPid: trial.rendererPid, setup, beforeAbort, outcome, after, events,
    elapsedMs: Math.round(performance.now() - begin) };
}

async function main() {
  const [dist = defaultDist, expectedRace, ...extra] = process.argv.slice(2);
  if (process.platform !== 'win32') return { check: 'unsupported-host' };
  if (extra.length || expectedRace !== undefined && !['abort', 'cleanup-failed'].includes(expectedRace)) return { check: 'invalid-arguments' };
  const product = (name) => path.resolve(dist, 'src/utils', `${name}.js`);
  const { defaultPluginProcessRunner } = await import(pathToFileURL(product('plugin-scripts')));
  const { readSafeOperationError } = await import(pathToFileURL(product('safe-operation-diagnostic')));
  const { resolveWindowsJobHelperPath } = await import(pathToFileURL(product('process-tree')));
  const productSha256 = await hashFile(product('plugin-scripts'));
  const helperSha256 = await hashFile(await resolveWindowsJobHelperPath());
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-windows-renderer-race-'));
  const trials = [];
  for (const name of cases) trials.push(await runCase(path.join(root, name), name, defaultPluginProcessRunner, readSafeOperationError));
  const [complete, interrupted, race] = trials;
  const controlsPassed = complete.outcome.kind === 'returned' && complete.outcome.exitCode === 0
    && complete.after.finished && interrupted.beforeAbort?.helper === 'live' && interrupted.beforeAbort.renderer === 'live'
    && interrupted.outcome.kind === 'abort' && !interrupted.after.finished;
  const ownedProcessesExited = trials.every(({ after }) => after.helper === 'exited' && after.renderer === 'exited' && after.closeDelivered);
  if (ownedProcessesExited) await rm(root, { recursive: true, force: true });
  const observed = controlsPassed && ownedProcessesExited && trials.every(({ setup }) => setup === 'ready')
    && ['abort', 'cleanup-failed'].includes(race.outcome.kind);
  const check = !observed ? 'incomplete' : expectedRace && expectedRace !== race.outcome.kind ? 'unexpected-race-result' : 'observed';
  return { check, platform: process.platform, arch: process.arch, node: process.versions.node, productSha256, helperSha256,
    controlsPassed, ownedProcessesExited, expectedRace: expectedRace ?? null, trials };
}

try {
  const report = await main();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.check !== 'observed') process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ check: 'setup-or-runner-failed', errno: errno(error) })}\n`);
  process.exitCode = 1;
}
