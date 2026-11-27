import path from 'node:path';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { writeIntent, observeIntent } from '../../src/intent/intent-store.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { snapshotRegularTree } from '../helpers/write-command-fixture.js';
import { fixture, expectSavedIntent, failManifestAfterActiveCheck } from '../helpers/joint-recovery-fixture.js';

describe('joint recovery through real Catalog and owned outputs', () => {
  beforeEach(() => { installNativeTestQualification({ discovery: true }); });
  it.each(['required', 'required at recheck', 'independent'] as const)('protects an explicitly removed User provider according to its %s Project dependency', async (relation) => {
    const required = relation !== 'independent';
    const value = await fixture(false, ['generic'], false, { a: [], b: ['x'], x: [required ? 'a' : 'd'], d: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'),
      [...(relation === 'required at recheck' ? [] : ['recovery.plan']), 'recovery.locked.demand'], ['recovery.plan']);
    const before = await observeIntent(user);
    try {
      const result = await runPublicLifecycle('remove', ['team/a'], user, fault.runtime);
      if (required) {
        expect(result).toMatchObject({ status: 'blocked', data: { changes: { requirements: 'none', outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: relation === 'required at recheck'
            ? 'operationReviewStale' : 'dependencyStillRequired' })]) });
        expect(await observeIntent(user)).toEqual(before);
      } else expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' } });
    } finally { fault.restore(); }
    await expect(fs.pathExists(path.join(value.userRoot, 'a/SKILL.md'))).resolves.toBe(required);
    await expect(fs.pathExists(path.join(value.projectRoot, 'a'))).resolves.toBe(false);
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it.each(['verified', 'absent', 'drifted', 'unowned', 'copy lost under lock', 'manifest lost under lock'] as const)('checks the Project copy (%s) before removing a User provider with an unreadable consumer', async (copy) => {
    const value = await fixture(false, ['generic'], false, { a: [], b: ['x'], x: ['a'] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    expect((await runPublicLifecycle('install', ['team/b', 'team/a'], project)).status).toBe('success');
    const projectCopy = path.join(value.projectRoot, 'a/SKILL.md');
    const userCopy = path.join(value.userRoot, 'a/SKILL.md');
    const projectFiles = await snapshotRegularTree(path.dirname(projectCopy));
    const before = await fs.readFile(projectCopy, 'utf8');
    expect(await fs.readFile(userCopy, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(value.projectRoot, 'x/SKILL.md'), 'utf8')).toContain('Use x.');
    if (copy === 'absent') await fs.remove(path.dirname(projectCopy));
    if (copy === 'drifted') await fs.appendFile(projectCopy, 'Local edit.\n');
    if (copy === 'unowned') await fs.remove(path.join(path.dirname(projectCopy), SKILL_OWNER_MARKER));
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'),
      [...(copy === 'manifest lost under lock' ? [] : ['recovery.plan']), 'recovery.locked.demand'], ['recovery.plan']);
    const projectIntent = await observeIntent(project);
    const userIntent = await observeIntent(user);
    try {
      const result = await runPublicLifecycle('remove', ['team/a'], user, { debugLogger: { log: async (event) => {
        await fault.runtime.debugLogger!.log(event);
        if (copy === 'copy lost under lock' && event.data?.name === 'recovery.locked.demand' && event.data.phase === 'start') {
          await fs.remove(path.dirname(projectCopy));
        }
      } } });
      if (copy === 'verified') {
        expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' } });
        expect(await fs.pathExists(userCopy)).toBe(false);
        expect(await snapshotRegularTree(path.dirname(projectCopy))).toEqual(projectFiles);
        await expect(observeIntent(user)).resolves.toMatchObject({ value: { roots: [] } });
      } else {
        expect(result).toMatchObject({ status: 'blocked', data: { changes: { requirements: 'none', outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: copy.endsWith('under lock')
            ? 'operationReviewStale' : 'dependencyStillRequired' })]) });
        expect(await fs.readFile(userCopy, 'utf8')).toBe(before);
        expect(await observeIntent(user)).toEqual(userIntent);
      }
      expect(await observeIntent(project)).toEqual(projectIntent);
    } finally { fault.restore(); }
  });

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
  it('moves a shared dependency to project and cleans it after the last project root is removed', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const removed = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user',
      exactTargets: [{ pluginId: 'team/a', agent: 'generic', scope: 'user' }] });
    expect(removed.ok, JSON.stringify(removed, null, 2)).toBe(true);
    await expectSavedIntent(removed, { ...value.options, scope: 'user' });
    expect(removed.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await observeIntent({ ...value.options, scope: 'project' })).toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
    const last = await runRecovery('uninstall', ['team/b'], { ...value.options, scope: 'project',
      exactTargets: [{ pluginId: 'team/b', agent: 'generic', scope: 'project' }] });
    expect(last.ok).toBe(true);
    await expectSavedIntent(last, { ...value.options, scope: 'project' });
    expect(last.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(last.inSync).toBe(true);
  }, 30000);
  // Test Value Gate: independent Native scopes cannot replace or protect each
  // other's released dependencies; keep and a same-scope declaration retain them.
  it.each([
    { scope: 'user', keep: false, directRoot: 'none' },
    { scope: 'user', keep: true, directRoot: 'none' },
    { scope: 'project', keep: false, directRoot: 'none' },
    { scope: 'project', keep: true, directRoot: 'none' },
    { scope: 'user', keep: false, directRoot: 'other' },
    { scope: 'user', keep: true, directRoot: 'other' },
    { scope: 'project', keep: false, directRoot: 'other' },
    { scope: 'project', keep: true, directRoot: 'other' },
    { scope: 'user', keep: false, directRoot: 'selected' },
    { scope: 'project', keep: false, directRoot: 'selected' },
  ] as const)('removes only the selected independent Native scope with retention=$keep ($scope, direct root=$directRoot)', async ({ scope, keep, directRoot }) => {
    const value = await fixture(false, ['opencode'], ['d']);
    await setTargets({ ...value.options, scope: 'user' }, ['opencode']);
    const otherScope = scope === 'user' ? 'project' : 'user';
    if (directRoot !== 'none') {
      const location = { ...value.options, scope: directRoot === 'other' ? otherScope : scope };
      const intent = await observeIntent(location);
      if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent(location, { ...intent.value,
        roots: [...(directRoot === 'selected' ? intent.value.roots : []), { pluginId: 'team/d' }],
      });
    }
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const root = scope === 'user' ? 'a' : 'b';
    const otherRoot = directRoot === 'other' ? 'd' : scope === 'user' ? 'b' : 'a';
    const retainDependency = keep || directRoot === 'selected';
    const packageRoot = (currentScope: 'user' | 'project', name: string) =>
      path.resolve(value.nativeSkill('opencode', currentScope, name), '../..');
    const otherIntent = await observeIntent({ ...value.options, scope: otherScope });
    const protectedRoots = [...new Set([otherRoot, 'd'])].map((name) => packageRoot(otherScope, name));
    const protectedBefore = await Promise.all(protectedRoots.map(snapshotRegularTree));
    const dependencyBefore = await snapshotRegularTree(packageRoot(scope, 'd'));
    expect(Object.keys(dependencyBefore).length).toBeGreaterThan(0);
    const foreign = path.join(path.dirname(packageRoot(scope, root)), 'foreign.txt');
    await fs.outputFile(foreign, 'Keep foreign content.');
    const plan = await prepareRecovery('uninstall', [`team/${root}`], {
      ...value.options, scope, keepDependencies: keep,
    });
    try {
      expect(plan.dependencyCleanupTargets).toEqual(retainDependency ? [] : [{ pluginId: 'team/d', agent: 'opencode', scope }]);
      expect(plan.joint?.children.flatMap((child) => child.receipt.requestedTargets)
        .map((target) => `${target.pluginId}@${target.scope}`).sort())
        .toEqual((retainDependency ? [`team/${root}@${scope}`] : [`team/${root}@${scope}`, `team/d@${scope}`]).sort());
      const removed = await executeRecovery(plan, { yes: true });
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      expect(removed.intent.roots).toEqual(directRoot === 'selected' ? ['team/d'] : []);
      expect(removed.remainingTargets).toEqual([]);
      if (!keep) expect((await readRecoveryStatus(value.options)).extraObserved).toEqual([]);
      expect(await fs.pathExists(packageRoot(scope, root))).toBe(false);
      if (retainDependency) expect(await snapshotRegularTree(packageRoot(scope, 'd'))).toEqual(dependencyBefore);
      else {
        expect(await fs.pathExists(packageRoot(scope, 'd'))).toBe(false);
        expect(removed.targetResults).toContainEqual(expect.objectContaining({
          pluginId: 'team/d', agent: 'opencode', scope, relation: 'dependency', execution: 'applied',
        }));
      }
      expect(await Promise.all(protectedRoots.map(snapshotRegularTree))).toEqual(protectedBefore);
      expect(await observeIntent({ ...value.options, scope: otherScope })).toEqual(otherIntent);
      expect(await fs.readFile(foreign, 'utf8')).toBe('Keep foreign content.');
    } finally { await plan.context.dispose(); }
  }, 30000);
  // Removing a root must preserve independent declarations and live consumers,
  // while a dependency-only update must not create an Intent root.
  it('updates a precise indirect dependency without changing either Intent', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const before = await Promise.all(['user', 'project'].map((scope) => observeIntent({ ...value.options, scope: scope as 'user' | 'project' })));
    const updated = await runRecovery('reinstall', ['team/d'], { ...value.options, scope: 'user', allowDependencySelectors: true,
      exactTargets: [{ pluginId: 'team/d', agent: 'generic' }] });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    expect(updated.targetResults.map((target) => target.pluginId)).toEqual(['team/d']);
    expect(updated.declarationChanged).toBe(false);
    expect(await Promise.all(['user', 'project'].map((scope) => observeIntent({ ...value.options, scope: scope as 'user' | 'project' })))).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('blocks indirect dependency removal and allows force without removing its consumers', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const location = { ...value.options, scope: 'user' as const };
    const before = await observeIntent(location);
    const blocked = await runRecovery('uninstall', ['team/d'], location);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(true);
    const forced = await runRecovery('uninstall', ['team/d'], { ...location, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(forced.declarationChanged).toBe(false);
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(forced.allSatisfied).toBe(false);
  }, 30000);

  it('cleans a transitive orphan closure but preserves a directly declared dependency', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    const project = { ...value.options, scope: 'project' as const };
    await writeIntent(project, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const user = { ...value.options, scope: 'user' as const };
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const planned = await prepareRecovery('uninstall', ['team/a'], user);
    try {
      expect(planned.dependencyCleanupTargets?.map((target) => target.pluginId).sort()).toEqual(['team/b', 'team/d']);
      const result = await executeRecovery(planned, { yes: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name))))).toEqual([false, false, false]);
    } finally { await planned.context.dispose(); }
    expect((await runRecovery('install', ['team/a', 'team/d'], user)).ok).toBe(true);
    expect((await runRecovery('uninstall', ['team/a'], user)).ok).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'b'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('preserves an orphan dependency needed by an installed consumer whose Intent was removed', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('keeps an installed dependency out of removal when the other scope cannot read its provider manifest', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['d'], b: ['x'], x: ['d'], d: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    // Only the user root is installed. The saved project requirement still protects its provider.
    expect((await runRecovery('install', ['team/a'], user)).ok).toBe(true);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: project.env });
    const file = path.join(active.snapshotPath, 'plugins', 'x', '.agents-plugin', 'plugin.json');
    const readJson = fs.readJson.bind(fs);
    let manifestReads = 0;
    const reads = vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
      if (String(args[0]) === file && ++manifestReads === 2) throw Object.assign(new Error('read failed'), { code: 'EIO' });
      return readJson(...args);
    });
    try {
      const plan = await prepareRecovery('uninstall', ['team/a'], user);
      try {
        expect(plan.joint?.demand.roots).toContainEqual(expect.objectContaining({ pluginId: 'team/b', scope: 'project',
          state: 'unknown', blockers: [expect.objectContaining({ code: 'pluginManifestUnavailable' })] }));
        expect(plan.joint?.demand.complete).toBe(false);
        expect(plan.dependencyCleanupTargets).toEqual([]);
        expect(plan.receipt.requestedTargets.map((target) => target.pluginId)).toEqual(['team/a']);
        const removed = await executeRecovery(plan, { yes: true, runtime: { debugLogger: { log: (event) => {
          if (event.data?.phase === 'start' && ['recovery.locked.demand', 'recovery.locked.recheck'].includes(String(event.data.name))) {
            manifestReads = 0;
          }
        } } } });
        expect(removed).toMatchObject({ declarationChanged: true,
          targetResults: [expect.objectContaining({ pluginId: 'team/a', execution: 'applied' })] });
      } finally { await plan.context.dispose(); }
    } finally { reads.mockRestore(); }
    await expect(fs.pathExists(path.join(value.userRoot, 'a'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).resolves.toBe(true);
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it('retains the transitive dependencies when deleting their consumer fails', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === path.join(value.userRoot, 'a')) throw new Error('EACCES');
      return rename(source, destination);
    });
    try {
      const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md'))))).toEqual([true, true, true]);
    } finally { failure.mockRestore(); }
  }, 30000);

  it('retains a shared leaf when a consumer on the second dependency path fails to delete', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === path.join(value.userRoot, 'c')) throw new Error('EACCES');
      return rename(source, destination);
    });
    try {
      const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
      expect(result.ok).toBe(false);
      expect(result.targetResults.find((target) => target.pluginId === 'team/d')?.blockers)
        .toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await Promise.all(['a', 'b', 'c', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
        .toEqual([false, false, true, true]);
    } finally { failure.mockRestore(); }
  }, 30000);

  it('retains dependencies when a possible current-project consumer cannot be identified', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    await fs.writeFile(path.join(value.projectRoot, 'b', SKILL_OWNER_MARKER), '{broken');
    expect((await readRecoveryStatus(value.options)).coverage.portable).toBe(false);
    const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
  }, 30000);

  it.for([false, true])('keeps exact removal pairs and protects unselected consumers (shared=%s)', async (shared, test) => {
    const timing = createCommandTestTiming(test);
    const runtime = (sequence: number): RebuildCommandRuntime => ({
      debugLogger: { log: (event) => timing.commandEvent(sequence, event) },
    });
    const graph = shared ? { a: ['d'], b: ['d'], d: [] } : { a: ['d'], b: ['e'], d: [], e: [] };
    const value = await timing.measure('fixture', 'exact removal catalog', () => fixture(false, ['generic', 'opencode'], false, graph));
    await setTargets({ ...value.options, scope: 'user' }, ['generic', 'opencode']);
    await writeIntent({ ...value.options, scope: 'user' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const project = { ...value.options, scope: 'project' as const };
    const intent = await observeIntent(project);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(project, { ...intent.value, roots: [{ pluginId: 'team/a' }, { pluginId: 'team/b' }] });
    expect((await timing.measure('command', 'initial sync', (sequence) => runRecovery('sync', [], value.options, runtime(sequence)))).ok).toBe(true);
    const plan = await timing.measure('command', 'prepare exact removal', (sequence) =>
      prepareRecovery('uninstall', ['team/a', 'team/b'], { ...project, targets: ['generic', 'opencode'],
        exactTargets: [{ pluginId: 'team/a', agent: 'generic' }, { pluginId: 'team/b', agent: 'opencode' }] }, runtime(sequence)));
    try {
      expect(plan.dependencyCleanupTargets?.map((target) => `${target.pluginId}@${target.agent}`).sort())
        .toEqual(shared ? [] : ['team/d@generic', 'team/e@opencode']);
      expect(plan.receipt.requestedTargets.map((target) => `${target.pluginId}@${target.agent}`).sort())
        .toEqual(shared ? ['team/a@generic', 'team/b@opencode'] : ['team/a@generic', 'team/b@opencode', 'team/d@generic', 'team/e@opencode']);
      const result = await timing.measure('command', 'execute exact removal', (sequence) =>
        executeRecovery(plan, { yes: true, runtime: runtime(sequence) }));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const exists = (name: string, agent: 'generic' | 'opencode') => fs.pathExists(path.join(
        agent === 'generic' ? path.join(value.projectRoot, name) : value.nativeSkill('opencode', 'project', name), 'SKILL.md'));
      expect(await Promise.all([exists('a', 'generic'), exists('a', 'opencode'), exists('b', 'generic'), exists('b', 'opencode')]))
        .toEqual([false, true, true, false]);
      expect(await Promise.all([exists('d', 'generic'), exists('d', 'opencode')])).toEqual([shared, true]);
      if (!shared) expect(await Promise.all([exists('e', 'generic'), exists('e', 'opencode')])).toEqual([true, false]);
    } finally { await plan.context.dispose(); }
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it.each([false, true])('removes a root and selected leaf while respecting intermediate retention (keep=%s)', async (keep) => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const result = await runRecovery('uninstall', ['team/a', 'team/d'], { ...value.options, scope: 'user', keepDependencies: keep });
    expect(result.ok, JSON.stringify(result)).toBe(!keep);
    if (keep) expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
      .toEqual([keep, keep, keep]);
  }, 30000);

  it('removes a project declaration while preserving the user provider used by a user consumer', async () => {
    const value = await fixture();
    const project = { ...value.options, scope: 'project' as const };
    const intent = await observeIntent(project);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(project, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const projectProvider = path.join(value.projectRoot, 'd', 'SKILL.md');
    await expect(fs.readFile(projectProvider, 'utf8')).resolves.toContain('Use d.');
    const userProvider = await fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'));
    const userIntent = await observeIntent({ ...value.options, scope: 'user' });
    const result = await runRecovery('uninstall', ['team/d'], project);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.intent.roots).toEqual([]);
    expect(result.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/d', agent: 'generic', scope: 'project', execution: 'applied', observation: 'missing', content: 'absent',
    }));
    await expect(fs.pathExists(path.dirname(projectProvider))).resolves.toBe(false);
    await expect(fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'))).resolves.toEqual(userProvider);
    expect(await observeIntent({ ...value.options, scope: 'user' })).toEqual(userIntent);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('does not replace a live user consumer dependency with a project-only provider', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    const before = await observeIntent(user);
    const result = await runRecovery('uninstall', ['team/d'], user);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(user)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('blocks an indirect provider switch that would strand an existing user consumer', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['d'], b: ['d'], d: [], x: ['d'] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    expect((await runRecovery('install', ['team/x'], user)).ok).toBe(true);
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/a' }] });
    const before = await observeIntent(user);
    for (const force of [false, true]) {
      const result = await runRecovery('uninstall', ['team/a'], { ...user, force });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await observeIntent(user)).toEqual(before);
      expect(await Promise.all(['a', 'd', 'x'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
        .toEqual([true, true, true]);
    }
  }, 30000);

  it('requires force when a live consumer dependency graph is no longer available in Active', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    await fs.remove(path.join(value.source, 'plugins', 'a'));
    await createDependencyCatalogSnapshotFixture(value.source, [
      { name: 'b', dependencies: ['d'] }, { name: 'd' },
    ].map((entry) => ({ ...entry, configureManifest: (manifest) => {
      manifest.platforms = ['generic']; manifest.skills = './skills'; delete manifest.extensions;
    } })));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: value.options.env });
    const status = await readRecoveryStatus(value.options);
    expect(status.coverage.portable).toBe(true);
    expect(status.existingTargets).toContainEqual({ pluginId: 'team/a', agent: 'generic', scope: 'user' });
    const before = await observeIntent(user);
    const blocked = await runRecovery('uninstall', ['team/d'], user);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(user)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    const forced = await runRecovery('uninstall', ['team/d'], { ...user, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
  }, 30000);
});

// A requirements-only exit leaves the installed Project consumer able to use its dependency.
it.each(['inherited skills', 'healthy project copy', 'damaged project copy', 'missing declared copy', 'removed consumer'] as const)(
  'removes a User root while accounting for %s in the current project', async (scenario) => {
    installNativeTestQualification({ discovery: true });
    const value = await fixture(false, ['opencode']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    const userDependency = path.join(value.nativeSkill('opencode', 'user', 'd'), 'SKILL.md');
    const projectDependency = path.join(value.nativeSkill('opencode', 'project', 'd'), 'SKILL.md');
    const projectConsumer = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    await setTargets(user, ['opencode']);
    const hasProjectCopy = scenario === 'healthy project copy' || scenario === 'damaged project copy';
    if (hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    if (!hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    await expect(fs.readFile(userDependency, 'utf8')).resolves.toContain('Use d.');
    expect(await fs.pathExists(projectDependency)).toBe(hasProjectCopy);
    if (scenario === 'damaged project copy') await fs.appendFile(projectDependency, '\nOut of date.\n');

    expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'requirements' })).status).toBe('success');
    if (scenario === 'missing declared copy') {
      expect((await runPublicLifecycle('install', ['team/d'], { ...project, only: 'requirements' })).status).toBe('success');
    }
    if (scenario === 'removed consumer') {
      expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'outputs', targets: ['opencode'] })).status).toBe('success');
    } else await expect(fs.readFile(projectConsumer, 'utf8')).resolves.toContain('Use b.');

    const removed = await runPublicLifecycle('remove', ['team/a'], { ...project, scope: 'user' });
    expect(removed.status, JSON.stringify(removed.diagnostics)).toBe('success');
    expect(await fs.pathExists(path.join(value.nativeSkill('opencode', 'user', 'a'), 'SKILL.md'))).toBe(false);
    expect(await fs.pathExists(projectConsumer)).toBe(scenario !== 'removed consumer');
    expect(await fs.pathExists(userDependency)).toBe(scenario !== 'healthy project copy' && scenario !== 'removed consumer');
    if (hasProjectCopy) await expect(fs.readFile(projectDependency, 'utf8')).resolves.toContain('Use d.');
  }, 30_000,
);

