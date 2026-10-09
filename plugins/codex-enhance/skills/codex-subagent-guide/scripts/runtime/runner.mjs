import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { LIMITS, fail, redact, validateRequest, validateResult } from './contracts.mjs';
import { safePath, readText, readStdin, executablePaths, readJson } from './files.mjs';
import { validateEnvironmentConfig } from './plan.mjs';
import { validateSelectors } from '../file-selection/contracts.mjs';
import { processTable, observeTree, stopOwnedTree } from './processes.mjs';

export function resolveAdapterEnvironment(source = process.env, executor = {}) {
  validateEnvironmentConfig(executor);
  const host = { ...source };
  const environment = Object.fromEntries(Object.entries(host).filter(([key, value]) => typeof value === 'string' && !key.startsWith('AW_PLUGIN_') && !key.startsWith('AW_SUBAGENT_')));
  const referenced = {};
  const secretValues = [];
  for (const [target, origin] of Object.entries(executor.envFrom ?? {})) {
    if (!Object.hasOwn(host, origin) || typeof host[origin] !== 'string') fail('environmentSourceMissing', 'A configured envFrom host variable is missing. Set the source variable before running.');
    if (host[origin].includes('\0')) fail('environmentInvalid', 'An envFrom host value contains NUL.');
    referenced[target] = host[origin];
    secretValues.push(host[origin]);
  }
  return { environment: { ...environment, ...(executor.env ?? {}), ...referenced }, secretValues };
}
export function adapterEnvironment(source = process.env, executor = {}) {
  return resolveAdapterEnvironment(source, executor).environment;
}

export async function prepareRun(selected, request, options = {}) {
  const fileSelectors = request.files ?? [];
  if (selected.mode === 'workspace' && fileSelectors.length) fail('filesNotAllowedInWorkspace', 'Workspace execution does not accept --file. Describe the focus paths in the prompt.');
  if (request.prompt === undefined) fail('argumentsRequired', 'Supply --profile and --prompt TEXT or --prompt -.');
  if (selected.mode === 'bundle') validateSelectors(fileSelectors);
  const workspace = await fs.realpath(path.resolve(request.workspace ?? process.cwd())).catch(() => fail('workspaceMissing', 'The workspace is missing.'));
  await safePath(workspace, 'directory');
  let task;
  if (request.prompt === '-') task = await readStdin(options.stdin ?? process.stdin);
  else {
    if (typeof request.prompt !== 'string' || !request.prompt.isWellFormed() || request.prompt.includes('\0')) fail('promptInvalid', 'The prompt must be valid UTF-8 text without NUL.');
    if (Buffer.byteLength(request.prompt) > LIMITS.taskBytes) fail('taskTooLarge', 'The prompt exceeds the 256 KiB limit. Use a smaller task.');
    task = request.prompt;
  }
  if (!task.trim()) fail('inputEmpty', 'The prompt is empty. Supply a task.');
  let prompt = task;
  if (request.instructionsFile !== undefined) {
    if (typeof request.instructionsFile !== 'string' || !request.instructionsFile || request.instructionsFile === '-') fail('instructionsInvalid', 'Use a readable instruction file path; stdin is reserved for --prompt -.');
    const instructions = await readText(request.instructionsFile, LIMITS.instructionBytes, 'instructionsTooLarge');
    prompt = `执行指令：\n${instructions}\n\n本次任务：\n${task}`;
  }
  let executable;
  try { executable = await executablePaths(selected.command, selected.entrypoint); }
  catch (error) {
    if (selected.executor.adapter !== 'custom') fail('installedRuntimeMissing', 'The installed adapter resource is missing or unreadable. Sync or reinstall the Guide.', ['sync', 'reinstall']);
    throw error;
  }
  const wire = {
    protocolVersion: 4, execution: { ...selected.execution }, mode: selected.mode,
    workspace, prompt, args: [...selected.executor.args],
    ...(selected.mode === 'bundle' ? {
      fileSelectors: [...fileSelectors],
      fileResolver: { command: process.execPath, args: [path.join(selected.resourceRoot, 'scripts', 'resolve-files.mjs')] },
    } : {}),
  };
  validateRequest(wire);
  return { selected, executable, originalWorkspace: workspace, request: wire, ...resolveAdapterEnvironment(options.environment ?? process.env, selected.executor) };
}

