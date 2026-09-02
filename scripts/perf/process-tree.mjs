import { spawn } from 'node:child_process';

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_CLEANUP_SETTLE_MS = 500;
const DEFAULT_DESCENDANT_SNAPSHOT_TIMEOUT_MS = 500;
const DEFAULT_DESCENDANT_MONITOR_INTERVAL_MS = 250;
const TASKKILL_TIMEOUT_MS = 400;

export class ProcessTreeTimeoutError extends Error {
  constructor(label, timeoutMs, stdout, stderr) {
    super(`${label} exceeded its hard timeout of ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    this.name = 'ProcessTreeTimeoutError';
  }
}

function createTaskkillInvocation(pid, force) {
  return {
    command: 'taskkill',
    args: ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
  };
}

function taskkillProcessTree(invocation, signal) {
  return new Promise((resolve, reject) => {
    let killer;
    try {
      killer = spawn(invocation.command, invocation.args, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (error, succeeded = false) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        reject(error);
      } else {
        resolve(succeeded);
      }
    };
    const abort = () => {
      try {
        killer.kill();
        killer.unref();
      } catch {
        // taskkill already exited.
      }
      finish(signal.reason instanceof Error ? signal.reason : new Error('taskkill aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    killer.once('error', (error) => finish(error));
    killer.once('close', (code) => finish(undefined, code === 0));
  });
}

function killDirectChild(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // The child already exited.
  }
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function identityKey(identity) {
  return `${identity.pid}:${identity.startIdentity}`;
}

function sameIdentity(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.startIdentity === right.startIdentity,
  );
}

export function parsePosixProcessTree(rootPid, processTable) {
  const identitiesByPid = new Map();
  const childrenByParent = new Map();
  for (const line of processTable.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) {
      continue;
    }
    const identity = {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      startIdentity: match[3].trim(),
    };
    identitiesByPid.set(identity.pid, identity);
    const children = childrenByParent.get(identity.parentPid) ?? [];
    children.push(identity.pid);
    childrenByParent.set(identity.parentPid, children);
  }

  const descendants = [];
  const visited = new Set([rootPid]);
  const pending = [{ pid: rootPid, depth: 0 }];
  while (pending.length > 0) {
    const parent = pending.pop();
    for (const pid of childrenByParent.get(parent.pid) ?? []) {
      if (visited.has(pid)) {
        continue;
      }
      const identity = identitiesByPid.get(pid);
      if (!identity) {
        continue;
      }
      visited.add(pid);
      const descendant = { ...identity, depth: parent.depth + 1 };
      descendants.push(descendant);
      pending.push(descendant);
    }
  }

  return {
    rootIdentity: identitiesByPid.get(rootPid) ?? null,
    descendants: descendants.sort(
      (left, right) => right.depth - left.depth || right.pid - left.pid,
    ),
    identitiesByPid,
  };
}

export function parseWindowsProcessTree(rootPid, rawProcessTable) {
  const records = Array.isArray(rawProcessTable) ? rawProcessTable : [rawProcessTable];
  const rows = records
    .filter((record) => record && typeof record === 'object')
    .map((record) => [
      String(record.ProcessId ?? ''),
      String(record.ParentProcessId ?? ''),
      String(record.CreationDate ?? '').trim(),
    ].join(' '))
    .join('\n');
  return parsePosixProcessTree(rootPid, rows);
}

export function snapshotPosixProcessTree(rootPid, signal) {
  return new Promise((resolve, reject) => {
    const ps = spawn('ps', ['-Ao', 'pid=,ppid=,lstart='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        ps.stdout.destroy();
        ps.unref();
        reject(error);
      } else {
        resolve(parsePosixProcessTree(rootPid, output));
      }
    };
    const abort = () => {
      killDirectChild(ps, 'SIGKILL');
      ps.stdout.destroy();
      ps.unref();
      finish(signal.reason instanceof Error ? signal.reason : new Error('ps snapshot aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    ps.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    ps.once('error', finish);
    ps.once('close', (code, closeSignal) => {
      if (code !== 0) {
        finish(new Error(
          `ps snapshot failed with exit code ${code ?? 'null'}${closeSignal ? ` and signal ${closeSignal}` : ''}.`,
        ));
        return;
      }
      finish();
    });
  });
}

export function snapshotWindowsProcessTree(rootPid, signal) {
  return new Promise((resolve, reject) => {
    const command = [
      'Get-CimInstance Win32_Process',
      '| Select-Object ProcessId,ParentProcessId,CreationDate',
      '| ConvertTo-Json -Compress',
    ].join(' ');
    const powershell = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        powershell.stdout.destroy();
        powershell.unref();
        reject(error);
      } else {
        try {
          resolve(parseWindowsProcessTree(rootPid, JSON.parse(output || '[]')));
        } catch (parseError) {
          reject(parseError);
        }
      }
    };
    const abort = () => {
      killDirectChild(powershell, 'SIGKILL');
      powershell.stdout.destroy();
      powershell.unref();
      finish(signal.reason instanceof Error ? signal.reason : new Error('Windows snapshot aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    powershell.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    powershell.once('error', finish);
    powershell.once('close', (code, closeSignal) => {
      if (code !== 0) {
        finish(new Error(
          `Windows snapshot failed with exit code ${code ?? 'null'}${closeSignal ? ` and signal ${closeSignal}` : ''}.`,
        ));
        return;
      }
      finish();
    });
  });
}

async function runBoundedOperation(timeoutMs, operation, activeControllers) {
  const controller = new AbortController();
  activeControllers.add(controller);
  let rejectTimeout;
  let rejectAbort;
  const timeout = new Promise((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort(
    controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new Error('Process-tree operation aborted.'),
  );
  controller.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`Process-tree operation exceeded ${timeoutMs}ms.`);
    controller.abort(error);
    rejectTimeout(error);
  }, timeoutMs);
  const work = Promise.resolve().then(() => operation(controller.signal));
  void work.catch(() => {});
  try {
    return { ok: true, value: await Promise.race([work, timeout, aborted]) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abort);
    controller.abort();
    activeControllers.delete(controller);
  }
}

function collectMatchingDescendants(observedDescendants, snapshot) {
  return [...observedDescendants.values()]
    .filter((identity) => sameIdentity(identity, snapshot.identitiesByPid.get(identity.pid)))
    .sort((left, right) => right.depth - left.depth || right.pid - left.pid);
}

function signalPosixIdentities(options) {
  const matchingDescendants = collectMatchingDescendants(
    options.observedDescendants,
    options.snapshot,
  );
  for (const identity of matchingDescendants) {
    try {
      options.killProcess(identity.pid, options.signal);
    } catch {
      // This revalidated descendant already exited.
    }
  }

  const rootMatches = sameIdentity(
    options.rootIdentity,
    options.snapshot.identitiesByPid.get(options.child.pid),
  );
  if (options.includeRoot && rootMatches) {
    try {
      process.kill(-options.child.pid, options.signal);
    } catch {
      killDirectChild(options.child, options.signal);
    }
  }
  return { matchingDescendants, rootMatches };
}

export function runProcessTree(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const snapshotProcessTree = platform === 'win32'
    ? dependencies.snapshotWindowsProcessTree ?? snapshotWindowsProcessTree
    : dependencies.snapshotPosixProcessTree ?? snapshotPosixProcessTree;
  const verifyPosixProcessTree = dependencies.verifyPosixProcessTree ?? snapshotPosixProcessTree;
  const runTaskkill = dependencies.taskkillProcessTree ?? taskkillProcessTree;
  const killProcess = dependencies.killPosixProcess ?? ((pid, signal) => process.kill(pid, signal));
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const cleanupSettleMs = options.cleanupSettleMs ?? DEFAULT_CLEANUP_SETTLE_MS;
  const snapshotTimeoutMs = options.descendantSnapshotTimeoutMs ??
    DEFAULT_DESCENDANT_SNAPSHOT_TIMEOUT_MS;
  const monitorIntervalMs = options.descendantMonitorIntervalMs ??
    DEFAULT_DESCENDANT_MONITOR_INTERVAL_MS;
  const taskkillTimeoutMs = options.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS;

  if (options.signal?.aborted) {
    return Promise.reject(
      options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Process-tree run aborted.'),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true,
    });
    const activeControllers = new Set();
    const observedDescendants = new Map();
    const delayTimers = new Set();
    let rootIdentity = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let closing = false;
    let childClosed = false;
    let monitorTimer;
    let monitorInFlight = Promise.resolve();
    let resolveChildClose;
    const childClose = new Promise((resolveClose) => {
      resolveChildClose = resolveClose;
    });

    const delay = (milliseconds) => new Promise((resolveDelay) => {
      const timer = setTimeout(() => {
        delayTimers.delete(timer);
        resolveDelay();
      }, milliseconds);
      delayTimers.add(timer);
    });
    const stopMonitoring = () => {
      clearTimeout(monitorTimer);
    };
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      stopMonitoring();
      options.signal?.removeEventListener('abort', abortRun);
      for (const timer of delayTimers) {
        clearTimeout(timer);
      }
      delayTimers.clear();
      for (const controller of activeControllers) {
        controller.abort();
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) {
        reject(error);
      } else {
        resolve(result ?? { stdout, stderr });
      }
    };
    const captureSnapshot = async () => {
      const result = await runBoundedOperation(
        snapshotTimeoutMs,
        (signal) => snapshotProcessTree(child.pid, signal),
        activeControllers,
      );
      return result.ok && result.value?.identitiesByPid instanceof Map
        ? result.value
        : null;
    };
    const captureVerificationSnapshot = async () => {
      const result = await runBoundedOperation(
        snapshotTimeoutMs,
        (signal) => verifyPosixProcessTree(child.pid, signal),
        activeControllers,
      );
      return result.ok && result.value?.identitiesByPid instanceof Map
        ? result.value
        : null;
    };
    const rememberSnapshot = (snapshot) => {
      if (!rootIdentity && snapshot.rootIdentity) {
        rootIdentity = snapshot.rootIdentity;
      }
      for (const identity of snapshot.descendants) {
        const observedForPid = [...observedDescendants.values()]
          .filter((observed) => observed.pid === identity.pid);
        if (
          observedForPid.length > 0 &&
          !observedForPid.some((observed) => sameIdentity(observed, identity))
        ) {
          continue;
        }
        observedDescendants.set(identityKey(identity), identity);
      }
    };
    const rememberCurrentRootSnapshot = (snapshot) => {
      if (!rootIdentity) {
        if (childClosed || childHasExited(child) || !snapshot.rootIdentity) {
          return false;
        }
        rememberSnapshot(snapshot);
        return true;
      }
      const currentRoot = snapshot.identitiesByPid.get(child.pid);
      if (!sameIdentity(rootIdentity, currentRoot)) {
        return false;
      }
      rememberSnapshot(snapshot);
      return true;
    };
    const scheduleMonitor = (delayMs = 0) => {
      if (closing || timedOut || settled) {
        return;
      }
      monitorTimer = setTimeout(() => {
        monitorInFlight = captureSnapshot().then((snapshot) => {
          if (snapshot) {
            rememberCurrentRootSnapshot(snapshot);
          }
          scheduleMonitor(snapshot ? monitorIntervalMs : Math.max(monitorIntervalMs, 1_000));
        }).catch(() => scheduleMonitor(Math.max(monitorIntervalMs, 1_000)));
        void monitorInFlight;
      }, delayMs);
    };
    const runWindowsSignal = async (pid, force) => {
      const result = await runBoundedOperation(
        taskkillTimeoutMs,
        (signal) => runTaskkill({
          pid,
          force,
          ...createTaskkillInvocation(pid, force),
        }, signal),
        activeControllers,
      );
      return result.ok && result.value === true;
    };
    const matchingWindowsRoots = (snapshot) => {
      const matching = collectMatchingDescendants(observedDescendants, snapshot);
      const matchingPids = new Set(matching.map((identity) => identity.pid));
      return matching.filter((identity) => !matchingPids.has(identity.parentPid));
    };
    const cleanupPosixAfterClose = async () => {
      await monitorInFlight;
      if (observedDescendants.size === 0) {
        return;
      }
      const termSnapshot = await captureSnapshot();
      if (!termSnapshot) {
        throw new Error(`${options.label} exited, but observed descendant cleanup could not be verified.`);
      }
      const termTargets = signalPosixIdentities({
        child,
        observedDescendants,
        rootIdentity,
        snapshot: termSnapshot,
        signal: 'SIGTERM',
        includeRoot: false,
        killProcess,
      });
      if (termTargets.matchingDescendants.length === 0) {
        return;
      }
      await delay(terminationGraceMs);
      const killSnapshot = await captureSnapshot();
      if (!killSnapshot) {
        throw new Error(`${options.label} exited, but observed descendant KILL could not be verified.`);
      }
      signalPosixIdentities({
        child,
        observedDescendants,
        rootIdentity,
        snapshot: killSnapshot,
        signal: 'SIGKILL',
        includeRoot: false,
        killProcess,
      });
      await delay(cleanupSettleMs);
      const finalSnapshot = await captureSnapshot();
      if (!finalSnapshot || collectMatchingDescendants(observedDescendants, finalSnapshot).length > 0) {
        throw new Error(`${options.label} exited, but an observed descendant remains alive.`);
      }
    };
    const cleanupWindowsAfterClose = async () => {
      await monitorInFlight;
      if (observedDescendants.size === 0) {
        return;
      }
      const termSnapshot = await captureSnapshot();
      if (!termSnapshot) {
        throw new Error(`${options.label} exited, but Windows descendant cleanup could not be verified.`);
      }
      const termRoots = matchingWindowsRoots(termSnapshot);
      if (termRoots.length === 0) {
        return;
      }
      await Promise.all(termRoots.map((identity) => runWindowsSignal(identity.pid, false)));
      await delay(terminationGraceMs);
      const killSnapshot = await captureSnapshot();
      if (!killSnapshot) {
        throw new Error(`${options.label} exited, but Windows descendant KILL could not be verified.`);
      }
      const killRoots = matchingWindowsRoots(killSnapshot);
      await Promise.all(killRoots.map((identity) => runWindowsSignal(identity.pid, true)));
      await delay(cleanupSettleMs);
      const finalSnapshot = await captureSnapshot();
      if (!finalSnapshot || collectMatchingDescendants(observedDescendants, finalSnapshot).length > 0) {
        throw new Error(`${options.label} exited, but an observed Windows descendant remains alive.`);
      }
    };
    const cleanupAfterClose = async (code, signal) => {
      if (platform === 'win32') {
        await cleanupWindowsAfterClose();
      } else {
        await cleanupPosixAfterClose();
      }
      if (code !== 0 && !options.allowNonZeroExitCode) {
        throw new Error(
          `${options.label} failed with exit code ${code ?? 'null'}${signal ? ` and signal ${signal}` : ''}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      return { stdout, stderr, exitCode: code, signal };
    };
    const cleanupRunningTree = async () => {
      if (platform === 'win32') {
        const termSnapshot = await captureSnapshot();
        if (termSnapshot) {
          rememberCurrentRootSnapshot(termSnapshot);
          const currentRoot = termSnapshot.identitiesByPid.get(child.pid);
          if (!childHasExited(child) && sameIdentity(rootIdentity, currentRoot)) {
            const succeeded = await runWindowsSignal(child.pid, false);
            if (!succeeded && !childHasExited(child)) {
              killDirectChild(child, 'SIGTERM');
            }
          }
          await Promise.all(matchingWindowsRoots(termSnapshot)
            .map((identity) => runWindowsSignal(identity.pid, false)));
        } else if (!childHasExited(child)) {
          killDirectChild(child, 'SIGTERM');
        }
        await delay(terminationGraceMs);
        const killSnapshot = await captureSnapshot();
        if (killSnapshot) {
          rememberCurrentRootSnapshot(killSnapshot);
          const currentRoot = killSnapshot.identitiesByPid.get(child.pid);
          if (!childHasExited(child) && sameIdentity(rootIdentity, currentRoot)) {
            const succeeded = await runWindowsSignal(child.pid, true);
            if (!succeeded && !childHasExited(child)) {
              killDirectChild(child, 'SIGKILL');
            }
          }
          await Promise.all(matchingWindowsRoots(killSnapshot)
            .map((identity) => runWindowsSignal(identity.pid, true)));
        } else if (!childHasExited(child)) {
          killDirectChild(child, 'SIGKILL');
        }
      } else {
        const termSnapshot = await captureSnapshot();
        if (termSnapshot) {
          rememberCurrentRootSnapshot(termSnapshot);
          signalPosixIdentities({
            child,
            observedDescendants,
            rootIdentity,
            snapshot: termSnapshot,
            signal: 'SIGTERM',
            includeRoot: true,
            killProcess,
          });
          if (!sameIdentity(rootIdentity, termSnapshot.identitiesByPid.get(child.pid)) &&
              !childHasExited(child)) {
            killDirectChild(child, 'SIGTERM');
          }
        } else {
          killDirectChild(child, 'SIGTERM');
        }
        await delay(terminationGraceMs);
        const killSnapshot = await captureSnapshot();
        if (killSnapshot) {
          rememberCurrentRootSnapshot(killSnapshot);
          const killResult = signalPosixIdentities({
            child,
            observedDescendants,
            rootIdentity,
            snapshot: killSnapshot,
            signal: 'SIGKILL',
            includeRoot: true,
            killProcess,
          });
          if (!killResult.rootMatches && !childHasExited(child)) {
            killDirectChild(child, 'SIGKILL');
          }
        } else {
          if (!childHasExited(child)) {
            killDirectChild(child, 'SIGKILL');
          }
        }
      }
      await delay(cleanupSettleMs);
      if (platform === 'win32') {
        const finalSnapshot = await captureSnapshot();
        if (!finalSnapshot) {
          throw new Error(`${options.label} cleanup could not verify Windows process-tree termination.`);
        }
        const rootRemains = sameIdentity(
          rootIdentity,
          finalSnapshot.identitiesByPid.get(child.pid),
        );
        const descendantsRemain = collectMatchingDescendants(
          observedDescendants,
          finalSnapshot,
        ).length > 0;
        if (!childHasExited(child) || rootRemains || descendantsRemain) {
          throw new Error(`${options.label} cleanup could not confirm Windows process-tree termination.`);
        }
      } else if (!childHasExited(child)) {
        killDirectChild(child, 'SIGKILL');
        await delay(cleanupSettleMs);
      }
      if (platform !== 'win32' && observedDescendants.size > 0) {
        const verificationSnapshot = await captureVerificationSnapshot();
        if (!verificationSnapshot) {
          throw new Error(`${options.label} cleanup could not verify descendant termination.`);
        }
        if (
          collectMatchingDescendants(observedDescendants, verificationSnapshot).length > 0
        ) {
          signalPosixIdentities({
            child,
            observedDescendants,
            rootIdentity,
            snapshot: verificationSnapshot,
            signal: 'SIGKILL',
            includeRoot: false,
            killProcess,
          });
          await delay(cleanupSettleMs);
          let finalSnapshot = await captureVerificationSnapshot();
          if (finalSnapshot &&
              collectMatchingDescendants(observedDescendants, finalSnapshot).length > 0) {
            await delay(cleanupSettleMs);
            finalSnapshot = await captureVerificationSnapshot();
          }
          if (!finalSnapshot ||
              collectMatchingDescendants(observedDescendants, finalSnapshot).length > 0) {
            throw new Error(`${options.label} cleanup could not confirm descendant termination.`);
          }
        }
      }
    };

    const cleanupAfterTimeout = async () => {
      await cleanupRunningTree();
      throw new ProcessTreeTimeoutError(options.label, options.timeoutMs, stdout, stderr);
    };

    const timeoutTimer = options.timeoutMs == null ? undefined : setTimeout(() => {
      timedOut = true;
      closing = true;
      stopMonitoring();
      void cleanupAfterTimeout().then(
        () => finish(new ProcessTreeTimeoutError(options.label, options.timeoutMs, stdout, stderr)),
        finish,
      );
    }, options.timeoutMs);

    const abortRun = () => {
      if (settled || closing) {
        return;
      }
      aborted = true;
      closing = true;
      clearTimeout(timeoutTimer);
      stopMonitoring();
      const reason = options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Process-tree run aborted.');
      void cleanupRunningTree().then(() => finish(reason), finish);
    };
    options.signal?.addEventListener('abort', abortRun, { once: true });

    scheduleMonitor();
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      if (options.captureOutput !== false) {
        stdout += text;
      }
      options.onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (options.captureOutput !== false) {
        stderr += text;
      }
      options.onStderr?.(text);
    });
    child.once('error', (error) => {
      if (!timedOut && !aborted) {
        finish(new Error(`${options.label} failed to start: ${error.message}`));
      }
    });
    child.once('close', resolveChildClose);
    child.once('exit', (code, signal) => {
      childClosed = true;
      if (timedOut || aborted || settled) {
        return;
      }
      closing = true;
      clearTimeout(timeoutTimer);
      stopMonitoring();
      void cleanupAfterClose(code, signal).then(async (result) => {
        await childClose;
        finish(undefined, { ...result, stdout, stderr });
      }, finish);
    });
  });
}
