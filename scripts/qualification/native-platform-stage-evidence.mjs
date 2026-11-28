import fs from 'node:fs/promises';

const byteLimit = 256 * 1024;
const recordLimit = 256;
const stageNames = new Set(['recovery.plan', 'recovery.lock.wait', 'recovery.locked.demand',
  'recovery.locked.recheck', 'recovery.child.plan', 'recovery.child.execute', 'recovery.status',
  'status.discovery', 'status.adapter.inspect', 'status.inventory', 'status.demand',
  'target.build', 'inspect', 'native.write', 'artifacts.write', 'postcheck.inspect']);

// Project only fixed stage names and times from the fixture's own debug log.
// Keep the old prefix window for shared-provider timing. Failed long batches
// also need their last complete stages, within the same byte/record bound.
export async function readPublicAwStages(file, { retainTail = false } = {}) {
  let records = [];
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const overflow = size > byteLimit;
    const half = byteLimit / 2;
    const windows = retainTail && overflow
      ? [{ start: 0, length: half }, { start: size - half, length: half }]
      : [{ start: 0, length: Math.min(size, byteLimit) }];
    let partial = overflow;
    for (const { start, length } of windows) {
      const input = Buffer.alloc(length);
      const { bytesRead } = await handle.read(input, 0, length, start);
      const text = input.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      // Both edges can split a JSON record when a batch is interrupted.
      if (start) lines.shift();
      lines.pop();
      partial ||= bytesRead !== length || !text.endsWith('\n');
      for (const line of lines) {
        const { time, event } = JSON.parse(line);
        if (typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(time)
          || !['performance:stage', 'rebuild:action'].includes(event?.type)) continue;
        const { name, phase, durationMs } = event.data ?? {};
        if (!stageNames.has(name) || !['start', 'success', 'failure'].includes(phase)) continue;
        records.push({ time, name, phase, ...(Number.isSafeInteger(durationMs) && durationMs >= 0 ? { durationMs } : {}) });
        if (!retainTail && records.length === recordLimit) return { state: 'limited', records };
      }
    }
    const limited = retainTail && (overflow || records.length > recordLimit);
    if (records.length > recordLimit) records = [...records.slice(0, 64), ...records.slice(-(recordLimit - 64))];
    return { state: limited ? 'limited' : partial ? 'partial' : 'captured', records };
  } catch { return { state: 'unavailable', records: records.slice(0, recordLimit) }; }
  finally { await handle?.close().catch(() => {}); }
}
