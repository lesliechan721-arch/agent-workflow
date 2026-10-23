import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicJson, readJson } from './files.mjs';
import { fail, safeError } from './contracts.mjs';
import { safeSpawn } from './platform.mjs';
import { processTable, stopOwnedTree } from './processes.mjs';
import { createRun, openRun, observeRun, recordFiles, readRecord, saveGap, saveObservation,
  workerAlive, expired, removeExpired, removeScratch, terminal, delay } from './store.mjs';
import { OUTPUT_LIMIT, communication, needsCommunication, groupHeader, diagnostic, eventText,
  finalChunks, resultReport, measureReport, collectReport, exportHint } from './output.mjs';

const scanDiagnostic = (context) => context.scanFailed ? diagnostic('expirationScanIncomplete', 'Some expired resources could not be checked. They were retained.') : '';
const readDiagnostic = 'diagnostic: error\ncode: runReadFailed\n';
const operationError = (operation, handle, error, run) => {
  const safe = safeError(error);
  return { text: `${operation}: error\n${run ? groupHeader(run) : `run: ${handle}\n`}code: ${safe.code}\nmessage: ${safe.message}\n`, exitCode: 1 };
};

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
      ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
    });
    child.unref();
  } catch (error) {
    child?.unref();
    // No launch descriptor means the worker cannot submit a model. Retain uncertain ownership.
    return operationError('start', run.handle, error, run);
  }
  const until = Date.now() + 10000;
  let current;
  do {
    context.table = undefined;
    try { current = await observeRun(context, await openRun(context, run.handle)); }
    catch (error) { return operationError('start', run.handle, error, run); }
    if (current.snapshot.communicationSupported !== null || current.result) break;
    await delay(80);
  } while (Date.now() < until);
  await saveObservation(current, { terminalConsumed: false });
  const ready = current.snapshot.communicationSupported !== null;
  return { text: `start: ${ready ? 'ready' : current.result ? 'error' : 'notReady'}\n${groupHeader(current, true)}${ready ? '' : `code: ${current.result?.code ?? 'startupNotReady'}\n`}`,
    diagnostic: scanDiagnostic(context), exitCode: ready ? 0 : 1 };
}

export async function sendInput(context, request) {
  let run;
  try {
    run = await observeRun(context, await openRun(context, request.runs[0]));
    if (run.snapshot.state === 'starting') fail('runNotReady', 'The run has not initialized.');
    if (run.snapshot.state !== 'running') fail('runClosed', 'The run no longer accepts input.');
    if (run.snapshot.communicationSupported !== true) fail('communicationUnsupported', 'This run does not support communication.');
    const id = randomBytes(16).toString('hex');
    const name = `${String(Date.now()).padStart(16, '0')}-${process.hrtime.bigint()}-${id}.json`;
    await atomicJson(path.join(run.directory, 'outbox', name), { id, text: request.text, phase: 'queued' });
    const after = await readJson(path.join(run.directory, 'snapshot.json'), 16384);
    const delivery = after.state === 'running' ? 'queued' : 'unknown';
    run.snapshot = after;
    return { text: `send: ${delivery}\n${groupHeader(run)}delivery: ${delivery}\n`, exitCode: 0, diagnostic: scanDiagnostic(context) };
  } catch (error) { return { ...operationError('send', request.runs[0], error, run), diagnostic: scanDiagnostic(context) }; }
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
    const stderr = scanDiagnostic(context);
    if (!request.export && measured.bytes + Buffer.byteLength(stderr) > OUTPUT_LIMIT) {
      return { text: `result: error\n${groupHeader(run)}code: resultTooLarge\nresult_bytes: ${measured.bytes}\noutput_limit_bytes: ${OUTPUT_LIMIT}\nmessage: ${exportHint(run.handle)}\n`, diagnostic: stderr, exitCode: 1 };
    }
    return { ...(request.export ? { report: factory, token: measured.token } : { text: await collectReport(factory, measured.token) }),
      diagnostic: stderr, exitCode: 0, afterOutput: async () => {
        try {
          for (const name of events) await fs.unlink(path.join(run.directory, 'events', name));
          await saveObservation(run, { terminalConsumed: true });
        } catch { fail('resultConsumeFailed', 'The output was written, but some unread records could not be consumed.'); }
      } };
  } catch (error) { return { ...operationError('result', request.runs[0], error, run), diagnostic: scanDiagnostic(context) }; }
}

