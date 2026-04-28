import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandWarningError } from '../../src/types.js';

function createCapturedIo() {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('cli entry', () => {
  it('rejects invalid --skill-trigger values at the entry layer', async () => {
    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--skill-trigger', 'sometimes'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('Unsupported skill trigger preference "sometimes"');
  });

  it('passes install --skill-trigger to installCommand', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io } = createCapturedIo();
    const env = {} as NodeJS.ProcessEnv;
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--skill-trigger', 'manual'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      }),
      { env },
    );
  });

  it('passes upgrade --skill-trigger to upgradeCommand', async () => {
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['claude'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/upgrade.js', () => ({
      upgradeCommand,
    }));

    const { io } = createCapturedIo();
    const env = {} as NodeJS.ProcessEnv;
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['upgrade', 'git-commit', '--platform', 'claude', '--skill-trigger', 'auto'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(upgradeCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'project',
        platform: 'claude',
        requestedSkillTrigger: 'auto',
      }),
      { env },
    );
  });

  it('prints warnings before the final error message', async () => {
    vi.doMock('../../src/commands/upgrade.js', () => ({
      upgradeCommand: vi.fn(async () => {
        throw new CommandWarningError('fatal upgrade error', {
          warnings: ['rebuild replay skipped'],
        });
      }),
    }));

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['upgrade', 'git-commit'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    const stderr = readStderr();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Warning: rebuild replay skipped');
    expect(stderr).toContain('fatal upgrade error');
    expect(stderr.indexOf('Warning: rebuild replay skipped')).toBeLessThan(
      stderr.indexOf('fatal upgrade error'),
    );
  });
});
