import { execFile } from 'node:child_process';

const IDENTITY_COLUMNS = 'pid=,ppid=,pgid=,state=,lstart=';
const START = '(\\w{3}\\s+\\w{3}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})';
const identityRow = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+\\S+\\s+${START}\\s*$`, 'u');
const nameRow = new RegExp(`^\\s*(\\d+)\\s+${START}\\s+(.+?)\\s*$`, 'u');
const normalizeStart = (value) => value.trim().replace(/\s+/gu, ' ');

// Private Hosted qualification evidence only. ucomm is a limited kernel process
// name, not argv, a full path, or proof of executable identity. Never use it to
// authorize a signal, accept cleanup, or replace the observer's original error.
export function createProcessNameDiagnostic(runCommand = execFile) {
  let rootPid;
  let queried = false;
  let closed = false;
  let query;
  let rows = [];
  function inspect(stdout) {
    if (!rootPid || queried || closed || typeof stdout !== 'string' || stdout.length > 1024 * 1024) return;
    const table = new Map();
    for (const line of stdout.split('\n')) {
      const match = identityRow.exec(line);
      if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]),
        pgid: Number(match[3]), startTime: normalizeStart(match[4]) });
    }
    if (!table.has(rootPid)) return;
    const targets = [...table.values()].filter((row) => {
      if (row.pid === rootPid || row.pgid === rootPid) return false;
      let current = row;
      const seen = new Set();
      while (current && !seen.has(current.pid)) {
        if (current.ppid === rootPid) return true;
        seen.add(current.pid); current = table.get(current.ppid);
      }
      return false;
    }).slice(0, 8);
    if (!targets.length) return;
    queried = true;
    rows = targets.map(({ pid, startTime }) => ({ pid, startTime, source: 'ps-ucomm', unavailable: 'query-pending' }));
    try { query = runCommand('ps', ['-p', targets.map((row) => row.pid).join(','), '-o', 'pid=,lstart=,ucomm='],
      { timeout: 100, windowsHide: true, maxBuffer: 4096 }, (error, output) => {
        if (closed) return;
        for (const row of rows) row.unavailable = error ? 'query-failed' : 'identity-not-returned';
        if (error || typeof output !== 'string' || output.length > 4096) return;
        for (const line of output.split('\n')) {
          const match = nameRow.exec(line);
          if (!match) continue;
          const row = rows.find((item) => item.pid === Number(match[1]) && item.startTime === normalizeStart(match[2]));
          if (!row) continue;
          if (!/^[A-Za-z0-9_.+-]{1,32}$/u.test(match[3])) { row.unavailable = 'name-rejected'; continue; }
          row.processName = match[3]; delete row.unavailable;
        }
      }); } catch { for (const row of rows) row.unavailable = 'query-failed'; }
  }
  return {
    onSpawn({ pid }) { rootPid = pid; },
    execFile(command, args, options, callback) {
      return runCommand(command, args, options, (error, stdout, ...rest) => {
        try {
          if (!error && command === 'ps' && args.length === 3 && args[0] === '-A'
            && args[1] === '-o' && args[2] === IDENTITY_COLUMNS) inspect(stdout);
        } catch { /* Diagnostic failures do not enter the original observer. */ }
        return callback(error, stdout, ...rest);
      });
    },
    snapshot(diagnostics = []) {
      const first = diagnostics.find((item) => item.reason === 'marked-process-group-changed');
      if (!first) return [];
      return rows.filter((row) => first.affectedPids.includes(row.pid) && first.processes.some((item) =>
        item.pid === row.pid && normalizeStart(item.startTime ?? item.knownStartTime ?? '') === row.startTime))
        .map((row) => ({ ...row }));
    },
    stop() {
      closed = true;
      try { query?.kill('SIGKILL'); } catch { /* The bounded ps query can already have exited. */ }
    },
  };
}
