import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getClaudeHome,
  getCodexHome,
  resolveCliTempRoot,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveAwHome,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../../src/utils/paths.js';
import { setTestPathFenceHookForTests } from '../../src/utils/test-path-fence.js';
import { resolveUserHome } from '../../src/utils/state-paths.js';
import { expectPathFenceViolation } from '../helpers/test-isolation.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('project key paths', () => {
  // Test Value Gate: plain copied Windows environments must resolve the same target as the child provider.
  it('uses mixed-case Windows home keys and keeps POSIX keys exact', () => {
    expect(resolveUserHome({ UserProfile: 'D:\\custom\\home' }, 'win32', 'C:\\Users\\default'))
      .toBe('D:\\custom\\home');
    expect(resolveUserHome({ home: '/ignored', HOME: '/exact' }, 'linux', '/system')).toBe('/exact');
    expect(resolveUserHome({ home: '/ignored' }, 'linux', '/system')).toBe('/system');
  });

  it('chooses the first sorted Windows home key, including an undefined first value', () => {
    expect(resolveUserHome({ userprofile: 'Z:\\last', UserProfile: 'D:\\first' }, 'win32', 'C:\\system'))
      .toBe('D:\\first');
    expect(resolveUserHome({ UserProfile: 'D:\\ignored', USERPROFILE: undefined }, 'win32', 'C:\\system'))
      .toBe('C:\\system');
  });

  it('resolves formal Windows Agent and AW homes from mixed-case keys', () => {
    // These are pure path calculations for a foreign platform; no filesystem access follows.
    setTestPathFenceHookForTests(null);
    const env = { UserProfile: 'C:\\Users\\custom', CodeX_Home: '  D:\\codex  ',
      Claude_Config_Dir: '  E:\\claude  ', Aw_Home: 'F:\\aw' };
    expect(getCodexHome(env, 'win32', 'C:\\system')).toBe('D:\\codex');
    expect(getClaudeHome(env, 'win32', 'C:\\system')).toBe('E:\\claude');
    expect(resolveAwHome(env, 'win32', 'C:\\system')).toBe('F:\\aw');
    expect(getCodexHome({ UserProfile: env.UserProfile }, 'win32', 'C:\\system'))
      .toBe('C:\\Users\\custom\\.codex');
    expect(getClaudeHome({ UserProfile: env.UserProfile }, 'win32', 'C:\\system'))
      .toBe('C:\\Users\\custom\\.claude');
  });

  it('uses the canonical repo root for Claude project paths from a subdirectory', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const repoRoot = path.join(isolation.layout.rootDir, 'claude-project-root');
    const subdir = path.join(repoRoot, 'packages', 'app');
    const outside = path.join(isolation.layout.rootDir, 'outside-claude');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(subdir);
    await fs.ensureDir(outside);
    await fs.symlink(outside, path.join(subdir, '.claude'), 'dir');
    const canonicalRoot = await fs.realpath(repoRoot);

    expect(resolveClaudePaths(subdir, 'project', isolation.env).configDir).toBe(
      path.join(canonicalRoot, '.claude'),
    );
    await expect(resolveClaudeProjectKey(subdir)).resolves.toBe(canonicalRoot);
  });

  it('derives isolated home and current catalog cache paths from the shared test env', async () => {
    const isolation = getCurrentSourceTestIsolation();

    expect(resolveAwHome(process.env)).toBe(isolation.layout.awHomeDir);
    expect(getCodexHome(process.env)).toBe(isolation.layout.codexHomeDir);
    expect(getClaudeHome(process.env)).toBe(isolation.layout.claudeHomeDir);
    expect(resolveCliTempRoot(process.env)).toBe(path.join(isolation.layout.tmpDir, 'aw-cli'));
  });

  it('blocks real-home fallbacks and read-only home overrides while the test fence is installed', () => {
    const repositoryCwd = getSourceTestRepositoryCwd();
    const realHome = os.userInfo().homedir;
    registerCurrentTestReadonlyFixtureRoot(repositoryCwd, 'repository cwd');
    expectPathFenceViolation(
      () => resolveAwHome({ HOME: realHome } as NodeJS.ProcessEnv),
      {
        access: 'write',
        path: path.join(realHome, '.aw'),
        source: 'AW_HOME fallback (HOME)',
        reason: 'outsideRegisteredRoots',
        recommendedFixIncludes: 'createIsolatedTestEnv()',
      },
    );

    expectPathFenceViolation(
      () => getCodexHome({
        CODEX_HOME: path.join(repositoryCwd, '.codex-test-home'),
      } as NodeJS.ProcessEnv),
      {
        access: 'write',
        path: path.join(repositoryCwd, '.codex-test-home'),
        source: 'CODEX_HOME',
        reason: 'writeToReadOnlyRoot',
        conflictingRootPath: repositoryCwd,
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );

    expectPathFenceViolation(
      () => getClaudeHome({
        CLAUDE_CONFIG_DIR: path.join(repositoryCwd, '.claude-test-home'),
      } as NodeJS.ProcessEnv),
      {
        access: 'write',
        path: path.join(repositoryCwd, '.claude-test-home'),
        source: 'CLAUDE_CONFIG_DIR',
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

  it('uses official Agent homes and ignores AW test overrides', () => {
    setTestPathFenceHookForTests(null);
    const home = path.join(os.tmpdir(), 'agent-home');
    const env = { HOME: home, USERPROFILE: home,
      AW_CODEX_HOME: path.join(home, 'aw-codex'),
      AW_CLAUDE_HOME: path.join(home, 'aw-claude') };
    expect(getCodexHome({
      ...env, CODEX_HOME: path.join(home, 'public-codex'),
    })).toBe(path.join(home, 'public-codex'));
    expect(getClaudeHome({
      ...env, CLAUDE_CONFIG_DIR: path.join(home, 'public-claude'),
    })).toBe(path.join(home, 'public-claude'));
    expect(getCodexHome(env)).toBe(path.join(home, '.codex'));
    expect(getClaudeHome(env)).toBe(path.join(home, '.claude'));
    expect(getCodexHome({})).toBe(path.join(os.userInfo().homedir, '.codex'));
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
    expect(paths.configTomlPath).toBe(path.join(repoRoot, '.codex', 'config.toml'));
  });
});