export function previewResult(prepared) {
  return {
    preview: true, execution: prepared.request.execution, mode: prepared.request.mode,
    workspace: prepared.request.workspace, args: prepared.request.args,
    ...(prepared.request.mode === 'bundle' ? { fileSelectors: prepared.request.fileSelectors } : {}),
    environmentNames: Object.keys(prepared.selected.executor.env ?? {}),
    environmentReferences: { ...(prepared.selected.executor.envFrom ?? {}) },
  };
}

export function formatPreview(preview) {
  const lines = [`PREVIEW · ${preview.execution.profile} → ${preview.execution.executor} · ${preview.mode}`, `工作目录：${preview.workspace}`,
    `参数：${JSON.stringify(preview.args)}`];
  for (const key of ['model', 'reasoningEffort']) lines.push(`${key}：${preview.execution[key] ?? '后端默认'}`);
  if (preview.environmentNames.length) lines.push(`env 变量：${preview.environmentNames.join(', ')}`);
  if (Object.keys(preview.environmentReferences).length) lines.push(`envFrom 来源：${JSON.stringify(preview.environmentReferences)}`);
  if (preview.mode === 'bundle') {
    lines.push(`文件选择式（${preview.fileSelectors.length}）：`);
    for (const selector of preview.fileSelectors) lines.push(JSON.stringify(selector.length > 2048 ? `${selector.slice(0, 2048)}… [显示省略 ${selector.length - 2048} 个字符]` : selector));
    lines.push('未展开文件选择；未检查匹配文件；未启动解析器或后端。');
  } else lines.push('未启动后端。');
  return `${lines.join('\n')}\n`;
}

export function formatResult(result, execution, mode) {
  const lines = [`${result.state.toUpperCase()} · ${execution.profile} → ${execution.executor} · ${mode}`];
  if (result.state === 'unknown') lines.push('未确认服务终态。不要自动重新提交。');
  if (result.state !== 'completed') {
    if (result.code && /^[A-Za-z][A-Za-z0-9]*$/.test(result.code)) lines.push(`原因：${result.code}`);
    lines.push(`已知生成状态：${result.generationStarted === true ? '已开始' : result.generationStarted === false ? '未开始' : '未确认'}`);
    if (result.sessionId) lines.push(`会话：${JSON.stringify(result.sessionId)}`);
  }
  if (result.temporaryDirectory) lines.push(`本地收尾未确认或临时清理失败；保留目录：${result.temporaryDirectory}`);
  if (result.text) lines.push('', ...(result.state === 'unknown' ? ['部分结果：'] : []), result.text);
  return `${lines.join('\n')}\n`;
}

