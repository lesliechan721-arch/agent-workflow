import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getTrackingManifestPath,
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
});
