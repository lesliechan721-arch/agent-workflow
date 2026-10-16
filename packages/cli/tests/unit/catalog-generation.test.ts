import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogGenerationProviderSet } from '../../src/utils/catalog-generation-service.js';
import { addCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import {
  activateCatalogSourceGeneration,
  compareCatalogGenerationFreshness,
  probeCatalogSourceFreshness,
  probeCatalogSourceGeneration,
  readCatalogGenerationStatus,
  recoverCatalogGenerationStateAndActivate,
  repairCatalogSourceGeneration,
  syncCatalogSourceGeneration,
} from '../../src/utils/catalog-generation-service.js';
import type { CatalogGenerationCandidateEvidence, GitCatalogSource } from '../../src/types.js';
import {
  readCatalogGenerationState,
  withCatalogGenerationStateTransaction,
} from '../../src/utils/catalog-generation-state.js';
import {
  createCatalogStoreKey,
  publishCatalogStoreEntry,
  readCatalogStoreEntry,
  replaceDamagedCatalogStoreEntry,
  resolveCatalogStoreLocation,
} from '../../src/utils/catalog-generation-store.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { CatalogProviderCompatibilityError } from '../../src/utils/catalog-public-error.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import {
  calculateCatalogSourceConfigFingerprint,
  calculateCatalogSourceIdentity,
} from '../../src/utils/catalog-source-identity.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';
import {
  calculateCatalogSourceImpactDigest,
  inspectCatalogSourceImpact,
} from '../../src/utils/catalog-source-impact.js';
import {
  createEmptyPluginIntentState,
  upsertPluginIntentRoot,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { setNativeCliRunnerOverrideForTests } from '../../src/utils/native-cli.js';
import {
  calculateCatalogSourcesConfigDigest,
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
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

async function arrangeDamagedInactiveCandidate(name: string) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = fixturePath(name);
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'active content\n');
  await configurePathSource(sourceRoot);
  const first = await syncCatalogSourceGeneration({
    sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
  });
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'inactive candidate\n');
  const candidate = await syncCatalogSourceGeneration({
    sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
  });
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'active content\n');
  const active = await syncCatalogSourceGeneration({
    sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
  });
  expect(active.active!.snapshotDigest).toBe(first.active!.snapshotDigest);
  const candidateLocation = resolveCatalogStoreLocation({
    logicalIdentity: candidate.active!.logicalIdentity,
    snapshotDigest: candidate.active!.snapshotDigest,
    env: isolation.env,
  });
  await fs.writeFile(candidateLocation.metadataPath, 'damaged inactive entry\n');
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'inactive candidate\n');
  const resolution = await catalogPathProviderInternal.resolve({
    id: 'team', type: 'path', path: sourceRoot, primary: true,
  }, { cliVersion: '1.0.0', env: isolation.env });
  return {
    isolation,
    resolution,
    active: active.active!,
    candidate: candidate.active!,
    candidateLocation,
  };
}

