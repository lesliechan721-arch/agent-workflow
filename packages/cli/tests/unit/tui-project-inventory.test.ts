import { describe, expect, it, vi } from 'vitest';

import type {
  StatusV8ClaudeTarget,
  StatusV8CodexTarget,
  StatusV8Payload,
  StatusV8Target,
} from '../../src/commands/status-v6.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import {
  buildProjectInventory,
} from '../../src/tui/project-inventory.js';
import type { PluginDependencyOverviewViewModel } from '../../src/tui/model.js';

function claudeTarget(
  pluginName: string,
  scope: 'project' | 'user',
  state: StatusV8ClaudeTarget['state'],
  options: {
    desired?: boolean;
    owned?: boolean;
    dependency?: { pluginId: string; scope: 'project' | 'user' };
    reason?: string;
  } = {},
): StatusV8ClaudeTarget {
  return {
    pluginId: `official/${pluginName}`,
    pluginName,
    sourceId: 'official',
    sourceIdentity: 'official-source',
    version: '2.0.0',
    platform: 'claude',
    scope,
    cwd: '/tmp/project',
    state,
    components: [
      { kind: 'ownership', key: 'skill', state: options.owned ? 'present' : 'absent' },
      ...(options.desired ? [{
        kind: 'intent' as const,
        key: 'desired',
        state: 'desired',
        metadata: { enabled: true, scopes: [scope], relation: 'root' },
      }] : []),
      ...(options.dependency ? [{
        kind: 'dependency' as const,
        key: options.dependency.pluginId,
        state: 'ready',
        metadata: { platform: 'claude', scope: options.dependency.scope },
      }] : []),
    ],
    reasons: options.reason ? [{ code: options.reason, message: options.reason, severity: 'blocking' }] : [],
    recoveryActions: [],
  };
}

function payload(targets: StatusV8Target[]): StatusV8Payload {
  return {
    schemaVersion: 8,
    catalog: {
      primarySourceId: 'official',
      configDigest: 'config',
      compositeDigest: 'catalog',
      sources: [{
        id: 'official', identity: 'official-source', type: 'path', primary: true,
        requestedRef: 'local',
      }],
    },
    filters: { plugins: [], platform: 'both', cwd: '/tmp/project' },
    targets,
    errors: [],
  };
}

function codexTarget(pluginName: string, scope: 'project' | 'user', options: {
  dependency?: { pluginId: string; scope: 'project' | 'user' };
  components?: StatusV8CodexTarget['components'];
  state?: StatusV8CodexTarget['state'];
} = {}): StatusV8CodexTarget {
  const state = options.state ?? 'ready';
  return {
    pluginId: `official/${pluginName}`,
    pluginName,
    sourceId: 'official',
    sourceIdentity: 'official-source',
    version: '2.0.0',
    platform: 'codex',
    cwd: '/tmp/project',
    state,
    components: options.components ?? [],
    reasons: [],
    recoveryActions: [],
    placements: [{
      scope,
      state,
      components: [
        { kind: 'ownership', key: 'native', state: 'absent' },
        { kind: 'activation', key: scope, state: 'enabled', metadata: { evidence: 'observed' } },
        ...(options.dependency ? [{ kind: 'dependency' as const,
          key: options.dependency.pluginId,
          state: 'ready',
          metadata: { platform: 'codex', scope: options.dependency.scope },
        }] : []),
      ],
      reasons: [],
      recoveryActions: [],
    }],
  };
}

function loadResult(targets: StatusV8ClaudeTarget[]): TuiStatusLoadResult {
  return {
    projectRoot: '/tmp/project',
    projectIntent: { state: 'ready', roots: [
      { pluginId: 'official/healthy', platforms: ['claude'] },
    ] },
    payload: payload(targets),
    pluginSummaries: [],
    targetRevisions: [],
  };
}

