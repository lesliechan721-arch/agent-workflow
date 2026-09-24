import { describe, expect, it, vi } from 'vitest';

import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { buildPluginDetailSubject } from '../../src/tui/plugin-detail.js';
import { buildProjectInventory } from '../../src/tui/project-inventory.js';
import { buildTuiViewModel, type PluginDependencyOverviewViewModel } from '../../src/tui/model.js';

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

function subject(status: TuiStatusLoadResult, pluginId: string) {
  const model = buildTuiViewModel({
    status: status.payload, pluginSummaries: status.pluginSummaries,
    targetRevisions: status.targetRevisions,
    dependencyOverviews: status.dependencyOverviews,
    configStoreInventory: status.configStoreInventory,
  });
  const projectInventory = buildProjectInventory({
    projectRoot: status.projectRoot,
    projectIntent: status.projectIntent,
    status: status.payload,
    pluginSummaries: model.plugins,
    targetRevisions: status.targetRevisions,
    dependencyOverviews: status.dependencyOverviews,
  });
  return buildPluginDetailSubject({
    pluginId, status: status.payload, pluginSummaries: status.pluginSummaries,
    targetRevisions: status.targetRevisions, plugins: model.plugins,
    projectInventory, dependencyOverviews: status.dependencyOverviews,
  });
}

describe('unified plugin detail subject', () => {
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

  it('keeps an orphan project declaration and a saved config as read-only identities', () => {
    const declaration: TuiStatusLoadResult = {
      projectRoot: '/tmp/project',
      projectIntent: { state: 'ready', roots: [{ pluginId: 'retired/legacy', platforms: ['codex'] }] },
      payload: payload(), pluginSummaries: [],
    };
    expect(subject(declaration, 'retired/legacy')).toMatchObject({
      pluginId: 'retired/legacy', sourceId: 'retired', definitionAvailable: false,
      placements: [{ platform: 'codex', scope: 'project', declared: true,
        actual: false, projectState: 'blocked', observation: 'unknown' }],
    });
    expect(subject(declaration, 'retired/legacy')?.placements[0]).not.toHaveProperty('installedVersion');
    expect(subject(declaration, 'retired/legacy')?.plugin).toBeUndefined();

    const catalogOnlyDeclaration: TuiStatusLoadResult = {
      ...declaration,
      projectIntent: { state: 'ready', roots: [{ pluginId: 'official/legacy', platforms: ['codex'] }] },
      pluginSummaries: [{ pluginId: 'official/legacy', pluginName: 'legacy',
        description: 'Known catalog entry', version: '1.0.0' }],
    };
    expect(subject(catalogOnlyDeclaration, 'official/legacy')?.catalogVersion).toBe('1.0.0');
    expect(subject(catalogOnlyDeclaration, 'official/legacy')?.placements[0]).not.toHaveProperty('expectedVersion');

    const config: TuiStatusLoadResult = {
      payload: payload(), pluginSummaries: [],
      configStoreInventory: [{ pluginId: 'official/saved', sourceId: 'official',
        pluginName: 'saved', scope: 'user' }],
    };
    expect(subject(config, 'official/saved')).toMatchObject({
      definitionAvailable: false, savedConfigScopes: ['user'], placements: [],
    });
    expect(subject(config, 'official/saved')?.catalogVersion).toBeUndefined();
  });

  it('uses explicit project inventory evidence for shared user content', () => {
    const status: TuiStatusLoadResult = {
      projectRoot: '/tmp/project',
      projectIntent: { state: 'ready', roots: [{ pluginId: 'official/root', platforms: ['claude'] }] },
      payload: payload([
        { pluginId: 'official/root', pluginName: 'root', sourceId: 'official', sourceIdentity: 'source',
          version: '1.0.0', platform: 'claude', scope: 'project', cwd: '/tmp/project', state: 'ready',
          components: [
            { kind: 'ownership', key: 'root', state: 'present' },
            { kind: 'dependency', key: 'official/shared', state: 'ready',
              metadata: { platform: 'claude', scope: 'user' } },
          ], reasons: [], recoveryActions: [] },
        { pluginId: 'official/shared', pluginName: 'shared', sourceId: 'official', sourceIdentity: 'source',
          version: '1.0.0', platform: 'claude', scope: 'user', cwd: '/tmp/project', state: 'ready',
          components: [{ kind: 'ownership', key: 'shared', state: 'present' }],
          reasons: [], recoveryActions: [] },
        { pluginId: 'official/unrelated', pluginName: 'unrelated', sourceId: 'official',
          sourceIdentity: 'source', version: '1.0.0', platform: 'claude', scope: 'user',
          cwd: '/tmp/project', state: 'ready',
          components: [{ kind: 'ownership', key: 'unrelated', state: 'present' }],
          reasons: [], recoveryActions: [] },
      ]),
      pluginSummaries: [],
      dependencyOverviews: [{ ...overview('official/root'), dependencies: [{
        pluginId: 'official/shared', displayName: 'Shared', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }],
        placements: [], aggregateStatus: 'ready',
      }] }],
    };
    expect(subject(status, 'official/shared')?.placements[0]).toMatchObject({
      platform: 'claude', scope: 'user', actual: true, sharedWithCurrentProject: true,
    });
    expect(subject(status, 'official/unrelated')?.placements[0]).toMatchObject({
      platform: 'claude', scope: 'user', actual: true, sharedWithCurrentProject: false,
    });
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
