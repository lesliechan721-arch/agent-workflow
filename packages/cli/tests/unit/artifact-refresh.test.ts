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
  readInstalledLedger: vi.fn(async () => ({ plugins: {} })),
}));

import { reapplyConfigRefresh } from '../../src/utils/artifact-refresh.js';
import type { GeneratedArtifact, PluginMeta } from '../../src/types.js';
import { resolveCodexPaths } from '../../src/utils/paths.js';
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
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [
            createTrackedDynamicArtifact({
              artifactPath,
              refreshKeys: ['mode', 'token'],
              lastRefresh: {
                status: 'failed',
                updatedAt: '2026-05-04T00:00:00.000Z',
                event: 'refresh',
                triggerKeys: ['token'],
                error: 'old failure',
              },
            }),
          ],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (_plugin, _scope, options: { changedConfigKeys?: string[] }) => {
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
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [
            createTrackedDynamicArtifact({
              artifactPath,
              refreshKeys: ['mode', 'token'],
              lastRefresh: {
                status: 'succeeded',
                updatedAt: '2026-05-04T00:00:00.000Z',
                event: 'refresh',
                triggerKeys: ['mode'],
              },
            }),
          ],
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
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-05T00:00:00.000Z',
          artifacts: [
            createTrackedDynamicSkillArtifact({
              artifactPath,
              refreshKeys: ['explorerModel', 'modelReasoningEffort'],
              lastRefresh: {
                status: 'failed',
                updatedAt: '2026-05-04T00:00:00.000Z',
                event: 'refresh',
                triggerKeys: ['explorerModel'],
                error: 'old skill failure',
              },
            }),
          ],
        },
      },
    });

    codexAdapterInstallExtensions.mockImplementation(async (_plugin, _scope, options: { changedConfigKeys?: string[] }) => {
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
