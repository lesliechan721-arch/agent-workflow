import { spawn } from 'node:child_process';
import { fail } from './contracts.mjs';
import { currentUserIdentity, launchedProcess, windowsJobMembers, windowsOperation } from './platform.mjs';

const supported = new Set(['darwin', 'linux', 'win32']);
// Use the fixed native observer. Host restrictions are an explicit failure;
// changing a system executable's privilege bits is not a runtime fallback.
export async function withSystemPs(operation) {
  return operation('/bin/ps');
}

function observerEnvironment() {
  return { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...(process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER ? { AW_AGENT_SKILL_EVAL_PROCESS_MARKER: process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER } : {}) };
}

function observePosix(args, maxBuffer) {
  return withSystemPs((executable) => new Promise((resolve, reject) => {
    // execFile does not forward detached. Use spawn so the observer cannot
    // become a live member of the task group that it is trying to inspect.
    const child = spawn(executable, args, { detached: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: observerEnvironment() });
    const chunks = [];
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => { failure = new Error('The process observer timed out.'); child.kill('SIGKILL'); }, 3000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxBuffer) chunks.push(chunk);
      else { failure = new Error('The process observer output is too large.'); child.kill('SIGKILL'); }
    });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? new Error('The process observer failed.'));
      else resolve({ stdout: Buffer.concat(chunks).toString('utf8') });
    });
  }));
}

function posixRows(stdout) {
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4] }] : [];
  });
}

export async function processTable() {
  if (!supported.has(process.platform)) fail('platformUnsupported', 'External runs require macOS, Linux, or native Windows.');
  if (process.platform === 'win32') {
    const rows = await windowsOperation([
      '$rows = @(Get-CimInstance Win32_Process | ForEach-Object {',
      '  if ($null -ne $_.CreationDate) {',
      '    [PSCustomObject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; pgid = $null; started = $_.CreationDate.ToUniversalTime().Ticks.ToString() }',
      '  }',
      '})',
      'ConvertTo-Json -InputObject $rows -Compress',
    ].join('\n'));
    if (!Array.isArray(rows) || rows.some((row) => !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid) || !/^\d+$/.test(row.started)) || !rows.some((row) => row.pid === process.pid)) fail('processObservationFailed', 'The native Windows process observer cannot verify the current process.');
    return rows;
  }
  let stdout;
  try { ({ stdout } = await observePosix(['-axo', 'pid=,ppid=,pgid=,lstart='], 4194304)); }
  catch { fail('processObservationFailed', 'Process ownership could not be observed.'); }
  const table = posixRows(stdout);
  if (!table.some((row) => row.pid === process.pid)) fail('processObservationFailed', 'The process observer cannot see the current process. Use an environment with process-tree observation.');
  return table;
}

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('processIdentityInvalid', 'The process identifier must be a positive safe integer.');
  if (process.platform === 'win32') return windowsOperation([
    '  $item = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$data.pid)',
    '  if ($null -eq $item) { $null | ConvertTo-Json -Compress; return }',
    '  $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid',
    '  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { throw 'The process does not belong to the current user.' }",
    '  [PSCustomObject]@{ pid = [int]$item.ProcessId; ppid = [int]$item.ParentProcessId; pgid = $null; started = $item.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress',
  ].join('\n'), { pid });
  let stdout;
  try { ({ stdout } = await observePosix(['-p', `${process.pid},${pid}`, '-o', 'pid=,ppid=,pgid=,lstart='], 65536)); }
  catch { fail('processObservationFailed', 'The process start identity could not be observed.'); }
  const rows = posixRows(stdout);
  if (!rows.some((row) => row.pid === process.pid)) fail('processObservationFailed', 'The process observer cannot verify the current process.');
  return rows.find((row) => row.pid === pid) ?? null;
}

export async function ownsProcess(identity, token) {
  if (!/^[a-f0-9]{48}$/.test(token ?? '')) return false;
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.started !== 'string') return false;
  if (process.platform === 'win32') {
    const owner = await currentUserIdentity();
    if (identity.ownership !== token || identity.owner?.kind !== 'windows' || identity.owner.sid !== owner.sid) return false;
    const row = await processIdentity(identity.pid);
    return row?.started === identity.started;
  }
  try {
    // The environment is used only for the ownership marker. It is never logged or persisted.
    const { stdout } = await observePosix(['eww', '-p', String(identity.pid), '-o', 'pid=,lstart=,command='], 2097152);
    const match = stdout.trim().match(/^(\d+)\s+(.{24})\s+([\s\S]+)$/);
    return Boolean(match && Number(match[1]) === identity.pid && match[2] === identity.started && match[3].split(/\s+/).includes(`AW_SUBAGENT_PROCESS_TOKEN=${token}`));
  } catch { return false; }
}

