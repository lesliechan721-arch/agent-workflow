import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

const portable = vi.hoisted(() => ({ inspectResidue: vi.fn() }));
vi.mock('../../src/portable/recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/recovery.js')>(),
  inspectPortableResidue: portable.inspectResidue,
}));

import {
  activateRecoverySourcesAndReprepare,
  executeRecovery,
  prepareRecovery,
  runRecovery,
} from '../../src/recovery/coordinator.js';
import { checkRecovery } from '../../src/recovery/status.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped sync source refresh', () => {
  it('keeps Active unchanged during refresh Review and rebuilds the recovery plan after activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'review-refresh-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'active\n');
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const before = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!before) throw new Error('Missing Active generation in fixture.');
    await addRoot({ scope: 'user', cwd, env }, 'local/demo', before.logicalIdentity);

    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'reviewed candidate\n');
    const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    await fs.writeJson(manifestPath, { ...manifest, catalogVersion: '2.0.0' }, { spaces: 2 });

    const plan = await prepareRecovery('sync', ['local/demo'], { scope: 'user', cwd, env,
      cliVersion: '1.0.0', targets: ['codex'], refresh: true });
    expect(plan.sourceRefreshes).toHaveLength(1);
    expect((await readCatalogGenerationState(env)).sources.local?.active).toEqual(before);
    const reviewedDigest = plan.sourceRefreshes[0]!.candidate.snapshotDigest;

    const rebuilt = await activateRecoverySourcesAndReprepare(plan);
    const activated = (await readCatalogGenerationState(env)).sources.local?.active;
    expect(activated?.snapshotDigest).toBe(reviewedDigest);
    expect(activated?.snapshotDigest).not.toBe(before.snapshotDigest);
    expect(rebuilt.sourceRefreshes).toEqual([]);
    expect(rebuilt.demand.catalogOperationContext?.generationSetDigest)
      .not.toBe(plan.demand.catalogOperationContext?.generationSetDigest);
    await rebuilt.context.dispose();
  });

  it('keeps a failed source blocked after another source is activated and the recovery plan is rebuilt', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const freshRoot = path.join(cwd, 'mixed-refresh-fresh');
    const failedRoot = path.join(cwd, 'mixed-refresh-failed');
    await createCatalogSnapshotFixture(freshRoot, 'alpha', [], 'active alpha\n');
    await createCatalogSnapshotFixture(failedRoot, 'beta', [], 'active beta\n');
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'fresh', type: 'path', primary: true, path: freshRoot },
      { id: 'failed', type: 'path', primary: false, path: failedRoot },
    ] }, expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'fresh', cliVersion: '1.0.0', env });
    await syncCatalogSourceGeneration({ sourceId: 'failed', cliVersion: '1.0.0', env });
    const state = await readCatalogGenerationState(env);
    const freshActive = state.sources.fresh?.active;
    const failedActive = state.sources.failed?.active;
    if (!freshActive || !failedActive) throw new Error('Missing Active generation in fixture.');
    await addRoot({ scope: 'user', cwd, env }, 'fresh/alpha', freshActive.logicalIdentity);
    await addRoot({ scope: 'user', cwd, env }, 'failed/beta', failedActive.logicalIdentity);

    await createCatalogSnapshotFixture(freshRoot, 'alpha', [], 'candidate alpha\n');
    const manifestPath = path.join(freshRoot, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    await fs.writeJson(manifestPath, { ...manifest, catalogVersion: '2.0.0' }, { spaces: 2 });
    await fs.remove(failedRoot);

    const plan = await prepareRecovery('sync', ['fresh/alpha', 'failed/beta'], {
      scope: 'user', cwd, env, cliVersion: '1.0.0', targets: ['codex'], refresh: true,
    });
    expect(plan.sourceRefreshes.map((entry) => entry.sourceId)).toEqual(['fresh']);
    expect(plan.sourceRefreshFailures).toEqual([
      { sourceId: 'failed', code: 'catalogGenerationRefreshFailed' },
    ]);

    const rebuilt = await activateRecoverySourcesAndReprepare(plan);
    expect((await readCatalogGenerationState(env)).sources.fresh?.active.snapshotDigest)
      .toBe(plan.sourceRefreshes[0]!.candidate.snapshotDigest);
    expect(rebuilt.receipt.targetResults.find((target) => target.pluginId === 'failed/beta')?.blockers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'catalogGenerationRefreshFailed' }),
      ]));
    await rebuilt.context.dispose();
  });

  it('does not activate a refresh without explicit source confirmation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'unconfirmed-refresh-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'active\n');
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const before = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!before) throw new Error('Missing Active generation in fixture.');
    await addRoot({ scope: 'user', cwd, env }, 'local/demo', before.logicalIdentity);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'candidate\n');
    const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    await fs.writeJson(manifestPath, { ...manifest, catalogVersion: '2.0.0' }, { spaces: 2 });

    const receipt = await runRecovery('sync', ['local/demo'], { scope: 'user', cwd, env,
      cliVersion: '1.0.0', targets: ['codex'], refresh: true });

    expect(receipt.blockers).toContainEqual(expect.objectContaining({
      code: 'sourceRefreshConfirmationRequired',
    }));
    expect((await readCatalogGenerationState(env)).sources.local?.active).toEqual(before);
  });

  it('reviews a new install declaration separately from an already saved root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'install-review-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const location = { scope: 'user' as const, cwd, env };
    const options = { ...location, cliVersion: '1.0.0', targets: [] };

    const fresh = await prepareRecovery('install', ['local/demo'], options);
    expect(fresh.plannedImpact).toEqual({ declaration: true, preferences: false,
      config: false, outputs: false });
    await fresh.context.dispose();
    const active = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!active) throw new Error('Missing Active generation in fixture.');
    await addRoot(location, 'local/demo', active.logicalIdentity);
    const saved = await prepareRecovery('install', ['local/demo'], options);
    expect(saved.plannedImpact).toEqual({ declaration: false, preferences: false,
      config: false, outputs: false });
    await saved.context.dispose();
  });

  it('does not restore a failed source from its old Active generation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = { ...isolation.env, PATH: '' };
    const sourceRoot = path.join(cwd, 'source');
    await createCatalogSnapshotFixture(sourceRoot);
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const active = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!active) throw new Error('Missing Active generation in fixture.');
    await addRoot({ scope: 'user', cwd, env }, 'local/demo', active.logicalIdentity);
    const before = await observeIntent({ scope: 'user', cwd, env });
    await fs.remove(sourceRoot);

    const receipt = await runRecovery('sync', ['local/demo'], { scope: 'user', cwd, env,
      cliVersion: '1.0.0', targets: ['codex'], refresh: true, yes: true });

    expect(receipt.ok).toBe(false);
    expect(receipt.targetResults).toEqual([expect.objectContaining({ pluginId: 'local/demo',
      agent: 'codex', execution: 'not-run', blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'catalogGenerationRefreshFailed' }),
      ]) })]);
    expect(receipt.outputsMayHaveChanged).toBe(false);
    expect(await observeIntent({ scope: 'user', cwd, env })).toEqual(before);
  });

  it('reports a declared root without local Agents as blocked in read-only --all check', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'check-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const active = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!active) throw new Error('Missing Active generation in fixture.');
    const location = { scope: 'user' as const, cwd, env };
    await addRoot(location, 'local/demo', active.logicalIdentity);
    const before = await observeIntent(location);
    const runtimeUser = path.join(isolation.layout.awHomeDir, 'runtime', 'user');
    expect(await fs.pathExists(runtimeUser)).toBe(false);

    const receipt = await checkRecovery([], { ...location, cliVersion: '1.0.0', all: true });

    expect(receipt.ok).toBe(false);
    expect(receipt.requestedRoots).toEqual(['local/demo']);
    expect(receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'localTargetsRequired' }),
    ]));
    expect(receipt.targetResults).toEqual([]);
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(runtimeUser)).toBe(false);
  });
});

