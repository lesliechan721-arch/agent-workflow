import path from 'node:path';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { writeIntent, observeIntent } from '../../src/intent/intent-store.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { fixture } from '../helpers/joint-recovery-fixture.js';

describe('joint recovery through real Catalog and owned outputs', () => {
  beforeEach(() => { installNativeTestDiscovery(); });

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