it.each(['owned consumer', 'foreign consumer', 'removed consumer', 'healthy project copy'] as const)(
  'protects only dependencies still needed by a delisted %s', async (scenario) => {
    installNativeTestQualification({ discovery: true });
    const value = await fixture(false, ['opencode']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    const removeFromProject = { ...project, scope: 'user' as const };
    const projectB = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    const userD = path.join(value.nativeSkill('opencode', 'user', 'd'), 'SKILL.md');
    const projectD = path.join(value.nativeSkill('opencode', 'project', 'd'), 'SKILL.md');
    const hasProjectCopy = scenario === 'healthy project copy';
    const userRoot = hasProjectCopy ? 'team/d' : 'team/a';
    await setTargets(user, ['opencode']);
    if (hasProjectCopy) {
      const intent = await observeIntent(user);
      if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent(user, { ...intent.value, roots: [{ pluginId: userRoot }] });
      expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    }
    expect((await runRecovery('sync', [userRoot], user)).ok).toBe(true);
    if (!hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    expect(await fs.pathExists(projectD)).toBe(hasProjectCopy);
    expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'requirements' })).status).toBe('success');

    const indexPath = path.join(value.source, 'catalog-manifest.json');
    const index = await fs.readJson(indexPath) as { entries: Array<{ name: string }> };
    await fs.writeJson(indexPath, { ...index, entries: index.entries.filter(({ name }) => name !== 'b') });
    await fs.remove(path.join(value.source, 'plugins', 'b'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: user.env });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: user.env });
    expect(active.manifest.entries.map(({ name }) => name)).not.toContain('b');

    const cleanProjectB = () => runPublicLifecycle('remove', ['team/b'], { ...project, only: 'outputs', targets: ['opencode'] });
    if (scenario === 'removed consumer') expect((await cleanProjectB()).status).toBe('success');
    if (scenario === 'foreign consumer') await fs.remove(path.join(path.resolve(projectB, '../../..'), SKILL_OWNER_MARKER));
    const before = await observeIntent(user);
    const removed = await runPublicLifecycle('remove', [userRoot], removeFromProject);
    if (scenario === 'owned consumer') {
      expect(removed.status).toBe('blocked');
      expect(removed.diagnostics).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await observeIntent(user)).toEqual(before);
      await expect(fs.readFile(userD, 'utf8')).resolves.toContain('Use d.');
      await expect(fs.readFile(projectB, 'utf8')).resolves.toContain('Use b.');
      expect((await cleanProjectB()).status).toBe('success');
      expect((await runPublicLifecycle('remove', [userRoot], removeFromProject)).status).toBe('success');
    } else {
      expect(removed.status, JSON.stringify(removed.diagnostics)).toBe('success');
    }
    expect(await fs.pathExists(userD)).toBe(false);
    expect(await fs.pathExists(projectB)).toBe(hasProjectCopy || scenario === 'foreign consumer');
    if (hasProjectCopy) await expect(fs.readFile(projectD, 'utf8')).resolves.toContain('Use d.');
  }, 30_000,
);
