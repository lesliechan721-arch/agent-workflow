import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import {
  applyBuiltInConfigWrite,
  applyPluginConfigWrite,
  replayBuiltInConfigRuntime,
  resetPluginConfigWithHelper,
} from '../../src/utils/plugin-config-write.js';
import {
  writeDynamicArtifactDiagnosticCacheAt,
  writeInstallRecordFileAt,
  writeProjectArtifactIdentityFileAt,
} from '../../src/install-state/facade.js';
import {
  createProjectArtifactSharedLocator,
  createHistoricalLifecycleRuntimePaths,
  getDiagnosticCachePath,
  getInstallRecordPath,
  getProjectArtifactSharedIdentityPath,
} from '../../src/install-state/paths.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';
import * as pluginConfigModule from '../../src/utils/plugin-config.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { resolveCodexPaths, resolveCodexProjectKey } from '../../src/utils/paths.js';
import * as skillTriggerModule from '../../src/utils/skill-trigger-preferences.js';
import { writeTrackingManifest } from '../../src/utils/tracking.js';
import {
  TestPathFenceError,
  normalizeAbsolutePath,
} from '../helpers/path-fence.js';
import {
  getSourceTestRepositoryCwd,
  registerCurrentTestWritableStateRoot,
  runWithCurrentRepositoryCwdAsReadOnly,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

interface ExpectedAsyncPathFenceViolation {
  access: 'read' | 'write';
  path: string;
  source: string;
  reason?: 'outsideRegisteredRoots' | 'writeToReadOnlyRoot';
  conflictingRootPath?: string;
  recommendedFixIncludes?: string;
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function initRepo(repoRoot: string): Promise<void> {
  await fs.ensureDir(repoRoot);
  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot });
}

function createPlugin(
  pluginName = 'configurable-plugin',
  options: { withProjectDynamicTarget?: boolean; withUserDynamicTarget?: boolean } = {},
): PluginMeta {
  const artifactTargets = [
    ...(options.withProjectDynamicTarget
      ? [{
          id: 'project-instructions',
          platform: 'codex' as const,
          target: 'codex.developerInstructionsBlock' as const,
          scopes: ['project' as const],
          states: ['present' as const],
          refreshKeys: ['mode'],
          requiresCodexProjectConfig: true,
        }]
      : []),
    ...(options.withUserDynamicTarget
      ? [{
          id: 'user-instructions',
          platform: 'codex' as const,
          target: 'codex.developerInstructionsBlock' as const,
          scopes: ['user' as const],
          states: ['present' as const],
          refreshKeys: ['mode'],
        }]
      : []),
  ];
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
        },
      },
      ...(artifactTargets.length > 0
        ? {
            artifacts: {
              targets: artifactTargets,
            },
          }
        : {}),
    },
  };
}

async function materializePlugin(root: string, plugin: PluginMeta): Promise<PluginMeta> {
  const pluginRoot = path.join(root, 'plugin');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(manifestPath, plugin.manifest, { spaces: 2 });
  await fs.outputFile(path.join(pluginRoot, 'index.js'), 'export {};\n');
  return {
    ...plugin,
    rootDir: pluginRoot,
    manifestPath,
  };
}

