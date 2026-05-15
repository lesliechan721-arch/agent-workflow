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
  getDiagnosticCachePath,
  getInstallRecordPath,
  getProjectArtifactSharedIdentityPath,
} from '../../src/install-state/paths.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { resolveCodexPaths, resolveCodexProjectKey } from '../../src/utils/paths.js';
import * as skillTriggerModule from '../../src/utils/skill-trigger-preferences.js';
import { writeTrackingManifest } from '../../src/utils/tracking.js';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

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
  options: { withProjectDynamicTarget?: boolean } = {},
): PluginMeta {
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
      ...(options.withProjectDynamicTarget
        ? {
            artifacts: {
              targets: [{
                id: 'project-instructions',
                platform: 'codex' as const,
                target: 'codex.developerInstructionsBlock' as const,
                scopes: ['project'],
                states: ['present'],
                refreshKeys: ['mode'],
                requiresCodexProjectConfig: true,
              }],
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
          manifestDigest: 'sha256:manifest',
          bundleFingerprint: 'sha256:bundle',
        },
        installSource: {
          kind: 'explicit' as const,
          explicitlyRequested: true,
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
    await writeInstallRecordFileAt(recordPath, recordFile);
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
          manifestDigest: 'sha256:manifest',
          bundleFingerprint: 'sha256:bundle',
        },
        installSource: {
          kind: 'explicit' as const,
          explicitlyRequested: true,
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
    await writeInstallRecordFileAt(recordPath, recordFile);
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
