import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicJson, readJson } from './files.mjs';
import { fail, safeError } from './contracts.mjs';
import { safeSpawn } from './platform.mjs';
import { processTable, stopOwnedTree } from './processes.mjs';
import { createRun, openRun, openRuns, observeRun, recordFiles, readRecord, saveGap, saveObservation,
  workerAlive, expired, removeExpired, removeScratch, terminal, delay } from './store.mjs';
import { OUTPUT_LIMIT, communication, initializationDiagnostics, needsInitialization, diagnostic, eventText,
  finalChunks, resultReport, measureReport, collectReport, exportHint, uncoveredGaps, textBlock } from './output.mjs';

const scanDiagnostic = (context) => context.scanFailed ? diagnostic('expirationScanIncomplete', 'Some expired resources could not be checked. They were retained.') : '';
const readDiagnostic = diagnostic('runReadFailed', 'Some unread events or notifications could not be delivered. Retry wait or result.');
const operationError = (operation, handle, error, run) => {
  const safe = safeError(error);
  const terminalState = run?.result?.state;
  return { text: operation === 'start' ? `start_failed ${handle}${terminalState ? ` state=${terminalState}` : ''} code=${safe.code}\n` : '',
    diagnostic: diagnostic(safe.code, `${safe.message}${operation === 'start' ? ' Continue with this handle through wait, result, or stop.' : ''}`, handle), exitCode: 1 };
};
const operationDiagnostic = (response, context) => ({ ...response, diagnostic: response.diagnostic + scanDiagnostic(context) });

export async function startRun(context, prepared, request) {
  // The host must permit ownership observation before any model can be submitted.
  await processTable();
  const run = await createRun(context, request.name, prepared.request.workspace);
  let child;
  try {
    child = await safeSpawn(process.execPath, [path.join(prepared.selected.resourceRoot, 'scripts/worker.mjs'), '--directory', run.directory], {
      cwd: prepared.request.workspace, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...prepared.environment, AW_SUBAGENT_PROCESS_TOKEN: run.meta.token },
    });
    let launchError;
    child.once('error', (error) => { launchError = error; });
    const identity = await child.identityReady;
    if (!identity || launchError) fail('workerStartFailed', 'The host did not establish the background worker.');
    run.meta.worker = identity;
    await atomicJson(path.join(run.directory, 'owner.json'), run.meta);
    await atomicJson(path.join(run.directory, 'launch.json'), {
      request: prepared.request, executable: prepared.executable, environment: prepared.environment,
      secretValues: prepared.secretValues, resourceRoot: prepared.selected.resourceRoot,
      adapter: prepared.selected.executor.adapter,
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
    child.unref();
  } catch (error) {
    child?.unref();
    // No launch descriptor means the worker cannot submit a model. Retain uncertain ownership.
    return operationDiagnostic(operationError('start', run.handle, error, run), context);
  }
  const until = Date.now() + 10000;
  let current;
  do {
    // This call created the private run and still owns the original child
    // handle. Its exit state proves this worker's lifetime without reopening
    // the run or sampling every system process on each initialization check.
    context.table = child.exitCode === null && child.signalCode === null ? [run.meta.worker] : [];
    try { current = await observeRun(context, run); }
    catch (error) { return operationDiagnostic(operationError('start', run.handle, error, run), context); }
    if (current.snapshot.ready || current.result) break;
    const remaining = until - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(80, remaining));
  } while (Date.now() < until);
  const ready = current.snapshot.ready;
  try { await saveObservation(current, { terminalConsumed: false,
    initializationSequence: ready ? current.snapshot.initializationSequence : current.observed.initializationSequence }); }
  catch (error) { return operationDiagnostic(operationError('start', run.handle, error, current), context); }
  if (ready) return { text: `started ${run.handle} communication=${communication(current.snapshot)}\n${initializationDiagnostics(current.snapshot.diagnostics, run.handle, current.snapshot.initialization, { control: true })}`, diagnostic: scanDiagnostic(context), exitCode: 0 };
  if (current.result) {
    const code = current.result.code ?? 'startupFailed';
    return { text: `start_failed ${run.handle} state=${current.result.state} code=${code}\n`,
      diagnostic: diagnostic(code, `${current.result.message ?? 'The executor stopped before it became ready.'} Continue with this handle through wait, result, or stop.`, run.handle) + scanDiagnostic(context), exitCode: 1 };
  }
  return { text: `starting ${run.handle}\n`, diagnostic: diagnostic('startupNotReady', 'Initialization is still pending. Continue with this handle through wait, result, or stop.', run.handle) + scanDiagnostic(context), exitCode: 1 };

}

