import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import type { CatalogGenerationProviderSet } from '../../src/utils/catalog-generation-service.js';
import {
  readCatalogGenerationStatus,
  syncCatalogSourceGeneration,
} from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import {
  calculateCatalogSourcesConfigDigest,
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

async function configurePathSource(sourcePath: string): Promise<void> {
  const isolation = getCurrentSourceTestIsolation();
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  const config = {
    schemaVersion: 2 as const,
    sources: [{ id: 'team', type: 'path' as const, path: sourcePath, primary: true }],
  };
  expect(calculateCatalogSourcesConfigDigest(config)).not.toBe('');
  await replaceCatalogSourcesConfig({ config, expectedDigest: current.digest, env: isolation.env });
}

describe('Catalog Active store and state', () => {
  it('checks a provider snapshot without writing store or Active', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('check-only');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);

    const result = await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      check: true,
      env: isolation.env,
    });

    expect(result).toMatchObject({ mode: 'check', outcome: 'checked', activeChanged: false });
    expect((await readCatalogGenerationState(isolation.env)).sources.team).toEqual({
      lastSync: expect.objectContaining({ mode: 'check', state: 'succeeded' }),
    });
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);
    await expect(readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({ sources: [{ activeReady: false, configMatchesActive: false }] });
  });

  it('publishes an immutable store entry before atomically selecting Active', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('first-sync');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);

    const result = await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
    });
    const state = await readCatalogGenerationState(isolation.env);
    const status = await readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env });

    expect(result).toMatchObject({ mode: 'sync', outcome: 'activated', activeChanged: true });
    expect(state.sources.team).toEqual({ active: result.active, lastSync: result.lastSync });
    expect(status.sources[0]).toMatchObject({ activeReady: true, configMatchesActive: true });
    const storeRoot = path.join(isolation.env.AW_HOME!, 'catalog-store');
    const metadataFiles = (await fs.readdir(storeRoot)).flatMap((identity) => [
      path.join(storeRoot, identity, result.active!.snapshotDigest.slice('sha256:'.length), 'metadata.json'),
    ]);
    expect(metadataFiles).toHaveLength(1);
    await expect(fs.readJson(metadataFiles[0]!)).resolves.toMatchObject({
      logicalIdentity: result.active!.logicalIdentity,
      snapshotDigest: result.active!.snapshotDigest,
    });
  });

  it('keeps the previous Active and records only a safe error code when sync fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('failed-sync');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const before = (await readCatalogGenerationState(isolation.env)).sources.team!.active;
    const secret = 'do-not-persist-provider-detail';
    const providers: CatalogGenerationProviderSet = {
      git: async () => { throw new Error('unused'); },
      path: async () => { throw new Error(secret); },
    };

    await expect(syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: { providers },
    })).rejects.toMatchObject({ code: 'catalogGenerationRefreshFailed' });

    const state = await readCatalogGenerationState(isolation.env);
    expect(state.sources.team!.active).toEqual(before);
    expect(state.sources.team!.lastSync).toMatchObject({
      mode: 'sync',
      state: 'failed',
      errorCode: 'catalogGenerationRefreshFailed',
    });
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it('reuses identical content and does not create Candidate, cache, or publication records', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('store-reuse');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const first = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const second = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    expect(second).toMatchObject({ outcome: 'unchanged', activeChanged: false });
    expect(second.active!.activatedAt).toBe(first.active!.activatedAt);
    const sourceState = (await readCatalogGenerationState(isolation.env)).sources.team!;
    expect(Object.keys(sourceState).sort()).toEqual(['active', 'lastSync']);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-cache'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-generations'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-published-versions'))).resolves.toBe(false);
  });

  it('resolves ordinary operation context from Active while provider access is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('offline-active');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const synced = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    await fs.remove(sourceRoot);

    const context = await resolveCatalogOperationContext({ env: isolation.env });
    expect(context.generationSet.sources[0]).toMatchObject({
      sourceId: 'team',
      snapshotDigest: synced.active!.snapshotDigest,
    });
  });
});
