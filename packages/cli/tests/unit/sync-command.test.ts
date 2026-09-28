import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

const portable = vi.hoisted(() => ({ inspectResidue: vi.fn() }));
vi.mock('../../src/portable/recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/recovery.js')>(),
  inspectPortableResidue: portable.inspectResidue,
}));

import { executeRecovery, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { checkRecovery } from '../../src/recovery/status.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped sync source refresh', () => {
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
