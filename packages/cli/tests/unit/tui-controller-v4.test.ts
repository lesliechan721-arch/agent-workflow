import { describe, expect, it, vi } from 'vitest';

import type { StatusV4Payload, StatusV4PluginSummary } from '../../src/commands/status-v4.js';
import { createRebuildProgressFeed, type RebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  TuiController,
  userIssueKey,
  type OperationEvidence,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import {
  buildConfigPage,
  buildPlatformActions,
  buildPluginDetailActions,
  buildPluginPreviewActions,
  buildTuiViewModel,
  type PluginListItemViewModel,
} from '../../src/tui/model.js';
import { TuiRouter } from '../../src/tui/router.js';

function source(
  id: string,
  options: { primary?: boolean; freshness?: 'remote' | 'cache' | 'path'; error?: string; type?: 'git' | 'path' } = {},
): StatusV4Payload['catalog']['sources'][number] {
  return {
    id,
    identity: `identity:${id}`,
    type: options.type ?? 'git',
    primary: options.primary ?? id === 'official',
    requestedRef: options.type === 'path' ? 'path' : 'refs/heads/catalog/latest',
    ...(options.freshness ? { freshness: options.freshness } : {}),
    ...(options.error ? { error: options.error, errorCode: 'catalogSourceUnavailable' } : {}),
  };
}

function status(options: {
  sources?: StatusV4Payload['catalog']['sources'];
  targets?: StatusV4Payload['targets'];
  errors?: StatusV4Payload['errors'];
} = {}): StatusV4Payload {
  return {
    schemaVersion: 4,
    catalog: {
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: options.sources ?? [source('official', { freshness: 'cache' })],
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: options.targets ?? [],
    errors: options.errors ?? [],
  };
}

function target(options: {
  pluginName?: string;
  sourceId?: string;
  platform?: 'codex' | 'claude';
  scope: 'user' | 'project';
  state: 'present' | 'absent' | 'partial' | 'error';
  errorCode?: string;
}): StatusV4Payload['targets'][number] {
  const pluginName = options.pluginName ?? 'demo';
  const sourceId = options.sourceId ?? 'official';
  return {
    pluginName,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    pluginId: `${sourceId}/${pluginName}`,
    version: '1.0.0',
    platform: options.platform ?? 'codex',
    scope: options.scope,
    cwd: '/workspace',
    state: options.state,
    components: [],
    errors: options.state === 'error' ? [{ code: options.errorCode ?? 'targetError', message: 'safe failure' }] : [],
  };
}

function summaries(...entries: Array<[string, string]>): StatusV4PluginSummary[] {
  return entries.map(([sourceId, pluginName]) => ({
    pluginName,
    pluginId: `${sourceId}/${pluginName}`,
    description: `${sourceId} description`,
  }));
}

function sourceCheck(sourceId: string): { sourceIdentity: string; requestedRef: string } {
  return {
    sourceIdentity: `identity:${sourceId}`,
    requestedRef: 'refs/heads/catalog/latest',
  };
}

const baseEvidence: OperationEvidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
  source: {
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    snapshotDigest: 'sha256:snapshot',
    contentDigest: 'sha256:content',
  },
  targetFingerprint: 'sha256:target',
};

function dependencies(overrides: Partial<TuiControllerDependencies> = {}): TuiControllerDependencies {
  return {
    loadStatus: vi.fn().mockResolvedValue({
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
    }),
    checkSource: vi.fn(async (sourceId: string) => sourceCheck(sourceId)),
    captureEvidence: vi.fn().mockResolvedValue(baseEvidence),
    executeIntent: vi.fn().mockResolvedValue({ ok: true }),
    createToken: vi.fn()
      .mockReturnValueOnce('operation-1')
      .mockReturnValueOnce('review-1')
      .mockReturnValueOnce('operation-2')
      .mockReturnValueOnce('review-2'),
    now: () => 1_000,
    ...overrides,
  };
}

function menuPlugin(overrides: Partial<PluginListItemViewModel> = {}): PluginListItemViewModel {
  return {
    pluginId: 'official/demo',
    sourceId: 'official',
    displayName: 'Demo',
    description: 'Demo plugin',
    version: '2.0.0',
    configFieldCount: 0,
    sourceLabel: 'Official',
    supportedPlatforms: ['codex'],
    installedPlacements: [{ platform: 'codex', state: 'notInstalled', supportedScopes: ['user', 'project'] }],
    aggregateStatus: 'available',
    portableSkills: false,
    dependencySummary: {
      directCount: 0, transitiveCount: 0, totalCount: 0,
      readyCount: 0, missingCount: 0, issueCount: 0,
    },
    technicalComponents: [],
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('TUI v4 router and ViewModel', () => {
  it('builds capability actions only for capabilities with live content', () => {
    const empty = menuPlugin();
    expect(buildPluginPreviewActions(empty).map((action) => action.id)).toEqual(['add', 'source']);
    expect(buildPluginDetailActions(empty).map((action) => action.id)).toEqual(['platform', 'about']);

    const capable = menuPlugin({
      portableSkills: true,
      configFieldCount: 2,
      dependencySummary: {
        directCount: 1, transitiveCount: 1, totalCount: 2,
        readyCount: 2, missingCount: 0, issueCount: 0,
      },
    });
    expect(buildPluginPreviewActions(capable).map((action) => action.id)).toEqual([
      'add', 'portableSkills', 'dependencies', 'settings', 'source',
    ]);
    expect(buildPluginDetailActions(capable).map((action) => action.id)).toEqual([
      'platform', 'dependencies', 'portableSkills', 'settings', 'about',
    ]);
  });

  it('builds preview primary actions from live placement health and availability', () => {
    const incomplete = menuPlugin({
      aggregateStatus: 'needsAttention',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'incomplete',
        revision: { state: 'unknown', availableVersion: '2.0.0' },
      }],
    });
    const healthyWithMissingPlatform = menuPlugin({
      aggregateStatus: 'installed',
      supportedPlatforms: ['codex', 'claude'],
      installedPlacements: [
        {
          platform: 'codex', state: 'installed', scope: 'user', health: 'ready',
          revision: { state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0' },
        },
        { platform: 'claude', state: 'notInstalled', supportedScopes: ['user'] },
      ],
    });
    const healthyEverywhere = menuPlugin({
      aggregateStatus: 'installed',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'ready',
        revision: { state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0' },
      }],
    });

    expect(buildPluginPreviewActions(incomplete)[0]?.id).toBe('repair');
    expect(buildPluginPreviewActions(healthyWithMissingPlatform)[0]?.id).toBe('add');
    expect(buildPluginPreviewActions(healthyEverywhere)[0]?.id).toBe('manage');
  });

  it('shows upgrade only with reliable upgradeAvailable revision evidence', () => {
    const ready = (revision: Extract<PluginListItemViewModel['installedPlacements'][number], {
      state: 'installed';
    }>['revision']): PluginListItemViewModel => menuPlugin({
      aggregateStatus: 'installed',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'ready', revision,
      }],
    });

    expect(buildPlatformActions(ready({
      state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0',
    }), 'codex').map((action) => action.id)).not.toContain('upgrade');
    expect(buildPlatformActions(ready({ state: 'unknown', availableVersion: '2.0.0' }), 'codex')
      .map((action) => action.id)).not.toContain('upgrade');
    expect(buildPlatformActions(ready({
      state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0',
    }), 'codex')).toContainEqual(expect.objectContaining({ id: 'upgrade', availableVersion: '2.0.0' }));
  });

  it('limits unavailable source menus to source and safe recovery actions', () => {
    const unavailable = menuPlugin({ aggregateStatus: 'unavailable' });
    expect(buildPluginPreviewActions(unavailable).map((action) => action.id)).toEqual(['sourceProblem']);
    expect(buildPluginDetailActions(unavailable).map((action) => action.id)).toEqual([
      'sourceProblem', 'about',
    ]);
    expect(buildPlatformActions(unavailable, 'codex').map((action) => action.id)).toEqual([
      'sourceProblem', 'refreshSource',
    ]);

    const installed = menuPlugin({
      aggregateStatus: 'unavailable',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'ready',
        revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }],
    });
    expect(buildPluginPreviewActions(installed).map((action) => action.id)).toEqual([
      'sourceProblem', 'manage',
    ]);
    expect(buildPluginDetailActions(installed).map((action) => action.id)).toEqual([
      'platform', 'sourceProblem', 'about',
    ]);
    expect(buildPlatformActions(installed, 'codex').map((action) => action.id)).toEqual([
      'sourceProblem', 'refreshSource',
    ]);
  });

  it('uses add for absent and reinstall for incomplete platform placement', () => {
    expect(buildPlatformActions(menuPlugin(), 'codex')[0]?.id).toBe('add');
    expect(buildPlatformActions(menuPlugin({
      aggregateStatus: 'needsAttention',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'project', health: 'incomplete',
        revision: { state: 'unknown', availableVersion: '2.0.0' },
      }],
    }), 'codex')[0]?.id).toBe('reinstall');
  });

  it('centralizes install target compatibility and recomputes it for the selected scope', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ platform: 'codex', scope: 'user', state: 'absent' }),
          target({ platform: 'codex', scope: 'project', state: 'absent' }),
          target({ platform: 'claude', scope: 'project', state: 'absent' }),
        ] }),
        pluginSummaries: [{
          ...summaries(['official', 'demo'])[0]!,
          supportedTargets: { codex: ['user', 'project'], claude: ['project'] },
        }],
      }),
    }));
    await controller.load();

    expect(controller.listInstallTargets('official/demo', 'user')).toEqual([
      { platform: 'codex', compatible: true },
      { platform: 'claude', compatible: false, disabled: '不支持所选位置' },
    ]);
    expect(controller.listInstallTargets('official/demo', 'project')).toEqual([
      { platform: 'codex', compatible: true },
      { platform: 'claude', compatible: true },
    ]);
  });

  it('projects manifest order, presentation groups, fallback fields, presets, and private values safely', () => {
    const fields = [
      { key: 'level', title: '级别', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: 'strict', sourceLayer: 'user' as const, storedValue: 'strict', storedSourceLayer: 'user' as const },
      { key: 'rules', title: '规则', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: '/Users/private/rules.json', sourceLayer: 'local' as const, storedValue: '/Users/private/rules.json', storedSourceLayer: 'local' as const },
      { key: 'token', title: '令牌', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: 'sk-private', sourceLayer: 'user' as const, storedValue: 'sk-private', storedSourceLayer: 'user' as const },
    ];
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema: {
        schema: {
          level: { type: 'enum', title: '级别', values: ['fast', 'strict'] },
          rules: { type: 'file', title: '规则', default: '/Users/private/default-rules.json' },
          token: { type: 'string', title: '令牌', sensitive: true, default: 'default-secret' },
        },
        presentation: {
          groups: [{ id: 'basic', title: '基本设置', fields: ['level'] }],
          fields: { level: { valueLabels: { fast: '快速', strict: '严格' }, recommendedValue: 'strict', advanced: true } },
          presets: [{
            id: 'strict',
            title: '严格方案',
            values: { level: 'strict', rules: '/Users/private/preset-rules.json', token: 'preset-secret' },
          }],
        },
      },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields },
    });

    expect(page.groups.map((group) => [group.title, group.fields.map((field) => field.key)])).toEqual([
      ['基本设置', ['level']],
      ['其他设置', ['rules', 'token']],
    ]);
    expect(page.groups[0]!.fields[0]).toEqual(expect.objectContaining({
      enumValues: ['fast', 'strict'],
      valueLabels: { fast: '快速', strict: '严格' },
      recommendedValue: 'strict',
      value: 'strict',
    }));
    expect(page.presets).toEqual([{
      id: 'strict',
      title: '严格方案',
      values: { level: 'strict' },
      privateFieldTitles: ['规则', '令牌'],
    }]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('sk-private');

    const fallback = buildConfigPage({
      pluginId: 'official/demo',
      schema: { schema: { level: { type: 'enum' }, rules: { type: 'file' }, token: { type: 'string', sensitive: true } } },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields },
    });
    expect(fallback.groups).toHaveLength(1);
    expect(fallback.groups[0]!.title).toBe('插件设置');
    expect(fallback.groups[0]!.fields.map((field) => field.key)).toEqual(['level', 'rules', 'token']);

    const fieldAdvanced = buildConfigPage({
      pluginId: 'official/demo',
      schema: {
        schema: { level: { type: 'enum' }, model: { type: 'string' } },
        presentation: { fields: { model: { advanced: true } } },
      },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields: [fields[0]!, {
        key: 'model', title: '模型', kind: 'manifest', reserved: false, writable: true,
        valueState: 'configured', effectiveValue: 'review-v2', sourceLayer: 'user',
        storedValue: 'review-v2', storedSourceLayer: 'user',
      }] },
    });
    expect(fieldAdvanced.groups.map((group) => [group.id, group.title, group.advanced,
      group.fields.map((field) => field.key)])).toEqual([
      ['general', '插件设置', false, ['level']],
      ['advanced', '高级设置', true, ['model']],
    ]);

    const layeredField = {
      ...fields[0]!,
      effectiveValue: 'fast',
      sourceLayer: 'project' as const,
      storedValue: 'strict',
      storedSourceLayer: 'user' as const,
    };
    const editable = buildConfigPage({
      pluginId: 'official/demo',
      schema: { schema: { level: { type: 'enum', values: ['fast', 'strict'] } } },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields: [layeredField] },
    });
    const effective = buildConfigPage({
      pluginId: 'official/demo',
      schema: { schema: { level: { type: 'enum', values: ['fast', 'strict'] } } },
      read: { pluginName: 'demo', scope: 'effective', projectLayer: 'shared', fields: [layeredField] },
    });
    expect(editable.groups[0]!.fields[0]).toMatchObject({
      displayValue: 'strict', value: 'strict', configured: true, sourceLabel: '本层已设置',
    });
    expect(effective.groups[0]!.fields[0]).toMatchObject({
      displayValue: 'fast', value: 'fast', configured: true, sourceLabel: '当前项目',
    });
  });
  it('restores list focus, query, and source tab after a detail route goes back', () => {
    const router = new TuiRouter();
    router.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'team' },
      { focusIndex: 4, scrollOffset: 2, query: 'gate', sourceTabId: 'team' },
    );
    router.push({ name: 'pluginDetail', pluginId: 'team/review-gate' });

    expect(router.back()).toEqual({
      depth: 2,
      current: {
        route: { name: 'pluginList', mode: 'browse', sourceId: 'team' },
        context: { focusIndex: 4, scrollOffset: 2, query: 'gate', sourceTabId: 'team' },
      },
    });
  });

  it('keeps dependency detail optional and restores the originating route on back', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginPreview', pluginId: 'official/root' }, { focusIndex: 1 });
    router.push({ name: 'pluginDependencies', pluginId: 'official/root' });

    expect(router.back()).toEqual({
      depth: 2,
      current: {
        route: { name: 'pluginPreview', pluginId: 'official/root' },
        context: { focusIndex: 1 },
      },
    });
  });

  it('returns dependency overview evidence loaded by the runtime without recomputing a client closure', async () => {
    const overview = {
      pluginId: 'official/root',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 1, issueCount: 0 },
      dependencies: [{
        pluginId: 'official/toolkit', displayName: 'Toolkit', relation: 'direct' as const,
        depth: 1, requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }],
        placements: [], aggregateStatus: 'notInstalled' as const,
        placementReferences: [{ consumer: { pluginId: 'official/root', platform: 'codex' as const, scope: 'project' as const, project: 'current' as const }, dependency: { pluginId: 'official/toolkit', platform: 'codex' as const, scope: 'user' as const, project: null } }],
      }],
      dependents: [],
      blockers: [],
    };
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const controller = new TuiController(dependencies({
      captureEvidence,
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ pluginName: 'root', scope: 'project', state: 'partial' }),
          target({ pluginName: 'toolkit', scope: 'user', state: 'present' }),
        ] }),
        pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
        dependencyOverviews: [overview, {
          pluginId: 'official/toolkit',
          summary: { directCount: 0, transitiveCount: 0, totalCount: 0, readyCount: 0, missingCount: 0, issueCount: 0 },
          dependencies: [],
          dependents: [{
            pluginId: 'official/root', displayName: 'Root', relation: 'dependent' as const,
            depth: 1, requiredBy: [], placements: [], aggregateStatus: 'notInstalled' as const,
            placementReferences: [{ consumer: { pluginId: 'official/root', platform: 'codex' as const, scope: 'project' as const, project: 'current' as const }, dependency: { pluginId: 'official/toolkit', platform: 'codex' as const, scope: 'user' as const, project: null } }],
          }],
          blockers: [],
        }],
      }),
    }));
    await controller.load();

    expect(controller.getPluginDependencyOverview('official/root')).toEqual(overview);
    expect(controller.getPluginOverview('official/root')?.dependencySummary).toEqual(overview.summary);
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/root', platform: 'codex', scope: 'user',
    });
    expect(review.changes).toContainEqual(expect.objectContaining({
      group: 'preserved', pluginId: 'official/toolkit', kind: 'keep',
    }));
    await expect(controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    })).rejects.toMatchObject({ code: 'dependencyStillRequired' });
    await expect(controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
      force: true,
    })).resolves.toMatchObject({
      pluginAction: 'cleanup',
      title: '强制清理插件',
      description: expect.stringContaining('依赖者会变为不完整'),
      equivalentCommand: 'aw cleanup official/toolkit --platform codex --scope user --force',
      changes: expect.arrayContaining([
        expect.objectContaining({ kind: 'warning', title: '跳过依赖保护' }),
      ]),
    });
    expect(captureEvidence).toHaveBeenCalledTimes(2);
  });

  it('does not block dependency removal for an explicitly absent consumer target', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ pluginName: 'root', scope: 'project', state: 'absent' }),
          target({ pluginName: 'toolkit', scope: 'user', state: 'present' }),
        ] }),
        pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
        dependencyOverviews: [{
          pluginId: 'official/toolkit',
          summary: { directCount: 0, transitiveCount: 0, totalCount: 0, readyCount: 0, missingCount: 0, issueCount: 0 },
          dependencies: [],
          dependents: [{
            pluginId: 'official/root', displayName: 'Root', relation: 'dependent' as const,
            depth: 1, requiredBy: [], placements: [], aggregateStatus: 'notInstalled' as const,
            placementReferences: [{
              consumer: { pluginId: 'official/root', platform: 'codex' as const, scope: 'project' as const, project: 'current' as const },
              dependency: { pluginId: 'official/toolkit', platform: 'codex' as const, scope: 'user' as const, project: null },
            }],
          }],
          blockers: [],
        }],
      }),
    }));
    await controller.load();

    await expect(controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    })).resolves.toMatchObject({ operationKind: 'pluginWrite', pluginAction: 'uninstall' });
  });

  it('keeps same-name plugins separate and sorts the tie by source identity', () => {
    const view = buildTuiViewModel({
      status: status({
        sources: [
          source('official', { freshness: 'cache' }),
          source('team', { freshness: 'cache', primary: false }),
        ],
        targets: [
          target({ sourceId: 'team', pluginName: 'review-gate', scope: 'user', state: 'absent' }),
          target({ sourceId: 'official', pluginName: 'review-gate', scope: 'user', state: 'present' }),
        ],
      }),
      pluginSummaries: summaries(['team', 'review-gate'], ['official', 'review-gate']),
    });

    expect(view.plugins.map((plugin) => [plugin.pluginId, plugin.aggregateStatus])).toEqual([
      ['official/review-gate', 'installed'],
      ['team/review-gate', 'available'],
    ]);
  });

  it('projects typed dependency issue actions to the canonical dependency target', () => {
    const missing = target({ pluginName: 'root', scope: 'project', state: 'partial' });
    missing.errors = [{
      code: 'dependencyMissing',
      message: 'dependencyMissing: official/toolkit is absent at its recorded target.',
    }];
    const view = buildTuiViewModel({
      status: status({ targets: [missing] }),
      pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
      dependencyOverviews: [{
        pluginId: 'official/root',
        summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 1, issueCount: 1 },
        dependencies: [{
          pluginId: 'official/toolkit', displayName: 'Toolkit', relation: 'direct', depth: 1,
          requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }], placements: [],
          aggregateStatus: 'notInstalled', placementReferences: [{
            consumer: { pluginId: 'official/root', platform: 'codex', scope: 'project', project: 'current' },
            dependency: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user', project: null },
          }],
        }],
        dependents: [], blockers: [],
      }],
    });

    expect(view.issues).toContainEqual(expect.objectContaining({
      category: 'dependencyMissing',
      pluginId: 'official/root',
      dependencyPluginId: 'official/toolkit',
      platform: 'codex',
      scope: 'project',
      actions: expect.arrayContaining([expect.objectContaining({
        id: 'installDependency',
        pluginId: 'official/toolkit',
        writeAction: 'install',
        platform: 'codex',
        scope: 'user',
      })]),
    }));
  });

  it('projects one installed scope as normal placement and two scopes as a conflict issue', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ scope: 'user', state: 'present' }),
          target({ scope: 'project', state: 'partial' }),
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.plugins[0]?.installedPlacements).toEqual([{
      platform: 'codex',
      state: 'scopeConflict',
      placements: [
        { scope: 'project', health: 'incomplete', revision: { state: 'unknown', availableVersion: '1.0.0' } },
        { scope: 'user', health: 'ready', revision: { state: 'unknown', availableVersion: '1.0.0' } },
      ],
    }]);
    expect(view.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: 'scope:official/demo:codex',
        pluginId: 'official/demo',
        sourceId: 'official',
        placements: ['project', 'user'],
        actions: expect.arrayContaining([
          expect.objectContaining({ id: 'keepUserScope' }),
          expect.objectContaining({ id: 'keepProjectScope' }),
        ]),
      }),
    ]));
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not treat %s + %s as installed scope conflict evidence', (userState, projectState) => {
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ scope: 'user', state: userState }),
          target({ scope: 'project', state: projectState }),
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.plugins[0]?.installedPlacements).toEqual([{
      platform: 'codex',
      state: 'installed',
      scope: userState === 'present' ? 'user' : 'project',
      health: 'ready',
      revision: { state: 'unknown', availableVersion: '1.0.0' },
    }]);
    expect(view.issues.some((issue) => issue.category === 'scopeConflict')).toBe(false);
    expect(view.issues.some((issue) => issue.category === 'diagnostic')).toBe(true);
  });

  it('projects top-level inventory errors once with safe stable details', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [target({ scope: 'user', state: 'error' })],
        errors: [
          { code: 'legacyStateUnsupported', message: 'legacy at /Users/private/state' },
          { code: 'nativeStateUnreadable', message: 'token=private-token' },
          { code: 'nativeStateUnreadable', message: 'duplicate raw error' },
          { code: 'targetError', message: 'already represented by the target' },
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.issues.map((issue) => issue.issueId)).toEqual([
      'target:official/demo:codex:user:error',
      'status:legacyStateUnsupported',
      'status:nativeStateUnreadable',
    ]);
    expect(JSON.stringify(view.issues)).not.toContain('/Users/private');
    expect(JSON.stringify(view.issues)).not.toContain('private-token');
  });

  it('classifies issue routes from typed status and config evidence without message matching', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ pluginName: 'partial', scope: 'user', state: 'partial' }),
          target({ pluginName: 'missing', scope: 'user', state: 'error', errorCode: 'sourceMissing' }),
          target({ pluginName: 'changed', scope: 'user', state: 'error', errorCode: 'sourceChanged' }),
          target({ pluginName: 'offline', scope: 'user', state: 'error', errorCode: 'catalogSourceUnavailable' }),
          target({ pluginName: 'offline-two', scope: 'project', state: 'error', errorCode: 'catalogSourceUnavailable' }),
        ],
        errors: [{ code: 'legacyStateUnsupported', message: 'arbitrary text that does not name legacy state' }],
      }),
      pluginSummaries: [{
        pluginName: 'required',
        pluginId: 'official/required',
        description: 'required config fixture',
        configIssues: [{ type: 'missing-required', key: 'rules', title: '规则文件', source: 'missing' }],
      }],
      sourceHealth: new Map([['official', {
        sourceId: 'official',
        state: 'degraded',
        issueId: 'source:official:cache',
      }]]),
    });

    expect(Object.fromEntries(view.issues.map((issue) => [issue.issueId, issue.category]))).toMatchObject({
      'target:official/partial:codex:user:partial': 'incompleteInstallation',
      'target:official/missing:codex:user:error': 'sourceMissing',
      'target:official/changed:codex:user:error': 'sourceIdentityChanged',
      'config:official/required:required': 'requiredConfigMissing',
      'status:legacyStateUnsupported': 'legacyState',
      'source:official:cache': 'sourceDegraded',
    });
    expect(JSON.stringify(view.issues)).not.toContain('arbitrary text');
    expect(view.issues.find((issue) => issue.category === 'sourceDegraded')?.actions.map((action) => action.id))
      .toContain('continueWithCache');
    expect(view.issues.filter((issue) => issue.sourceId === 'official'
      && (issue.category === 'sourceUnavailable' || issue.category === 'sourceDegraded'))).toHaveLength(1);
    expect(view.issues.find((issue) => issue.category === 'sourceDegraded')?.impact).toContain(
      '2 个安装位置受此来源根问题影响。',
    );
    expect(view.issues.find((issue) => issue.category === 'sourceMissing')?.actions.map((action) => action.id))
      .toEqual(['reAddSource', 'viewTechnical']);
    expect(view.issues.find((issue) => issue.category === 'sourceIdentityChanged')?.actions.map((action) => action.id))
      .toEqual(['viewSourceChange', 'viewTechnical']);
  });

  it('keeps bundleUnavailable as a plugin target issue beside a degraded source root', () => {
    const unavailableTarget = target({
      pluginName: 'offline', scope: 'user', state: 'error', errorCode: 'catalogSourceUnavailable',
    });
    unavailableTarget.errors.push({ code: 'bundleUnavailable', message: 'bundle missing' });
    const view = buildTuiViewModel({
      status: status({ targets: [unavailableTarget] }),
      pluginSummaries: summaries(['official', 'offline']),
      sourceHealth: new Map([['official', {
        sourceId: 'official', state: 'degraded', issueId: 'source:official:cache',
      }]]),
    });

    expect(view.issues).toHaveLength(2);
    expect(view.home.issueCount).toBe(2);
    expect(view.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: 'source:official:cache', category: 'sourceDegraded',
        impact: expect.arrayContaining(['1 个安装位置受此来源根问题影响。']),
      }),
      expect.objectContaining({
        issueId: expect.stringContaining('bundleUnavailable'),
        pluginId: 'official/offline', category: 'sourceUnavailable',
        rootCode: 'bundleUnavailable', mergeEligible: false,
        explanation: '当前来源中无法取得这个插件的可信 bundle。',
      }),
    ]));
    expect(view.issues.find((issue) => issue.rootCode === 'bundleUnavailable')?.impact)
      .toContain('当前目标不能使用这个插件包；这不表示来源缓存整体不可用。');
  });

  it('keeps config issue type and layer while isolating a safe per-plugin read diagnostic', () => {
    const view = buildTuiViewModel({
      status: status(),
      pluginSummaries: [
        {
          pluginName: 'invalid', pluginId: 'official/invalid', description: 'invalid',
          configIssues: [{ type: 'invalid-config', key: 'mode', title: '模式', source: 'projectLocal' }],
        },
        {
          pluginName: 'unreadable', pluginId: 'official/unreadable', description: 'unreadable',
          configDiagnostic: { code: 'configReadFailed', message: '插件设置当前不可读。未读取或显示设置值。' },
        },
      ],
    });

    expect(view.issues.find((issue) => issue.pluginId === 'official/invalid')).toMatchObject({
      title: 'invalid · 设置值无效',
      configLayer: { scope: 'project', projectLayer: 'local' },
      requiredFields: [{ key: 'mode', title: '模式', type: 'invalid-config', source: 'projectLocal' }],
    });
    expect(view.issues.find((issue) => issue.pluginId === 'official/unreadable')).toMatchObject({
      category: 'diagnostic',
      technicalDetails: [{ code: 'configReadFailed', message: '插件设置当前不可读。未读取或显示设置值。' }],
    });
  });
});