describe('Catalog Active store and state', () => {
  it('automatically replaces a damaged inactive candidate during ordinary sync', async () => {
    const fixture = await arrangeDamagedInactiveCandidate('inactive-candidate-repair');

    const synced = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: fixture.isolation.env,
    });

    expect(synced).toMatchObject({
      outcome: 'activated',
      activeChanged: true,
      active: { snapshotDigest: fixture.candidate.snapshotDigest },
    });
    await expect(readCatalogStoreEntry({
      logicalIdentity: fixture.candidate.logicalIdentity,
      snapshotDigest: fixture.candidate.snapshotDigest,
      env: fixture.isolation.env,
    })).resolves.toMatchObject({ reused: true });
  });

  it('keeps a damaged candidate when it becomes Active before inactive repair takes the lock', async () => {
    const fixture = await arrangeDamagedInactiveCandidate('inactive-candidate-active-race');
    let raced = false;

    await expect(syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: fixture.isolation.env,
      runtime: {
        afterInactiveStoreRepairPrepared: async () => {
          raced = true;
          await withCatalogGenerationStateTransaction({
            env: fixture.isolation.env,
            action: async (current) => ({
              state: {
                ...current,
                sources: {
                  ...current.sources,
                  racer: { active: fixture.candidate },
                },
              },
              result: undefined,
            }),
          });
        },
      },
    })).rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });

    expect(raced).toBe(true);
    await expect(fs.readFile(fixture.candidateLocation.metadataPath, 'utf8'))
      .resolves.toBe('damaged inactive entry\n');
    expect((await readCatalogGenerationState(fixture.isolation.env)).sources.racer!.active)
      .toEqual(fixture.candidate);
  });

  it('reuses a candidate repaired by another writer before inactive repair takes the lock', async () => {
    const fixture = await arrangeDamagedInactiveCandidate('inactive-candidate-concurrent-repair');
    let repaired = false;

    const synced = await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: fixture.isolation.env,
      runtime: {
        afterInactiveStoreRepairPrepared: async () => {
          repaired = true;
          await replaceDamagedCatalogStoreEntry({
            resolution: fixture.resolution,
            logicalIdentity: fixture.candidate.logicalIdentity,
            snapshotDigest: fixture.candidate.snapshotDigest,
            env: fixture.isolation.env,
          });
        },
      },
    });

    expect(repaired).toBe(true);
    expect(synced.active!.snapshotDigest).toBe(fixture.candidate.snapshotDigest);
    await expect(readCatalogStoreEntry({
      logicalIdentity: fixture.candidate.logicalIdentity,
      snapshotDigest: fixture.candidate.snapshotDigest,
      env: fixture.isolation.env,
    })).resolves.toMatchObject({ reused: true });
  });

  it('keeps a damaged inactive candidate when generation state is invalid', async () => {
    const fixture = await arrangeDamagedInactiveCandidate('inactive-candidate-invalid-state');
    const statePath = path.join(fixture.isolation.env.AW_HOME!, 'catalog-state.json');
    const invalidState = '{ invalid state\n';
    await fs.writeFile(statePath, invalidState);

    await expect(publishCatalogStoreEntry({
      resolution: fixture.resolution,
      env: fixture.isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationStateInvalid' });

    await expect(fs.readFile(fixture.candidateLocation.metadataPath, 'utf8'))
      .resolves.toBe('damaged inactive entry\n');
    await expect(fs.readFile(statePath, 'utf8')).resolves.toBe(invalidState);
  });

  it('restores a damaged inactive candidate when automatic replacement fails', async () => {
    const fixture = await arrangeDamagedInactiveCandidate('inactive-candidate-restore');
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (path.basename(String(source)).startsWith('.replacement-')
        && String(target) === fixture.candidateLocation.entryDir) {
        throw Object.assign(new Error('injected inactive replacement failure'), { code: 'EIO' });
      }
      return rename(source, target);
    });
    try {
      await expect(syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: fixture.isolation.env,
      })).rejects.toMatchObject({ code: 'catalogGenerationPublishFailed' });
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.readFile(fixture.candidateLocation.metadataPath, 'utf8'))
      .resolves.toBe('damaged inactive entry\n');
    expect((await readCatalogGenerationState(fixture.isolation.env)).sources.team!.active)
      .toEqual(fixture.active);
  });

  it('enforces Git version policy in the generation service and permits a verified ref change', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const roots = {
      active: fixturePath('policy-active'),
      conflict: fixturePath('policy-conflict'),
      rollback: fixturePath('policy-rollback'),
      identity: fixturePath('policy-identity'),
    };
    await Promise.all([
      createCatalogSnapshotFixture(roots.active, 'demo', [], 'active\n'),
      createCatalogSnapshotFixture(roots.conflict, 'demo', [], 'conflict\n'),
      createCatalogSnapshotFixture(roots.rollback, 'demo', [], 'rollback\n'),
      createCatalogSnapshotFixture(roots.identity, 'demo', [], 'identity\n'),
    ]);
    for (const [name, root] of Object.entries(roots)) {
      const markerPath = path.join(root, '.aw-generated.json');
      const marker = await fs.readJson(markerPath) as Record<string, unknown>;
      await fs.writeJson(markerPath, {
        ...marker,
        workspaceIdentity: name === 'identity' ? 'other-policy-workspace' : 'policy-workspace',
      });
      const manifestPath = path.join(root, 'catalog-manifest.json');
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, {
        ...manifest,
        catalogVersion: name === 'rollback' ? '1.0.0' : '2.0.0',
      });
    }
    const source: GitCatalogSource = {
      id: 'team',
      type: 'git',
      primary: true,
      url: fixturePath('policy.git'),
      refPolicy: { type: 'explicit', ref: 'refs/heads/one' },
    };
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: config.digest,
      env: isolation.env,
    });
    let selectedRoot = roots.active;
    const git = async (configured: GitCatalogSource) => {
      const resolution = await catalogPathProviderInternal.resolve({
        id: configured.id,
        type: 'path',
        primary: configured.primary,
        path: selectedRoot,
      }, { cliVersion: '1.0.0', env: isolation.env });
      return {
        ...resolution,
        sourceIdentity: await calculateCatalogSourceIdentity(configured),
        requestedRef: configured.refPolicy.type === 'explicit'
          ? configured.refPolicy.ref : 'refs/heads/catalog/latest',
        resolvedCommit: (selectedRoot === roots.active ? 'a'
          : selectedRoot === roots.conflict ? 'b'
            : selectedRoot === roots.rollback ? 'c' : 'd').repeat(40),
        transport: 'git' as const,
      };
    };
    const inspectSourceImpact = vi.fn(inspectCatalogSourceImpact);
    const runtime = {
      providers: { git, path: catalogPathProviderInternal.resolve },
      inspectSourceImpact,
    };
    const initial = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });

    expect(inspectSourceImpact).toHaveBeenCalledTimes(2);
    inspectSourceImpact.mockClear();
    selectedRoot = roots.conflict;
    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).rejects.toMatchObject({ code: 'catalogVersionConflict' });
    expect(inspectSourceImpact).not.toHaveBeenCalled();
    selectedRoot = roots.rollback;
    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).rejects.toMatchObject({ code: 'catalogRollbackDetected' });
    expect(inspectSourceImpact).not.toHaveBeenCalled();
    selectedRoot = roots.identity;
    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).rejects.toMatchObject({ code: 'catalogLogicalIdentityChanged' });
    expect(inspectSourceImpact).not.toHaveBeenCalled();
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active)
      .toEqual(initial.active);

    const beforeRefChange = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ ...source, refPolicy: { type: 'explicit', ref: 'refs/heads/two' } }],
      },
      expectedDigest: beforeRefChange.digest,
      env: isolation.env,
    });
    selectedRoot = roots.conflict;
    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).resolves.toMatchObject({ outcome: 'activated', activeChanged: true });
  });

  it('rechecks Git version policy under the lock before collecting impact', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const roots = {
      active: fixturePath('locked-policy-active'),
      candidate: fixturePath('locked-policy-candidate'),
      concurrent: fixturePath('locked-policy-concurrent'),
    };
    await Promise.all(Object.values(roots).map((root) => createCatalogSnapshotFixture(root)));
    for (const [name, root] of Object.entries(roots)) {
      const markerPath = path.join(root, '.aw-generated.json');
      const marker = await fs.readJson(markerPath) as Record<string, unknown>;
      await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'locked-policy-workspace' });
      const manifestPath = path.join(root, 'catalog-manifest.json');
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, {
        ...manifest,
        catalogVersion: name === 'active' ? '1.0.0' : name === 'candidate' ? '2.0.0' : '3.0.0',
      });
    }
    const source: GitCatalogSource = {
      id: 'team', type: 'git', primary: true, url: fixturePath('locked-policy.git'),
      refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
    };
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: config.digest,
      env: isolation.env,
    });
    let selected: keyof typeof roots = 'active';
    const git = async (configured: GitCatalogSource) => {
      const resolution = await catalogPathProviderInternal.resolve({
        id: configured.id, type: 'path', primary: configured.primary, path: roots[selected],
      }, { cliVersion: '1.0.0', env: isolation.env });
      return {
        ...resolution,
        sourceIdentity: await calculateCatalogSourceIdentity(configured),
        requestedRef: 'refs/heads/main',
        resolvedCommit: ({ active: 'a', candidate: 'b', concurrent: 'c' } as const)[selected].repeat(40),
        transport: 'git' as const,
      };
    };
    const providers = { git, path: catalogPathProviderInternal.resolve };
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime: { providers },
    });
    selected = 'candidate';
    const inspectSourceImpact = vi.fn(inspectCatalogSourceImpact);

    await expect(activateCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: {
        providers,
        inspectSourceImpact,
        afterCandidateResolved: async () => {
          expect(inspectSourceImpact).toHaveBeenCalledTimes(1);
          selected = 'concurrent';
          await syncCatalogSourceGeneration({
            sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime: { providers },
          });
          inspectSourceImpact.mockClear();
        },
      },
    })).rejects.toMatchObject({ code: 'catalogRollbackDetected' });
    expect(inspectSourceImpact).not.toHaveBeenCalled();
  });

  it('repairs the exact Git commit before CLI sync continues and requires replacement when that commit is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const roots = {
      first: fixturePath('git-repair-first'),
      second: fixturePath('git-repair-second'),
      third: fixturePath('git-repair-third'),
    };
    await Promise.all([
      createCatalogSnapshotFixture(roots.first, 'demo', [], 'first\n'),
      createCatalogSnapshotFixture(roots.second, 'demo', [], 'second\n'),
      createCatalogSnapshotFixture(roots.third, 'demo', [], 'second\n'),
    ]);
    for (const [name, root] of Object.entries(roots)) {
      const markerPath = path.join(root, '.aw-generated.json');
      const marker = await fs.readJson(markerPath) as Record<string, unknown>;
      await fs.writeJson(markerPath, {
        ...marker,
        workspaceIdentity: 'git-repair-workspace',
        sourceIdentity: `sha256:${'9'.repeat(64)}`,
      });
      const manifestPath = path.join(root, 'catalog-manifest.json');
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, {
        ...manifest,
        catalogVersion: name === 'first' ? '1.0.0' : '2.0.0',
      });
    }
    const commits = {
      first: '1'.repeat(40),
      second: '2'.repeat(40),
      third: '3'.repeat(40),
    };
    const source: GitCatalogSource = {
      id: 'team', type: 'git', primary: true,
      url: fixturePath('repair.git'),
      refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
    };
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: config.digest,
      env: isolation.env,
    });
    let main: keyof typeof roots = 'first';
    const unavailable = new Set<string>();
    const requestedRefs: string[] = [];
    const git = async (configured: GitCatalogSource) => {
      const requestedRef = configured.refPolicy.type === 'explicit'
        ? configured.refPolicy.ref : 'refs/heads/catalog/latest';
      requestedRefs.push(requestedRef);
      if (unavailable.has(requestedRef)) throw new Error('commit unavailable');
      const exact = (Object.entries(commits) as Array<[keyof typeof roots, string]>)
        .find(([, commit]) => commit === requestedRef)?.[0];
      const selected = exact ?? main;
      const resolution = await catalogPathProviderInternal.resolve({
        id: configured.id, type: 'path', primary: configured.primary, path: roots[selected],
      }, { cliVersion: '1.0.0', env: isolation.env });
      return {
        ...resolution,
        sourceIdentity: await calculateCatalogSourceIdentity(configured),
        requestedRef,
        resolvedCommit: commits[selected],
        transport: 'git' as const,
      };
    };
    const runtime = { providers: { git, path: catalogPathProviderInternal.resolve } };
    const first = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    const firstLocation = resolveCatalogStoreLocation({
      logicalIdentity: first.active!.logicalIdentity,
      snapshotDigest: first.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.writeFile(firstLocation.metadataPath, 'damaged\n');
    main = 'second';
    requestedRefs.length = 0;

    const continued = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(requestedRefs).toEqual([commits.first, 'refs/heads/main']);
    expect(continued.active).toMatchObject({
      resolvedCommit: commits.second,
      logicalIdentity: first.active!.logicalIdentity,
    });

    const secondLocation = resolveCatalogStoreLocation({
      logicalIdentity: continued.active!.logicalIdentity,
      snapshotDigest: continued.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.writeFile(secondLocation.metadataPath, 'damaged\n');
    unavailable.add(commits.second);
    main = 'third';
    const sameKeyCandidate = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(sameKeyCandidate.candidate.snapshotDigest).toBe(continued.active!.snapshotDigest);
    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).rejects.toMatchObject({ code: 'catalogReplaceDamagedRequired' });
    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
      replaceDamaged: true,
      impactConfirmed: true,
    })).resolves.toMatchObject({
      outcome: 'activated',
      active: { resolvedCommit: commits.third },
    });
  });

  it('classifies candidate versions and digest conflicts with strict SemVer precedence', () => {
    const candidate = (catalogVersion: string, snapshotDigest: string): CatalogGenerationCandidateEvidence => ({
      sourceConfigFingerprint: `sha256:${'1'.repeat(64)}`,
      sourceIdentity: `sha256:${'2'.repeat(64)}`,
      logicalIdentity: 'workspace',
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'b'.repeat(40),
      catalogVersion,
      channel: 'latest',
      manifestDigest: `sha256:${'3'.repeat(64)}`,
      snapshotDigest,
    });
    const active = {
      logicalIdentity: 'workspace',
      catalogVersion: '2.0.0',
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
      resolvedCommit: 'a'.repeat(40),
    };

    expect(compareCatalogGenerationFreshness({
      sourceType: 'git', active, candidate: candidate('2.1.0', `sha256:${'b'.repeat(64)}`),
    }).state).toBe('updateAvailable');
    expect(compareCatalogGenerationFreshness({
      sourceType: 'git', active, candidate: candidate('2.0.0', `sha256:${'b'.repeat(64)}`),
    }).state).toBe('versionConflict');
    expect(compareCatalogGenerationFreshness({
      sourceType: 'git', active, candidate: candidate('2.0.0-beta.1', `sha256:${'b'.repeat(64)}`),
    }).state).toBe('rollbackDetected');
    expect(compareCatalogGenerationFreshness({
      sourceType: 'git', active, candidate: candidate('9.0.0', active.snapshotDigest),
    }).state).toBe('current');
    expect(compareCatalogGenerationFreshness({
      sourceType: 'path', active, candidate: candidate('2.0.0', `sha256:${'b'.repeat(64)}`),
    }).state).toBe('localChangesAvailable');
  });

  it('checks an unchanged unsupported Git Active by remote ref without full fetch', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('git-freshness-active');
    await createCatalogSnapshotFixture(sourceRoot);
    const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    await fs.writeJson(manifestPath, {
      ...manifest,
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v7', 'aw.future-feature.v3'] } },
    });
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    const source: GitCatalogSource = {
      id: 'team', type: 'git', primary: true, url: fixturePath('remote.git'),
      refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
    };
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const validation = await validateCatalogSnapshotTransport(sourceRoot);
    const resolvedCommit = 'a'.repeat(40);
    const gitResolution = {
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit,
      rootDir: sourceRoot,
      manifest: validation.manifest,
      manifestDigest: validation.manifestDigest,
      snapshotDigest: validation.snapshotDigest,
      transport: 'git' as const,
      async cleanup() {},
    };
    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: {
        providers: {
          git: async () => gitResolution,
          path: catalogPathProviderInternal.resolve,
        },
      },
    });
    const stateBeforeCheck = await readCatalogGenerationState(isolation.env);
    const fullResolve = vi.fn(async () => { throw new Error('full fetch must not run'); });
    const probeGitRef = vi.fn(async () => ({
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit,
      fixed: false,
    }));

    const freshness = await probeCatalogSourceFreshness({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: {
        probeGitRef,
        providers: { git: fullResolve, path: catalogPathProviderInternal.resolve },
      },
    });

    expect(freshness).toMatchObject({ state: 'current', activeVersion: '1.0.0' });
    expect(probeGitRef).toHaveBeenCalledTimes(1);
    expect(fullResolve).not.toHaveBeenCalled();
    expect(await readCatalogGenerationState(isolation.env)).toEqual(stateBeforeCheck);
  });

  it('does not run Git for an unsupported fixed-commit Active automatic check', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('git-fixed-active');
    await createCatalogSnapshotFixture(sourceRoot);
    const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    await fs.writeJson(manifestPath, {
      ...manifest,
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v7', 'aw.future-feature.v3'] } },
    });
    const fixedCommit = 'c'.repeat(40);
    const source: GitCatalogSource = {
      id: 'team', type: 'git', primary: true, url: fixturePath('fixed-remote.git'),
      refPolicy: { type: 'explicit', ref: fixedCommit },
    };
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const validation = await validateCatalogSnapshotTransport(sourceRoot);
    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: { providers: {
        git: async () => ({
          sourceId: source.id,
          sourceIdentity,
          requestedRef: fixedCommit,
          resolvedCommit: fixedCommit,
          rootDir: sourceRoot,
          manifest: validation.manifest,
          manifestDigest: validation.manifestDigest,
          snapshotDigest: validation.snapshotDigest,
          transport: 'git' as const,
          async cleanup() {},
        }),
        path: catalogPathProviderInternal.resolve,
      } },
    });
    setNativeCliRunnerOverrideForTests(async () => {
      throw new Error('fixed commit automatic check must not run Git');
    });
    try {
      await expect(probeCatalogSourceFreshness({
        sourceId: source.id,
        cliVersion: '1.0.0',
        env: isolation.env,
      })).resolves.toMatchObject({ state: 'fixed', activeVersion: '1.0.0' });
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }
  });
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
      compatibility: { state: 'supported' },
    });
    expect(status.catalogGenerationStatusSchemaVersion).toBe(2);
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
      .resolves.toMatchObject({
        catalogGenerationStatusSchemaVersion: 2,
        sources: [{
          activeReady: false,
          configMatchesActive: false,
          compatibility: null,
        }],
      });
  });

  it('reports an unsupported healthy Active without classifying it as damaged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('unsupported-active-status');
    await createCatalogSnapshotFixture(sourceRoot);
    const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    const requiredCapabilities = ['aw.catalog-snapshot.v7', 'aw.future-feature.v3'];
    await fs.writeJson(manifestPath, {
      ...manifest,
      requires: { aw: { capabilities: requiredCapabilities } },
    });
    await configurePathSource(sourceRoot);
    const providers: CatalogGenerationProviderSet = {
      git: async () => { throw new Error('unused'); },
      path: async (source) => {
        const validation = await validateCatalogSnapshotTransport(source.path);
        return {
          sourceId: source.id,
          sourceIdentity: await calculateCatalogSourceIdentity(source),
          requestedRef: 'path',
          resolvedCommit: `path:${validation.snapshotDigest}`,
          rootDir: source.path,
          manifest: validation.manifest,
          manifestDigest: validation.manifestDigest,
          snapshotDigest: validation.snapshotDigest,
          transport: 'path',
          async cleanup() {},
        };
      },
    };
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime: { providers },
    });

    const status = await readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env });
    expect(status).toMatchObject({
      catalogGenerationStatusSchemaVersion: 2,
      sources: [{
        activeReady: false,
        configMatchesActive: true,
        compatibility: {
          state: 'unsupported',
          requiredCapabilities,
          missingCapabilities: ['aw.future-feature.v3'],
        },
      }],
    });
    expect(status.sources[0]!.errorCode).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('availableCapabilities');

    const error = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env })
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(CatalogProviderCompatibilityError);
    expect(error).toMatchObject({
      code: 'awCapabilityUnsupported',
      requiredCapabilities,
      missingCapabilities: ['aw.future-feature.v3'],
    });
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

  it('probes an explicit prospective source without saving source config, state, or store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('prospective-probe');
    await createCatalogSnapshotFixture(sourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);

    const result = await probeCatalogSourceGeneration({
      sourceId: 'prospective',
      source: { id: 'prospective', type: 'path', path: sourceRoot, primary: false },
      cliVersion: '1.0.0',
      env: isolation.env,
    });

    expect(result).toMatchObject({ sourceId: 'prospective', candidate: { requestedRef: 'path' } });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-state.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);
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

  it('does not overwrite an Active that changes after the reviewed candidate resolves', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('active-review-race');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'initial\n');
    await configurePathSource(sourceRoot);
    const initial = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'reviewed\n');
    const reviewed = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    let concurrent: Awaited<ReturnType<typeof syncCatalogSourceGeneration>> | undefined;

    await expect(activateCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      expectedCandidate: reviewed.candidate,
      expectedActive: initial.active!,
      env: isolation.env,
      runtime: {
        afterCandidateResolved: async () => {
          await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'concurrent\n');
          concurrent = await syncCatalogSourceGeneration({
            sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
          });
          await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'reviewed\n');
        },
      },
    })).rejects.toMatchObject({ code: 'catalogGenerationReviewStale' });

    expect(concurrent?.active).toBeDefined();
    expect(await readCatalogGenerationState(isolation.env)).toEqual({
      schemaVersion: 1,
      sources: { team: { active: concurrent!.active, lastSync: concurrent!.lastSync } },
    });
    expect(concurrent!.active!.snapshotDigest).not.toBe(reviewed.candidate.snapshotDigest);
    await expect(fs.pathExists(resolveCatalogStoreLocation({
      logicalIdentity: reviewed.candidate.logicalIdentity,
      snapshotDigest: reviewed.candidate.snapshotDigest,
      env: isolation.env,
    }).entryDir)).resolves.toBe(true);
  });

  it('does not replace a concurrently created Active from a no-Active Review', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('no-active-review-race');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const reviewed = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    let concurrent: Awaited<ReturnType<typeof syncCatalogSourceGeneration>> | undefined;

    await expect(activateCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      expectedCandidate: reviewed.candidate,
      expectedActive: null,
      env: isolation.env,
      runtime: {
        afterCandidateResolved: async () => {
          concurrent = await syncCatalogSourceGeneration({
            sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
          });
        },
      },
    })).rejects.toMatchObject({ code: 'catalogGenerationReviewStale' });

    expect(await readCatalogGenerationState(isolation.env)).toEqual({
      schemaVersion: 1,
      sources: { team: { active: concurrent!.active, lastSync: concurrent!.lastSync } },
    });
  });

  it('uses lock-time lifecycle impact for CLI activation confirmation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('activation-impact-race');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'dependency' },
      { name: 'consumer', dependencies: ['dependency'] },
    ]);
    await configurePathSource(sourceRoot);
    const initial = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'dependency' },
      { name: 'consumer' },
    ]);

    await expect(syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        afterCandidateResolved: async () => {
          await writePluginIntentState({
            scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
          }, upsertPluginIntentRoot(createEmptyPluginIntentState(), {
            pluginId: 'team/consumer', platforms: ['codex'],
          }));
        },
      },
    })).rejects.toMatchObject({ code: 'catalogImpactConfirmationRequired' });
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active)
      .toEqual(initial.active);
  });

  it('rejects reviewed activation when config impact drifts before the final lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('reviewed-activation-impact-race');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const initial = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const reviewed = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const reviewedImpact = await inspectCatalogSourceImpact({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      sourcePrimary: true,
      mode: 'generation',
      candidateManifest: reviewed.manifest,
    });

    await expect(activateCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      expectedCandidate: reviewed.candidate,
      expectedActive: initial.active!,
      expectedImpactDigest: calculateCatalogSourceImpactDigest(reviewedImpact),
      impactConfirmed: true,
      runtime: {
        afterCandidateResolved: async () => {
          await fs.outputJson(
            path.join(isolation.env.AW_HOME!, 'plugin-config', 'team', 'demo', 'config.json'),
            { schemaVersion: 3, pluginId: 'team/demo', values: {} },
          );
        },
      },
    })).rejects.toMatchObject({ code: 'catalogGenerationReviewStale' });
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active)
      .toEqual(initial.active);
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

  it('does not recover invalid state when the published store disappears before the lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('invalid-state-store-race');
    await createCatalogSnapshotFixture(sourceRoot);
    await configurePathSource(sourceRoot);
    const reviewed = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const statePath = path.join(isolation.env.AW_HOME!, 'catalog-state.json');
    const invalidState = '{ invalid state\n';
    await fs.outputFile(statePath, invalidState);
    const location = resolveCatalogStoreLocation({
      logicalIdentity: reviewed.candidate.logicalIdentity,
      snapshotDigest: reviewed.candidate.snapshotDigest,
      env: isolation.env,
    });
    let providerStagingDir: string | undefined;

    await expect(recoverCatalogGenerationStateAndActivate({
      sourceId: 'team',
      cliVersion: '1.0.0',
      expectedCandidate: reviewed.candidate,
      env: isolation.env,
      runtime: {
        providers: {
          git: async () => { throw new Error('unused'); },
          path: async (source, options) => {
            const resolution = await catalogPathProviderInternal.resolve(source, options);
            providerStagingDir = resolution.rootDir;
            return {
              ...resolution,
              async cleanup() {
                // Keep cleanup pending while the missing store causes activation to reject.
                await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
                await resolution.cleanup();
              },
            };
          },
        },
        afterRecoveryStorePublished: async () => {
          await fs.remove(location.entryDir);
        },
      },
    })).rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });

    await expect(fs.readFile(statePath, 'utf8')).resolves.toBe(invalidState);
    await expect(fs.pathExists(location.entryDir)).resolves.toBe(false);
    expect(providerStagingDir).toBeDefined();
    await expect(fs.pathExists(providerStagingDir!)).resolves.toBe(false);
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

  it('refreshes Git Active provenance for identical content and reuses it for the next ref probe', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('git-provenance-reuse');
    await createCatalogSnapshotFixture(sourceRoot);
    const firstSource: GitCatalogSource = {
      id: 'team', type: 'git', primary: true, url: fixturePath('first-provenance.git'),
      refPolicy: { type: 'explicit', ref: 'refs/heads/one' },
    };
    const initialConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [firstSource] },
      expectedDigest: initialConfig.digest,
      env: isolation.env,
    });
    let resolvedCommit = 'a'.repeat(40);
    const git = async (source: GitCatalogSource) => {
      const resolution = await catalogPathProviderInternal.resolve({
        id: source.id, type: 'path', primary: source.primary, path: sourceRoot,
      }, { cliVersion: '1.0.0', env: isolation.env });
      return {
        ...resolution,
        sourceIdentity: await calculateCatalogSourceIdentity(source),
        requestedRef: source.refPolicy.type === 'explicit'
          ? source.refPolicy.ref : 'refs/heads/catalog/latest',
        resolvedCommit,
        transport: 'git' as const,
      };
    };
    const providers = { git, path: catalogPathProviderInternal.resolve };
    const first = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime: { providers },
    });
    const secondSource: GitCatalogSource = {
      ...firstSource,
      url: fixturePath('second-provenance.git'),
      refPolicy: { type: 'explicit', ref: 'refs/heads/two' },
    };
    const beforeSourceChange = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [secondSource] },
      expectedDigest: beforeSourceChange.digest,
      env: isolation.env,
    });
    resolvedCommit = 'b'.repeat(40);

    const second = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime: { providers },
    });
    const expectedSourceIdentity = await calculateCatalogSourceIdentity(secondSource);
    const expectedFingerprint = calculateCatalogSourceConfigFingerprint(secondSource);
    expect(second).toMatchObject({
      outcome: 'unchanged',
      activeChanged: false,
      active: {
        sourceConfigFingerprint: expectedFingerprint,
        sourceIdentity: expectedSourceIdentity,
        requestedRef: 'refs/heads/two',
        resolvedCommit,
        activatedAt: first.active!.activatedAt,
      },
      lastSync: { resolvedCommit },
    });
    expect(second.active!.snapshotDigest).toBe(first.active!.snapshotDigest);
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(second.active);
    const store = resolveCatalogStoreLocation({
      logicalIdentity: second.active!.logicalIdentity,
      snapshotDigest: second.active!.snapshotDigest,
      env: isolation.env,
    });
    await expect(fs.readdir(store.logicalIdentityDirectory))
      .resolves.toEqual([second.active!.snapshotDigest.slice('sha256:'.length)]);

    const fullResolve = vi.fn(async () => { throw new Error('full fetch must not run'); });
    const probeGitRef = vi.fn(async () => ({
      sourceId: secondSource.id,
      sourceIdentity: expectedSourceIdentity,
      requestedRef: 'refs/heads/two',
      resolvedCommit,
      fixed: false,
    }));
    await expect(probeCatalogSourceFreshness({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: {
        probeGitRef,
        providers: { git: fullResolve, path: catalogPathProviderInternal.resolve },
      },
    })).resolves.toMatchObject({ state: 'current', activeResolvedCommit: resolvedCommit });
    expect(probeGitRef).toHaveBeenCalledTimes(1);
    expect(fullResolve).not.toHaveBeenCalled();
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

    const inspectSourceImpact = vi.fn(inspectCatalogSourceImpact);
    const repaired = await repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      runtime: { inspectSourceImpact },
    });

    expect(repaired.active?.snapshotDigest).toBe(synced.active?.snapshotDigest);
    expect(inspectSourceImpact).not.toHaveBeenCalled();
    await expect(fs.readFile(sibling, 'utf8')).resolves.toBe('keep');
    await expect(readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({ sources: [{ activeReady: true }] });
  });

  it('rejects a changed repair candidate before replacing the damaged Active entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('stale-repair');
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
    await fs.writeFile(location.metadataPath, 'damaged');
    const probe = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const markerPath = path.join(sourceRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as Record<string, unknown>;
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'changed-after-repair-review' });

    await expect(repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', expectedCandidate: probe.candidate,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationReviewStale' });
    await expect(fs.readFile(location.metadataPath, 'utf8')).resolves.toBe('damaged');
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(synced.active);
  });

  it('checks the reviewed Active under the mutation lock before repairing its store entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('repair-active-race');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'reviewed repair\n');
    await configurePathSource(sourceRoot);
    const initial = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const location = resolveCatalogStoreLocation({
      logicalIdentity: initial.active!.logicalIdentity,
      snapshotDigest: initial.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.writeFile(location.metadataPath, 'damaged before race\n');
    const reviewed = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    let concurrent: Awaited<ReturnType<typeof syncCatalogSourceGeneration>> | undefined;

    await expect(repairCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      expectedCandidate: reviewed.candidate,
      expectedActive: initial.active!,
      env: isolation.env,
      runtime: {
        afterCandidateResolved: async () => {
          await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'concurrent repair\n');
          concurrent = await syncCatalogSourceGeneration({
            sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
            replaceDamaged: true,
            impactConfirmed: true,
          });
          await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'reviewed repair\n');
        },
      },
    })).rejects.toMatchObject({ code: 'catalogGenerationReviewStale' });

    await expect(fs.readFile(location.metadataPath, 'utf8')).resolves.toBe('damaged before race\n');
    expect(await readCatalogGenerationState(isolation.env)).toEqual({
      schemaVersion: 1,
      sources: { team: { active: concurrent!.active, lastSync: concurrent!.lastSync } },
    });
  });

  it('rejects a repair candidate with a different logical identity before store or state writes', async () => {
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
    const firstLocation = resolveCatalogStoreLocation({
      logicalIdentity: first.active!.logicalIdentity,
      snapshotDigest: first.active!.snapshotDigest,
      env: isolation.env,
    });
    const sibling = path.join(firstLocation.logicalIdentityDirectory, 'unrelated-entry');
    await fs.outputFile(sibling, 'keep');
    await fs.writeFile(firstLocation.metadataPath, 'damaged');
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', path: secondRoot, primary: true }],
      },
      expectedDigest: config.digest,
      env: isolation.env,
    });

    await expect(repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogReplaceDamagedRequired' });
    const candidateLocation = resolveCatalogStoreLocation({
      logicalIdentity: 'workspace-b',
      snapshotDigest: first.active!.snapshotDigest,
      env: isolation.env,
    });

    await expect(fs.readFile(firstLocation.metadataPath, 'utf8')).resolves.toBe('damaged');
    await expect(fs.readFile(sibling, 'utf8')).resolves.toBe('keep');
    await expect(fs.pathExists(candidateLocation.entryDir)).resolves.toBe(false);
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(first.active);
  });

  it('keeps the logical identity gate for damaged replacement unless the source config changed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = fixturePath('replace-logical-first');
    const secondRoot = fixturePath('replace-logical-second');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', [], 'first\n'),
      createCatalogSnapshotFixture(secondRoot, 'demo', [], 'second\n'),
    ]);
    await configurePathSource(firstRoot);
    const first = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const location = resolveCatalogStoreLocation({
      logicalIdentity: first.active!.logicalIdentity,
      snapshotDigest: first.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.writeFile(location.metadataPath, 'damaged\n');
    const secondMarker = await fs.readJson(path.join(secondRoot, '.aw-generated.json')) as Record<string, unknown>;
    await fs.writeJson(path.join(firstRoot, '.aw-generated.json'), secondMarker);

    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      replaceDamaged: true, impactConfirmed: true,
    })).rejects.toMatchObject({ code: 'catalogLogicalIdentityChanged' });

    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', path: secondRoot, primary: true }],
      },
      expectedDigest: config.digest,
      env: isolation.env,
    });
    await expect(syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      replaceDamaged: true, impactConfirmed: true,
    })).resolves.toMatchObject({
      outcome: 'activated',
      active: { logicalIdentity: expect.not.stringMatching(first.active!.logicalIdentity) },
    });
  });

  it('rejects a repair candidate with a different digest before store or state writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('repair-different-digest');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'first content\n');
    await configurePathSource(sourceRoot);
    const first = await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const firstLocation = resolveCatalogStoreLocation({
      logicalIdentity: first.active!.logicalIdentity,
      snapshotDigest: first.active!.snapshotDigest,
      env: isolation.env,
    });
    const sibling = path.join(firstLocation.logicalIdentityDirectory, 'unrelated-entry');
    await fs.outputFile(sibling, 'keep');
    await fs.writeFile(firstLocation.metadataPath, 'damaged');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'different content\n');
    const candidate = await probeCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const candidateLocation = resolveCatalogStoreLocation({
      logicalIdentity: candidate.candidate.logicalIdentity,
      snapshotDigest: candidate.candidate.snapshotDigest,
      env: isolation.env,
    });

    await expect(repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogReplaceDamagedRequired' });

    await expect(fs.readFile(firstLocation.metadataPath, 'utf8')).resolves.toBe('damaged');
    await expect(fs.readFile(sibling, 'utf8')).resolves.toBe('keep');
    await expect(fs.pathExists(candidateLocation.entryDir)).resolves.toBe(false);
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(first.active);
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

  it('restores the quarantined target when replacement validation fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('repair-validation-rollback');
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
    await fs.writeFile(location.metadataPath, 'damaged-before-validation');
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target);
      if (path.basename(String(source)).startsWith('.replacement-')
        && String(target) === location.entryDir) {
        await fs.writeFile(location.metadataPath, 'damaged-replacement');
      }
    });

    await expect(repairCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });
    renameSpy.mockRestore();
    await expect(fs.readFile(location.metadataPath, 'utf8')).resolves.toBe('damaged-before-validation');
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
