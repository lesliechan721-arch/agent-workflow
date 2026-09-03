import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import {
  createEmptyPluginIntentState,
  upsertPluginIntentRoot,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePathSource(root: string): Promise<NodeJS.ProcessEnv> {
  const isolation = getCurrentSourceTestIsolation();
  await createCatalogSnapshotFixture(root);
  await fs.writeJson(path.join(root, '.aw-generated.json'), {
    schemaVersion: 1,
    kind: 'catalog',
    workspaceIdentity: 'workspace:cli-source-sync',
    sourceIdentity: `sha256:${crypto.createHash('sha256').update('cli-source-sync').digest('hex')}`,
  }, { spaces: 2 });
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: root }] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  return isolation.env;
}

describe('Catalog source sync CLI', () => {
  it('checks without creating Active, then syncs and reports ready offline status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-sync-cli');
    const env = await configurePathSource(root);

    const checked = await runCliEntry(['catalog', 'source', 'sync', 'local', '--check', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(checked.exitCode, checked.stderr).toBe(0);
    expect(checked.parseJsonStdout()).toMatchObject({
      command: 'catalog:source:sync', ok: true, sourceId: 'local', mode: 'check', outcome: 'checked',
      activeChanged: false,
      impact: { inventoryComplete: true, affectedReferences: [] },
    });
    await expect(fs.pathExists(path.join(env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);

    const beforeStatus = await runCliEntry(['catalog', 'source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(beforeStatus.exitCode).toBe(0);
    expect(beforeStatus.parseJsonStdout()).toMatchObject({
      sources: [{ sourceId: 'local', activeReady: false }],
    });

    const synced = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(synced.exitCode, synced.stderr).toBe(0);
    const syncReceipt = synced.parseJsonStdout();
    expect(syncReceipt).toMatchObject({
      command: 'catalog:source:sync', ok: true, sourceId: 'local', mode: 'sync', outcome: 'activated',
      activeChanged: true,
      active: { snapshotDigest: expect.stringMatching(/^sha256:/u) },
    });

    const status = await runCliEntry(['catalog', 'source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.parseJsonStdout()).toMatchObject({
      sources: [{
        sourceId: 'local', activeReady: true,
        active: { snapshotDigest: syncReceipt.active.snapshotDigest },
        lastSync: { mode: 'sync' },
      }],
    });
  });

  it('repairs an exact damaged Path Active, then requires replacement and impact confirmation for changed content', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-damaged-cli');
    const env = await configurePathSource(root);
    const first = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    const firstActive = first.parseJsonStdout().active;
    const location = resolveCatalogStoreLocation({
      logicalIdentity: firstActive.logicalIdentity,
      snapshotDigest: firstActive.snapshotDigest,
      env,
    });
    await fs.writeFile(location.metadataPath, 'damaged\n');

    const repaired = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(repaired.exitCode, repaired.stderr).toBe(0);
    expect(repaired.parseJsonStdout()).toMatchObject({
      outcome: 'unchanged', activeChanged: false,
      active: { snapshotDigest: firstActive.snapshotDigest },
    });

    await writePluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    }, upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'local/demo', platforms: ['codex'],
    }));
    await fs.remove(root);
    await createCatalogSnapshotFixture(root, 'replacement');
    await fs.writeJson(path.join(root, '.aw-generated.json'), {
      schemaVersion: 1,
      kind: 'catalog',
      workspaceIdentity: 'workspace:cli-source-sync',
      sourceIdentity: `sha256:${crypto.createHash('sha256').update('cli-source-sync').digest('hex')}`,
    }, { spaces: 2 });
    await fs.writeFile(location.metadataPath, 'damaged again\n');

    const replacementRequired = await runCliEntry([
      'catalog', 'source', 'sync', 'local', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env, interactive: false });
    expect(replacementRequired.exitCode).toBe(1);
    expect(replacementRequired.parseJsonStdout()).toMatchObject({
      errors: [{ code: 'catalogReplaceDamagedRequired' }],
    });

    const confirmationRequired = await runCliEntry([
      'catalog', 'source', 'sync', 'local', '--replace-damaged', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env, interactive: false });
    expect(confirmationRequired.exitCode).toBe(1);
    expect(confirmationRequired.parseJsonStdout()).toMatchObject({
      errors: [{ code: 'catalogImpactConfirmationRequired' }],
    });

    const replaced = await runCliEntry([
      'catalog', 'source', 'sync', 'local', '--replace-damaged', '--yes', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env, interactive: false });
    expect(replaced.exitCode, replaced.stderr).toBe(0);
    expect(replaced.parseJsonStdout()).toMatchObject({
      outcome: 'activated', activeChanged: true,
      impact: {
        inventoryComplete: false,
        references: [{ category: 'lifecycle', pluginId: 'local/demo' }],
        affectedReferences: [],
      },
    });
  });

  it('does not expose removed rollout commands and keeps the old Active after sync fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-sync-failure');
    const env = await configurePathSource(root);
    const first = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(first.exitCode).toBe(0);
    const activeDigest = first.parseJsonStdout().active.snapshotDigest;
    await fs.remove(root);

    const failed = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(failed.exitCode).toBe(1);
    const status = await runCliEntry(['catalog', 'source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(status.parseJsonStdout()).toMatchObject({
      sources: [{ activeReady: true, active: { snapshotDigest: activeDigest } }],
    });

    for (const command of ['refresh', 'activate-candidate', 'generation-status', 'refresh-policy']) {
      const removed = await runCliEntry(['catalog', 'source', command, 'local'], {
        cwd: isolation.layout.fixtureCwd, env, interactive: false,
      });
      expect(removed.exitCode).toBe(1);
    }
  });
});
