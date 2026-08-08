import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

const codexAdapterStatus = vi.fn(async () => ({
  plugins: [{ managedArtifacts: [] }],
}));
const codexAdapterInstallExtensions = vi.fn();
const codexAdapterInstallPluginFromMarketplace = vi.fn();
const claudeAdapterStatus = vi.fn(async () => ({
  plugins: [{ generatedArtifacts: [] }],
}));
const claudeAdapterInstallExtensions = vi.fn();

vi.mock('../../src/adapters/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(() => ({
    status: codexAdapterStatus,
    installExtensions: codexAdapterInstallExtensions,
    installPluginFromMarketplace: codexAdapterInstallPluginFromMarketplace,
  })),
}));

vi.mock('../../src/adapters/claude.js', () => ({
  ClaudeAdapter: vi.fn().mockImplementation(() => ({
    status: claudeAdapterStatus,
    installExtensions: claudeAdapterInstallExtensions,
  })),
}));

vi.mock('../../src/commands/codex-project-safety.js', () => ({
  preflightCodexProjectWriteSafety: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/local-marketplace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/local-marketplace.js')>();
  return {
    ...actual,
    readInstalledLedger: vi.fn(async () => ({ plugins: {} })),
  };
});

import {
  reapplyConfigRefresh,
  refreshArtifactsAfterConfigWrite,
} from '../../src/utils/artifact-refresh.js';
import { preflightCodexProjectWriteSafety } from '../../src/commands/codex-project-safety.js';
import type { GeneratedArtifact, PluginMeta, SkillTriggerPreference } from '../../src/types.js';
import type { InstallRecordFile, PluginLocation } from '../../src/install-state/types.js';
import {
  getDiagnosticCachePath,
  getInstallRecordPath,
} from '../../src/install-state/paths.js';
import { stageHistoricalLifecycleRuntime } from '../../src/install-state/runtime-state.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../../src/utils/paths.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';
import { readTrackingManifest, writeTrackingManifest } from '../../src/utils/tracking.js';
import * as tracking from '../../src/utils/tracking.js';
import * as transactions from '../../src/install-state/transactions.js';
import {
  getCurrentSourceTestIsolation,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createPlugin(pluginName = 'codex-explore'): PluginMeta {
  return {
    rootDir: '/tmp/plugin',
    manifestPath: '/tmp/plugin/.agents-plugin/plugin.json',
    manifest: {
      name: pluginName,
      version: '0.1.0',
      description: 'Artifact refresh test plugin',
      compatibility: {
        aw: {
          minVersion: '0.1.0',
        },
      },
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CODEX'],
        },
      },
    },
  };
}

function createTrackedDynamicArtifact(options: {
  artifactPath: string;
  refreshKeys: string[];
  lastRefresh?: GeneratedArtifact['lastRefresh'];
}): GeneratedArtifact {
  return {
    path: options.artifactPath,
    kind: 'instruction',
    platform: 'codex',
    id: 'dynamic-instruction',
    target: 'codex.developerInstructionsBlock',
    state: 'present',
    refreshKeys: [...options.refreshKeys],
    lastRefresh: options.lastRefresh,
  };
}

function createTrackedDynamicSkillArtifact(options: {
  artifactPath: string;
  refreshKeys: string[];
  artifactKey?: string;
  id?: string;
  lastRefresh?: GeneratedArtifact['lastRefresh'];
}): GeneratedArtifact {
  return {
    path: options.artifactPath,
    kind: 'skill',
    platform: 'codex',
    artifactKey: options.artifactKey ?? 'codex-explore',
    id: options.id ?? 'codex-explore-skill',
    target: 'codex.skill',
    state: 'present',
    refreshKeys: [...options.refreshKeys],
    contentDigest: 'sha256:skill-content',
    configDigest: 'sha256:skill-config',
    lastRefresh: options.lastRefresh,
  };
}