export async function sendInput(context, request) {
  let run;
  try {
    run = await observeRun(context, await openRun(context, request.runs[0]));
    if (run.snapshot.state === 'starting') fail('runNotReady', 'The run has not initialized.');
    if (run.snapshot.state !== 'running') fail('runClosed', 'The run no longer accepts input.');
    if (run.snapshot.initialization?.capabilities.communication?.status !== 'enabled') fail('communicationUnsupported', 'This run does not support communication.');
    const id = randomBytes(16).toString('hex');
    const name = `${String(Date.now()).padStart(16, '0')}-${process.hrtime.bigint()}-${id}.json`;
    await atomicJson(path.join(run.directory, 'outbox', name), { id, text: request.text, phase: 'queued' });
    let delivery = 'unknown';
    try {
      const after = await readJson(path.join(run.directory, 'snapshot.json'), 16384);
      delivery = after.state === 'running' ? 'queued' : 'unknown';
    } catch { /* The input is queued; a closing or unreadable snapshot cannot undo it. */ }
    return { text: `queued ${run.handle}${delivery === 'unknown' ? ' delivery=unknown' : ''}\n`, exitCode: 0, diagnostic: scanDiagnostic(context) };
  } catch (error) { return operationDiagnostic(operationError('send', request.runs[0], error, run), context); }
}

async function settleLateInputs(run) {
  // send and closing can cross. A single parent completes send before reading the fixed result.
  // Inputs still on disk are evidence of a gap, never an instruction to submit again.
  for (const name of await recordFiles(run, 'outbox')) {
    const input = await readRecord(run, 'outbox', name);
    const status = input.phase === 'queued' ? 'notSubmitted' : 'unknown';
    await saveGap(run, name, input, status, status === 'unknown' ? 'inputDeliveryUnknown' : 'runClosed');
  }
}

async function consumeResult(run, events) {
  try {
    for (const name of events) await fs.unlink(path.join(run.directory, 'events', name));
    await saveObservation(run, { terminalConsumed: true });
  } catch { fail('resultConsumeFailed', 'The complete report was written, but unread records could not all be consumed. Reading again can repeat messages.'); }
}

async function exportResult(run, events, factory, target, context) {
  const destination = path.resolve(target);
  let handle;
  try { handle = await fs.open(destination, 'wx', 0o600); }
  catch (error) {
    const exists = error.code === 'EEXIST';
    return { text: '', diagnostic: diagnostic(exists ? 'resultOutputExists' : 'resultOutputFailed', exists ? 'The output path already exists. Choose a new path; existing content was retained.' : 'The output file could not be created. Check its parent directory and access permissions.', run.handle) + scanDiagnostic(context), exitCode: 1 };
  }
  let bytes = 0, uncertainBytes = false, writeFailed = false;
  try {
    for await (const chunk of factory()) {
      const buffer = Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length) {
        let written;
        try { written = await handle.write(buffer, offset, buffer.length - offset, null); }
        catch (error) { uncertainBytes = true; throw error; }
        if (!written.bytesWritten) { uncertainBytes = true; throw new Error('The output file stopped accepting bytes.'); }
        offset += written.bytesWritten; bytes += written.bytesWritten;
      }
    }
  } catch { writeFailed = true; }
  try { await handle.close(); } catch { writeFailed = true; }
  if (writeFailed) return { text: '', diagnostic: textBlock('diagnostic', `path=${JSON.stringify(destination)} complete=false bytes=${uncertainBytes ? 'unknown' : bytes}. The file may be incomplete. Unread messages were retained.`, { run: run.handle, code: 'resultOutputFailed' }), exitCode: 1 };
  let consumed = true, errorDiagnostic = '';
  try { await consumeResult(run, events); }
  catch (error) { consumed = false; errorDiagnostic = diagnostic('resultConsumeFailed', safeError(error).message, run.handle); }
  return { text: `exported ${run.handle} path=${JSON.stringify(destination)} bytes=${bytes} consumed=${consumed}\n`, diagnostic: errorDiagnostic + scanDiagnostic(context), exitCode: consumed ? 0 : 1 };
}

