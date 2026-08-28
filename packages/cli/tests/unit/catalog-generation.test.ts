import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  removeCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import {
  CatalogRefreshCoordinator,
  loadCatalogGenerationViewModels,
} from '../../src/tui/catalog-generation.js';
import type {
  CatalogSource,
  CatalogSourceResolution,
  CatalogSourcesConfig,
} from '../../src/types.js';
import {
  resolveActiveCatalogGeneration,
  resolveCatalogGenerationSet,
} from '../../src/utils/catalog-generation-resolver.js';
import {
  activateCatalogSourceCandidate,
  readCatalogGenerationStatus,
  refreshCatalogSourceGeneration,
  setCatalogSourceRefreshPolicy,
} from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogGenerationLocation } from '../../src/utils/catalog-generation-store.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  resolveCatalogOperationContext,
  resolvePartialCatalogOperationContext,
} from '../../src/utils/catalog-operation-context.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
  resolveCatalogSourceRef,
} from '../../src/utils/catalog-sources.js';
import { validateCatalogSnapshot } from '../../src/utils/catalog-snapshot.js';
import {
  withResolvedMultiSourceCatalog,
  type CatalogSourceProviderSet,
} from '../../src/utils/multi-source-catalog.js';
import { setAtomicConfigBeforeRenameHookForTests } from '../../src/utils/plugin-config.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function createGenerationSnapshot(options: {
  root: string;
  workspaceIdentity: string;
  catalogVersion: string;
  content: string;
}): Promise<void> {
  await createCatalogSnapshotFixture(
    options.root,
    'demo',
    '0.1.0',
    options.content,
  );
  const manifestPath = path.join(options.root, 'catalog-manifest.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  manifest.catalogVersion = options.catalogVersion;
  manifest.channel = options.catalogVersion.includes('-beta.') ? 'beta' : 'latest';
  await Promise.all([
    fs.writeJson(manifestPath, manifest, { spaces: 2 }),
    fs.writeJson(path.join(options.root, '.aw-generated.json'), {
      schemaVersion: 1,
      kind: 'catalog',
      workspaceIdentity: options.workspaceIdentity,
      sourceIdentity: sha256(`${options.workspaceIdentity}:${options.content}`),
    }, { spaces: 2 }),
  ]);
}

async function configureSources(config: CatalogSourcesConfig): Promise<void> {
  const isolation = getCurrentSourceTestIsolation();
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config,
    expectedDigest: current.digest,
    env: isolation.env,
  });
}

async function resolutionFor(
  source: CatalogSource,
  root: string,
  commit: string,
): Promise<CatalogSourceResolution> {
  const validation = await validateCatalogSnapshot(root);
  return {
    sourceId: source.id,
    sourceIdentity: await calculateCatalogSourceIdentity(source),
    requestedRef: source.type === 'git'
      ? resolveCatalogSourceRef(source.refPolicy, '1.0.0')
      : 'path',
    resolvedCommit: source.type === 'git' ? commit : `path:${validation.snapshotDigest}`,
    rootDir: root,
    manifest: validation.manifest,
    manifestDigest: validation.manifestDigest,
    snapshotDigest: validation.snapshotDigest,
    cacheEntryKey: crypto.createHash('sha256').update(`${source.id}:${commit}`).digest('hex'),
    source: source.type === 'git' ? 'remote' : 'path',
    cacheFallback: false,
  };
}

function providers(options: {
  roots: Map<string, string>;
  commits?: Map<string, string>;
  onResolve?: () => void;
}): CatalogSourceProviderSet {
  return {
    git: async (source) => {
      options.onResolve?.();
      return resolutionFor(
        source,
        options.roots.get(source.id)!,
        options.commits?.get(source.id) ?? '1'.repeat(40),
      );
    },
    path: async (source) => {
      options.onResolve?.();
      return resolutionFor(source, options.roots.get(source.id)!, 'path');
    },
  };
}