function waitReport(groups, more, changed) {
  return async function* (token) {
    yield `wait: ${changed ? 'changed' : 'error'}\n${more ? 'more: true\n' : ''}`;
    let first = true;
    for (const group of groups) {
      if (!group.items.length && !group.error) continue;
      if (!first) yield '\n'; first = false;
      if (!group.run) { yield `run: ${group.handle}\ncode: ${group.error}\n`; continue; }
      const capability = group.capability ?? (group.items.some((item) => item.kind === 'state' || item.kind === 'final' || item.kind === 'deferred') && needsCommunication(group.run));
      yield groupHeader(group.run, capability);
      if (group.error) yield `code: ${group.error}\n`;
      for (const item of group.items) {
        if (item.kind === 'message') yield item.rendered ?? await eventText(group.run, item.name, token);
        if (item.kind === 'final') yield* finalChunks(group.run, group.gaps, token);
        if (item.kind === 'deferred') {
          yield `result: deferred\nresult_bytes: ${group.resultBytes}\ndeferred_reason: outputLimit\n`;
          if (group.gaps.length) yield `delivery_gaps: ${group.gaps.length}\n`;
          yield `message: ${group.resultBytes > OUTPUT_LIMIT ? exportHint(group.handle) : `Use result --run ${group.handle}.`}\n`;
        }
      }
    }
  };
}

