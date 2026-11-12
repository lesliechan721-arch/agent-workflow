import { execFile } from 'node:child_process';

const IDENTITY_COLUMNS = 'pid=,ppid=,pgid=,state=,lstart=';
const START = '(\\w{3}\\s+\\w{3}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})';
const identityAndName = new RegExp(`^(\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+\\S+\\s+${START})(?:[ \\t]+(.*))?$`, 'u');
const normalizeStart = (value) => value.trim().replace(/\s+/gu, ' ');
const nameFailureReasons = new Set(['marked-process-group-changed', 'root-marker-missing',
  'known-process-marker-missing', 'initial-group-marker-missing', 'process-marker-unreadable']);

// Hosted qualification diagnostics only. The extra column changes this query's
// output size and failure surface. Project every row back to the identity schema;
// names never authorize a signal, establish ownership, or clear an original error.
export function createProcessNameDiagnostic(runCommand = execFile) {
  let rootPid;
  let closed = false;
  const recent = new Map();
  function project(stdout) {
    if (typeof stdout !== 'string') throw new Error('qualification-identity-projection-failed');
    const table = new Map();
    const lines = stdout.split('\n').map((line) => {
      if (!line.trim()) return line;
      const match = identityAndName.exec(line);
      if (!match || table.has(Number(match[2]))) throw new Error('qualification-identity-projection-failed');
      const name = (match[6] ?? '').trim();
      table.set(Number(match[2]), { pid: Number(match[2]), ppid: Number(match[3]),
        startTime: normalizeStart(match[5]), ...(name && /^[A-Za-z0-9_.+-]{1,32}$/u.test(name)
          ? { processName: name } : { unavailable: name ? 'name-rejected' : 'name-not-returned' }) });
      return match[1];
    });
    if (!closed && table.has(rootPid)) {
      for (const row of table.values()) {
        let current = row;
        const seen = new Set();
        while (current && current.pid !== rootPid && !seen.has(current.pid)) {
          seen.add(current.pid); current = table.get(current.ppid);
        }
        if (current?.pid !== rootPid) continue;
        const { ppid: _ppid, ...hint } = row;
        const key = `${row.pid}:${row.startTime}`;
        recent.delete(key);
        recent.set(key, { ...hint, source: 'identity-ps-ucomm' });
        if (recent.size > 32) recent.delete(recent.keys().next().value);
      }
    }
    return lines.join('\n');
  }
  return {
    onSpawn({ pid }) { rootPid = pid; },
    execFile(command, args, options, callback) {
      if (command !== 'ps' || args.length !== 3 || args[0] !== '-A'
        || args[1] !== '-o' || args[2] !== IDENTITY_COLUMNS) return runCommand(command, args, options, callback);
      return runCommand(command, ['-A', '-o', `${IDENTITY_COLUMNS},ucomm=`], options, (error, stdout, ...rest) => {
        if (error) return callback(error, '', ...rest);
        let projected;
        try { projected = project(stdout); }
        catch { return callback(new Error('qualification-identity-projection-failed'), '', ...rest); }
        return callback(error, projected, ...rest);
      });
    },
    snapshot(diagnostics = []) {
      const first = diagnostics.find((item) => nameFailureReasons.has(item.reason));
      if (!first) return [];
      return [...recent.values()].filter((row) => first.affectedPids.includes(row.pid) && first.processes.some((item) =>
        item.pid === row.pid && normalizeStart(item.startTime ?? item.knownStartTime ?? '') === row.startTime))
        .slice(0, 8).map((row) => ({ ...row }));
    },
    stop() { closed = true; },
  };
}