describe('Catalog immutable generations', () => {
  it('cancels a staged refresh while it waits for the AW_HOME mutation lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('lock-cancel-first');
    const second = fixturePath('lock-cancel-second');
    const third = fixturePath('lock-cancel-third');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:lock-cancel', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: second, workspaceIdentity: 'workspace:lock-cancel', catalogVersion: '1.1.0', content: 'second\n',
      }),
      createGenerationSnapshot({
        root: third, workspaceIdentity: 'workspace:lock-cancel', catalogVersion: '1.2.0', content: 'third\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: 'https://example.invalid/team.git',
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    const roots = new Map([['team', first]]);
    const commits = new Map([['team', '1'.repeat(40)]]);
    const runtime = { providers: providers({ roots, commits }) };
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    roots.set('team', second);
    commits.set('team', '2'.repeat(40));
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    const statePath = path.join(isolation.env.AW_HOME!, 'catalog-generations.json');
    const stateBefore = await fs.readFile(statePath);
    const holderEntered = deferred();
    const releaseHolder = deferred();
    let holderCompleted = false;
    const holder = withAwHomeMutationLock({
      env: isolation.env,
      action: async () => {
        holderEntered.resolve();
        await releaseHolder.promise;
        holderCompleted = true;
      },
    });
    await holderEntered.promise;
    roots.set('team', third);
    commits.set('team', '3'.repeat(40));
    let refreshError: unknown;
    const updates: string[] = [];
    const coordinator = new CatalogRefreshCoordinator({
      maxConcurrency: 1,
      onUpdate: (_sourceId, state) => updates.push(state),
      execute: async (sourceId, signal, onState) => {
        try {
          await refreshCatalogSourceGeneration({
            sourceId,
            cliVersion: '1.0.0',
            env: isolation.env,
            signal,
            runtime: {
              ...runtime,
              onProgress: (event) => onState(event.state),
            },
          });
        } catch (error) {
          refreshError = error;
          throw error;
        }
        return {
          source: (await loadCatalogGenerationViewModels({ env: isolation.env }))[0]!,
        };
      },
    });
    const refresh = coordinator.refresh('team', 'candidateReady');
    const generationRoot = path.join(isolation.env.AW_HOME!, 'catalog-generations');
    try {
      await waitUntil(async () => {
        const entries = await fs.readdir(generationRoot).catch(() => []);
        for (const entry of entries.filter((name) => name.startsWith('.staging-'))) {
          if (await fs.pathExists(path.join(generationRoot, entry, 'generation.json'))) return true;
        }
        return false;
      }, 'prepared Catalog staging');
      expect(holderCompleted).toBe(false);
      coordinator.cancel('team');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Cancelled refresh did not settle promptly.'));
        }, 1_000);
        void refresh.then(() => {
          clearTimeout(timeout);
          resolve();
        }, (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      expect(refreshError).toMatchObject({ name: 'AbortError' });
      expect(updates.at(-1)).toBe('candidateReady');
      expect(updates).not.toContain('failed');
      expect(await fs.readFile(statePath)).toEqual(stateBefore);
      expect((await fs.readdir(generationRoot)).filter((name) => name.startsWith('.staging-')))
        .toEqual([]);
      expect(holderCompleted).toBe(false);
    } finally {
      coordinator.dispose();
      releaseHolder.resolve();
      await holder;
    }
    let reacquired = false;
    await withAwHomeMutationLock({
      env: isolation.env,
      action: async () => { reacquired = true; },
    });
    expect(reacquired).toBe(true);
  });

  it('bootstraps Git Active, no-ops the same generation, and activates a newer Candidate without a provider call', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('git-first');
    const second = fixturePath('git-second');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:team', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: second, workspaceIdentity: 'workspace:team', catalogVersion: '1.1.0', content: 'second\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: 'https://example.invalid/team.git',
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    const roots = new Map([['team', first]]);
    let providerCalls = 0;
    const runtime = { providers: providers({ roots, onResolve: () => { providerCalls += 1; } }) };

    const bootstrap = await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(bootstrap).toMatchObject({ outcome: 'activeReady', active: { catalogVersion: '1.0.0' } });
    const activeDigest = bootstrap.active!.snapshotDigest;

    await expect(refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).resolves.toMatchObject({
      outcome: 'upToDate',
      active: { snapshotDigest: activeDigest },
    });

    roots.set('team', second);
    const candidate = await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(candidate).toMatchObject({
      outcome: 'candidateReady',
      active: { catalogVersion: '1.0.0', snapshotDigest: activeDigest },
      candidate: { catalogVersion: '1.1.0', candidateKind: 'upgrade' },
    });

    const beforeActivationCalls = providerCalls;
    await expect(activateCatalogSourceCandidate({
      sourceId: 'team', env: isolation.env,
    })).resolves.toMatchObject({ outcome: 'activated', active: { catalogVersion: '1.1.0' } });
    expect(providerCalls).toBe(beforeActivationCalls);
    const status = await readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env });
    expect(status).toMatchObject({ sources: [{ active: { catalogVersion: '1.1.0' } }] });
    expect(status.sources[0]!.candidate).toBeUndefined();
  });

  it('persists Git refresh policy without a provider call and keeps Path manual', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const gitRoot = fixturePath('policy-git');
    const pathRoot = fixturePath('policy-path');
    await Promise.all([
      createGenerationSnapshot({
        root: gitRoot, workspaceIdentity: 'workspace:policy-git', catalogVersion: '1.0.0', content: 'git\n',
      }),
      createGenerationSnapshot({
        root: pathRoot, workspaceIdentity: 'workspace:policy-path', catalogVersion: '1.0.0', content: 'path\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [
        {
          id: 'team', type: 'git', primary: true, url: 'https://example.invalid/policy.git',
          refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
        },
        { id: 'local', type: 'path', primary: false, path: pathRoot },
      ],
    });
    let providerCalls = 0;
    const runtime = { providers: providers({
      roots: new Map([['team', gitRoot], ['local', pathRoot]]),
      onResolve: () => { providerCalls += 1; },
    }) };
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(providerCalls).toBe(2);

    await expect(setCatalogSourceRefreshPolicy({
      sourceId: 'team', refreshPolicy: 'manual', env: isolation.env,
    })).resolves.toMatchObject({ sourceId: 'team', refreshPolicy: 'manual' });
    expect(providerCalls).toBe(2);
    await expect(readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({ sources: [{ refreshPolicy: 'manual' }] });
    await expect(setCatalogSourceRefreshPolicy({
      sourceId: 'local', refreshPolicy: 'startup', env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationRefreshPolicyInvalid' });
    await expect(readCatalogGenerationStatus({ sourceId: 'local', env: isolation.env }))
      .resolves.toMatchObject({ sources: [{ refreshPolicy: 'manual' }] });
    expect(providerCalls).toBe(2);
  });

  it('rejects activation when Candidate changes after Review and preserves the current pointers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('candidate-drift-first');
    const second = fixturePath('candidate-drift-second');
    const third = fixturePath('candidate-drift-third');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:candidate-drift', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: second, workspaceIdentity: 'workspace:candidate-drift', catalogVersion: '1.1.0', content: 'second\n',
      }),
      createGenerationSnapshot({
        root: third, workspaceIdentity: 'workspace:candidate-drift', catalogVersion: '1.2.0', content: 'third\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: 'https://example.invalid/candidate-drift.git',
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    const roots = new Map([['team', first]]);
    const runtime = { providers: providers({ roots }) };
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    roots.set('team', second);
    const reviewed = await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    roots.set('team', third);
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });

    await expect(activateCatalogSourceCandidate({
      sourceId: 'team',
      expectedCandidateGenerationKey: reviewed.candidate!.generationKey,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationCandidateChanged' });
    await expect(readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({
        sources: [{
          active: { catalogVersion: '1.0.0' },
          candidate: { catalogVersion: '1.2.0' },
        }],
      });
  });

  it('cancels a provider refresh without changing the last successful generation state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('cancel-refresh');
    await createGenerationSnapshot({
      root, workspaceIdentity: 'workspace:cancel-refresh', catalogVersion: '1.0.0', content: 'active\n',
    });
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: 'https://example.invalid/cancel-refresh.git',
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      runtime: { providers: providers({ roots: new Map([['team', root]]) }) },
    });
    const before = await readCatalogGenerationState(isolation.env);
    const entered = deferred();
    const abort = new AbortController();
    const refresh = refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, signal: abort.signal,
      runtime: {
        providers: {
          path: async () => { throw new Error('unused'); },
          git: async (_source, context) => {
            entered.resolve();
            return new Promise<CatalogSourceResolution>((_resolve, reject) => {
              context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
            });
          },
        },
      },
    });
    await entered.promise;
    abort.abort(new Error('cancelled by TUI'));
    await expect(refresh).rejects.toThrow('cancelled by TUI');
    expect(await readCatalogGenerationState(isolation.env)).toEqual(before);
  });

  it('rejects workspace identity drift from an unchanged real Git source', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const workRoot = fixturePath('identity-drift-work');
    const remoteRoot = fixturePath('identity-drift.git');
    await createGenerationSnapshot({
      root: workRoot,
      workspaceIdentity: 'workspace:stable',
      catalogVersion: '1.0.0',
      content: 'stable\n',
    });
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workRoot });
    await execFileAsync('git', ['add', '.'], { cwd: workRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'initial catalog',
    ], { cwd: workRoot });
    await execFileAsync('git', ['init', '--bare', remoteRoot]);
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: workRoot });
    await execFileAsync('git', ['push', 'origin', 'HEAD:refs/heads/catalog/latest'], { cwd: workRoot });
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: remoteRoot,
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const stateBeforeDrift = await readCatalogGenerationState(isolation.env);

    const markerPath = path.join(workRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath);
    marker.workspaceIdentity = 'workspace:unexpected';
    await fs.writeJson(markerPath, marker, { spaces: 2 });
    await execFileAsync('git', ['add', '.aw-generated.json'], { cwd: workRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'change workspace identity',
    ], { cwd: workRoot });
    await execFileAsync('git', ['push', 'origin', 'HEAD:refs/heads/catalog/latest'], { cwd: workRoot });

    await expect(refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationIdentityMismatch' });
    expect(await readCatalogGenerationState(isolation.env)).toEqual(stateBeforeDrift);
    await expect(resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({ logicalIdentity: 'workspace:stable' });
  });

  it('discards an old refresh after a source URL update establishes a new Active', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const oldRoot = fixturePath('stale-update-old');
    const newRoot = fixturePath('stale-update-new');
    await Promise.all([
      createGenerationSnapshot({
        root: oldRoot, workspaceIdentity: 'workspace:old', catalogVersion: '1.0.0', content: 'old\n',
      }),
      createGenerationSnapshot({
        root: newRoot, workspaceIdentity: 'workspace:new', catalogVersion: '1.0.0', content: 'new\n',
      }),
    ]);
    const oldUrl = 'https://old.example.invalid/catalog.git';
    const newUrl = 'https://new.example.invalid/catalog.git';
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: oldUrl,
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    const oldEntered = deferred();
    const releaseOld = deferred();
    const runtime = {
      providers: {
        git: async (source: Extract<CatalogSource, { type: 'git' }>) => {
          if (source.url === oldUrl) {
            oldEntered.resolve();
            await releaseOld.promise;
            return resolutionFor(source, oldRoot, '1'.repeat(40));
          }
          return resolutionFor(source, newRoot, '2'.repeat(40));
        },
        path: async () => { throw new Error('unused'); },
      },
    } satisfies { providers: CatalogSourceProviderSet };

    const oldRefresh = refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    await oldEntered.promise;
    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { type: 'git', url: newUrl },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: { generation: runtime },
    })).resolves.toMatchObject({ ok: true, changed: true, errors: [] });
    const stateAfterUpdate = await readCatalogGenerationState(isolation.env);
    expect(stateAfterUpdate.sources.team).toMatchObject({
      logicalIdentity: 'workspace:new', active: { resolvedCommit: '2'.repeat(40) },
    });

    releaseOld.resolve();
    await expect(oldRefresh).rejects.toMatchObject({ code: 'catalogGenerationIdentityMismatch' });
    expect(await readCatalogGenerationState(isolation.env)).toEqual(stateAfterUpdate);
    await expect(resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({ logicalIdentity: 'workspace:new' });
  });

  it('discards an old refresh after its source is removed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = fixturePath('stale-remove-primary');
    const removedRoot = fixturePath('stale-remove-source');
    await Promise.all([
      createGenerationSnapshot({
        root: primaryRoot, workspaceIdentity: 'workspace:primary', catalogVersion: '1.0.0', content: 'primary\n',
      }),
      createGenerationSnapshot({
        root: removedRoot, workspaceIdentity: 'workspace:removed', catalogVersion: '1.0.0', content: 'removed\n',
      }),
    ]);
    const removedUrl = 'https://removed.example.invalid/catalog.git';
    await configureSources({
      schemaVersion: 1,
      sources: [
        { id: 'primary', type: 'path', primary: true, path: primaryRoot },
        {
          id: 'team', type: 'git', primary: false, url: removedUrl,
          refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
        },
      ],
    });
    const oldEntered = deferred();
    const releaseOld = deferred();
    const runtime = {
      providers: {
        git: async (source: Extract<CatalogSource, { type: 'git' }>) => {
          oldEntered.resolve();
          await releaseOld.promise;
          return resolutionFor(source, removedRoot, '3'.repeat(40));
        },
        path: async () => { throw new Error('unused'); },
      },
    } satisfies { providers: CatalogSourceProviderSet };
    const oldRefresh = refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    await oldEntered.promise;
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true });

    releaseOld.resolve();
    await expect(oldRefresh).rejects.toMatchObject({ code: 'catalogGenerationSourceMissing' });
    expect((await readCatalogGenerationState(isolation.env)).sources.team).toBeUndefined();
  });

  it('rejects one Git version with different content across source IDs and preserves existing pointers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('immutable-first');
    const changed = fixturePath('immutable-changed');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:shared', catalogVersion: '2.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: changed, workspaceIdentity: 'workspace:shared', catalogVersion: '2.0.0', content: 'changed\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [
        {
          id: 'alias-a', type: 'git', primary: true, url: 'https://example.invalid/shared.git',
          refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
        },
        {
          id: 'alias-b', type: 'git', primary: false, url: 'ssh://git@example.invalid/shared.git',
          refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
        },
      ],
    });
    const roots = new Map([['alias-a', first], ['alias-b', changed]]);
    const runtime = { providers: providers({ roots }) };
    const active = await refreshCatalogSourceGeneration({
      sourceId: 'alias-a', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    await expect(refreshCatalogSourceGeneration({
      sourceId: 'alias-b', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).rejects.toMatchObject({ code: 'catalogImmutableVersionViolation' });
    const state = await readCatalogGenerationState(isolation.env);
    expect(state.sources['alias-a']?.active?.snapshotDigest).toBe(active.active!.snapshotDigest);
    expect(state.sources['alias-a']?.candidate).toBeUndefined();
    expect(state.sources['alias-b']?.active).toBeUndefined();
    expect(state.sources['alias-b']?.candidate).toBeUndefined();
    expect(state.sources['alias-b']?.lastCheck).toMatchObject({
      state: 'immutableViolation', errorCode: 'catalogImmutableVersionViolation',
    });
  });

  it('keeps a Git Active on channel rollback and permits an explicit ref-change Candidate', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const current = fixturePath('rollback-current');
    const older = fixturePath('rollback-older');
    await Promise.all([
      createGenerationSnapshot({
        root: current, workspaceIdentity: 'workspace:rollback', catalogVersion: '3.0.0', content: 'current\n',
      }),
      createGenerationSnapshot({
        root: older, workspaceIdentity: 'workspace:rollback', catalogVersion: '2.0.0', content: 'older\n',
      }),
    ]);
    const source = {
      id: 'team', type: 'git' as const, primary: true,
      url: 'https://example.invalid/rollback.git',
      refPolicy: { type: 'explicit' as const, ref: 'refs/heads/catalog/latest' },
    };
    await configureSources({ schemaVersion: 1, sources: [source] });
    const roots = new Map([['team', current]]);
    const runtime = { providers: providers({ roots }) };
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    roots.set('team', older);
    const rollback = await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(rollback).toMatchObject({
      outcome: 'channelRollback', active: { catalogVersion: '3.0.0' },
    });
    expect(rollback.candidate).toBeUndefined();

    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ ...source, refPolicy: { type: 'explicit', ref: 'refs/heads/legacy' } }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await expect(resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env }))
      .rejects.toMatchObject({ code: 'catalogGenerationIdentityMismatch' });
    await expect(refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    })).resolves.toMatchObject({
      outcome: 'candidateReady',
      active: { catalogVersion: '3.0.0' },
      candidate: { catalogVersion: '2.0.0', candidateKind: 'refChange' },
    });
    await expect(readCatalogGenerationStatus({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({
        sources: [{
          active: { catalogVersion: '3.0.0' },
          candidate: { catalogVersion: '2.0.0', candidateKind: 'refChange' },
        }],
      });
  });

  it('refreshes a Path source directly to Active even when the Catalog version is unchanged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('path-first');
    const changed = fixturePath('path-changed');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:path', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: changed, workspaceIdentity: 'workspace:path', catalogVersion: '1.0.0', content: 'changed\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: first }],
    });
    const roots = new Map([['local', first]]);
    const runtime = { providers: providers({ roots }) };
    const initial = await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    roots.set('local', changed);
    const refreshed = await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(refreshed).toMatchObject({
      outcome: 'activeReady', active: { catalogVersion: '1.0.0' },
    });
    expect(refreshed.candidate).toBeUndefined();
    expect(refreshed.active!.snapshotDigest).not.toBe(initial.active!.snapshotDigest);
  });

  it('preserves Active when activation state replacement or generation publication fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('atomic-first');
    const second = fixturePath('atomic-second');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:atomic', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: second, workspaceIdentity: 'workspace:atomic', catalogVersion: '2.0.0', content: 'second\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: 'https://example.invalid/atomic.git',
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    const roots = new Map([['team', first]]);
    const runtime = { providers: providers({ roots }) };
    const active = await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    roots.set('team', second);
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    setAtomicConfigBeforeRenameHookForTests(async (targetPath) => {
      if (path.basename(targetPath) === 'catalog-generations.json') {
        throw new Error('injected state failure');
      }
    });
    try {
      await expect(activateCatalogSourceCandidate({
        sourceId: 'team',
        env: isolation.env,
      })).rejects.toThrow('injected state failure');
    } finally {
      setAtomicConfigBeforeRenameHookForTests(undefined);
    }
    let state = await readCatalogGenerationState(isolation.env);
    expect(state.sources.team?.active?.snapshotDigest).toBe(active.active!.snapshotDigest);
    expect(state.sources.team?.candidate?.catalogVersion).toBe('2.0.0');

    const pathFirst = fixturePath('publish-first');
    const pathChanged = fixturePath('publish-changed');
    await Promise.all([
      createGenerationSnapshot({
        root: pathFirst, workspaceIdentity: 'workspace:publish', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: pathChanged, workspaceIdentity: 'workspace:publish', catalogVersion: '1.0.0', content: 'changed\n',
      }),
    ]);
    const beforeConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: pathFirst }],
      },
      expectedDigest: beforeConfig.digest,
      env: isolation.env,
    });
    const pathRoots = new Map([['local', pathFirst]]);
    const pathRuntime = { providers: providers({ roots: pathRoots }) };
    const pathActive = await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, runtime: pathRuntime,
    });
    pathRoots.set('local', pathChanged);
    const changedValidation = await validateCatalogSnapshot(pathChanged);
    const blocked = resolveCatalogGenerationLocation({
      logicalIdentity: 'workspace:publish',
      snapshotDigest: changedValidation.snapshotDigest,
      env: isolation.env,
    });
    await fs.ensureDir(blocked.logicalIdentityDirectory);
    await fs.writeFile(blocked.generationDir, 'blocked\n');
    await expect(refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, runtime: pathRuntime,
    })).rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });
    state = await readCatalogGenerationState(isolation.env);
    expect(state.sources.local?.active?.snapshotDigest).toBe(pathActive.active!.snapshotDigest);
  });

  it('fails recoverably for damaged state and generation metadata', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('damaged');
    await createGenerationSnapshot({
      root, workspaceIdentity: 'workspace:damaged', catalogVersion: '1.0.0', content: 'content\n',
    });
    await configureSources({
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: root }],
    });
    const runtime = { providers: providers({ roots: new Map([['local', root]]) }) };
    const active = await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    const statePath = path.join(isolation.env.AW_HOME!, 'catalog-generations.json');
    const validState = await fs.readFile(statePath);
    await fs.writeFile(statePath, '{"schemaVersion":99}\n');
    await expect(readCatalogGenerationStatus({ env: isolation.env }))
      .rejects.toMatchObject({ code: 'catalogGenerationStateInvalid' });
    await fs.writeFile(statePath, validState);

    const location = resolveCatalogGenerationLocation({
      logicalIdentity: 'workspace:damaged',
      snapshotDigest: active.active!.snapshotDigest,
      env: isolation.env,
    });
    const validMetadata = await fs.readFile(location.metadataPath);
    await fs.writeFile(location.metadataPath, '{}\n');
    await expect(readCatalogGenerationStatus({ env: isolation.env }))
      .rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });
    await fs.writeFile(location.metadataPath, validMetadata);
    await expect(readCatalogGenerationStatus({ env: isolation.env }))
      .resolves.toMatchObject({ sources: [{ active: { catalogVersion: '1.0.0' } }] });
  });

  it('keeps healthy generation view models when another source metadata is damaged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const healthyRoot = fixturePath('view-model-healthy');
    const damagedRoot = fixturePath('view-model-damaged');
    await Promise.all([
      createGenerationSnapshot({
        root: healthyRoot, workspaceIdentity: 'workspace:view-model-healthy', catalogVersion: '1.0.0', content: 'healthy\n',
      }),
      createGenerationSnapshot({
        root: damagedRoot, workspaceIdentity: 'workspace:view-model-damaged', catalogVersion: '1.0.0', content: 'damaged\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [
        { id: 'healthy', type: 'path', primary: true, path: healthyRoot },
        { id: 'damaged', type: 'path', primary: false, path: damagedRoot },
      ],
    });
    const runtime = { providers: providers({ roots: new Map([
      ['healthy', healthyRoot], ['damaged', damagedRoot],
    ]) }) };
    const [healthy, damaged] = await Promise.all([
      refreshCatalogSourceGeneration({
        sourceId: 'healthy', cliVersion: '1.0.0', env: isolation.env, runtime,
      }),
      refreshCatalogSourceGeneration({
        sourceId: 'damaged', cliVersion: '1.0.0', env: isolation.env, runtime,
      }),
    ]);
    const damagedLocation = resolveCatalogGenerationLocation({
      logicalIdentity: 'workspace:view-model-damaged',
      snapshotDigest: damaged.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.writeFile(damagedLocation.metadataPath, '{}\n');

    await expect(loadCatalogGenerationViewModels({ env: isolation.env })).resolves.toEqual([
      expect.objectContaining({
        sourceId: 'damaged', refreshState: 'failed',
        lastCheckCode: 'catalogGenerationMetadataInvalid',
      }),
      expect.objectContaining({
        sourceId: 'healthy', refreshState: 'idle',
        active: expect.objectContaining({ catalogVersion: '1.0.0' }),
      }),
    ]);
    expect(healthy.active?.catalogVersion).toBe('1.0.0');
  });

  it('does not reuse an old source-ID pointer after the configured source identity changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('identity-first');
    const replacement = fixturePath('identity-replacement');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:identity-first', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: replacement, workspaceIdentity: 'workspace:identity-replacement', catalogVersion: '1.0.0', content: 'replacement\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: first }],
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env,
      runtime: { providers: providers({ roots: new Map([['local', first]]) }) },
    });
    const receipt = await updateCatalogSourceCommand({
      sourceId: 'local',
      update: { type: 'path', path: replacement },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: { beforeRefresh: () => fs.remove(replacement) },
    });
    expect(receipt).toMatchObject({ ok: true, changed: true, errors: [expect.any(Object)] });
    expect((await readCatalogGenerationState(isolation.env)).sources.local).toBeUndefined();
    const status = await readCatalogGenerationStatus({ sourceId: 'local', env: isolation.env });
    expect(status.sources).toMatchObject([{ sourceId: 'local' }]);
    expect(status.sources[0]!.active).toBeUndefined();
  });

  it('returns a stable generation-set digest and immutable local snapshot paths', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('set-first');
    const second = fixturePath('set-second');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:set-a', catalogVersion: '1.0.0', content: 'a\n',
      }),
      createGenerationSnapshot({
        root: second, workspaceIdentity: 'workspace:set-b', catalogVersion: '2.0.0', content: 'b\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [
        { id: 'a', type: 'path', primary: true, path: first },
        { id: 'b', type: 'path', primary: false, path: second },
      ],
    });
    const runtime = { providers: providers({ roots: new Map([['a', first], ['b', second]]) }) };
    await Promise.all(['a', 'b'].map((sourceId) => refreshCatalogSourceGeneration({
      sourceId, cliVersion: '1.0.0', env: isolation.env, runtime,
    })));
    const before = await resolveCatalogGenerationSet({ env: isolation.env });
    await fs.writeFile(path.join(first, 'plugins', 'demo', 'README.md'), 'mutable source changed\n');
    const after = await resolveCatalogGenerationSet({ env: isolation.env });
    expect(after.generationSetDigest).toBe(before.generationSetDigest);
    expect(after.sources.map((source) => source.sourceId)).toEqual(['a', 'b']);
    for (const source of after.sources) {
      expect(source.snapshotPath).toContain(path.join(isolation.env.AW_HOME!, 'catalog-generations'));
      await expect(validateCatalogSnapshot(source.snapshotPath)).resolves.toMatchObject({
        snapshotDigest: source.snapshotDigest,
      });
    }
  });

  it('bootstraps exactly once, keeps Candidate out of ordinary contexts, and changes only after activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('operation-first');
    const second = fixturePath('operation-second');
    await Promise.all([
      createGenerationSnapshot({
        root: first, workspaceIdentity: 'workspace:operation', catalogVersion: '1.0.0', content: 'first\n',
      }),
      createGenerationSnapshot({
        root: second, workspaceIdentity: 'workspace:operation', catalogVersion: '2.0.0', content: 'second\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [{
        id: 'team', type: 'git', primary: true, url: 'https://example.invalid/operation.git',
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }],
    });
    const roots = new Map([['team', first]]);
    let providerCalls = 0;
    const runtime = { providers: providers({
      roots,
      onResolve: () => { providerCalls += 1; },
    }) };

    const bootstrapped = await resolveCatalogOperationContext({
      cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(providerCalls).toBe(1);
    expect(bootstrapped.catalog.sources[0]!.resolution!.rootDir)
      .toContain(path.join(isolation.env.AW_HOME!, 'catalog-generations'));
    await resolveCatalogOperationContext({ cliVersion: '1.0.0', env: isolation.env, runtime });
    expect(providerCalls).toBe(1);

    roots.set('team', second);
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    const withCandidate = await resolveCatalogOperationContext({
      cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(withCandidate.generationSetDigest).toBe(bootstrapped.generationSetDigest);
    expect(withCandidate.catalog.sources[0]!.resolution!.manifest.catalogVersion).toBe('1.0.0');
    expect(providerCalls).toBe(2);

    await activateCatalogSourceCandidate({ sourceId: 'team', env: isolation.env });
    const activated = await resolveCatalogOperationContext({
      cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    expect(activated.generationSetDigest).not.toBe(bootstrapped.generationSetDigest);
    expect(activated.catalog.sources[0]!.resolution!.manifest.catalogVersion).toBe('2.0.0');
    expect(providerCalls).toBe(2);
  });

  it('reports one failed bootstrap without resolving an existing Active source remotely', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const activeRoot = fixturePath('partial-active');
    const missingRoot = fixturePath('partial-missing');
    await Promise.all([
      createGenerationSnapshot({
        root: activeRoot, workspaceIdentity: 'workspace:active', catalogVersion: '1.0.0', content: 'active\n',
      }),
      createGenerationSnapshot({
        root: missingRoot, workspaceIdentity: 'workspace:missing', catalogVersion: '1.0.0', content: 'missing\n',
      }),
    ]);
    await configureSources({
      schemaVersion: 1,
      sources: [
        { id: 'active', type: 'path', primary: true, path: activeRoot },
        {
          id: 'missing', type: 'git', primary: false, url: 'https://example.invalid/missing.git',
          refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
        },
      ],
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'active', cliVersion: '1.0.0', env: isolation.env,
      runtime: { providers: providers({ roots: new Map([['active', activeRoot]]) }) },
    });
    let activeCalls = 0;
    let missingCalls = 0;
    const failingProviders: CatalogSourceProviderSet = {
      path: async () => {
        activeCalls += 1;
        throw new Error('existing Active must not resolve its provider');
      },
      git: async () => {
        missingCalls += 1;
        throw new Error('offline');
      },
    };

    const catalog = await withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0', freshnessPolicy: 'cacheFirst', env: isolation.env,
      providers: failingProviders,
      consume: (resolution) => ({
        available: resolution.sources.filter((source) => source.resolution).map((source) => source.sourceId),
        failed: resolution.sources.filter((source) => source.error).map((source) => source.sourceId),
        messages: resolution.sources.flatMap((source) => source.error ? [source.error.message] : []),
      }),
    });
    expect(catalog).toMatchObject({ available: ['active'], failed: ['missing'] });
    expect(catalog.messages[0]).toContain('aw catalog source refresh missing');
    expect(activeCalls).toBe(0);
    expect(missingCalls).toBe(1);
  });

  it('binds successful Active sources when another source bootstrap fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const activeRoot = fixturePath('partial-context-active');
    await createGenerationSnapshot({
      root: activeRoot,
      workspaceIdentity: 'workspace:partial-context-active',
      catalogVersion: '1.0.0',
      content: 'active\n',
    });
    await configureSources({
      schemaVersion: 1,
      sources: [
        { id: 'active', type: 'path', primary: true, path: activeRoot },
        {
          id: 'missing', type: 'git', primary: false,
          url: 'https://example.invalid/partial-context.git',
          refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
        },
      ],
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'active', cliVersion: '1.0.0', env: isolation.env,
      runtime: { providers: providers({ roots: new Map([['active', activeRoot]]) }) },
    });
    let activeCalls = 0;
    let missingCalls = 0;
    const context = await resolvePartialCatalogOperationContext({
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: {
        providers: {
          path: async () => {
            activeCalls += 1;
            throw new Error('bound Active source must stay local');
          },
          git: async () => {
            missingCalls += 1;
            throw new Error('offline');
          },
        },
      },
    });
    expect(context.generationSet.sources.map((source) => source.sourceId)).toEqual(['active']);
    expect(context.catalog.sources).toEqual([
      expect.objectContaining({ sourceId: 'active', resolution: expect.any(Object) }),
      expect.objectContaining({ sourceId: 'missing', error: expect.any(Error) }),
    ]);
    expect(context.generationSetDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(activeCalls).toBe(0);
    expect(missingCalls).toBe(1);
  });

  it('fails closed for a damaged Active without automatic provider recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('operation-damaged');
    await createGenerationSnapshot({
      root, workspaceIdentity: 'workspace:operation-damaged', catalogVersion: '1.0.0', content: 'content\n',
    });
    await configureSources({
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: root }],
    });
    const runtime = { providers: providers({ roots: new Map([['local', root]]) }) };
    const active = await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, runtime,
    });
    const location = resolveCatalogGenerationLocation({
      logicalIdentity: 'workspace:operation-damaged',
      snapshotDigest: active.active!.snapshotDigest,
      env: isolation.env,
    });
    await fs.writeFile(path.join(location.snapshotRoot, 'catalog-manifest.json'), '{}\n');
    let providerCalls = 0;
    await expect(resolveCatalogOperationContext({
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: { providers: providers({
        roots: new Map([['local', root]]),
        onResolve: () => { providerCalls += 1; },
      }) },
    })).rejects.toMatchObject({ code: 'catalogGenerationMetadataInvalid' });
    expect(providerCalls).toBe(0);
  });
});