describe('TUI v4 background source checks', () => {
  it('combines source, installation, and query filters without treating error placement as uninstalled', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({
          sources: [source('official'), source('team', { primary: false })],
          targets: [
            target({ pluginName: 'matching-tool', sourceId: 'official', scope: 'user', state: 'absent' }),
            target({ pluginName: 'installed-matching-tool', sourceId: 'official', scope: 'user', state: 'present' }),
            target({ pluginName: 'error-matching-tool', sourceId: 'official', scope: 'user', state: 'error' }),
            target({ pluginName: 'matching-tool', sourceId: 'team', scope: 'user', state: 'absent' }),
          ],
        }),
        pluginSummaries: summaries(
          ['official', 'matching-tool'],
          ['official', 'installed-matching-tool'],
          ['official', 'error-matching-tool'],
          ['team', 'matching-tool'],
        ),
      }),
    }));
    await controller.load();

    expect(controller.listPlugins({
      mode: 'browse',
      sourceId: 'official',
      installFilter: 'uninstalled',
      query: 'matching-tool',
    }).map((plugin) => plugin.pluginId)).toEqual(['official/matching-tool']);
    expect(controller.listPlugins({
      mode: 'browse',
      installFilter: 'uninstalled',
    }).map((plugin) => plugin.pluginId)).toEqual(['official/matching-tool', 'team/matching-tool']);
  });

  it('publishes a safe terminal state when the initial status load fails', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockRejectedValue(new Error('nativeStateUnreadable: /private/path')),
    }));

    await expect(controller.load()).resolves.toBeUndefined();

    expect(controller.snapshot).toMatchObject({
      phase: 'error',
      loadError: { code: 'nativeStateUnreadable' },
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain('/private/path');
  });

  it('returns the cache-first page before a successful remote check refreshes its data', async () => {
    const remote = deferred<void>();
    const initial = { payload: status(), pluginSummaries: summaries(['official', 'demo']) };
    const refreshed = {
      payload: status({
        sources: [source('official', { freshness: 'remote' })],
        targets: [target({ scope: 'user', state: 'absent' })],
      }),
      pluginSummaries: summaries(['official', 'demo'], ['official', 'new-plugin']),
    };
    const deps = dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(refreshed),
      checkSource: vi.fn(async (sourceId: string) => {
        await remote.promise;
        return sourceCheck(sourceId);
      }),
    });
    const controller = new TuiController(deps);

    await controller.load();
    expect(controller.snapshot.phase).toBe('ready');
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'checking' });
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual(['official/demo']);

    remote.resolve();
    await nextTurn();
    await nextTurn();
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual([
      'official/demo', 'official/new-plugin',
    ]);
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
  });

  it('accepts checked evidence that matches a concurrently replaced authoritative source', async () => {
    const remote = deferred<void>();
    const initialSource = {
      ...source('official', { freshness: 'cache' }),
      identity: 'identity:official-old',
      requestedRef: 'refs/heads/catalog/old',
    };
    const replacedSource = {
      ...source('official', { freshness: 'remote' }),
      identity: 'identity:official-new',
      requestedRef: 'refs/heads/catalog/new',
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status({ sources: [initialSource] }), pluginSummaries: [] })
        .mockResolvedValueOnce({ payload: status({ sources: [replacedSource] }), pluginSummaries: [] }),
      checkSource: vi.fn(async () => {
        await remote.promise;
        return {
          sourceIdentity: replacedSource.identity,
          requestedRef: replacedSource.requestedRef,
        };
      }),
    }));

    await controller.load();
    remote.resolve();
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
    expect(controller.listUserIssues()).toEqual([]);
  });

  it('rejects old checked evidence after the authoritative source identity and ref change', async () => {
    const remote = deferred<void>();
    const betaPath = source('beta', { type: 'path', freshness: 'path', primary: false });
    const initialSource = {
      ...source('official', { freshness: 'cache' }),
      identity: 'identity:official-old',
      requestedRef: 'refs/heads/catalog/old',
    };
    const replacedSource = {
      ...source('official', { freshness: 'remote' }),
      identity: 'identity:official-new',
      requestedRef: 'refs/heads/catalog/new',
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status({ sources: [initialSource, betaPath] }), pluginSummaries: [] })
        .mockResolvedValueOnce({ payload: status({ sources: [replacedSource, betaPath] }), pluginSummaries: [] })
        .mockResolvedValueOnce({
          payload: status({ sources: [
            { ...initialSource, freshness: 'cache' },
            source('beta', { freshness: 'cache', primary: false }),
          ] }),
          pluginSummaries: [],
        }),
      checkSource: vi.fn(async (sourceId: string) => {
        if (sourceId === 'beta') return sourceCheck(sourceId);
        await remote.promise;
        return {
          sourceIdentity: initialSource.identity,
          requestedRef: initialSource.requestedRef,
        };
      }),
    }));

    await controller.load();
    remote.resolve();
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toContainEqual(expect.objectContaining({
      sourceId: 'official',
      state: 'unavailable',
    }));
    expect(controller.listUserIssues()).toContainEqual(expect.objectContaining({
      issueId: 'source:official:unavailable',
    }));

    await controller.refreshSource('beta');

    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'cache' });
  });

  it('keeps cached plugins and creates a degraded issue after remote failure', async () => {
    const controller = new TuiController(dependencies({
      checkSource: vi.fn().mockRejectedValue(new Error('remote unavailable')),
    }));
    await controller.load();
    await nextTurn();

    expect(controller.listPlugins({ mode: 'browse' })).toHaveLength(1);
    expect(controller.snapshot.sourceHealth).toEqual([expect.objectContaining({
      sourceId: 'official',
      state: 'degraded',
    })]);
    expect(controller.listUserIssues()).toEqual([expect.objectContaining({
      issueId: 'source:official:cache',
    })]);
  });

  it('marks a source unavailable when cache-first load had no usable data', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources: [source('official', { error: 'no cache' })] }),
        pluginSummaries: [],
      }),
      checkSource: vi.fn().mockRejectedValue(new Error('remote unavailable')),
    }));
    await controller.load();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toEqual([expect.objectContaining({
      sourceId: 'official',
      state: 'unavailable',
    })]);
    expect(controller.listUserIssues()[0]?.issueId).toBe('source:official:unavailable');
  });

  it('does not treat a previously usable path source as cache after refresh fails', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({
          payload: status({ sources: [source('local', { type: 'path', freshness: 'path', primary: true })] }),
          pluginSummaries: summaries(['local', 'demo']),
        })
        .mockRejectedValueOnce(new Error('/private/local source disappeared')),
      checkSource: vi.fn().mockRejectedValue(new Error('/private/local source disappeared')),
    }));
    await controller.load();
    await controller.refreshSource('local');

    expect(controller.snapshot.sourceHealth).toContainEqual(expect.objectContaining({
      sourceId: 'local', state: 'unavailable',
    }));
    expect(controller.listUserIssues().find((issue) => issue.sourceId === 'local')?.actions)
      .not.toContainEqual(expect.objectContaining({ id: 'continueWithCache' }));
    expect(JSON.stringify(controller.snapshot)).not.toContain('/private/local');
  });

  it('does not carry old cache evidence into a replaced source with no authoritative data', async () => {
    const initialSource = {
      ...source('official', { freshness: 'cache' }),
      identity: 'identity:official-old',
      requestedRef: 'refs/heads/catalog/old',
    };
    const replacedSource = {
      ...source('official', { error: 'new source unavailable' }),
      identity: 'identity:official-new',
      requestedRef: 'refs/heads/catalog/new',
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status({ sources: [initialSource] }), pluginSummaries: [] })
        .mockResolvedValueOnce({ payload: status({ sources: [replacedSource] }), pluginSummaries: [] }),
      checkSource: vi.fn().mockRejectedValue(new Error('remote check failed')),
    }));

    await controller.load();
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toEqual([{
      sourceId: 'official',
      state: 'unavailable',
      issueId: 'source:official:unavailable',
      message: '远端检查失败，并且没有可用缓存数据。',
    }]);
    expect(controller.listUserIssues()[0]).toMatchObject({
      issueId: 'source:official:unavailable',
      actions: expect.not.arrayContaining([expect.objectContaining({ id: 'continueWithCache' })]),
    });
  });

  it('keeps a matching authoritative cache after the remote check fails', async () => {
    const cachedSource = source('official', { freshness: 'cache' });
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources: [cachedSource] }),
        pluginSummaries: summaries(['official', 'demo']),
      }),
      checkSource: vi.fn().mockRejectedValue(new Error('remote check failed')),
    }));

    await controller.load();
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toContainEqual({
      sourceId: 'official',
      state: 'degraded',
      issueId: 'source:official:cache',
      message: '远端检查失败。当前仍使用已验证的缓存数据。',
    });
    expect(controller.listUserIssues()[0]?.actions).toContainEqual(
      expect.objectContaining({ id: 'continueWithCache' }),
    );
  });

  it('does not carry a successful source marker across a requested ref replacement', async () => {
    const initialSources = [
      source('alpha', { type: 'path', freshness: 'path', primary: true }),
      source('beta', { type: 'path', freshness: 'path', primary: false }),
    ];
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status({ sources: initialSources }), pluginSummaries: [] })
        .mockRejectedValueOnce(new Error('alpha reload failed'))
        .mockResolvedValueOnce({
          payload: status({ sources: [
            { ...source('alpha', { type: 'git', freshness: 'cache', primary: true }), identity: 'identity:alpha-replaced' },
            source('beta', { type: 'git', freshness: 'cache', primary: false }),
          ] }),
          pluginSummaries: [],
        }),
      checkSource: vi.fn(async (sourceId: string) => sourceCheck(sourceId)),
    }));
    await controller.load();
    await controller.refreshSource('alpha');
    await controller.refreshSource('beta');

    expect(controller.snapshot.sourceHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'alpha', state: 'cache' }),
      expect.objectContaining({ sourceId: 'beta', state: 'ready' }),
    ]));
  });

  it('aborts the active source check on dispose and does not publish a late result', async () => {
    let observedSignal: AbortSignal | undefined;
    const checkSource = vi.fn((_sourceId: string, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const controller = new TuiController(dependencies({ checkSource }));
    await controller.load();
    const listener = vi.fn();
    controller.subscribe(listener);
    const callsBeforeDispose = listener.mock.calls.length;

    controller.dispose();
    await nextTurn();

    expect(observedSignal?.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(callsBeforeDispose);
    expect(controller.snapshot.phase).toBe('disposed');
  });

  it('does not let an older failed check overwrite a newer successful refresh', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const checks = [first, second];
    const deps = dependencies({
      checkSource: vi.fn(async (sourceId: string) => {
        await checks.shift()!.promise;
        return sourceCheck(sourceId);
      }),
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({
          payload: status({ sources: [source('official', { freshness: 'remote' })] }),
          pluginSummaries: summaries(['official', 'demo']),
        }),
    });
    const controller = new TuiController(deps);
    await controller.load();
    const newer = controller.refreshSource('official');
    second.resolve();
    await newer;
    first.reject(new Error('old remote failure'));
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
  });

  it('does not let an older full reload for another source overwrite newer status', async () => {
    const older = deferred<TuiStatusLoadResult>();
    const newer = deferred<TuiStatusLoadResult>();
    const initial = {
      payload: status({ sources: [
        source('alpha', { type: 'path', freshness: 'path', primary: true }),
        source('beta', { type: 'path', freshness: 'path', primary: false }),
      ] }),
      pluginSummaries: summaries(['alpha', 'old']),
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise),
    }));
    await controller.load();

    const alpha = controller.refreshSource('alpha');
    const beta = controller.refreshSource('beta');
    const refreshedPayload = status({ sources: [
      source('alpha', { type: 'git', freshness: 'cache', primary: true }),
      source('beta', { type: 'git', freshness: 'cache', primary: false }),
    ] });
    newer.resolve({ payload: refreshedPayload, pluginSummaries: summaries(['beta', 'newer']) });
    await beta;
    older.resolve({ payload: refreshedPayload, pluginSummaries: summaries(['alpha', 'stale']) });
    await alpha;

    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual([
      'beta/newer',
    ]);
    expect(controller.snapshot.sourceHealth).toEqual(expect.arrayContaining([
      { sourceId: 'alpha', state: 'ready' },
      { sourceId: 'beta', state: 'ready' },
    ]));
    const payloadSourceIds = new Set(controller.snapshot.viewModel?.sourceTabs.map((source) => source.id));
    expect(controller.snapshot.sourceHealth.every((health) => payloadSourceIds.has(health.sourceId))).toBe(true);
    expect(controller.snapshot.sourceHealth.some((health) => health.state === 'degraded')).toBe(false);
  });

  it('keeps per-source ready evidence when a concurrent full reload is rejected', async () => {
    const alphaCheck = deferred<void>();
    const betaCheck = deferred<void>();
    const alphaReload = deferred<TuiStatusLoadResult>();
    const betaReload = deferred<TuiStatusLoadResult>();
    const sources = [
      source('alpha', { freshness: 'cache', primary: true }),
      source('beta', { freshness: 'cache', primary: false }),
    ];
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status({ sources }), pluginSummaries: [] })
        .mockImplementationOnce(() => alphaReload.promise)
        .mockImplementationOnce(() => betaReload.promise),
      checkSource: vi.fn(async (sourceId: string) => {
        await (sourceId === 'alpha' ? alphaCheck.promise : betaCheck.promise);
        return sourceCheck(sourceId);
      }),
    }));
    await controller.load();
    alphaCheck.resolve();
    await nextTurn();
    betaCheck.resolve();
    await nextTurn();

    betaReload.resolve({ payload: status({ sources }), pluginSummaries: [] });
    await nextTurn();
    alphaReload.resolve({ payload: status({ sources }), pluginSummaries: [] });
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toEqual(expect.arrayContaining([
      { sourceId: 'alpha', state: 'ready' },
      { sourceId: 'beta', state: 'ready' },
    ]));
    expect(controller.snapshot.viewModel?.sourceTabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'alpha', state: 'ready' }),
      expect.objectContaining({ id: 'beta', state: 'ready' }),
    ]));
    expect(controller.listUserIssues()).toEqual([]);
  });

  it('does not inherit rejected refresh evidence after the authoritative source identity changes', async () => {
    const alphaCheck = deferred<void>();
    const betaCheck = deferred<void>();
    const alphaReload = deferred<TuiStatusLoadResult>();
    const betaReload = deferred<TuiStatusLoadResult>();
    const initialSources = [
      source('alpha', { freshness: 'cache', primary: true }),
      source('beta', { freshness: 'cache', primary: false }),
    ];
    const replacedSources = [
      { ...source('alpha', { freshness: 'cache', primary: true }), identity: 'identity:alpha-replaced' },
      source('beta', { freshness: 'cache', primary: false }),
    ];
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status({ sources: initialSources }), pluginSummaries: [] })
        .mockImplementationOnce(() => alphaReload.promise)
        .mockImplementationOnce(() => betaReload.promise),
      checkSource: vi.fn(async (sourceId: string) => {
        await (sourceId === 'alpha' ? alphaCheck.promise : betaCheck.promise);
        return sourceCheck(sourceId);
      }),
    }));
    await controller.load();
    alphaCheck.resolve();
    await nextTurn();
    betaCheck.resolve();
    await nextTurn();

    betaReload.resolve({ payload: status({ sources: replacedSources }), pluginSummaries: [] });
    await nextTurn();
    alphaReload.resolve({ payload: status({ sources: initialSources }), pluginSummaries: [] });
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toEqual(expect.arrayContaining([
      { sourceId: 'alpha', state: 'cache' },
      { sourceId: 'beta', state: 'ready' },
    ]));
    expect(controller.snapshot.viewModel?.sourceTabs).toContainEqual(expect.objectContaining({
      id: 'alpha', state: 'cache',
    }));
  });

  it('cancels an older refresh and removes stale source health after a source write reload', async () => {
    const oldRefresh = deferred<void>();
    const initial = {
      payload: status({ sources: [
        source('alpha', { type: 'path', freshness: 'path', primary: true }),
        source('removed', { type: 'path', freshness: 'path', primary: false, error: 'old failure' }),
      ] }),
      pluginSummaries: summaries(['alpha', 'old']),
    };
    const afterWrite = {
      payload: status({ sources: [source('alpha', { type: 'path', freshness: 'path', primary: true })] }),
      pluginSummaries: summaries(['alpha', 'new']),
    };
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: { configDigest: 'sha256:before', candidateDigest: 'sha256:candidate', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(afterWrite)
        .mockResolvedValue(initial),
      checkSource: vi.fn(async (sourceId: string) => {
        await oldRefresh.promise;
        return sourceCheck(sourceId);
      }),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
    }));
    await controller.load();
    const refresh = controller.refreshSource('removed');
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'remove',
      sourceId: 'removed',
    });
    await controller.executeOperation(review.reviewToken);
    oldRefresh.resolve();
    await refresh;

    expect(controller.listSources().map((entry) => entry.id)).toEqual(['alpha']);
    expect(controller.snapshot.sourceHealth).toEqual([{ sourceId: 'alpha', state: 'path' }]);
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual(['alpha/new']);
  });

  it('aborts an older generation when the same source is refreshed again', async () => {
    const signals: AbortSignal[] = [];
    const checks: Array<ReturnType<typeof deferred<void>>> = [];
    const checkSource = vi.fn((_sourceId: string, signal: AbortSignal) => {
      signals.push(signal);
      const pending = deferred<void>();
      checks.push(pending);
      signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
      return pending.promise.then(() => sourceCheck(_sourceId));
    });
    const controller = new TuiController(dependencies({ checkSource }));
    await controller.load();

    const newer = controller.refreshSource('official');
    expect(signals[0]?.aborted).toBe(true);
    checks[1]!.resolve();
    await newer;
  });

  it.each([
    ['missing', undefined, 'unavailable'],
    ['error without authoritative data', source('official', { error: 'raw private error' }), 'unavailable'],
    ['cache', source('official', { freshness: 'cache' }), 'ready'],
    ['path', source('official', { freshness: 'path', type: 'path' }), 'path'],
  ] as const)('projects a successful remote reload with %s data as %s', async (_label, refreshed, expected) => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({
          payload: status({ sources: refreshed ? [refreshed] : [] }),
          pluginSummaries: summaries(['official', 'demo']),
        }),
    }));
    await controller.load();
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toEqual(refreshed
      ? [expect.objectContaining({ sourceId: 'official', state: expected })]
      : []);
    expect(controller.snapshot.sourceHealth.every((health) =>
      controller.snapshot.viewModel?.sourceTabs.some((source) => source.id === health.sourceId))).toBe(true);
    if (expected === 'ready') {
      expect(controller.snapshot.viewModel?.sourceTabs).toContainEqual(expect.objectContaining({
        id: 'official', state: 'ready',
      }));
    }
    expect(JSON.stringify(controller.snapshot)).not.toContain('raw private error');
  });
});

