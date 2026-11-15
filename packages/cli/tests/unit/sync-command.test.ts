import path from 'node:path';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  activateRecoverySourcesAndReprepare,
  executeRecovery,
  prepareRecovery,
  runRecovery,
} from '../../src/recovery/coordinator.js';
import { checkRecovery } from '../../src/recovery/status.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { observePreferences, setTargets } from '../../src/intent/deployment-preferences.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { observePortableSkill, portableOwnedTreeDigest, publishPortableSkill } from '../../src/portable/writer.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createCatalogSnapshotFixture as createCatalogFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function createSyncCatalogFixture(root: string, name = 'demo', capabilities: readonly string[] = [], readme = `${name}\n`) {
  await createCatalogFixture(root, name, capabilities, readme, (manifest) => {
    manifest.extensions = { instructions: [{ name: `${name}-instruction`, title: name, content: `${name}.`, coverage: ['main'] }] };
  });
}

beforeEach(async () => {
  const isolation = getCurrentSourceTestIsolation();
  await setTargets({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, ['codex']);
});

describe('scoped sync source refresh', () => {
  it('keeps Active unchanged during refresh Review and rebuilds the recovery plan after activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'review-refresh-source');
    await createSyncCatalogFixture(sourceRoot, 'demo', [], 'active\n');
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const before = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!before) throw new Error('Missing Active generation in fixture.');
    await addRoot({ scope: 'user', cwd, env }, 'local/demo', before.logicalIdentity);

    await createSyncCatalogFixture(sourceRoot, 'demo', [], 'reviewed candidate\n');
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
    await createSyncCatalogFixture(freshRoot, 'alpha', [], 'active alpha\n');
    await createSyncCatalogFixture(failedRoot, 'beta', [], 'active beta\n');
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

    await createSyncCatalogFixture(freshRoot, 'alpha', [], 'candidate alpha\n');
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
    await createSyncCatalogFixture(sourceRoot, 'demo', [], 'active\n');
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const before = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!before) throw new Error('Missing Active generation in fixture.');
    await addRoot({ scope: 'user', cwd, env }, 'local/demo', before.logicalIdentity);
    await createSyncCatalogFixture(sourceRoot, 'demo', [], 'candidate\n');
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
    await createSyncCatalogFixture(sourceRoot);
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const location = { scope: 'user' as const, cwd, env };
    const options = { ...location, cliVersion: '1.0.0' };

    const fresh = await prepareRecovery('install', ['local/demo'], options);
    expect(fresh.plannedImpact).toMatchObject({ declaration: true, preferences: false, config: false });
    await fresh.context.dispose();
    const active = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!active) throw new Error('Missing Active generation in fixture.');
    await addRoot(location, 'local/demo', active.logicalIdentity);
    const saved = await prepareRecovery('install', ['local/demo'], options);
    expect(saved.plannedImpact).toMatchObject({ declaration: false, preferences: false, config: false });
    await saved.context.dispose();
  });

  it('does not restore a failed source from its old Active generation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = { ...isolation.env, PATH: '' };
    const sourceRoot = path.join(cwd, 'source');
    await createSyncCatalogFixture(sourceRoot);
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

  it('reports a declared root without local Agents as blocked in a read-only check', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'check-source');
    await createSyncCatalogFixture(sourceRoot);
    const current = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: current.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const active = (await readCatalogGenerationState(env)).sources.local?.active;
    if (!active) throw new Error('Missing Active generation in fixture.');
    const location = { scope: 'user' as const, cwd, env };
    await setTargets(location, []);
    await addRoot(location, 'local/demo', active.logicalIdentity);
    const before = await observeIntent(location);
    const runtimeUser = path.join(isolation.layout.awHomeDir, 'runtime', 'user');
    expect(await fs.pathExists(runtimeUser)).toBe(false);

    const receipt = await checkRecovery([], { ...location, cliVersion: '1.0.0', all: true });

    expect(receipt.ok).toBe(false);
    expect(receipt.requestedRoots).toEqual(['local/demo']);
    expect(receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'targetsNotConfigured' }),
    ]));
    expect(receipt.targetResults).toEqual([]);
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(runtimeUser)).toBe(false);
  });
});

async function ownedGenericSkill(location: { cwd: string; env: NodeJS.ProcessEnv }) {
  const sourceDir = path.join(location.cwd, 'portable-source', 'demo');
  await fs.ensureDir(location.env.HOME!);
  const destinationRoot = path.join(await fs.realpath(location.env.HOME!), '.agents', 'skills');
  const identity = { pluginId: 'local/demo', logicalIdentity: 'sha256:logical',
    platform: 'generic' as const, scope: 'user' as const, skill: 'demo' };
  await fs.outputFile(path.join(sourceDir, 'SKILL.md'), '---\nname: demo\ndescription: Test skill\n---\nUse demo.\n');
  await fs.outputFile(path.join(sourceDir, 'README.md'), 'Use demo.\n');
  const expectedDigest = await portableOwnedTreeDigest(sourceDir);
  const observed = await observePortableSkill({ destinationRoot, skill: 'demo', identity });
  await publishPortableSkill({ sourceDir, destinationRoot, identity, expectedDigest,
    configDigest: `sha256:${'1'.repeat(64)}`, observed });
  return path.join(destinationRoot, 'demo');
}

