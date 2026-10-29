#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { atomicJson, readJson, executablePaths, fileFailureDiagnostic } from './runtime/files.mjs';
import { LIMITS, redact, fail, safeError, validateResult } from './runtime/contracts.mjs';
import { sanitizeDiagnostics, summarizeDiagnostics } from './runtime/diagnostics.mjs';
import { createFrameDecoder, createFrameWriter, createProtocolState } from './runtime/protocol.mjs';
import { safeSpawn, resolveSafeCommand } from './runtime/platform.mjs';
import { processTable, observeTree, stopOwnedTree } from './runtime/processes.mjs';
import { storeContext, readOwner, recordFiles, readRecord, saveGap, removeScratch, delay } from './runtime/store.mjs';

export async function runWorker(directory) {
  const startedAt = Date.now();
  const context = await storeContext({ temporaryRoot: path.dirname(path.dirname(directory)) });
  const run = await readOwner(context, path.basename(directory));
  if (run.directory !== directory || process.env.AW_SUBAGENT_PROCESS_TOKEN !== run.meta.token) fail('workerIdentityInvalid', 'The worker ownership binding is invalid.');
  const bootstrapEnd = Date.now() + 10000;
  let prepared;
  while (!prepared) {
    try { prepared = await readJson(path.join(directory, 'launch.json'), 16 * 1024 * 1024); }
    catch (error) {
      if (Date.now() >= bootstrapEnd) throw error;
      await delay(20);
    }
  }
  run.meta = (await readOwner(context, run.meta.id)).meta;
  if (run.meta.worker?.pid !== process.pid) fail('workerIdentityInvalid', 'The worker process does not match its recorded identity.');
  await fs.unlink(path.join(directory, 'launch.json'));
  const request = { ...prepared.request,
    run: { id: run.meta.id, name: run.meta.name, deadlineAt: prepared.deadlineMs === undefined ? null : startedAt + prepared.deadlineMs },
    runtime: { directory: path.join(directory, 'adapter'), toolkit: {
      module: path.join(prepared.resourceRoot, 'scripts/runtime/adapter-channel.mjs'), command: process.execPath,
      messageScript: path.join(prepared.resourceRoot, 'scripts/message.mjs'), mcpScript: path.join(prepared.resourceRoot, 'scripts/message-mcp.mjs'),
    } },
  };
  let snapshot = await readJson(path.join(directory, 'snapshot.json'), 16384);
  let child, writer, candidate, readyDiagnostics, fault, faultDiagnostic, exited = false, closed = false, adapterExitCode = null;
  let stopReason, stoppingAt, eventSequence = 0, stderrBytes = 0, writes = Promise.resolve();
  const protocol = createProtocolState();
  const sanitize = (value) => redact(value, prepared.environment, prepared.secretValues);
  const state = async (next, extra = {}) => {
    snapshot = { ...snapshot, ...extra, state: next, sequence: snapshot.sequence + 1 };
    await atomicJson(path.join(directory, 'snapshot.json'), snapshot);
  };
  const event = async (value) => {
    const name = `${String(++eventSequence).padStart(16, '0')}-${randomBytes(8).toString('hex')}.json`;
    await atomicJson(path.join(directory, 'events', name), value);
  };
  const markFault = (code, error) => {
    if (!fault) { fault = code; faultDiagnostic = fileFailureDiagnostic(error, directory); }
    stopReason ??= 'channelError'; stoppingAt ??= Date.now();
  };
  const writeFrame = async (frame) => {
    protocol.acceptWorker(frame);
    await writer.write(frame);
  };
  const pendingNames = new Map();
  const acceptEvent = async (frame) => {
    if (frame.type === 'ready') {
      readyDiagnostics = frame.diagnostics ? sanitizeDiagnostics(frame.diagnostics, prepared.environment, prepared.secretValues) : undefined;
      await state(stopReason ? 'closing' : 'running', { ready: true, initialization: frame.initialization,
        ...(readyDiagnostics ? { diagnostics: summarizeDiagnostics(readyDiagnostics) } : {}),
        initializationSequence: snapshot.sequence + 1 });
    } else if (frame.type === 'message') {
      const text = sanitize(frame.text);
      if (Buffer.byteLength(text) > 4096) fail('messageTooLarge', 'The redacted message exceeds its limit.');
      await event({ type: 'message', text });
    } else if (frame.type === 'delivery') {
      const name = pendingNames.get(frame.id);
      if (!name) fail('protocolInvalid', 'The delivery does not match a pending input.');
      const input = await readRecord(run, 'outbox', name);
      if (frame.status === 'submitted') await fs.unlink(path.join(directory, 'outbox', name));
      else {
        await saveGap(run, name, input, frame.status, frame.code, frame.message ? sanitize(frame.message) : undefined);
        await event({ type: 'delivery', gap: name });
      }
      pendingNames.delete(frame.id);
    } else if (frame.type === 'closing') {
      await state('closing');
      stoppingAt ??= Date.now();
    } else if (frame.type === 'result') {
      candidate = { ...frame, text: sanitize(frame.text), ...(frame.message ? { message: sanitize(frame.message) } : {}) };
      for (const key of ['model', 'sessionId']) if (candidate[key]) candidate[key] = sanitize(candidate[key]);
      stoppingAt ??= Date.now();
    }
  };
  let stopSent = false;
  if (prepared.adapter === 'custom') {
    try {
      prepared.executable = await executablePaths(prepared.executable.command, prepared.executable.entrypoint);
      if (prepared.executable.entrypoint) await fs.access(prepared.executable.entrypoint, constants.R_OK);
      prepared.executable = await resolveSafeCommand(prepared.executable.command, prepared.executable.entrypoint ? [prepared.executable.entrypoint] : [], {
        cwd: request.workspace, env: prepared.environment,
      });
    } catch (error) {
      const safe = safeError(error);
      candidate = { protocolVersion: 5, type: 'result', state: 'failed', generationStarted: false,
        backendExitCode: null, text: '', code: safe.code,
        message: 'The custom command or entrypoint is missing, unreadable, or not executable. Repair the executor and start a new run.',
        initialization: { environment: { status: 'unavailable', code: safe.code }, capabilities: {} } };
    }
  }
  if (!candidate) {
    try {
      child = await safeSpawn(prepared.executable.command, prepared.executable.args ?? (prepared.executable.entrypoint ? [prepared.executable.entrypoint] : []), {
        cwd: request.workspace, env: { ...(prepared.executable.env ?? prepared.environment), AW_SUBAGENT_PROCESS_TOKEN: run.meta.token },
        resourceDirectory: request.runtime.directory,
        detached: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      writer = createFrameWriter(child.stdin, { direction: 'worker' });
      child.stdin.on('error', () => { if (!candidate) markFault('adapterInputClosed'); });
      const decoder = createFrameDecoder({ direction: 'adapter', onFrame: (frame) => {
        protocol.acceptAdapter(frame);
        writes = writes.then(() => acceptEvent(frame));
        writes.catch((error) => markFault('runStateUnavailable', error));
      } });
      child.stdout.on('data', (bytes) => {
        child.stdout.pause();
        try { decoder.push(bytes); } catch { markFault('protocolInvalid'); }
        writes.finally(() => { if (!child.stdout.destroyed) child.stdout.resume(); }).catch(() => {});
      });
      child.stdout.on('end', () => { try { decoder.end(); } catch { markFault('protocolInvalid'); } });
      child.stderr.on('data', (bytes) => {
        stderrBytes += bytes.length;
        if (stderrBytes > LIMITS.logBytes) markFault('diagnosticLimitExceeded');
      });
      child.once('error', () => markFault('adapterStartFailed'));
      child.once('exit', (code) => { exited = true; adapterExitCode = code; stoppingAt ??= Date.now(); });
      child.once('close', () => { closed = true; });
      const identity = await child.identityReady;
      if (identity) run.meta.processes = [identity];
      await atomicJson(path.join(directory, 'owner.json'), run.meta);
      await writeFrame(request);
      let lastObservation = 0;
      while (!closed) {
        await writes.catch(() => {});
        const now = Date.now();
        if (!stopReason && request.run.deadlineAt !== null && now >= request.run.deadlineAt) stopReason = 'deadline';
        if (!stopReason && await fs.lstat(path.join(directory, 'stop.json')).catch(() => null)) stopReason = 'requested';
        if (stopReason && !stopSent) {
          stopSent = true; stoppingAt ??= now;
          run.meta.stopRequested = stopReason;
          await atomicJson(path.join(directory, 'owner.json'), run.meta);
          await state('closing');
          if (!exited && !candidate) writeFrame({ protocolVersion: 5, type: 'stop', reason: stopReason }).catch(() => markFault('adapterInputClosed'));
        }
        if (!stopReason && snapshot.state === 'running' && snapshot.initialization?.capabilities.communication?.status === 'enabled') {
          for (const name of await recordFiles(run, 'outbox')) {
            const input = await readRecord(run, 'outbox', name);
            if (input.phase !== 'queued' || pendingNames.has(input.id)) continue;
            // Persist the uncertain write stage before touching the connection. Never replay it.
            await atomicJson(path.join(directory, 'outbox', name), { ...input, phase: 'writing' });
            pendingNames.set(input.id, name);
            writeFrame({ protocolVersion: 5, type: 'message', id: input.id, text: input.text }).catch(() => markFault('adapterInputClosed'));
          }
        }
        if (now - lastObservation >= 1000) {
          run.meta.processes = await observeTree(child.pid, run.meta.processes, run.meta.token);
          await atomicJson(path.join(directory, 'owner.json'), run.meta);
          lastObservation = now;
        }
        if (stoppingAt !== undefined && now - stoppingAt >= 30000) { markFault('localStopTimeout'); break; }
        // A dead adapter with inherited live pipes must not keep the run open forever.
        if (exited && now - stoppingAt >= 250) break;
        await delay(40);
      }
    } catch (error) { markFault(error?.code && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.code) ? error.code : 'workerFailed', error); }
  }
  await writes.catch(() => {});
  let stopped = false;
  try {
    if (child?.pid) {
      const cleanup = await stopOwnedTree(child.pid, run.meta.processes, run.meta.token);
      run.meta.processes = cleanup.tracked; stopped = cleanup.stopped;
    } else stopped = true;
  } catch { fault ??= 'localTreeStopUnconfirmed'; }
  child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
  await writes.catch(() => {});
  if (!candidate) candidate = { protocolVersion: 5, type: 'result', state: child?.pid ? 'unknown' : 'failed',
    generationStarted: child?.pid ? null : false, backendExitCode: null, text: '',
    code: fault ?? 'adapterResultMissing', message: 'A complete backend result was not received.' };
  if (fault || !stopped || (child && adapterExitCode !== 0) ||
    candidate.state === 'completed' && (stopReason || candidate.generationStarted !== true || candidate.backendExitCode !== 0 || !candidate.text.trim()) ||
    candidate.state === 'cancelled' && (!stopReason || candidate.generationStarted !== false && candidate.remoteStopConfirmed !== true) ||
    stopReason && candidate.generationStarted !== false && candidate.remoteStopConfirmed !== true) {
    candidate = { ...candidate, state: 'unknown', code: fault ?? (!stopped ? 'localTreeStopUnconfirmed' : 'completionUnconfirmed') };
  }
  if (faultDiagnostic) candidate.message = faultDiagnostic;
  if (!candidate.initialization && snapshot.initialization) candidate.initialization = snapshot.initialization;
  if (candidate.diagnostics) candidate.diagnostics = sanitizeDiagnostics(candidate.diagnostics, prepared.environment, prepared.secretValues);
  else if (readyDiagnostics?.length) candidate.diagnostics = readyDiagnostics;
  else if (snapshot.diagnostics?.length) candidate.diagnostics = snapshot.diagnostics;
  try { validateResult(candidate); }
  catch { candidate = { protocolVersion: 5, type: 'result', state: 'unknown', generationStarted: null, backendExitCode: null, text: '', code: 'adapterResultInvalid' }; }
  for (const name of await recordFiles(run, 'outbox')) {
    const input = await readRecord(run, 'outbox', name);
    const status = input.phase === 'queued' ? 'notSubmitted' : 'unknown';
    await saveGap(run, name, input, status, status === 'unknown' ? 'inputDeliveryUnknown' : 'runClosed');
  }
  run.meta.localTreeStopped = stopped;
  run.meta.terminalAt = Date.now();
  try { await removeScratch(run); }
  catch { candidate = { ...candidate, state: 'unknown', code: 'scratchCleanupFailed' }; }
  // Save the fixed clock before publishing the result. Failed writes never extend its TTL.
  await atomicJson(path.join(directory, 'owner.json'), run.meta);
  await atomicJson(path.join(directory, 'final.json'), candidate);
  await state(candidate.state, {
    ...(candidate.initialization ? { initialization: candidate.initialization,
      initializationSequence: snapshot.ready ? snapshot.initializationSequence : snapshot.sequence + 1 } : {}),
    // Keep ready diagnostics as the comparison point for later result reads.
    // Complete terminal diagnostics remain in final.json.
    ...(!snapshot.ready && candidate.diagnostics ? { diagnostics: summarizeDiagnostics(candidate.diagnostics) } : {}),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--directory' || !path.isAbsolute(args[1])) process.exitCode = 2;
  else runWorker(args[1]).catch(() => { process.exitCode = 1; });
}
