import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertIsolatedTestEnv,
  assertPathWithinReadableRoots,
  assertSafeTestCwd,
  createIsolatedTestEnv,
  expectPathFenceViolation,
  runWithRepositoryCwdAsReadOnly,
  withSafeTestCwd,
} from '../helpers/test-isolation.js';
import { normalizeAbsolutePath } from '../helpers/path-fence.js';

const cleanupTasks: Array<() => Promise<void>> = [];
const extraTempDirs: string[] = [];

async function trackTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  extraTempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();
    if (cleanup) {
      await cleanup();
    }
  }

  await Promise.all(extraTempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('test isolation helpers', () => {
  it('creates the stage 1 safe root layout and env overlay', async () => {
    const isolated = await createIsolatedTestEnv();
    cleanupTasks.push(isolated.cleanup);

    expect(isolated.layout.rootDir).toContain('aw-test-isolation-');
    expect(isolated.layout.homeDir).toBe(path.join(isolated.layout.rootDir, 'home'));
    expect(isolated.layout.awHomeDir).toBe(path.join(isolated.layout.rootDir, 'aw-home'));
    expect(isolated.layout.codexHomeDir).toBe(path.join(isolated.layout.rootDir, 'codex-home'));
    expect(isolated.layout.claudeHomeDir).toBe(path.join(isolated.layout.rootDir, 'claude-home'));
    expect(isolated.layout.xdgConfigHomeDir).toBe(path.join(isolated.layout.rootDir, 'xdg-config'));
    expect(isolated.layout.xdgCacheHomeDir).toBe(path.join(isolated.layout.rootDir, 'xdg-cache'));
    expect(isolated.layout.xdgStateHomeDir).toBe(path.join(isolated.layout.rootDir, 'xdg-state'));
    expect(isolated.layout.npmDir).toBe(path.join(isolated.layout.rootDir, 'npm'));
    expect(isolated.layout.npmUserConfigPath).toBe(path.join(isolated.layout.npmDir, '.npmrc'));
    expect(isolated.layout.tmpDir).toBe(path.join(isolated.layout.rootDir, 'tmp'));
    expect(isolated.layout.debugLogsDir).toBe(path.join(isolated.layout.rootDir, 'debug-logs'));
    expect(isolated.layout.fixtureCwd).toBe(path.join(isolated.layout.rootDir, 'fixture-cwd'));

    expect(isolated.env.HOME).toBe(isolated.layout.homeDir);
    expect(isolated.env.USERPROFILE).toBe(isolated.layout.homeDir);
    expect(isolated.env.AW_HOME).toBe(isolated.layout.awHomeDir);
    expect(isolated.env.AW_CODEX_HOME).toBe(isolated.layout.codexHomeDir);
    expect(isolated.env.AW_CLAUDE_HOME).toBe(isolated.layout.claudeHomeDir);
    expect(isolated.env.XDG_CONFIG_HOME).toBe(isolated.layout.xdgConfigHomeDir);
    expect(isolated.env.XDG_CACHE_HOME).toBe(isolated.layout.xdgCacheHomeDir);
    expect(isolated.env.XDG_STATE_HOME).toBe(isolated.layout.xdgStateHomeDir);
    expect(isolated.env.npm_config_userconfig).toBe(isolated.layout.npmUserConfigPath);
    expect(isolated.env.NPM_CONFIG_USERCONFIG).toBe(isolated.layout.npmUserConfigPath);
    expect(isolated.env.TMPDIR).toBe(isolated.layout.tmpDir);
    expect(isolated.env.TEMP).toBe(isolated.layout.tmpDir);
    expect(isolated.env.TMP).toBe(isolated.layout.tmpDir);

    await expect(fs.pathExists(isolated.layout.npmUserConfigPath)).resolves.toBe(true);
    await expect(fs.pathExists(isolated.layout.debugLogsDir)).resolves.toBe(true);
    await expect(fs.pathExists(isolated.layout.fixtureCwd)).resolves.toBe(true);

    expect(() => assertIsolatedTestEnv(isolated.env, isolated.rootRegistry)).not.toThrow();
    expect(() => assertSafeTestCwd(isolated.layout.fixtureCwd, isolated.rootRegistry)).not.toThrow();
  });

  it.each([
    {
      key: 'HOME',
      value: os.homedir(),
    },
    {
      key: 'AW_HOME',
      value: path.join(os.homedir(), '.aw'),
    },
    {
      key: 'AW_CODEX_HOME',
      value: path.join(os.homedir(), '.codex'),
    },
    {
      key: 'AW_CLAUDE_HOME',
      value: path.join(os.homedir(), '.claude'),
    },
    {
      key: 'npm_config_userconfig',
      value: path.join(os.homedir(), '.npmrc'),
    },
  ])('fails early when %s points at a real user path', async ({ key, value }) => {
    const isolated = await createIsolatedTestEnv();
    cleanupTasks.push(isolated.cleanup);

    const overriddenEnv: NodeJS.ProcessEnv = {
      ...isolated.env,
      [key]: value,
    };
    if (key === 'npm_config_userconfig') {
      overriddenEnv.NPM_CONFIG_USERCONFIG = value;
    }

    expectPathFenceViolation(
      () => assertIsolatedTestEnv(overriddenEnv, isolated.rootRegistry),
      {
        access: 'write',
        path: value,
        source: key,
        reason: 'outsideRegisteredRoots',
        recommendedFixIncludes: 'createIsolatedTestEnv()',
      },
    );
  });

  it('fails early when temp paths point at an unregistered root', async () => {
    const isolated = await createIsolatedTestEnv();
    cleanupTasks.push(isolated.cleanup);
    const rogueTempRoot = await trackTempDir('aw-test-isolation-rogue-temp-');

    expectPathFenceViolation(
      () => assertIsolatedTestEnv({
        ...isolated.env,
        TMPDIR: rogueTempRoot,
        TEMP: rogueTempRoot,
        TMP: rogueTempRoot,
      }, isolated.rootRegistry),
      {
        access: 'write',
        path: rogueTempRoot,
        source: 'TMPDIR',
        reason: 'outsideRegisteredRoots',
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );
  });

  it('withSafeTestCwd registers a writable cwd and restores process.cwd()', async () => {
    const isolated = await createIsolatedTestEnv();
    cleanupTasks.push(isolated.cleanup);
    const previousCwd = process.cwd();
    const workspaceRoot = await trackTempDir('aw-test-isolation-cwd-');
    const normalizedWorkspaceRoot = normalizeAbsolutePath(workspaceRoot);

    const result = await withSafeTestCwd(isolated.rootRegistry, workspaceRoot, () => {
      expect(process.cwd()).toBe(normalizedWorkspaceRoot);
      expect(() => assertSafeTestCwd(process.cwd(), isolated.rootRegistry)).not.toThrow();
      return path.join(process.cwd(), '.agent-workflows');
    });

    expect(result).toBe(path.join(normalizedWorkspaceRoot, '.agent-workflows'));
    expect(process.cwd()).toBe(previousCwd);
  });

  it('runWithRepositoryCwdAsReadOnly keeps cwd readable but not writable', async () => {
    const isolated = await createIsolatedTestEnv();
    cleanupTasks.push(isolated.cleanup);
    const previousCwd = process.cwd();
    const repoRoot = await trackTempDir('aw-test-isolation-readonly-repo-');
    const normalizedRepoRoot = normalizeAbsolutePath(repoRoot);

    await runWithRepositoryCwdAsReadOnly(
      isolated.rootRegistry,
      () => {
        expect(process.cwd()).toBe(normalizedRepoRoot);
        expect(() => assertPathWithinReadableRoots(isolated.rootRegistry, {
          path: path.join(repoRoot, 'fixtures', 'repo-template'),
          source: 'repo fixture',
        })).not.toThrow();

        expectPathFenceViolation(
          () => assertSafeTestCwd(process.cwd(), isolated.rootRegistry),
          {
            access: 'write',
            path: repoRoot,
            source: 'cwd',
            reason: 'writeToReadOnlyRoot',
            conflictingRootPath: repoRoot,
            recommendedFixIncludes: 'withSafeTestCwd()',
          },
        );
      },
      {
        repositoryCwd: repoRoot,
      },
    );

    expect(process.cwd()).toBe(previousCwd);
  });

  it('fails early when cwd points at an unregistered repository root', async () => {
    const isolated = await createIsolatedTestEnv();
    cleanupTasks.push(isolated.cleanup);
    const rogueRepoRoot = await trackTempDir('aw-test-isolation-rogue-cwd-');

    expectPathFenceViolation(
      () => assertSafeTestCwd(rogueRepoRoot, isolated.rootRegistry),
      {
        access: 'write',
        path: rogueRepoRoot,
        source: 'cwd',
        reason: 'outsideRegisteredRoots',
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );
  });
});
