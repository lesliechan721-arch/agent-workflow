import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

const codexAdapterStatus = vi.fn(async () => ({
  plugins: [{ managedArtifacts: [] }],
}));
const codexAdapterInstallExtensions = vi.fn();

vi.mock('../../src/adapters/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(() => ({
    status: codexAdapterStatus,
    installExtensions: codexAdapterInstallExtensions,
  })),
}));

vi.mock('../../src/commands/codex-project-safety.js', () => ({
  preflightCodexProjectWriteSafety: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/local-marketplace.js', () => ({
  getLocalMarketplaceCodexSkillRoot: (rootDir: string, pluginName: string, skillKey: string) =>
    path.join(rootDir, 'plugins', pluginName, 'codex', 'skills', skillKey),
  readInstalledLedger: vi.fn(async () => ({ plugins: {} })),
}));

import { reapplyConfigRefresh } from '../../src/utils/artifact-refresh.js';
import type { GeneratedArtifact, PluginMeta } from '../../src/types.js';
import type { InstallRecordFile, PluginLocation } from '../../src/install-state/types.js';
import { getInstallRecordPath } from '../../src/install-state/paths.js';
import { stageHistoricalLifecycleRuntime } from '../../src/install-state/runtime-state.js';
import { resolveCodexPaths, resolveCodexProjectKey } from '../../src/utils/paths.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';
import { readTrackingManifest, writeTrackingManifest } from '../../src/utils/tracking.js';

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
  lastRefresh?: GeneratedArtifact['lastRefresh'];
}): GeneratedArtifact {
  return {
    path: options.artifactPath,
    kind: 'skill',
    platform: 'codex',
    artifactKey: 'codex-explore',
    id: 'codex-explore-skill',
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
  historicalVersion?: string;
}): Promise<string> {
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

  const [manifestDigest, bundleFingerprint] = await Promise.all([
    calculateFileDigest(sourceManifestPath),
    calculatePluginBundleFingerprint(sourceBundleRoot),
  ]);
  const location: PluginLocation = {
    plugin: options.plugin.manifest.name,
    platform: 'codex',
    scope: options.scope,
    ...(options.scope === 'project'
      ? { projectKey: await resolveCodexProjectKey(options.repoRoot) }
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
      platform: 'codex',
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
      lifecycle: runtimeStage.runtimeRef,
      artifacts: options.artifacts.map((artifact) => ({
        kind: artifact.kind,
        platform: artifact.platform,
        path: artifact.path,
        ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
        ...(artifact.id === undefined ? {} : { id: artifact.id }),
        ...(artifact.target === undefined ? {} : { target: artifact.target }),
        ...(artifact.state === undefined ? {} : { state: artifact.state }),
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('artifact refresh reapply helper', () => {
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

    expect(receipt).toMatchObject({
      attempted: true,
      status: 'succeeded',
      triggerKeys: ['token'],
    });
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

  it('reapplies tracked codex.skill artifacts through the same refresh path', async () => {
    const root = await makeTempRoot('aw-artifact-refresh-skill-');
    const repoRoot = path.join(root, 'repo');
    const env = {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    } as NodeJS.ProcessEnv;
    await fs.ensureDir(path.join(repoRoot, '.git'));
    const plugin = createPlugin();
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

    codexAdapterInstallExtensions.mockImplementation(async (refreshPlugin: PluginMeta, _scope, options: { changedConfigKeys?: string[] }) => {
      expect(refreshPlugin.rootDir).toBe(historicalBundleRoot);
      expect(refreshPlugin.manifest.version).toBe('0.0.8');
      expect(options.changedConfigKeys).toEqual(['explorerModel']);
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
