import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginManifestSource } from '../../src/types.js';
import {
  assertSafePluginConfigSegment,
  coercePluginConfigUpdates,
  createPluginConfigFormModel,
  patchPluginConfigStore,
  preflightRequiredPluginConfigs,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveAwProjectRoot,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  toCliConfigPromptOptions,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createManifest(pluginName = 'configurable-plugin'): PluginManifestSource {
  return {
    name: pluginName,
    version: '0.1.0',
    description: 'Config test plugin',
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
        enabled: {
          type: 'boolean',
          default: true,
        },
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin config store', () => {
  it('rejects unsafe plugin config path segments', () => {
    for (const value of ['', '.', '..', 'bad/name', 'bad\\name', '/abs', 'file://x', 'C:\\tmp']) {
      expect(() => assertSafePluginConfigSegment(value)).toThrow();
    }

    expect(assertSafePluginConfigSegment('good-plugin')).toBe('good-plugin');
  });

  it('stores user and project config, tracks sources, redacts sensitive values, and preserves unknown keys', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(cwd);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    const manifest = createManifest();

    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'user-secret',
        legacy: 'keep-me',
      },
    });
    await patchPluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
      updates: { retries: 2 },
    });
    await patchPluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd,
      env,
      updates: { token: 'project-secret' },
    });

    const effective = await resolveEffectivePluginConfig({
      manifest,
      cwd,
      env,
    });

    expect(effective.projectRoot).toBe(repoRoot);
    expect(effective.values).toMatchObject({
      token: 'project-secret',
      retries: 2,
      mode: 'safe',
      enabled: true,
    });
    expect(effective.redactedValues.token).toBe('[redacted]');
    expect(effective.sources).toMatchObject({
      token: 'project',
      retries: 'user',
      mode: 'default',
      enabled: 'default',
    });
    expect(effective.ignoredUnknownKeys).toEqual([{ scope: 'user', key: 'legacy' }]);
    await expect(readPluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        legacy: 'keep-me',
      },
    });

    await resetPluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd,
      env,
    });
    await expect(resolveEffectivePluginConfig({ manifest, cwd, env })).resolves.toMatchObject({
      values: {
        token: 'user-secret',
      },
      sources: {
        token: 'user',
      },
    });
  });

  it('coerces schema values, enforces number bounds, and writes POSIX stores as 0600 best effort', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const manifest = createManifest();

    await expect(coercePluginConfigUpdates({
      schema: manifest.config!.schema,
      cwd,
      updates: {
        retries: '4',
      },
    })).rejects.toThrow('less than or equal to 3');

    const updates = await coercePluginConfigUpdates({
      schema: manifest.config!.schema,
      cwd,
      updates: {
        retries: '3',
        enabled: 'false',
        mode: 'fast',
      },
    });
    await patchPluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
      updates,
    });

    await expect(readPluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        retries: 3,
        enabled: false,
        mode: 'fast',
      },
    });

    if (process.platform !== 'win32') {
      const mode = (await fs.stat(resolvePluginConfigStorePath({
        pluginName: manifest.name,
        scope: 'user',
        cwd,
        env,
      }))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('resolves file and directory values against the AW project root and revalidates them on read', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const repoRoot = path.join(root, 'repo');
    const subdir = path.join(repoRoot, 'packages', 'app');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(subdir);
    await fs.outputFile(path.join(repoRoot, 'config.json'), '{}\n');
    await fs.ensureDir(path.join(repoRoot, 'data'));
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const manifest = createManifest();
    manifest.config!.schema.configFile = { type: 'file', required: true };
    manifest.config!.schema.dataDir = { type: 'directory', required: true };

    const fromRepoRoot = await coercePluginConfigUpdates({
      schema: manifest.config!.schema,
      cwd: repoRoot,
      updates: {
        token: 'secret',
        configFile: 'config.json',
        dataDir: 'data',
      },
    });
    const fromSubdir = await coercePluginConfigUpdates({
      schema: manifest.config!.schema,
      cwd: subdir,
      updates: {
        configFile: 'config.json',
        dataDir: 'data',
      },
    });

    expect(fromSubdir.configFile).toBe(fromRepoRoot.configFile);
    expect(fromSubdir.dataDir).toBe(fromRepoRoot.dataDir);

    await patchPluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd: subdir,
      env,
      updates: fromRepoRoot,
    });
    await fs.remove(path.join(repoRoot, 'config.json'));

    const effective = await resolveEffectivePluginConfig({
      manifest,
      cwd: subdir,
      env,
    });
    expect(effective.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'invalid-config',
        key: 'configFile',
      }),
    ]));

    await expect(patchPluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd: subdir,
      env,
      updates: {},
      removeKeys: ['configFile'],
    })).resolves.toMatchObject({
      removedKeys: ['configFile'],
    });
  });

  it('drops lower-priority invalid config issues when a higher-priority layer provides a valid value', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const repoRoot = path.join(root, 'repo');
    const subdir = path.join(repoRoot, 'packages', 'app');
    const validConfigFile = path.join(repoRoot, 'project-config.json');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(subdir);
    await fs.outputFile(validConfigFile, '{}\n');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const manifest = createManifest();
    manifest.config!.schema = {
      configFile: { type: 'file', required: true },
    };

    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd: subdir,
      env,
      values: {
        configFile: path.join(repoRoot, 'missing-config.json'),
      },
    });
    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd: subdir,
      env,
      values: {
        configFile: validConfigFile,
      },
    });

    const effective = await resolveEffectivePluginConfig({
      manifest,
      cwd: subdir,
      env,
    });

    await expect(fs.realpath(validConfigFile)).resolves.toBe(effective.values.configFile);
    expect(effective.sources.configFile).toBe('project');
    expect(effective.issues).toEqual([]);
  });

  it('falls back project config root to normalized cwd outside repos and workspaces', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const cwd = path.join(root, 'plain-dir');
    await fs.ensureDir(cwd);

    expect(resolveAwProjectRoot(cwd)).toBe(cwd);
    expect(resolvePluginConfigStorePath({
      pluginName: 'configurable-plugin',
      scope: 'project',
      cwd,
    })).toBe(path.join(
      cwd,
      '.agent-workflows',
      'plugin-config',
      'configurable-plugin',
      'config.json',
    ));
  });

  it('builds a reusable config form model without exposing sensitive current values', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const manifest = createManifest();

    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'super-secret',
        retries: 2,
      },
    });

    const effective = await resolveEffectivePluginConfig({
      manifest,
      cwd,
      env,
    });
    const formModel = createPluginConfigFormModel({
      manifest,
      effective,
      initialScope: 'user',
    });
    const promptOptions = toCliConfigPromptOptions(formModel);

    expect(formModel.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'token',
        sensitive: true,
        configured: true,
        currentValue: undefined,
      }),
      expect.objectContaining({
        key: 'retries',
        configured: true,
        currentValue: 2,
      }),
    ]));
    expect(promptOptions.currentValues).toEqual({
      retries: 2,
      mode: 'safe',
      enabled: true,
    });
    expect(promptOptions.configuredKeys).toEqual(expect.arrayContaining(['token', 'retries', 'mode', 'enabled']));
    expect(promptOptions.currentValues?.token).toBeUndefined();
  });

  it('deduplicates required config preflight by plugin and schema identity without prompting or writing config', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const manifest = createManifest();
    const context = {
      env,
    };

    await expect(preflightRequiredPluginConfigs({
      targets: [
        { manifest, schemaSourceIdentity: 'same-manifest' },
        { manifest, schemaSourceIdentity: 'same-manifest' },
      ],
      cwd,
      defaultScope: 'user',
      context,
      interactive: true,
    })).rejects.toThrow(
      'configurable-plugin requires valid AW config before install/upgrade: token. ' +
        'Run `aw config set configurable-plugin token <value> -s user`, or open `aw` to complete setup.',
    );
    await expect(fs.pathExists(path.join(env.AW_HOME!, 'plugin-config', manifest.name, 'config.json'))).resolves.toBe(false);
  });
});