async function materializeSkillTriggerPluginForConfigTest(root: string, pluginName: string): Promise<PluginMeta> {
  const basePlugin = createPlugin(pluginName);
  const plugin = await materializePlugin(root, {
    ...basePlugin,
    manifest: {
      ...basePlugin.manifest,
      skills: './skills',
      skillTriggers: {
        commit: {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      },
      config: undefined,
    },
  } as PluginMeta);
  await fs.outputFile(path.join(plugin.rootDir, 'skills', 'commit', 'SKILL.md'), '# commit\n');
  await fs.outputFile(
    path.join(plugin.rootDir, 'skills', 'commit', 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: true\n',
  );
  return plugin;
}

function createAgentVersionRunner(options: {
  codex?: string;
  claude?: string;
} = {}): NativeCliRunner {
  return async (invocation) => {
    if (invocation.args.length !== 1 || invocation.args[0] !== '--version') {
      throw new Error(`Unexpected native CLI invocation in config-write.test.ts: ${invocation.command} ${invocation.args.join(' ')}`.trim());
    }
    if (invocation.command === 'codex') {
      return { exitCode: 0, stdout: options.codex ?? 'codex-cli 0.131.0', stderr: '' };
    }
    if (invocation.command === 'claude') {
      return { exitCode: 0, stdout: options.claude ?? '2.1.88 (Claude Code)', stderr: '' };
    }
    throw new Error(`Unexpected native CLI command: ${invocation.command}`);
  };
}

async function writeUserInstallRecordForConfigTest(options: {
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
}): Promise<void> {
  const location = {
    plugin: options.plugin.manifest.name,
    platform: 'codex' as const,
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
    nonce: `test-${options.plugin.manifest.name}`,
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
      platform: 'codex',
      scope: 'user',
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

async function writeProjectInstallRecordForConfigTest(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
}): Promise<{ projectKey: string }> {
  const projectKey = await resolveCodexProjectKey(options.cwd);
  const location = {
    plugin: options.plugin.manifest.name,
    platform: 'codex' as const,
    scope: 'project' as const,
    projectKey,
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
    nonce: `test-project-${options.plugin.manifest.name}`,
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
      platform: 'codex',
      scope: 'project',
      projectKey,
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
  return { projectKey };
}

async function writeUserDynamicTrackingForConfigTest(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
}): Promise<void> {
  await writeTrackingManifest(resolveCodexPaths(options.cwd, 'user', options.env).trackingDir, {
    version: 1,
    plugins: {
      [options.plugin.manifest.name]: {
        name: options.plugin.manifest.name,
        generatedAt: '2026-05-18T00:00:00.000Z',
        artifacts: [{
          path: path.join(options.env.AW_HOME!, 'runtime', options.plugin.manifest.name, 'instructions.md'),
          kind: 'instruction',
          platform: 'codex',
          id: 'user-instructions',
          target: 'codex.developerInstructionsBlock',
          state: 'present',
          refreshKeys: ['mode'],
          configDigest: 'sha256:old-config',
          contentDigest: 'sha256:old-content',
        }],
      },
    },
  });
}

async function writeUserDynamicDiagnosticCacheForConfigTest(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
}): Promise<void> {
  const location = {
    plugin: options.plugin.manifest.name,
    platform: 'codex' as const,
    scope: 'user' as const,
  };
  const cachePath = getDiagnosticCachePath(options.cwd, location, options.env);
  await writeDynamicArtifactDiagnosticCacheAt(cachePath, {
    version: 1,
    recordId: path.basename(cachePath, '.json'),
    location,
    updatedAt: '2026-05-18T00:00:00.000Z',
    artifacts: [{
      id: 'user-instructions',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      refreshKeys: ['mode'],
      configDigest: 'sha256:old-config',
      contentDigest: 'sha256:old-content',
    }],
  });
}

async function writeAdoptableProjectIdentityForConfigTest(options: {
  cwd: string;
  repoRoot: string;
  plugin: PluginMeta;
}): Promise<void> {
  const repoArtifactPath = path.join(options.repoRoot, '.codex', 'config.toml');
  await fs.outputFile(repoArtifactPath, '# existing\n');
  const sourceManifestDigest = await calculateFileDigest(options.plugin.manifestPath);
  const sourceBundleFingerprint = await calculatePluginBundleFingerprint(options.plugin.rootDir);
  const locator = createProjectArtifactSharedLocator({
    plugin: options.plugin.manifest.name,
    platform: 'codex',
    repoRoot: options.repoRoot,
    projectRoot: options.repoRoot,
  });
  const identityPath = getProjectArtifactSharedIdentityPath({ repoRoot: options.repoRoot, locator });
  await writeProjectArtifactIdentityFileAt(identityPath, {
    version: 1,
    sharedIdentityId: path.basename(identityPath, '.json'),
    locator,
    source: {
      pluginVersion: options.plugin.manifest.version,
      manifestDigest: sourceManifestDigest,
      bundleFingerprint: sourceBundleFingerprint,
    },
    generatedAt: '2026-05-18T00:00:00.000Z',
    artifacts: [{
      kind: 'instruction',
      platform: 'codex',
      path: '.codex/config.toml',
      id: 'project-instructions',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
    }],
  });
}

async function expectAsyncPathFenceViolation(
  action: () => Promise<unknown>,
  expected: ExpectedAsyncPathFenceViolation,
): Promise<TestPathFenceError> {
  let caughtError: unknown;

  try {
    await action();
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(TestPathFenceError);
  const pathFenceError = caughtError as TestPathFenceError;
  expect(pathFenceError.details.access).toBe(expected.access);
  expect(pathFenceError.details.source).toBe(expected.source);
  expect(pathFenceError.details.normalizedUnsafePath).toBe(normalizeAbsolutePath(expected.path));

  if (expected.reason) {
    expect(pathFenceError.details.reason).toBe(expected.reason);
  }
  if (expected.conflictingRootPath) {
    expect(pathFenceError.details.conflictingRoot?.path).toBe(normalizeAbsolutePath(expected.conflictingRootPath));
  }
  if (expected.recommendedFixIncludes) {
    expect(pathFenceError.details.recommendedFix).toContain(expected.recommendedFixIncludes);
  }

  return pathFenceError;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin config write helper', () => {
  it('fails atomically when any updated field is invalid', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = createPlugin('fresh-config-plugin');

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

  it('writes built-in SkillTrigger values into the reserved namespace and returns per-target apply results', async () => {
    const root = await makeTempRoot('aw-config-write-built-in-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);

    const basePlugin = createPlugin('skill-plugin');
    const plugin = await materializePlugin(root, {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        skills: './skills',
        skillTriggers: {
          commit: {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        },
        config: undefined,
      },
    } as PluginMeta);
    await fs.outputFile(path.join(plugin.rootDir, 'skills', 'commit', 'SKILL.md'), '# commit\n');
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'commit', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );

    vi.spyOn(localMarketplaceModule, 'readInstalledLedger').mockResolvedValue({
      ledgerState: { status: 'available' },
      plugins: {
        [plugin.manifest.name]: {
          platforms: {
            codex: {
              userScope: {
                managed: true,
              },
            },
            claude: {
              userScope: {
                managed: true,
              },
            },
          },
        },
      },
    } as never);
    vi.spyOn(skillTriggerModule, 'materializeSkillTriggerPreference').mockResolvedValue({
      committed: false,
      warnings: [],
      summary: {
        status: 'patched',
        preference: 'manual',
        patchedSkills: [],
        skippedSkills: [],
        generatedArtifacts: [],
      },
      rollbackHandle: {
        committed: false,
        backupSkillsRoot: null,
        operations: [],
      },
    } as never);
    vi.spyOn(skillTriggerModule, 'commitMaterializedSkillTriggerPreference').mockResolvedValue(undefined);

    const receipt = await applyBuiltInConfigWrite({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'user',
      cwd,
      env,
      key: 'aw.skillTriggers.commit.trigger',
      action: 'set',
      value: 'manual',
    });

    expect(receipt.affectedFields).toEqual([expect.objectContaining({
      key: 'aw.skillTriggers.commit.trigger',
      kind: 'builtIn',
      reserved: true,
      action: 'set',
      scope: 'user',
    })]);
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: {
          pluginName: plugin.manifest.name,
          platform: 'codex',
          scope: 'user',
        },
        action: 'configApply',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: plugin.manifest.name,
          platform: 'claude',
          scope: 'user',
        },
        action: 'configApply',
        state: 'completed',
      }),
    ]));
    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        $aw: {
          skillTriggers: {
            commit: {
              trigger: 'manual',
            },
          },
        },
      },
    });
  });

  it('keeps project-scope built-in SkillTrigger writes config-only when the project target is not installed', async () => {
    const root = await makeTempRoot('aw-config-write-project-built-in-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);

    const basePlugin = createPlugin('project-skill-plugin');
    const plugin = await materializePlugin(root, {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        skills: './skills',
        skillTriggers: {
          commit: {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        },
        config: undefined,
      },
    } as PluginMeta);
    await fs.outputFile(path.join(plugin.rootDir, 'skills', 'commit', 'SKILL.md'), '# commit\n');
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'commit', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );

    const materializeSpy = vi.spyOn(skillTriggerModule, 'materializeSkillTriggerPreference').mockResolvedValue({
      committed: false,
      warnings: [],
      summary: {
        status: 'patched',
        preference: 'manual',
        patchedSkills: [],
        skippedSkills: [],
        generatedArtifacts: [],
      },
      rollbackHandle: {
        committed: false,
        backupSkillsRoot: null,
        operations: [],
      },
    } as never);
    vi.spyOn(skillTriggerModule, 'commitMaterializedSkillTriggerPreference').mockResolvedValue(undefined);

    const receipt = await applyBuiltInConfigWrite({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'project',
      cwd,
      env,
      key: 'aw.skillTriggers.commit.trigger',
      action: 'set',
      value: 'manual',
    });

    expect(receipt.targetResults).toEqual([]);
    expect(materializeSpy).not.toHaveBeenCalled();
    await expect(fs.pathExists(path.join(repoRoot, '.agents', 'skills'))).resolves.toBe(false);
    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        $aw: {
          skillTriggers: {
            commit: {
              trigger: 'manual',
            },
          },
        },
      },
    });
  });

  it('replays project-scope Codex SkillTrigger runtime for an installed project target', async () => {
    const root = await makeTempRoot('aw-config-write-project-built-in-installed-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);

    const basePlugin = createPlugin('installed-project-skill-plugin');
    const plugin = await materializePlugin(root, {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        skills: './skills',
        skillTriggers: {
          commit: {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        },
        config: undefined,
      },
    } as PluginMeta);
    await fs.outputFile(path.join(plugin.rootDir, 'skills', 'commit', 'SKILL.md'), '# commit\n');
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'commit', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    const { projectKey } = await writeProjectInstallRecordForConfigTest({ cwd, env, plugin });

    const materializeSpy = vi.spyOn(skillTriggerModule, 'materializeSkillTriggerPreference').mockResolvedValue({
      committed: false,
      warnings: [],
      summary: {
        status: 'patched',
        preference: 'manual',
        patchedSkills: [],
        skippedSkills: [],
        generatedArtifacts: [],
      },
      rollbackHandle: {
        committed: false,
        backupSkillsRoot: null,
        operations: [],
      },
    } as never);
    vi.spyOn(skillTriggerModule, 'commitMaterializedSkillTriggerPreference').mockResolvedValue(undefined);

    const receipt = await applyBuiltInConfigWrite({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'project',
      cwd,
      env,
      key: 'aw.skillTriggers.commit.trigger',
      action: 'set',
      value: 'manual',
    });

    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginName: plugin.manifest.name,
          platform: 'codex',
          scope: 'project',
          projectKey,
        }),
        action: 'configApply',
        state: 'completed',
      }),
    ]));
    expect(materializeSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        platform: 'codex',
        scope: 'project',
        kind: 'repoSkill',
        root: path.join(repoRoot, '.agents', 'skills'),
      }),
    }));
  });

  it('returns a no-op when replaying built-in runtime for plugins without SkillTrigger fields', async () => {
    const root = await makeTempRoot('aw-config-write-no-built-in-');
    const cwd = path.join(root, 'repo');
    await fs.ensureDir(cwd);

    await expect(replayBuiltInConfigRuntime({
      plugin: createPlugin('plain-plugin'),
      scope: 'user',
      cwd,
      env: {} as NodeJS.ProcessEnv,
    })).resolves.toEqual([]);
  });

  it('blocks project shared config writes when cwd is only registered as a read-only repo fixture', async () => {
    const root = await makeTempRoot('aw-config-write-readonly-project-');
    const repositoryCwd = pluginConfigModule.resolveAwProjectRoot(getSourceTestRepositoryCwd());
    const plugin = await materializePlugin(
      root,
      createPlugin('readonly-project-config-plugin'),
    );

    await runWithCurrentRepositoryCwdAsReadOnly(async () => {
      const repositoryCwd = process.cwd();
      const projectRoot = pluginConfigModule.resolveAwProjectRoot(repositoryCwd);

      await expectAsyncPathFenceViolation(
        () => applyPluginConfigWrite({
          plugin,
          scope: 'project',
          cwd: repositoryCwd,
          env: process.env,
          request: {
            updates: {
              retries: '2',
            },
          },
        }),
        {
          access: 'write',
          path: path.join(
            projectRoot,
            '.agent-workflows',
            'plugin-config',
            plugin.manifest.name,
            'config.json',
          ),
          source: 'project shared plugin config store (.agent-workflows/plugin-config)',
          reason: 'writeToReadOnlyRoot',
          conflictingRootPath: projectRoot,
          recommendedFixIncludes: 'withSafeTestCwd()',
        },
      );
      expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
    }, { repositoryCwd });
  });

  it('reports a failed target result when only .agent-workflows is writable but .agents/skills stays read-only', async () => {
    const root = await makeTempRoot('aw-config-write-built-in-readonly-runtime-');
    const repositoryCwd = pluginConfigModule.resolveAwProjectRoot(getSourceTestRepositoryCwd());
    const basePlugin = createPlugin('readonly-runtime-plugin');
    const plugin = await materializePlugin(root, {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        skills: './skills',
        skillTriggers: {
          commit: {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        },
        config: undefined,
      },
    } as PluginMeta);
    await fs.outputFile(path.join(plugin.rootDir, 'skills', 'commit', 'SKILL.md'), '# commit\n');
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'commit', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );

    vi.spyOn(pluginConfigModule, 'writePluginConfigStore').mockResolvedValue({
      pluginName: plugin.manifest.name,
      scope: 'project',
      path: '',
    });

    await runWithCurrentRepositoryCwdAsReadOnly(async () => {
      const repositoryCwd = process.cwd();
      const projectRoot = pluginConfigModule.resolveAwProjectRoot(repositoryCwd);
      const projectKey = await resolveCodexProjectKey(repositoryCwd);
      registerCurrentTestWritableStateRoot(
        path.join(projectRoot, '.agent-workflows'),
        'project config store',
      );
      vi.spyOn(localMarketplaceModule, 'readInstalledLedger').mockResolvedValue({
        ledgerState: { status: 'available' },
        plugins: {
          [plugin.manifest.name]: {
            platforms: {
              codex: {
                projectScopes: {
                  [projectKey]: {
                    managed: true,
                  },
                },
              },
            },
          },
        },
      } as never);

      vi.mocked(pluginConfigModule.writePluginConfigStore).mockResolvedValue({
        pluginName: plugin.manifest.name,
        scope: 'project',
        path: path.join(
          projectRoot,
          '.agent-workflows',
          'plugin-config',
          plugin.manifest.name,
          'config.json',
        ),
      });

      const receipt = await applyBuiltInConfigWrite({
        pluginName: plugin.manifest.name,
        plugin,
        scope: 'project',
        cwd: repositoryCwd,
        env: process.env,
        key: 'aw.skillTriggers.commit.trigger',
        action: 'set',
        value: 'manual',
      });

      expect(receipt.targetResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: plugin.manifest.name,
            platform: 'codex',
            scope: 'project',
            projectKey,
          }),
          action: 'configApply',
          state: 'failed',
          message: expect.stringContaining(path.join(projectRoot, '.agents', 'skills')),
        }),
      ]));
    }, { repositoryCwd });
  });

  it('prewrites project shared config without refresh when the current project has no local record', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin());

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
      projectLayer: 'shared',
      updatedKeys: ['retries'],
      removedKeys: ['mode'],
      effective: {
        values: {
          token: '[redacted]',
          retries: 2,
        },
      },
      artifactRefresh: {
        attempted: false,
        status: 'skipped',
        triggerKeys: ['retries', 'mode'],
      },
      configRefreshSkippedReason: 'noRefreshTarget',
      warnings: [],
    });
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
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

  it('fails config writes before touching the store when an installed refresh target fails agent version gate', async () => {
    const root = await makeTempRoot('aw-config-write-version-gate-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('version-gated-config-plugin', {
      withUserDynamicTarget: true,
    }));
    await writeUserInstallRecordForConfigTest({ root, cwd, env, plugin });
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        mode: 'safe',
      },
    });

    await expect(applyPluginConfigWrite({
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }),
      request: {
        updates: {
          mode: 'fast',
        },
      },
    })).rejects.toThrow('Codex 版本过低');

    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        mode: 'safe',
      },
    });
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('fails built-in SkillTrigger writes before touching the store when apply target fails agent version gate', async () => {
    const root = await makeTempRoot('aw-config-write-built-in-gate-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const basePlugin = createPlugin('version-gated-skill-plugin');
    const plugin = await materializePlugin(root, {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        skills: './skills',
        skillTriggers: {
          commit: {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        },
        config: undefined,
      },
    } as PluginMeta);
    await fs.outputFile(path.join(plugin.rootDir, 'skills', 'commit', 'SKILL.md'), '# commit\n');
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'commit', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    vi.spyOn(localMarketplaceModule, 'readInstalledLedger').mockResolvedValue({
      ledgerState: { status: 'available' },
      plugins: {
        [plugin.manifest.name]: {
          platforms: {
            codex: {
              userScope: {
                managed: true,
              },
            },
          },
        },
      },
    } as never);
    const materializeSpy = vi.spyOn(skillTriggerModule, 'materializeSkillTriggerPreference').mockResolvedValue({
      committed: false,
      warnings: [],
      summary: {
        status: 'patched',
        preference: 'manual',
        patchedSkills: [],
        skippedSkills: [],
        generatedArtifacts: [],
      },
      rollbackHandle: {
        committed: false,
        backupSkillsRoot: null,
        operations: [],
      },
    } as never);

    await expect(applyBuiltInConfigWrite({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }),
      key: 'aw.skillTriggers.commit.trigger',
      action: 'set',
      value: 'manual',
    })).rejects.toThrow('Codex 版本过低');

    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {},
    });
    expect(materializeSpy).not.toHaveBeenCalled();
  });

  it('uses user install record evidence when gating built-in SkillTrigger writes', async () => {
    const root = await makeTempRoot('aw-config-write-built-in-record-gate-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializeSkillTriggerPluginForConfigTest(root, 'record-backed-skill-plugin');
    await writeUserInstallRecordForConfigTest({ root, cwd, env, plugin });

    const materializeSpy = vi.spyOn(skillTriggerModule, 'materializeSkillTriggerPreference').mockResolvedValue({
      committed: false,
      warnings: [],
      summary: {
        status: 'patched',
        preference: 'manual',
        patchedSkills: [],
        skippedSkills: [],
        generatedArtifacts: [],
      },
      rollbackHandle: {
        committed: false,
        backupSkillsRoot: null,
        operations: [],
      },
    } as never);

    await expect(applyBuiltInConfigWrite({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }),
      key: 'aw.skillTriggers.commit.trigger',
      action: 'set',
      value: 'manual',
    })).rejects.toThrow('Codex 版本过低');

    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {},
    });
    expect(materializeSpy).not.toHaveBeenCalled();
  });

  it('uses user dynamic diagnostic cache evidence when gating built-in SkillTrigger writes', async () => {
    const root = await makeTempRoot('aw-config-write-built-in-cache-gate-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializeSkillTriggerPluginForConfigTest(root, 'cache-backed-skill-plugin');
    await writeUserDynamicDiagnosticCacheForConfigTest({ cwd, env, plugin });

    const materializeSpy = vi.spyOn(skillTriggerModule, 'materializeSkillTriggerPreference').mockResolvedValue({
      committed: false,
      warnings: [],
      summary: {
        status: 'patched',
        preference: 'manual',
        patchedSkills: [],
        skippedSkills: [],
        generatedArtifacts: [],
      },
      rollbackHandle: {
        committed: false,
        backupSkillsRoot: null,
        operations: [],
      },
    } as never);

    await expect(applyBuiltInConfigWrite({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }),
      key: 'aw.skillTriggers.commit.trigger',
      action: 'set',
      value: 'manual',
    })).rejects.toThrow('Codex 版本过低');

    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {},
    });
    expect(materializeSpy).not.toHaveBeenCalled();
  });

  it('replays user built-in SkillTrigger runtime as user scope when fallback evidence is user diagnostic cache', async () => {
    const root = await makeTempRoot('aw-config-write-built-in-user-cache-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializeSkillTriggerPluginForConfigTest(root, 'user-cache-backed-skill-plugin');
    await writeUserDynamicDiagnosticCacheForConfigTest({ cwd, env, plugin });

    const materializeSpy = vi.spyOn(skillTriggerModule, 'materializeSkillTriggerPreference').mockResolvedValue({
      committed: false,
      warnings: [],
      summary: {
        status: 'patched',
        preference: 'manual',
        patchedSkills: [],
        skippedSkills: [],
        generatedArtifacts: [],
      },
      rollbackHandle: {
        committed: false,
        backupSkillsRoot: null,
        operations: [],
      },
    } as never);
    vi.spyOn(skillTriggerModule, 'commitMaterializedSkillTriggerPreference').mockResolvedValue(undefined);

    const receipt = await applyBuiltInConfigWrite({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.131.0' }),
      key: 'aw.skillTriggers.commit.trigger',
      action: 'set',
      value: 'manual',
    });

    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: {
          pluginName: plugin.manifest.name,
          platform: 'codex',
          scope: 'user',
        },
        action: 'configApply',
        state: 'completed',
      }),
    ]));
    expect(materializeSpy).toHaveBeenCalledWith(expect.objectContaining({
      marketplaceRootOrStagingRoot: env.AW_HOME,
    }));
    expect(materializeSpy.mock.calls[0]?.[0]).not.toHaveProperty('target');
  });

  it('fails config writes before touching the store when user tracking-only dynamic refresh target fails agent version gate', async () => {
    const root = await makeTempRoot('aw-config-write-user-tracking-gate-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('tracking-backed-config-plugin', {
      withUserDynamicTarget: true,
    }));
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        mode: 'safe',
      },
    });
    await writeUserDynamicTrackingForConfigTest({ cwd, env, plugin });

    await expect(applyPluginConfigWrite({
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }),
      request: {
        updates: {
          mode: 'fast',
        },
      },
    })).rejects.toThrow('Codex 版本过低');

    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        mode: 'safe',
      },
    });
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('refreshes user dynamic artifacts when only tracking evidence remains and agent version is supported', async () => {
    const root = await makeTempRoot('aw-config-write-user-tracking-refresh-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('tracking-refresh-config-plugin', {
      withUserDynamicTarget: true,
    }));
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        mode: 'safe',
      },
    });
    await writeUserDynamicTrackingForConfigTest({ cwd, env, plugin });

    const receipt = await applyPluginConfigWrite({
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.131.0' }),
      request: {
        updates: {
          mode: 'fast',
        },
      },
    });

    expect(refreshArtifactsAfterConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      plugin,
      commandScope: 'user',
      changedKeys: ['mode'],
    }));
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: {
          pluginName: plugin.manifest.name,
          platform: 'codex',
          scope: 'user',
        },
        action: 'configApply',
        state: 'completed',
      }),
    ]));
    expect(receipt.configRefreshSkippedReason).toBeUndefined();
  });

  it('fails config writes before touching the store when user diagnostic cache dynamic refresh target fails agent version gate', async () => {
    const root = await makeTempRoot('aw-config-write-user-cache-gate-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('cache-backed-config-plugin', {
      withUserDynamicTarget: true,
    }));
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        mode: 'safe',
      },
    });
    await writeUserDynamicDiagnosticCacheForConfigTest({ cwd, env, plugin });

    await expect(applyPluginConfigWrite({
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }),
      request: {
        updates: {
          mode: 'fast',
        },
      },
    })).rejects.toThrow('Codex 版本过低');

    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        mode: 'safe',
      },
    });
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('fails config reset before deleting the store when an installed refresh target fails agent version gate', async () => {
    const root = await makeTempRoot('aw-config-reset-version-gate-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('version-gated-reset-plugin', {
      withUserDynamicTarget: true,
    }));
    await writeUserInstallRecordForConfigTest({ root, cwd, env, plugin });
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        mode: 'safe',
      },
    });

    await expect(resetPluginConfigWithHelper({
      pluginName: plugin.manifest.name,
      plugin,
      scope: 'user',
      cwd,
      env,
      nativeCliRunner: createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }),
    })).rejects.toThrow('Codex 版本过低');

    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        mode: 'safe',
      },
    });
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('allows config-only prewrites for adoptable project artifacts without entering the agent version gate', async () => {
    const root = await makeTempRoot('aw-config-write-adoptable-prewrite-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('adoptable-prewrite-plugin', {
      withProjectDynamicTarget: true,
    }));
    await writeAdoptableProjectIdentityForConfigTest({ cwd, repoRoot, plugin });
    const nativeCliRunner = vi.fn(createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }));

    const receipt = await applyPluginConfigWrite({
      plugin,
      scope: 'project',
      cwd,
      env,
      nativeCliRunner,
      request: {
        updates: {
          retries: '2',
        },
      },
    });

    expect(receipt.configRefreshSkippedReason).toBe('adoptExistingRequired');
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        retries: 2,
      },
    });
  });

  it('blocks adoptable project artifact refresh before agent version probing or store writes', async () => {
    const root = await makeTempRoot('aw-config-write-adoptable-refresh-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('adoptable-refresh-plugin', {
      withProjectDynamicTarget: true,
    }));
    await writeAdoptableProjectIdentityForConfigTest({ cwd, repoRoot, plugin });
    const nativeCliRunner = vi.fn(createAgentVersionRunner({ codex: 'codex-cli 0.130.0' }));

    await expect(applyPluginConfigWrite({
      plugin,
      scope: 'project',
      cwd,
      env,
      nativeCliRunner,
      request: {
        updates: {
          mode: 'fast',
        },
      },
    })).rejects.toThrow('aw install adoptable-refresh-plugin --platform codex --scope project --adopt-existing');

    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
    }))).resolves.toBe(false);
  });

  it('refreshes current project artifacts and同步写回 install-state when project shared config changes affect a local record', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('configurable-plugin', {
      withProjectDynamicTarget: true,
    }));

    const projectKey = await resolveCodexProjectKey(cwd);
    const location = {
      plugin: plugin.manifest.name,
      platform: 'codex' as const,
      scope: 'project' as const,
      projectKey,
    };
    const recordPath = getInstallRecordPath(cwd, location, env);
    const recordId = path.basename(recordPath, '.json');
    const repoArtifactPath = path.join(repoRoot, '.codex', 'config.toml');
    await fs.outputFile(repoArtifactPath, '# before\n');
    const sourceManifestDigest = await calculateFileDigest(plugin.manifestPath);
    const sourceBundleFingerprint = await calculatePluginBundleFingerprint(plugin.rootDir);
    const lifecyclePaths = createHistoricalLifecycleRuntimePaths({
      cwd,
      location,
      recordId,
      manifestDigest: sourceManifestDigest,
      bundleFingerprint: sourceBundleFingerprint,
      nonce: 'test-refresh',
      env,
      manifestRelativePath: '.agents-plugin/plugin.json',
    });
    await fs.copy(plugin.rootDir, lifecyclePaths.bundleRoot);
    const manifestDigest = await calculateFileDigest(lifecyclePaths.manifestPath);
    const bundleFingerprint = await calculatePluginBundleFingerprint(lifecyclePaths.bundleRoot);

    await writeTrackingManifest(resolveCodexPaths(cwd, 'project', env).trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-08T01:00:00.000Z',
          artifacts: [{
            path: repoArtifactPath,
            kind: 'instruction',
            platform: 'codex',
            id: 'project-instructions',
            target: 'codex.developerInstructionsBlock',
            state: 'present',
            refreshKeys: ['mode'],
            configDigest: 'sha256:new-config',
            contentDigest: 'sha256:new-content',
            lastRefresh: {
              status: 'succeeded',
              updatedAt: '2026-05-08T01:00:00.000Z',
              triggerKeys: ['mode'],
              event: 'refresh',
            },
            refreshReach: {
              commandScope: 'project',
              refreshedCurrentProjectTarget: true,
            },
          }],
        },
      },
    });

    const recordFile = {
      version: 2 as const,
      recordId,
      record: {
        pluginName: plugin.manifest.name,
        platform: 'codex' as const,
        scope: 'project' as const,
        projectKey,
        installedAt: '2026-05-07T01:00:00.000Z',
        updatedAt: '2026-05-07T01:00:00.000Z',
        source: {
          pluginVersion: plugin.manifest.version,
          manifestDigest,
          bundleFingerprint,
        },
        installSource: {
          kind: 'explicit' as const,
          explicitlyRequested: true,
        },
        lifecycle: {
          runtimeRoot: lifecyclePaths.runtimeRoot,
          bundleRoot: lifecyclePaths.bundleRoot,
          manifestPath: lifecyclePaths.manifestPath,
          pluginVersion: plugin.manifest.version,
          sourceManifestDigest: manifestDigest,
          bundleFingerprint,
          events: ['install'],
          createdAt: '2026-05-07T01:00:00.000Z',
        },
        artifacts: [{
          kind: 'instruction' as const,
          platform: 'codex' as const,
          path: repoArtifactPath,
          id: 'project-instructions',
          target: 'codex.developerInstructionsBlock' as const,
        }],
        dependencyEdges: [],
      },
    };
    await writeInstallRecordFileAt(recordPath, recordFile, { env });
    await writeDynamicArtifactDiagnosticCacheAt(
      getDiagnosticCachePath(cwd, location, env),
      {
        version: 1,
        recordId,
        location,
        updatedAt: '2026-05-07T01:00:00.000Z',
        artifacts: [{
          id: 'project-instructions',
          target: 'codex.developerInstructionsBlock',
          state: 'present',
          refreshKeys: ['mode'],
          configDigest: 'sha256:old-config',
          contentDigest: 'sha256:old-content',
          lastRefresh: {
            status: 'success',
            at: '2026-05-07T01:00:00.000Z',
            event: 'install',
          },
        }],
      },
      recordFile,
    );

    const locator = createProjectArtifactSharedLocator({
      plugin: plugin.manifest.name,
      platform: 'codex',
      repoRoot,
      projectRoot: repoRoot,
    });
    await writeProjectArtifactIdentityFileAt(
      getProjectArtifactSharedIdentityPath({ repoRoot, locator }),
      {
        version: 1,
        sharedIdentityId: path.basename(getProjectArtifactSharedIdentityPath({ repoRoot, locator }), '.json'),
        locator,
        source: recordFile.record.source,
        generatedAt: '2026-05-07T01:00:00.000Z',
        artifacts: [{
          kind: 'instruction',
          platform: 'codex',
          path: '.codex/config.toml',
          id: 'project-instructions',
          target: 'codex.developerInstructionsBlock',
          state: 'present',
          contentDigest: 'sha256:old-content',
        }],
      },
    );

    const receipt = await applyPluginConfigWrite({
      plugin,
      scope: 'project',
      cwd,
      env,
      applyTargets: [
        {
          pluginName: plugin.manifest.name,
          platform: 'codex',
          scope: 'project',
          projectKey,
        },
        {
          pluginName: plugin.manifest.name,
          platform: 'claude',
          scope: 'project',
          projectKey,
        },
      ],
      request: {
        updates: {
          mode: 'fast',
        },
      },
    });

    expect(receipt.artifactRefresh).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['mode'],
    });
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: {
          pluginName: plugin.manifest.name,
          platform: 'codex',
          scope: 'project',
          projectKey,
        },
        action: 'configApply',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: plugin.manifest.name,
          platform: 'claude',
          scope: 'project',
          projectKey,
        },
        action: 'configApply',
        state: 'notRun',
      }),
    ]));
    expect(refreshArtifactsAfterConfigWrite).toHaveBeenCalledTimes(1);

    const updatedRecord = await fs.readJson(recordPath);
    expect(updatedRecord.record.artifacts[0]).toMatchObject({
      id: 'project-instructions',
      target: 'codex.developerInstructionsBlock',
      path: repoArtifactPath,
    });

    const updatedCache = await fs.readJson(getDiagnosticCachePath(cwd, location, env));
    expect(updatedCache.artifacts[0]).toMatchObject({
      id: 'project-instructions',
      target: 'codex.developerInstructionsBlock',
      configDigest: 'sha256:new-config',
      contentDigest: 'sha256:new-content',
      lastRefresh: {
        status: 'success',
        event: 'config',
      },
    });

    const updatedIdentity = await fs.readJson(getProjectArtifactSharedIdentityPath({ repoRoot, locator }));
    expect(updatedIdentity.artifacts[0]).toMatchObject({
      path: '.codex/config.toml',
      id: 'project-instructions',
      target: 'codex.developerInstructionsBlock',
      contentDigest: 'sha256:new-content',
    });
  });

  it('preserves accepted install-state and only records refresh failure summary when config refresh fails', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    const plugin = await materializePlugin(root, createPlugin('configurable-plugin', {
      withProjectDynamicTarget: true,
    }));

    vi.mocked(refreshArtifactsAfterConfigWrite).mockResolvedValueOnce({
      attempted: true,
      status: 'failed',
      triggerKeys: ['mode'],
      artifacts: [],
      error: 'render failed',
    });

    const projectKey = await resolveCodexProjectKey(cwd);
    const location = {
      plugin: plugin.manifest.name,
      platform: 'codex' as const,
      scope: 'project' as const,
      projectKey,
    };
    const recordPath = getInstallRecordPath(cwd, location, env);
    const recordId = path.basename(recordPath, '.json');
    const repoArtifactPath = path.join(repoRoot, '.codex', 'config.toml');
    await fs.outputFile(repoArtifactPath, '# before\n');
    const sourceManifestDigest = await calculateFileDigest(plugin.manifestPath);
    const sourceBundleFingerprint = await calculatePluginBundleFingerprint(plugin.rootDir);
    const lifecyclePaths = createHistoricalLifecycleRuntimePaths({
      cwd,
      location,
      recordId,
      manifestDigest: sourceManifestDigest,
      bundleFingerprint: sourceBundleFingerprint,
      nonce: 'test-refresh-failed',
      env,
      manifestRelativePath: '.agents-plugin/plugin.json',
    });
    await fs.copy(plugin.rootDir, lifecyclePaths.bundleRoot);
    const manifestDigest = await calculateFileDigest(lifecyclePaths.manifestPath);
    const bundleFingerprint = await calculatePluginBundleFingerprint(lifecyclePaths.bundleRoot);

    await writeTrackingManifest(resolveCodexPaths(cwd, 'project', env).trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-08T01:00:00.000Z',
          artifacts: [{
            path: repoArtifactPath,
            kind: 'instruction',
            platform: 'codex',
            id: 'project-instructions',
            target: 'codex.developerInstructionsBlock',
            state: 'present',
            refreshKeys: ['mode'],
            configDigest: 'sha256:new-config',
            contentDigest: 'sha256:new-content',
            lastRefresh: {
              status: 'failed',
              updatedAt: '2026-05-08T01:00:00.000Z',
              triggerKeys: ['mode'],
              event: 'refresh',
              error: 'render failed',
            },
            refreshReach: {
              commandScope: 'project',
              refreshedCurrentProjectTarget: false,
            },
          }],
        },
      },
    });

    const recordFile = {
      version: 2 as const,
      recordId,
      record: {
        pluginName: plugin.manifest.name,
        platform: 'codex' as const,
        scope: 'project' as const,
        projectKey,
        installedAt: '2026-05-07T01:00:00.000Z',
        updatedAt: '2026-05-07T01:00:00.000Z',
        source: {
          pluginVersion: plugin.manifest.version,
          manifestDigest,
          bundleFingerprint,
        },
        installSource: {
          kind: 'explicit' as const,
          explicitlyRequested: true,
        },
        lifecycle: {
          runtimeRoot: lifecyclePaths.runtimeRoot,
          bundleRoot: lifecyclePaths.bundleRoot,
          manifestPath: lifecyclePaths.manifestPath,
          pluginVersion: plugin.manifest.version,
          sourceManifestDigest: manifestDigest,
          bundleFingerprint,
          events: ['install'],
          createdAt: '2026-05-07T01:00:00.000Z',
        },
        artifacts: [{
          kind: 'instruction' as const,
          platform: 'codex' as const,
          path: repoArtifactPath,
          id: 'project-instructions',
          target: 'codex.developerInstructionsBlock' as const,
        }],
        dependencyEdges: [],
      },
    };
    await writeInstallRecordFileAt(recordPath, recordFile, { env });
    await writeDynamicArtifactDiagnosticCacheAt(
      getDiagnosticCachePath(cwd, location, env),
      {
        version: 1,
        recordId,
        location,
        updatedAt: '2026-05-07T01:00:00.000Z',
        artifacts: [{
          id: 'project-instructions',
          target: 'codex.developerInstructionsBlock',
          state: 'present',
          refreshKeys: ['mode'],
          configDigest: 'sha256:old-config',
          contentDigest: 'sha256:old-content',
          lastRefresh: {
            status: 'success',
            at: '2026-05-07T01:00:00.000Z',
            event: 'install',
          },
        }],
      },
      recordFile,
    );

    const locator = createProjectArtifactSharedLocator({
      plugin: plugin.manifest.name,
      platform: 'codex',
      repoRoot,
      projectRoot: repoRoot,
    });
    const identityPath = getProjectArtifactSharedIdentityPath({ repoRoot, locator });
    await writeProjectArtifactIdentityFileAt(
      identityPath,
      {
        version: 1,
        sharedIdentityId: path.basename(identityPath, '.json'),
        locator,
        source: recordFile.record.source,
        generatedAt: '2026-05-07T01:00:00.000Z',
        artifacts: [{
          kind: 'instruction',
          platform: 'codex',
          path: '.codex/config.toml',
          id: 'project-instructions',
          target: 'codex.developerInstructionsBlock',
          state: 'present',
          contentDigest: 'sha256:old-content',
        }],
      },
    );

    const beforeRecord = await fs.readJson(recordPath);
    const beforeIdentity = await fs.readJson(identityPath);

    const receipt = await applyPluginConfigWrite({
      plugin,
      scope: 'project',
      cwd,
      env,
      request: {
        updates: {
          mode: 'fast',
        },
      },
    });

    expect(receipt.artifactRefresh).toMatchObject({
      attempted: true,
      status: 'failed',
      error: 'render failed',
    });

    await expect(fs.readJson(recordPath)).resolves.toEqual(beforeRecord);
    await expect(fs.readJson(identityPath)).resolves.toEqual(beforeIdentity);
    await expect(fs.readJson(getDiagnosticCachePath(cwd, location, env))).resolves.toMatchObject({
      artifacts: [{
        id: 'project-instructions',
        target: 'codex.developerInstructionsBlock',
        configDigest: 'sha256:old-config',
        contentDigest: 'sha256:old-content',
        lastRefresh: {
          status: 'failed',
          event: 'config',
          error: 'render failed',
        },
      }],
    });
  });

  it('treats removing a missing key as a no-op without creating an empty store or refreshing', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const plugin = createPlugin('missing-key-plugin');

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

  it('fails before shared config write when the target path is ignored', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.agent-workflows/\n', 'utf8');
    const plugin = createPlugin();

    await expect(applyPluginConfigWrite({
      plugin,
      scope: 'project',
      cwd,
      env,
      request: {
        updates: {
          retries: '2',
        },
      },
    })).rejects.toThrow('project shared config');

    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
    }))).resolves.toBe(false);
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('writes project local config into plugin-config.local, ensures ignore, and skips repo-visible refresh', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    const plugin = createPlugin();

    const receipt = await applyPluginConfigWrite({
      plugin,
      scope: 'project',
      projectLayer: 'local',
      cwd,
      env,
      request: {
        updates: {
          token: 'local-secret',
        },
      },
    });

    expect(receipt).toMatchObject({
      scope: 'project',
      projectLayer: 'local',
      updatedKeys: ['token'],
      artifactRefresh: {
        attempted: false,
        status: 'skipped',
      },
      warnings: [],
    });
    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      projectLayer: 'local',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        token: 'local-secret',
      },
    });
    await expect(fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8')).resolves.toContain(
      '.agent-workflows/plugin-config.local/',
    );
    expect(refreshArtifactsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it('blocks path-type keys from project shared config but allows them in project local config', async () => {
    const root = await makeTempRoot('aw-config-write-');
    const repoRoot = path.join(root, 'repo');
    const cwd = path.join(repoRoot, 'packages', 'app');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await initRepo(repoRoot);
    await fs.ensureDir(cwd);
    await fs.outputFile(path.join(repoRoot, 'config.json'), '{}\n');
    const plugin = createPlugin();
    plugin.manifest.config!.schema.configFile = { type: 'file', required: false };

    await expect(applyPluginConfigWrite({
      plugin,
      scope: 'project',
      cwd,
      env,
      request: {
        updates: {
          configFile: 'config.json',
        },
      },
    })).rejects.toThrow('cannot be written into project shared config');

    const localReceipt = await applyPluginConfigWrite({
      plugin,
      scope: 'project',
      projectLayer: 'local',
      cwd,
      env,
      request: {
        updates: {
          configFile: 'config.json',
        },
      },
    });

    expect(localReceipt.projectLayer).toBe('local');
    await expect(readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      projectLayer: 'local',
      cwd,
      env,
    })).resolves.toMatchObject({
      values: {
        configFile: await fs.realpath(path.join(repoRoot, 'config.json')),
      },
    });
  });

  it('returns removedKeys and installedHistorical schema metadata when resetting an installed store', async () => {
    const root = await makeTempRoot('aw-config-write-reset-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);

    const historicalPlugin = await materializePlugin(root, createPlugin('resettable-plugin', {
      withUserDynamicTarget: true,
    }));
    const currentPlugin = {
      ...historicalPlugin,
      manifest: {
        ...structuredClone(historicalPlugin.manifest),
        version: '0.2.0',
      },
    } satisfies PluginMeta;
    const location = {
      plugin: historicalPlugin.manifest.name,
      platform: 'codex' as const,
      scope: 'user' as const,
    };
    const recordPath = getInstallRecordPath(cwd, location, env);
    const recordId = path.basename(recordPath, '.json');
    const sourceManifestDigest = await calculateFileDigest(historicalPlugin.manifestPath);
    const sourceBundleFingerprint = await calculatePluginBundleFingerprint(historicalPlugin.rootDir);
    const lifecyclePaths = createHistoricalLifecycleRuntimePaths({
      cwd,
      location,
      recordId,
      manifestDigest: sourceManifestDigest,
      bundleFingerprint: sourceBundleFingerprint,
      nonce: 'test-reset',
      env,
      manifestRelativePath: '.agents-plugin/plugin.json',
    });
    await fs.copy(historicalPlugin.rootDir, lifecyclePaths.bundleRoot);
    const manifestDigest = await calculateFileDigest(lifecyclePaths.manifestPath);
    const bundleFingerprint = await calculatePluginBundleFingerprint(lifecyclePaths.bundleRoot);
    await writeInstallRecordFileAt(recordPath, {
      version: 2,
      recordId,
      record: {
        pluginName: historicalPlugin.manifest.name,
        platform: 'codex',
        scope: 'user',
        installedAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
        source: {
          pluginVersion: historicalPlugin.manifest.version,
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
          pluginVersion: historicalPlugin.manifest.version,
          sourceManifestDigest: manifestDigest,
          bundleFingerprint,
          events: ['install'],
          createdAt: '2026-05-18T00:00:00.000Z',
        },
        artifacts: [],
        dependencyEdges: [],
      },
    }, { env });
    await writePluginConfigStore({
      pluginName: historicalPlugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        mode: 'fast',
      },
    });

    const receipt = await resetPluginConfigWithHelper({
      pluginName: historicalPlugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      plugin: currentPlugin,
    });

    expect(receipt.schema).toMatchObject({
      source: 'installedHistorical',
      pluginVersion: historicalPlugin.manifest.version,
    });
    expect(receipt.removedKeys).toEqual(['mode']);
    expect(receipt.artifactRefresh).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['mode'],
    });
    expect(refreshArtifactsAfterConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      changedKeys: ['mode'],
    }));
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
      projectLayer: 'shared',
      existed: true,
      deleted: true,
      artifactRefresh: {
        attempted: false,
        status: 'skipped',
      },
      warnings: [],
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
