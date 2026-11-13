import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import type { PluginMeta, Scope } from '../../src/types.js';
import type { JointDemandSnapshot } from '../../src/recovery/joint-demand.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { buildScopedInventory } from '../../src/tui/scoped-inventory.js';
import { buildPluginDetailSubject } from '../../src/tui/plugin-detail.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { inspectDeployment, deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createNativeDependencyCatalog, createCodexNativeTestRuntime, replaceCatalogSourcesConfig, installFixturePlugin } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function joint(user: string[], project: string[], platform: 'pi' | 'codex'): JointDemandSnapshot {
  const isolation = getCurrentSourceTestIsolation();
  const plugins = [['root', ['middle']], ['middle', ['leaf']], ['leaf', []], ['other', ['leaf']]].map(([name, dependencies]) => ({
    pluginId: `team/${name}`, sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`,
    rootDir: path.join(isolation.layout.fixtureCwd, String(name)), manifestPath: '/unused',
    manifest: { schemaVersion: 4, name, version: '2.0.0', description: name, platforms: [platform], dependencies },
  } as PluginMeta));
  const preferences = { schemaVersion: 2 as const, kind: 'aw-deployment-preferences' as const, targets: [platform], exclusions: [] };
  const demand = (scope: Scope, names: string[]) => ({ scope,
    intent: { state: 'valid' as const, value: { schemaVersion: 3 as const, kind: 'aw-plugin-intents' as const,
      sources: { team: { logicalIdentity: 'source:team' } }, roots: names.map((name) => ({ pluginId: `team/${name}` })) },
      digest: `intent:${scope}`, rawDigest: 'raw', rawBytes: Buffer.from('{}') },
    preferences: { state: 'valid' as const, value: preferences, digest: 'prefs', rawDigest: 'raw', rawBytes: Buffer.from('{}') },
    roots: names.map((name) => ({ pluginId: `team/${name}`, sourceId: 'team', sourceState: 'ready' as const, blockers: [],
      plugin: plugins.find((plugin) => plugin.manifest.name === name)! })), plugins, errors: [] });
  return { context: { cwd: isolation.layout.fixtureCwd, context: 'project', projectRoot: isolation.layout.fixtureCwd, scopes: ['user', 'project'] },
    user: demand('user', user), project: demand('project', project), preferences };
}
const sourceView = { schemaVersion: 8 as const, catalog: { primarySourceId: 'team', configDigest: 'config', compositeDigest: 'catalog',
  sources: [{ id: 'team', identity: 'source', type: 'path' as const, primary: true, requestedRef: 'path' }] },
  filters: { plugins: [], platform: 'both' as const, cwd: '/unused' }, targets: [], errors: [] };

// Test Value Gate: use the actual joint status producer, not hand-written requiredBy/contribution mocks, to protect precise provider placement.
describe('current recovery dependency contributions', () => {
  it.each([
    { name: 'User only', user: ['root'], project: [], scope: 'user' as const, provider: 'user' as const, platform: 'pi' as const },
    { name: 'Project only', user: [], project: ['root'], scope: 'project' as const, provider: 'project' as const, platform: 'pi' as const },
    { name: 'shared User provider', user: ['other'], project: ['root'], scope: 'project' as const, provider: 'user' as const, platform: 'codex' as const },
  ])('keeps direct and transitive positions for $name', async ({ user, project, scope, provider, platform }) => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const snapshot = joint(user, project, platform);
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      nativeObservations: snapshot.user.plugins.map((plugin) => ({ pluginId: plugin.pluginId!, platform, content: 'satisfied' as const, blockers: [], installedVersion: '1.0.0' })) }, snapshot);
    const leaf = status.observedTargets!.find((target) => target.pluginId === 'team/leaf' && target.scope === provider)!;
    expect(leaf).toMatchObject({ providerScope: provider, requiredBy: expect.arrayContaining(['team/root']),
      contributions: expect.arrayContaining([{ root: 'team/root', scope, path: ['team/root', 'team/middle', 'team/leaf'] }]) });
    const root = status.inventory!.find((entry) => entry.pluginId === 'team/root')!;
    const overview = { pluginId: 'team/root', summary: { directCount: 1, transitiveCount: 1, totalCount: 2, readyCount: 2, missingCount: 0, issueCount: 0 },
      dependencies: ['middle', 'leaf'].map((name) => ({ pluginId: `team/${name}`, displayName: name,
        relation: name === 'middle' ? 'direct' as const : 'transitive' as const, depth: name === 'middle' ? 1 : 2,
        requiredBy: [], placements: [], aggregateStatus: 'ready' as const })), dependents: [], blockers: [] };
    const inventory = buildScopedInventory({ recovery: { ...status, scope, inventory: [{ ...root, targetResults: root.targetResults.filter((target) => target.scope === scope) }] },
      status: sourceView, pluginSummaries: [], dependencyOverviews: [overview] });
    const middle = inventory.declaredRoots[0]!.dependencies.find((item) => item.pluginId === 'team/middle')!;
    expect(middle.targets).toEqual([expect.objectContaining({ platform, scope,
      expectedVersion: '2.0.0', installedVersion: '1.0.0' })]);
    expect(inventory.declaredRoots[0]!.dependencies.find((item) => item.pluginId === 'team/leaf')!.targets)
      .toEqual([expect.objectContaining({ platform, scope: provider, location: provider === scope ? 'scope' : 'sharedUser' })]);
    const detail = buildPluginDetailSubject({ pluginId: 'team/leaf', status: sourceView, pluginSummaries: [], plugins: [],
      scopedInventories: { [scope]: inventory }, dependencyOverviews: [overview], currentScopes: [scope] });
    expect(detail?.placements).toEqual([expect.objectContaining({ platform, scope: provider })]);
  });

  // Test Value Gate: actual AW-owned descriptor bytes establish an installed version; unsafe or incompatible metadata must remain unknown.
  it('reads only a regular owned descriptor with the exact Native identity and strict version', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const layout = await getNativeTestLayout({ platform: 'cursor', pluginId: 'team/demo', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      sourceIdentity: `sha256:${'2'.repeat(64)}`, scope: 'user' });
    const descriptor = path.join(layout.packageRoot, '.cursor-plugin', 'plugin.json');
    await fs.outputJson(descriptor, { name: 'demo', version: '1.2.3' });
    const component = deploymentPackageComponent(layout.binding, layout);
    await writeSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot), identity: component.identity });
    const context = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    expect((await inspectDeployment(context, layout.binding)).packageVersion).toBe('1.2.3');
    for (const value of [{ name: 'another-plugin', version: '1.2.3' }, { name: 'demo', version: '01.2.3' }]) {
      await fs.writeJson(descriptor, value);
      expect((await inspectDeployment(context, layout.binding)).packageVersion).toBeUndefined();
    }
    await fs.remove(descriptor);
    const outside = path.join(isolation.layout.fixtureCwd, 'foreign-descriptor.json');
    await fs.outputJson(outside, { name: 'demo', version: '9.9.9' });
    await fs.symlink(outside, descriptor);
    expect((await inspectDeployment(context, layout.binding)).packageVersion).toBeUndefined();
  });

  // Test Value Gate: the real installed Native observer must feed actual dependency placement and must withdraw a verified edge after local output disappears.
  it('refreshes genuine installed dependency positions and removes stale verified relations', async () => {
    installNativeTestQualification({ discovery: true, trust: true });
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const source = path.join(isolation.layout.fixtureCwd, 'native-dependency-source');
    await createNativeDependencyCatalog(source, [{ name: 'root', dependencies: ['middle'] }, { name: 'middle', dependencies: ['dep'] }, { name: 'dep' }, { name: 'unrelated' }]);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] },
      expectedDigest: before.digest, env: isolation.env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], { scope: 'user', platform: 'codex', cwd: isolation.layout.fixtureCwd }, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({ cwd: isolation.layout.fixtureCwd,
      env: runtime.env, nativeCliRunner: runtime.nativeCliRunner, interactive: false })));
    try {
      await controller.load();
      expect(controller.snapshot.scopedInventories.user?.declaredRoots.find((entry) => entry.pluginId === 'team/root')?.dependencies[0]?.targets)
        .toEqual([expect.objectContaining({ platform: 'codex', scope: 'user', actual: true, installedVersion: '1.0.0' })]);
      expect(controller.getPluginDetailSubject('team/middle')?.relations.outgoing)
        .toContainEqual({ pluginId: 'team/dep', displayName: 'dep', declared: true, verified: true });
      const dep = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/dep', scope: 'user', cwd: isolation.layout.fixtureCwd, env: runtime.env });
      await fs.remove(dep.packageRoot);
      expect(await controller.refreshScopedInventory('user')).toBe(true);
      expect(controller.getPluginDetailSubject('team/middle')?.relations.outgoing)
        .toContainEqual({ pluginId: 'team/dep', displayName: 'dep', declared: true, verified: false });
      expect(controller.getPluginDetailSubject('team/dep')?.placements[0]).not.toHaveProperty('installedVersion');
      expect(controller.getPluginDetailSubject('team/unrelated')?.placements).toEqual([]);
      expect(controller.listUserIssues()).toEqual(expect.arrayContaining([expect.objectContaining({
        pluginId: 'team/dep', platform: 'codex', scope: 'user',
      })]));
      expect(controller.listUserIssues().some((issue) => issue.pluginId === 'team/unrelated')).toBe(false);
    } finally { controller.dispose(); }
  });
});
