import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMITS, fail, redact, safeError, validateRequest, validateResult } from '../runtime/contracts.mjs';
import { safePath, readLimited, readStdin, textFromBytes, atomicJson } from '../runtime/files.mjs';
import { processTable, observeTree, stopOwnedTree } from '../runtime/processes.mjs';

export function rejectOption(option) {
  fail('adapterArgumentConflict', `The adapter owns ${option}. Remove it from args.`);
}

/** Check owned controls, not a general backend option allowlist. */
export function checkArguments(args, { owned, commands = [], short = {}, booleans = [], values = [], variadic = [], onOption }) {
  let valueExpected = false;
  let variadicExpected = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (valueExpected) { valueExpected = false; continue; }
    if (variadicExpected && !argument.startsWith('-')) continue;
    variadicExpected = false;
    if (argument === '--' || argument === '-') rejectOption(argument);
    if (!argument.startsWith('-')) {
      // A bare backend command or prompt can replace the one owned invocation.
      fail('adapterArgumentConflict', 'args must contain backend options and their values, not a command or prompt.');
    }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const option = equals < 0 ? argument : argument.slice(0, equals);
      const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
      if (owned.includes(option)) rejectOption(option);
      onOption?.(option, value);
      variadicExpected = equals < 0 && variadic.includes(option);
      valueExpected = equals < 0 && !variadicExpected && (values.includes(option) || (!booleans.includes(option) && typeof value === 'string' && !value.startsWith('-')));
      continue;
    }
    // Public short aliases accept both separate and attached values. Boolean
    // aliases can be clustered; a value-taking alias owns the cluster suffix.
    for (let offset = 1; offset < argument.length; offset++) {
      const option = `-${argument[offset]}`;
      if (owned.includes(option)) rejectOption(option);
      const kind = short[option];
      if (kind === 'value') {
        const value = argument.slice(offset + 1) || args[index + 1];
        onOption?.(option, value);
        variadicExpected = variadic.includes(option);
        valueExpected = !variadicExpected && offset + 1 === argument.length;
        break;
      }
      if (kind !== 'boolean') {
        // Unknown options remain the backend's error responsibility. A command
        // immediately after one cannot be used as a control escape.
        const next = args[index + 1];
        if (commands.includes(next)) rejectOption(next);
        valueExpected = offset + 1 === argument.length && typeof next === 'string' && !next.startsWith('-');
        break;
      }
      onOption?.(option, undefined);
    }
  }
}

