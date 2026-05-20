import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getClaudeHome,
  getCodexHome,
  resolveClaudeProjectKey,
  resolveAwHome,
  resolveCurrentCatalogCacheEntriesDir,
  resolveCurrentCatalogCacheEntryDir,
  resolveCurrentCatalogCacheRoot,
  resolveCurrentCatalogCacheStagingDir,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../../src/utils/paths.js';
import { setTestPathFenceHookForTests } from '../../src/utils/test-path-fence.js';
import { expectPathFenceViolation } from '../helpers/test-isolation.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
  registerCurrentTestReadonlyFixtureRoot,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('project key paths', () => {
  it('derives isolated home and current catalog cache paths from the shared test env', () => {
    const isolation = getCurrentSourceTestIsolation();

    expect(resolveAwHome(process.env)).toBe(isolation.layout.awHomeDir);
    expect(getCodexHome(process.env)).toBe(isolation.layout.codexHomeDir);
    expect(getClaudeHome(process.env)).toBe(isolation.layout.claudeHomeDir);
    expect(resolveCurrentCatalogCacheRoot(process.env)).toBe(path.join(isolation.layout.awHomeDir, 'catalog-cache'));
    expect(resolveCurrentCatalogCacheEntriesDir(process.env)).toBe(path.join(isolation.layout.awHomeDir, 'catalog-cache', 'entries'));
    expect(resolveCurrentCatalogCacheEntryDir('cache-key', process.env)).toBe(path.join(isolation.layout.awHomeDir, 'catalog-cache', 'entries', 'cache-key'));
    expect(resolveCurrentCatalogCacheStagingDir(process.env)).toBe(path.join(isolation.layout.awHomeDir, 'catalog-cache', 'staging'));
  });

  it('blocks real-home fallbacks and read-only home overrides while the test fence is installed', () => {
    const repositoryCwd = getSourceTestRepositoryCwd();
    registerCurrentTestReadonlyFixtureRoot(repositoryCwd, 'repository cwd');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    try {
      expectPathFenceViolation(
        () => resolveAwHome({} as NodeJS.ProcessEnv),
        {
          access: 'write',
          path: path.join(os.homedir(), '.aw'),
          source: 'AW_HOME fallback (os.homedir())',
          reason: 'outsideRegisteredRoots',
          recommendedFixIncludes: 'createIsolatedTestEnv()',
        },
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }

    expectPathFenceViolation(
      () => getCodexHome({
        AW_CODEX_HOME: path.join(repositoryCwd, '.codex-test-home'),
      } as NodeJS.ProcessEnv),
      {
        access: 'write',
        path: path.join(repositoryCwd, '.codex-test-home'),
        source: 'AW_CODEX_HOME',
        reason: 'writeToReadOnlyRoot',
        conflictingRootPath: repositoryCwd,
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );

    expectPathFenceViolation(
      () => getClaudeHome({
        AW_CLAUDE_HOME: path.join(repositoryCwd, '.claude-test-home'),
      } as NodeJS.ProcessEnv),
      {
        access: 'write',
        path: path.join(repositoryCwd, '.claude-test-home'),
        source: 'AW_CLAUDE_HOME',
        reason: 'writeToReadOnlyRoot',
        conflictingRootPath: repositoryCwd,
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );
  });

  it('restores production path resolution once the test-only fence hook is reset', () => {
    const unsafeAwHome = path.join(getSourceTestRepositoryCwd(), '.aw-test-home');
    setTestPathFenceHookForTests(null);

    expect(resolveAwHome({
      AW_HOME: unsafeAwHome,
    } as NodeJS.ProcessEnv)).toBe(unsafeAwHome);
  });

  it('normalizes symlink and realpath aliases to the same Claude/Codex project key', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-paths-'));
    tempDirs.push(root);

    const realRepo = path.join(root, 'real-repo');
    const aliasRepo = path.join(root, 'alias-repo');
    await fs.ensureDir(path.join(realRepo, '.git'));
    await fs.ensureDir(path.join(realRepo, 'subdir'));
    await fs.symlink(realRepo, aliasRepo);

    const [claudeReal, claudeAlias, codexReal, codexAlias] = await Promise.all([
      resolveClaudeProjectKey(realRepo),
      resolveClaudeProjectKey(aliasRepo),
      resolveCodexProjectKey(path.join(realRepo, 'subdir')),
      resolveCodexProjectKey(path.join(aliasRepo, 'subdir')),
    ]);

    expect(claudeAlias).toBe(claudeReal);
    expect(codexAlias).toBe(codexReal);
  });

  it('anchors Codex project paths at the repo root when invoked from a subdirectory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-paths-'));
    tempDirs.push(root);

    const repoRoot = path.join(root, 'repo');
    const nestedDir = path.join(repoRoot, 'packages', 'feature');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(nestedDir);

    const paths = resolveCodexPaths(nestedDir, 'project');

    expect(paths.configDir).toBe(path.join(repoRoot, '.codex'));
    expect(paths.trackingDir).toBe(path.join(repoRoot, '.codex'));
    expect(paths.hooksPath).toBe(path.join(repoRoot, '.codex', 'hooks.json'));
  });
});
