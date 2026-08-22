import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (process.platform !== 'win32') {
      try {
        const { stdout } = await execFileAsync('ps', ['-o', 'state=', '-p', String(pid)]);
        if (String(stdout).trim().startsWith('Z')) return;
      } catch {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} is still running after cleanup.`);
}