export async function waitRuns(context, request) {
  const until = Date.now() + request.timeoutMs;
  let groups;
  for (;;) {
    context.table = undefined;
    groups = [];
    for (const handle of request.runs) {
      try {
        const run = await observeRun(context, await openRun(context, handle));
        if (run.result) await settleLateInputs(run);
        const events = await recordFiles(run, 'events');
        const items = [];
        const group = { run, handle, items, events, gaps: [], candidates: [] };
        if (run.result && !run.observed.terminalConsumed) {
          group.gaps = await recordFiles(run, 'gaps');
          group.resultBytes = (await measureReport(resultReport(run, [], group.gaps))).bytes;
          group.candidates.push({ kind: 'final' });
        } else if (!run.result && (run.snapshot.sequence > run.observed.sequence || needsCommunication(run))) group.candidates.push({ kind: 'state' });
        group.candidates.push(...events.map((name) => ({ kind: 'message', name })));
        groups.push(group);
      } catch (error) { groups.push({ handle, items: [], error: safeError(error).code, candidates: [] }); }
    }
    if (groups.some((group) => group.error || group.candidates.length)) break;
    if (groups.every((group) => group.run?.result)) return { text: 'wait: settled\n', exitCode: 0, diagnostic: scanDiagnostic(context) };
    if (Date.now() >= until) return { text: 'wait: timeout\n', exitCode: 0, diagnostic: scanDiagnostic(context) };
    await delay(Math.min(100, until - Date.now()));
  }
  let readFailed = groups.some((group) => group.error);
  const knownDiagnostic = readFailed ? readDiagnostic : scanDiagnostic(context);
  const stdoutLimit = OUTPUT_LIMIT - Buffer.byteLength(knownDiagnostic);
  let remaining = groups.reduce((count, group) => count + group.candidates.length, 0);
  let more = false, stoppedSelecting = false;
  for (const group of groups) {
    for (const candidate of group.candidates) {
      remaining -= 1;
      if (stoppedSelecting) { more = true; continue; }
      let item = candidate;
      if (item.kind === 'final') {
        const single = { ...group, items: [item] };
        if ((await measureReport(waitReport([single], false, true))).bytes > stdoutLimit) item = { kind: 'deferred' };
      }
      group.items.push(item);
      try {
        // Ordinary consumption can fail without removing a state header. Reserve only
        // the short command diagnostic. A failed final removes its complete body,
        // which already frees more than this diagnostic, so an otherwise fitting
        // final must not be deferred or left unread because of a fictitious reserve.
        const ordinary = groups.some((entry) => entry.items.some((value) => ['state', 'message'].includes(value.kind)));
        const diagnosticBytes = Math.max(Buffer.byteLength(knownDiagnostic), ordinary ? Buffer.byteLength(readDiagnostic + 'more: true\n') : 0);
        const measured = await measureReport(waitReport(groups, remaining > 0, true));
        if (measured.bytes + diagnosticBytes > OUTPUT_LIMIT) { group.items.pop(); stoppedSelecting = true; more = true; }
      } catch (error) {
        group.items.pop(); group.consumeError = safeError(error).code; readFailed = true; more = true;
        stoppedSelecting = true;
      }
    }
  }
  // Complete serialization and retain only this bounded batch before removing its files.
  const selected = await measureReport(waitReport(groups, more, true));
  for (const group of groups) {
    if (!group.run) continue;
    group.capability = group.items.some((item) => item.kind !== 'message') && needsCommunication(group.run);
    for (const item of group.items) if (item.kind === 'message') item.rendered = await eventText(group.run, item.name, selected.token);
  }
  // Consume only fully selected events. A failed deletion is not presented as delivered.
  for (const group of groups) {
    if (!group.run) continue;
    const retained = [];
    for (const item of group.items) {
      if (item.kind === 'message') {
        try { await fs.unlink(path.join(group.run.directory, 'events', item.name)); }
        catch { group.consumeError = 'runReadFailed'; readFailed = true; more = true; continue; }
      }
      retained.push(item);
    }
    group.items = retained;
    if (group.items.some((item) => item.kind !== 'message')) {
      try { await saveObservation(group.run, { terminalConsumed: group.run.observed.terminalConsumed || group.items.some((item) => ['final', 'deferred'].includes(item.kind)) }); }
      catch {
        group.items = group.items.filter((item) => item.kind === 'message');
        group.capability = false;
        group.consumeError = 'runReadFailed'; readFailed = true; more = true;
      }
    }
  }
  const changed = groups.some((group) => group.items.length);
  const stderr = readFailed ? readDiagnostic : scanDiagnostic(context);
  // An affected event remains unread. Include target diagnostics when they fit;
  // the reserved command diagnostic always reports partial failure this time.
  for (const group of groups) if (group.consumeError) {
    group.error = group.consumeError;
    if ((await measureReport(waitReport(groups, more, changed))).bytes + Buffer.byteLength(stderr) > OUTPUT_LIMIT) delete group.error;
  }
  const factory = waitReport(groups, more, changed);
  return { text: await collectReport(factory, selected.token, OUTPUT_LIMIT - Buffer.byteLength(stderr)), diagnostic: stderr, exitCode: readFailed ? 1 : 0 };
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
    const state = run.result?.state ?? run.snapshot?.state ?? 'unknown';
    if (stopped) await removeScratch(run);
    const response = { text: `stop: ${stopped ? 'stopped' : 'stopping'}\n${groupHeader({ ...run, snapshot: { state } })}local_stopped: ${stopped}\n${stopped ? '' : 'code: localStopUnconfirmed\n'}`,
      exitCode: stopped ? 0 : 1, diagnostic: scanDiagnostic(context) };
    context.table = undefined;
    await removeExpired(context, run).catch(() => {});
    return response;
  } catch (error) { return { ...operationError('stop', request.runs[0], error, run?.snapshot ? run : undefined), diagnostic: scanDiagnostic(context) }; }
}
