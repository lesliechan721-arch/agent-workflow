import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { syncCatalogSourceCommand } from '../../src/commands/catalog-generation.js';
import {
  executeCatalogStoreTask,
  inspectCatalogStoreTask,
  prepareCatalogStoreTask,
} from '../../src/tui/catalog-store-task.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const OLD_FORMAL = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
const OLD_TEMP = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);

async function setTreeTime(root: string, date: Date): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const child of await fs.readdir(root)) await setTreeTime(path.join(root, child), date);
  }
  await fs.utimes(root, date, date);
}

async function writeSnapshot(root: string, readme: string): Promise<void> {
  await fs.remove(root);
  await createCatalogSnapshotFixture(root, 'demo', [], readme);
  const markerPath = path.join(root, '.aw-generated.json');
  const marker = await fs.readJson(markerPath) as Record<string, unknown>;
  await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'tui-catalog-store-task-test' });
}

describe('TUI Catalog store task backend', () => {
  it('binds execution to the exact reclaimable items in the prepared preview', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'tui-catalog-store-task');
    await writeSnapshot(root, 'first\n');
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: root }],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    const first = (await syncCatalogSourceCommand({
      sourceId: 'local', cliVersion: '0.1.0', cwd: path.dirname(root), env: isolation.env,
    })).active!;
    const firstLocation = resolveCatalogStoreLocation({ ...first, env: isolation.env });
    await writeSnapshot(root, 'second\n');
    await syncCatalogSourceCommand({
      sourceId: 'local', cliVersion: '0.1.0', cwd: path.dirname(root), env: isolation.env,
    });
    await setTreeTime(firstLocation.entryDir, OLD_FORMAL);

    const overview = await inspectCatalogStoreTask({ env: isolation.env, now: NOW });
    expect(overview.totals.reclaimableEntries).toBe(1);

    const evidence = await prepareCatalogStoreTask({ env: isolation.env, now: NOW });
    expect(evidence.preview.deleted).toEqual([]);
    expect(evidence.authorizedItems).toEqual([{
      storeKey: firstLocation.storeKey,
      category: 'entry',
    }]);

    const addedName = '.replacement-44444444-4444-4444-8444-444444444444.tmp';
    const addedPath = path.join(firstLocation.logicalIdentityDirectory, addedName);
    await fs.copy(firstLocation.entryDir, addedPath);
    await setTreeTime(addedPath, OLD_TEMP);
    const addedStoreKey = `${firstLocation.storeKey.split('/')[0]!}/${addedName}`;

    const result = await executeCatalogStoreTask({
      authorizedItems: evidence.authorizedItems,
      env: isolation.env,
      now: NOW,
    });

    expect(result.deleted).toEqual([{
      storeKey: firstLocation.storeKey,
      bytes: expect.any(Number),
    }]);
    expect(result.retained).toContainEqual({
      storeKey: addedStoreKey,
      reason: 'temporaryOlderThan24Hours',
    });
    await expect(fs.pathExists(firstLocation.entryDir)).resolves.toBe(false);
    await expect(fs.pathExists(addedPath)).resolves.toBe(true);
  });
});
