import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { runPublicLifecycle, type LifecycleData } from '../../src/commands/public-lifecycle.js';
import { runPublicPluginList, runPublicPluginShow, runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { createNativeDependencyCatalog, createCodexNativeTestRuntime } from '../helpers/write-command-fixture.js';
import { syncManagedCommandPackage, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { normalizeCommandDefinition } from '@lesliechan721/aw-plugin-core/manifest';

async function fixture(options: { active?: boolean; script?: boolean | 'fail-pi'; targets?: string[]; sourceId?: string; name?: string }={}) {
  const isolation=getCurrentSourceTestIsolation();
  const sourceId = options.sourceId ?? 'team';
  const name = options.name ?? 'demo';
  const cwd=path.join(isolation.layout.fixtureCwd, 'public-project');
  const source=path.join(isolation.layout.fixtureCwd, `public-source-${sourceId}`);
  await fs.ensureDir(cwd); await git(cwd, ['init', '--quiet']);
  const root=path.join(source, 'plugins', name);
  for(const folder of ['skills', 'cursor/skills', 'pi/skills']) {
    await fs.outputFile(path.join(root, folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(root, folder, name, 'README.md'), 'Use demo.\n');
  }
  if(options.script) await fs.outputFile(path.join(root, 'pre-apply.mjs'), "import fs from 'node:fs'; const input = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
    + (options.script === 'fail-pi' ? "if (input.target.platform === 'pi') process.exit(7);\n" : ''));
  await createDependencyCatalogSnapshotFixture(source, [{
    name, configureManifest: (manifest) => {
      manifest.platforms=['cursor', 'pi']; manifest.skills='./skills'; delete manifest.extensions;
      if(options.script) manifest.scripts={ preApply: { path: './pre-apply.mjs' } };
    }
  }]);
  const plugin=await readPluginManifest(root, { mode: 'bundle' });
  for(const target of ['cursor', 'pi']) await fs.outputJson(path.join(root, target, 'skills', name, 'aw-plugin-requirements.json'),
    createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities??[]));
  const catalog=path.join(source, 'catalog-manifest.json');
  await fs.writeJson(catalog, { ...await fs.readJson(catalog), entries: [await createCatalogManifestV7Entry(plugin, root)] });
  const current=await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: sourceId, type: 'path', primary: true, path: source }] }, expectedDigest: current.digest, env: isolation.env });
  if(options.active!==false) await syncCatalogSourceGeneration({ sourceId, cliVersion: '1.0.0', env: isolation.env });
  const location={ cwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project' as const, context: 'project' as const };
  await setTargets(location, options.targets??['cursor']);
  return { location, source, root, output: path.join(cwd, '.cursor', 'skills', name) };
}