export async function readResult(context, request) {
  let run;
  try {
    run = await observeRun(context, await openRun(context, request.runs[0]));
    if (!run.result) fail('resultNotReady', 'The run has not reached a terminal state.');
    await settleLateInputs(run);
    const events = await recordFiles(run, 'events');
    const gaps = await recordFiles(run, 'gaps');
    const factory = resultReport(run, events, gaps);
    const measured = await measureReport(factory);
    if (request.outputFile !== undefined) return await exportResult(run, events, factory, request.outputFile, context);
    const stderr = scanDiagnostic(context);
    const diagnosticBudget = Math.max(Buffer.byteLength(stderr), Buffer.byteLength(diagnostic('resultConsumeFailed', 'The report was written, but some unread records could not be consumed. Reading again can repeat messages.', run.handle)));
    if (measured.bytes + diagnosticBudget > OUTPUT_LIMIT) return { text: '', diagnostic: diagnostic('resultTooLarge', exportHint(run.handle), run.handle) + stderr, exitCode: 1 };
    return { text: await collectReport(factory), diagnostic: stderr, exitCode: 0, afterOutput: () => consumeResult(run, events) };
  } catch (error) { return operationDiagnostic(operationError('result', request.runs[0], error, run), context); }
}

function waitReport(groups, more) {
  return async function* () {
    if (more) yield 'more=true\n';
    for (const group of groups) for (const item of group.items) yield item.rendered;
  };
}

function deferredText(group, maximumBytes) {
  const line = `deferred ${group.handle} state=${group.run.result.state}${group.capability ? ` communication=${communication(group.run.snapshot)}` : ''}\n`;
  const hint = diagnostic('resultTooLarge', exportHint(group.handle), group.handle);
  return line + (group.capability ? initializationDiagnostics(group.run.snapshot.diagnostics, group.handle, group.run.snapshot.initialization, {
    maximumBytes: Math.max(0, maximumBytes - Buffer.byteLength(line + hint)),
  }) : '') + hint;
}

async function prepareWaitItem(group, candidate, maximumBytes) {
  if (candidate.kind === 'message') return { ...candidate, rendered: await eventText(group.run, candidate.name),
    gap: (await readRecord(group.run, 'events', candidate.name)).gap };
  if (candidate.kind === 'ready') {
    const line = `ready ${group.handle} communication=${communication(group.run.snapshot)}\n`;
    return { ...candidate, rendered: line + initializationDiagnostics(group.run.snapshot.diagnostics, group.handle, group.run.snapshot.initialization, {
      maximumBytes: Math.max(0, maximumBytes - Buffer.byteLength(line)),
    }) };
  }
  const gaps = await uncoveredGaps(group.run, group.events, group.gaps);
  const bodyBytes = (await measureReport(() => finalChunks(group.run, gaps, group.capability, { diagnostics: false }))).bytes;
  if (bodyBytes <= maximumBytes) {
    const factory = () => finalChunks(group.run, gaps, group.capability, { diagnosticBytes: maximumBytes - bodyBytes });
    if ((await measureReport(factory)).bytes <= maximumBytes) return { ...candidate, rendered: await collectReport(factory, undefined, maximumBytes) };
  }
  return { kind: 'deferred', rendered: deferredText(group, maximumBytes) };
}

