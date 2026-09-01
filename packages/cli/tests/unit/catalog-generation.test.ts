import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogGenerationProviderSet } from '../../src/utils/catalog-generation-service.js';
import { addCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import {
  activateCatalogSourceGeneration,
  probeCatalogSourceGeneration,
  readCatalogGenerationStatus,
  repairCatalogSourceGeneration,
  syncCatalogSourceGeneration,
} from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import {
  createCatalogStoreKey,
  resolveCatalogStoreLocation,
} from '../../src/utils/catalog-generation-store.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
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
  it('hashes logical identities into fixed, case-sensitive store segments', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const identity = '团队/https://例.example/a?b=c'.repeat(40);
    const segment = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

    expect(createCatalogStoreKey(identity, digest)).toBe(`${segment(identity)}/${'a'.repeat(64)}`);
    expect(createCatalogStoreKey('Catalog', digest)).not.toBe(createCatalogStoreKey('catalog', digest));
  });

  it.each(['.', '..'])('syncs logical identity %j only into its two-level store entry', async (logicalIdentity) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath(`dot-identity-${logicalIdentity.length}`);
    await createCatalogSnapshotFixture(sourceRoot);
    const markerPath = path.join(sourceRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as Record<string, unknown>;
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: logicalIdentity }, { spaces: 2 });
    await configurePathSource(sourceRoot);

    const result = await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
    });
    const location = resolveCatalogStoreLocation({
      logicalIdentity,
      snapshotDigest: result.active!.snapshotDigest,
      env: isolation.env,
    });
    const relativeEntry = path.relative(location.storeRootDir, location.entryDir);
    const status = await readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env });

    expect(relativeEntry.split(path.sep)).toEqual([
      crypto.createHash('sha256').update(logicalIdentity, 'utf8').digest('hex'),
      result.active!.snapshotDigest.slice('sha256:'.length),
    ]);
    expect(status.sources[0]).toMatchObject({
      active: result.active,
      storeKey: location.storeKey,
      activeReady: true,
      configMatchesActive: true,
    });
    expect(location.storeKey.split('/')).not.toContain('.');
    expect(location.storeKey.split('/')).not.toContain('..');
    await expect(fs.pathExists(location.metadataPath)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      result.active!.snapshotDigest.slice('sha256:'.length),
    ))).resolves.toBe(false);
  });

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

  it('probes candidate evidence without writing state or store and cleans provider staging', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('pure-probe');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);

    const result = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    expect(result.candidate).toMatchObject({
      sourceConfigFingerprint: expect.stringMatching(/^sha256:/u),
      sourceIdentity: expect.stringMatching(/^sha256:/u),
      logicalIdentity: expect.any(String),
      requestedRef: 'path',
      resolvedCommit: expect.stringMatching(/^path:sha256:/u),
      catalogVersion: '1.0.0',
      channel: 'latest',
      manifestDigest: expect.stringMatching(/^sha256:/u),
      snapshotDigest: expect.stringMatching(/^sha256:/u),
    });
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-state.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);
    await expect(fs.readdir(path.join(isolation.env.AW_HOME!, 'tmp'))).resolves.toEqual([]);
  });

  it('blocks a logical identity change while source config identity is continuous', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('logical-continuity');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const first = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const markerPath = path.join(sourceRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as Record<string, unknown>;
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'replacement-workspace' }, { spaces: 2 });

    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogLogicalIdentityChanged' });
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active)
      .toEqual(first.active);
  });

  it('rejects stale expected candidate evidence before store publication', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('stale-review');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const probe = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const markerPath = path.join(sourceRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as Record<string, unknown>;
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'changed-after-review' }, { spaces: 2 });

    await expect(activateCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', expectedCandidate: probe.candidate,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationReviewStale' });
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);
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

  it('does not hold the AW_HOME mutation lock while a provider is waiting', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('slow-provider');
    const otherRoot = fixturePath('concurrent-source');
    await createCatalogSnapshotFixture(sourceRoot);
    await createCatalogSnapshotFixture(otherRoot);
    await configurePathSource(sourceRoot);
    let enterProvider!: () => void;
    let releaseProvider!: () => void;
    const providerEntered = new Promise<void>((resolve) => { enterProvider = resolve; });
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providers: CatalogGenerationProviderSet = {
      git: async () => { throw new Error('unused'); },
      path: async (source, options) => {
        enterProvider();
        await providerRelease;
        return catalogPathProviderInternal.resolve(source, options);
      },
    };
    const syncing = syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime: { providers },
    });
    await providerEntered;

    await expect(addCatalogSourceCommand({
      source: { id: 'other', type: 'path', path: otherRoot, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true });
    releaseProvider();
    await expect(syncing).resolves.toMatchObject({ outcome: 'activated' });
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

  it('repairs only the damaged current Active store entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('exact-repair');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const synced = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const location = resolveCatalogStoreLocation({
      logicalIdentity: synced.active!.logicalIdentity,
      snapshotDigest: synced.active!.snapshotDigest,
      env: isolation.env,
    });
    const sibling = path.join(location.logicalIdentityDirectory, 'unrelated-entry');
    await fs.outputFile(sibling, 'keep');
    await fs.writeFile(location.metadataPath, 'damaged');

    const repaired = await repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    expect(repaired.active?.snapshotDigest).toBe(synced.active?.snapshotDigest);
    await expect(fs.readFile(sibling, 'utf8')).resolves.toBe('keep');
    await expect(readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({ sources: [{ activeReady: true }] });
  });

  it('publishes the candidate store key when source config changes to equal content with a new workspace identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = fixturePath('repair-workspace-a');
    const secondRoot = fixturePath('repair-workspace-b');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot),
      createCatalogSnapshotFixture(secondRoot),
    ]);
    for (const [root, workspaceIdentity] of [
      [firstRoot, 'workspace-a'],
      [secondRoot, 'workspace-b'],
    ] as const) {
      const markerPath = path.join(root, '.aw-generated.json');
      const marker = await fs.readJson(markerPath) as Record<string, unknown>;
      await fs.writeJson(markerPath, { ...marker, workspaceIdentity }, { spaces: 2 });
    }
    await configurePathSource(firstRoot);
    const first = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', path: secondRoot, primary: true }],
      },
      expectedDigest: config.digest,
      env: isolation.env,
    });

    const repaired = await repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const firstLocation = resolveCatalogStoreLocation({
      logicalIdentity: first.active!.logicalIdentity,
      snapshotDigest: first.active!.snapshotDigest,
      env: isolation.env,
    });
    const repairedLocation = resolveCatalogStoreLocation({
      logicalIdentity: repaired.active!.logicalIdentity,
      snapshotDigest: repaired.active!.snapshotDigest,
      env: isolation.env,
    });

    expect(repaired.active).toMatchObject({
      logicalIdentity: 'workspace-b',
      snapshotDigest: first.active!.snapshotDigest,
    });
    expect(repairedLocation.entryDir).not.toBe(firstLocation.entryDir);
    await expect(fs.pathExists(firstLocation.entryDir)).resolves.toBe(true);
    await expect(fs.pathExists(repairedLocation.entryDir)).resolves.toBe(true);
  });

  it('publishes a missing exact Active entry without quarantine replacement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('repair-missing-active');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const synced = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const location = resolveCatalogStoreLocation({
      logicalIdentity: synced.active!.logicalIdentity,
      snapshotDigest: synced.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.remove(location.entryDir);

    const repaired = await repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    expect(repaired.active).toEqual(synced.active);
    await expect(fs.pathExists(location.metadataPath)).resolves.toBe(true);
    await expect(readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({ sources: [{ activeReady: true }] });
  });

  it('restores the quarantined target when exact repair replacement fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('repair-rollback');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const synced = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const location = resolveCatalogStoreLocation({
      logicalIdentity: synced.active!.logicalIdentity,
      snapshotDigest: synced.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.writeFile(location.metadataPath, 'damaged-before-repair');
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (path.basename(String(source)).startsWith('.replacement-')
        && String(target) === location.entryDir) {
        throw Object.assign(new Error('injected replacement failure'), { code: 'EIO' });
      }
      return rename(source, target);
    });

    await expect(repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationPublishFailed' });
    renameSpy.mockRestore();
    await expect(fs.readFile(location.metadataPath, 'utf8')).resolves.toBe('damaged-before-repair');
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(synced.active);
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
