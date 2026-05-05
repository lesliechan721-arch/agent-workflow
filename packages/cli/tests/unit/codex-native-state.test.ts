import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assessCodexMarketplaceCleanup,
  checkCodexNativeInstallPostCheck,
  checkCodexNativeUninstallPostCheck,
  listCodexNativeEvidence,
  readCodexNativePluginState,
} from '../../src/utils/codex-native-state.js';
import {
  upsertCodexMarketplaceFile,
  upsertCodexPluginEnabledFile,
} from '../../src/utils/codex-config.js';
import { resolveCodexPaths } from '../../src/utils/paths.js';

const tempDirs: string[] = [];

async function makeEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-native-state-'));
  tempDirs.push(root);
  return {
    ...process.env,
    AW_CODEX_HOME: path.join(root, 'codex-home'),
  };
}

function getConfigPath(env: NodeJS.ProcessEnv): string {
  return resolveCodexPaths(process.cwd(), 'user', env).configTomlPath;
}

function getCacheVersionPath(
  env: NodeJS.ProcessEnv,
  pluginName: string,
  version: string,
): string {
  return path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName, version);
}

async function writeActiveCache(
  env: NodeJS.ProcessEnv,
  pluginName: string,
  version = '0.1.0',
): Promise<string> {
  const versionPath = getCacheVersionPath(env, pluginName, version);
  await fs.outputFile(path.join(versionPath, 'plugin.json'), '{}\n', 'utf8');
  return versionPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('codex-native-state', () => {
  it('distinguishes enabled-only and disabled-only config entries', async () => {
    const env = await makeEnv();
    const configPath = getConfigPath(env);

    await upsertCodexPluginEnabledFile(configPath, 'enabled-only@aw', { enabled: true });
    await upsertCodexPluginEnabledFile(configPath, 'disabled-only@aw', { enabled: false });

    await expect(readCodexNativePluginState('enabled-only', env)).resolves.toMatchObject({
      pluginId: 'enabled-only@aw',
      configEntryPresent: true,
      pluginEnabled: true,
      pluginInstalled: false,
      cacheStatus: 'missing',
    });
    await expect(readCodexNativePluginState('disabled-only', env)).resolves.toMatchObject({
      pluginId: 'disabled-only@aw',
      configEntryPresent: true,
      pluginEnabled: false,
      pluginInstalled: false,
      cacheStatus: 'missing',
    });

    await expect(listCodexNativeEvidence(env)).resolves.toMatchObject([
      {
        pluginName: 'enabled-only',
        pluginEnabled: true,
        pluginInstalled: false,
      },
    ]);
  });

  it('detects cache-only active installs as native evidence', async () => {
    const env = await makeEnv();
    const activeCachePath = await writeActiveCache(env, 'cache-only');

    await expect(readCodexNativePluginState('cache-only', env)).resolves.toMatchObject({
      configEntryPresent: false,
      pluginEnabled: false,
      pluginInstalled: true,
      cacheStatus: 'active',
      activeCacheVersion: '0.1.0',
      activeCachePath,
    });

    await expect(listCodexNativeEvidence(env)).resolves.toMatchObject([
      {
        pluginName: 'cache-only',
        pluginEnabled: false,
        pluginInstalled: true,
        activeCachePath,
      },
    ]);
  });

  it('treats multiple valid cache versions as ambiguous instead of installed', async () => {
    const env = await makeEnv();
    const firstPath = await writeActiveCache(env, 'multi-version', '0.1.0');
    const secondPath = await writeActiveCache(env, 'multi-version', '0.2.0');
    const state = await readCodexNativePluginState('multi-version', env);

    expect(state).toMatchObject({
      configEntryPresent: false,
      pluginEnabled: false,
      pluginInstalled: false,
      cacheStatus: 'ambiguous',
      validCachePaths: [firstPath, secondPath],
    });
    expect(state.activeCachePath).toBeUndefined();

    await expect(listCodexNativeEvidence(env)).resolves.toMatchObject([
      {
        pluginName: 'multi-version',
        pluginInstalled: false,
        cacheStatus: 'ambiguous',
        validCachePaths: [firstPath, secondPath],
      },
    ]);
  });

  it('surfaces invalid cache directories and non-directory entries as native evidence diagnostics', async () => {
    const env = await makeEnv();
    const invalidVersionPath = getCacheVersionPath(env, 'invalid-cache', '0.1.0');
    await fs.ensureDir(invalidVersionPath);
    const nonDirectoryEntryPath = getCacheVersionPath(env, 'file-entry', '0.1.0');
    await fs.outputFile(nonDirectoryEntryPath, 'not a directory\n', 'utf8');

    await expect(readCodexNativePluginState('invalid-cache', env)).resolves.toMatchObject({
      pluginInstalled: false,
      cacheStatus: 'invalid',
      invalidCachePaths: [invalidVersionPath],
      ignoredCacheEntries: [],
    });
    await expect(readCodexNativePluginState('file-entry', env)).resolves.toMatchObject({
      pluginInstalled: false,
      cacheStatus: 'invalid',
      invalidCachePaths: [],
      ignoredCacheEntries: [nonDirectoryEntryPath],
    });
    await expect(listCodexNativeEvidence(env)).resolves.toMatchObject([
      {
        pluginName: 'file-entry',
        pluginInstalled: false,
        cacheStatus: 'invalid',
        ignoredCacheEntries: [nonDirectoryEntryPath],
      },
      {
        pluginName: 'invalid-cache',
        pluginInstalled: false,
        cacheStatus: 'invalid',
        invalidCachePaths: [invalidVersionPath],
      },
    ]);
  });

  it('runs install post-check against both enabled config and active cache', async () => {
    const env = await makeEnv();
    const configPath = getConfigPath(env);

    await upsertCodexPluginEnabledFile(configPath, 'ready@aw', { enabled: true });
    await writeActiveCache(env, 'ready');
    await upsertCodexPluginEnabledFile(configPath, 'enabled-only@aw', { enabled: true });
    await writeActiveCache(env, 'cache-only');

    await expect(checkCodexNativeInstallPostCheck('ready', env)).resolves.toMatchObject({
      ok: true,
      state: {
        pluginEnabled: true,
        pluginInstalled: true,
      },
    });
    await expect(checkCodexNativeInstallPostCheck('enabled-only', env)).resolves.toMatchObject({
      ok: false,
      state: {
        pluginEnabled: true,
        pluginInstalled: false,
      },
    });
    await expect(checkCodexNativeInstallPostCheck('cache-only', env)).resolves.toMatchObject({
      ok: false,
      state: {
        pluginEnabled: false,
        pluginInstalled: true,
      },
    });
  });

  it('runs uninstall post-check against config entry removal and cache removal', async () => {
    const env = await makeEnv();
    const configPath = getConfigPath(env);

    await upsertCodexPluginEnabledFile(configPath, 'disabled-residue@aw', { enabled: false });
    await writeActiveCache(env, 'cache-residue');
    await fs.ensureDir(getCacheVersionPath(env, 'invalid-cache-residue', '0.1.0'));
    await writeActiveCache(env, 'ambiguous-cache-residue', '0.1.0');
    await writeActiveCache(env, 'ambiguous-cache-residue', '0.2.0');

    await expect(checkCodexNativeUninstallPostCheck('clean', env)).resolves.toMatchObject({
      ok: true,
      state: {
        configEntryPresent: false,
        pluginInstalled: false,
      },
    });
    await expect(checkCodexNativeUninstallPostCheck('disabled-residue', env)).resolves.toMatchObject({
      ok: false,
      state: {
        configEntryPresent: true,
        pluginEnabled: false,
        pluginInstalled: false,
      },
    });
    await expect(checkCodexNativeUninstallPostCheck('cache-residue', env)).resolves.toMatchObject({
      ok: false,
      state: {
        configEntryPresent: false,
        pluginInstalled: true,
      },
    });
    await expect(checkCodexNativeUninstallPostCheck('invalid-cache-residue', env)).resolves.toMatchObject({
      ok: false,
      state: {
        configEntryPresent: false,
        pluginInstalled: false,
        cacheStatus: 'invalid',
      },
    });
    await expect(checkCodexNativeUninstallPostCheck('ambiguous-cache-residue', env)).resolves.toMatchObject({
      ok: false,
      state: {
        configEntryPresent: false,
        pluginInstalled: false,
        cacheStatus: 'ambiguous',
      },
    });
  });

  it('allows marketplace cleanup only when no enabled config or active cache evidence remains', async () => {
    const env = await makeEnv();
    const configPath = getConfigPath(env);

    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: '/tmp/aw-home',
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, 'disabled-only@aw', { enabled: false });

    await expect(assessCodexMarketplaceCleanup(env)).resolves.toMatchObject({
      marketplaceConfigPresent: true,
      canCleanup: true,
      blockingEvidence: [],
    });

    await upsertCodexPluginEnabledFile(configPath, 'enabled-only@aw', { enabled: true });
    await writeActiveCache(env, 'cache-only');

    await expect(assessCodexMarketplaceCleanup(env)).resolves.toMatchObject({
      marketplaceConfigPresent: true,
      canCleanup: false,
      blockingEvidence: [
        {
          pluginName: 'cache-only',
          pluginInstalled: true,
        },
        {
          pluginName: 'enabled-only',
          pluginEnabled: true,
        },
      ],
    });
  });
});