function waitFailureReserve(groups) {
  const items = groups.flatMap((group) => group.items);
  const failureBytes = Buffer.byteLength(readDiagnostic + 'more=true\n');
  if (items.some((item) => ['message', 'ready'].includes(item.kind))) return failureBytes;
  // A failed observation save removes its complete control notification. Reserve
  // only any diagnostic bytes that this removal does not already make available.
  return items.length ? Math.max(0, failureBytes - Math.min(...items.map((item) => Buffer.byteLength(item.rendered)))) : 0;
}

function waitDiagnostics(groups, context) {
  const consumption = groups.some((group) => group.consumeError);
  const errors = groups.filter((group) => group.error);
  if (!errors.length) return consumption ? readDiagnostic : scanDiagnostic(context);
  let text = consumption ? readDiagnostic : '';
  for (const group of errors) {
    const next = diagnostic(group.consumeError ?? group.error, 'This run could not be read or its notification could not be consumed. Retry wait or result.', group.handle);
    if (Buffer.byteLength(text + next) > 800) {
      text += diagnostic('diagnosticOmitted', 'Additional runs could not be read. Retry each requested handle.'); break;
    }
    text += next;
  }
  return text;
}

export async function waitRuns(context, request) {
  const until = Date.now() + request.timeoutMs;
  let groups;
  for (;;) {
    context.table = undefined;
    groups = [];
    const opened = await openRuns(context, request.runs);
    for (const handle of request.runs) {
      try {
        const entry = opened.get(handle);
        if (entry.error) throw entry.error;
        const run = await observeRun(context, entry.run);
        if (run.result) await settleLateInputs(run);
        const events = await recordFiles(run, 'events');
        const group = { run, handle, items: [], events, gaps: [], candidates: events.map((name) => ({ kind: 'message', name })), capability: needsInitialization(run) };
        if (run.result && !run.observed.terminalConsumed) {
          group.gaps = await recordFiles(run, 'gaps');
          group.candidates.push({ kind: 'final' });
        } else if (!run.result && run.snapshot.ready && group.capability) group.candidates.push({ kind: 'ready' });
        groups.push(group);
      } catch (error) { groups.push({ handle, items: [], error: safeError(error).code, candidates: [] }); }
    }
    if (groups.some((group) => group.error || group.candidates.length)) break;
    if (groups.every((group) => group.run?.result)) return { text: 'settled\n', exitCode: 0, diagnostic: scanDiagnostic(context) };
    if (Date.now() >= until) return { text: 'timeout\n', exitCode: 0, diagnostic: scanDiagnostic(context) };
    await delay(Math.min(100, until - Date.now()));
  }
  let remaining = groups.reduce((count, group) => count + group.candidates.length, 0);
  let more = false, stoppedSelecting = false;
  for (const group of groups) {
    for (const [index, candidate] of group.candidates.entries()) {
      remaining--;
      if (stoppedSelecting) { more = true; continue; }
      try {
        const maximumBytes = OUTPUT_LIMIT - Buffer.byteLength(waitDiagnostics(groups, context)) -
          (remaining > 0 ? Buffer.byteLength('more=true\n') : 0) - (candidate.kind === 'ready' ? Buffer.byteLength(readDiagnostic + 'more=true\n') : 0);
        const item = await prepareWaitItem(group, candidate, maximumBytes);
        group.items.push(item);
        const reserve = Buffer.byteLength(waitDiagnostics(groups, context)) + waitFailureReserve(groups);
        if ((await measureReport(waitReport(groups, remaining > 0))).bytes + reserve > OUTPUT_LIMIT) {
          group.items.pop(); stoppedSelecting = true; more = true;
        }
      } catch (error) {
        // Candidate measurement and freezing can read event and gap files more
        // than once. Retain this run's records and continue with healthy runs.
        group.items = []; group.error = safeError(error).code; more = true;
        remaining -= group.candidates.length - index - 1;
        break;
      }
    }
  }
  // A later run's read error can reduce the earlier selection's remaining
  // budget. Recheck the frozen text before consuming any records.
  const stdoutLimit = OUTPUT_LIMIT - Buffer.byteLength(waitDiagnostics(groups, context));
  for (const group of groups) for (const item of group.items) {
    const controlBudget = stdoutLimit - (more ? Buffer.byteLength('more=true\n') : 0);
    if (item.kind === 'ready') item.rendered = (await prepareWaitItem(group, item, controlBudget - Buffer.byteLength(readDiagnostic + 'more=true\n'))).rendered;
    if (item.kind === 'deferred') item.rendered = deferredText(group, controlBudget);
    if (item.kind === 'final' && Buffer.byteLength(item.rendered) > stdoutLimit) {
      item.kind = 'deferred'; item.rendered = deferredText(group, stdoutLimit);
    }
  }
  while ((await measureReport(waitReport(groups, more))).bytes + Buffer.byteLength(waitDiagnostics(groups, context)) + waitFailureReserve(groups) > OUTPUT_LIMIT) {
    const last = groups.findLast((group) => group.items.length);
    if (!last) break;
    last.items.pop(); more = true;
  }
  for (const group of groups) {
    if (!group.run) continue;
    const retained = [];
    for (const item of group.items) {
      if (item.kind === 'message') {
        try { await fs.unlink(path.join(group.run.directory, 'events', item.name)); }
        catch {
          const final = group.items.find((entry) => entry.kind === 'final');
          if (item.gap && final) final.rendered = item.rendered + final.rendered;
          group.consumeError = 'runReadFailed'; more = true; continue;
        }
      }
      retained.push(item);
    }
    group.items = retained;
    if (group.items.some((item) => item.kind !== 'message')) {
      try { await saveObservation(group.run, {
        terminalConsumed: group.run.observed.terminalConsumed || group.items.some((item) => ['final', 'deferred'].includes(item.kind)),
        initializationSequence: group.capability ? group.run.snapshot.initializationSequence : group.run.observed.initializationSequence,
      }); }
      catch {
        group.items = group.items.filter((item) => item.kind === 'message');
        group.consumeError = 'runReadFailed'; more = true;
      }
    }
  }
  const stderr = waitDiagnostics(groups, context);
  return { text: await collectReport(waitReport(groups, more), undefined, OUTPUT_LIMIT - Buffer.byteLength(stderr)), diagnostic: stderr,
    exitCode: groups.some((group) => group.error || group.consumeError) ? 1 : 0 };
}

