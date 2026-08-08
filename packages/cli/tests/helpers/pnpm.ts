import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestPnpmOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeout?: number;
}

export interface TestPnpmInvocation {
  command: string;
  args: string[];
}

export function createTestPnpmInvocation(
  args: string[],
  npmExecPath: string | undefined = process.env.npm_execpath,
): TestPnpmInvocation {
  const resolvedNpmExecPath = npmExecPath?.trim();
  if (!resolvedNpmExecPath) {
    throw new Error(
      'Cannot run pnpm in tests because npm_execpath is missing. Run the test through pnpm so the exact pnpm CLI path is available.',
    );
  }

  return {
    command: process.execPath,
    args: [resolvedNpmExecPath, ...args],
  };
}

export async function execPnpmForTest(
  args: string[],
  options: TestPnpmOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const env = options.env ?? process.env;
  const invocation = createTestPnpmInvocation(args);
  return execFileAsync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
  });
}
