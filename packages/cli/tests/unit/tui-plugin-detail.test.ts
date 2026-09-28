import { describe, expect, it, vi } from 'vitest';

import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { buildPluginDetailSubject } from '../../src/tui/plugin-detail.js';
import { buildTuiViewModel, type PluginDependencyOverviewViewModel } from '../../src/tui/model.js';
import { buildScopedInventory, type RecoveryInventoryInput,
  type ScopedInventoryViewModel, type ScopedInventoryLoadResult } from '../../src/tui/scoped-inventory.js';

function payload(targets: StatusV8Payload['targets'] = []): StatusV8Payload {
  return {
    schemaVersion: 8,
    catalog: {
      primarySourceId: 'official', configDigest: 'config', compositeDigest: 'catalog',
      sources: [{ id: 'official', identity: 'source', type: 'path', primary: true, requestedRef: 'local' }],
    },
    filters: { plugins: [], platform: 'both', cwd: '/tmp/project' },
    targets,
    errors: [],
  };
}

function overview(pluginId: string): PluginDependencyOverviewViewModel {
  return {
    pluginId,
    summary: { directCount: 0, transitiveCount: 0, totalCount: 0,
      readyCount: 0, missingCount: 0, issueCount: 0 },
    dependencies: [], dependents: [], blockers: [],
  };
}

function subject(status: TuiStatusLoadResult, pluginId: string,
  scopedInventories?: Partial<Record<'user' | 'project', ScopedInventoryViewModel>>) {
  const model = buildTuiViewModel({
    status: status.payload, pluginSummaries: status.pluginSummaries,
    targetRevisions: status.targetRevisions,
    dependencyOverviews: status.dependencyOverviews,
    configStoreInventory: status.configStoreInventory,
  });
  return buildPluginDetailSubject({
    pluginId, status: status.payload, pluginSummaries: status.pluginSummaries,
    targetRevisions: status.targetRevisions, plugins: model.plugins,
    dependencyOverviews: status.dependencyOverviews,
    scopedInventories,
  });
}

function scopeInventory(scope: 'user' | 'project', options: {
  intentState?: string;
  agents?: string[];
  preferenceState?: string;
  roots?: NonNullable<RecoveryInventoryInput['inventory']>;
} = {}): ScopedInventoryViewModel {
  const recovery: RecoveryInventoryInput = {
    scope, intent: { state: options.intentState ?? 'valid' },
    selection: { agents: options.agents ?? [], preferences: options.preferenceState ?? 'absent' },
    inventory: options.roots ?? [], errors: [], allSatisfied: null,
  };
  return buildScopedInventory({ recovery, status: payload(), pluginSummaries: [] });
}

