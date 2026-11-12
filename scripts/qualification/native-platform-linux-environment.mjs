import { createReadStream } from 'node:fs';

const ENVIRONMENT_LIMIT = 65536;
const STAT_LIMIT = 4096;
const SOURCE = 'linux-proc-startup-environment';
const BINDING = 'same-proc-starttime-within-read-not-atomic-with-original-ps';

function errorStatus(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied';
  if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return 'not-found';
  return 'read-error';
}

// The finite stream range also bounds reads before its data callback runs.
// A full stat allowance is conservatively incomplete: no extra byte is read.
function readBoundedFile(file, maximumBytes, overflowByte, signal, io) {
  return new Promise((resolve) => {
    const readLimit = maximumBytes + Number(overflowByte);
    let stream;
    let settled = false;
    let bytes = 0;
    let chunks = [];
    function finish(status) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      const data = status === 'complete' ? Buffer.concat(chunks, bytes) : undefined;
      chunks = [];
      // AbortSignal alone does not stop an injected or already pending read.
      // destroy requests closure without waiting beyond the caller's deadline.
      stream?.destroy();
      resolve({ status, bytes: Math.min(bytes, maximumBytes), data });
    }
    function abort() { finish('aborted'); }
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      stream = io.createReadStream(file, { signal, start: 0, end: readLimit - 1,
        highWaterMark: Math.min(STAT_LIMIT, readLimit) });
      stream.on('data', (chunk) => {
        if (settled) return;
        if (!Buffer.isBuffer(chunk)) { finish('read-error'); return; }
        const retained = Math.min(chunk.length, Math.max(0, maximumBytes - bytes));
        if (retained > 0) chunks.push(chunk.subarray(0, retained));
        bytes = Math.min(readLimit, bytes + chunk.length);
        if (bytes >= readLimit) finish('truncated');
      });
      stream.once('end', () => finish('complete'));
      // Keep the listener after settlement so a late destroy error is handled.
      stream.on('error', (error) => finish(errorStatus(error)));
      stream.once('close', () => finish('read-error'));
      if (settled || signal.aborted) { stream.destroy(); abort(); }
    } catch (error) { finish(errorStatus(error)); }
  });
}

function startTime(data, pid) {
  const text = data.toString('utf8');
  const close = text.lastIndexOf(')');
  if (close < 0 || !text.startsWith(`${pid} (`)) return undefined;
  const fields = text.slice(close + 1).trim().split(/\s+/u);
  // The first field after comm is field 3 (state); starttime is field 22.
  if (!/^[A-Za-z]$/u.test(fields[0] ?? '') || !/^[0-9]+$/u.test(fields[19] ?? '')) return undefined;
  return fields[19];
}

function containsItem(data, expected) {
  let offset = 0;
  while (offset < data.length) {
    const delimiter = data.indexOf(0, offset);
    const end = delimiter === -1 ? data.length : delimiter;
    if (end - offset === expected.length && data.subarray(offset, end).equals(expected)) return true;
    offset = end + 1;
  }
  return false;
}

/**
 * Read one cooperative Linux startup-environment sample. The optional IO seam
 * replaces only createReadStream; paths, byte limits and deadlines stay fixed.
 * proc stat starttime binds these reads to each other, not to an earlier ps
 * sample or to one exec image. No raw environment or identity ticks escape.
 */
export async function readLinuxStartupEnvironment(request, io = { createReadStream }) {
  const startedAt = new Date().toISOString();
  let environmentBytes = 0;
  function result(status, identity = 'unknown', markerMatches = null) {
    return Object.freeze({ source: SOURCE, status, markerMatches, environmentBytes,
      identity, startedAt, finishedAt: new Date().toISOString(), binding: BINDING });
  }
  const { pid, markerEnvironmentVariable: name, marker, deadlineAt, signal } = request ?? {};
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0
    || typeof name !== 'string' || name.length > ENVIRONMENT_LIMIT || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
    || typeof marker !== 'string' || !marker.length || marker.length > ENVIRONMENT_LIMIT || marker.includes('\0')
    || Buffer.from(marker).toString('utf8') !== marker
    || !io || typeof io.createReadStream !== 'function'
    || signal !== undefined && (typeof signal?.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    return result('invalid-input');
  }
  const expected = Buffer.from(`${name}=${marker}`, 'utf8');
  if (expected.length > ENVIRONMENT_LIMIT) return result('invalid-input');
  const controller = new AbortController();
  let stopStatus;
  let timer;
  function stop(status) {
    if (stopStatus) return;
    stopStatus = status;
    controller.abort();
  }
  function abort() { stop('aborted'); }
  function deadline() {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) stop('deadline-exceeded');
    // Large valid absolute times still use the same deadline, never a new budget.
    else timer = setTimeout(deadline, Math.min(remaining, 2147483647));
  }
  function stopped() {
    if (!stopStatus && Date.now() >= deadlineAt) stop('deadline-exceeded');
    return stopStatus;
  }
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  deadline();
  try {
    if (stopped()) return result(stopStatus);
    const statFile = `/proc/${pid}/stat`;
    const before = await readBoundedFile(statFile, STAT_LIMIT, false, controller.signal, io);
    if (stopped()) return result(stopStatus);
    if (before.status !== 'complete') return result(before.status);
    const originalStart = startTime(before.data, pid);
    if (originalStart === undefined) return result('identity-unknown');

    const environment = await readBoundedFile(`/proc/${pid}/environ`, ENVIRONMENT_LIMIT, true, controller.signal, io);
    environmentBytes = environment.bytes;
    if (stopped()) return result(stopStatus);
    const after = await readBoundedFile(statFile, STAT_LIMIT, false, controller.signal, io);
    if (stopped()) return result(stopStatus);
    if (after.status !== 'complete') return result(after.status);
    const finalStart = startTime(after.data, pid);
    if (finalStart === undefined) return result('identity-unknown');
    if (originalStart !== finalStart) return result('identity-changed', 'changed');
    if (environment.status !== 'complete') return result(environment.status, 'same');
    if (environmentBytes === 0) return result('empty', 'same');
    return result('complete', 'same', containsItem(environment.data, expected));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
