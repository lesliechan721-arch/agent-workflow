import { describe, expect, it } from 'vitest';

import {
  NativeCliError,
  execFileNativeCliRunner,
  runNativeCli,
} from '../../src/utils/native-cli.js';

describe('native-cli', () => {
  it('passes invocations through fake runners', async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

    const result = await runNativeCli(
      {
        command: 'claude',
        args: ['plugin', 'install', 'git-commit@aw'],
        cwd: '/tmp/workspace',
      },
      async (invocation) => {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        };
      },
    );

    expect(calls).toEqual([
      {
        command: 'claude',
        args: ['plugin', 'install', 'git-commit@aw'],
        cwd: '/tmp/workspace',
      },
    ]);
    expect(result.stdout).toBe('ok');
  });

  it('captures stdout and stderr from execFile', async () => {
    const result = await execFileNativeCliRunner({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ready"); process.stderr.write("warn");'],
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'ready',
      stderr: 'warn',
    });
  });

  it('converts non-zero exits into NativeCliError', async () => {
    await expect(
      execFileNativeCliRunner({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(7);',
        ],
      }),
    ).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 7,
      stdout: 'partial',
      stderr: 'boom',
    });
  });

  it('surfaces timeouts as exitCode 124', async () => {
    await expect(
      execFileNativeCliRunner({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000);'],
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 124,
    });
  });
});