export async function captureProcessScope(identity, token) {
  if (process.platform === 'win32') return null;
  const table = await processTable();
  const root = table.find((row) => row.pid === identity.pid && row.started === identity.started);
  const leader = root && table.find((row) => row.pid === root.pgid && row.pgid === root.pgid);
  // A token on a member of the caller's shared group does not make that group
  // private. Production has a detached worker as its verified group leader.
  if (!leader || !await ownsProcess(leader, token)) return null;
  const excluded = [];
  let parent = table.find((row) => row.pid === root.ppid);
  while (parent && parent.pgid === root.pgid && !excluded.some((row) => row.pid === parent.pid)) {
    excluded.push({ pid: parent.pid, started: parent.started });
    parent = table.find((row) => row.pid === parent.ppid);
  }
  return { kind: 'posix-group', pgid: root.pgid, leader: { pid: leader.pid, started: leader.started }, excluded };
}

function rootScope(rootPid, known, token) {
  const root = known.find((row) => row.pid === rootPid && row.ownership === token && row.scope);
  const scope = root?.scope;
  if (scope?.kind === 'posix-group') {
    if (!Number.isSafeInteger(scope.pgid) || scope.pgid <= 0 || scope.leader?.pid !== scope.pgid || typeof scope.leader.started !== 'string' || !Array.isArray(scope.excluded)) fail('processScopeInvalid', 'The private process group information is invalid.');
  } else if (scope?.kind !== 'windows-job') return null;
  return scope;
}