describe('ordinary scoped cleanup residue', () => {
  // Test Value Gate: failed output inspection must retain every selected deployment as retryable.
  it('keeps every unobservable generic deployment in the cleanup retry set', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await addRoot(location, 'local/demo', 'sha256:logical');
    await addRoot(location, 'local/other', 'sha256:logical');
    await fs.outputFile(path.join(isolation.env.HOME!, '.agents', 'skills'), 'foreign file');

    const receipt = await runRecovery('cleanup', ['local/demo', 'local/other'], { ...location,
      cliVersion: '1.0.0', targets: ['generic'], yes: true });

    expect(receipt.remainingTargets.map((target) => `${target.pluginId}/${target.agent}`).sort())
      .toEqual(['local/demo/generic', 'local/other/generic']);
    for (const target of receipt.targetResults) expect(target.blockers)
      .toContainEqual(expect.objectContaining({ code: 'portableObservationFailed' }));
    expect(await fs.readFile(path.join(isolation.env.HOME!, '.agents', 'skills'), 'utf8')).toBe('foreign file');
    expect(receipt.outputsMayHaveChanged).toBe(false);
  });

  // Test Value Gate: offline cleanup removes only owned output and preserves strong documents and foreign skills.
  it('cleans an owned Portable copy while preserving foreign content and all strong state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await addRoot(location, 'local/demo', 'sha256:logical');
    const beforeIntent = await observeIntent(location);
    const beforePreferences = await observePreferences(location);
    const configPath = resolvePluginConfigStorePath({ ...location, sourceId: 'local', pluginName: 'demo' });
    await fs.outputFile(configPath, 'saved config bytes');
    const owned = await ownedGenericSkill(location);
    const foreign = path.join(path.dirname(owned), 'foreign', 'SKILL.md');
    await fs.outputFile(foreign, 'foreign skill bytes');

    const receipt = await runRecovery('cleanup', ['local/demo'], { ...location,
      cliVersion: '1.0.0', targets: ['generic'], yes: true });

    expect(receipt).toMatchObject({ ok: true, declarationChanged: false,
      preferencesChanged: false, configChanged: false, outputsMayHaveChanged: true, remainingTargets: [] });
    expect(await fs.pathExists(owned)).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('foreign skill bytes');
    expect(await fs.readFile(configPath, 'utf8')).toBe('saved config bytes');
    expect(await observeIntent(location)).toEqual(beforeIntent);
    expect(await observePreferences(location)).toEqual(beforePreferences);
  });

  it('removes a declaration while leaving unowned Portable output untouched', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await setTargets(location, ['generic']);
    const sourceRoot = path.join(location.cwd, 'remove-foreign-source');
    await createSyncCatalogFixture(sourceRoot);
    const sourceConfig = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: sourceConfig.digest, env: location.env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: location.env });
    const active = (await readCatalogGenerationState(location.env)).sources.local?.active;
    if (!active) throw new Error('Missing Active generation in fixture.');
    await addRoot(location, 'local/demo', active.logicalIdentity);
    const beforePreferences = await observePreferences(location);
    const foreign = path.join(isolation.env.HOME!, '.agents', 'skills', 'demo', 'SKILL.md');
    await fs.outputFile(foreign, 'legacy third-party skill');

    const receipt = await runRecovery('uninstall', ['local/demo'], { ...location,
      cliVersion: '1.0.0', yes: true });

    expect(receipt.ok, JSON.stringify(receipt, null, 2)).toBe(true);
    expect(receipt).toMatchObject({ declarationChanged: true,
      preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false });
    expect(await observeIntent(location)).toMatchObject({ state: 'valid', value: { roots: [] } });
    expect(await observePreferences(location)).toEqual(beforePreferences);
    expect(await fs.readFile(foreign, 'utf8')).toBe('legacy third-party skill');
  });

  it('rejects a stale User execution directory before any output or strong-state write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await addRoot(location, 'local/demo', 'sha256:logical');
    const before = await observeIntent(location);
    const owned = await ownedGenericSkill(location);
    const plan = await prepareRecovery('cleanup', ['local/demo'], { ...location,
      cliVersion: '1.0.0', targets: ['generic'], yes: true });
    await fs.outputFile(path.join(plan.context.executionCwd, '.codex'), 'new local config marker');

    const receipt = await executeRecovery(plan);

    expect(receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(receipt.outputsMayHaveChanged).toBe(false);
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(owned)).toBe(true);
  });

  it('rejects a changed HOME symlink target before cleanup writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const alias = path.join(isolation.layout.rootDir, 'home-alias');
    const otherHome = path.join(isolation.layout.rootDir, 'other-home');
    await fs.ensureDir(otherHome);
    await fs.ensureDir(isolation.layout.homeDir);
    await fs.symlink(isolation.layout.homeDir, alias, 'dir');
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, HOME: alias, USERPROFILE: alias } };
    await addRoot(location, 'local/demo', 'sha256:logical');
    const before = await observeIntent(location);
    await ownedGenericSkill(location);
    const plan = await prepareRecovery('cleanup', ['local/demo'], { ...location,
      cliVersion: '1.0.0', targets: ['generic'], yes: true });
    await fs.remove(alias);
    await fs.symlink(otherHome, alias, 'dir');

    const receipt = await executeRecovery(plan);

    expect(receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(receipt.outputsMayHaveChanged).toBe(false);
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(path.join(isolation.layout.homeDir, '.agents', 'skills', 'demo'))).toBe(true);
  });
});