async function writeHistoricalInstallRecord(options: {
  root: string;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
  scope: 'project' | 'user';
  artifacts: GeneratedArtifact[];
  platform?: 'codex' | 'claude';
  historicalVersion?: string;
  skillTriggerPreference?: SkillTriggerPreference;
  prepareBundle?: (sourceBundleRoot: string) => Promise<void>;
}): Promise<string> {
  const platform = options.platform ?? 'codex';
  const sourceBundleRoot = path.join(
    options.root,
    `historical-source-${options.scope}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const manifest = {
    ...structuredClone(options.plugin.manifest),
    version: options.historicalVersion ?? options.plugin.manifest.version,
  };
  const sourceManifestPath = path.join(sourceBundleRoot, '.agents-plugin', 'plugin.json');
  await fs.outputJson(sourceManifestPath, manifest, { spaces: 2 });
  await fs.outputJson(
    path.join(sourceBundleRoot, platform === 'codex' ? '.codex-plugin' : '.claude-plugin', 'plugin.json'),
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      compatibility: manifest.compatibility,
    },
    { spaces: 2 },
  );
  await options.prepareBundle?.(sourceBundleRoot);

  const [manifestDigest, bundleFingerprint] = await Promise.all([
    calculateFileDigest(sourceManifestPath),
    calculatePluginBundleFingerprint(sourceBundleRoot),
  ]);
  const location: PluginLocation = {
    plugin: options.plugin.manifest.name,
    platform,
    scope: options.scope,
    ...(options.scope === 'project'
      ? {
          projectKey: platform === 'codex'
            ? await resolveCodexProjectKey(options.repoRoot)
            : await resolveClaudeProjectKey(options.repoRoot),
        }
      : {}),
  };
  const runtimeStage = await stageHistoricalLifecycleRuntime({
    cwd: options.repoRoot,
    location,
    sourceBundleRoot,
    pluginVersion: manifest.version,
    manifestDigest,
    bundleFingerprint,
    events: ['install', 'upgrade', 'uninstall'],
    manifestRelativePath: path.join('.agents-plugin', 'plugin.json'),
    env: options.env,
  });
  await runtimeStage.commit();
  await runtimeStage.finalize();

  const recordPath = getInstallRecordPath(options.repoRoot, location, options.env);
  const recordFile: InstallRecordFile = {
    version: 2,
    recordId: path.basename(recordPath, '.json'),
    record: {
      pluginName: options.plugin.manifest.name,
      platform,
      scope: options.scope,
      ...(options.scope === 'project' ? { projectKey: location.projectKey ?? undefined } : {}),
      installedAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
      source: {
        pluginVersion: manifest.version,
        manifestDigest,
        bundleFingerprint,
      },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      ...(options.skillTriggerPreference
        ? { options: { skillTriggerPreference: options.skillTriggerPreference } }
        : {}),
      lifecycle: runtimeStage.runtimeRef,
      artifacts: options.artifacts.map((artifact) => ({
        kind: artifact.kind,
        platform: artifact.platform,
        path: artifact.path,
        ...(artifact.paths === undefined ? {} : { paths: [...artifact.paths] }),
        ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
        ...(artifact.id === undefined ? {} : { id: artifact.id }),
        ...(artifact.target === undefined ? {} : { target: artifact.target }),
        ...(artifact.state === undefined ? {} : { state: artifact.state }),
        ...(artifact.refreshKeys === undefined ? {} : { refreshKeys: [...artifact.refreshKeys] }),
        ...(artifact.kind === 'skill' || artifact.kind === 'mcpServer'
          ? { ownershipMarker: artifact.artifactKey ?? artifact.path }
          : {}),
        ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
        ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
      })),
      dependencyEdges: [],
    },
  };
  await fs.outputJson(recordPath, recordFile, { spaces: 2 });

  return runtimeStage.runtimeRef.bundleRoot;
}

afterEach(async () => {
  vi.clearAllMocks();
  codexAdapterStatus.mockResolvedValue({
    plugins: [{ managedArtifacts: [] }],
  });
  claudeAdapterStatus.mockResolvedValue({
    plugins: [{ generatedArtifacts: [] }],
  });
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('artifact refresh reapply helper', () => {
  it('rebuilds a config-write refresh unit from install-state when tracking is missing', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-missing-tracking-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin();
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    const artifactPath = codexPaths.configTomlPath;
    await fs.outputFile(artifactPath, 'before\n');
    const installedArtifact = createTrackedDynamicArtifact({
      artifactPath,
      refreshKeys: ['mode'],
    });
    await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'project',
      artifacts: [installedArtifact],
    });
    codexAdapterInstallExtensions.mockImplementation(async (_plugin, _scope, options: {
      changedConfigKeys?: string[];
      previousArtifacts?: GeneratedArtifact[];
    }) => {
      expect(options.changedConfigKeys).toEqual(['mode']);
      expect(options.previousArtifacts).toEqual([
        expect.objectContaining({
          id: 'dynamic-instruction',
          refreshKeys: ['mode'],
        }),
      ]);
      return [createTrackedDynamicArtifact({
        artifactPath,
        refreshKeys: ['mode'],
      })];
    });

    const receipt = await refreshArtifactsAfterConfigWrite({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
      changedKeys: ['mode'],
    });

    expect(receipt.status, receipt.error).toBe('succeeded');
    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['mode'],
    });
    expect(codexAdapterInstallExtensions).toHaveBeenCalledTimes(1);
    await expect(readTrackingManifest(codexPaths.trackingDir)).resolves.toMatchObject({
      plugins: {
        [plugin.manifest.name]: {
          artifacts: [expect.objectContaining({
            id: 'dynamic-instruction',
            refreshKeys: ['mode'],
          })],
        },
      },
    });
  });

  it('rebuilds a reapply unit without tracking and records renderer failure diagnostics', async () => {
    const root = await makeTempRoot('aw-artifact-reapply-missing-tracking-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin();
    const artifactPath = resolveCodexPaths(repoRoot, 'project', env).configTomlPath;
    await fs.outputFile(artifactPath, 'before\n');
    const installedArtifact = createTrackedDynamicArtifact({
      artifactPath,
      refreshKeys: ['mode'],
    });
    await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'project',
      artifacts: [installedArtifact],
    });
    codexAdapterInstallExtensions.mockRejectedValueOnce(new Error('renderer failed'));

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'failed',
      triggerKeys: ['mode'],
      error: 'renderer failed',
    });
    const location: PluginLocation = {
      plugin: plugin.manifest.name,
      platform: 'codex',
      scope: 'project',
      projectKey: await resolveCodexProjectKey(repoRoot),
    };
    await expect(fs.readJson(getDiagnosticCachePath(repoRoot, location, env))).resolves.toMatchObject({
      artifacts: [expect.objectContaining({
        id: 'dynamic-instruction',
        refreshKeys: ['mode'],
        lastRefresh: expect.objectContaining({
          status: 'failed',
          event: 'config',
          error: 'renderer failed',
        }),
      })],
    });
  });

  it('prefers failed artifact triggerKeys and writes a succeeded refresh result back to tracking', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin();
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    const artifactPath = path.join(repoRoot, '.codex', 'instructions.md');
    await fs.outputFile(artifactPath, 'before\n');
    const trackedArtifact = createTrackedDynamicArtifact({
      artifactPath,
      refreshKeys: ['mode', 'token'],
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['token'],
        error: 'old failure',
      },
    });
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'project',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.9',
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta, _scope, options: { changedConfigKeys?: string[] }) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      expect(refreshPlugin.manifest.version).toBe('0.0.9');
      expect(options.changedConfigKeys).toEqual(['token']);
      return [
        createTrackedDynamicArtifact({
          artifactPath,
          refreshKeys: ['mode', 'token'],
        }),
      ];
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });

    expect(receipt.status, receipt.error).toBe('succeeded');
    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['token'],
    });
    expect(codexAdapterStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: historicalBundleRoot,
        manifest: expect.objectContaining({ version: '0.0.9' }),
      }),
      'project',
      {
        previousArtifacts: [expect.objectContaining({
          id: 'dynamic-instruction',
          refreshKeys: ['mode', 'token'],
        })],
      },
    );
    expect(preflightCodexProjectWriteSafety).toHaveBeenCalledWith(expect.objectContaining({
      targets: [
        expect.objectContaining({
          source: 'historical',
          plugin: expect.objectContaining({
            rootDir: historicalBundleRoot,
            manifest: expect.objectContaining({ version: '0.0.9' }),
          }),
        }),
      ],
    }));
    await expect(readTrackingManifest(codexPaths.trackingDir)).resolves.toMatchObject({
      plugins: {
        [plugin.manifest.name]: {
          artifacts: [
            expect.objectContaining({
              lastRefresh: expect.objectContaining({
                status: 'succeeded',
                event: 'refresh',
                triggerKeys: ['token'],
              }),
            }),
          ],
        },
      },
    });
  });

  it('rebuilds Codex user native cache from a staged historical marketplace', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-user-cache-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin();
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    const artifactPath = path.join(env.AW_HOME!, 'plugins', plugin.manifest.name, 'codex', 'skills', 'codex-explore');
    await fs.outputFile(path.join(artifactPath, 'SKILL.md'), 'old runtime skill\n');
    const trackedArtifact = createTrackedDynamicSkillArtifact({
      artifactPath,
      refreshKeys: ['explorerModel'],
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
        error: 'old failure',
      },
    });
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'user',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.7',
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      expect(refreshPlugin.manifest.version).toBe('0.0.7');
      await fs.outputFile(path.join(artifactPath, 'SKILL.md'), 'historical refreshed skill\n');
      return [
        createTrackedDynamicSkillArtifact({
          artifactPath,
          refreshKeys: ['explorerModel'],
        }),
      ];
    });
    codexAdapterInstallPluginFromMarketplace.mockImplementation(async (
      refreshPlugin: PluginMeta,
      scope: string,
      options: { marketplacePath?: string },
    ) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      expect(refreshPlugin.manifest.version).toBe('0.0.7');
      expect(scope).toBe('user');
      expect(options.marketplacePath).toBeDefined();
      expect(options.marketplacePath).not.toContain(env.AW_HOME!);

      const marketplacePath = options.marketplacePath!;
      const stagedRoot = path.dirname(path.dirname(path.dirname(marketplacePath)));
      await expect(fs.readJson(marketplacePath)).resolves.toMatchObject({
        name: 'aw',
        plugins: [
          expect.objectContaining({
            name: plugin.manifest.name,
            source: `./plugins/${plugin.manifest.name}`,
          }),
        ],
      });
      await expect(
        fs.readFile(path.join(stagedRoot, 'plugins', plugin.manifest.name, 'codex', 'skills', 'codex-explore', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('historical refreshed skill\n');
      await expect(
        fs.readJson(path.join(stagedRoot, 'plugins', plugin.manifest.name, '.codex-plugin', 'plugin.json')),
      ).resolves.toMatchObject({
        skills: './codex/skills',
      });
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'user',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['explorerModel'],
    });
    expect(codexAdapterInstallPluginFromMarketplace).toHaveBeenCalledTimes(1);
  });

  it('rebuilds Codex user native cache without replacing a custom platform skills root', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-user-custom-cache-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin('mixed-skills');
    plugin.manifest.skills = './custom-skills';
    plugin.manifest.config = {
      schema: {
        explorerModel: {
          type: 'string',
        },
      },
    };
    plugin.manifest.skillTriggers = {
      'static-skill': { defaultTrigger: 'auto', allowDynamicTrigger: true },
      'codex-explore': { defaultTrigger: 'auto', allowDynamicTrigger: true },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['user'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['explorerModel'],
        skillKey: 'codex-explore',
      }],
    };
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    const artifactPath = path.join(env.AW_HOME!, 'plugins', plugin.manifest.name, 'codex', 'skills', 'codex-explore');
    await fs.outputFile(path.join(artifactPath, 'SKILL.md'), 'old runtime skill\n');
    const trackedArtifact = createTrackedDynamicSkillArtifact({
      artifactPath,
      refreshKeys: ['explorerModel'],
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
        error: 'old failure',
      },
    });
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'user',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.7',
      prepareBundle: async (bundleRoot) => {
        const manifestPath = path.join(bundleRoot, '.codex-plugin', 'plugin.json');
        const manifest = await fs.readJson(manifestPath);
        await fs.writeJson(manifestPath, {
          ...manifest,
          skills: './codex/custom-skills',
        }, { spaces: 2 });
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'static-skill', 'SKILL.md'),
          'static historical skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'static-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
      },
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      await fs.outputFile(path.join(artifactPath, 'SKILL.md'), 'custom refreshed skill\n');
      await fs.outputFile(
        path.join(artifactPath, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      );
      return [
        createTrackedDynamicSkillArtifact({
          artifactPath,
          refreshKeys: ['explorerModel'],
        }),
      ];
    });
    codexAdapterInstallPluginFromMarketplace.mockImplementation(async (
      _refreshPlugin: PluginMeta,
      _scope: string,
      options: { marketplacePath?: string },
    ) => {
      const marketplacePath = options.marketplacePath!;
      const stagedRoot = path.dirname(path.dirname(path.dirname(marketplacePath)));
      const stagedPluginRoot = path.join(stagedRoot, 'plugins', plugin.manifest.name);
      await expect(
        fs.readJson(path.join(stagedPluginRoot, '.codex-plugin', 'plugin.json')),
      ).resolves.toMatchObject({
        skills: './codex/custom-skills',
      });
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'static-skill', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('static historical skill\n');
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'codex-explore', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('custom refreshed skill\n');
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'user',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['explorerModel'],
    });
    expect(codexAdapterInstallPluginFromMarketplace).toHaveBeenCalledTimes(1);
  });

  it('removes stale mirrored dynamic Codex skills from custom roots when rebuilding the historical marketplace', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-user-custom-cleanup-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin('mixed-skills');
    plugin.manifest.skills = './custom-skills';
    plugin.manifest.config = {
      schema: {
        explorerModel: {
          type: 'string',
        },
      },
    };
    plugin.manifest.skillTriggers = {
      'static-skill': { defaultTrigger: 'auto', allowDynamicTrigger: true },
      'refreshed-skill': { defaultTrigger: 'auto', allowDynamicTrigger: true },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'refreshed-skill-artifact',
        platform: 'codex',
        scopes: ['user'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['explorerModel'],
        skillKey: 'refreshed-skill',
      }],
    };
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    const refreshedArtifactPath = path.join(
      env.AW_HOME!,
      'plugins',
      plugin.manifest.name,
      'codex',
      'skills',
      'refreshed-skill',
    );
    const trackedArtifact = createTrackedDynamicSkillArtifact({
      artifactPath: refreshedArtifactPath,
      artifactKey: 'refreshed-skill',
      id: 'refreshed-skill-artifact',
      refreshKeys: ['explorerModel'],
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
        error: 'old failure',
      },
    });
    const staleRecordArtifact = createTrackedDynamicSkillArtifact({
      artifactPath: path.join(
        env.AW_HOME!,
        'plugins',
        plugin.manifest.name,
        'codex',
        'skills',
        'legacy-skill',
      ),
      artifactKey: 'legacy-skill',
      id: 'legacy-skill-artifact',
      refreshKeys: ['explorerModel'],
    });
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'user',
      artifacts: [trackedArtifact, staleRecordArtifact],
      historicalVersion: '0.0.7',
      prepareBundle: async (bundleRoot) => {
        const manifestPath = path.join(bundleRoot, '.codex-plugin', 'plugin.json');
        const manifest = await fs.readJson(manifestPath);
        await fs.writeJson(manifestPath, {
          ...manifest,
          skills: './codex/custom-skills',
        }, { spaces: 2 });
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'static-skill', 'SKILL.md'),
          'static historical skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'static-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'legacy-skill', 'SKILL.md'),
          'stale historical skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'legacy-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
      },
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      await fs.outputFile(path.join(refreshedArtifactPath, 'SKILL.md'), 'refreshed runtime skill\n');
      await fs.outputFile(
        path.join(refreshedArtifactPath, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      );
      return [
        createTrackedDynamicSkillArtifact({
          artifactPath: refreshedArtifactPath,
          artifactKey: 'refreshed-skill',
          id: 'refreshed-skill-artifact',
          refreshKeys: ['explorerModel'],
        }),
      ];
    });
    codexAdapterInstallPluginFromMarketplace.mockImplementation(async (
      _refreshPlugin: PluginMeta,
      _scope: string,
      options: { marketplacePath?: string },
    ) => {
      const marketplacePath = options.marketplacePath!;
      const stagedRoot = path.dirname(path.dirname(path.dirname(marketplacePath)));
      const stagedPluginRoot = path.join(stagedRoot, 'plugins', plugin.manifest.name);
      await expect(
        fs.readJson(path.join(stagedPluginRoot, '.codex-plugin', 'plugin.json')),
      ).resolves.toMatchObject({
        skills: './codex/custom-skills',
      });
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'static-skill', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('static historical skill\n');
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'refreshed-skill', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('refreshed runtime skill\n');
      await expect(
        fs.pathExists(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'legacy-skill')),
      ).resolves.toBe(false);
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'user',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['explorerModel'],
    });
    expect(codexAdapterInstallPluginFromMarketplace).toHaveBeenCalledTimes(1);
  });

  it('preserves migrated static Codex skills in custom roots when rebuilding the historical marketplace', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-user-custom-migrated-static-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin('mixed-skills');
    plugin.manifest.skills = './custom-skills';
    plugin.manifest.config = {
      schema: {
        explorerModel: {
          type: 'string',
        },
      },
    };
    plugin.manifest.skillTriggers = {
      'static-skill': { defaultTrigger: 'auto', allowDynamicTrigger: true },
      'legacy-skill': { defaultTrigger: 'auto', allowDynamicTrigger: true },
      'refreshed-skill': { defaultTrigger: 'auto', allowDynamicTrigger: true },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'refreshed-skill-artifact',
        platform: 'codex',
        scopes: ['user'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['explorerModel'],
        skillKey: 'refreshed-skill',
      }],
    };
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    const refreshedArtifactPath = path.join(
      env.AW_HOME!,
      'plugins',
      plugin.manifest.name,
      'codex',
      'skills',
      'refreshed-skill',
    );
    const trackedArtifact = createTrackedDynamicSkillArtifact({
      artifactPath: refreshedArtifactPath,
      artifactKey: 'refreshed-skill',
      id: 'refreshed-skill-artifact',
      refreshKeys: ['explorerModel'],
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
        error: 'old failure',
      },
    });
    const migratedRecordArtifact = createTrackedDynamicSkillArtifact({
      artifactPath: path.join(
        env.AW_HOME!,
        'plugins',
        plugin.manifest.name,
        'codex',
        'skills',
        'legacy-skill',
      ),
      artifactKey: 'legacy-skill',
      id: 'legacy-skill-artifact',
      refreshKeys: ['explorerModel'],
    });
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'user',
      artifacts: [trackedArtifact, migratedRecordArtifact],
      historicalVersion: '0.0.7',
      prepareBundle: async (bundleRoot) => {
        const manifestPath = path.join(bundleRoot, '.codex-plugin', 'plugin.json');
        const manifest = await fs.readJson(manifestPath);
        await fs.writeJson(manifestPath, {
          ...manifest,
          skills: './codex/custom-skills',
        }, { spaces: 2 });
        await fs.outputFile(
          path.join(bundleRoot, 'custom-skills', 'static-skill', 'SKILL.md'),
          'static source skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'custom-skills', 'static-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'custom-skills', 'legacy-skill', 'SKILL.md'),
          'migrated static source skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'custom-skills', 'legacy-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'static-skill', 'SKILL.md'),
          'static historical skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'static-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'legacy-skill', 'SKILL.md'),
          'stale mirrored dynamic skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'custom-skills', 'legacy-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
      },
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      await fs.outputFile(path.join(refreshedArtifactPath, 'SKILL.md'), 'refreshed runtime skill\n');
      await fs.outputFile(
        path.join(refreshedArtifactPath, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      );
      return [
        createTrackedDynamicSkillArtifact({
          artifactPath: refreshedArtifactPath,
          artifactKey: 'refreshed-skill',
          id: 'refreshed-skill-artifact',
          refreshKeys: ['explorerModel'],
        }),
      ];
    });
    codexAdapterInstallPluginFromMarketplace.mockImplementation(async (
      _refreshPlugin: PluginMeta,
      _scope: string,
      options: { marketplacePath?: string },
    ) => {
      const marketplacePath = options.marketplacePath!;
      const stagedRoot = path.dirname(path.dirname(path.dirname(marketplacePath)));
      const stagedPluginRoot = path.join(stagedRoot, 'plugins', plugin.manifest.name);
      await expect(
        fs.readJson(path.join(stagedPluginRoot, '.codex-plugin', 'plugin.json')),
      ).resolves.toMatchObject({
        skills: './codex/custom-skills',
      });
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'static-skill', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('static historical skill\n');
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'legacy-skill', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('migrated static source skill\n');
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'custom-skills', 'refreshed-skill', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('refreshed runtime skill\n');
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'user',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['explorerModel'],
    });
    expect(codexAdapterInstallPluginFromMarketplace).toHaveBeenCalledTimes(1);
  });

  it('preserves bundled Codex skill trigger materialization in the staged historical marketplace', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-user-trigger-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin('mixed-skills');
    plugin.manifest.skills = './skills';
    plugin.manifest.config = {
      schema: {
        explorerModel: {
          type: 'string',
        },
      },
    };
    plugin.manifest.skillTriggers = {
      'static-skill': { defaultTrigger: 'auto', allowDynamicTrigger: true },
      'codex-explore': { defaultTrigger: 'auto', allowDynamicTrigger: true },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present', 'disabled'],
        refreshKeys: ['explorerModel'],
        skillKey: 'codex-explore',
      }],
    };
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd: repoRoot,
      env,
      values: {
        $aw: {
          skillTriggers: {
            'static-skill': { trigger: 'manual' },
            'codex-explore': { trigger: 'manual' },
          },
        },
      },
    });
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    const artifactPath = path.join(env.AW_HOME!, 'plugins', plugin.manifest.name, 'codex', 'skills', 'codex-explore');
    await fs.outputFile(path.join(artifactPath, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
    const trackedArtifact = createTrackedDynamicSkillArtifact({
      artifactPath,
      refreshKeys: ['explorerModel'],
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
        error: 'old failure',
      },
    });
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'user',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.7',
      skillTriggerPreference: 'manual',
      prepareBundle: async (bundleRoot) => {
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'skills', 'static-skill', 'SKILL.md'),
          'static historical skill\n',
        );
        await fs.outputFile(
          path.join(bundleRoot, 'codex', 'skills', 'static-skill', 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n',
        );
      },
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      await fs.outputFile(path.join(artifactPath, 'SKILL.md'), 'dynamic refreshed skill\n');
      await fs.outputFile(
        path.join(artifactPath, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      );
      return [
        createTrackedDynamicSkillArtifact({
          artifactPath,
          refreshKeys: ['explorerModel'],
        }),
      ];
    });
    codexAdapterInstallPluginFromMarketplace.mockImplementation(async (
      _refreshPlugin: PluginMeta,
      _scope: string,
      options: { marketplacePath?: string },
    ) => {
      const marketplacePath = options.marketplacePath!;
      const stagedRoot = path.dirname(path.dirname(path.dirname(marketplacePath)));
      const stagedPluginRoot = path.join(stagedRoot, 'plugins', plugin.manifest.name);
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'skills', 'static-skill', 'agents', 'openai.yaml'), 'utf8'),
      ).resolves.toContain('allow_implicit_invocation: false');
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'skills', 'codex-explore', 'agents', 'openai.yaml'), 'utf8'),
      ).resolves.toContain('allow_implicit_invocation: false');
      await expect(
        fs.readFile(path.join(stagedPluginRoot, 'codex', 'skills', 'codex-explore', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('dynamic refreshed skill\n');
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'user',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['explorerModel'],
    });
    expect(codexAdapterInstallPluginFromMarketplace).toHaveBeenCalledTimes(1);
  });

  it('blocks staged historical marketplace writes outside registered temp roots and allows them after registration', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-stage-fence-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin('staged-cache');
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    const artifactPath = path.join(env.AW_HOME!, 'plugins', plugin.manifest.name, 'codex', 'skills', 'codex-explore');
    await fs.outputFile(path.join(artifactPath, 'SKILL.md'), 'old runtime skill\n');
    const trackedArtifact = createTrackedDynamicSkillArtifact({
      artifactPath,
      refreshKeys: ['explorerModel'],
    });
    await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'user',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.7',
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async () => {
      await fs.outputFile(path.join(artifactPath, 'SKILL.md'), 'historical refreshed skill\n');
      return [
        createTrackedDynamicSkillArtifact({
          artifactPath,
          refreshKeys: ['explorerModel'],
        }),
      ];
    });

    const isolation = getCurrentSourceTestIsolation();
    const externalTmpRoot = path.join(isolation.layout.rootDir, 'external-artifact-refresh-stage');
    await fs.ensureDir(externalTmpRoot);

    codexAdapterInstallPluginFromMarketplace.mockImplementation(async (
      _refreshPlugin: PluginMeta,
      _scope: string,
      options: { marketplacePath?: string },
    ) => {
      expect(options.marketplacePath).toContain(externalTmpRoot);
    });

    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(externalTmpRoot);
    try {
      await expect(
        reapplyConfigRefresh({
          plugin,
          commandScope: 'user',
          cwd: repoRoot,
          env,
        }),
      ).resolves.toMatchObject({
        attempted: true,
        status: 'failed',
        error: expect.stringContaining('staging root'),
      });

      registerCurrentTestWritableStateRoot(
        externalTmpRoot,
        'artifact refresh staged historical marketplace root',
      );

      await expect(reapplyConfigRefresh({
        plugin,
        commandScope: 'user',
        cwd: repoRoot,
        env,
      })).resolves.toMatchObject({
        attempted: true,
        status: 'succeeded',
      });
    } finally {
      tmpdirSpy.mockRestore();
    }

    expect(codexAdapterInstallPluginFromMarketplace).toHaveBeenCalledTimes(1);
  });

  it('falls back to all tracked refreshKeys when there is no failed artifact and records refresh failures', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin();
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    const artifactPath = path.join(repoRoot, '.codex', 'instructions.md');
    await fs.outputFile(artifactPath, 'before\n');
    const trackedArtifact = createTrackedDynamicArtifact({
      artifactPath,
      refreshKeys: ['mode', 'token'],
      lastRefresh: {
        status: 'succeeded',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['mode'],
      },
    });
    await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'project',
      artifacts: [trackedArtifact],
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (_plugin, _scope, options: { changedConfigKeys?: string[] }) => {
      expect(options.changedConfigKeys).toEqual(['mode', 'token']);
      throw new Error('renderer failed');
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'failed',
      triggerKeys: ['mode', 'token'],
      error: 'renderer failed',
    });
    await expect(readTrackingManifest(codexPaths.trackingDir)).resolves.toMatchObject({
      plugins: {
        [plugin.manifest.name]: {
          artifacts: [
            expect.objectContaining({
              lastRefresh: expect.objectContaining({
                status: 'failed',
                event: 'refresh',
                triggerKeys: ['mode', 'token'],
                error: 'renderer failed',
              }),
            }),
          ],
        },
      },
    });
  });

  it('returns skipped when no tracked dynamic artifact can be located', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));

    const receipt = await reapplyConfigRefresh({
      plugin: createPlugin(),
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });

    expect(receipt).toMatchObject({
      attempted: false,
      status: 'skipped',
      triggerKeys: [],
      artifacts: [],
      reason: 'no-tracked-dynamic-artifact',
    });
    expect(codexAdapterInstallExtensions).not.toHaveBeenCalled();
  });

  it('passes the effective built-in preference to tracked Claude skill refresh', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-claude-skill-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin('dynamic-claude');
    plugin.manifest.marketplace.policy.products = ['CLAUDE'];
    plugin.manifest.skillTriggers = {
      'dynamic-claude': { defaultTrigger: 'auto', allowDynamicTrigger: true },
    };
    plugin.manifest.config = {
      schema: {
        mode: { type: 'string' },
      },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'dynamic-claude-skill',
        platform: 'claude',
        scopes: ['project'],
        target: 'claude.skill',
        kind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'dynamic-claude',
      }],
    };
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      projectLayer: 'shared',
      cwd: repoRoot,
      env,
      values: {
        $aw: {
          skillTriggers: {
            'dynamic-claude': { trigger: 'manual' },
          },
        },
      },
    });
    const claudePaths = resolveClaudePaths(repoRoot, 'project', env);
    const artifactPath = path.join(claudePaths.configDir, 'skills', 'dynamic-claude');
    await fs.outputFile(path.join(artifactPath, 'SKILL.md'), '---\nname: dynamic-claude\ndescription: Dynamic Claude skill.\n---\nBody\n');
    const trackedArtifact: GeneratedArtifact = {
      path: artifactPath,
      paths: [path.join(artifactPath, 'SKILL.md')],
      kind: 'skill',
      platform: 'claude',
      artifactKey: 'dynamic-claude',
      id: 'dynamic-claude-skill',
      target: 'claude.skill',
      state: 'present',
      refreshKeys: [],
      contentDigest: 'sha256:old-content',
      configDigest: 'sha256:old-config',
    };
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      platform: 'claude',
      scope: 'project',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.9',
    });
    await writeTrackingManifest(claudePaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });
    let expectedPreference: SkillTriggerPreference = 'manual';
    claudeAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta, _scope, options: {
      skillTriggerPreference?: SkillTriggerPreference;
      skillTriggerPreferences?: Record<string, SkillTriggerPreference>;
    }) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      expect(options.skillTriggerPreferences?.['dynamic-claude']).toBe(expectedPreference);
      return [{
        ...trackedArtifact,
        contentDigest: 'sha256:new-content',
        configDigest: 'sha256:new-config',
      }];
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });

    expect(receipt.status, receipt.error).toBe('succeeded');
    expect(claudeAdapterInstallExtensions).toHaveBeenCalledTimes(1);

    expectedPreference = 'auto';
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      projectLayer: 'shared',
      cwd: repoRoot,
      env,
      values: {},
    });
    const resetReceipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });
    expect(resetReceipt.status, resetReceipt.error).toBe('succeeded');
    expect(claudeAdapterInstallExtensions).toHaveBeenCalledTimes(2);
  });

  it.each([
    { surface: 'tracking', error: 'injected tracking failure' },
    { surface: 'install-state', error: 'injected install-state failure' },
  ])('restores runtime from install-state when tracking is missing and $surface persistence fails', async ({ surface, error }) => {
    const root = await makeTempRoot('aw-artifact-refresh-transaction-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin('transactional-claude');
    plugin.manifest.marketplace.policy.products = ['CLAUDE'];
    plugin.manifest.skillTriggers = {
      'transactional-claude': { defaultTrigger: 'auto', allowDynamicTrigger: true },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'transactional-claude-skill',
        platform: 'claude',
        scopes: ['project'],
        target: 'claude.skill',
        kind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'transactional-claude',
      }],
    };
    const claudePaths = resolveClaudePaths(repoRoot, 'project', env);
    const artifactPath = path.join(claudePaths.configDir, 'skills', 'transactional-claude');
    const oldSkill = '---\nname: transactional-claude\ndescription: Old skill.\n---\nOld\n';
    const newSkill = '---\nname: transactional-claude\ndescription: New skill.\n---\nNew\n';
    await fs.outputFile(path.join(artifactPath, 'SKILL.md'), oldSkill);
    const trackedArtifact: GeneratedArtifact = {
      path: artifactPath,
      paths: [path.join(artifactPath, 'SKILL.md')],
      kind: 'skill',
      platform: 'claude',
      artifactKey: 'transactional-claude',
      id: 'transactional-claude-skill',
      target: 'claude.skill',
      state: 'present',
      refreshKeys: [],
      contentDigest: 'sha256:old-content',
      configDigest: 'sha256:old-config',
    };
    await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      platform: 'claude',
      scope: 'project',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.7',
    });
    claudeAdapterInstallExtensions.mockImplementation(async (_plugin, _scope, options: {
      previousArtifacts?: GeneratedArtifact[];
    }) => {
      expect(options.previousArtifacts).toEqual([
        expect.objectContaining({
          id: 'transactional-claude-skill',
          contentDigest: 'sha256:old-content',
        }),
      ]);
      await fs.outputFile(path.join(artifactPath, 'SKILL.md'), newSkill);
      return [{
        ...trackedArtifact,
        contentDigest: 'sha256:new-content',
        configDigest: 'sha256:new-config',
      }];
    });
    if (surface === 'tracking') {
      vi.spyOn(tracking, 'writeTrackingManifest').mockRejectedValueOnce(new Error(error));
    } else {
      vi.spyOn(transactions, 'runInstallStateTransaction').mockRejectedValueOnce(new Error(error));
    }

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error).toContain(error);
    await expect(fs.readFile(path.join(artifactPath, 'SKILL.md'), 'utf8')).resolves.toBe(oldSkill);
    const trackingManifest = await readTrackingManifest(claudePaths.trackingDir);
    expect(trackingManifest.plugins[plugin.manifest.name]).toBeUndefined();
    const location: PluginLocation = {
      plugin: plugin.manifest.name,
      platform: 'claude',
      scope: 'project',
      projectKey: await resolveClaudeProjectKey(repoRoot),
    };
    const record = await fs.readJson(getInstallRecordPath(repoRoot, location, env)) as InstallRecordFile;
    expect(record.record.artifacts[0]?.contentDigest).toBe('sha256:old-content');
    const diagnosticCache = await fs.readJson(getDiagnosticCachePath(repoRoot, location, env)) as {
      artifacts: Array<{
        contentDigest?: string;
        lastRefresh?: { status: string; event: string; error?: string };
      }>;
    };
    expect(diagnosticCache.artifacts[0]).toMatchObject({
      contentDigest: 'sha256:old-content',
      lastRefresh: {
        status: 'failed',
        event: 'config',
        error: expect.stringContaining(error),
      },
    });
    if (surface === 'install-state') {
      expect(transactions.runInstallStateTransaction).toHaveBeenCalledTimes(2);
    }
  });

  it('reapplies tracked codex.skill artifacts through the same refresh path', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-skill-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin();
    plugin.manifest.skillTriggers = {
      'codex-explore': { defaultTrigger: 'auto', allowDynamicTrigger: true },
    };
    plugin.manifest.config = {
      schema: {
        explorerModel: { type: 'string' },
        modelReasoningEffort: { type: 'string' },
      },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        skillKey: 'codex-explore',
      }],
    };
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      projectLayer: 'shared',
      cwd: repoRoot,
      env,
      values: {
        $aw: {
          skillTriggers: {
            'codex-explore': { trigger: 'manual' },
          },
        },
      },
    });
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    const artifactPath = path.join(repoRoot, '.agents', 'skills', 'codex-explore');
    await fs.ensureDir(artifactPath);
    const trackedArtifact = createTrackedDynamicSkillArtifact({
      artifactPath,
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      lastRefresh: {
        status: 'failed',
        updatedAt: '2026-05-04T00:00:00.000Z',
        event: 'refresh',
        triggerKeys: ['explorerModel'],
        error: 'old skill failure',
      },
    });
    const historicalBundleRoot = await writeHistoricalInstallRecord({
      root,
      repoRoot,
      env,
      plugin,
      scope: 'project',
      artifacts: [trackedArtifact],
      historicalVersion: '0.0.8',
    });
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [trackedArtifact],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta, _scope, options: {
      changedConfigKeys?: string[];
      skillTriggerPreference?: SkillTriggerPreference;
      skillTriggerPreferences?: Record<string, SkillTriggerPreference>;
    }) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      expect(refreshPlugin.manifest.version).toBe('0.0.8');
      expect(options.changedConfigKeys).toEqual(['explorerModel']);
      expect(options.skillTriggerPreferences?.['codex-explore']).toBe('manual');
      return [
        createTrackedDynamicSkillArtifact({
          artifactPath,
          refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        }),
      ];
    });

    const receipt = await reapplyConfigRefresh({
      plugin,
      commandScope: 'project',
      cwd: repoRoot,
      env,
    });

    expect(receipt.status, receipt.error).toBe('succeeded');
    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['explorerModel'],
      artifacts: [
        expect.objectContaining({
          id: 'codex-explore-skill',
          target: 'codex.skill',
          scope: 'project',
          status: 'succeeded',
        }),
      ],
    });
  });
});
