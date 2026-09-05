import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertIsolatedTestEnv,
  assertPathWithinWritableRoots,
  assertPathWithinReadableRoots,
  assertSafeTestCwd,
  createIsolatedTestEnv,
  expectPathFenceViolation,
  runWithRepositoryCwdAsReadOnly,
  withSafeTestCwd,
} from '../helpers/test-isolation.js';
import { normalizeAbsolutePath } from '../helpers/path-fence.js';
import {
  createPureTestIsolationContext,
  PURE_TEST_ENV_KEYS,
} from '../../../../scripts/test/pure-test-isolation.js';

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
  it('keeps non-pure tests on the full filesystem isolation', async () => {
    expect(process.env.HOME).toContain('aw-test-isolation-');
    expect(process.env.HOME).not.toContain('aw-pure-test-home-');
    expect(path.basename(process.cwd())).toBe('fixture-cwd');
    expect(process.cwd()).toContain(path.basename(path.dirname(process.env.HOME!)));
    await expect(fs.pathExists(path.dirname(process.env.HOME!))).resolves.toBe(true);
    await expect(fs.pathExists(process.env.npm_config_userconfig!)).resolves.toBe(true);
  });

  it('patches and restores only the controlled pure environment keys', async () => {
    const before = new Map(Object.entries(process.env));
    const cwd = process.cwd();
    const uncontrolledKey = 'AW_PURE_TEST_UNCONTROLLED_SENTINEL';
    process.env[uncontrolledKey] = 'preserved';
    const context = await createPureTestIsolationContext();

    try {
      const changedKeys = Object.keys(process.env).filter((key) =>
        process.env[key] !== before.get(key) && key !== uncontrolledKey);
      expect(changedKeys.sort()).toEqual([...PURE_TEST_ENV_KEYS].sort());
      expect(process.env[uncontrolledKey]).toBe('preserved');
      expect(process.cwd()).toBe(cwd);
      await expect(fs.pathExists(context.sentinelHome)).resolves.toBe(false);
      await expect(fs.pathExists(context.npmUserConfigPath)).resolves.toBe(false);
    } finally {
      await context.teardown();
      delete process.env[uncontrolledKey];
    }

    for (const key of PURE_TEST_ENV_KEYS) {
      expect(Object.hasOwn(process.env, key)).toBe(before.has(key));
      expect(process.env[key]).toBe(before.get(key));
    }
  });

  it('fails and removes only its sentinel HOME when a pure test creates it', async () => {
    const context = await createPureTestIsolationContext();
    const foreignSibling = `${context.sentinelHome}-foreign`;
    await Promise.all([
      fs.ensureDir(context.sentinelHome),
      fs.ensureDir(foreignSibling),
    ]);

    try {
      await expect(context.teardown()).rejects.toThrow('Pure test created its sentinel HOME');
      await expect(fs.pathExists(context.sentinelHome)).resolves.toBe(false);
      await expect(fs.pathExists(foreignSibling)).resolves.toBe(true);
    } finally {
      await fs.remove(foreignSibling);
    }
  });

  it('creates required paths and leaves business state paths lazy', async () => {
    const isolated = await createIsolatedTestEnv();
    cleanupTasks.push(isolated.cleanup);

    expect(isolated.layout.rootDir).toContain('aw-test-isolation-');
    expect(isolated.layout.homeDir).toBe(path.join(isolated.layout.rootDir, 'home'));
    expect(isolated.layout.awHomeDir).toBe(path.join(isolated.layout.rootDir, 'aw-home'));
    expect(isolated.layout.localMarketplaceStagingRoot).toBe(path.join(
      isolated.layout.rootDir,
      '.aw-local-marketplace-staging',
    ));
    expect(isolated.layout.localMarketplaceBackupRoot).toBe(path.join(
      isolated.layout.rootDir,
      '.aw-local-marketplace-backups',
    ));
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

    await expect(fs.pathExists(isolated.layout.rootDir)).resolves.toBe(true);
    await expect(fs.pathExists(isolated.layout.npmDir)).resolves.toBe(true);
    await expect(fs.pathExists(isolated.layout.npmUserConfigPath)).resolves.toBe(true);
    await expect(fs.pathExists(isolated.layout.tmpDir)).resolves.toBe(true);
    await expect(fs.pathExists(isolated.layout.fixtureCwd)).resolves.toBe(true);

    for (const lazyPath of [
      isolated.layout.homeDir,
      isolated.layout.awHomeDir,
      isolated.layout.localMarketplaceStagingRoot,
      isolated.layout.localMarketplaceBackupRoot,
      isolated.layout.codexHomeDir,
      isolated.layout.claudeHomeDir,
      isolated.layout.xdgConfigHomeDir,
      isolated.layout.xdgCacheHomeDir,
      isolated.layout.xdgStateHomeDir,
      isolated.layout.debugLogsDir,
    ]) {
      await expect(fs.pathExists(lazyPath)).resolves.toBe(false);
    }

    expect(() => assertIsolatedTestEnv(isolated.env, isolated.rootRegistry)).not.toThrow();
    expect(() => assertPathWithinWritableRoots(isolated.rootRegistry, {
      path: isolated.layout.localMarketplaceBackupRoot,
      source: 'local marketplace backup root',
    })).not.toThrow();
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
