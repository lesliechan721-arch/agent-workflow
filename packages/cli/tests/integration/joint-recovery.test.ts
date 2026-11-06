import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { writeIntent, observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';

async function fixture(collide = false, platforms: Array<'cursor' | 'pi' | 'generic' | 'antigravity'> = ['cursor'], switchHook = false) {
  const skill = (name: string) => collide && name === 'b' ? 'a' : name;
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'joint-project');
  const source = path.join(isolation.layout.fixtureCwd, 'joint-source');
  const hookTrace = path.join(cwd, 'hook-trace.jsonl');
  const hookFailure = path.join(cwd, 'fail-user-cursor');
  await fs.ensureDir(cwd); await git(cwd, ['init', '--quiet']);
  for (const name of ['a', 'b', 'd']) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'SKILL.md'),
    `---\nname: ${skill(name)}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
  for (const name of ['a', 'b', 'd']) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'README.md'), `Use ${name}.\n`);
  for (const name of ['a', 'b', 'd']) for (const platform of platforms) await fs.copy(path.join(source, 'plugins', name, 'skills'), path.join(source, 'plugins', name, platform, 'skills'));
  if (switchHook) for (const name of ['a', 'b', 'd']) await fs.outputFile(path.join(source, 'plugins', name, 'pre-apply.mjs'), [
    "import fs from 'node:fs'; const c = JSON.parse(fs.readFileSync(0, 'utf8'));",
    `fs.appendFileSync(${JSON.stringify(hookTrace)}, JSON.stringify({ plugin: c.plugin.name, platform: c.target.platform, scope: c.target.scope }) + '\\n');`,
    `if (fs.existsSync(${JSON.stringify(hookFailure)}) && c.plugin.name === 'd' && c.target.platform === 'cursor' && c.target.scope === 'user') process.exit(23);`,
  ].join('\n'));
  await createDependencyCatalogSnapshotFixture(source, ['a', 'b', 'd'].map((name) => ({ name,
    ...(name !== 'd' ? { dependencies: ['d'] } : {}), configureManifest: (manifest) => {
      manifest.platforms = platforms; manifest.skills = './skills'; delete manifest.extensions;
      if (switchHook) manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
    } })));
  const entries = [];
  for (const name of ['a', 'b', 'd']) {
    const root = path.join(source, 'plugins', name);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []);
    for (const platform of platforms) await fs.outputJson(path.join(root, platform, 'skills', skill(name), 'aw-plugin-requirements.json'), receipt);
    entries.push(await createCatalogManifestV7Entry(plugin, root));
  }
  const catalogPath = path.join(source, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries });
  const config = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const generated = await fs.readJson(path.join(source, '.aw-generated.json')) as { workspaceIdentity: string };
  const options = { cwd, env: isolation.env, cliVersion: '1.0.0', yes: true };
  const intent = (name: string) => ({ schemaVersion: 3 as const, kind: 'aw-plugin-intents' as const,
    sources: { team: { logicalIdentity: generated.workspaceIdentity } }, roots: [{ pluginId: `team/${name}` }] });
  await writeIntent({ ...options, scope: 'user' }, intent('a'));
  await writeIntent({ ...options, scope: 'project' }, intent('b'));
  await setTargets({ ...options, scope: 'user' }, ['cursor']);
  return { options, cwd, hookTrace, hookFailure, userRoot: path.join(isolation.env.HOME!, '.cursor', 'skills'), projectRoot: path.join(cwd, '.cursor', 'skills') };
}

async function expectSavedIntent(receipt: RecoveryReceipt, location: Parameters<typeof observeIntent>[0]) {
  const saved = await observeIntent(location);
  expect(saved.state).toBe('valid');
  if (saved.state !== 'valid') throw new Error('Expected the saved Intent to be readable.');
  expect(receipt.intent).toEqual({ state: 'valid', digest: saved.digest,
    roots: saved.value.roots.map((root) => root.pluginId) });
}

describe('joint recovery through real Catalog and owned Portable outputs', () => {
  // Public receipts must identify the saved scope and digest, independently of output execution.
  it.each(['user', 'project'] as const)('reports the saved %s Intent after initial install, add, no-op and remove', async (scope) => {
    const value = await fixture();
    const location = { ...value.options, scope };
    const other = { ...value.options, scope: scope === 'user' ? 'project' as const : 'user' as const };
    const otherBefore = await observeIntent(other);
    await fs.remove(await resolveIntentPath(location));
    const root = scope === 'user' ? 'team/a' : 'team/b';
    const installed = await runRecovery('install', [root], location);
    expect(installed.ok).toBe(true);
    expect(installed.declarationChanged).toBe(true);
    await expectSavedIntent(installed, location);
    const added = await runRecovery('install', ['team/d'], location);
    expect(added.ok).toBe(true);
    expect(added.declarationChanged).toBe(true);
    await expectSavedIntent(added, location);
    expect(added.intent.roots).toEqual([root, 'team/d']);
    const unchanged = await runRecovery('install', ['team/d'], location);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.declarationChanged).toBe(false);
    expect(unchanged.intent).toEqual(added.intent);
    const removed = await runRecovery('uninstall', ['team/d'], location);
    expect(removed.ok).toBe(true);
    expect(removed.declarationChanged).toBe(true);
    await expectSavedIntent(removed, location);
    expect(removed.intent.roots).toEqual([root]);
    expect(removed.intent.digest).not.toBe(added.intent.digest);
    expect(await observeIntent(other)).toEqual(otherBefore);
  }, 30000);

  // Test Value Gate: the public execution must create one shared dependency and preserve both declarations.
  it('repairs user providers before project consumers without a project dependency copy', async () => {
    const value = await fixture();
    const result = await runRecovery('sync', [], value.options);
    expect(result.errors).toEqual([]);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.declarationChanged).toBe(false);
    await expectSavedIntent(result, { ...value.options, scope: 'project' });
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await observeIntent({ ...value.options, scope: 'project' })).toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
    const status = await readRecoveryStatus(value.options);
    expect(status.coverage.scopes).toEqual(['user', 'project']);
    expect(status.allSatisfied).toBe(true);
  }, 30000);
  it.each(['changed', 'invalid'] as const)('detects a %s second Intent before any output write', async (state) => {
    const value = await fixture();
    const plan = await prepareRecovery('sync', ['team/a'], value.options);
    const location = { ...value.options, scope: 'project' as const };
    if (state === 'invalid') await fs.writeFile(await resolveIntentPath(location), '{broken');
    else await writeIntent(location, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const result = await executeRecovery(plan);
    expect(result.ok).toBe(false);
    expect(result.declarationChanged).toBe(false);
    expect(result.blockers.some((item) => item.code === 'operationReviewStale')).toBe(true);
    if (state === 'invalid') {
      expect(result.intent).toMatchObject({ state: 'invalid', roots: null, digest: expect.any(String) });
      expect(result.errors.some((item) => item.code === 'pluginIntentStateInvalid')).toBe(true);
    } else await expectSavedIntent(result, location);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
  }, 30000);
  it('preserves a rejected Intent write diagnostic and creates no outputs', async () => {
    const value = await fixture();
    const location = { ...value.options, scope: 'project' as const };
    await fs.remove(await resolveIntentPath(location));
    const userBefore = await observeIntent({ ...value.options, scope: 'user' });
    await fs.writeFile(path.join(value.cwd, '.gitignore'), '/.agent-workflows/\n');
    await expect(runRecovery('install', ['team/b'], location)).rejects.toThrow('projectConfigIgnored');
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
    expect(await observeIntent({ ...value.options, scope: 'user' })).toEqual(userBefore);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
    expect(await fs.pathExists(value.projectRoot)).toBe(false);
  }, 30000);
  it('clears reviewed target outputs while keeping both Intent documents', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await setTargets({ ...value.options, scope: 'user' }, []);
    const result = await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(result.outputsMayHaveChanged).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
    expect(await observeIntent({ ...value.options, scope: 'user' })).toMatchObject({ value: { roots: [{ pluginId: 'team/a' }] } });
  }, 30000);
  // Test Value Gate: a rejected replacement must retain the previously working
  // owned files; unrelated safe deployment and explicit clearing remain usable.
  it('preserves Pi outputs when replacement targets conflict and still permits safe work', async () => {
    const value = await fixture(false, ['cursor', 'pi', 'generic', 'antigravity']);
    await setTargets({ ...value.options, scope: 'user' }, ['pi']);
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const oldUser = path.join(value.options.env.HOME!, '.pi', 'agent', 'skills', 'a', 'SKILL.md');
    const oldProject = path.join(value.cwd, '.pi', 'skills', 'b', 'SKILL.md');
    const oldContents = await Promise.all([fs.readFile(oldUser, 'utf8'), fs.readFile(oldProject, 'utf8')]);

    await setTargets({ ...value.options, scope: 'user' }, ['cursor', 'generic']);
    const conflicted = await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.errors.some((error) => error.code === 'targetPlacementConflict')).toBe(true);
    expect(conflicted.outputsMayHaveChanged).toBe(false);
    expect(await Promise.all([fs.readFile(oldUser, 'utf8'), fs.readFile(oldProject, 'utf8')])).toEqual(oldContents);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);

    await setTargets({ ...value.options, scope: 'user' }, ['cursor', 'generic', 'antigravity']);
    const partial = await runRecovery('sync', [], { ...value.options, context: 'user', retireUnselectedTargets: true });
    expect(partial.ok).toBe(false);
    const safeOutput = path.join(value.options.env.HOME!, '.gemini', 'config', 'skills', 'a', 'SKILL.md');
    expect(await fs.pathExists(safeOutput)).toBe(true);
    expect(await fs.readFile(oldUser, 'utf8')).toBe(oldContents[0]);

    await setTargets({ ...value.options, scope: 'user' }, []);
    await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(await fs.pathExists(oldUser)).toBe(false);
    expect(await fs.pathExists(oldProject)).toBe(false);
    expect(await fs.pathExists(safeOutput)).toBe(false);
    expect(await observeIntent({ ...value.options, scope: 'user' })).toMatchObject({ value: { roots: [{ pluginId: 'team/a' }] } });
  }, 30000);
  // Test Value Gate: scope-switch hooks must run before deleting a working
  // provider, and failure must not prevent another target from switching.
  it('retains project providers when user preApply fails and switches an independent target once', async (test) => {
    const timing = createCommandTestTiming(test);
    const runtime = (commandSequence: number): RebuildCommandRuntime => ({
      debugLogger: { log: (event) => timing.commandEvent(commandSequence, event) },
    });
    const value = await timing.measure('fixture', 'provider switch', async () => {
      const value = await fixture(false, ['cursor', 'pi'], true);
      await writeIntent({ ...value.options, scope: 'user' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
      await setTargets({ ...value.options, scope: 'user' }, ['cursor', 'pi']);
      return value;
    });
    expect((await timing.measure('command', 'initial sync', (sequence) =>
      runRecovery('sync', [], value.options, runtime(sequence)))).ok).toBe(true);
    const oldProvider = path.join(value.projectRoot, 'd', 'SKILL.md');
    const oldConsumer = path.join(value.projectRoot, 'b', 'SKILL.md');
    const oldContents = await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')]);
    await fs.writeFile(value.hookTrace, '');
    const denied = await timing.measure('command', 'unauthorized install', async (sequence) => {
      const unauthorized = await prepareRecovery('install', ['team/b'], { ...value.options, scope: 'user', yes: false }, runtime(sequence));
      return executeRecovery(unauthorized, { yes: false });
    });
    expect(denied.ok).toBe(false);
    expect(denied.declarationChanged).toBe(true);
    await expectSavedIntent(denied, { ...value.options, scope: 'user' });
    expect(denied.errors.some((error) => error.code === 'preApplyAuthorizationRequired')).toBe(true);
    expect(await fs.readFile(value.hookTrace, 'utf8')).toBe('');
    expect(await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')])).toEqual(oldContents);
    await fs.writeFile(value.hookFailure, 'fail user Cursor provider');

    const result = await timing.measure('command', 'install with failing preApply', (sequence) =>
      runRecovery('install', ['team/b'], { ...value.options, scope: 'user' }, runtime(sequence)));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === 'providerSwitchPreApplyFailed')).toBe(true);
    expect(result.declarationChanged).toBe(false);
    await expectSavedIntent(result, { ...value.options, scope: 'user' });
    expect(await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')])).toEqual(oldContents);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'b'))).toBe(false);
    const userPi = path.join(value.options.env.HOME!, '.pi', 'agent', 'skills');
    expect(await fs.pathExists(path.join(userPi, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(userPi, 'b', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.cwd, '.pi', 'skills', 'b'))).toBe(false);
    const events = (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toHaveLength(3);
    expect(events).toEqual(expect.arrayContaining([
      { plugin: 'd', platform: 'cursor', scope: 'user' },
      { plugin: 'd', platform: 'pi', scope: 'user' },
      { plugin: 'b', platform: 'pi', scope: 'user' },
    ]));
  }, 30000);
  it('keeps a failed user provider at user scope and blocks its project consumer', async () => {
    const value = await fixture();
    const foreign = path.join(value.userRoot, 'd', 'SKILL.md');
    await fs.outputFile(foreign, 'Foreign content.');
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'userProviderNotSatisfied'), JSON.stringify(result, null, 2)).toBe(true);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign content.');
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
  }, 30000);
  it('moves a shared dependency to project when its last user root is removed without garbage collecting it', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const removed = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
    expect(removed.ok, JSON.stringify(removed, null, 2)).toBe(true);
    await expectSavedIntent(removed, { ...value.options, scope: 'user' });
    expect(removed.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await observeIntent({ ...value.options, scope: 'project' })).toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
    const last = await runRecovery('uninstall', ['team/b'], { ...value.options, scope: 'project' });
    expect(last.ok).toBe(true);
    await expectSavedIntent(last, { ...value.options, scope: 'project' });
    expect(last.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(last.inSync).toBe(false);
  }, 30000);
  it('does not install missing outputs during configuration apply', async () => {
    const value = await fixture();
    const result = await runRecovery('sync', ['team/a', 'team/d', 'team/b'], { ...value.options, existingOnly: true });
    expect(result.ok).toBe(false);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
    expect(await fs.pathExists(value.projectRoot)).toBe(false);
  }, 30000);

  it('blocks cross-scope Skill names from different plugins before creating outputs', async () => {
    const value = await fixture(true);
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'crossScopeSkillCollision')).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'a'))).toBe(false);
  }, 30000);

  it('continues an independent source while a missing source and its project consumer remain blocked', async () => {
    const value = await fixture();
    for (const scope of ['user', 'project'] as const) {
      const observed = await observeIntent({ ...value.options, scope });
      if (observed.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent({ ...value.options, scope }, { ...observed.value,
        sources: { ...observed.value.sources, missing: { logicalIdentity: 'catalog:missing' } },
        roots: [...observed.value.roots, { pluginId: scope === 'user' ? 'missing/provider' : 'missing/consumer' }],
      });
    }
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'sourceMissing')).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'provider'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'consumer'))).toBe(false);
    const status = await readRecoveryStatus(value.options);
    expect(status.allSatisfied).toBeNull();
    expect(status.inventory?.find((entry) => entry.pluginId === 'missing/consumer')?.targetResults[0]).toMatchObject({
      content: 'unknown', blockers: [expect.objectContaining({ code: 'sourceMissing' })],
    });
  }, 30000);

});