describe('unified plugin detail subject', () => {
  it('keeps a declared root with no local targets separate from Native placements and an unread scope', () => {
    const pluginId = 'official/demo';
    const status: TuiStatusLoadResult = { payload: payload(),
      pluginSummaries: [{ pluginId, pluginName: 'demo', displayName: 'Demo', version: '1.0.0' }] };
    const user = scopeInventory('user', { roots: [{ pluginId, source: 'official',
      sourceState: 'unavailable', blockers: [{ code: 'sourceUnavailable', message: 'offline' }],
      targetResults: [] }] });
    expect(subject(status, pluginId, { user })).toMatchObject({
      declarations: {
        user: { state: 'declared', sourceState: 'unavailable', targets: 'empty', agents: [] },
        project: { state: 'unobserved', targets: 'unobserved', agents: [] },
      }, placements: [],
    });
  });

  it('keeps same-name Portable declarations in both scopes without inventing Native placements', () => {
    const pluginId = 'official/demo';
    const status: TuiStatusLoadResult = { payload: payload(),
      pluginSummaries: [{ pluginId, pluginName: 'demo', displayName: 'Demo', version: '1.0.0' }] };
    const portableRoot = (scope: 'user' | 'project') => [{ pluginId, source: 'official',
      sourceState: 'ready', blockers: [], targetResults: [{ pluginId, agent: 'cursor', scope,
        delivery: { kind: 'agent-skills' as const, provider: 'skills-cli' as const, agentId: 'cursor' as const },
        execution: 'not-run' as const, observation: 'missing' as const, blockers: [], requiredBy: [pluginId] }] }];
    const user = scopeInventory('user', { agents: ['cursor'], preferenceState: 'valid',
      roots: portableRoot('user') });
    const project = scopeInventory('project', { agents: ['cursor'], preferenceState: 'valid',
      roots: portableRoot('project') });
    expect(subject(status, pluginId, { user, project })).toMatchObject({
      declarations: {
        user: { state: 'declared', sourceState: 'ready', targets: 'selected', agents: ['cursor'] },
        project: { state: 'declared', sourceState: 'ready', targets: 'selected', agents: ['cursor'] },
      }, placements: [],
    });
  });

  it('distinguishes observed absence from invalid declarations and preferences', () => {
    const pluginId = 'official/demo';
    const status: TuiStatusLoadResult = { payload: payload(),
      pluginSummaries: [{ pluginId, pluginName: 'demo', displayName: 'Demo', version: '1.0.0' }] };
    const user = scopeInventory('user', { intentState: 'absent' });
    const project = scopeInventory('project', { intentState: 'invalid', preferenceState: 'invalid' });
    expect(subject(status, pluginId, { user, project })?.declarations).toEqual({
      user: { state: 'not-declared', targets: 'empty', agents: [] },
      project: { state: 'unobserved', targets: 'unobserved', agents: [] },
    });
  });

  it('shows one detail subject from catalog and scoped inventory and returns to each entry', async () => {
    const pluginId = 'official/demo';
    const recovery: RecoveryInventoryInput = {
      scope: 'user', intent: { state: 'valid' },
      selection: { agents: [], preferences: 'absent' },
      inventory: [{ pluginId, source: 'official', sourceState: 'ready',
        blockers: [], targetResults: [] }], errors: [], allSatisfied: null,
    };
    const status: TuiStatusLoadResult = { payload: payload(),
      pluginSummaries: [{ pluginId, pluginName: 'demo', displayName: 'Demo', version: '1.0.0' }],
      scopedRecovery: { user: recovery },
    };
    const controller = new TuiController({ loadStatus: vi.fn(async () => status) });
    await controller.load();
    controller.push({ name: 'pluginList', mode: 'browse' });
    controller.push({ name: 'pluginDetail', pluginId });
    const fromCatalog = controller.getPluginDetailSubject(pluginId);
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    controller.push({ name: 'intentInventory', scope: 'user' });
    controller.push({ name: 'pluginDetail', pluginId });
    expect(controller.getPluginDetailSubject(pluginId)).toEqual(fromCatalog);
    expect(fromCatalog?.declarations).toMatchObject({
      user: { state: 'declared', targets: 'empty' },
      project: { state: 'unobserved', targets: 'unobserved' },
    });
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'intentInventory', scope: 'user' });
    controller.dispose();
  });

  it.each(['removed', 'unknown', 'conflict', 'updated'] as const)(
    'uses refreshed scope facts in every detail after a placement is %s', async (change) => {
      const pluginId = 'official/demo';
      const target = (scope: 'user' | 'project') => ({ pluginId, pluginName: 'demo', sourceId: 'official',
        sourceIdentity: 'source', platform: 'claude' as const, scope, cwd: '/tmp/project',
        state: 'ready' as const, components: [{ kind: 'ownership' as const, key: 'demo', state: 'present' }],
        reasons: [], recoveryActions: [] });
      const revision = (scope: 'user' | 'project', version: string) => ({ pluginId, platform: 'claude' as const,
        scope, revision: { state: 'current' as const, availableVersion: version, installedVersion: version } });
      const summaries = [{ pluginId, pluginName: 'demo', displayName: 'Initial', description: 'initial', version: '2.0.0' }];
      const loaded: TuiStatusLoadResult = { payload: payload([target('user'), target('project')]),
        pluginSummaries: summaries, targetRevisions: [revision('user', '2.0.0'), revision('project', '2.0.0')] };
      const current: ScopedInventoryLoadResult = { scope: 'user', intent: { state: 'valid' },
        selection: { agents: ['claude-code'], preferences: 'valid' }, inventory: [], extraObserved: [],
        errors: [], allSatisfied: true, nativeSnapshot: { payload: payload(change === 'removed' ? [] : [target('user')]),
          pluginSummaries: [{ ...summaries[0]!, displayName: 'Current', version: '3.0.0' }],
          targetRevisions: change === 'updated' ? [revision('user', '3.0.0')] : [], dependencyOverviews: [] } };
      if (change !== 'removed') current.extraObserved = [{ pluginId, agent: 'claude-code', scope: 'user',
        delivery: { kind: 'native', platform: 'claude' },
        observation: change === 'updated' ? 'verified' : 'unknown',
        content: change === 'updated' ? 'satisfied' : change }];
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
        loadScopedStatus: vi.fn().mockResolvedValue(current) });
      await controller.load();
      const previousProject = controller.getPluginDetailSubject(pluginId)?.placements.find((entry) => entry.scope === 'project');
      await controller.refreshScopedInventory('user');
      const detail = controller.getPluginDetailSubject(pluginId)!;
      expect(detail).toMatchObject({ displayName: 'Current', catalogVersion: '3.0.0' });
      expect(detail.placements.find((entry) => entry.scope === 'project')).toEqual(previousProject);
      const user = detail.placements.find((entry) => entry.scope === 'user');
      if (change === 'removed') expect(user).toBeUndefined();
      else if (change === 'updated') expect(user).toMatchObject({ actual: true, statusState: 'ready', installedVersion: '3.0.0' });
      else {
        expect(user).toMatchObject({ observation: 'unknown', projectState: change === 'conflict' ? 'blocked' : 'unknown' });
        expect(user?.statusState).not.toBe('ready');
        expect(user).not.toHaveProperty('installedVersion');
      }
      for (const route of [{ name: 'pluginList', mode: 'browse' }, { name: 'intentInventory', scope: 'user' },
        { name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' },
        { name: 'pluginDependencies', pluginId }] as const) {
        controller.push(route);
        controller.updatePageContext({ query: 'retain', focusIndex: 0, scrollOffset: 0 });
        const before = controller.snapshot.router.current;
        controller.push({ name: 'pluginDetail', pluginId });
        expect(controller.getPluginDetailSubject(pluginId)).toEqual(detail);
        controller.back();
        expect(controller.snapshot.router.current.context).toEqual(before.context);
      }
      controller.dispose();
    });

  it('replaces verified dependency edges only for the refreshed consumer scope', async () => {
    const pluginId = 'official/demo';
    const dependencyId = 'official/base';
    const graph = (scopes: Array<'user' | 'project'>) => {
      const value = overview(pluginId);
      value.dependencies = [{ pluginId: dependencyId, displayName: 'Base', relation: 'direct', depth: 1,
        requiredBy: [], placements: [], aggregateStatus: 'ready',
        availablePlacementReferences: scopes.map((scope) => ({
          consumer: { pluginId, platform: 'claude', scope, project: scope === 'project' ? 'current' : null },
          dependency: { pluginId: dependencyId, platform: 'claude', scope: 'user', project: null },
        })) }];
      return [value];
    };
    const loaded: TuiStatusLoadResult = { payload: payload(), pluginSummaries: [
      { pluginId, pluginName: 'demo', displayName: 'Demo', description: 'Demo' }],
      dependencyOverviews: graph(['user', 'project']) };
    const loadScopedStatus = vi.fn(async (scope: 'user' | 'project'): Promise<ScopedInventoryLoadResult> => ({
      scope, intent: { state: 'valid' }, selection: { agents: [], preferences: 'valid' },
      inventory: [], extraObserved: [], errors: [], allSatisfied: true,
      nativeSnapshot: { payload: payload(), pluginSummaries: loaded.pluginSummaries,
        targetRevisions: [], dependencyOverviews: graph([]) },
    }));
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded), loadScopedStatus });
    await controller.load();
    await controller.refreshScopedInventory('user');
    expect(controller.getPluginDetailSubject(pluginId)?.relations.outgoing).toEqual([
      { pluginId: dependencyId, displayName: 'Base', declared: true, verified: true },
    ]);
    await controller.refreshScopedInventory('project');
    expect(controller.getPluginDetailSubject(pluginId)?.relations.outgoing).toEqual([
      { pluginId: dependencyId, displayName: 'Base', declared: true, verified: false },
    ]);
    const before = controller.getPluginDetailSubject(pluginId);
    loadScopedStatus.mockRejectedValueOnce(new Error('unreadable'));
    expect(await controller.refreshScopedInventory('user')).toBe(false);
    expect(controller.getPluginDetailSubject(pluginId)).toEqual(before);
    expect(controller.snapshot.scopedInventoryRefresh.user?.state).toBe('error');
    controller.dispose();
  });

  it('keeps catalog and installed versions separate across legal scopes', () => {
    const id = 'official/demo';
    const status: TuiStatusLoadResult = {
      payload: payload([{
        pluginId: id, pluginName: 'demo', sourceId: 'official', sourceIdentity: 'source',
        version: '9.0.0', platform: 'codex', cwd: '/tmp/project', state: 'needsSync',
        components: [{ kind: 'sharedNative', key: 'demo', state: 'unobserved' }],
        reasons: [], recoveryActions: [],
        placements: [
          { scope: 'user', state: 'ready', components: [
            { kind: 'intent', key: 'desired', state: 'desired', metadata: {
              enabled: true, scopes: ['user'], relation: 'root',
            } },
            { kind: 'activation', key: 'user', state: 'enabled', metadata: { evidence: 'observed' } },
          ], reasons: [], recoveryActions: [] },
          { scope: 'project', state: 'needsSync', components: [
            { kind: 'intent', key: 'desired', state: 'desired', metadata: {
              enabled: true, scopes: ['project'], relation: 'root',
            } },
            { kind: 'ownership', key: 'project', state: 'partial' },
          ], reasons: [], recoveryActions: [] },
        ],
      }]),
      pluginSummaries: [{ pluginId: id, pluginName: 'demo', displayName: 'Demo',
        description: 'A trusted summary', version: '2.0.0' }],
      targetRevisions: [
        { pluginId: id, platform: 'codex', scope: 'user', revision: {
          state: 'unknown', availableVersion: '2.0.0', installedVersion: '1.0.0',
        } },
        { pluginId: id, platform: 'codex', scope: 'project', revision: {
          state: 'unknown', availableVersion: '2.0.0',
        } },
      ],
    };
    const result = subject(status, id);
    expect(result).toMatchObject({ pluginId: id, catalogVersion: '2.0.0',
      description: 'A trusted summary', definitionAvailable: true });
    expect(result?.placements).toHaveLength(2);
    expect(result?.placements.find((item) => item.scope === 'user')).toMatchObject({
      actual: true, declared: true, installedVersion: '1.0.0',
      observation: 'unknown',
    });
    expect(result?.placements.find((item) => item.scope === 'project')).toMatchObject({
      declared: true, observation: 'unknown',
    });
    expect(result?.placements.every((item) => item.expectedVersion === undefined)).toBe(true);
    expect(result?.placements.find((item) => item.scope === 'project')).not.toHaveProperty('installedVersion');
  });

  it('collects incoming and reference-only relation identities without treating unknown as empty', () => {
    const graph = overview('official/consumer');
    graph.dependencies.push({
      pluginId: 'official/needed', displayName: 'Needed', relation: 'direct', depth: 1,
      requiredBy: [{ pluginId: 'official/consumer', displayName: 'Consumer' }],
      placements: [], aggregateStatus: 'notInstalled',
      availablePlacementReferences: [{
        consumer: { pluginId: 'official/consumer', platform: 'codex', scope: 'user', project: null },
        dependency: { pluginId: 'other/reference', platform: 'codex', scope: 'user', project: null },
      }],
    });
    const status: TuiStatusLoadResult = {
      payload: payload(), pluginSummaries: [], dependencyOverviews: [graph],
    };
    expect(subject(status, 'official/needed')?.relations.incoming).toEqual([{
      pluginId: 'official/consumer', displayName: 'Consumer', declared: true, verified: false,
    }]);
    expect(subject(status, 'other/reference')?.relations.incoming).toEqual([{
      pluginId: 'official/consumer', displayName: 'Consumer', declared: true, verified: true,
    }]);
    expect(subject(status, 'other/reference')?.relations.checkState).toBe('unknown');
    expect(subject(status, 'other/reference')?.plugin).toBeUndefined();
    expect(subject(status, 'same/reference')).toBeUndefined();
  });

  it('retains read-only evidence when the catalog source is unavailable', () => {
    const id = 'official/demo';
    const summary: StatusV8PluginSummary = {
      pluginId: id, pluginName: 'demo', description: 'Known description', version: '2.0.0',
    };
    const unavailable = payload();
    unavailable.catalog.sources[0] = { ...unavailable.catalog.sources[0]!,
      error: 'offline', errorCode: 'catalogSourceUnavailable' };
    const result = subject({ payload: unavailable, pluginSummaries: [summary],
      dependencyOverviews: [overview(id)] }, id);
    expect(result).toMatchObject({ pluginId: id, catalogVersion: '2.0.0',
      definitionAvailable: false, relations: { checkState: 'unknown', hasKnownRelations: false } });
  });

  it('does not treat an empty overview for a removed catalog definition as a complete relation check', () => {
    const pluginId = 'official/removed';
    const currentTarget = {
      pluginId, pluginName: 'removed', sourceId: 'official', sourceIdentity: 'source',
      platform: 'claude' as const, scope: 'project' as const, cwd: '/tmp/project',
      state: 'needsSync' as const, components: [], reasons: [], recoveryActions: [],
    };
    const removed: TuiStatusLoadResult = {
      payload: payload([currentTarget]), pluginSummaries: [],
      dependencyOverviews: [overview(pluginId)],
    };
    expect(subject(removed, pluginId)).toMatchObject({
      pluginId, definitionAvailable: false,
      relations: { outgoing: [], incoming: [], checkState: 'unknown', hasKnownRelations: false },
    });

    const defined: TuiStatusLoadResult = {
      ...removed,
      pluginSummaries: [{ pluginId, pluginName: 'removed', description: '', version: '1.0.0' }],
    };
    expect(subject(defined, pluginId)?.relations).toMatchObject({
      outgoing: [], incoming: [], checkState: 'checked', hasKnownRelations: false,
    });
  });

  it('retains known incoming references when the referenced plugin definition is missing', () => {
    const pluginId = 'official/removed';
    const removed = overview(pluginId);
    removed.dependents.push({
      pluginId: 'official/consumer', displayName: 'Consumer', relation: 'dependent', depth: 1,
      requiredBy: [], placements: [], aggregateStatus: 'ready',
      placementReferences: [{
        consumer: { pluginId: 'official/consumer', platform: 'codex', scope: 'project', project: 'current' },
        dependency: { pluginId, platform: 'codex', scope: 'project', project: 'current' },
      }],
    });
    const status: TuiStatusLoadResult = {
      payload: payload(), pluginSummaries: [], dependencyOverviews: [removed],
    };
    expect(subject(status, pluginId)).toMatchObject({
      pluginId, definitionAvailable: false,
      relations: {
        outgoing: [], checkState: 'unknown', hasKnownRelations: true,
        incoming: [{ pluginId: 'official/consumer', displayName: 'Consumer',
          declared: true, verified: false }],
      },
    });
  });

  it('preserves a relation-only route on refresh and returns to the list when all evidence disappears', async () => {
    const graph = overview('official/consumer');
    graph.dependents.push({ pluginId: 'other/reference', displayName: 'Reference',
      relation: 'dependent', depth: 1, requiredBy: [], placements: [], aggregateStatus: 'notInstalled' });
    const first: TuiStatusLoadResult = { payload: payload(), pluginSummaries: [],
      dependencyOverviews: [graph] };
    const empty: TuiStatusLoadResult = { payload: payload(), pluginSummaries: [] };
    const loadStatus = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(first)
      .mockResolvedValueOnce(empty);
    const controller = new TuiController({
      loadStatus,
      captureEvidence: vi.fn(async () => { throw new Error('unused'); }),
      executeIntent: vi.fn(async () => { throw new Error('unused'); }),
    });
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'other/reference' });
    await controller.load();
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'other/reference',
    });
    expect(controller.getPluginOverview('other/reference')).toBeUndefined();
    await controller.load();
    expect(controller.getPluginDetailSubject('other/reference')).toBeUndefined();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('keeps relation-only identity out of write route normalization', async () => {
    const graph = overview('official/consumer');
    graph.dependents.push({ pluginId: 'other/reference', displayName: 'Reference',
      relation: 'dependent', depth: 1, requiredBy: [], placements: [], aggregateStatus: 'notInstalled' });
    const fixture: TuiStatusLoadResult = { payload: payload(), pluginSummaries: [],
      dependencyOverviews: [graph] };
    const controller = new TuiController({
      loadStatus: vi.fn(async () => fixture),
      captureEvidence: vi.fn(async () => { throw new Error('unused'); }),
      executeIntent: vi.fn(async () => { throw new Error('unused'); }),
    });
    await controller.load();
    controller.push({ name: 'installPlacement', pluginId: 'other/reference' });
    await controller.load();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
  });
});
