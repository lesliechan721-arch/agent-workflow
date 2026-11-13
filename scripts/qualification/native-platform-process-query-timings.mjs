import { execFile } from 'node:child_process';

const identityColumns = 'pid=,ppid=,pgid=,state=,lstart=';
const outputLengthLimit = 16 * 1024 * 1024;
const firstLimit = 8;
const lastLimit = 16;

function queryKind(command, args) {
  if (!Array.isArray(args)) return undefined;
  if (command === 'ps' && args.length === 3 && args[0] === '-A' && args[1] === '-o'
    && [identityColumns, `${identityColumns},ucomm=`].includes(args[2])) return 'identity-ps';
  if (command === 'ps' && args.length === 4 && args[0] === 'eww' && args[1] === '-A'
    && args[2] === '-o' && args[3] === `${identityColumns},command=`) return 'marker-ps';
  if (command === '/usr/bin/osascript' && args.length === 5 && args[0] === '-l' && args[1] === 'JavaScript'
    && args[2] === '-e' && typeof args[3] === 'string' && typeof args[4] === 'string') return 'darwin-marker-osascript';
  return undefined;
}

function outputLength(value) {
  const unit = typeof value === 'string' ? 'string-code-units' : Buffer.isBuffer(value) ? 'buffer-bytes' : undefined;
  return unit ? { value: Math.min(value.length, outputLengthLimit), unit, capped: value.length > outputLengthLimit } : undefined;
}

function errorCategory(error) {
  const code = error?.code;
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-limit';
  if (code === 'ENOENT') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied';
  if (code === 'ABORT_ERR') return 'aborted';
  return typeof code === 'number' && Number.isInteger(code) ? 'nonzero-exit' : 'other';
}

// Diagnostic-only wrapper around existing observer queries. No command text,
// script, environment, marker, or process-table content enters these records.
export function createProcessQueryTimingDiagnostic(runCommand = execFile, now = Date.now) {
  const first = [];
  const last = [];
  let sequence = 0;
  let closed = false;
  return {
    execFile(command, args, options, callback) {
      let record;
      try {
        const kind = closed ? undefined : queryKind(command, args);
        if (kind) {
          record = { sequence: ++sequence, queryKind: kind, startedAt: now(), status: 'pending',
            ...(Number.isFinite(options?.timeout) ? { timeoutMs: options.timeout } : {}) };
          if (first.length < firstLimit) first.push(record);
          else { last.push(record); if (last.length > lastLimit) last.shift(); }
        }
      } catch { /* Diagnostic capture cannot block the original query. */ }
      if (!record) return Reflect.apply(runCommand, this, [command, args, options, callback]);
      let callbackInvoked = false;
      const measuredCallback = function (...values) {
        callbackInvoked = true;
        if (!closed) {
          try {
            const [error, stdout, stderr] = values;
            record.callbackAt = now();
            record.status = error ? 'callback-error' : 'callback-success';
            if (error) record.errorCategory = errorCategory(error);
            const stdoutLength = outputLength(stdout);
            const stderrLength = outputLength(stderr);
            if (stdoutLength) record.stdoutLength = stdoutLength;
            if (stderrLength) record.stderrLength = stderrLength;
          } catch { /* Always deliver the original callback and its arguments. */ }
        }
        return Reflect.apply(callback, this, values);
      };
      try { return Reflect.apply(runCommand, this, [command, args, options, measuredCallback]); }
      catch (error) {
        if (!closed && !callbackInvoked) {
          try { record.status = 'synchronous-error'; record.errorCategory = errorCategory(error); }
          catch { /* The original synchronous error remains authoritative. */ }
        }
        throw error;
      }
    },
    snapshot() {
      if (!sequence) return undefined;
      return { source: 'existing-observer-execFile-callbacks', clock: 'unix-epoch-ms', capturedAt: now(),
        firstLimit, lastLimit, outputLengthLimit, omitted: Math.max(0, sequence - first.length - last.length),
        records: [...first, ...last].map(record => ({ ...record,
          ...(record.stdoutLength ? { stdoutLength: { ...record.stdoutLength } } : {}),
          ...(record.stderrLength ? { stderrLength: { ...record.stderrLength } } : {}) })) };
    },
    stop() { closed = true; },
  };
}