export async function stopRun(context, request) {
  let run;
  try {
    run = await openRun(context, request.runs[0]);
    if (!expired(run.meta)) run = await observeRun(context, run);
    if (!run.result && !expired(run.meta)) await atomicJson(path.join(run.directory, 'stop.json'), { reason: 'requested' });
    const until = Date.now() + 30000;
    while (!run.result && !expired(run.meta) && Date.now() < until) {
      await delay(100); context.table = undefined;
      run = await observeRun(context, await openRun(context, run.handle));
    }
    context.table = undefined;
    let stopped = run.meta.localTreeStopped;
    if (!await workerAlive(context, run.meta) || expired(run.meta)) {
      const root = expired(run.meta) ? run.meta.worker : run.meta.processes[0];
      if (root) {
        const cleanup = await stopOwnedTree(root.pid, [root, ...run.meta.processes], run.meta.token);
        stopped = cleanup.stopped; run.meta.processes = cleanup.tracked;
      } else stopped = run.meta.processes.length === 0;
      run.meta.localTreeStopped = stopped;
      await atomicJson(path.join(run.directory, 'owner.json'), run.meta);
    }
    if (stopped) await removeScratch(run);
    const response = { text: `${stopped ? 'stopped' : 'stopping'} ${run.handle} remote_stop_confirmed=${run.result?.remoteStopConfirmed ?? 'unknown'}\n`,
      exitCode: stopped ? 0 : 1, diagnostic: (stopped ? '' : diagnostic('localStopUnconfirmed', 'Local stopping is not confirmed. Retry stop with this handle.', run.handle)) + scanDiagnostic(context) };
    context.table = undefined;
    await removeExpired(context, run).catch(() => {});
    return response;
  } catch (error) { return operationDiagnostic(operationError('stop', request.runs[0], error, run?.snapshot ? run : undefined), context); }
}
