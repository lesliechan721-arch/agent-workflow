import { spawn } from 'node:child_process';
import process from 'node:process';

function terminateWindowsTree(child) {
  return new Promise((resolve) => {
    const killer = spawn(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    killer.once('error', () => {
      child.kill('SIGKILL');
      resolve();
    });
    killer.once('close', resolve);
  });
}

function signalChildTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

function posixProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function waitForEvalChild(
  child,
  timeoutMs,
  { forceKillAfterMs = 2_000, terminationPollMs = 20 } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let closed = false;
    let closeResult;
    let forceKillTimer;
    let terminationPollTimer;
    let windowsTerminationPending = false;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (terminationPollTimer) clearTimeout(terminationPollTimer);
    };
    const finish = () => {
      if (settled || !closed) return;
      if (timedOut && windowsTerminationPending) return;
      if (
        timedOut
        && process.platform !== 'win32'
        && child.pid
        && posixProcessGroupExists(child.pid)
      ) {
        if (!terminationPollTimer) {
          terminationPollTimer = setTimeout(() => {
            terminationPollTimer = undefined;
            finish();
          }, terminationPollMs);
        }
        return;
      }
      settled = true;
      cleanup();
      resolve({ ...closeResult, timedOut });
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        windowsTerminationPending = true;
        terminateWindowsTree(child).finally(() => {
          windowsTerminationPending = false;
          finish();
        });
        return;
      }
      signalChildTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        signalChildTree(child, 'SIGKILL');
      }, forceKillAfterMs);
      finish();
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      closed = true;
      closeResult = { code, signal };
      finish();
    });
  });
}
