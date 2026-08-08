import { execFile } from 'node:child_process';

type KillSignal = 'SIGTERM' | 'SIGKILL';
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 1_000;

export interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: KillSignal) => void;
  execFile?: (
    command: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean },
    callback: (error: Error | null, stdout: string) => void,
  ) => unknown;
}

const defaultExecFile: NonNullable<ProcessTreeDependencies['execFile']> = (
  command,
  args,
  options,
  callback,
) => execFile(command, args, options, (error, stdout) => callback(error, stdout));

function runTaskkill(
  pid: number,
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), PROCESS_TREE_COMMAND_TIMEOUT_MS);
    timeout.unref();

    try {
      execFileImpl(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { timeout: PROCESS_TREE_COMMAND_TIMEOUT_MS, windowsHide: true },
        (error) => finish(!error),
      );
    } catch {
      finish(false);
    }
  });
}

function readDescendantProcessIds(
  pid: number,
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
): Promise<number[]> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: number[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish([]), PROCESS_TREE_COMMAND_TIMEOUT_MS);
    timeout.unref();

    try {
      execFileImpl(
        'ps',
        ['-A', '-o', 'pid=,ppid='],
        { timeout: PROCESS_TREE_COMMAND_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            finish([]);
            return;
          }

          const childrenByParent = new Map<number, number[]>();
          for (const line of stdout.split('\n')) {
            const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
            if (!match) {
              continue;
            }
            const processId = Number(match[1]);
            const parentProcessId = Number(match[2]);
            const children = childrenByParent.get(parentProcessId) ?? [];
            children.push(processId);
            childrenByParent.set(parentProcessId, children);
          }

          const descendants: number[] = [];
          const pending = [...(childrenByParent.get(pid) ?? [])];
          while (pending.length > 0) {
            const descendant = pending.shift()!;
            descendants.push(descendant);
            pending.push(...(childrenByParent.get(descendant) ?? []));
          }
          finish(descendants.reverse());
        },
      );
    } catch {
      finish([]);
    }
  });
}

export async function terminateProcessTree(
  pid: number,
  killDirectChild: (signal: KillSignal) => void,
  dependencies: ProcessTreeDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;

  if (platform === 'win32') {
    const execFileImpl = dependencies.execFile ?? defaultExecFile;
    if (!(await runTaskkill(pid, execFileImpl))) {
      try {
        killDirectChild('SIGKILL');
      } catch {
        // The direct child can exit before the fallback runs.
      }
    }
    return;
  }

  const kill = dependencies.kill ?? process.kill.bind(process);
  const descendants = await readDescendantProcessIds(
    pid,
    dependencies.execFile ?? defaultExecFile,
  );
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const descendantPid of descendants) {
      try {
        kill(descendantPid, signal);
      } catch {
        // A descendant can exit between process discovery and termination.
      }
    }
  }

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      killDirectChild(signal);
    } catch {
      // The direct child can exit between signals.
    }
  }
}
