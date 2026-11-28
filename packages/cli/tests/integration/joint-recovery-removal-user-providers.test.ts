import path from 'node:path';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it } from 'vitest';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { writeIntent, observeIntent } from '../../src/intent/intent-store.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { snapshotRegularTree } from '../helpers/write-command-fixture.js';
import { fixture, expectSavedIntent, failManifestAfterActiveCheck } from '../helpers/joint-recovery-fixture.js';

describe('joint recovery through real Catalog and owned outputs', () => {
  beforeEach(() => { installNativeTestDiscovery(); });
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
});
