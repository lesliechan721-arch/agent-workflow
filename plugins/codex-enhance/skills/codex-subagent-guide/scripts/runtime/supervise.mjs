import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMITS, digest, redact } from './contracts.mjs';
import { readJson, readLimited, atomicJson, executableIdentity } from './files.mjs';
import { processTable, observeTree, stopOwnedTree } from './processes.mjs';
import { adapterEnvironment } from './runner.mjs';

/** Program receipts never grade the worker's business answer. */
export function outcomeFromEvidence({ exitCode, output, receipt, instructionRevision, interrupted = false, localTreeStopped = false }) {
  if (!receipt || receipt.protocolVersion !== 2 || !['system', 'developer', 'equivalent-config'].includes(receipt.instructionChannel) || receipt.instructionsRevision !== instructionRevision) return { state: 'unknown', code: 'receiptMissingOrIncompatible' };
  if (['completed', 'failed', 'cancelled'].includes(receipt.outcome) && !localTreeStopped) return { state: 'unknown', code: 'localTreeStopUnconfirmed' };
  if (receipt.outcome === 'completed' && ((receipt.generationStarted !== undefined && receipt.generationStarted !== true) || (receipt.scopeViolation !== undefined && receipt.scopeViolation !== false) || (receipt.localExitCode !== undefined && receipt.localExitCode !== 0))) return { state: 'unknown', code: 'receiptContradictory' };
  if (receipt.outcome === 'completed' && exitCode === 0 && output.trim() && ['completed', 'turn.completed'].includes(receipt.providerTerminal) && !interrupted) return { state: 'completed' };
  if (receipt.outcome === 'failed' && ['failed', 'turn.failed'].includes(receipt.providerTerminal)) return { state: 'failed', code: receipt.code === 'parameterUnavailable' ? 'parameterUnavailable' : 'providerFailed' };
  if (receipt.outcome === 'failed' && receipt.generationStarted === false) return { state: 'failed', code: 'adapterPreconditionFailed' };
  if (receipt.outcome === 'cancelled' && receipt.providerStopped === true && localTreeStopped) return { state: 'cancelled' };
  return { state: 'unknown', code: interrupted ? localTreeStopped ? 'remoteStopUnconfirmed' : 'localTreeStopUnconfirmed' : 'providerTerminalUnconfirmed' };
}

