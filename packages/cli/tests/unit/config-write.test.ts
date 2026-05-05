import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/artifact-refresh.js', () => ({
  refreshArtifactsAfterConfigWrite: vi.fn(async (options: { changedKeys?: string[]; resetAllTrackedKeys?: boolean }) => ({
    attempted: options.resetAllTrackedKeys === true || (options.changedKeys?.length ?? 0) > 0,
    status: 'succeeded' as const,
    triggerKeys: [...(options.changedKeys ?? [])],
    artifacts: [],
  })),
}));

import { refreshArtifactsAfterConfigWrite } from '../../src/utils/artifact-refresh.js';
import type { PluginMeta } from '../../src/types.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
} from '../../src/utils/plugin-config-write.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createPlugin(pluginName = 'configurable-plugin'): PluginMeta {
  return {
    rootDir: '/tmp/plugin',
    manifestPath: '/tmp/plugin/.agents-plugin/plugin.json',
    manifest: {
      name: pluginName,
      version: '0.1.0',
      description: 'Config write test plugin',
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
      config: {
        schema: {
          token: {
            type: 'string',
            required: true,
            sensitive: true,
          },
          retries: {
            type: 'number',
            default: 1,
            min: 0,
            max: 3,
          },
          mode: {
            type: 'enum',
            values: ['fast', 'safe'],
            default: 'safe',
          },
        },
      },
    },
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin config write helper', () => {
  it('fails atomically when any updated field is invalid', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = createPlugin();

    await expect(applyPluginConfigWrite({
      plugin,
      scope: 'user',
      cwd,
      env,
      request: {
        updates: {
          token: 'secret',
          retries: '4',
        },
      },
    })).rejects.toThrow('less than or equal to 3');

    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    }))).resolves.toBe(false);
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('patches once, refreshes once, preserves unknown keys, and does not copy another layer into the target store', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(cwd);
    const plugin = createPlugin();

    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'user-secret',
      },
    });
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        mode: 'safe',
        legacyProject: 'keep-me',
      },
    });

    const receipt = await applyPluginConfigWrite({
      plugin,
      scope: 'project',
      cwd,
      env,
      request: {
        updates: {
          retries: '2',
        },
        removeKeys: ['mode'],
      },
    });

    expect(receipt).toMatchObject({
      plugin: plugin.manifest.name,
      scope: 'project',
      updatedKeys: ['retries'],
      removedKeys: ['mode'],
      effective: {
        values: {
          token: '[redacted]',
          retries: 2,
        },
      },
      artifactRefresh: {
        attempted: true,
        status: 'succeeded',
        triggerKeys: ['retries', 'mode'],
      },
    });
    expect(refreshArtifactsAfterConfigWrite).toHaveBeenCalledTimes(1);
    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        retries: 2,
        legacyProject: 'keep-me',
      },
    });
    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        token: 'user-secret',
      },
    });
  });

  it('treats removing a missing key as a no-op without creating an empty store or refreshing', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = createPlugin();

    const receipt = await applyPluginConfigWrite({
      plugin,
      scope: 'user',
      cwd,
      env,
      request: {
        removeKeys: ['mode'],
      },
    });

    expect(receipt.updatedKeys).toEqual([]);
    expect(receipt.removedKeys).toEqual([]);
    expect(receipt.artifactRefresh).toMatchObject({
      attempted: false,
      status: 'skipped',
      triggerKeys: [],
    });
    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    }))).resolves.toBe(false);
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('supports raw-store reset when the current catalog entry is missing and refuses unsafe plugin names', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);

    await writePluginConfigStore({
      pluginName: 'missing-plugin',
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'old-secret',
      },
    });

    const receipt = await resetPluginConfigWithHelper({
      pluginName: 'missing-plugin',
      scope: 'user',
      cwd,
      env,
    });
    expect(receipt).toMatchObject({
      plugin: 'missing-plugin',
      existed: true,
      deleted: true,
      artifactRefresh: {
        attempted: false,
        status: 'skipped',
      },
    });
    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName: 'missing-plugin',
      scope: 'user',
      cwd,
      env,
    }))).resolves.toBe(false);

    const unsafeRoot = await makeTempRoot('aw-config-write-');
    const unsafeCwd = path.join(unsafeRoot, 'repo');
    const unsafeEnv = { AW_HOME: path.join(unsafeRoot, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(unsafeCwd);
    const untouchedPath = path.join(unsafeEnv.AW_HOME!, 'plugin-config', 'safe-plugin', 'config.json');
    await fs.outputJson(untouchedPath, { token: 'keep' }, { spaces: 2 });

    await expect(resetPluginConfigWithHelper({
      pluginName: '../safe-plugin',
      scope: 'user',
      cwd: unsafeCwd,
      env: unsafeEnv,
    })).rejects.toThrow('Invalid plugin config segment');
    await expect(fs.readJson(untouchedPath)).resolves.toEqual({ token: 'keep' });
  });
});
