// Qualification-only diagnostics. These events never change a process decision.
export function createMarkerIdentityConfirmationCapture() {
  const records = [];
  let omitted = 0;
  let closed = false;
  return {
    capture(event) {
      if (closed || event?.phase !== 'post-marker-confirmation'
        || !['absent', 'present', 'unknown'].includes(event.result)
        || ![event.rootPid, event.pid].every(value => Number.isSafeInteger(value) && value > 0)
        || ![event.queryStartedAt, event.queryCompletedAt, event.deadline].every(value => Number.isSafeInteger(value) && value > 0)
        || typeof event.startTime !== 'string' || !/^[\x20-\x7e]{1,128}$/u.test(event.startTime)) return;
      if (records.length === 8) { omitted++; return; }
      records.push({ rootPid: event.rootPid, pid: event.pid, startTime: event.startTime,
        phase: event.phase, queryStartedAt: event.queryStartedAt, queryCompletedAt: event.queryCompletedAt,
        deadline: event.deadline, result: event.result });
    },
    snapshot() {
      return records.length || omitted ? { source: 'observer-local-post-marker-identity-query',
        records: records.map(record => ({ ...record })), omitted } : undefined;
    },
    stop() { closed = true; },
  };
}