export async function supervise(runDirectory) {
  process.umask(0o077);
  const recordPath = path.join(runDirectory, 'record.json');
  const record = await readJson(recordPath);
  const environment = {
    ...adapterEnvironment(),
    ...(process.env.AW_SUBAGENT_CODEX_EXPECTED_SHA256 ? { AW_SUBAGENT_CODEX_EXPECTED_SHA256: process.env.AW_SUBAGENT_CODEX_EXPECTED_SHA256 } : {}),
    AW_SUBAGENT_PROCESS_TOKEN: record.processToken,
    AW_SUBAGENT_RUN_DIR: runDirectory,
    AW_SUBAGENT_RESULT_FILE: path.join(runDirectory, 'receipt.json'),
    AW_SUBAGENT_TRACE_FILE: path.join(runDirectory, 'codex-events.jsonl'),
  };
  let child;
  let tracked = [];
  let interrupted = false;
  let localTreeStopped = false;
  let stopping;
  let scanner;
  let deadline;
  let outputBytes = 0;
  let logBytes = 0;
  const output = [];
  const diagnostics = [];
  const stop = () => {
    interrupted = true;
    if (!stopping && child?.pid) stopping = stopOwnedTree(child.pid, tracked, record.processToken)
      .then((result) => { tracked = result.tracked; localTreeStopped = result.stopped; })
      .catch(() => { localTreeStopped = false; });
    return stopping;
  };
  const onSignal = () => { void stop(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    record.supervisor = (await processTable()).find((item) => item.pid === process.pid);
    const identity = await executableIdentity(record.executable.path, record.executable.entrypoint?.path);
    if (identity.sha256 !== record.executable.sha256 || identity.entrypoint?.sha256 !== record.executable.entrypoint?.sha256) throw new Error('executorChanged');
    const input = await readLimited(path.join(runDirectory, 'request.json'), LIMITS.materialBytes + LIMITS.taskBytes + LIMITS.instructionBytes + 1048576);
    if (digest(JSON.stringify(JSON.parse(input.toString('utf8')))) !== record.requestDigest) throw new Error('requestChanged');
    child = spawn(record.executable.path, record.executable.entrypoint ? [record.executable.entrypoint.path] : [], {
      shell: false, detached: !environment.AW_AGENT_SKILL_EVAL_PROCESS_MARKER, cwd: record.plan.mode === 'bundle' ? path.join(runDirectory, 'materials') : record.originalWorkspace,
      stdio: ['pipe', 'pipe', 'pipe'], env: environment,
    });
    const exited = new Promise((resolve) => {
      child.once('error', () => resolve({ code: null, spawnFailed: true }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    record.generationMayHaveStarted = true;
    tracked = await observeTree(child.pid, [], record.processToken);
    record.processes = tracked;
    await atomicJson(recordPath, record);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > LIMITS.outputBytes) { record.code = 'outputTooLarge'; void stop(); }
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      logBytes += chunk.length;
      if (logBytes > LIMITS.logBytes) { record.code = 'diagnosticsTooLarge'; void stop(); }
      else diagnostics.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    let scanning = false;
    scanner = setInterval(() => {
      if (scanning || interrupted) return;
      scanning = true;
      observeTree(child.pid, tracked, record.processToken).then((result) => { tracked = result; })
        .catch(() => { record.code = 'processObservationFailed'; void stop(); })
        .finally(() => { scanning = false; });
    }, 250);
    deadline = setTimeout(() => { record.code = 'runnerDeadlineExceeded'; void stop(); }, record.deadlineMs);
    const exit = await exited;
    clearInterval(scanner);
    clearTimeout(deadline);
    if (stopping) await stopping;
    else {
      const remaining = await observeTree(child.pid, tracked, record.processToken);
      localTreeStopped = (await stopOwnedTree(child.pid, remaining, record.processToken)).stopped;
    }
    const finalText = redact(Buffer.concat(output).toString('utf8'), environment);
    await fs.writeFile(path.join(runDirectory, 'output.md'), finalText, { mode: 0o600 });
    await fs.writeFile(path.join(runDirectory, 'diagnostics.log'), redact(Buffer.concat(diagnostics).toString('utf8'), environment), { mode: 0o600 });
    let receipt;
    try { receipt = await readJson(path.join(runDirectory, 'receipt.json'), LIMITS.receiptBytes); } catch { /* Missing evidence remains unknown. */ }
    const outcome = outcomeFromEvidence({ exitCode: exit.code, output: finalText, receipt, instructionRevision: record.plan.worker.instructionRevision, interrupted, localTreeStopped });
    record.state = outcome.state;
    record.code ??= outcome.code;
    if (record.code === 'outputTooLarge' || record.code === 'diagnosticsTooLarge') record.state = 'unknown';
    if (receipt) record.receipt = JSON.parse(redact(JSON.stringify(receipt), environment));
    record.exitCode = exit.code;
    record.localTreeStopped = localTreeStopped;
    record.processes = tracked;
  } catch {
    if (child?.pid) await stop();
    record.state = record.generationMayHaveStarted ? 'unknown' : 'failed';
    record.code ??= record.generationMayHaveStarted ? 'executionUnconfirmed' : 'executorPreconditionFailed';
  } finally {
    clearInterval(scanner);
    clearTimeout(deadline);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    record.endedAt = new Date().toISOString();
    await atomicJson(recordPath, record);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  supervise(process.argv[2]).catch(() => { process.exitCode = 1; });
}
