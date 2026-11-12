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

// Retain only row shape from the original successful marker query. This never
// changes that query, its callback arguments, or the observer's decision.
export function createProcessMarkerRowDiagnostic(runCommand = execFile) {
  const markerColumns = `${IDENTITY_COLUMNS},command=`;
  const rowPattern = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+${START}\\s+(.*)$`, 'u');
  const recent = [];
  let rootPid;
  let markerName;
  let marker;
  let closed = false;
  let queryId = 0;
  let cacheEvictions = 0;
  function capture(stdout, query) {
    if (closed || !rootPid || !markerName || !marker || typeof stdout !== 'string' || stdout.length > 2 * 1024 * 1024) return;
    const table = new Map();
    let unparsedLines = 0;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const match = rowPattern.exec(line);
      if (!match || !/^[A-Za-z?]$/u.test(match[4])) { unparsedLines += 1; continue; }
      const [pid, ppid, pgid] = match.slice(1, 4).map(Number);
      if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid <= 0 || table.has(pid)) return;
      table.set(pid, { pid, ppid, pgid, state: match[4], startTime: normalizeStart(match[5]), command: match[6].trim() });
    }
    if (!table.has(rootPid)) return;
    for (const row of table.values()) {
      if (row.state.startsWith('Z')) continue;
      let current = row;
      const seen = new Set();
      while (current && current.pid !== rootPid && !seen.has(current.pid)) {
        seen.add(current.pid); current = table.get(current.ppid);
      }
      if (current?.pid !== rootPid && row.pgid !== rootPid) continue;
      const tokens = row.command.split(/\s+/u);
      if (tokens.includes(`${markerName}=${marker}`)) continue;
      const { command, ...identity } = row;
      recent.push({ ...identity, ...query, unparsedLines, source: 'original-marker-ps-row-shape',
        commandForm: !command ? 'empty' : command === '<defunct>' ? 'defunct'
          : /^\([^)]*\)$/u.test(command) ? 'parenthesized'
            : /^\[[^\]]*\]\s+<defunct>$/u.test(command) ? 'bracketed-defunct'
              : /^\[[^\]]*\]$/u.test(command) ? 'bracketed' : 'other',
        markerMatches: false,
        markerAssignmentPresent: tokens.some((token) => token.startsWith(`${markerName}=`)) });
      if (recent.length > 32) { recent.shift(); cacheEvictions += 1; }
    }
  }
  return {
    onSpawn({ pid }) { rootPid = pid; },
    setMarker(name, value) { markerName = name; marker = value; },
    execFile(command, args, options, callback) {
      if (command !== 'ps' || args.length !== 4 || args[0] !== 'eww' || args[1] !== '-A'
        || args[2] !== '-o' || args[3] !== markerColumns) return runCommand(command, args, options, callback);
      const query = { queryId: ++queryId, queryStartedAt: new Date().toISOString() };
      return runCommand(command, args, options, (error, stdout, ...rest) => {
        if (!error) {
          try { capture(stdout, { ...query, queryCallbackAt: new Date().toISOString() }); }
          catch { /* Diagnostic parsing cannot change the original callback. */ }
        }
        return callback(error, stdout, ...rest);
      });
    },
    snapshot(diagnostics = []) {
      const first = diagnostics.find((item) => item.rootPid === rootPid && nameFailureReasons.has(item.reason));
      const capturedAt = Date.parse(first?.capturedAt);
      if (!first || !Number.isFinite(capturedAt)) return [];
      const matches = [];
      for (const row of recent) {
        if (Date.parse(row.queryCallbackAt) > capturedAt || !first.affectedPids.includes(row.pid)
          || !first.processes.some((item) => item.pid === row.pid
            && normalizeStart(item.startTime ?? item.knownStartTime ?? '') === row.startTime)) continue;
        matches.push(row);
      }
      return matches.slice(0, 8).map((row) => ({ ...row, cacheEvictions,
        queryCandidateCount: matches.filter((item) => item.pid === row.pid).length,
        omittedMatches: Math.max(0, matches.length - 8),
        association: 'ambiguous-query-pid-start-and-callback-time-only' }));
    },
    stop() { closed = true; },
  };
}