describe('TUI v4 Review safety', () => {
  it('groups the frozen dependency plan and projects target-level partial evidence', async () => {
    const dependencyPlan = {
      dependencyPlanSchemaVersion: 1 as const,
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/base', 'official/toolkit', 'official/root'],
      dependencyEdges: [
        { from: 'official/root', to: 'official/toolkit' },
        { from: 'official/toolkit', to: 'official/base' },
      ],
      targets: [
        { pluginId: 'official/base', pluginName: 'base', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/toolkit'], state: 'absent' as const, action: 'install' as const, order: 0 },
        { pluginId: 'official/toolkit', pluginName: 'toolkit', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/root'], state: 'present' as const, action: 'keep' as const, order: 1 },
        { pluginId: 'official/root', pluginName: 'root', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'requested' as const, requiredBy: [], state: 'absent' as const, action: 'install' as const, order: 2 },
      ],
    };
    const evidence = { ...baseEvidence, dependencyPlan };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        dependencyPlan,
        targetResults: [
          { target: { pluginId: 'official/base', platform: 'codex', scope: 'user' }, action: 'install', state: 'failed' },
          { target: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }, action: 'keep', state: 'completed' },
          { target: { pluginId: 'official/root', platform: 'codex', scope: 'user' }, action: 'skipped', state: 'failed' },
        ],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/root', platform: 'codex', scope: 'user',
    });

    expect(review.primaryLabel).toContain('3 个插件');
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/root', group: 'requested', relation: 'requested', kind: 'add' }),
      expect.objectContaining({ pluginId: 'official/toolkit', group: 'dependencies', relation: 'direct', kind: 'keep' }),
      expect.objectContaining({ group: 'preserved' }),
    ]));
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'partial',
      summary: { targets: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'official/base', relation: 'transitive', state: 'failed' }),
        expect.objectContaining({ pluginId: 'official/toolkit', relation: 'direct', state: 'kept', requiredBy: ['official/root'] }),
        expect.objectContaining({ pluginId: 'official/root', relation: 'requested', state: 'skipped' }),
      ]) },
    });
    expect(controller.snapshot.progressTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/toolkit', relation: 'direct', state: 'kept' }),
      expect.objectContaining({ pluginId: 'official/root', relation: 'requested', state: 'skipped' }),
    ]));
  });

  it('keeps a failed dependency execution failed when no target completed or was kept', async () => {
    const dependencyPlan = {
      dependencyPlanSchemaVersion: 1 as const,
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/toolkit', 'official/root'],
      dependencyEdges: [{ from: 'official/root', to: 'official/toolkit' }],
      targets: [
        { pluginId: 'official/toolkit', pluginName: 'toolkit', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/root'], state: 'absent' as const, action: 'install' as const, order: 0 },
        { pluginId: 'official/root', pluginName: 'root', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'requested' as const, requiredBy: [], state: 'absent' as const, action: 'install' as const, order: 1 },
      ],
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, dependencyPlan }),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        dependencyPlan,
        targetResults: [
          { target: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }, action: 'install', state: 'failed' },
          { target: { pluginId: 'official/root', platform: 'codex', scope: 'user' }, action: 'skipped', state: 'failed' },
        ],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/root', platform: 'codex', scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);
    expect(result).toMatchObject({
      state: 'blocked',
      code: 'operationFailed',
      summary: {
        code: 'operationFailed',
        targets: [
          expect.objectContaining({ pluginId: 'official/toolkit', relation: 'direct', state: 'failed' }),
          expect.objectContaining({ pluginId: 'official/root', relation: 'requested', state: 'skipped' }),
        ],
      },
    });
    expect(result).not.toHaveProperty('writeMayHaveCompleted');
    expect(controller.snapshot.result).toMatchObject({
      state: 'blocked', code: 'operationFailed', summary: { code: 'operationFailed' },
    });
  });

  it('single-flights repeated execution while validation and evidence capture are delayed', async () => {
    const validation = deferred<void>();
    const capture = deferred<OperationEvidence>();
    const executeIntent = vi.fn().mockResolvedValue({
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const validateIntent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => validation.promise);
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(baseEvidence)
      .mockImplementationOnce(() => capture.promise);
    const controller = new TuiController(dependencies({
      validateIntent,
      captureEvidence,
      executeIntent,
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    const observedCodes: string[] = [];
    controller.subscribe((snapshot) => {
      if (snapshot.result?.state === 'blocked') observedCodes.push(snapshot.result.code);
    });

    const first = controller.executeOperation(review.reviewToken);
    const second = controller.executeOperation(review.reviewToken);
    expect(second).toBe(first);
    expect(controller.snapshot.router.current.route).toEqual({ name: 'progress', operationId: review.operationId });
    validation.resolve();
    await nextTurn();
    capture.resolve(baseEvidence);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.operationId).toBe(review.operationId);
    expect(observedCodes).not.toContain('reviewTicketInvalid');
  });

  it('does not publish after disposal while an operation write is pending', async () => {
    const write = deferred<unknown>();
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn(() => write.promise),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    const executing = controller.executeOperation(review.reviewToken);
    const callsBeforeDispose = listener.mock.calls.length;

    controller.dispose();
    write.resolve({ targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }] });
    await executing;

    expect(listener).toHaveBeenCalledTimes(callsBeforeDispose);
    expect(controller.snapshot.phase).toBe('disposed');
    expect(controller.snapshot.router.current.route.name).toBe('progress');
  });

  it.each([
    ['pluginWrite', {
      kind: 'pluginWrite' as const, action: 'upgrade' as const, pluginId: 'official/demo',
      platform: 'codex' as const, scope: 'user' as const,
    }, baseEvidence, { name: 'pluginDetail' as const, pluginId: 'official/demo' }],
    ['sourceMutation', {
      kind: 'sourceMutation' as const, action: 'add' as const, sourceId: 'team',
      source: { id: 'team', type: 'path' as const, primary: false, path: '/safe/fixture' },
    }, {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before', candidateDigest: 'sha256:candidate',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    }, { name: 'sourceAdd' as const, step: 'location' as const, owner: 'draft-1' }],
  ])('uses the fixed unconfirmed-write result after a successful %s write cannot reload status', async (
    _label,
    intent,
    evidence,
    returnRoute,
  ) => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockRejectedValueOnce(new Error('/private/reload failed')),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      checkSource: vi.fn(() => new Promise(() => undefined)),
      executeIntent: vi.fn().mockResolvedValue({
        targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
      }),
    }));
    await controller.load();
    controller.push(returnRoute);
    const review = await controller.buildOperationReview(intent);

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'blocked', code: 'tuiStateReloadFailed', writeMayHaveCompleted: true,
      message: '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。',
      returnRoute,
    });
    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual(returnRoute);
  });

  it.each([
    ['succeeded', {
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    }],
    ['partial', {
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
      ],
    }],
    ['blocked', new Error('writeRejected')],
  ] as const)('replaces transient routes for a %s result and never returns to Progress', async (state, execution) => {
    const controller = new TuiController(dependencies({
      executeIntent: execution instanceof Error
        ? vi.fn().mockRejectedValue(execution)
        : vi.fn().mockResolvedValue(execution),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'both', scope: 'user',
    });
    const depthAtReview = controller.snapshot.router.depth;

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state });
    expect(controller.snapshot.router).toMatchObject({
      depth: depthAtReview,
      current: { route: { name: 'result', operationId: review.operationId } },
    });

    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.router.depth).toBe(depthAtReview - 1);
    controller.back();
    expect(controller.snapshot.router).toMatchObject({ depth: 1, current: { route: { name: 'home' } } });
  });

  it.each([
    ['plugin', { name: 'pluginDetail' as const, pluginId: 'official/demo' }],
    ['source', { name: 'sourceList' as const }],
    ['issue', { name: 'issueList' as const }],
    ['home', { name: 'home' as const }],
    ['failed target', { name: 'platform' as const, pluginId: 'official/demo', platform: 'codex' as const }],
  ])('leaves Result through one terminal API for the %s action and removes transient history', async (_label, targetRoute) => {
    const controller = new TuiController(dependencies());
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await controller.executeOperation(review.reviewToken);

    controller.leaveResult(targetRoute);

    expect(controller.snapshot.result).toBeUndefined();
    expect(controller.snapshot.router.current.route).toEqual(targetRoute);
    expect(controller.snapshot.router.depth).toBe(2);
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('normalizes an explicit Result destination before replacing its terminal frame', async () => {
    const controller = new TuiController(dependencies());
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await controller.executeOperation(review.reviewToken);

    controller.leaveResult({ name: 'pluginDetail', pluginId: 'missing/plugin' });

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(controller.snapshot.result).toBeUndefined();
  });

  it.each([
    ['plugin', {
      kind: 'pluginWrite' as const, action: 'upgrade' as const, pluginId: 'official/demo',
      platform: 'codex' as const, scope: 'user' as const,
    }, { targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }] }],
    ['config', {
      kind: 'configSave' as const, pluginId: 'official/demo', scope: 'user' as const,
      projectLayer: 'shared' as const, updates: { level: 'strict' },
    }, { configWrite: 'succeeded', targetResults: [] }],
  ])('starts a Git refresh after the accepted %s write status is published', async (_label, intent, execution) => {
    const check = deferred<void>();
    const cached = {
      payload: status({ sources: [source('official', { freshness: 'cache' })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const ready = {
      payload: status({ sources: [source('official', { freshness: 'remote' })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const checkSource = vi.fn((sourceId: string) => check.promise.then(() => sourceCheck(sourceId)));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({
          payload: status({ sources: [source('official', { type: 'path', freshness: 'path' })] }),
          pluginSummaries: summaries(['official', 'demo']),
        })
        .mockResolvedValueOnce(cached)
        .mockResolvedValueOnce(ready),
      checkSource,
      executeIntent: vi.fn().mockResolvedValue(execution),
    }));
    const observed: Array<{ result: boolean; health?: string }> = [];
    controller.subscribe((snapshot) => observed.push({
      result: snapshot.result?.state === 'succeeded',
      health: snapshot.sourceHealth.find((entry) => entry.sourceId === 'official')?.state,
    }));
    await controller.load();
    const review = await controller.buildOperationReview(intent);
    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({ state: 'succeeded' });

    expect(checkSource).toHaveBeenCalledWith('official', expect.any(AbortSignal));
    expect(observed).toEqual(expect.arrayContaining([
      { result: true, health: 'cache' },
      { result: true, health: 'checking' },
    ]));
    check.resolve();
    await nextTurn();
    await nextTurn();
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
  });

  it('starts a refresh for a new Git source after an accepted source add', async () => {
    const check = deferred<void>();
    const teamCache = source('team', { freshness: 'cache', primary: false });
    const teamReady = source('team', { freshness: 'remote', primary: false });
    const checkSource = vi.fn((sourceId: string) => check.promise.then(() => sourceCheck(sourceId)));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({
          payload: status({ sources: [source('official', { type: 'path', freshness: 'path' })] }),
          pluginSummaries: summaries(['official', 'demo']),
        })
        .mockResolvedValueOnce({
          payload: status({ sources: [source('official', { type: 'path', freshness: 'path' }), teamCache] }),
          pluginSummaries: [...summaries(['official', 'demo']), ...summaries(['team', 'new'])],
        })
        .mockResolvedValueOnce({
          payload: status({ sources: [source('official', { type: 'path', freshness: 'path' }), teamReady] }),
          pluginSummaries: [...summaries(['official', 'demo']), ...summaries(['team', 'new'])],
        }),
      checkSource,
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation', action: 'add', sourceId: 'team',
      source: { id: 'team', type: 'git', primary: false, url: 'https://example.test/team.git', refPolicy: { type: 'cliChannel' }, subdir: 'catalog' },
    });
    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({ state: 'succeeded' });

    expect(checkSource).toHaveBeenCalledWith('team', expect.any(AbortSignal));
    expect(checkSource).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'team', state: 'checking' });
    check.resolve();
    await nextTurn();
    await nextTurn();
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'team', state: 'ready' });
  });

  function issueWriteFixture(afterWrite: TuiStatusLoadResult | Error) {
    const initial: TuiStatusLoadResult = {
      payload: status({
        sources: [source('official', { type: 'path', freshness: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadStatus = vi.fn().mockResolvedValueOnce(initial);
    if (afterWrite instanceof Error) loadStatus.mockRejectedValueOnce(afterWrite);
    else loadStatus.mockResolvedValueOnce(afterWrite);
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const value = new TuiController(dependencies({ loadStatus, executeIntent }));
    return { value, initial, executeIntent };
  }

  async function buildIssueReview(value: TuiController) {
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'incompleteInstallation')!;
    return value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'reinstall',
      pluginId: issue.pluginId!,
      platform: issue.platform!,
      scope: issue.scope!,
      originIssue: {
        issueId: issue.issueId,
        issueKey: userIssueKey(issue),
        category: issue.category,
        actionId: 'reinstall',
      },
    });
  }

  it('reports issueStillPresent after a successful command when the typed issue remains', async () => {
    const fixture = issueWriteFixture({
      payload: status({
        sources: [source('official', { type: 'path', freshness: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const review = await buildIssueReview(fixture.value);

    const result = await fixture.value.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'issueStillPresent', writeMayHaveCompleted: true,
      verification: 'issueStillPresent',
    });
    expect(fixture.executeIntent).toHaveBeenCalledTimes(1);
    expect(fixture.value.snapshot.phase).toBe('ready');
  });

  it('keeps an issue-origin dependency partial result when the origin issue remains', async () => {
    const dependencyPlan = {
      dependencyPlanSchemaVersion: 1 as const,
      requestedPluginIds: ['official/demo'],
      resolvedPluginIds: ['official/base', 'official/toolkit', 'official/demo'],
      dependencyEdges: [
        { from: 'official/demo', to: 'official/toolkit' },
        { from: 'official/toolkit', to: 'official/base' },
      ],
      targets: [
        { pluginId: 'official/base', pluginName: 'base', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/toolkit'], state: 'present' as const, action: 'keep' as const, order: 0 },
        { pluginId: 'official/toolkit', pluginName: 'toolkit', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/demo'], state: 'absent' as const, action: 'install' as const, order: 1 },
        { pluginId: 'official/demo', pluginName: 'demo', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'requested' as const, requiredBy: [], state: 'partial' as const, action: 'install' as const, order: 2 },
      ],
    };
    const loaded: TuiStatusLoadResult = {
      payload: status({
        sources: [source('official', { type: 'path', freshness: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'base'], ['official', 'toolkit'], ['official', 'demo']),
    };
    const value = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, dependencyPlan }),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        dependencyPlan,
        targetResults: [
          { target: { pluginId: 'official/base', platform: 'codex', scope: 'user' }, action: 'keep', state: 'completed' },
          { target: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }, action: 'install', state: 'failed' },
          { target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' }, action: 'skipped', state: 'failed' },
        ],
      }),
    }));
    const review = await buildIssueReview(value);

    const result = await value.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'partial',
      summary: {
        code: 'operationPartial',
        targets: [
          expect.objectContaining({ pluginId: 'official/base', relation: 'transitive', state: 'kept' }),
          expect.objectContaining({ pluginId: 'official/toolkit', relation: 'direct', state: 'failed' }),
          expect.objectContaining({ pluginId: 'official/demo', relation: 'requested', state: 'skipped' }),
        ],
      },
      originIssue: expect.objectContaining({ category: 'incompleteInstallation', actionId: 'reinstall' }),
    });
    expect(result).not.toHaveProperty('code', 'issueStillPresent');
    expect(value.listUserIssues()).toContainEqual(expect.objectContaining({
      category: 'incompleteInstallation', pluginId: 'official/demo', scope: 'user',
    }));
  });

  it('reports issueVerificationFailed without claiming no write when post-write reload fails', async () => {
    const fixture = issueWriteFixture(new Error('/Users/private/reload failure'));
    const review = await buildIssueReview(fixture.value);

    const result = await fixture.value.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'issueVerificationFailed', writeMayHaveCompleted: true,
      verification: 'verificationFailed',
      message: '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。',
    });
    expect(fixture.executeIntent).toHaveBeenCalledTimes(1);
    expect(fixture.value.snapshot.phase).toBe('ready');
    expect(JSON.stringify(fixture.value.snapshot)).not.toContain('/Users/private');
  });

  it('reports issue success only after the typed issue disappears', async () => {
    const fixture = issueWriteFixture({
      payload: status({
        sources: [source('official', { type: 'path', freshness: 'path' })],
        targets: [target({ scope: 'user', state: 'present' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const review = await buildIssueReview(fixture.value);

    expect(await fixture.value.executeOperation(review.reviewToken)).toMatchObject({ state: 'succeeded' });
    expect(fixture.value.listUserIssues()).toEqual([]);
  });

  it('reloads status and blocks an all-failed receipt as an unconfirmed write', async () => {
    const refreshed = {
      payload: status({
        sources: [source('official', { type: 'path', freshness: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce({
        payload: status({ sources: [source('official', { type: 'path', freshness: 'path' })] }),
        pluginSummaries: summaries(['official', 'demo']),
      })
      .mockResolvedValue(refreshed);
    const controller = new TuiController(dependencies({
      loadStatus,
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: { platform: 'codex', scope: 'user' },
          state: 'failed',
          errorCode: 'durableCleanupFailed',
        }],
      }),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'operationFailed', writeMayHaveCompleted: true,
      operationKind: 'pluginWrite', pluginId: 'official/demo',
      returnRoute: { name: 'pluginDetail', pluginId: 'official/demo' },
    });
    expect(result).not.toHaveProperty('summary');
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(controller.getTargetState('official/demo', 'codex', 'user')).toBe('partial');
  });

  it('blocks a forged issue origin before evidence capture and performs zero writes', async () => {
    const executeIntent = vi.fn();
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const value = new TuiController(dependencies({ executeIntent, captureEvidence }));
    await value.load();

    await expect(value.buildOperationReview({
      kind: 'pluginWrite', action: 'reinstall', pluginId: 'official/demo', platform: 'codex', scope: 'user',
      originIssue: {
        issueId: 'forged', issueKey: 'forged', category: 'incompleteInstallation', actionId: 'reinstall',
      },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('revalidates both sides of a dependency issue at execution entry and performs zero writes when it changes', async () => {
    const consumer = target({ pluginName: 'root', scope: 'project', state: 'partial' });
    consumer.errors = [{ code: 'dependencyMissing', message: 'dependencyMissing: official/toolkit is absent.' }];
    const loaded: TuiStatusLoadResult = {
      payload: status({ targets: [consumer, target({ pluginName: 'toolkit', scope: 'user', state: 'absent' })] }),
      pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
      dependencyOverviews: [{
        pluginId: 'official/root',
        summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 1, issueCount: 1 },
        dependencies: [{
          pluginId: 'official/toolkit', displayName: 'Toolkit', relation: 'direct', depth: 1,
          requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }], placements: [], aggregateStatus: 'notInstalled',
          placementReferences: [{
            consumer: { pluginId: 'official/root', platform: 'codex', scope: 'project', project: 'current' },
            dependency: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user', project: null },
          }],
        }],
        dependents: [], blockers: [],
      }],
    };
    const validateIntent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('operationReviewStale: consumer issue changed'));
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const executeIntent = vi.fn();
    const value = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded), validateIntent, captureEvidence, executeIntent,
    }));
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'dependencyMissing')!;
    const action = issue.actions.find((candidate) => candidate.id === 'installDependency')!;
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
      originIssue: {
        issueId: issue.issueId, issueKey: userIssueKey(issue), category: issue.category, actionId: action.id,
        consumerPluginId: issue.pluginId, consumerSourceIdentity: issue.sourceIdentity,
        consumerPlatform: issue.platform, consumerScope: issue.scope,
        dependencyPluginId: issue.dependencyPluginId, dependencyPlatform: issue.dependencyPlatform,
        dependencyScope: issue.dependencyScope, dependencyProject: issue.dependencyProject,
      },
    });

    await expect(value.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'operationReviewStale',
    });
    expect(captureEvidence).toHaveBeenCalledTimes(1);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('blocks a forged scope conflict for %s + %s with zero writes', async (userState, projectState) => {
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const executeIntent = vi.fn();
    const value = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ scope: 'user', state: userState }),
          target({ scope: 'project', state: projectState }),
        ] }),
        pluginSummaries: summaries(['official', 'demo']),
      }),
      captureEvidence,
      executeIntent,
    }));
    await value.load();

    await expect(value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: userState === 'present' ? 'user' : 'project',
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'forged',
        category: 'scopeConflict',
        actionId: userState === 'present' ? 'keepProjectScope' : 'keepUserScope',
      },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('reports a committed config write with one failed target as partial', async () => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'failed',
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    }));
    controller.push({
      name: 'configFields',
      pluginId: 'official/demo',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { mode: 'strict' },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'partial',
      summary: {
        code: 'operationPartial',
        message: '操作只完成了一部分。',
        targets: [
          expect.objectContaining({ platform: 'codex', state: 'completed' }),
          expect.objectContaining({ platform: 'claude', state: 'failed' }),
        ],
      },
    });
    expect(controller.snapshot.router.current.route).toMatchObject({ name: 'result' });
    expect(controller.snapshot.activeReview).toBeUndefined();
  });

  it('reports a reset as unconfirmed when the post-write status reload fails', async () => {
    const initial = {
      payload: status({ sources: [source('official', { type: 'path', freshness: 'path', primary: true })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error('/private/reload failed'));
    const controller = new TuiController(dependencies({
      loadStatus,
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded', targetResults: [],
      }),
    }));
    await controller.load();
    controller.push({
      name: 'configUnavailable', pluginId: 'official/demo',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'blocked', code: 'tuiStateReloadFailed', operationKind: 'configReset',
      pluginId: 'official/demo', writeMayHaveCompleted: true,
      message: '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。',
      returnRoute: { name: 'configUnavailable', pluginId: 'official/demo' },
    });
    expect(controller.snapshot.phase).toBe('ready');
    expect(JSON.stringify(controller.snapshot)).not.toContain('/private/reload');
  });

  it('accepts a reset receipt when the refreshed plugin bundle is unavailable', async () => {
    const initial = {
      payload: status({ sources: [source('official', { type: 'path', freshness: 'path', primary: true })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const unavailable = {
      payload: status({
        sources: [source('official', { freshness: 'cache' })],
        targets: [target({ scope: 'user', state: 'error', errorCode: 'bundleUnavailable' })],
      }),
      pluginSummaries: [],
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(unavailable),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded', targetResults: [],
      }),
    }));
    await controller.load();
    controller.push({ name: 'configUnavailable', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'succeeded', operationKind: 'configReset',
      summary: { message: '操作已完成。' },
    });
    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'configUnavailable', pluginId: 'official/demo',
    });
  });

  it('returns from a successful result to the installed list when its plugin was deleted', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    controller.leaveResult();

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('normalizes deleted plugin routes restored from history after a background reload', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
    }));
    await controller.load();
    controller.push({ name: 'configUnavailable', pluginId: 'official/demo' });
    controller.push({ name: 'sourceList' });

    await controller.load();
    controller.back();

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('normalizes a deleted plugin return route for blocked and stale results', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:changed' };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
      captureEvidence: vi.fn()
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValue(changedEvidence),
    }));
    await controller.load();
    controller.push({ name: 'configUnavailable', pluginId: 'official/demo' });
    const staleReview = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    await expect(controller.executeOperation(staleReview.reviewToken)).resolves.toMatchObject({ state: 'stale' });
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });

    const blocked = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
      executeIntent: vi.fn().mockRejectedValue(new Error('writeRejected')),
    }));
    await blocked.load();
    blocked.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const blockedReview = await blocked.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await expect(blocked.executeOperation(blockedReview.reviewToken)).resolves.toMatchObject({ state: 'blocked' });
    blocked.leaveResult();
    expect(blocked.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('confirms reset when the source remains ready after execution', async () => {
    const readyStatus = {
      payload: status({ sources: [source('official', { type: 'path', freshness: 'path', primary: true })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(readyStatus),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded', targetResults: [],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'succeeded', operationKind: 'configReset',
    });
  });

  it('reloads status and reports uncertainty when config runtime apply throws', async () => {
    const loadStatus = vi.fn().mockResolvedValue({
      payload: status({ sources: [source('official', { type: 'path', freshness: 'path' })] }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const controller = new TuiController(dependencies({
      loadStatus,
      executeIntent: vi.fn().mockRejectedValue(
        new Error('runtimeApplyFailed: runtime apply failed: /Users/private/config.json'),
      ),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { mode: 'strict' },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'runtimeApplyFailed', operationKind: 'configSave',
      writeMayHaveCompleted: true,
    });
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(controller.snapshot)).not.toContain('/Users/private');
  });

  it('invalidates cancelled, expired, and over-limit Review tickets through public behavior', async () => {
    let token = 0;
    let now = 1_000;
    const controller = new TuiController(dependencies({
      createToken: () => `token-${++token}`,
      now: () => now,
      reviewTtlMs: 10,
      maxReviewTickets: 2,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };
    const oldest = await controller.buildOperationReview(intent);
    const retained = await controller.buildOperationReview(intent);
    const newest = await controller.buildOperationReview(intent);
    expect(await controller.executeOperation(oldest.reviewToken)).toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });
    expect(await controller.executeOperation(retained.reviewToken)).toMatchObject({ state: 'succeeded' });

    const cancelled = await controller.buildOperationReview(intent);
    controller.back();
    expect(await controller.executeOperation(cancelled.reviewToken)).toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });

    const expired = await controller.buildOperationReview(intent);
    now = 2_000;
    await controller.buildOperationReview(intent);
    expect(await controller.executeOperation(expired.reviewToken)).toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });
    expect(newest.reviewToken).not.toBe(cancelled.reviewToken);
  });

  it('performs zero writes and shows a blocked result after fresh status makes the stale intent illegal', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:changed' };
    const executeIntent = vi.fn();
    const validateIntent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('targetAlreadyInstalled: new state is not legal'));
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(baseEvidence)
      .mockResolvedValueOnce(changedEvidence)
      .mockResolvedValueOnce(changedEvidence);
    const controller = new TuiController(dependencies({
      captureEvidence,
      executeIntent,
      validateIntent,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };
    const review = await controller.buildOperationReview(intent);

    const result = await controller.executeOperation(review.reviewToken);

    expect(executeIntent).not.toHaveBeenCalled();
    expect(validateIntent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'blocked',
      code: 'targetAlreadyInstalled',
    });
    expect(result).not.toHaveProperty('writeMayHaveCompleted');
    expect(controller.snapshot.router.current.route).toEqual({ name: 'result', operationId: review.operationId });
  });

  it('returns a new Review when the locked write reports a typed stale prefix', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:locked-change' };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn()
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValueOnce(changedEvidence),
      executeIntent: vi.fn().mockRejectedValue(
        new Error('operationReviewStale: /Users/private/target token-private'),
      ),
    }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result.state).toBe('stale');
    expect(controller.snapshot.router.depth).toBe(2);
    expect(JSON.stringify(controller.snapshot)).not.toContain('/Users/private');
    expect(JSON.stringify(controller.snapshot)).not.toContain('token-private');
  });

  it('does not expose sensitive config values in Review or controller snapshots', async () => {
    const secret = 'sk-private-review-secret';
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        config: {
          scope: 'user',
          projectLayer: 'shared',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
        },
      }),
    }));
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { token: secret },
      sensitiveKeys: ['token'],
    });

    const visible = JSON.stringify({ review, snapshot: controller.snapshot });
    expect(visible).not.toContain(secret);
    expect(visible).toContain('已设置 → 将更新');
    expect(visible).not.toContain('/Users/');
  });

  it('passes the canonical plugin identity to the write executor', async () => {
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const controller = new TuiController(dependencies({ executeIntent }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'cleanup',
      pluginId: 'team-tools/review-gate',
      platform: 'claude',
      scope: 'project',
    });

    await controller.executeOperation(review.reviewToken);

    expect(executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'team-tools/review-gate' }),
      baseEvidence,
    );
    expect(controller.snapshot.result).toMatchObject({
      summary: { pluginId: 'team-tools/review-gate', action: 'cleanup' },
    });
  });

  it('keeps only a safe result summary and reloads after a post-command failure', async () => {
    const secret = '/Users/private/config.json?token=private-token';
    const succeeded = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({ configWrite: 'succeeded', effective: { token: secret }, path: secret }),
    }));
    const successReview = await succeeded.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { token: secret },
      sensitiveKeys: ['token'],
    });
    await succeeded.executeOperation(successReview.reviewToken);

    const failed = new TuiController(dependencies({
      executeIntent: vi.fn().mockRejectedValue(new Error(`nativeStateUnreadable: ${secret}`)),
    }));
    const failureReview = await failed.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
    });
    await failed.executeOperation(failureReview.reviewToken);

    expect(succeeded.snapshot.result).toEqual(expect.objectContaining({
      state: 'succeeded',
      summary: expect.objectContaining({ code: 'operationSucceeded', message: '操作已完成。' }),
    }));
    expect(failed.snapshot.result).toEqual(expect.objectContaining({
      state: 'blocked',
      code: 'nativeStateUnreadable',
      writeMayHaveCompleted: true,
      message: '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。',
    }));
    expect(JSON.stringify({ success: succeeded.snapshot, failure: failed.snapshot })).not.toContain(secret);
  });

  it('isolates nested router, status, ticket, progress, and result values from caller mutation', async () => {
    const router = new TuiRouter();
    const route = {
      name: 'configFields' as const,
      pluginId: 'official/demo',
      layer: { scope: 'project' as const, projectLayer: 'shared' as const },
    };
    router.push(route);
    route.layer.projectLayer = 'local';
    expect(router.snapshot.current.route).toMatchObject({ layer: { projectLayer: 'shared' } });

    const loaded = {
      payload: status({ sources: [source('official', { type: 'path', freshness: 'path' })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadSnapshot = structuredClone(loaded);
    let progressListener: ((value: { messages: string[] }) => void) | undefined;
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockImplementation(async () => structuredClone(loadSnapshot)),
    }), {
      subscribe: (listener) => {
        progressListener = listener;
        return vi.fn();
      },
    } as unknown as RebuildProgressFeed);
    await controller.load();
    loaded.pluginSummaries[0]!.pluginName = 'mutated';
    const messages = ['safe'];
    progressListener?.({ messages });
    messages[0] = 'mutated';
    expect(controller.snapshot.progress.messages).toEqual(['safe']);
    const intent = {
      kind: 'configSave' as const,
      pluginId: 'official/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
      updates: { mode: 'safe' },
    };
    const review = await controller.buildOperationReview(intent);
    intent.updates.mode = 'mutated';
    await controller.executeOperation(review.reviewToken);
    const snapshot = controller.snapshot;

    expect(controller.listPlugins({ mode: 'browse' })[0]?.displayName).toBe('demo');
    expect(snapshot.progress.messages).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.viewModel?.plugins)).toBe(true);
    expect(controller.dependencies.executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { mode: 'safe' } }),
      baseEvidence,
    );
  });

  it('publishes rebuild progress through the unified snapshot', () => {
    let progressListener: ((value: { current?: { target: string; phase: string }; messages: string[] }) => void) | undefined;
    const progressFeed = {
      subscribe: vi.fn((listener) => {
        progressListener = listener;
        listener({ messages: [] });
        return vi.fn();
      }),
    } as unknown as RebuildProgressFeed;
    const controller = new TuiController(dependencies(), progressFeed);
    progressListener?.({ current: { target: 'demo', phase: '检查当前组件' }, messages: ['开始检查'] });

    expect(controller.snapshot.progress).toEqual({
      current: { target: 'demo', phase: '检查当前组件' },
      messages: ['开始检查'],
    });
  });

  it('retains elapsed time and only the latest eight safe progress messages in the result summary', async () => {
    let listener: ((value: { messages: string[] }) => void) | undefined;
    let now = 1_000;
    const controller = new TuiController(dependencies({
      now: () => now,
      executeIntent: vi.fn(async () => {
        listener?.({ messages: Array.from({ length: 10 }, (_, index) => `安全消息 ${index + 1}`) });
        now = 4_500;
        return { configWrite: 'succeeded', overallState: 'succeeded', targetResults: [] };
      }),
    }), {
      subscribe: (next) => {
        listener = next;
        next({ messages: [] });
        return vi.fn();
      },
      clearCurrent: vi.fn(),
    } as unknown as RebuildProgressFeed);
    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared', updates: { mode: 'safe' },
    });
    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'succeeded',
      summary: { elapsedMs: 3_500, messages: Array.from({ length: 8 }, (_, index) => `安全消息 ${index + 3}`) },
    });
  });

  it('clears current and messages before each consecutive formal execution', async () => {
    const feed = createRebuildProgressFeed();
    const second = deferred<unknown>();
    let call = 0;
    const value = new TuiController(dependencies({
      executeIntent: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          feed.addEvent({
            type: 'rebuild:action',
            source: { plugin: 'demo', platform: 'codex', scope: 'user' },
            data: { name: 'preflight.inspect', phase: 'start' },
          } as never);
          return { ok: true };
        }
        return second.promise;
      }),
    }), feed);
    const intent = {
      kind: 'pluginWrite' as const, action: 'install' as const,
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
    };
    const first = await value.buildOperationReview(intent);
    await value.executeOperation(first.reviewToken);
    expect(value.snapshot.progress.current).toBeDefined();
    const messages = value.snapshot.progress.messages;

    const next = await value.buildOperationReview(intent);
    const executing = value.executeOperation(next.reviewToken);
    await nextTurn();
    expect(value.snapshot.progress.current).toEqual({
      target: 'official/demo', phase: '验证当前状态',
    });
    expect(messages).not.toEqual([]);
    expect(value.snapshot.progress.messages).toEqual([]);
    second.resolve({ ok: true });
    const secondResult = await executing;
    expect(secondResult).toMatchObject({ summary: { messages: [] } });
    expect(JSON.stringify(secondResult)).not.toContain('demo · Codex');
  });

  it('binds source writes to candidate and inventory evidence without exposing private input', async () => {
    const privatePath = '/Users/private/catalog';
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before',
        candidateDigest: 'sha256:candidate',
        sourceIdentity: 'sha256:identity',
        inventoryDigest: 'sha256:inventory',
        referenceCount: 0,
        inventoryComplete: true,
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'local-dev',
      source: { id: 'local-dev', type: 'path', primary: false, path: privatePath },
      changes: [{ title: '本地目录', private: true }],
    });

    expect(review.technicalDetails).toContain('候选配置：sha256:candidate');
    expect(review.technicalDetails).toContain('引用清单：sha256:inventory · 0 项');
    expect(JSON.stringify(controller.snapshot)).not.toContain(privatePath);
    await controller.executeOperation(review.reviewToken);
    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded', operationKind: 'sourceMutation' });
    expect(vi.mocked(controller.dependencies.loadStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rebuilds a source Review with zero writes when config evidence becomes stale', async () => {
    const first: OperationEvidence = {
      catalog: { configDigest: 'sha256:one', compositeDigest: 'sha256:candidate-one' },
      sourceWrite: { configDigest: 'sha256:one', candidateDigest: 'sha256:candidate-one', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const second: OperationEvidence = {
      catalog: { configDigest: 'sha256:two', compositeDigest: 'sha256:candidate-two' },
      sourceWrite: { configDigest: 'sha256:two', candidateDigest: 'sha256:candidate-two', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const executeIntent = vi.fn();
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      executeIntent,
    }));
    const review = await controller.buildOperationReview({ kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools' });
    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({ state: 'stale' });
    expect(executeIntent).not.toHaveBeenCalled();
    expect(controller.snapshot.activeReview?.technicalDetails).toContain('候选配置：sha256:candidate-two');
  });

  it('maps a source config CAS conflict to the same typed stale Review', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:one', compositeDigest: 'sha256:candidate' },
      sourceWrite: { configDigest: 'sha256:one', candidateDigest: 'sha256:candidate', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const conflict = new Error('Catalog source config changed concurrently.');
    conflict.name = 'CatalogSourcesConfigConflictError';
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockRejectedValue(conflict),
    }));
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'setPrimary',
      sourceId: 'team-tools',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'stale',
      operationKind: 'sourceMutation',
      sourceAction: 'setPrimary',
      review: { operationKind: 'sourceMutation', sourceAction: 'setPrimary' },
    });
  });
});