async function taggedProcesses(token) {
  let stdout;
  // Keep selection in BSD syntax. GNU ps cannot recover its BSD -x fallback
  // when a separate BSD eww option precedes a combined SysV -axo argument.
  try { ({ stdout } = await observePosix(['axeww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], 16 * 1024 * 1024)); }
  catch { fail('processObservationFailed', 'The remaining run process markers could not be observed.'); }
  let sawCurrent = false;
  const result = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+([\s\S]+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) sawCurrent = true;
    // Raw command/environment bytes are discarded, never persisted or logged.
    if (match[5].split(/\s+/).includes(`AW_SUBAGENT_PROCESS_TOKEN=${token}`)) result.push({ pid, ppid: Number(match[2]), pgid: Number(match[3]), started: match[4] });
  }
  if (!sawCurrent) fail('processObservationFailed', 'The process marker observer cannot verify the current process.');
  return result;
}

export async function observeTree(rootPid, known, token) {
  const launch = launchedProcess(rootPid);
  if (launch?.token === token) await launch.ready;
  const table = await processTable();
  const result = [...known];
  if (launch?.identity && launch.token === token && !result.some((item) => item.pid === rootPid && item.started === launch.identity.started)) result.push(launch.identity);
  if (process.platform === 'win32' && rootPid === process.pid && /^[a-f0-9]{48}$/.test(token ?? '') && process.env.AW_SUBAGENT_PROCESS_TOKEN === token) {
    const root = table.find((row) => row.pid === rootPid);
    if (!result.some((item) => item.pid === rootPid && item.started === root.started)) result.push({ ...root, ownership: token, owner: await currentUserIdentity() });
  }
  const owned = (identity) => process.platform !== 'win32' || (identity.ownership === token && identity.owner?.sid);
  // Only an unchanged, observed parent can establish a new ancestry edge.
  // Stale PIDs never become roots for a newly reused process tree.
  const candidates = new Map(result.filter((item) => owned(item) && table.some((row) => row.pid === item.pid && row.started === item.started)).map((row) => [row.pid, row]));
  if (process.platform !== 'win32' && !result.some((row) => row.pid === rootPid)) {
    const root = table.find((row) => row.pid === rootPid);
    if (root) candidates.set(root.pid, root);
  }
  let changed;
  do {
    changed = false;
    for (const row of table) if (candidates.has(row.ppid) && !candidates.has(row.pid)) {
      const parent = candidates.get(row.ppid);
      if (process.platform === 'win32' && BigInt(row.started) < BigInt(parent.started)) continue;
      const identity = process.platform === 'win32' ? { ...row, ownership: token, owner: parent.owner } : row;
      candidates.set(row.pid, identity);
      changed = true;
    }
  } while (changed);
  const scope = rootScope(rootPid, result, token);
  if (scope?.kind === 'posix-group') {
    for (const row of table) if (row.pgid === scope.pgid && !scope.excluded.some((ancestor) => ancestor.pid === row.pid && ancestor.started === row.started)) candidates.set(row.pid, { ...row, scope });
  }
  for (const row of candidates.values()) {
    // A missing or unreadable marker removes permission to signal the process.
    // It does not prove that this related process has stopped.
    if (!result.some((item) => item.pid === row.pid && item.started === row.started)) result.push(row);
  }
  return result;
}

async function stopWindowsProcess(identity) {
  // Keep the original process handle open while checking and stopping it.
  // Stop-Process/taskkill by PID alone would leave a PID-reuse race.
  await windowsOperation([
    '$native = $null',
    'try {',
    '  try { $native = [Diagnostics.Process]::GetProcessById([int]$data.pid) } catch [ArgumentException] { $false | ConvertTo-Json -Compress; return }',
    '  $handle = $native.Handle',
    // CIM datetimes have microsecond precision; the native handle has 100 ns.
    '  $nativeTicks = $native.StartTime.ToUniversalTime().Ticks',
    '  if (($nativeTicks - ($nativeTicks % 10)).ToString() -ne $data.started) { $false | ConvertTo-Json -Compress; return }',
    '  $item = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$data.pid)',
    '  if ($null -eq $item) { $false | ConvertTo-Json -Compress; return }',
    '  $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid',
    "  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $data.sid) { throw 'The process owner changed.' }",
    '  if (!$native.HasExited) { $native.Kill() }',
    '  $true | ConvertTo-Json -Compress',
    '} finally { if ($null -ne $native) { $native.Dispose() } }',
  ].join('\n'), { pid: identity.pid, started: identity.started, sid: identity.owner.sid });
}

export async function stopOwnedTree(rootPid, known, token) {
  let tracked = await observeTree(rootPid, known, token);
  const scope = rootScope(rootPid, tracked, token);
  if (scope?.kind === 'windows-job') {
    // Job accounting, rather than sampled ancestry, is the authoritative scope.
    // Terminate + wait-for-empty also covers children whose parents have exited.
    await windowsJobMembers(scope, true);
    const root = tracked.find((row) => row.pid === rootPid && row.scope?.name === scope.name);
    if (root && await ownsProcess(root, token)) await stopWindowsProcess(root);
    const table = await processTable();
    return { stopped: !tracked.some((identity) => table.some((row) => row.pid === identity.pid && row.started === identity.started)), tracked };
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const identity of [...tracked].reverse()) if (await ownsProcess(identity, token)) {
      if (process.platform === 'win32') {
        await stopWindowsProcess(identity);
        continue;
      }
      try { process.kill(identity.pid, signal); } catch (error) { if (error.code !== 'ESRCH') fail('processStopFailed', 'An owned process could not be stopped.'); }
    }
    await new Promise((resolve) => setTimeout(resolve, signal === 'SIGTERM' ? 250 : 100));
    tracked = await observeTree(rootPid, tracked, token);
  }
  const table = await processTable();
  let stopped = Boolean(scope) && !tracked.some((identity) => table.some((row) => row.pid === identity.pid && row.started === identity.started));
  if (scope?.kind === 'posix-group') {
    const isAncestor = (row) => scope.excluded.some((ancestor) => ancestor.pid === row.pid && ancestor.started === row.started);
    if (table.some((row) => row.pgid === scope.pgid && !isAncestor(row))) stopped = false;
    // A daemon can leave a POSIX group. Preserve control information if a run
    // marker survives outside this scope; a shared/foreign group is never killed.
    if ((await taggedProcesses(token)).some((row) => !isAncestor(row) && !tracked.some((item) => item.pid === row.pid && item.started === row.started))) stopped = false;
  }
  return { stopped, tracked };
}