describe('project inventory', () => {
  it('keeps all declared roots, groups proven shared dependencies, and separates current project extras', () => {
    const healthy = claudeTarget('healthy', 'project', 'ready', {
      desired: true,
      owned: true,
      dependency: { pluginId: 'official/shared', scope: 'user' },
    });
    const pending = claudeTarget('pending', 'project', 'needsSync', { desired: true });
    const lost = claudeTarget('lost', 'project', 'blocked', {
      desired: true, reason: 'bundleUnavailable',
    });
    const shared = claudeTarget('shared', 'user', 'ready', { owned: true });
    const unrelatedUser = claudeTarget('unrelated', 'user', 'ready', { owned: true });
    const extra = claudeTarget('extra', 'project', 'ready', { owned: true });
    const overview: PluginDependencyOverviewViewModel = {
      pluginId: 'official/healthy',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1,
        readyCount: 1, missingCount: 0, issueCount: 0 },
      dependencies: [{
        pluginId: 'official/shared', displayName: 'Shared', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/healthy', displayName: 'Healthy' }],
        placements: [], aggregateStatus: 'ready',
      }],
      dependents: [], blockers: [],
    };
    const inventory = buildProjectInventory({
      projectRoot: '/tmp/project',
      projectIntent: { state: 'ready', roots: [
        { pluginId: 'official/healthy', platforms: ['claude'] },
        { pluginId: 'official/pending', platforms: ['claude'] },
        { pluginId: 'official/lost', platforms: ['claude'] },
      ] },
      status: payload([healthy, pending, lost, shared, unrelatedUser, extra]),
      pluginSummaries: [],
      dependencyOverviews: [overview],
      actionableTargets: [
        { pluginId: 'official/pending', platform: 'claude', scope: 'project' },
        { pluginId: 'official/shared', platform: 'claude', scope: 'project' },
      ],
    });

    expect(inventory.declaredRoots.map((root) => [root.pluginId, root.state])).toEqual([
      ['official/lost', 'blocked'],
      ['official/pending', 'pending'],
      ['official/healthy', 'ready'],
    ]);
    expect(inventory.declaredRoots.find((root) => root.pluginId === 'official/healthy')
      ?.dependencies[0]?.targets).toMatchObject([{ location: 'sharedUser', scope: 'user' }]);
    expect(inventory.extraInstalledRoots.map((root) => root.pluginId)).toEqual(['official/extra']);
    expect(inventory.syncTargets).toEqual([{
      pluginId: 'official/pending', platform: 'claude', scope: 'project',
    }]);
    expect(inventory.counts).toEqual({ blocked: 1, pending: 1, unknown: 0, ready: 1 });
  });

  it('does not reuse a Codex shared dependency proof for the same Claude plugin', () => {
    const overview: PluginDependencyOverviewViewModel = {
      pluginId: 'official/root',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1,
        readyCount: 1, missingCount: 0, issueCount: 0 },
      dependencies: [{
        pluginId: 'official/shared', displayName: 'Shared', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }],
        placements: [], aggregateStatus: 'ready',
      }],
      dependents: [], blockers: [],
    };
    const inventory = buildProjectInventory({
      projectRoot: '/tmp/project',
      projectIntent: { state: 'ready', roots: [
        { pluginId: 'official/root', platforms: ['codex', 'claude'] },
      ] },
      status: payload([
        codexTarget('root', 'project', { dependency: { pluginId: 'official/shared', scope: 'user' } }),
        claudeTarget('root', 'project', 'ready', { desired: true, owned: true }),
        codexTarget('shared', 'user'),
        claudeTarget('shared', 'user', 'ready', { owned: true }),
      ]),
      pluginSummaries: [],
      dependencyOverviews: [overview],
    });

    expect(inventory.declaredRoots[0]?.dependencies[0]?.targets).toMatchObject([
      { platform: 'codex', scope: 'user', location: 'sharedUser' },
    ]);
  });

  it.each(['sharedNative', 'activation'] as const)(
    'keeps a %s observation gap unknown even when reasons do not name it',
    (kind) => {
      const target = codexTarget('unknown', 'project', { state: 'needsSync',
        components: kind === 'sharedNative'
          ? [{ kind: 'sharedNative', key: 'unknown@aw-official', state: 'unobserved' }]
          : [],
      });
      target.placements[0]!.components = kind === 'activation'
        ? [{ kind: 'ownership', key: 'native', state: 'absent' },
          { kind: 'activation', key: 'project', state: 'unknown', metadata: { evidence: 'unobserved' } }]
        : [{ kind: 'ownership', key: 'native', state: 'absent' }];
      const inventory = buildProjectInventory({
        projectRoot: '/tmp/project',
        projectIntent: { state: 'ready', roots: [{ pluginId: 'official/unknown', platforms: ['codex'] }] },
        status: payload([target]),
        pluginSummaries: [],
      });

      expect(inventory.declaredRoots[0]?.state).toBe('unknown');
      target.placements[0]!.reasons = [{ code: 'sourceUnavailable',
        message: 'Source unavailable.', severity: 'blocking' }];
      expect(buildProjectInventory({
        projectRoot: '/tmp/project',
        projectIntent: { state: 'ready', roots: [{ pluginId: 'official/unknown', platforms: ['codex'] }] },
        status: payload([target]),
        pluginSummaries: [],
      }).declaredRoots[0]?.state).toBe('blocked');
    },
  );

  it('retains a declared root when Status has no resolved Catalog target', () => {
    const inventory = buildProjectInventory({
      projectRoot: '/tmp/project',
      projectIntent: { state: 'ready', roots: [
        { pluginId: 'missing/tool', platforms: ['claude'] },
      ] },
      status: payload([]),
      pluginSummaries: [],
    });
    expect(inventory.declaredRoots).toMatchObject([{
      pluginId: 'missing/tool', state: 'blocked',
      targets: [{ reasonCodes: ['sourceMissing'] }],
    }]);
  });

  it('refreshes Status in place and preserves the current route and draft', async () => {
    const before = loadResult([claudeTarget('healthy', 'project', 'needsSync', { desired: true })]);
    const after = loadResult([claudeTarget('healthy', 'project', 'ready', { desired: true, owned: true })]);
    const loadStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const beginCatalogSession = vi.fn();
    const captureEvidence = vi.fn();
    const executeIntent = vi.fn();
    const controller = new TuiController({
      loadStatus, beginCatalogSession, captureEvidence, executeIntent,
    });
    await controller.load();
    controller.push({ name: 'projectStatus' });
    controller.setExternalDraftState([{ kind: 'configDraft', owner: 'test', revision: 1 }]);
    const route = controller.snapshot.router;

    await expect(controller.refreshProjectInventory()).resolves.toBe(true);

    expect(controller.snapshot.projectInventory?.declaredRoots[0]?.state).toBe('ready');
    expect(controller.snapshot.projectInventoryRefresh).toMatchObject({ state: 'idle' });
    expect(controller.snapshot.router).toEqual(route);
    expect(controller.hasSessionDraft).toBe(true);
    expect(beginCatalogSession).toHaveBeenCalledTimes(1);
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('filters by observed installation scope and excludes unconfirmed targets from uninstalled', async () => {
    const project = claudeTarget('project-only', 'project', 'ready', { owned: true });
    const user = claudeTarget('user-only', 'user', 'ready', { owned: true });
    const absent = claudeTarget('absent', 'project', 'absent');
    const unknown = claudeTarget('unknown', 'project', 'needsSync', { desired: true });
    unknown.components = [{ kind: 'ownership', key: 'skill', state: 'error' }];
    const loaded = loadResult([project, user, absent, unknown]);
    loaded.pluginSummaries = [{
      pluginId: 'official/absent', pluginName: 'absent', description: 'Available in Catalog',
    }];
    const controller = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn(), executeIntent: vi.fn(),
    });
    await controller.load();
    const ids = (filter: 'project' | 'user' | 'uninstalled'): string[] =>
      controller.listPlugins({ mode: 'browse', installFilter: filter }).map((plugin) => plugin.pluginId);

    expect(ids('project')).toEqual(['official/project-only']);
    expect(ids('user')).toEqual(['official/user-only']);
    expect(ids('uninstalled')).toEqual(['official/absent']);
  });
});