export async function privateOutputPath(directory, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.normalize(target) !== target) fail('adapterOutputPathInvalid', 'The adapter output path must be absolute and normalized.');
  const relative = path.relative(directory, target);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) fail('adapterOutputPathInvalid', 'The adapter output must stay in this private run directory.');
  await safePath(path.dirname(target), 'directory');
  try { await fs.lstat(target); fail('adapterOutputExists', 'This output already exists. Do not resubmit an existing run.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

export async function finalOutput(target) {
  const value = textFromBytes(await readLimited(target, LIMITS.outputBytes, 'adapterOutputTooLarge'));
  await fs.chmod(target, 0o600);
  return value;
}

async function runBackend(command, args, request, environment, control, onSpawn, deadlineMs) {
  // The runner controls this marker. The backend inherits the full effective
  // environment so its normal auth, hooks, plugins and tools keep working.
  const token = environment.AW_SUBAGENT_PROCESS_TOKEN;
  if (!/^[a-f0-9]{48}$/.test(token ?? '')) fail('processMarkerMissing', 'Run this adapter through the installed Guide runner.');
  await processTable();
  if (control.interrupted) fail('adapterStoppedBeforeSubmission', 'The adapter was stopped before backend startup.');
  const child = spawn(command, args, { shell: false, detached: false, cwd: request.workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  control.child = child;
  let exitCode = null;
  let exited = false;
  let closed = false;
  let observationFailed = false;
  let bytes = 0;
  let overflow = false;
  let known = [];
  let observation = Promise.resolve();
  const stdout = [];
  const stderr = [];
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  const exit = new Promise((resolve) => {
    child.once('error', () => { exited = true; resolve(); });
    child.once('exit', (code) => { exited = true; exitCode = code; resolve(); });
  });
  const close = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  const collect = (destination, chunk) => {
    bytes += chunk.length;
    if (bytes > LIMITS.logBytes) { overflow = true; child.kill('SIGTERM'); return; }
    destination.push(chunk);
  };
  child.stdout.on('data', (chunk) => collect(stdout, chunk));
  child.stderr.on('data', (chunk) => collect(stderr, chunk));
  child.stdin.on('error', () => {});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }).catch((error) => {
    fail(error.code === 'ENOENT' ? 'backendExecutableMissing' : 'backendStartFailed', `${command} could not start. Check its installation, PATH, and supported arguments.`);
  });
  onSpawn();
  const observe = () => {
    observation = observation.then(async () => {
      try { known = await observeTree(child.pid, known, token); }
      catch { observationFailed = true; child.kill('SIGTERM'); }
    });
  };
  observe();
  const observer = setInterval(observe, 100);
  const deadline = setTimeout(() => { control.timedOut = true; child.kill('SIGTERM'); }, deadlineMs);
  child.stdin.end(request.prompt);
  let stopped = false;
  try {
    // A stopped child can keep pipes open through descendants. Do not mistake
    // exit for close, and do not wait without a local cleanup boundary.
    await Promise.race([exit, new Promise((resolve) => {
      const interval = setInterval(() => {
        if (control.interrupted || control.timedOut || overflow || observationFailed) { clearInterval(interval); resolve(); }
        else if (exited) { clearInterval(interval); resolve(); }
      }, 50);
    })]);
    clearInterval(observer);
    await observation;
    const remaining = await observeTree(child.pid, known, token);
    const table = await processTable();
    const active = remaining.some((identity) => table.some((row) => row.pid === identity.pid && row.started === identity.started));
    stopped = active ? (await stopOwnedTree(child.pid, remaining, token)).stopped : true;
    if (!closed) {
      let closeTimer;
      await Promise.race([close, new Promise((resolve) => { closeTimer = setTimeout(resolve, 1000); })]);
      clearTimeout(closeTimer);
    }
    if (!closed) { stopped = false; child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); }
  } catch { stopped = false; }
  finally { clearInterval(observer); clearTimeout(deadline); control.child = undefined; }
  return { code: exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stopped: stopped && !observationFailed, overflow, spawnError };
}

export async function executeAdapter(request, environment, backend, { deadlineMs = LIMITS.deadlineMs } = {}) {
  const result = { protocolVersion: 4, state: 'failed', generationStarted: false, backendExitCode: null, text: '' };
  const control = { interrupted: false, timedOut: false };
  const onSignal = () => { control.interrupted = true; control.child?.kill('SIGTERM'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let resultFile;
  try {
    const directory = environment.AW_SUBAGENT_TEMP_DIR;
    if (!directory) fail('adapterDirectoryMissing', 'Run this adapter through the installed Guide runner.');
    await safePath(directory, 'directory');
    if (((await fs.stat(directory)).mode & 0o077) !== 0) fail('directoryNotPrivate', 'The adapter run directory must have mode 0700.');
    resultFile = await privateOutputPath(directory, environment.AW_SUBAGENT_RESULT_FILE);
    validateRequest(request);
    if (request.mode !== backend.mode) fail('adapterModeUnsupported', `${backend.command} requires ${backend.mode} mode.`);
    await safePath(request.workspace, 'directory');
    const outputFile = await privateOutputPath(directory, path.join(directory, `${backend.command}-answer.md`));
    const args = backend.arguments(request, outputFile, environment);
    await backend.preflight?.(request, control);
    const run = await runBackend(backend.command, args, request, environment, control, () => { result.generationStarted = null; }, deadlineMs);
    result.backendExitCode = run.code;
    Object.assign(result, await backend.result(request, run, outputFile));
    if (result.state !== 'completed' && !result.message && !run.overflow) {
      // Keep a bounded actual backend error for repair. The outer runner also
      // removes resolved envFrom values, which are deliberately absent here.
      try {
        const diagnostic = textFromBytes(run.stderr).trim();
        const loggedError = textFromBytes(run.stdout).split('\n').filter((line) => /^\s*(?:ERROR:|error:)/i.test(line)).slice(-2).join('\n');
        if (diagnostic || loggedError) result.message = redact((diagnostic || loggedError).slice(-8192), environment);
      } catch { /* Invalid diagnostic bytes do not establish a service terminal. */ }
    }
    if (!run.stopped) Object.assign(result, { state: 'unknown', code: 'localTreeStopUnconfirmed' });
    else if (run.overflow) Object.assign(result, { state: 'unknown', code: 'adapterOutputTooLarge' });
    else if (control.interrupted || control.timedOut) Object.assign(result, { state: 'unknown', code: control.timedOut ? 'adapterDeadlineExceeded' : 'remoteStopUnconfirmed', remoteStopConfirmed: false });
  } catch (error) {
    const safe = safeError(error);
    result.state = result.generationStarted === false && !['protocolInvalid', 'protocolTooLarge'].includes(safe.code) ? 'failed' : 'unknown';
    result.code = safe.code;
    const selectionError = /^fileSelection(?:InputInvalid|PathMissing|Empty|ReadFailed|LimitExceeded|Failed|Unsupported)$/.test(safe.code);
    result.message = redact(selectionError && typeof error.message === 'string' ? error.message : safe.message, environment);
    if (control.interrupted) {
      result.state = result.generationStarted === false ? 'cancelled' : 'unknown';
      if (result.generationStarted !== false) result.remoteStopConfirmed = false;
    }
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  result.text = redact(result.text, environment);
  if (result.message) result.message = redact(result.message.slice(0, 8192), environment);
  if (resultFile) await atomicJson(resultFile, validateResult(result));
  return result;
}

export function adapterMain(moduleUrl, execute, help) {
  if (!process.argv[1] || fileURLToPath(moduleUrl) !== path.resolve(process.argv[1])) return;
  const main = async () => {
    process.umask(0o077);
    if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) { process.stdout.write(help); return; }
    if (process.argv.length !== 2) fail('adapterArgumentsInvalid', 'This wrapper accepts only stdin JSON or --help. Put backend arguments in request.args.');
    let request;
    try { request = JSON.parse(await readStdin(process.stdin, LIMITS.requestBytes, 'protocolTooLarge')); }
    catch (error) { if (error.code) throw error; fail('protocolInvalid', 'The adapter requires one UTF-8 Adapter v4 JSON request.'); }
    const result = await execute(request);
    if (result.state !== 'completed') process.exitCode = 1;
  };
  main().catch((error) => { process.stderr.write(`${JSON.stringify(safeError(error))}\n`); process.exitCode = 1; });
}
