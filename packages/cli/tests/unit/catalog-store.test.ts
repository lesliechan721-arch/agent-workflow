import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { syncCatalogSourceCommand } from '../../src/commands/catalog-generation.js';
import { catalogStorePrune, catalogStoreStatus } from '../../src/commands/catalog-store.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createCatalogStoreKey, resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const OLD_FORMAL = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
const OLD_TEMP = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
const AFTER_TEMP_RETENTION = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);

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
  await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'catalog-store-test' });
}

async function configureSource(root: string): Promise<NodeJS.ProcessEnv> {
  const isolation = getCurrentSourceTestIsolation();
  await writeSnapshot(root, 'first\n');
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: root }] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  return isolation.env;
}

async function sync(root: string, env: NodeJS.ProcessEnv, readme?: string) {
  if (readme !== undefined) await writeSnapshot(root, readme);
  return syncCatalogSourceCommand({
    sourceId: 'local', cliVersion: '0.1.0', cwd: path.dirname(root), env,
  });
}

describe('Catalog immutable store maintenance', () => {
  it('keeps Active and young formal entries, and only deletes old inactive entries with --yes semantics', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-formal');
    const env = await configureSource(root);
    const first = await sync(root, env);
    const firstLocation = resolveCatalogStoreLocation({
      logicalIdentity: first.active!.logicalIdentity,
      snapshotDigest: first.active!.snapshotDigest,
      env,
    });
    await sync(root, env, 'second\n');

    const young = await catalogStoreStatus({ env, now: NOW });
    expect(young.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ storeKey: firstLocation.storeKey, status: 'retained', reason: 'inactiveWithin30Days' }),
      expect.objectContaining({ status: 'active', reason: 'active' }),
    ]));

    await setTreeTime(firstLocation.entryDir, OLD_FORMAL);
    const dryRun = await catalogStorePrune({ env, now: NOW });
    expect(dryRun).toMatchObject({ dryRun: true, deleted: [] });
    expect(dryRun.entries).toContainEqual(expect.objectContaining({
      storeKey: firstLocation.storeKey, status: 'reclaimable', reason: 'inactiveOlderThan30Days',
    }));
    await expect(fs.pathExists(firstLocation.entryDir)).resolves.toBe(true);

    let claimedPath: string | undefined;
    const pruned = await catalogStorePrune({
      dryRun: false,
      env,
      now: NOW,
      runtime: {
        afterDeleteClaim: async ({ claimPath, storeKey }) => {
          expect(storeKey).toBe(firstLocation.storeKey);
          await expect(fs.realpath(path.dirname(claimPath)))
            .resolves.toBe(await fs.realpath(path.dirname(firstLocation.entryDir)));
          expect(path.basename(claimPath)).toMatch(/^\.delete-[0-9a-f-]+\.tmp$/u);
          await expect(fs.pathExists(firstLocation.entryDir)).resolves.toBe(false);
          await expect(fs.pathExists(claimPath)).resolves.toBe(true);
          claimedPath = claimPath;
        },
      },
    });
    expect(pruned.deleted).toContainEqual(expect.objectContaining({ storeKey: firstLocation.storeKey }));
    expect(claimedPath).toBeDefined();
    await expect(fs.pathExists(firstLocation.entryDir)).resolves.toBe(false);
    const active = (await readCatalogGenerationState(env)).sources.local!.active!;
    await expect(fs.pathExists(resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
    }).entryDir)).resolves.toBe(true);
  });

  it('applies the 24-hour rule to staging/replacement and requires a healthy canonical for quarantine', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-temp');
    const env = await configureSource(root);
    const active = (await sync(root, env)).active!;
    const location = resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
    });
    const names = {
      staging: '.staging-11111111-1111-4111-8111-111111111111.tmp',
      replacement: '.replacement-22222222-2222-4222-8222-222222222222.tmp',
      stagingYoung: '.staging-55555555-5555-4555-8555-555555555555.tmp',
      replacementOld: '.replacement-66666666-6666-4666-8666-666666666666.tmp',
      stagingFile: '.staging-77777777-7777-4777-8777-777777777777.tmp',
      replacementFile: '.replacement-88888888-8888-4888-8888-888888888888.tmp',
      quarantine: '.quarantine-33333333-3333-4333-8333-333333333333.tmp',
      missing: '.quarantine-44444444-4444-4444-8444-444444444444.tmp',
    };
    for (const name of [names.staging, names.replacement, names.stagingYoung,
      names.replacementOld, names.quarantine, names.missing]) {
      await fs.copy(location.entryDir, path.join(location.logicalIdentityDirectory, name));
    }
    for (const name of [names.stagingFile, names.replacementFile]) {
      await fs.writeFile(path.join(location.logicalIdentityDirectory, name), 'foreign temporary file\n');
    }
    const missingPath = path.join(location.logicalIdentityDirectory, names.missing);
    const missingMetadata = await fs.readJson(path.join(missingPath, 'metadata.json')) as Record<string, unknown>;
    await fs.writeJson(path.join(missingPath, 'metadata.json'), {
      ...missingMetadata,
      snapshotDigest: `sha256:${'f'.repeat(64)}`,
    });
    await setTreeTime(path.join(location.logicalIdentityDirectory, names.staging), OLD_TEMP);
    await setTreeTime(path.join(location.logicalIdentityDirectory, names.replacementOld), OLD_TEMP);
    await setTreeTime(path.join(location.logicalIdentityDirectory, names.stagingFile), OLD_TEMP);
    await setTreeTime(path.join(location.logicalIdentityDirectory, names.replacementFile), OLD_TEMP);
    await setTreeTime(path.join(location.logicalIdentityDirectory, names.quarantine), OLD_TEMP);
    await setTreeTime(missingPath, OLD_TEMP);

    const status = await catalogStoreStatus({ env, now: NOW });
    expect(status.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'staging', status: 'reclaimable' }),
      expect.objectContaining({ category: 'staging', storeKey: `${location.storeKey.split('/')[0]}/${names.stagingYoung}`, status: 'retained', reason: 'temporaryWithin24Hours' }),
      expect.objectContaining({ category: 'replacement', status: 'retained', reason: 'temporaryWithin24Hours' }),
      expect.objectContaining({ category: 'replacement', storeKey: `${location.storeKey.split('/')[0]}/${names.replacementOld}`, status: 'reclaimable' }),
      expect.objectContaining({ category: 'staging', storeKey: `${location.storeKey.split('/')[0]}/${names.stagingFile}`, status: 'error', reason: 'unsafeTemporaryRoot' }),
      expect.objectContaining({ category: 'replacement', storeKey: `${location.storeKey.split('/')[0]}/${names.replacementFile}`, status: 'error', reason: 'unsafeTemporaryRoot' }),
      expect.objectContaining({ category: 'quarantine', storeKey: `${location.storeKey.split('/')[0]}/${names.quarantine}`, status: 'reclaimable' }),
      expect.objectContaining({ category: 'quarantine', storeKey: `${location.storeKey.split('/')[0]}/${names.missing}`, status: 'retained', reason: 'quarantineCanonicalUnhealthy' }),
    ]));

    const pruned = await catalogStorePrune({ dryRun: false, env, now: NOW });
    expect(pruned.deleted).toContainEqual(expect.objectContaining({
      storeKey: `${location.storeKey.split('/')[0]}/${names.quarantine}`,
    }));
    await expect(fs.pathExists(path.join(location.logicalIdentityDirectory, names.quarantine)))
      .resolves.toBe(false);
    await expect(fs.pathExists(missingPath)).resolves.toBe(true);
    await expect(fs.readFile(path.join(location.logicalIdentityDirectory, names.stagingFile), 'utf8'))
      .resolves.toBe('foreign temporary file\n');
    await expect(fs.readFile(path.join(location.logicalIdentityDirectory, names.replacementFile), 'utf8'))
      .resolves.toBe('foreign temporary file\n');

    await fs.copy(location.entryDir, path.join(location.logicalIdentityDirectory, names.quarantine));
    await setTreeTime(path.join(location.logicalIdentityDirectory, names.quarantine), OLD_TEMP);
    await fs.writeFile(location.metadataPath, 'damaged\n');
    const damaged = await catalogStoreStatus({ env, now: NOW });
    expect(damaged.entries).toContainEqual(expect.objectContaining({
      storeKey: `${location.storeKey.split('/')[0]}/${names.quarantine}`,
      status: 'retained',
      reason: 'quarantineCanonicalUnhealthy',
    }));
  });

  it('fails closed on invalid generation state and retains symlink, unsafe, and foreign nodes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-unsafe');
    const env = await configureSource(root);
    const active = (await sync(root, env)).active!;
    const location = resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
    });
    await fs.symlink(root, path.join(location.logicalIdentityDirectory, 'foreign-link'));
    await fs.writeFile(path.join(location.logicalIdentityDirectory, 'foreign-file'), 'foreign\n');
    await fs.ensureDir(path.join(location.logicalIdentityDirectory, '.staging-malformed'));
    const status = await catalogStoreStatus({ env, now: NOW });
    expect(status.entries.filter((entry) => entry.category === 'foreign')).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'error', reason: 'unsafeSymlink', reclaimableBytes: null }),
      expect.objectContaining({ status: 'retained', reason: 'unrecognizedStoreNode', reclaimableBytes: null }),
    ]));

    await fs.writeFile(path.join(env.AW_HOME!, 'catalog-state.json'), '{ invalid\n');
    await expect(catalogStorePrune({ dryRun: false, env, now: NOW }))
      .rejects.toMatchObject({ code: 'catalogGenerationStateInvalid' });
    await expect(fs.pathExists(location.entryDir)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(location.logicalIdentityDirectory, 'foreign-file'))).resolves.toBe(true);
  });

  it('continues after one deletion failure and returns a partial receipt', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-partial');
    const env = await configureSource(root);
    const first = (await sync(root, env)).active!;
    const second = (await sync(root, env, 'second\n')).active!;
    await sync(root, env, 'third\n');
    const locations = [first, second].map((active) => resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
    })).sort((left, right) => left.storeKey.localeCompare(right.storeKey));
    await Promise.all(locations.map((location) => setTreeTime(location.entryDir, OLD_FORMAL)));

    let removeCalls = 0;
    let failedClaimPath: string | undefined;
    const result = await catalogStorePrune({
      dryRun: false,
      env,
      now: NOW,
      remove: async (target) => {
        removeCalls += 1;
        if (removeCalls === 1) {
          failedClaimPath = target;
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        await fs.remove(target);
      },
    });
    expect(result).toMatchObject({ ok: false, overallState: 'partial' });
    expect(result.deleted).toContainEqual(expect.objectContaining({ storeKey: locations[1]!.storeKey }));
    expect(failedClaimPath).toBeDefined();
    await expect(fs.realpath(path.dirname(failedClaimPath!)))
      .resolves.toBe(await fs.realpath(path.dirname(locations[0]!.entryDir)));
    expect(path.basename(failedClaimPath!)).toMatch(/^\.delete-[0-9a-f-]+\.tmp$/u);
    const failedClaimStoreKey = `${locations[0]!.storeKey.split('/')[0]}/${path.basename(failedClaimPath!)}`;
    expect(result.entries).toContainEqual(expect.objectContaining({
      storeKey: failedClaimStoreKey,
      category: 'deleteClaim',
      status: 'retained',
      reason: 'deleteClaimWithin24Hours',
    }));
    expect(result.retained).toContainEqual({
      storeKey: failedClaimStoreKey,
      reason: 'deleteClaimWithin24Hours',
    });
    expect(result.errors).toContainEqual(expect.objectContaining({
      storeKey: failedClaimStoreKey,
      code: 'catalogStoreDeleteFailed',
    }));
    expect(JSON.stringify(result)).not.toContain(locations[0]!.entryDir);
    await expect(fs.pathExists(locations[0]!.entryDir)).resolves.toBe(false);
    await expect(fs.pathExists(failedClaimPath!)).resolves.toBe(true);
    await expect(fs.pathExists(locations[1]!.entryDir)).resolves.toBe(false);

    const retry = await catalogStorePrune({ dryRun: false, env, now: NOW });
    expect(retry.deleted).toEqual([]);
    expect(retry.entries).toContainEqual(expect.objectContaining({
      storeKey: failedClaimStoreKey,
      category: 'deleteClaim',
      status: 'retained',
      reason: 'deleteClaimWithin24Hours',
    }));
    await expect(fs.pathExists(failedClaimPath!)).resolves.toBe(true);

    const expiredRetry = await catalogStorePrune({
      dryRun: false,
      env,
      now: AFTER_TEMP_RETENTION,
    });
    expect(expiredRetry.deleted).toContainEqual(expect.objectContaining({
      storeKey: failedClaimStoreKey,
    }));
    await expect(fs.pathExists(failedClaimPath!)).resolves.toBe(false);
  });

  it('restores the original entry when setting the delete claim time fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-claim-time-failure');
    const env = await configureSource(root);
    const first = (await sync(root, env)).active!;
    await sync(root, env, 'second\n');
    const location = resolveCatalogStoreLocation({
      logicalIdentity: first.logicalIdentity,
      snapshotDigest: first.snapshotDigest,
      env,
    });
    await setTreeTime(location.entryDir, OLD_FORMAL);

    let claimPath: string | undefined;
    const result = await catalogStorePrune({
      dryRun: false,
      env,
      now: NOW,
      runtime: {
        updateDeleteClaimTime: async (target) => {
          claimPath = target;
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      },
    });

    expect(result.deleted).toEqual([]);
    expect(result.retained).toContainEqual({
      storeKey: location.storeKey,
      reason: 'staleBeforeDelete',
    });
    expect(result.entries).toContainEqual(expect.objectContaining({
      storeKey: location.storeKey,
      status: 'retained',
      reason: 'staleBeforeDelete',
    }));
    expect(claimPath).toBeDefined();
    await expect(fs.pathExists(location.entryDir)).resolves.toBe(true);
    await expect(fs.pathExists(claimPath!)).resolves.toBe(false);
  });

  it('reports deletion when remove throws after the claim is gone', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-remove-after-delete');
    const env = await configureSource(root);
    const first = (await sync(root, env)).active!;
    await sync(root, env, 'second\n');
    const location = resolveCatalogStoreLocation({
      logicalIdentity: first.logicalIdentity,
      snapshotDigest: first.snapshotDigest,
      env,
    });
    await setTreeTime(location.entryDir, OLD_FORMAL);

    const result = await catalogStorePrune({
      dryRun: false,
      env,
      now: NOW,
      remove: async (target) => {
        await fs.remove(target);
        throw new Error('completion status unavailable');
      },
    });

    expect(result).toMatchObject({ ok: true, overallState: 'succeeded', errors: [] });
    expect(result.deleted).toContainEqual(expect.objectContaining({ storeKey: location.storeKey }));
    await expect(fs.pathExists(location.entryDir)).resolves.toBe(false);
  });

  it('retains entries whose path, retention evidence, or identity changes after inspection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-stale');
    const env = await configureSource(root);
    const first = (await sync(root, env)).active!;
    const second = (await sync(root, env, 'second\n')).active!;
    const third = (await sync(root, env, 'third\n')).active!;
    await sync(root, env, 'fourth\n');
    const locations = [first, second, third].map((active) => resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
    })).sort((left, right) => left.storeKey.localeCompare(right.storeKey));
    await Promise.all(locations.map((location) => setTreeTime(location.entryDir, OLD_FORMAL)));
    const replacementSentinel = path.join(locations[0]!.entryDir, 'new-content.txt');

    const result = await catalogStorePrune({
      dryRun: false,
      env,
      now: NOW,
      runtime: {
        afterInitialInspection: async () => {
          await fs.remove(locations[0]!.entryDir);
          await fs.outputFile(replacementSentinel, 'replacement must survive\n');
          await setTreeTime(locations[0]!.entryDir, OLD_FORMAL);
          await setTreeTime(locations[1]!.entryDir, NOW);
          const metadataPath = path.join(locations[2]!.entryDir, 'metadata.json');
          const metadata = await fs.readJson(metadataPath) as Record<string, unknown>;
          await fs.writeJson(metadataPath, { ...metadata, logicalIdentity: 'catalog-store-tost' });
          await setTreeTime(locations[2]!.entryDir, OLD_FORMAL);
        },
      },
    });

    expect(result.deleted).toEqual([]);
    expect(result.retained).toEqual(expect.arrayContaining(locations.map((location) => ({
      storeKey: location.storeKey,
      reason: 'staleBeforeDelete',
    }))));
    expect(result.entries).toEqual(expect.arrayContaining(locations.map((location) => expect.objectContaining({
      storeKey: location.storeKey,
      status: 'retained',
      reason: 'staleBeforeDelete',
    }))));
    await expect(fs.readFile(replacementSentinel, 'utf8')).resolves.toBe('replacement must survive\n');
    await expect(fs.pathExists(locations[1]!.entryDir)).resolves.toBe(true);
    await expect(fs.pathExists(locations[2]!.entryDir)).resolves.toBe(true);
  });

  it('retains an entry that becomes Active after initial inspection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-active-recheck');
    const env = await configureSource(root);
    const first = (await sync(root, env)).active!;
    await sync(root, env, 'second\n');
    const firstLocation = resolveCatalogStoreLocation({
      logicalIdentity: first.logicalIdentity, snapshotDigest: first.snapshotDigest, env,
    });
    await setTreeTime(firstLocation.entryDir, OLD_FORMAL);

    const result = await catalogStorePrune({
      dryRun: false,
      env,
      now: NOW,
      runtime: {
        afterInitialInspection: async () => {
          const state = await readCatalogGenerationState(env);
          await fs.writeJson(path.join(env.AW_HOME!, 'catalog-state.json'), {
            ...state,
            sources: {
              ...state.sources,
              local: { ...state.sources.local, active: first },
            },
          });
        },
      },
    });

    expect(result.deleted).toEqual([]);
    expect(result.entries).toContainEqual(expect.objectContaining({
      storeKey: firstLocation.storeKey,
      status: 'active',
      reason: 'active',
    }));
    await expect(fs.pathExists(firstLocation.entryDir)).resolves.toBe(true);
  });

  it('serializes prune with activation and preserves the entry that becomes Active', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-race');
    const env = await configureSource(root);
    const active = (await sync(root, env)).active!;
    const location = resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
    });
    await setTreeTime(location.entryDir, OLD_FORMAL);
    const statePath = path.join(env.AW_HOME!, 'catalog-state.json');
    const validState = await fs.readFile(statePath, 'utf8');
    await fs.writeJson(statePath, { schemaVersion: 1, sources: {} });

    let prune!: Promise<Awaited<ReturnType<typeof catalogStorePrune>>>;
    await withAwHomeMutationLock({
      env,
      action: async () => {
        prune = catalogStorePrune({ dryRun: false, env, now: NOW });
        await fs.writeFile(statePath, validState);
      },
    });
    const result = await prune;
    expect(result.deleted).toEqual([]);
    expect(result.entries).toContainEqual(expect.objectContaining({
      storeKey: createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
      status: 'active',
    }));
    await expect(fs.pathExists(location.entryDir)).resolves.toBe(true);
  });

  it('preserves the final Active entry when real source activation races actual prune', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-store-real-race');
    const saved = path.join(isolation.layout.fixtureCwd, 'catalog-store-real-race-saved');
    const env = await configureSource(root);
    const first = (await sync(root, env)).active!;
    await fs.copy(root, saved);
    await sync(root, env, 'second\n');
    const firstLocation = resolveCatalogStoreLocation({
      logicalIdentity: first.logicalIdentity, snapshotDigest: first.snapshotDigest, env,
    });
    await setTreeTime(firstLocation.entryDir, OLD_FORMAL);
    await fs.remove(root);
    await fs.copy(saved, root);

    let candidateResolved!: () => void;
    const candidateReady = new Promise<void>((resolve) => { candidateResolved = resolve; });
    let releaseActivation!: () => void;
    const activationReleased = new Promise<void>((resolve) => { releaseActivation = resolve; });
    const activation = syncCatalogSourceCommand({
      sourceId: 'local', cliVersion: '0.1.0', cwd: isolation.layout.fixtureCwd, env,
      runtime: {
        afterCandidateResolved: async () => {
          candidateResolved();
          await activationReleased;
        },
      },
    });
    await candidateReady;
    const prune = catalogStorePrune({ dryRun: false, env, now: NOW });
    releaseActivation();
    const [activationOutcome, pruneOutcome] = await Promise.allSettled([activation, prune]);
    expect(pruneOutcome.status).toBe('fulfilled');
    const finalState = await readCatalogGenerationState(env);
    const finalActive = finalState.sources.local!.active!;
    const finalLocation = resolveCatalogStoreLocation({
      logicalIdentity: finalActive.logicalIdentity,
      snapshotDigest: finalActive.snapshotDigest,
      env,
    });
    await expect(fs.pathExists(finalLocation.entryDir)).resolves.toBe(true);
    if (activationOutcome.status === 'fulfilled') {
      expect(finalActive.snapshotDigest).toBe(first.snapshotDigest);
      await expect(fs.pathExists(firstLocation.entryDir)).resolves.toBe(true);
    } else {
      expect(activationOutcome.reason).toMatchObject({ code: 'catalogGenerationMetadataInvalid' });
    }
  });
});
