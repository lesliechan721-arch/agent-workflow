import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getTrackingManifestPath,
  getTrackingArtifactIntegrityErrors,
  getTrackingRecord,
  hasTrackingArtifacts,
  readTrackingManifest,
  readTrackingRecord,
  removeTrackingRecord,
  removeTrackingRecordFromManifest,
  upsertTrackingRecord,
  upsertTrackingRecordInManifest,
  writeTrackingManifest,
} from '../../src/utils/tracking.js';

const tempDirs: string[] = [];

async function makeTrackingDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tracking-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('tracking utils', () => {
  it('reads an empty manifest and persists tracking records to disk', async () => {
    const targetDir = await makeTrackingDir();
    const artifacts = [{
      path: path.join(targetDir, 'instruction.md'),
      kind: 'instruction' as const,
      platform: 'claude' as const,
    }];

    await expect(readTrackingManifest(targetDir)).resolves.toEqual({
      version: 1,
      plugins: {},
    });

    await upsertTrackingRecord(targetDir, 'git-commit', artifacts);

    const manifest = await readTrackingManifest(targetDir);
    const record = await readTrackingRecord(targetDir, 'git-commit');

    expect(getTrackingManifestPath(targetDir)).toBe(
      path.join(targetDir, '.agent-workflows-manifest.json'),
    );
    expect(getTrackingRecord(manifest, 'git-commit')).toMatchObject({
      name: 'git-commit',
      artifacts,
    });
    expect(record).toMatchObject({
      name: 'git-commit',
      artifacts,
    });
    expect(hasTrackingArtifacts(record)).toBe(true);
    expect(hasTrackingArtifacts(record, 'instruction')).toBe(true);
    expect(hasTrackingArtifacts(record, 'hook')).toBe(false);
    expect(hasTrackingArtifacts(undefined, 'instruction')).toBe(false);
  });

  it('updates and removes tracking records with both pure helpers and file helpers', async () => {
    const targetDir = await makeTrackingDir();
    const baseManifest = {
      version: 1 as const,
      plugins: {},
    };
    const manifestWithRecord = upsertTrackingRecordInManifest(baseManifest, 'git-commit', [
      {
        path: path.join(targetDir, 'settings.json'),
        kind: 'permission' as const,
        platform: 'claude' as const,
      },
    ]);

    expect(manifestWithRecord.plugins['git-commit']).toMatchObject({
      name: 'git-commit',
    });

    await writeTrackingManifest(targetDir, manifestWithRecord);
    await removeTrackingRecord(targetDir, 'git-commit');

    await expect(readTrackingRecord(targetDir, 'git-commit')).resolves.toBeUndefined();
    expect(removeTrackingRecordFromManifest(manifestWithRecord, 'git-commit')).toEqual({
      version: 1,
      plugins: {},
    });
  });

  it('persists artifact-aware metadata for multiple dynamic artifacts sharing one file', async () => {
    const targetDir = await makeTrackingDir();
    const configPath = path.join(targetDir, '.codex', 'config.toml');
    const rolePath = path.join(targetDir, '.codex', 'agents', 'aw-plugin-codex-explorer.toml');
    const artifacts = [
      {
        path: configPath,
        paths: [configPath],
        kind: 'instruction' as const,
        platform: 'codex' as const,
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock' as const,
        state: 'present' as const,
        refreshKeys: ['mode'],
        configDigest: 'sha256:config-a',
        contentDigest: 'sha256:content-a',
      },
      {
        path: configPath,
        paths: [configPath],
        kind: 'instruction' as const,
        platform: 'codex' as const,
        id: 'instruction-b',
        target: 'codex.developerInstructionsBlock' as const,
        state: 'disabled' as const,
        disabledReason: 'config',
        refreshKeys: ['mode'],
        configDigest: 'sha256:config-b',
        contentDigest: 'sha256:content-b',
      },
      {
        path: rolePath,
        paths: [configPath, rolePath],
        kind: 'agent' as const,
        platform: 'codex' as const,
        artifactKey: 'codex-explorer',
        id: 'codex-explorer-role',
        target: 'codex.agentRole' as const,
        state: 'present' as const,
        refreshKeys: ['explorerModel'],
        configDigest: 'sha256:config-role',
        contentDigest: 'sha256:content-role',
        roleKey: 'codex-explorer',
      },
    ];

    await upsertTrackingRecord(targetDir, 'dynamic-artifacts', artifacts);

    const record = await readTrackingRecord(targetDir, 'dynamic-artifacts');
    expect(record?.artifacts).toEqual(artifacts);
    expect(record?.artifacts.map((artifact) => artifact.id)).toEqual([
      'instruction-a',
      'instruction-b',
      'codex-explorer-role',
    ]);
    expect(record?.artifacts.map((artifact) => artifact.target)).toEqual([
      'codex.developerInstructionsBlock',
      'codex.developerInstructionsBlock',
      'codex.agentRole',
    ]);
    expect(record?.artifacts.map((artifact) => artifact.state)).toEqual([
      'present',
      'disabled',
      'present',
    ]);
    expect(record?.artifacts[1]).toMatchObject({
      refreshKeys: ['mode'],
      paths: [configPath],
      contentDigest: 'sha256:content-b',
    });
    expect(record?.artifacts[2]).toMatchObject({
      roleKey: 'codex-explorer',
      paths: [configPath, rolePath],
      configDigest: 'sha256:config-role',
      contentDigest: 'sha256:content-role',
    });
  });

  it('preserves refresh metadata when rewriting an existing tracked artifact identity', async () => {
    const targetDir = await makeTrackingDir();
    const configPath = path.join(targetDir, '.codex', 'config.toml');
    await upsertTrackingRecord(targetDir, 'dynamic-artifacts', [
      {
        path: configPath,
        paths: [configPath],
        kind: 'instruction',
        platform: 'codex',
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        refreshKeys: ['enableLightweightInstruction'],
        configDigest: 'sha256:before-config',
        contentDigest: 'sha256:before-content',
        lastRefresh: {
          status: 'failed',
          updatedAt: '2026-05-04T08:00:00.000Z',
          triggerKeys: ['enableLightweightInstruction'],
          event: 'refresh',
          error: 'renderer failed',
        },
        refreshReach: {
          commandScope: 'user',
          refreshedUserTarget: true,
          refreshedCurrentProjectTarget: false,
          scannedHistoricalProjects: false,
          historicalProjectTargetsMayBeStale: true,
          knownProjectTargetsOutsideReach: ['project:/repo-a'],
        },
      },
    ]);

    await upsertTrackingRecord(targetDir, 'dynamic-artifacts', [
      {
        path: configPath,
        paths: [configPath],
        kind: 'instruction',
        platform: 'codex',
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        refreshKeys: ['enableLightweightInstruction'],
        configDigest: 'sha256:after-config',
        contentDigest: 'sha256:after-content',
      },
    ]);

    await expect(readTrackingRecord(targetDir, 'dynamic-artifacts')).resolves.toMatchObject({
      artifacts: [{
        path: configPath,
        configDigest: 'sha256:after-config',
        contentDigest: 'sha256:after-content',
        lastRefresh: {
          status: 'failed',
          updatedAt: '2026-05-04T08:00:00.000Z',
          triggerKeys: ['enableLightweightInstruction'],
          event: 'refresh',
          error: 'renderer failed',
        },
        refreshReach: {
          commandScope: 'user',
          refreshedUserTarget: true,
          refreshedCurrentProjectTarget: false,
          scannedHistoricalProjects: false,
          historicalProjectTargetsMayBeStale: true,
          knownProjectTargetsOutsideReach: ['project:/repo-a'],
        },
      }],
    });
  });

  it('rejects invalid refresh metadata when reading or writing tracking manifests', async () => {
    const targetDir = await makeTrackingDir();
    const validPath = path.join(targetDir, '.codex', 'config.toml');

    await fs.writeJson(getTrackingManifestPath(targetDir), {
      version: 1,
      plugins: {
        broken: {
          name: 'broken',
          generatedAt: '2026-05-04T08:00:00.000Z',
          artifacts: [{
            path: validPath,
            kind: 'instruction',
            platform: 'codex',
            lastRefresh: {
              status: 'broken',
              updatedAt: '2026-05-04T08:00:00.000Z',
              event: 'refresh',
            },
          }],
        },
      },
    }, { spaces: 2 });

    await expect(readTrackingManifest(targetDir)).rejects.toThrow(
      'unsupported tracking artifact shape',
    );

    await expect(writeTrackingManifest(targetDir, {
      version: 1,
      plugins: {
        broken: {
          name: 'broken',
          generatedAt: '2026-05-04T08:00:00.000Z',
          artifacts: [{
            path: validPath,
            kind: 'instruction',
            platform: 'codex',
            refreshReach: {
              commandScope: 'workspace',
            },
          }],
        },
      },
    } as unknown as Awaited<ReturnType<typeof readTrackingManifest>>)).rejects.toThrow(
      'unsupported tracking artifact shape',
    );
  });

  it('marks skill and MCP tracking artifacts without artifactKey as integrity errors', () => {
    const errors = getTrackingArtifactIntegrityErrors([
      {
        path: '/repo/.agents/skills/commit',
        kind: 'skill',
        platform: 'codex',
      },
      {
        path: '/repo/.codex/config.toml',
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'acme.tools v1',
      },
      {
        path: '/repo/.codex/config.toml',
        kind: 'mcpServer',
        platform: 'codex',
      },
    ]);

    expect(errors).toEqual([
      {
        code: 'missingArtifactKey',
        kind: 'skill',
        platform: 'codex',
        path: '/repo/.agents/skills/commit',
        message: 'Tracking artifact kind "skill" requires artifactKey: /repo/.agents/skills/commit',
      },
      {
        code: 'missingArtifactKey',
        kind: 'mcpServer',
        platform: 'codex',
        path: '/repo/.codex/config.toml',
        message: 'Tracking artifact kind "mcpServer" requires artifactKey: /repo/.codex/config.toml',
      },
    ]);
  });

  it('rejects new tracking writes whose artifact paths are not absolute', async () => {
    const targetDir = await makeTrackingDir();

    await expect(
      upsertTrackingRecord(targetDir, 'git-commit', [
        {
          path: './relative-skill',
          kind: 'skill',
          platform: 'codex',
          artifactKey: 'commit',
        },
      ]),
    ).rejects.toThrow('Tracking artifact path must be absolute');

    await expect(
      upsertTrackingRecord(targetDir, 'git-commit', [
        {
          path: path.join(targetDir, 'absolute-skill'),
          paths: ['./relative-config.toml'],
          kind: 'skill',
          platform: 'codex',
          artifactKey: 'commit',
        },
      ]),
    ).rejects.toThrow('Tracking artifact path must be absolute');
  });
});
