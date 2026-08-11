import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTestPnpmInvocation,
  execPnpmForTest,
} from '../helpers/pnpm.js';

describe('test pnpm helper', () => {
  const fakePnpmPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'fake-pnpm.cjs',
  );

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs the npm_execpath pnpm CLI through the current Node executable', () => {
    expect(createTestPnpmInvocation(
      ['build', '--filter', '@lesliechan721/aw'],
      '/workspace/node_modules/pnpm/bin/pnpm.cjs',
    )).toEqual({
      command: process.execPath,
      args: [
        '/workspace/node_modules/pnpm/bin/pnpm.cjs',
        'build',
        '--filter',
        '@lesliechan721/aw',
      ],
    });
  });

  it('fails before spawning when npm_execpath is missing', async () => {
    vi.stubEnv('npm_execpath', '');

    await expect(execPnpmForTest(['build'], { env: {} })).rejects.toThrow(
      'Cannot run pnpm in tests because npm_execpath is missing',
    );
  });

  it('preserves stdout, stderr, and non-zero exit semantics', async () => {
    vi.stubEnv('npm_execpath', fakePnpmPath);
    const env = {
      ...process.env,
    };

    await expect(execPnpmForTest(['build'], {
      cwd: path.dirname(fakePnpmPath),
      env,
      maxBuffer: 1024,
    })).resolves.toEqual({
      stdout: 'stdout:build',
      stderr: 'stderr:fake-pnpm',
    });

    await expect(execPnpmForTest(['--fail'], { env })).rejects.toMatchObject({
      code: 7,
      stdout: 'stdout:--fail',
      stderr: 'stderr:fake-pnpm',
    });
  });
});
