import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import {
  createCatalogSnapshotFixture,
  rewriteActiveCatalogCapabilities,
} from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function writeCliSourceSnapshot(root: string, readme = 'demo\n'): Promise<void> {
  await createCatalogSnapshotFixture(root, 'demo', [], readme);
  await fs.writeJson(path.join(root, '.aw-generated.json'), {
    schemaVersion: 1,
    kind: 'catalog',
    workspaceIdentity: 'workspace:cli-source-sync',
    sourceIdentity: `sha256:${crypto.createHash('sha256').update('cli-source-sync').digest('hex')}`,
  }, { spaces: 2 });
}

async function configurePathSource(root: string): Promise<NodeJS.ProcessEnv> {
  const isolation = getCurrentSourceTestIsolation();
  await writeCliSourceSnapshot(root);
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: root }] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  return isolation.env;
}

describe('Catalog source sync CLI', () => {
  it('repairs a damaged inactive candidate during ordinary sync without repair flags', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-inactive-repair-cli');
    const env = await configurePathSource(root);
    const first = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(first.exitCode, first.stderr).toBe(0);
    await writeCliSourceSnapshot(root, 'inactive candidate\n');
    const candidate = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(candidate.exitCode, candidate.stderr).toBe(0);
    await writeCliSourceSnapshot(root);
    const active = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(active.exitCode, active.stderr).toBe(0);
    expect(active.parseJsonStdout().data.active.snapshotDigest)
      .toBe(first.parseJsonStdout().data.active.snapshotDigest);
    const candidateActive = candidate.parseJsonStdout().data.active;
    const candidateLocation = resolveCatalogStoreLocation({
      logicalIdentity: candidateActive.logicalIdentity,
      snapshotDigest: candidateActive.snapshotDigest,
      env,
    });
    await fs.writeFile(candidateLocation.metadataPath, 'damaged inactive entry\n');
    await writeCliSourceSnapshot(root, 'inactive candidate\n');

    const repaired = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });

    expect(repaired.exitCode, repaired.stderr).toBe(0);
    expect(repaired.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'success',
      command: 'source.sync',
      data: {
        outcome: 'activated',
        activeChanged: true,
        active: { snapshotDigest: candidateActive.snapshotDigest }
      }
    });
    await expect(fs.readJson(candidateLocation.metadataPath)).resolves.toMatchObject({
      snapshotDigest: candidateActive.snapshotDigest,
    });
  });

  it('checks without creating Active, then syncs and reports ready offline status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-sync-cli');
    const env = await configurePathSource(root);

    const checked = await runCliEntry(['source', 'status', 'local', '--remote', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(checked.exitCode, checked.stderr).toBe(0);
    expect(checked.parseJsonStdout()).toMatchObject({
      schemaVersion: 1, command: 'source.status', status: 'success',
      data: {
        sources: [{ sourceId: 'local', activeReady: false }],
        remote: [{ sourceId: 'local', checked: true, outcome: 'checked' }],
        complete: true,
      },
    });
    await expect(fs.pathExists(path.join(env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);

    const beforeStatus = await runCliEntry(['source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(beforeStatus.exitCode).toBe(0);
    expect(beforeStatus.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      data: { sources: [{ sourceId: 'local', activeReady: false }] }
    });

    const synced = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(synced.exitCode, synced.stderr).toBe(0);
    const syncReceipt = synced.parseJsonStdout();
    expect(syncReceipt).toMatchObject({
      schemaVersion: 1,
      status: 'success',
      command: 'source.sync',
      data: {
        sourceId: 'local',
        mode: 'sync',
        outcome: 'activated',
        activeChanged: true,
        active: { snapshotDigest: expect.stringMatching(/^sha256:/u) }
      }
    });

    const status = await runCliEntry(['source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      data: {
        sources: [{
          sourceId: 'local', activeReady: true,
          active: { snapshotDigest: syncReceipt.data.active.snapshotDigest },
          lastSync: { mode: 'sync' },
        }]
      }
    });
  });

  it('reports a healthy incompatible Active without exposing available capabilities', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-incompatible-cli');
    const env = await configurePathSource(root);
    const synced = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(synced.exitCode, synced.stderr).toBe(0);
    await rewriteActiveCatalogCapabilities({
      sourceId: 'local',
      requiredCapabilities: ['aw.catalog-snapshot.v7', 'aw.future-feature.v99'],
      env,
    });

    const jsonStatus = await runCliEntry(['source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(jsonStatus.exitCode, jsonStatus.stderr).toBe(0);
    const receipt = jsonStatus.parseJsonStdout();
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      data: {
        sources: [{
          sourceId: 'local',
          activeReady: false,
          compatibility: {
            state: 'unsupported',
            requiredCapabilities: ['aw.catalog-snapshot.v7', 'aw.future-feature.v99'],
            missingCapabilities: ['aw.future-feature.v99'],
          },
        }]
      }
    });
    expect(receipt.data.sources[0].compatibility).not.toHaveProperty('availableCapabilities');

    const humanStatus = await runCliEntry(['source', 'status', 'local'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(humanStatus.exitCode, humanStatus.stderr).toBe(0);
    expect(humanStatus.stdout.toLowerCase()).toContain('incompatible');
    expect(humanStatus.stdout).toContain('required: aw.catalog-snapshot.v7, aw.future-feature.v99');
    expect(humanStatus.stdout).toContain('missing: aw.future-feature.v99');
  });

  it('repairs an exact damaged Path Active, then requires replacement and impact confirmation for changed content', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-damaged-cli');
    const env = await configurePathSource(root);
    const first = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    const firstActive = first.parseJsonStdout().data.active;
    const location = resolveCatalogStoreLocation({
      logicalIdentity: firstActive.logicalIdentity,
      snapshotDigest: firstActive.snapshotDigest,
      env,
    });
    await fs.writeFile(location.metadataPath, 'damaged\n');

    const repaired = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(repaired.exitCode, repaired.stderr).toBe(0);
    expect(repaired.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      data: {
        outcome: 'unchanged',
        activeChanged: false,
        active: { snapshotDigest: firstActive.snapshotDigest }
      }
    });

    await writeIntentFixture({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    }, { roots: [{ pluginId: 'local/demo', platforms: ['codex'] }] });
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
      'source', 'sync', 'local', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env, interactive: false });
    expect(replacementRequired.exitCode).toBe(3);
    expect(replacementRequired.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      diagnostics: [{ code: 'catalogReplaceDamagedRequired' }],
      data: {}
    });

    const confirmationRequired = await runCliEntry([
      'source', 'sync', 'local', '--replace-damaged', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env, interactive: false });
    expect(confirmationRequired.exitCode).toBe(3);
    expect(confirmationRequired.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
      data: {}
    });

    const replaced = await runCliEntry([
      'source', 'sync', 'local', '--replace-damaged', '--yes', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env, interactive: false });
    expect(replaced.exitCode, replaced.stderr).toBe(0);
    expect(replaced.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      data: {
        outcome: 'activated',
        activeChanged: true,
        impact: {
          inventoryComplete: false,
          references: [{ category: 'lifecycle', pluginId: 'local/demo' }],
          affectedReferences: [],
        }
      }
    });
  });

  it('does not expose removed rollout commands and keeps the old Active after sync fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-sync-failure');
    const env = await configurePathSource(root);
    const first = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(first.exitCode).toBe(0);
    const activeDigest = first.parseJsonStdout().data.active.snapshotDigest;
    await fs.remove(root);

    const failed = await runCliEntry(['source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(failed.exitCode).toBe(3);
    const status = await runCliEntry(['source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(status.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      data: { sources: [{ activeReady: true, active: { snapshotDigest: activeDigest } }] }
    });

    for (const command of ['refresh', 'activate-candidate', 'generation-status', 'refresh-policy']) {
      const removed = await runCliEntry(['source', command, 'local'], {
        cwd: isolation.layout.fixtureCwd, env, interactive: false,
      });
      expect(removed.exitCode).toBe(2);
    }
  });
});
