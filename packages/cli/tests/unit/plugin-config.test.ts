import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginManifestSource, PluginMeta } from '../../src/types.js';
import { writeInstallRecordFileAt } from '../../src/install-state/facade.js';
import {
  createHistoricalLifecycleRuntimePaths,
  getInstallRecordPath,
} from '../../src/install-state/paths.js';
import {
  assertSafePluginConfigSegment,
  coercePluginConfigUpdates,
  createPluginConfigFormModel,
  patchPluginConfigStore,
  preflightRequiredPluginConfigs,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveAwProjectRoot,
  resolveConfigReadV2,
  resolveEffectivePluginConfig,
  resolveProjectArtifactRenderConfig,
  resolveProjectScopedPluginConfigView,
  resolveProjectLocalPluginConfigView,
  resolvePluginConfigStorePath,
  toCliConfigPromptOptions,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';
import { expectPathFenceViolation } from '../helpers/test-isolation.js';
import {
  getSourceTestRepositoryCwd,
  runWithCurrentRepositoryCwdAsReadOnly,
} from '../setup/test-isolation.js';

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
        authentication: 'ON_INSTALL',
      },
    },
    compatibility: {
      aw: {
        minVersion: '0.0.0',
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

async function materializePlugin(root: string, manifest: PluginManifestSource): Promise<PluginMeta> {
  const pluginRoot = path.join(root, `${manifest.name}-${manifest.version}`);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  return {
    rootDir: pluginRoot,
    manifestPath,
    manifest,
  };
}

async function writeHistoricalInstallRecord(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectKey?: string;
}): Promise<void> {
  const location = options.scope === 'project'
    ? {
        plugin: options.plugin.manifest.name,
        platform: options.platform,
        scope: 'project' as const,
        projectKey: options.projectKey ?? '',
      }
    : {
        plugin: options.plugin.manifest.name,
        platform: options.platform,
        scope: 'user' as const,
      };
  const recordPath = getInstallRecordPath(options.cwd, location, options.env);
  const recordId = path.basename(recordPath, '.json');
  const sourceManifestDigest = await calculateFileDigest(options.plugin.manifestPath);
  const sourceBundleFingerprint = await calculatePluginBundleFingerprint(options.plugin.rootDir);
  const lifecyclePaths = createHistoricalLifecycleRuntimePaths({
    cwd: options.cwd,
    location,
    recordId,
    manifestDigest: sourceManifestDigest,
    bundleFingerprint: sourceBundleFingerprint,
    nonce: `${options.platform}-${options.scope}`,
    env: options.env,
    manifestRelativePath: '.agents-plugin/plugin.json',
  });
  await fs.copy(options.plugin.rootDir, lifecyclePaths.bundleRoot);
  const manifestDigest = await calculateFileDigest(lifecyclePaths.manifestPath);
  const bundleFingerprint = await calculatePluginBundleFingerprint(lifecyclePaths.bundleRoot);
  await writeInstallRecordFileAt(recordPath, {
    version: 2,
    recordId,
    record: {
      pluginName: options.plugin.manifest.name,
      platform: options.platform,
      scope: options.scope,
      ...(options.scope === 'project' ? { projectKey: options.projectKey ?? '' } : {}),
      installedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      source: {
        pluginVersion: options.plugin.manifest.version,
        manifestDigest,
        bundleFingerprint,
      },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      lifecycle: {
        runtimeRoot: lifecyclePaths.runtimeRoot,
        bundleRoot: lifecyclePaths.bundleRoot,
        manifestPath: lifecyclePaths.manifestPath,
        pluginVersion: options.plugin.manifest.version,
        sourceManifestDigest: manifestDigest,
        bundleFingerprint,
        events: ['install'],
        createdAt: '2026-05-18T00:00:00.000Z',
      },
      artifacts: [],
      dependencyEdges: [],
    },
  }, { env: options.env });
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
    expect(effective.ignoredUnknownKeys).toEqual([{
      scope: 'user',
      projectLayer: 'shared',
      source: 'user',
      key: 'legacy',
    }]);
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

  it('layers project shared and project local config separately, and keeps repo-visible artifact config on shared truth only', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(cwd);
    await fs.outputFile(path.join(repoRoot, 'local-config.json'), '{}\n');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const manifest = createManifest();
    manifest.config!.schema.token.required = false;
    manifest.config!.schema.configFile = { type: 'file', required: false };

    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'user-secret',
      },
    });
    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        mode: 'fast',
      },
    });
    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      projectLayer: 'local',
      cwd,
      env,
      values: {
        token: 'local-secret',
        configFile: 'local-config.json',
      },
    });

    const effective = await resolveEffectivePluginConfig({
      manifest,
      cwd,
      env,
    });
    expect(effective.values).toMatchObject({
      token: 'local-secret',
      mode: 'fast',
    });
    expect(effective.sources).toMatchObject({
      token: 'projectLocal',
      mode: 'project',
    });
    expect(effective.stores.project.path).toContain('/plugin-config/');
    expect(effective.stores.projectLocal.path).toContain('/plugin-config.local/');

    const artifactConfig = await resolveProjectArtifactRenderConfig({
      manifest,
      cwd,
      env,
    });
    expect(artifactConfig.values).toMatchObject({
      mode: 'fast',
      enabled: true,
      retries: 1,
    });
    expect(artifactConfig.values.token).toBeUndefined();
    expect(artifactConfig.values.configFile).toBeUndefined();
    expect(artifactConfig.sources.mode).toBe('project');
    expect(artifactConfig.sources.token).toBe('missing');
    expect(artifactConfig.boundaryIssues).toEqual([]);

    const localOnly = await resolveProjectLocalPluginConfigView({
      manifest,
      cwd,
      env,
    });
    expect(localOnly.values).toMatchObject({
      token: 'local-secret',
    });
    expect(localOnly.sources).toMatchObject({
      token: 'projectLocal',
      mode: 'missing',
    });
    expect(localOnly.repoVisibleArtifactConfig.values).toMatchObject({
      mode: 'fast',
    });

    const projectView = await resolveProjectScopedPluginConfigView({
      manifest,
      cwd,
      env,
    });
    expect(projectView.entries.token).toMatchObject({
      userValue: '[redacted]',
      projectLocalValue: '[redacted]',
      effectiveValue: '[redacted]',
      effectiveSource: 'projectLocal',
      repoVisibleArtifactValue: undefined,
      repoVisibleArtifactSource: 'missing',
      repoVisibleArtifactUsesSharedTruth: true,
    });
    expect(projectView.entries.mode).toMatchObject({
      defaultValue: 'safe',
      projectSharedValue: 'fast',
      effectiveValue: 'fast',
      effectiveSource: 'project',
      repoVisibleArtifactValue: 'fast',
      repoVisibleArtifactSource: 'project',
    });
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

  it('excludes path-type config from project artifact render config and reports portable-boundary issues', async () => {
    const root = await makeTempRoot('aw-plugin-config-');
    const repoRoot = path.join(root, 'repo');
    const cwd = repoRoot;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.outputFile(path.join(repoRoot, 'config.json'), '{}\n');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const manifest = createManifest();
    manifest.config!.schema.configFile = {
      type: 'file',
      required: true,
      default: 'config.json',
    };

    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        mode: 'fast',
        configFile: 'config.json',
      },
    });

    const artifactConfig = await resolveProjectArtifactRenderConfig({
      manifest,
      cwd,
      env,
      refreshKeys: ['configFile'],
    });

    expect(artifactConfig.values.mode).toBe('fast');
    expect(artifactConfig.values.configFile).toBeUndefined();
    expect(artifactConfig.boundaryIssues.map((issue) => issue.reason)).toEqual(expect.arrayContaining([
      'pathTypeDefault',
      'pathTypeRequired',
      'sharedPathValue',
      'pathTypeRefreshKey',
    ]));
    expect(artifactConfig.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'invalid-config',
        key: 'configFile',
      }),
    ]));
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

  it('allows reading project config stores from a read-only repo fixture but blocks writes there', async () => {
    const repositoryCwd = resolveAwProjectRoot(getSourceTestRepositoryCwd());
    await runWithCurrentRepositoryCwdAsReadOnly(() => {
      const repositoryCwd = process.cwd();
      const projectRoot = resolveAwProjectRoot(repositoryCwd);
      const sharedPath = resolvePluginConfigStorePath({
        pluginName: 'configurable-plugin',
        scope: 'project',
        cwd: repositoryCwd,
        access: 'read',
      });
      const localPath = resolvePluginConfigStorePath({
        pluginName: 'configurable-plugin',
        scope: 'project',
        projectLayer: 'local',
        cwd: repositoryCwd,
        access: 'read',
      });

      expect(sharedPath).toBe(path.join(
        projectRoot,
        '.agent-workflows',
        'plugin-config',
        'configurable-plugin',
        'config.json',
      ));
      expect(localPath).toBe(path.join(
        projectRoot,
        '.agent-workflows',
        'plugin-config.local',
        'configurable-plugin',
        'config.json',
      ));

      expectPathFenceViolation(
        () => resolvePluginConfigStorePath({
          pluginName: 'configurable-plugin',
          scope: 'project',
          cwd: repositoryCwd,
          access: 'write',
        }),
        {
          access: 'write',
          path: sharedPath,
          source: 'project shared plugin config store (.agent-workflows/plugin-config)',
          reason: 'writeToReadOnlyRoot',
          conflictingRootPath: projectRoot,
          recommendedFixIncludes: 'withSafeTestCwd()',
        },
      );
      expectPathFenceViolation(
        () => resolvePluginConfigStorePath({
          pluginName: 'configurable-plugin',
          scope: 'project',
          projectLayer: 'local',
          cwd: repositoryCwd,
          access: 'write',
        }),
        {
          access: 'write',
          path: localPath,
          source: 'project local plugin config store (.agent-workflows/plugin-config.local)',
          reason: 'writeToReadOnlyRoot',
          conflictingRootPath: projectRoot,
          recommendedFixIncludes: 'withSafeTestCwd()',
        },
      );
    }, { repositoryCwd });
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

  it('prefers installed historical schema over the current catalog manifest when reading config', async () => {
    const root = await makeTempRoot('aw-plugin-config-historical-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);

    const historicalManifest = createManifest('configurable-plugin');
    historicalManifest.version = '0.1.0';
    delete historicalManifest.config!.schema.enabled;
    const currentManifest = createManifest('configurable-plugin');
    currentManifest.version = '0.2.0';
    currentManifest.config!.schema.newField = {
      type: 'string',
      default: 'catalog-only',
    };

    const historicalPlugin = await materializePlugin(root, historicalManifest);
    const currentPlugin = await materializePlugin(root, currentManifest);
    await Promise.all([
      writeHistoricalInstallRecord({
        cwd,
        env,
        plugin: historicalPlugin,
        platform: 'codex',
        scope: 'user',
      }),
      writeHistoricalInstallRecord({
        cwd,
        env,
        plugin: historicalPlugin,
        platform: 'claude',
        scope: 'user',
      }),
    ]);
    await writePluginConfigStore({
      pluginName: historicalManifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'secret',
      },
    });

    const resolved = await resolveConfigReadV2({
      pluginName: historicalManifest.name,
      plugin: currentPlugin,
      scope: 'user',
      projectLayer: 'shared',
      cwd,
      env,
    });

    expect(resolved.schema).toMatchObject({
      source: 'installedHistorical',
      pluginVersion: '0.1.0',
    });
    expect(resolved.fields.some((field) => field.key === 'newField')).toBe(false);
    expect(resolved.fields.some((field) => field.key === 'enabled')).toBe(false);
    expect(resolved.fields.some((field) => field.key === 'token')).toBe(true);
  });

  it('fails with configSchemaConflict when installed consumers disagree on schema identity', async () => {
    const root = await makeTempRoot('aw-plugin-config-conflict-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);

    const codexManifest = createManifest('configurable-plugin');
    codexManifest.version = '0.1.0';
    const claudeManifest = createManifest('configurable-plugin');
    claudeManifest.version = '0.2.0';
    claudeManifest.config!.schema.newField = {
      type: 'string',
      default: 'conflict',
    };

    const codexPlugin = await materializePlugin(root, codexManifest);
    const claudePlugin = await materializePlugin(root, claudeManifest);
    await Promise.all([
      writeHistoricalInstallRecord({
        cwd,
        env,
        plugin: codexPlugin,
        platform: 'codex',
        scope: 'user',
      }),
      writeHistoricalInstallRecord({
        cwd,
        env,
        plugin: claudePlugin,
        platform: 'claude',
        scope: 'user',
      }),
    ]);

    await expect(resolveConfigReadV2({
      pluginName: 'configurable-plugin',
      scope: 'user',
      projectLayer: 'shared',
      cwd,
      env,
    })).rejects.toThrow('configSchemaConflict');
  });
});