export function classifyResult(result, { adapterExitCode, localTreeStopped, interrupted }) {
  try { validateResult(result); } catch { return { state: 'unknown', code: 'adapterResultInvalid' }; }
  if (!localTreeStopped) return { state: 'unknown', code: 'localTreeStopUnconfirmed' };
  if (result.state === 'completed') {
    if (interrupted || adapterExitCode !== 0 || result.backendExitCode !== 0 || result.generationStarted !== true || !result.text.trim()) return { state: 'unknown', code: 'completionUnconfirmed' };
    return { state: 'completed' };
  }
  if (result.state === 'cancelled') return interrupted && (result.generationStarted === false || result.remoteStopConfirmed === true) ? { state: 'cancelled' } : { state: 'unknown', code: 'remoteStopUnconfirmed' };
  if ((interrupted || result.remoteStopConfirmed === false) && result.generationStarted !== false && result.remoteStopConfirmed !== true) return { state: 'unknown', code: 'remoteStopUnconfirmed' };
  if (result.state === 'failed') return { state: 'failed' };
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
    ...prepared.environment, AW_SUBAGENT_PROCESS_TOKEN: token,
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
  let cleanupAttempted = false;
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
      cleanupAttempted = true;
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
      cwd: prepared.originalWorkspace,
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
      cleanupAttempted = true;
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
    const classified = classifyResult(result, { adapterExitCode: code, localTreeStopped: localTreeStopped && !observationFailed, interrupted });
    if (overflow) Object.assign(classified, { state: 'unknown', code: 'adapterOutputTooLarge' });
    let resultValid = false;
    try { validateResult(result); resultValid = true; } catch { /* Retain only labelled partial text. */ }
    const safeResult = result?.protocolVersion === 4 ? {
      protocolVersion: 4,
      generationStarted: resultValid ? result.generationStarted : null,
      backendExitCode: Number.isSafeInteger(result.backendExitCode) ? result.backendExitCode : null,
      text: typeof result.text === 'string' && Buffer.byteLength(result.text) <= LIMITS.outputBytes ? result.text : '',
      ...Object.fromEntries(['code', 'message', 'sessionId', 'model'].filter((key) => typeof result[key] === 'string').map((key) => [key, result[key]])),
      ...(typeof result.remoteStopConfirmed === 'boolean' ? { remoteStopConfirmed: result.remoteStopConfirmed } : {}),
    } : { protocolVersion: 4, generationStarted: null, backendExitCode: null, text: '' };
    const final = {
      ...safeResult, ...classified, localTreeStopped: localTreeStopped && !observationFailed,
      adapterExitCode: code, diagnostics: Buffer.concat(diagnostics).toString('utf8'),
      restrictions: !outputClosed ? ['Output pipes did not close; local work can still be active.'] : [],
      ...(interrupted ? { stopRequested: true } : {}),
      ...(!localTreeStopped ? { temporaryDirectory: directory } : {}),
    };
    finalResult = { ...final };
    for (const key of ['text', 'diagnostics', 'code', 'message', 'sessionId', 'model']) if (typeof final[key] === 'string') finalResult[key] = redact(final[key], environment, prepared.secretValues);
    return finalResult;
  } catch (error) {
    if (!child) throw error;
    finalResult = { protocolVersion: 4, state: child.pid ? 'unknown' : 'failed', generationStarted: child.pid ? null : false,
      backendExitCode: null, text: '', code: child.pid ? 'foregroundUnconfirmed' : 'adapterStartFailed',
      localTreeStopped: false, adapterExitCode: child.exitCode, diagnostics: '', restrictions: [],
      ...(interrupted ? { stopRequested: true } : {}), temporaryDirectory: directory };
    return finalResult;
  } finally {
    clearTimeout(timer); clearTimeout(outputCloseTimer); clearInterval(monitor);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    await monitorBusy;
    if (child?.pid && !localTreeStopped && !cleanupAttempted) {
      // The dedicated live child handle remains owned even if the process observer fails.
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      const stopped = await stopOwnedTree(child.pid, tracked, token).catch(() => ({ stopped: false }));
      localTreeStopped = stopped.stopped;
    }
    if (!child?.pid) localTreeStopped = true;
    if (finalResult) finalResult.localTreeStopped = localTreeStopped && !observationFailed;
    const current = await fs.lstat(directory).catch(() => undefined);
    if ((!child || localTreeStopped) && current?.dev === directoryIdentity.dev && current?.ino === directoryIdentity.ino) {
      try { await fs.rm(directory, { recursive: true }); if (finalResult) delete finalResult.temporaryDirectory; }
      catch {
        if (finalResult) { finalResult.temporaryDirectory = directory; finalResult.restrictions.push('Local execution ended, but temporary-file cleanup failed.'); }
      }
    }
  }
}
