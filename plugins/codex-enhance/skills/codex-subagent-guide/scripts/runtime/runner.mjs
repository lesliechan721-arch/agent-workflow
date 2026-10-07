import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { LIMITS, STATES, fail, redact } from './contracts.mjs';
import { safePath, readText, inspectMaterials, executablePaths, readJson } from './files.mjs';
import { processTable, observeTree, stopOwnedTree } from './processes.mjs';

export const ENVIRONMENT_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR',
  'CODEX_HOME', 'OPENAI_API_KEY', 'AW_SUBAGENT_CODEX_BINARY', 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER',
]);
export function adapterEnvironment(source = process.env) {
  return Object.fromEntries(ENVIRONMENT_ALLOWLIST.filter((key) => typeof source[key] === 'string').map((key) => [key, source[key]]));
}

export async function prepareRun(selected, request) {
  if (!request.instructionsFile || !request.promptFile) fail('argumentsRequired', 'Run requires --instructions-file and --prompt-file.');
  const workspace = await fs.realpath(path.resolve(request.workspace ?? process.cwd())).catch(() => fail('workspaceMissing', 'The workspace is missing.'));
  await safePath(workspace, 'directory');
  const instructions = await readText(request.instructionsFile, LIMITS.instructionBytes, 'instructionsTooLarge');
  const task = await readText(request.promptFile, LIMITS.taskBytes, 'taskTooLarge');
  const selectedMaterials = await inspectMaterials(workspace, request.files ?? []);
  const executable = await executablePaths(selected.executor.command, selected.executor.entrypoint);
  return {
    selected, executable, originalWorkspace: workspace, totalBytes: selectedMaterials.totalBytes,
    request: {
      protocolVersion: 3, execution: selected.execution, mode: selected.mode, access: selected.access,
      workspace: selected.mode === 'workspace' ? workspace : null,
      instructions, task, materials: selectedMaterials.materials,
    },
  };
}

export function previewResult(prepared) {
  return {
    ok: true, preview: true, generationStarted: false,
    execution: prepared.request.execution, mode: prepared.request.mode, access: prepared.request.access,
    workspace: prepared.request.workspace,
    instructionsBytes: Buffer.byteLength(prepared.request.instructions), taskBytes: Buffer.byteLength(prepared.request.task),
    materialBytes: prepared.totalBytes,
    materials: prepared.request.materials.map(({ content, ...reference }) => reference),
    executable: prepared.executable,
    restrictions: restrictions(prepared.request), limits: LIMITS,
  };
}
function restrictions(request) {
  return request.mode === 'bundle'
    ? ['Only the explicitly selected UTF-8 material copies are supplied. No original workspace access is supplied.']
    : ['Workspace tools can read the live workspace after submission. Captured inputs are not a workspace snapshot.'];
}

export function classifyResult(result, { adapterExitCode, localTreeStopped, interrupted, access }) {
  if (!result || result.protocolVersion !== 3 || !STATES.includes(result.state) || typeof result.generationStarted !== 'boolean' || !result.service || !STATES.includes(result.service.state) || typeof result.text !== 'string' || Buffer.byteLength(result.text) > LIMITS.outputBytes || !result.access || result.access.mode !== access || !Array.isArray(result.access.restrictions) || result.access.restrictions.some((item) => typeof item !== 'string')) return { state: 'unknown', code: 'adapterResultInvalid' };
  if (!['system', 'developer', 'configuration'].includes(result.instructionChannel)) return { state: 'unknown', code: 'instructionChannelUnsupported' };
  if (!localTreeStopped) return { state: 'unknown', code: 'localTreeStopUnconfirmed' };
  if (result.state !== result.service.state) return { state: 'unknown', code: 'terminalConflict' };
  if (result.state === 'completed') {
    if (interrupted || adapterExitCode !== 0 || result.localExitCode !== 0 || !result.generationStarted || typeof result.service.event !== 'string' || !result.service.event.trim() || !result.text.trim()) return { state: 'unknown', code: 'completionUnconfirmed' };
    return { state: 'completed' };
  }
  if (result.state === 'cancelled') return result.remoteStopConfirmed === true && interrupted ? { state: 'cancelled' } : { state: 'unknown', code: 'remoteStopUnconfirmed' };
  if (interrupted) return { state: 'unknown', code: 'remoteStopUnconfirmed' };
  if (result.state === 'failed' && (result.generationStarted === false || (typeof result.service.event === 'string' && result.service.event.trim()))) return { state: 'failed' };
  return { state: 'unknown', code: result.code ?? 'serviceTerminalMissing' };
}