// Test Value Gate: protect public results and real writes at the confirmation, source, and ownership boundaries.
describe('public plugin lifecycle', () => {
  it('retains every producer result when removing Active and retired plugins together', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    await fs.ensureDir(path.join(cwd, '.git'));
    const source = path.join(cwd, 'mixed-remove-source');
    await createNativeDependencyCatalog(source, [{ name: 'active' }, { name: 'retired' }]);
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env: isolation.env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const location = { cwd, env: isolation.env, cliVersion: '1.0.0', scope: 'user', context: 'user', yes: true };
    await setTargets({ ...location, scope: 'user' }, ['codex']);
    const installed = await runPublicLifecycle('install', ['team/active', 'team/retired'], location, runtime);
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    const sourceIdentity = (await readCatalogGenerationState(isolation.env)).sources.team!.active!.sourceIdentity;
    const packages = [];
    for (const pluginName of ['active', 'retired']) {
      const sourceDirectory = path.join(cwd, `${pluginName}-commands`);
      await fs.outputFile(path.join(sourceDirectory, 'run.mjs'), 'process.exit(0);\n');
      packages.push(await syncManagedCommandPackage({ producer: { sourceId: 'team', sourceIdentity, pluginName, kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null },
        sourceDirectory, sets: [{ set: 'tools', state: 'present', entries: [normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'run.mjs' })] }], env: isolation.env }));
    }
    await createNativeDependencyCatalog(source, [{ name: 'active' }]);
    await fs.remove(path.join(source, 'plugins', 'retired'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true });
    const result = await runPublicLifecycle('remove', ['team/active', 'team/retired'], location, runtime);
    expect(result.status, JSON.stringify(result)).toMatch(/^(success|partial)$/u);
    const data = result.data as LifecycleData;
    expect(data.commandResults?.map((entry) => entry.producer.pluginName).sort(), JSON.stringify(result)).toEqual(['active', 'retired']);
    for (const value of packages) {
      expect(data.commandResults?.flatMap((entry) => entry.commandIds)).toEqual(expect.arrayContaining(value.commandIds));
      expect((await resolveManagedCommand(value.commandIds[0]!, isolation.env)).view.availability).toBe('ready');
    }
  });
  it.each([['cursor'], ['cursor', 'pi']])('reports foreign output blockers with independently observed targets %j', async (...targets) => {
    const { location, output } = await fixture({ targets });
    expect((await runPublicLifecycle('install', ['team/demo'], location)).status).toBe('success');
    const marker = path.join(output, '.agent-workflows-owner.json');
    await fs.writeJson(marker, { ...await fs.readJson(marker), owner: 'foreign' });
    const status = await runPublicPluginStatus([], location);
    expect(status.status).toBe(targets.length === 1 ? 'blocked' : 'partial');
    expect(status.data).toMatchObject({ inventory: [expect.objectContaining({ targetResults: expect.arrayContaining([
      expect.objectContaining({ target: 'cursor', content: 'conflict', blockerCodes: ['portableOutputConflict'] }),
    ]) })] });
    expect(status.diagnostics).toContainEqual(expect.objectContaining({ code: 'portableOutputConflict', subject: { pluginId: 'team/demo', target: 'cursor', scope: 'project' } }));
  });

  it.each(['fetch', 'activation'] as const)('continues a healthy source when another refresh fails during %s', async (failureStage) => {
    const first = await fixture({ sourceId: 'alpha', name: 'first' });
    const second = await fixture({ sourceId: 'beta', name: 'second' });
    const { location } = first;
    const config = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'alpha', type: 'path', primary: true, path: first.source },
      { id: 'beta', type: 'path', primary: false, path: second.source },
    ] }, expectedDigest: config.digest, env: location.env });
    const plugins = ['alpha/first', 'beta/second'];
    expect((await runPublicLifecycle('install', plugins, { ...location, only: 'requirements' })).status).toBe('success');
    for (const source of [first.source, second.source]) {
      const catalog = path.join(source, 'catalog-manifest.json');
      await fs.writeJson(catalog, { ...await fs.readJson(catalog), catalogVersion: '1.0.1' });
    }
    if (failureStage === 'fetch') await fs.remove(second.source);
    let interrupted = false;
    const result = await runPublicLifecycle('sync', plugins, { ...location, refresh: true, yes: true }, {
      debugLogger: { log: async (event) => {
        if (failureStage === 'activation' && !interrupted && event.type === 'performance:stage'
          && event.data?.name === 'recovery.plan' && event.data?.phase === 'success') {
          interrupted = true;
          await fs.remove(second.source);
        }
      } },
    });
    expect(result.status, JSON.stringify(result)).toBe('partial');
    expect(result.data).toMatchObject({ changes: { outputs: 'changed' }, targetResults: expect.arrayContaining([
      expect.objectContaining({ pluginId: 'alpha/first', execution: 'applied', observation: 'verified' }),
      expect.objectContaining({ pluginId: 'beta/second', execution: 'not-run', content: 'unknown' }),
    ]), remainingTargets: [{ pluginId: 'beta/second', target: 'cursor', scope: 'project' }] });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ subject: { sourceId: 'beta' } }));
    expect(await fs.pathExists(first.output)).toBe(true);
    expect(await fs.pathExists(second.output)).toBe(false);
    if (failureStage === 'activation') expect(interrupted).toBe(true);
  });
  it('keeps completed targets and unknown script effects when another target fails', async () => {
    const { location, output } = await fixture({ script: 'fail-pi', targets: ['cursor', 'pi'] });
    const result = await runPublicLifecycle('install', ['team/demo'], { ...location, yes: true, scriptTimeout: '1000' });
    expect(result.status, JSON.stringify(result)).toBe('partial');
    expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' },
      targetResults: [expect.objectContaining({ target: 'cursor', execution: 'applied', observation: 'verified' }),
        expect.objectContaining({ target: 'pi', execution: 'failed' })],
      remainingTargets: [{ pluginId: 'team/demo', target: 'pi', scope: 'project' }] });
    expect(await fs.pathExists(output)).toBe(true);
  });

  it('shows removal effects and observed targets before changing a requirement', async () => {
    const { location, output } = await fixture();
    expect((await runPublicLifecycle('install', ['team/demo'], location)).status).toBe('success');
    const before = await observeIntent(location);
    const result = await runPublicLifecycle('remove', ['team/demo'], location);
    expect(result.status, JSON.stringify(result)).toBe('blocked');
    expect(result.data).toMatchObject({ confirmation: { required: true, provided: false, effects: [expect.objectContaining({ code: 'removeOwnedOutput' })] },
      changes: { requirements: 'none', outputs: 'none' }, targetResults: [expect.objectContaining({ pluginId: 'team/demo', execution: 'not-run' })] });
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(output)).toBe(true);
    const removed = await runPublicLifecycle('remove', ['team/demo'], { ...location, yes: true });
    expect(removed.status, JSON.stringify(removed)).toBe('success');
    expect(await fs.pathExists(output)).toBe(false);
  });
  it('rejects malformed requests before scope normalization or writes', async () => {
    const { location }=await fixture();
    const result=await runPublicLifecycle('install', ['team/demo'], { ...location, context: 'invalid' });
    expect(result).toMatchObject({ command: 'plugin.install', status: 'failed', data: {} });
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
  });

  it('blocks empty targets before fetching a source or saving requirements', async () => {
    const { location }=await fixture({ active: false, targets: [] });
    const result=await runPublicLifecycle('install', ['team/demo'], location);
    expect(result.status).toBe('blocked'); expect(result.diagnostics[0]?.code).toBe('noTargetsEnabled');
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
    expect((await readCatalogGenerationState(location.env)).sources.team?.active).toBeUndefined();
  });

  it('does not activate a first source or save requirements before script confirmation', async () => {
    const { location, output }=await fixture({ active: false, script: true });
    const result=await runPublicLifecycle('install', ['team/demo'], location);
    expect(result.status).toBe('blocked');
    expect((result.data as LifecycleData).confirmation).toMatchObject({ required: true, provided: false, effects: [expect.objectContaining({ code: 'runPreApply' })] });
    expect(Object.values((result.data as LifecycleData).changes)).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
    expect((await readCatalogGenerationState(location.env)).sources.team?.active).toBeUndefined();
    expect(await fs.pathExists(output)).toBe(false);
    const installed=await runPublicLifecycle('install', ['team/demo'], { ...location, yes: true });
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    expect((installed.data as LifecycleData).changes).toMatchObject({ sources: 'changed', requirements: 'changed', outputs: 'changed' });
    expect(await fs.pathExists(output)).toBe(true);
  });

  it('filters one install without changing the saved target policy and reports unsatisfied status', async () => {
    const { location, output }=await fixture({ targets: ['cursor', 'pi'] });
    const result=await runPublicLifecycle('install', ['team/demo'], { ...location, target: ['cursor'] });
    expect(result.status, JSON.stringify(result)).toBe('success');
    expect((result.data as LifecycleData).targetResults.map((target) => target.target)).toEqual(['cursor']);
    expect(await fs.pathExists(output)).toBe(true);
    expect(await fs.pathExists(path.join(location.cwd, '.pi', 'skills', 'demo'))).toBe(false);
    const status=await runPublicPluginStatus([], location);
    expect(status.status, JSON.stringify(status)).toBe('success');
    expect(status.data).toMatchObject({ allSatisfied: false, targetPolicy: { targets: ['cursor', 'pi'] } });
  });

  it('keeps ordinary removal blocked offline while both only modes remain available', async () => {
    const { location, source, output }=await fixture();
    const installed=await runPublicLifecycle('install', ['team/demo'], location);
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    await fs.remove(path.join(location.env.AW_HOME!, 'catalog-state.json'));
    await fs.remove(path.join(location.env.AW_HOME!, 'catalog-store'));
    await fs.remove(source);
    const result=await runPublicLifecycle('remove', ['team/demo'], { ...location, yes: true });
    expect(result.status).toBe('blocked');
    expect((await observeIntent(location)).state).toBe('valid');
    expect(await fs.pathExists(output)).toBe(true);
    const canceled=await runPublicLifecycle('remove', ['team/demo'], { ...location, only: 'requirements' });
    expect(canceled.status).toBe('success'); expect(await fs.pathExists(output)).toBe(true);
    await setTargets(location, []);
    const cleaned=await runPublicLifecycle('remove', ['team/demo'], { ...location, only: 'outputs', target: ['cursor'], yes: true });
    expect(cleaned.status, JSON.stringify(cleaned)).toBe('success'); expect(await fs.pathExists(output)).toBe(false);
  });

  it('lists direct requirements offline and shows public metadata without private paths', async () => {
    const { location, source }=await fixture();
    const saved=await runPublicLifecycle('install', ['team/demo'], { ...location, only: 'requirements' });
    expect(saved.status).toBe('success'); expect((saved.data as LifecycleData).targetResults).toEqual([]);
    const shown=await runPublicPluginShow('team/demo', location);
    expect(shown.status).toBe('success'); expect(shown.data).toMatchObject({ pluginId: 'team/demo', version: '1.0.0' });
    expect(JSON.stringify(shown)).not.toContain(location.env.AW_HOME!);
    await fs.remove(source);
    const listed=await runPublicPluginList({ ...location, requested: true });
    expect(listed.status).toBe('success'); expect(listed.data).toMatchObject({ items: [{ pluginId: 'team/demo', direct: true }] });
  });
});