describe('ordinary scoped cleanup residue', () => {
  it('keeps each uncertain Agent in the cleanup retry set beside confirmed Portable residue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await addRoot(location, 'local/demo', 'sha256:logical');
    portable.inspectResidue.mockResolvedValue({ state: 'present', blockers: ['portableObservationFailed'],
      unknownAgents: ['claude-code'], targets: [{ skill: 'demo', agent: 'codex',
        physicalPath: path.join(isolation.layout.homeDir, '.agents', 'skills', 'demo') }] });

    const receipt = await runRecovery('cleanup', ['local/demo'], { ...location,
      cliVersion: '1.0.0', targets: ['codex', 'claude-code'], yes: true });
    expect(receipt.remainingTargets.map((target) => target.agent).sort()).toEqual(['claude-code', 'codex']);
    expect(receipt.targetResults.find((target) => target.agent === 'codex')?.blockers)
      .toContainEqual(expect.objectContaining({ code: 'backend-action-unsupported' }));
    expect(receipt.targetResults.find((target) => target.agent === 'claude-code')?.blockers)
      .toContainEqual(expect.objectContaining({ code: 'portableObservationFailed' }));
    portable.inspectResidue.mockReset();
  });
  it.each(['cleanup', 'uninstall'] as const)('keeps strong config and reports precise Portable residue for %s', async (command) => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await addRoot(location, 'local/demo', 'sha256:logical');
    const before = await observeIntent(location);
    const physicalPath = path.join(isolation.layout.homeDir, '.agents', 'skills', 'demo');
    portable.inspectResidue.mockResolvedValue({ state: 'present', blockers: [], targets: [
      { skill: 'demo', agent: 'cursor', physicalPath },
    ] });

    const receipt = await runRecovery(command, ['local/demo'], { ...location,
      cliVersion: '1.0.0', targets: ['cursor'], yes: true });

    expect(receipt).toMatchObject({ ok: false, declarationChanged: false,
      preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false });
    expect(receipt.remainingTargets).toEqual([expect.objectContaining({
      pluginId: 'local/demo', agent: 'cursor', scope: 'user',
    })]);
    expect(receipt.targetResults[0]?.recoveryActions?.join('\n')).toContain(physicalPath);
    expect(await observeIntent(location)).toEqual(before);
    expect(portable.inspectResidue).toHaveBeenCalledTimes(2);
    portable.inspectResidue.mockReset();
  });

  it('rejects a stale User execution directory before any output or strong-state write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await addRoot(location, 'local/demo', 'sha256:logical');
    const before = await observeIntent(location);
    portable.inspectResidue.mockResolvedValue({ state: 'absent', blockers: [], targets: [] });
    const plan = await prepareRecovery('cleanup', ['local/demo'], { ...location,
      cliVersion: '1.0.0', targets: ['cursor'], yes: true });
    await fs.outputFile(path.join(plan.context.executionCwd, '.codex'), 'new local config marker');

    const receipt = await executeRecovery(plan);

    expect(receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(receipt.outputsMayHaveChanged).toBe(false);
    expect(await observeIntent(location)).toEqual(before);
    expect(portable.inspectResidue).toHaveBeenCalledOnce();
    portable.inspectResidue.mockReset();
  });

  it('rejects a changed HOME symlink target before cleanup writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const alias = path.join(isolation.layout.rootDir, 'home-alias');
    const otherHome = path.join(isolation.layout.rootDir, 'other-home');
    await fs.ensureDir(otherHome);
    await fs.symlink(isolation.layout.homeDir, alias, 'dir');
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, HOME: alias, USERPROFILE: alias } };
    await addRoot(location, 'local/demo', 'sha256:logical');
    const before = await observeIntent(location);
    portable.inspectResidue.mockResolvedValue({ state: 'absent', blockers: [], targets: [] });
    const plan = await prepareRecovery('cleanup', ['local/demo'], { ...location,
      cliVersion: '1.0.0', targets: ['cursor'], yes: true });
    await fs.remove(alias);
    await fs.symlink(otherHome, alias, 'dir');

    const receipt = await executeRecovery(plan);

    expect(receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(receipt.outputsMayHaveChanged).toBe(false);
    expect(await observeIntent(location)).toEqual(before);
    expect(portable.inspectResidue).toHaveBeenCalledOnce();
    portable.inspectResidue.mockReset();
  });
});