/** One foreground child and one private result file. No persistent identity or recovery store. */
export async function runForeground(prepared, options = {}) {
  // Fail before launching if the environment cannot observe and stop this process tree.
  await processTable();
  const temporaryRoot = await fs.realpath(options.temporaryRoot ?? os.tmpdir());
  await safePath(temporaryRoot, 'directory');
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'aw-subagent-'));
  await fs.chmod(directory, 0o700);
  const directoryIdentity = await fs.lstat(directory);
  const resultFile = path.join(directory, 'result.json');
  const token = randomBytes(24).toString('hex');
  const environment = {
    ...adapterEnvironment(options.environment ?? process.env), AW_SUBAGENT_PROCESS_TOKEN: token,
    AW_SUBAGENT_TEMP_DIR: directory, AW_SUBAGENT_RESULT_FILE: resultFile,
  };
  let child;
  let tracked = [];
  let observationFailed = false;
  let interrupted = false;
  let stopping;
  let finishStop;
  const stopCompleted = new Promise((resolve) => { finishStop = resolve; });
  let outputBytes = 0;
  let overflow = false;
  const diagnostics = [];
  let timer;
  let monitor;
  let monitorBusy = Promise.resolve();
  let localTreeStopped = false;
  let finalResult;
  let outputClosed = false;
  let outputCloseTimer;
  const stop = () => {
    interrupted = true;
    if (!child || stopping) return;
    child.kill('SIGTERM');
    stopping = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await monitorBusy;
      const stopped = await stopOwnedTree(child.pid, tracked, token);
      tracked = stopped.tracked;
      localTreeStopped = stopped.stopped;
    })().catch(() => { observationFailed = true; }).finally(() => { finishStop({ code: child.exitCode }); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (options.signal?.aborted) fail('runCancelledBeforeStart', 'The invocation was stopped before the adapter started.');
    child = spawn(prepared.executable.command, prepared.executable.entrypoint ? [prepared.executable.entrypoint] : [], {
      cwd: prepared.request.mode === 'workspace' ? prepared.originalWorkspace : directory,
      shell: false, detached: false, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => {
      child.once('error', () => resolve({ code: null, spawnFailed: true }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const closed = new Promise((resolve) => { child.once('close', () => resolve(true)); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > LIMITS.logBytes) { overflow = true; stop(); return; }
      diagnostics.push(chunk);
    });
    child.stdin.on('error', () => {});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }).catch(() => fail('adapterStartFailed', 'The registered adapter could not start.'));
    tracked = await observeTree(child.pid, [], token);
    if (!tracked.some((row) => row.pid === child.pid)) fail('processObservationFailed', 'The adapter process is not visible to the process observer.');
    monitor = setInterval(() => {
      monitorBusy = monitorBusy.then(async () => { tracked = await observeTree(child.pid, tracked, token); }).catch(() => { observationFailed = true; stop(); });
    }, 250);
    timer = setTimeout(stop, options.deadlineMs ?? LIMITS.deadlineMs);
    child.stdin.end(JSON.stringify(prepared.request));
    const { code } = await Promise.race([exited, stopCompleted]);
    clearTimeout(timer); clearInterval(monitor);
    await monitorBusy;
    if (stopping) await stopping;
    if (!stopping) {
      const stopped = await stopOwnedTree(child.pid, tracked, token).catch(() => ({ stopped: false, tracked }));
      localTreeStopped = stopped.stopped; tracked = stopped.tracked;
    }
    // Descendants can retain these pipes after the adapter exits. Their lifetime
    // must not hold this invocation open after its own stop attempt has ended.
    outputClosed = await Promise.race([
      closed,
      new Promise((resolve) => { outputCloseTimer = setTimeout(() => resolve(false), 500); }),
    ]);
    clearTimeout(outputCloseTimer);
    if (!outputClosed) {
      localTreeStopped = false;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      child.unref();
    }
    let result;
    try {
      const stat = await fs.lstat(resultFile);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail('resultNotPrivate', 'The adapter result must be a private regular file.');
      result = await readJson(resultFile, LIMITS.resultBytes);
    } catch { /* A wrapper exit or ordinary text cannot establish the service outcome. */ }
    const classified = classifyResult(result, { adapterExitCode: code, localTreeStopped: localTreeStopped && !observationFailed, interrupted, access: prepared.request.access });
    if (overflow) Object.assign(classified, { state: 'unknown', code: 'adapterOutputTooLarge' });
    const safeResult = result?.protocolVersion === 3 ? {
      protocolVersion: 3, generationStarted: result.generationStarted !== false,
      instructionChannel: result.instructionChannel, service: result.service, text: typeof result.text === 'string' && Buffer.byteLength(result.text) <= LIMITS.outputBytes ? result.text : '',
      access: result.access, localExitCode: result.localExitCode, remoteStopConfirmed: result.remoteStopConfirmed, code: result.code,
    } : { protocolVersion: 3, generationStarted: true, service: { state: 'unknown' }, text: '', access: { mode: prepared.request.access, restrictions: [] } };
    const final = {
      ...safeResult, ...classified, localTreeStopped: localTreeStopped && !observationFailed,
      adapterExitCode: code,
      diagnostics: Buffer.concat(diagnostics).toString('utf8'),
      restrictions: [...restrictions(prepared.request), ...(Array.isArray(result?.access?.restrictions) ? result.access.restrictions.filter((item) => typeof item === 'string') : []),
        ...(!outputClosed ? ['Output pipes did not close after adapter exit or the stop attempt. Diagnostics can be incomplete; related local work can still be active.'] : [])],
      ...(interrupted ? { stopRequested: true } : {}),
      ...(!localTreeStopped ? { temporaryDirectory: directory } : {}),
    };
    finalResult = {
      ...final, text: redact(final.text, environment), diagnostics: redact(final.diagnostics, environment),
      restrictions: final.restrictions.map((item) => redact(item, environment)),
      instructionChannel: ['system', 'developer', 'configuration'].includes(final.instructionChannel) ? final.instructionChannel : undefined,
      code: typeof final.code === 'string' ? redact(final.code, environment) : undefined,
      access: { mode: prepared.request.access, restrictions: (Array.isArray(final.access?.restrictions) ? final.access.restrictions : []).filter((item) => typeof item === 'string').map((item) => redact(item, environment)) },
      service: final.service && {
        state: STATES.includes(final.service.state) ? final.service.state : 'unknown',
        ...(typeof final.service.event === 'string' ? { event: redact(final.service.event, environment) } : {}),
        ...(typeof final.service.sessionId === 'string' ? { sessionId: redact(final.service.sessionId, environment) } : {}),
        ...(typeof final.service.model === 'string' ? { model: redact(final.service.model, environment) } : {}),
      },
    };
    return finalResult;
  } finally {
    clearTimeout(timer); clearTimeout(outputCloseTimer); clearInterval(monitor);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    await monitorBusy;
    if (child?.pid && !localTreeStopped && !finalResult) {
      // The dedicated live child handle remains owned even if the process observer fails.
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      const stopped = await stopOwnedTree(child.pid, tracked, token).catch(() => ({ stopped: false }));
      localTreeStopped = stopped.stopped;
    }
    const current = await fs.lstat(directory).catch(() => undefined);
    if ((!child || localTreeStopped) && current?.dev === directoryIdentity.dev && current?.ino === directoryIdentity.ino) {
      try { await fs.rm(directory, { recursive: true }); }
      catch {
        if (finalResult) { finalResult.temporaryDirectory = directory; finalResult.restrictions.push('Local execution ended, but temporary-file cleanup failed.'); }
      }
    }
  }
}
