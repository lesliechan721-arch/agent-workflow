import { describe, expect, it, vi } from 'vitest';

import type { StatusV7Payload, StatusV7PluginSummary } from '../../src/commands/status-v6.js';
import type { DependencyOperationPlan } from '../../src/commands/dependency-operation-plan.js';
import { createRebuildProgressFeed, type RebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  TuiController,
  operationEvidenceFingerprint,
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
  options: { primary?: boolean; error?: string; type?: 'git' | 'path' } = {},
): StatusV7Payload['catalog']['sources'][number] {
  return {
    id,
    identity: `identity:${id}`,
    type: options.type ?? 'git',
    primary: options.primary ?? id === 'official',
    requestedRef: options.type === 'path' ? 'path' : 'refs/heads/catalog/latest',
    ...(!options.error ? { freshness: 'active' as const } : {}),
    ...(options.error ? { error: options.error, errorCode: 'catalogSourceUnavailable' } : {}),
  };
}

function sourceDetail(
  id: string,
  options: { autoCheck?: boolean; primary?: boolean; explicitRef?: string } = {},
): NonNullable<TuiStatusLoadResult['sourceDetails']>[number] {
  return {
    id,
    type: 'git',
    primary: options.primary ?? id === 'official',
    autoCheck: options.autoCheck ?? true,
    locationSummary: `https://example.test/${id}.git`,
    refPolicy: options.explicitRef ? 'explicit' : 'cliChannel',
    ...(options.explicitRef ? { explicitRef: options.explicitRef } : {}),
    pluginCount: 0,
    sourceIdentity: `identity:${id}`,
    requestedRef: options.explicitRef ?? 'refs/heads/catalog/latest',
    configDigest: 'sha256:config',
  };
}

function status(options: {
  sources?: StatusV7Payload['catalog']['sources'];
  targets?: StatusV7Payload['targets'];
  errors?: StatusV7Payload['errors'];
} = {}): StatusV7Payload {
  return {
    schemaVersion: 7,
    catalog: {
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: options.sources ?? [source('official')],
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
  errors?: StatusV7Payload['targets'][number]['errors'];
  recoveryActions?: StatusV7Payload['targets'][number]['recoveryActions'];
}): StatusV7Payload['targets'][number] {
  const pluginName = options.pluginName ?? 'demo';
  const sourceId = options.sourceId ?? 'official';
  const state = options.state === 'present'
    ? 'ready' as const
    : options.state === 'partial'
      ? 'needsSync' as const
      : options.state === 'error' ? 'blocked' as const : 'absent' as const;
  return {
    pluginName,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    pluginId: `${sourceId}/${pluginName}`,
    version: '1.0.0',
    platform: options.platform ?? 'codex',
    scope: options.scope,
    cwd: '/workspace',
    state,
    components: [{ kind: 'ownership', key: 'fixture', state: options.state }],
    reasons: options.errors
      ?? (options.state === 'error' ? [{ code: options.errorCode ?? 'targetError', message: 'safe failure', severity: 'blocking' }] : []),
    recoveryActions: options.recoveryActions ?? [],
  };
}

function summaries(...entries: Array<[string, string]>): StatusV7PluginSummary[] {
  return entries.map(([sourceId, pluginName]) => ({
    pluginName,
    pluginId: `${sourceId}/${pluginName}`,
    description: `${sourceId} description`,
  }));
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

  it('projects collision-only targets as blocked without installed evidence', () => {
    const collision = target({
      pluginName: 'collision',
      scope: 'user',
      state: 'absent',
      errors: [{
        code: 'artifactCollision',
        message: 'safe collision',
        severity: 'blocking',
      }],
    });

    expect(buildTuiViewModel({
      status: status({ targets: [collision] }),
      pluginSummaries: summaries(['official', 'collision']),
    }).plugins[0]?.installedPlacements).toEqual([{
      platform: 'codex',
      state: 'blocked',
      supportedScopes: ['user'],
      reason: 'artifactCollision',
    }]);
  });

  it('keeps add for a mixed-platform collision and makes output conflict first when all platforms block', () => {
    const mixed = menuPlugin({
      supportedPlatforms: ['codex', 'claude'],
      installedPlacements: [
        { platform: 'codex', state: 'blocked', supportedScopes: ['user'], reason: 'artifactCollision' },
        { platform: 'claude', state: 'notInstalled', supportedScopes: ['user'] },
      ],
    });
    const blocked = menuPlugin({
      supportedPlatforms: ['codex', 'claude'],
      installedPlacements: [
        { platform: 'codex', state: 'blocked', supportedScopes: ['user'], reason: 'artifactCollision' },
        { platform: 'claude', state: 'blocked', supportedScopes: ['user'], reason: 'artifactCollision' },
      ],
    });

    expect(buildPluginPreviewActions(mixed).map((action) => action.id)).toEqual(['add', 'source']);
    expect(buildPluginPreviewActions(blocked).map((action) => action.id)).toEqual([
      'outputCollision', 'source', 'about',
    ]);
    expect(buildPlatformActions(blocked, 'codex').map((action) => action.id)).toEqual([
      'outputCollision', 'source', 'about',
    ]);
  });

  it.each(['present', 'partial'] as const)(
    'keeps a blocking collision on an owned %s placement and hides constructive actions',
    (state) => {
      const collision = target({
        pluginName: `collision-${state}`,
        scope: 'user',
        state,
        errors: [{
          code: 'artifactCollision',
          message: 'safe collision',
          severity: 'blocking',
        }],
      });
      const plugin = buildTuiViewModel({
        status: status({ targets: [collision] }),
        pluginSummaries: summaries(['official', `collision-${state}`]),
        targetRevisions: [{
          pluginId: collision.pluginId,
          platform: 'codex',
          scope: 'user',
          revision: {
            state: 'upgradeAvailable',
            availableVersion: '2.0.0',
            installedVersion: '1.0.0',
          },
        }],
      }).plugins[0]!;

      expect(plugin.installedPlacements[0]).toMatchObject({
        state: 'installed',
        scope: 'user',
        blockingReason: 'artifactCollision',
      });
      expect(buildPlatformActions(plugin, 'codex').map((action) => action.id)).toEqual([
        'outputCollision', 'remove', 'technical',
      ]);
      if (state === 'present') {
        const mixed = {
          ...plugin,
          supportedPlatforms: ['codex', 'claude'] as const,
          installedPlacements: [
            ...plugin.installedPlacements,
            { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user' as const] },
          ],
        };
        expect(buildPluginPreviewActions(mixed)[0]?.id).toBe('add');
      }
    },
  );

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

  it('shows refresh-and-sync only with reliable upgradeAvailable revision evidence', () => {
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
    }), 'codex').map((action) => action.id)).not.toContain('refreshAndSync');
    expect(buildPlatformActions(ready({ state: 'unknown', availableVersion: '2.0.0' }), 'codex')
      .map((action) => action.id)).not.toContain('refreshAndSync');
    expect(buildPlatformActions(ready({
      state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0',
    }), 'codex')).toContainEqual(expect.objectContaining({ id: 'refreshAndSync', availableVersion: '2.0.0' }));
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

  it('keeps capability blockers unavailable without turning a healthy source into a source problem', () => {
    const unsupported = target({
      pluginName: 'modern',
      scope: 'user',
      state: 'error',
      errors: [{
        code: 'awCapabilityUnsupported',
        message: 'safe capability failure',
        severity: 'blocking',
      }],
    });
    unsupported.recoveryActions = [{
      command: 'manual',
      description: '升级 AW CLI 到支持插件所需 capability 的版本后重试。',
    }];
    const view = buildTuiViewModel({
      status: status({ targets: [unsupported] }),
      pluginSummaries: [{
        ...summaries(['official', 'modern'])[0]!,
        missingCapabilities: ['aw.future-feature.v1'],
      }],
    });
    const plugin = view.plugins[0]!;

    expect(plugin).toMatchObject({
      aggregateStatus: 'unavailable',
      capabilityUnsupported: true,
      capabilityRecovery: '升级 AW CLI 到支持插件所需 capability 的版本后重试。',
      missingCapabilities: ['aw.future-feature.v1'],
    });
    expect(view.sourceTabs).toEqual([expect.objectContaining({ id: 'official', state: 'ready' })]);
    expect(view.issues.some((issue) => issue.category === 'sourceUnavailable')).toBe(false);
    for (const actions of [
      buildPluginPreviewActions(plugin),
      buildPluginDetailActions(plugin),
      buildPlatformActions(plugin, 'codex'),
    ]) {
      expect(actions.map((action) => action.id)).toEqual(expect.arrayContaining([
        'upgradeAwCli', 'capabilityTechnical',
      ]));
      expect(actions.map((action) => action.id)).not.toContain('sourceProblem');
      expect(actions.map((action) => action.id)).not.toContain('refreshSource');
    }
  });

  it('uses add for absent and sync for an incomplete Codex placement', () => {
    expect(buildPlatformActions(menuPlugin(), 'codex')[0]?.id).toBe('add');
    expect(buildPlatformActions(menuPlugin({
      aggregateStatus: 'needsAttention',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'project', health: 'incomplete',
        revision: { state: 'unknown', availableVersion: '2.0.0' },
      }],
    }), 'codex')[0]?.id).toBe('sync');
  });

  it('keeps pure-native scope overlap legal and consumes real scoped uninstall recovery for mixed conflict', () => {
    const pureNative = target({ scope: 'project', state: 'present' });
    pureNative.components.push(
      {
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
      },
      { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
      { kind: 'activation', key: 'user', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
      { kind: 'activation', key: 'project', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
    );
    const purePlugin = buildTuiViewModel({
      status: status({ targets: [pureNative] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).plugins[0]!;
    expect(purePlugin.installedPlacements).toEqual([
      expect.objectContaining({
        state: 'installed', desiredScopes: ['project', 'user'], actualState: 'ready',
      }),
    ]);
    expect(purePlugin.installedPlacements[0]?.state).not.toBe('scopeConflict');

    const pureSingleScope = buildTuiViewModel({
      status: status({ targets: [{
        ...pureNative,
        components: pureNative.components.map((component) => component.kind === 'intent'
          ? { ...component, metadata: { enabled: true, scopes: ['user'], relation: 'root' } }
          : component.kind === 'activation' && component.key === 'project'
            ? { ...component, state: 'disabled' }
            : component),
      }] }),
      pluginSummaries: [{
        ...summaries(['official', 'demo'])[0]!,
        supportedTargets: { codex: ['user', 'project'], claude: [] },
      }],
    }).plugins[0]!;
    expect(buildPlatformActions(pureSingleScope, 'codex')[0]).toEqual({
      id: 'addScope', platform: 'codex', scope: 'project',
    });

    const mixed = {
      ...pureNative,
      state: 'blocked' as const,
      components: [
        ...pureNative.components,
        { kind: 'extension' as const, key: 'aw', state: 'conflict', metadata: { kinds: ['instruction'] } },
      ],
      reasons: [{ code: 'codexExtensionScopeConflict', message: 'safe conflict', severity: 'blocking' as const }],
      recoveryActions: [
        {
          command: 'uninstall' as const,
          scope: 'user' as const,
          description: '运行 aw uninstall official/demo --platform codex --scope user，再运行 aw sync official/demo --platform codex --scope project。',
        },
        {
          command: 'uninstall' as const,
          scope: 'project' as const,
          description: '运行 aw uninstall official/demo --platform codex --scope project，再运行 aw sync official/demo --platform codex --scope user。',
        },
      ],
    };
    const mixedPlugin = buildTuiViewModel({
      status: status({ targets: [mixed] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).plugins[0]!;
    expect(mixedPlugin.installedPlacements[0]).toMatchObject({
      state: 'installed', health: 'error', actualState: 'blocked',
      extensions: { state: 'conflict' },
      recovery: expect.arrayContaining([
        expect.objectContaining({ command: 'uninstall', scope: 'user' }),
        expect.objectContaining({ command: 'uninstall', scope: 'project' }),
      ]),
    });
    expect(buildPlatformActions(mixedPlugin, 'codex').map((action) => action.id)).toEqual([
      'resolveScopeConflict', 'resolveScopeConflict', 'technical',
    ]);
    expect(buildPluginDetailActions(mixedPlugin).filter((action) =>
      action.id === 'resolveScopeConflict')).toHaveLength(2);
    expect(buildTuiViewModel({
      status: status({ targets: [mixed] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'scopeConflict',
        actions: expect.arrayContaining([
          expect.objectContaining({ id: 'keepProjectScope', pluginId: 'official/demo' }),
          expect.objectContaining({ id: 'keepUserScope', pluginId: 'official/demo' }),
        ]),
      }),
    ]));

    const foreign = buildTuiViewModel({
      status: status({ targets: [{
        ...pureNative,
        state: 'blocked',
        components: pureNative.components.map((component) => component.kind === 'sharedNative'
          ? { ...component, state: 'blocked', metadata: { shared: true, reason: 'foreign' } }
          : component),
        reasons: [{ code: 'codexSharedNativeForeign', message: 'safe foreign', severity: 'blocking' }],
        recoveryActions: [{
          command: 'sync',
          description: '先移除或重命名 foreign shared native；cleanup 会保留 foreign 内容。',
        }],
      }] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).plugins[0]!;
    expect(buildPlatformActions(foreign, 'codex').map((action) => action.id)).toEqual([
      'technical', 'back',
    ]);

    const needsSync = menuPlugin({
      aggregateStatus: 'needsAttention',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'project', health: 'incomplete',
        actualState: 'needsSync', desiredScopes: ['project'],
        revision: { state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0' },
      }],
    });
    expect(buildPlatformActions(needsSync, 'codex')[0]?.id).toBe('sync');
  });

  it('centralizes install target compatibility and recomputes it for the selected scope', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({
            platform: 'codex', scope: 'user', state: 'absent',
            errors: [{ code: 'artifactCollision', message: 'safe collision', severity: 'blocking' }],
          }),
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
      { platform: 'codex', compatible: false, disabled: '存在输出冲突；请先移除或迁移占用内容' },
      { platform: 'claude', compatible: false, disabled: '不支持所选位置' },
    ]);
    expect(controller.listInstallTargets('official/demo', 'project')).toEqual([
      { platform: 'codex', compatible: true },
      { platform: 'claude', compatible: true },
    ]);
  });

  it('keeps a typed per-platform placement draft and delegates scope legality to the preview plan', async () => {
    const previewDependencyPlacement = vi.fn(async (intent: Extract<import('../../src/tui/controller.js').OperationIntent, { kind: 'pluginWrite' }>): Promise<DependencyOperationPlan> => {
      const platforms = intent.platform === 'both' ? ['codex', 'claude'] as const : [intent.platform];
      const selected = (pluginId: string, platform: 'codex' | 'claude') =>
        intent.dependencyScopeOverrides?.find((entry) =>
          entry.pluginId === pluginId && entry.platform === platform)?.scope;
      const targets: DependencyOperationPlan['targets'] = platforms.flatMap((platform) => {
        const directOverride = selected('official/toolkit', platform);
        const directScope = directOverride ?? intent.scope;
        const transitiveScope = directScope === 'user' ? 'user' : intent.scope;
        return [
          {
            pluginId: 'official/toolkit', pluginName: 'Toolkit', platform,
            relation: 'dependency', depth: 1, requiredBy: ['official/demo'],
            rootScope: intent.scope, minimumScope: intent.scope, resolvedScope: directScope,
            allowedScopes: ['project', 'user'], assignmentSource: directOverride
              ? 'userOverride' : 'default', locked: intent.scope === 'user',
            ...(directOverride ? { lockReason: 'dependencyScopeOverride', locked: true } : {}),
            affectsOtherProjects: directScope === 'user', state: 'absent', action: 'install', order: 1,
          },
          {
            pluginId: 'official/base', pluginName: 'Base', platform,
            relation: 'dependency', depth: 2, requiredBy: ['official/toolkit'],
            rootScope: intent.scope, minimumScope: transitiveScope, resolvedScope: transitiveScope,
            allowedScopes: ['project', 'user'], assignmentSource: directScope === 'user'
              ? 'consumerPromotion' : 'default', locked: intent.scope === 'user',
            affectsOtherProjects: transitiveScope === 'user', state: 'absent', action: 'install', order: 0,
          },
          {
            pluginId: 'official/reused', pluginName: 'Reused', platform,
            relation: 'dependency', depth: 1, requiredBy: ['official/demo'],
            rootScope: intent.scope, minimumScope: intent.scope, resolvedScope: 'user',
            allowedScopes: ['project', 'user'], assignmentSource: 'existingWiderTarget',
            locked: intent.scope === 'user', affectsOtherProjects: true,
            state: 'present', action: 'keep', order: 2,
          },
          {
            pluginId: 'official/demo', pluginName: 'Demo', platform,
            relation: 'requested', depth: 0, requiredBy: [], rootScope: intent.scope,
            minimumScope: intent.scope, resolvedScope: intent.scope,
            allowedScopes: [intent.scope], assignmentSource: 'root', locked: true,
            affectsOtherProjects: intent.scope === 'user', state: 'absent', action: 'install', order: 3,
          },
        ];
      });
      return {
        dependencyPlanSchemaVersion: 2,
        dependencyPlanDigest: `sha256:${JSON.stringify(targets)}`,
        requestedPluginIds: ['official/demo'],
        resolvedPluginIds: ['official/base', 'official/toolkit', 'official/reused', 'official/demo'],
        dependencyEdges: platforms.flatMap((platform) => [
          { from: 'official/demo', to: 'official/toolkit', platform },
          { from: 'official/toolkit', to: 'official/base', platform },
          { from: 'official/demo', to: 'official/reused', platform },
        ]),
        scopeOverrides: intent.dependencyScopeOverrides ?? [],
        targets,
        claimRoots: [],
      };
    });
    const controller = new TuiController(dependencies({ previewDependencyPlacement }));
    await controller.load();
    controller.beginInstallFlow('official/demo', 'project');
    controller.setInstallPlatforms(['codex', 'claude']);

    await expect(controller.prepareInstallDependencyPlacement()).resolves.toBe(true);
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/reused', platform: 'codex', scope: 'user', explanation: '复用健康的所有项目安装' }),
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'codex', scope: 'project' }),
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'claude', scope: 'project' }),
    ]));

    await controller.setDependencyScope('official/toolkit', 'codex', 'user');
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
        assignmentSource: 'userOverride', locked: false,
      }),
      expect.objectContaining({ pluginId: 'official/base', platform: 'codex', scope: 'user', assignmentSource: 'consumerPromotion' }),
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'claude', scope: 'project' }),
    ]));

    await controller.resetDependencyScopes();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toEqual([]);
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/toolkit', platform: 'codex', scope: 'project', assignmentSource: 'default',
      }),
      expect.objectContaining({
        pluginId: 'official/reused', platform: 'codex', scope: 'user', assignmentSource: 'existingWiderTarget',
      }),
    ]));

    await controller.setDependencyScope('official/toolkit', 'codex', 'user');

    controller.setInstallRootScope('user');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    });

    controller.setInstallRootScope('project');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    });

    await controller.setDependencyScope('official/toolkit', 'codex', 'project');
    controller.setInstallRootScope('user');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/toolkit', platform: 'codex', scope: 'project',
    });

    controller.setInstallRootScope('project');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    await controller.setDependencyScope('official/toolkit', 'codex', 'user');

    controller.setInstallPlatforms(['claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toEqual([]);
    expect(controller.snapshot.installPlacementDraft?.targets.every((entry) =>
      entry.platform === 'claude')).toBe(true);

    controller.setInstallRootScope('user');
    controller.setInstallPlatforms(['claude']);
    await expect(controller.prepareInstallDependencyPlacement()).resolves.toBe(false);
    expect(controller.snapshot.installPlacementDraft?.targets.every((entry) => entry.locked)).toBe(true);
  });

  it('invalidates a late dependency placement preview when Back cancels it', async () => {
    const preview = deferred<DependencyOperationPlan | undefined>();
    const controller = new TuiController(dependencies({
      previewDependencyPlacement: vi.fn(() => preview.promise),
    }));
    await controller.load();
    controller.beginInstallFlow('official/demo', 'project');
    controller.setInstallPlatforms(['codex']);
    const preparation = controller.prepareInstallDependencyPlacement();
    await nextTurn();
    expect(controller.snapshot.installPlacementDraft?.state).toBe('loading');

    controller.back();
    preview.resolve(undefined);

    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    expect(controller.snapshot.installPlacementDraft).toMatchObject({
      state: 'selecting', canContinue: false, targets: [],
    });
  });

  it('projects manifest order, presentation groups, choices, and private values safely', () => {
    const fields = [
      { key: 'level', title: '级别', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: 'strict', sourceLayer: 'user' as const, storedValue: 'strict', storedSourceLayer: 'user' as const },
      { key: 'rules', title: '规则', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: '/Users/private/rules.json', sourceLayer: 'local' as const, storedValue: '/Users/private/rules.json', storedSourceLayer: 'local' as const },
      { key: 'token', title: '令牌', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: 'sk-private', sourceLayer: 'user' as const, storedValue: 'sk-private', storedSourceLayer: 'user' as const },
    ];
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema: {
        fields: {
          level: {
            type: 'string',
            title: '级别',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'fast', title: '快速', value: 'fast' },
                { id: 'strict', title: '严格', value: 'strict', recommended: true },
              ],
            },
          },
          rules: { type: 'string', title: '规则', sensitive: true, default: '/Users/private/default-rules.json' },
          token: { type: 'string', title: '令牌', sensitive: true, default: 'default-secret' },
        },
        presentation: {
          groups: [{ id: 'basic', title: '基本设置', fields: ['level'] }],
        },
      },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields },
    });

    expect(page.groups.map((group) => [group.title, group.fields.map((field) => field.key)])).toEqual([
      ['基本设置', ['level']],
      ['其他设置', ['rules', 'token']],
    ]);
    expect(page.groups[0]!.fields[0]).toEqual(expect.objectContaining({
      type: 'string',
      allowCustom: false,
      matchedPresetId: 'strict',
      choices: [
        { id: 'fast', title: '快速', value: 'fast' },
        { id: 'strict', title: '严格', value: 'strict', recommended: true },
      ],
      value: 'strict',
    }));
    expect(page.presets).toEqual([]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('sk-private');

    const fallback = buildConfigPage({
      pluginId: 'official/demo',
      schema: { fields: { level: { type: 'string' }, rules: { type: 'string' }, token: { type: 'string', sensitive: true } } },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields },
    });
    expect(fallback.groups).toHaveLength(1);
    expect(fallback.groups[0]!.title).toBe('插件设置');
    expect(fallback.groups[0]!.fields.map((field) => field.key)).toEqual(['level', 'rules', 'token']);

    const fieldAdvanced = buildConfigPage({
      pluginId: 'official/demo',
      schema: {
        fields: { level: { type: 'string' }, model: { type: 'string' } },
        presentation: {
          groups: [
            { id: 'general', title: '插件设置', fields: ['level'] },
            { id: 'advanced', title: '高级设置', fields: ['model'], advanced: true },
          ],
        },
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
      schema: { fields: { level: { type: 'string' } } },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields: [{
        ...layeredField,
        effectiveValue: 'strict',
        sourceLayer: 'user',
      }] },
      effectiveRead: { pluginName: 'demo', scope: 'effective', projectLayer: 'shared', fields: [layeredField] },
    });
    const effective = buildConfigPage({
      pluginId: 'official/demo',
      schema: { fields: { level: { type: 'string' } } },
      read: { pluginName: 'demo', scope: 'effective', projectLayer: 'shared', fields: [layeredField] },
    });
    expect(editable.groups[0]!.fields[0]).toMatchObject({
      displayValue: 'strict', value: 'strict', configured: true, sourceLabel: '本层已设置',
      effectiveDisplayValue: 'fast', effectiveValue: 'fast', effectiveSourceLabel: '当前项目',
    });
    expect(effective.groups[0]!.fields[0]).toMatchObject({
      displayValue: 'fast', value: 'fast', configured: true, sourceLabel: '当前项目',
    });
  });

  it('projects canonical object presets and a stable sensitive-child summary', () => {
    const definition = {
      fields: {
        credentials: {
          type: 'object' as const,
          choices: {
            allowCustom: true,
            presets: [{
              id: 'service',
              title: 'Service',
              value: { token: 'secret', region: 'west' },
            }],
          },
          properties: {
            token: { type: 'string' as const, sensitive: true, required: true },
            region: { type: 'string' as const, required: true },
          },
        },
      },
    };
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema: definition,
      read: {
        pluginName: 'demo',
        scope: 'effective',
        fields: [{
          key: 'credentials',
          title: 'credentials',
          kind: 'manifest',
          reserved: false,
          writable: true,
          valueState: 'configured',
          effectiveValue: { region: 'west', token: '[redacted]' },
          sourceLayer: 'user',
          value: { region: 'west', token: '[redacted]' },
          source: 'user',
          matchedPreset: 'service',
          valid: true,
          issues: [],
        }],
      },
      effectiveRawValues: { credentials: { region: 'west', token: 'secret' } },
    });
    const field = page.groups[0]!.fields[0]!;

    expect(field).toMatchObject({
      type: 'object',
      matchedPresetId: 'service',
      displayValue: '方案“Service” · 2 项（region、token）',
      draftValue: { region: 'west', token: 'secret' },
    });
    expect(field.displayValue).not.toContain('secret');
  });

  it('matches a raw inherited object preset for a project override and precomputes redacted unset changes', () => {
    const schema = {
      fields: {
        credentials: {
          type: 'object' as const,
          choices: {
            allowCustom: true,
            presets: [{
              id: 'inherited',
              title: 'Inherited service',
              value: { token: 'inherited-secret', region: 'west' },
            }],
          },
          properties: {
            token: { type: 'string' as const, sensitive: true },
            region: { type: 'string' as const },
          },
        },
      },
    };
    const entry = (scope: 'user' | 'project', value: { token: string; region: string }) => ({
      key: 'credentials',
      title: 'credentials',
      kind: 'manifest' as const,
      reserved: false,
      writable: true,
      valueState: 'configured' as const,
      effectiveValue: value,
      sourceLayer: scope,
      storedValue: value,
      storedSourceLayer: scope,
    });
    const userRaw = { token: 'inherited-secret', region: 'west' };
    const projectRaw = { token: 'current-secret', region: 'east' };
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema,
      read: {
        pluginName: 'demo',
        scope: 'project',
        fields: [entry('project', { token: '[redacted]', region: 'east' })],
      },
      effectiveRead: {
        pluginName: 'demo',
        scope: 'effective',
        fields: [entry('project', { token: '[redacted]', region: 'east' })],
      },
      layerReads: {
        user: {
          pluginName: 'demo',
          scope: 'user',
          fields: [entry('user', { token: '[redacted]', region: 'west' })],
        },
        project: {
          pluginName: 'demo',
          scope: 'project',
          fields: [entry('project', { token: '[redacted]', region: 'east' })],
        },
      },
      rawValues: { credentials: projectRaw },
      rawLayerValues: { user: { credentials: userRaw }, project: { credentials: projectRaw } },
      effectiveRawValues: { credentials: projectRaw },
    });
    const field = page.groups[0]!.fields[0]!;

    expect(field.fallbackDisplayValue).toBe('方案“Inherited service” · 2 项（region、token）');
    expect(field.fallbackObjectChanges).toEqual(expect.arrayContaining([
      { property: 'region', before: 'east', after: 'west' },
      { property: 'token', before: '已设置', after: '已设置', private: true },
    ]));
    expect(JSON.stringify(field.fallbackObjectChanges)).not.toContain('current-secret');
    expect(JSON.stringify(field.fallbackObjectChanges)).not.toContain('inherited-secret');
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
    })).resolves.toMatchObject({ pluginAction: 'uninstall' });
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
    expect(captureEvidence).toHaveBeenCalledTimes(3);
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
          source('official'),
          source('team', { primary: false }),
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
    missing.reasons = [{
      code: 'dependencyMissing',
      message: 'dependencyMissing: official/toolkit is absent at its recorded target.',
      severity: 'warning',
      dependencyPluginId: 'official/toolkit',
      dependencyPlatform: 'codex',
      dependencyScope: 'user',
      dependencyProject: null,
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

  it('does not synthesize a conflict or removal recovery for two ready pure-native scopes', () => {
    const pureNativeTarget = (scope: 'user' | 'project') => {
      const value = target({ scope, state: 'present' });
      value.components.push(
        {
          kind: 'intent', key: 'desired', state: 'desired',
          metadata: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
        },
        { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
        { kind: 'activation', key: 'user', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
        { kind: 'activation', key: 'project', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
      );
      return value;
    };
    const view = buildTuiViewModel({
      status: status({
        targets: [
          pureNativeTarget('user'),
          pureNativeTarget('project'),
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.plugins[0]?.installedPlacements).toEqual([
      expect.objectContaining({
        platform: 'codex', state: 'installed', health: 'ready',
        desiredScopes: ['project', 'user'], actualState: 'ready',
      }),
    ]);
    expect(view.issues.some((issue) => issue.category === 'scopeConflict')).toBe(false);
    expect(buildPluginDetailActions(view.plugins[0]!).some((action) =>
      action.id === 'resolveScopeConflict')).toBe(false);
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

    expect(view.plugins[0]?.installedPlacements).toEqual([expect.objectContaining({
      platform: 'codex',
      state: 'installed',
      scope: userState === 'present' ? 'user' : 'project',
      health: 'ready',
      revision: { state: 'unknown', availableVersion: '1.0.0' },
    })]);
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
      'status:nativeStateUnreadable',
      'status:legacyStateUnsupported',
      'diagnostic:official/demo:codex:user',
    ]);
    expect(JSON.stringify(view.issues)).not.toContain('/Users/private');
    expect(JSON.stringify(view.issues)).not.toContain('private-token');
  });

  it('classifies issue routes from typed status and config evidence without message matching', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ pluginName: 'partial', scope: 'user', state: 'partial' }),
          target({
            pluginName: 'collision',
            scope: 'user',
            state: 'absent',
            errors: [{
              code: 'artifactCollision',
              message: 'safe collision',
              severity: 'blocking',
              collision: {
                reason: 'unownedContent',
                artifactKind: 'skill-directory',
                artifactKey: 'review',
                expectedOwner: 'official/collision',
              },
            }],
          }),
          target({
            pluginName: 'missing', scope: 'user', state: 'error', errorCode: 'sourceMissing',
            recoveryActions: [
              { command: 'sync', description: '来源恢复后同步 desired intent。' },
              { command: 'cleanup', description: '清理可证明属于 AW 的输出。' },
            ],
          }),
          target({ pluginName: 'changed', scope: 'user', state: 'error', errorCode: 'sourceChanged' }),
          target({ pluginName: 'offline', scope: 'user', state: 'error', errorCode: 'catalogSourceUnavailable' }),
          target({ pluginName: 'offline-two', scope: 'project', state: 'error', errorCode: 'catalogSourceUnavailable' }),
        ],
        errors: [{ code: 'legacyStateUnsupported', message: 'arbitrary text that does not name legacy state', severity: 'blocking' }],
      }),
      pluginSummaries: [{
        pluginName: 'required',
        pluginId: 'official/required',
        description: 'required config fixture',
        configIssues: [{ scope: 'user', type: 'missing-required', key: 'rules', title: '规则文件', source: 'missing' }],
      }],
      sourceHealth: new Map([['official', {
        sourceId: 'official',
        state: 'unavailable',
        issueId: 'source:official:unavailable',
      }]]),
    });

    expect(Object.fromEntries(view.issues.map((issue) => [issue.issueId, issue.category]))).toMatchObject({
      'incompleteInstallation:official/partial:codex:user': 'incompleteInstallation',
      'target:official/collision:codex:user:absent': 'artifactCollision',
      'target:official/missing:codex:user:blocked': 'sourceMissing',
      'target:official/changed:codex:user:blocked': 'sourceIdentityChanged',
      'config:official/required:required': 'requiredConfigMissing',
      'status:legacyStateUnsupported': 'legacyState',
      'source:official:unavailable': 'sourceUnavailable',
    });
    expect(JSON.stringify(view.issues)).not.toContain('arbitrary text');
    expect(view.issues.find((issue) => issue.category === 'incompleteInstallation')?.actions
      .map((action) => action.id)).toEqual(['sync', 'viewTechnical']);
    const collision = view.issues.find((issue) => issue.category === 'artifactCollision');
    expect(collision).toMatchObject({
      title: expect.stringContaining('输出冲突'),
      explanation: expect.stringContaining('不会覆盖或删除'),
      actions: [{ id: 'viewTechnical' }, { id: 'retryLater' }],
      technicalDetails: [{ code: 'artifactCollision', message: '目标包含没有 AW owner 标记的内容。' }],
    });
    expect(view.issues.find((issue) => issue.category === 'sourceUnavailable')?.actions.map((action) => action.id))
      .toEqual(['editSource', 'refreshSource', 'viewTechnical']);
    expect(view.issues.filter((issue) => issue.sourceId === 'official'
      && issue.category === 'sourceUnavailable')).toHaveLength(1);
    expect(view.issues.find((issue) => issue.category === 'sourceUnavailable')?.impact).toContain(
      '2 个安装位置受此来源根问题影响。',
    );
    expect(view.issues.find((issue) => issue.category === 'sourceMissing')?.actions.map((action) => action.id))
      .toEqual(['cleanup', 'reAddSource', 'viewTechnical']);
    expect(view.issues.find((issue) => issue.category === 'sourceIdentityChanged')?.actions.map((action) => action.id))
      .toEqual(['viewSourceChange', 'viewTechnical']);
  });

  it('selects one stable primary reason and orders issue root groups', () => {
    const consumer = target({
      pluginName: 'consumer', scope: 'project', state: 'partial', errors: [{
        code: 'dependencyNotReady',
        message: 'safe dependency symptom',
        dependencyPluginId: 'official/leaf',
        rootIssueId: 'artifactCollision:official/leaf:codex:user:agent:leaf-role',
        rootIssueCode: 'artifactCollision',
        severity: 'warning',
      }],
    });
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ pluginName: 'removed', scope: 'user', state: 'error', errorCode: 'sourceMissing' }),
          consumer,
          target({ sourceId: 'team', pluginName: 'graph', scope: 'user', state: 'absent' }),
          target({
            pluginName: 'dependency', scope: 'user', state: 'partial', errors: [{
              code: 'dependencyMissing',
              message: 'safe dependency evidence',
              dependencyPluginId: 'official/leaf',
              severity: 'warning',
            }],
          }),
          target({ pluginName: 'incomplete', scope: 'user', state: 'partial' }),
        ],
      }),
      pluginSummaries: [
        ...summaries(
          ['official', 'removed'],
          ['official', 'consumer'],
          ['official', 'leaf'],
          ['team', 'graph'],
          ['official', 'dependency'],
          ['official', 'incomplete'],
          ['official', 'available'],
        ),
        {
          pluginName: 'configured',
          pluginId: 'team/configured',
          description: 'config fixture',
          configIssues: [{
            scope: 'user', type: 'invalid-config', key: 'mode', title: '模式', source: 'user',
          }],
        },
        {
          pluginName: 'source-configured',
          pluginId: 'official/source-configured',
          description: 'source config fixture',
          configIssues: [{
            scope: 'user', type: 'invalid-config', key: 'mode', title: '模式', source: 'user',
          }],
        },
      ],
      sourceHealth: new Map([['official', {
        sourceId: 'official', state: 'unavailable', issueId: 'source:official:unavailable',
      }]]),
      dependencyOverviews: [{
        pluginId: 'team/graph',
        summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 0, issueCount: 1 },
        dependencies: [],
        dependents: [],
        blockers: [{
          code: 'dependencyGraphInvalid',
          title: '依赖关系无效',
          explanation: '依赖关系形成环。',
        }],
      }],
    });

    expect(view.issues.map((issue) => issue.group)).toEqual([
      'sourceRemoved',
      'artifactCollision',
      'sourceUnavailable',
      'dependency',
      'dependency',
      'config',
      'config',
      'installation',
    ]);
    expect(view.issues.filter((issue) =>
      issue.issueId === 'artifactCollision:official/leaf:codex:user:agent:leaf-role')).toHaveLength(1);
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/consumer')?.primaryAttention)
      .toEqual({
        severity: 'error',
        code: 'artifactCollision',
        message: '目标位置已有不属于当前插件的内容。AW 不会覆盖或删除这些内容。',
      });
    expect(view.plugins.find((plugin) => plugin.pluginId === 'team/configured')?.primaryAttention?.code)
      .toBe('invalidConfig');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/available')?.primaryAttention)
      .toMatchObject({ severity: 'error', code: 'sourceUnavailable' });
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/incomplete')?.primaryAttention?.code)
      .toBe('sourceUnavailable');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/dependency')?.primaryAttention?.code)
      .toBe('sourceUnavailable');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'team/graph')?.primaryAttention?.code)
      .toBe('dependencyGraphInvalid');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/source-configured')?.primaryAttention?.code)
      .toBe('sourceUnavailable');
  });

  it('keeps a direct root ahead of consumers and makes root aggregation order-independent', () => {
    const rootIssueId = 'artifactCollision:official/leaf:codex:user:agent:leaf-role';
    const direct = target({
      pluginName: 'leaf', scope: 'user', state: 'absent', errors: [{
        code: 'artifactCollision',
        message: 'safe direct collision',
        severity: 'blocking',
        rootIssueId,
        rootIssueCode: 'artifactCollision',
      }],
    });
    const consumer = (pluginName: string, scope: 'user' | 'project') => target({
      pluginName, scope, state: 'partial', errors: [{
        code: 'dependencyNotReady',
        message: 'safe dependency symptom',
        severity: 'warning',
        dependencyPluginId: 'official/leaf',
        rootIssueId,
        rootIssueCode: 'artifactCollision',
      }],
    });
    const targets = [consumer('consumer-b', 'project'), direct, consumer('consumer-a', 'user')];
    const project = (orderedTargets: StatusV7Payload['targets']) => buildTuiViewModel({
      status: status({ targets: orderedTargets }),
      pluginSummaries: summaries(
        ['official', 'leaf'],
        ['official', 'consumer-a'],
        ['official', 'consumer-b'],
      ),
    }).issues.find((issue) => issue.issueId === rootIssueId);

    expect(project(targets)).toMatchObject({
      pluginId: 'official/leaf',
      relationship: 'direct',
      rootEntity: { pluginId: 'official/leaf', platform: 'codex', scope: 'user' },
      affectedTargets: [
        { pluginId: 'official/consumer-a', platform: 'codex', scope: 'user', relationship: 'consumer' },
        { pluginId: 'official/consumer-b', platform: 'codex', scope: 'project', relationship: 'consumer' },
        { pluginId: 'official/leaf', platform: 'codex', scope: 'user', relationship: 'direct' },
      ],
    });
    expect(project([...targets].reverse())).toEqual(project(targets));
    expect(project(targets.filter((entry) => entry.pluginId !== 'official/leaf'))).toMatchObject({
      pluginId: 'official/leaf',
      relationship: 'consumer',
      rootEntity: { pluginId: 'official/leaf', platform: 'codex', scope: 'user' },
    });
  });

  it.each([
    {
      state: 'partial' as const,
      directErrors: [],
      rootIssueId: 'incompleteInstallation:official/leaf:codex:user',
      rootIssueCode: 'incompleteInstallation',
      category: 'incompleteInstallation',
    },
    {
      state: 'error' as const,
      directErrors: [{
        code: 'componentInspectionFailed',
        message: 'safe direct diagnostic',
        severity: 'blocking' as const,
      }],
      rootIssueId: 'diagnostic:official/leaf:codex:user',
      rootIssueCode: 'diagnostic',
      category: 'diagnostic',
    },
  ])('uses dependency evidence as the canonical key for a direct $state root', (fixture) => {
    const direct = target({
      pluginName: 'leaf', scope: 'user', state: fixture.state, errors: fixture.directErrors,
    });
    const consumer = (pluginName: string, scope: 'user' | 'project') => target({
      pluginName, scope, state: 'present', errors: [{
        code: 'dependencyNotReady',
        message: 'safe dependency symptom',
        severity: 'warning',
        dependencyPluginId: 'official/leaf',
        rootIssueId: fixture.rootIssueId,
        rootIssueCode: fixture.rootIssueCode,
      }],
    });
    const targets = [consumer('consumer-b', 'project'), direct, consumer('consumer-a', 'user')];
    const project = (orderedTargets: StatusV7Payload['targets']) => buildTuiViewModel({
      status: status({ targets: orderedTargets }),
      pluginSummaries: summaries(
        ['official', 'leaf'],
        ['official', 'consumer-a'],
        ['official', 'consumer-b'],
      ),
    }).issues.find((issue) => issue.issueId === fixture.rootIssueId);

    expect(project(targets)).toMatchObject({
      pluginId: 'official/leaf',
      category: fixture.category,
      relationship: 'direct',
      rootEntity: { pluginId: 'official/leaf', platform: 'codex', scope: 'user' },
      affectedTargets: [
        { pluginId: 'official/consumer-a', platform: 'codex', scope: 'user', relationship: 'consumer' },
        { pluginId: 'official/consumer-b', platform: 'codex', scope: 'project', relationship: 'consumer' },
        { pluginId: 'official/leaf', platform: 'codex', scope: 'user', relationship: 'direct' },
      ],
    });
    expect(project([...targets].reverse())).toEqual(project(targets));
  });

  it('selects an unavailable source before config and incomplete symptoms', () => {
    const view = buildTuiViewModel({
      status: status({ targets: [target({ pluginName: 'offline', scope: 'user', state: 'partial' })] }),
      pluginSummaries: [{
        pluginName: 'offline',
        pluginId: 'official/offline',
        description: 'offline fixture',
        configIssues: [{ scope: 'user', type: 'invalid-config', key: 'mode', title: '模式', source: 'user' }],
      }],
      sourceHealth: new Map([['official', {
        sourceId: 'official', state: 'unavailable', issueId: 'source:official:unavailable',
      }]]),
    });

    expect(view.plugins[0]?.primaryAttention).toMatchObject({
      severity: 'error', code: 'sourceUnavailable',
    });
  });

  it('keeps bundleUnavailable as a plugin target issue beside an unavailable source root', () => {
    const unavailableTarget = target({
      pluginName: 'offline', scope: 'user', state: 'error', errorCode: 'catalogSourceUnavailable',
    });
    unavailableTarget.reasons.push({ code: 'bundleUnavailable', message: 'bundle missing' });
    unavailableTarget.recoveryActions = [
      { command: 'sync', description: '来源恢复后同步 desired intent。' },
      { command: 'cleanup', description: '清理可证明属于 AW 的输出。' },
    ];
    const view = buildTuiViewModel({
      status: status({ targets: [unavailableTarget] }),
      pluginSummaries: [],
      sourceHealth: new Map([['official', {
        sourceId: 'official', state: 'unavailable', issueId: 'source:official:unavailable',
      }]]),
    });

    expect(view.issues).toHaveLength(2);
    expect(view.home.issueCount).toBe(2);
    expect(view.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: 'source:official:unavailable', category: 'sourceUnavailable',
        impact: expect.arrayContaining(['1 个安装位置受此来源根问题影响。']),
      }),
      expect.objectContaining({
        issueId: expect.stringContaining('bundleUnavailable'),
        pluginId: 'official/offline', category: 'sourceUnavailable',
        rootCode: 'bundleUnavailable', mergeEligible: false,
        title: expect.stringContaining('当前 Catalog 不再包含此插件'),
        explanation: '当前 Catalog 不再包含此插件，但仍发现 AW 管理的已安装内容。',
        actions: expect.arrayContaining([
          expect.objectContaining({ id: 'cleanup', writeAction: 'cleanup', label: '清理 AW-owned 内容' }),
        ]),
      }),
    ]));
    expect(view.issues.find((issue) => issue.rootCode === 'bundleUnavailable')?.impact)
      .toContain('可以清理可信的 AW 现场；这不表示来源整体可用。');
    expect(view.plugins).toContainEqual(expect.objectContaining({
      pluginId: 'official/offline',
      aggregateStatus: 'unavailable',
      installedPlacements: [expect.objectContaining({ state: 'installed', health: 'error' })],
    }));
  });

  it('keeps config issue type and layer while isolating a safe per-plugin read diagnostic', () => {
    const view = buildTuiViewModel({
      status: status(),
      pluginSummaries: [
        {
          pluginName: 'invalid', pluginId: 'official/invalid', description: 'invalid',
          configIssues: [{ scope: 'project', type: 'invalid-config', key: 'mode', title: '模式', source: 'project' }],
        },
        {
          pluginName: 'unreadable', pluginId: 'official/unreadable', description: 'unreadable',
          configDiagnostic: { scope: 'user', code: 'configReadFailed', message: '插件设置当前不可读。未读取或显示设置值。' },
        },
      ],
    });

    expect(view.issues.find((issue) => issue.pluginId === 'official/invalid')).toMatchObject({
      title: 'invalid · 设置值无效',
      configLayer: { scope: 'project' },
      requiredFields: [{ key: 'mode', title: '模式', type: 'invalid-config', source: 'project', scope: 'project' }],
      diagnostic: {
        technical: { code: 'invalid-config', stage: 'validate-config' },
      },
    });
    expect(view.issues.find((issue) => issue.pluginId === 'official/invalid')?.diagnostic.technical?.checks)
      .toContain('完成或修正列出的设置字段。');
    expect(view.issues.find((issue) => issue.pluginId === 'official/unreadable')).toMatchObject({
      category: 'diagnostic',
      technicalDetails: [{ code: 'configReadFailed', message: '设置读取报告了这个安全错误代码。' }],
      diagnostic: {
        technical: { code: 'configReadFailed', stage: 'read-config' },
      },
    });
  });
});

describe('TUI Catalog freshness session overlay', () => {
  it('reaches ready before a slow automatic freshness probe completes', async () => {
    const pending = deferred<{ sourceId: string; state: 'current' }>();
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn(() => pending.promise),
    }));

    await controller.load();

    expect(controller.snapshot.phase).toBe('ready');
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
    expect(controller.getPluginOverview('official/demo')).toBeDefined();
    pending.resolve({ sourceId: 'official', state: 'current' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('current');
    controller.dispose();
  });

  it('keeps a healthy Active source available when its background check fails', async () => {
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'catalogSourceResolutionFailed' });
      }),
    }));

    await controller.load();
    await nextTurn();

    expect(controller.getCatalogFreshness('official')).toMatchObject({
      state: 'checkFailed', errorCode: 'catalogSourceResolutionFailed',
    });
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
    expect(controller.getPluginOverview('official/demo')?.aggregateStatus).not.toBe('unavailable');
    expect(controller.listSources()).toContainEqual(expect.objectContaining({
      id: 'official', state: 'ready',
    }));
    expect(controller.snapshot.viewModel?.home).toMatchObject({
      issueCount: 0,
      unavailableSourceCount: 0,
      catalogRecoveryCount: 0,
    });
    controller.dispose();
  });

  it('automatically checks only enabled sources but keeps manual checks available', async () => {
    const sources = [source('official', { primary: true }), source('team', { primary: false })];
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId,
      state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources }),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: [
          sourceDetail('official', { primary: true }),
          sourceDetail('team', { primary: false, autoCheck: false }),
        ],
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness.mock.calls.map(([sourceId]) => sourceId)).toEqual(['official']);
    expect(controller.getSourceOverview('team').detail?.autoCheck).toBe(false);

    await controller.recheckCatalogSource('team');
    expect(probeCatalogFreshness.mock.calls.map(([sourceId]) => sourceId)).toEqual(['official', 'team']);
    expect(probeCatalogFreshness.mock.calls.at(-1)?.[1]).toEqual({ fullValidation: true });
    controller.dispose();
  });

  it('aborts and invalidates a running automatic check when autoCheck is disabled', async () => {
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    let aborted = false;
    const enabled = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official')],
    };
    const disabled = {
      ...enabled,
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(enabled)
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce(enabled);
    const probeCatalogFreshness = vi.fn((_sourceId, _options, signal: AbortSignal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return pending.promise;
    });
    const controller = new TuiController(dependencies({ loadStatus, probeCatalogFreshness }));

    await controller.load();
    await nextTurn();
    await controller.reloadCatalog({ sourceId: 'official' });
    expect(aborted).toBe(true);
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');
    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');

    await controller.reloadCatalog({ sourceId: 'official' });
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('queues a newly enabled source when it has not been attempted in this session', async () => {
    const initial = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const enabled = {
      ...initial,
      sourceDetails: [sourceDetail('official')],
    };
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId, state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(enabled),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness).not.toHaveBeenCalled();
    await controller.reloadCatalog({ sourceId: 'official' });
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('marks an exact commit source fixed without calling its automatic provider', async () => {
    const probeCatalogFreshness = vi.fn();
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: [sourceDetail('official', { explicitRef: 'a'.repeat(40) })],
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness).not.toHaveBeenCalled();
    expect(controller.getCatalogFreshness('official')?.state).toBe('fixed');
    controller.dispose();
  });

  it.each([
    ['disabled', sourceDetail('official', { autoCheck: false })],
    ['fixed', sourceDetail('official', { explicitRef: 'a'.repeat(40) })],
  ])('keeps a manual probe running across a same-descriptor reload for a %s source', async (
    _label,
    detail,
  ) => {
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    let aborted = false;
    const loaded = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [detail],
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      probeCatalogFreshness: vi.fn((_sourceId, _options, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return pending.promise;
      }),
    }));

    await controller.load();
    const manual = controller.recheckCatalogSource('official');
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('checking');
    await controller.reloadCatalog({ sourceId: 'official' });
    expect(aborted).toBe(false);
    expect(controller.getCatalogFreshness('official')?.state).toBe('checking');

    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await manual;
    expect(controller.getCatalogFreshness('official')?.state).toBe('updateAvailable');
    controller.dispose();
  });

  it('marks a 64-character commit without Active fixed and never calls its automatic provider', async () => {
    const probeCatalogFreshness = vi.fn();
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: [sourceDetail('official', { explicitRef: 'b'.repeat(64) })],
        catalogGenerations: [{
          sourceId: 'official', sourceType: 'git', state: 'activationRequired',
        }],
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(controller.getCatalogGeneration('official')?.active).toBeUndefined();
    expect(controller.getCatalogFreshness('official')?.state).toBe('fixed');
    expect(probeCatalogFreshness).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('applies a confirmed autoCheck disable before the final status reload completes', async () => {
    const finalLoad = deferred<TuiStatusLoadResult>();
    const automatic = deferred<{ sourceId: string; state: 'current' }>();
    let aborted = false;
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const enabled = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official')],
    };
    const disabled = {
      ...enabled,
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValueOnce(enabled).mockImplementationOnce(() => finalLoad.promise),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
      probeCatalogFreshness: vi.fn((_sourceId, _options, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return automatic.promise;
      }),
    }));
    await controller.load();
    await nextTurn();
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation', action: 'update', sourceId: 'official',
      update: { autoCheck: false },
    });

    const executing = controller.executeOperation(review.reviewToken);
    await nextTurn(2);
    expect(aborted).toBe(true);
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');
    finalLoad.resolve(disabled);
    await expect(executing).resolves.toMatchObject({ state: 'succeeded' });
    automatic.resolve({ sourceId: 'official', state: 'current' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');
    controller.dispose();
  });

  it('queues a confirmed autoCheck enable before a delayed final reload fails', async () => {
    const finalLoad = deferred<TuiStatusLoadResult>();
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const disabled = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId, state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValueOnce(disabled).mockImplementationOnce(() => finalLoad.promise),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
      probeCatalogFreshness,
    }));
    await controller.load();
    await nextTurn();
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation', action: 'update', sourceId: 'official',
      update: { autoCheck: true },
    });

    const executing = controller.executeOperation(review.reviewToken);
    await nextTurn(2);
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    finalLoad.reject(new Error('final load failed'));
    await expect(executing).resolves.toMatchObject({
      state: 'blocked', code: 'tuiStateReloadFailed', writeMayHaveCompleted: true,
    });
    expect(controller.getCatalogFreshness('official')?.state).toBe('current');
    controller.dispose();
  });

  it('starts the primary probe first and limits other source probes to two', async () => {
    const sources = [
      source('official', { primary: true }),
      source('one', { primary: false }),
      source('two', { primary: false }),
      source('three', { primary: false }),
      source('four', { primary: false }),
    ];
    const gates = new Map(sources.map((entry) => [entry.id, deferred<void>()]));
    const started: string[] = [];
    let activeOther = 0;
    let maximumOther = 0;
    const probeCatalogFreshness: TuiControllerDependencies['probeCatalogFreshness'] = vi.fn(
      async (sourceId) => {
        started.push(sourceId);
        if (sourceId !== 'official') {
          activeOther += 1;
          maximumOther = Math.max(maximumOther, activeOther);
        }
        await gates.get(sourceId)!.promise;
        if (sourceId !== 'official') activeOther -= 1;
        return { sourceId, state: 'current' };
      },
    );
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources }),
        pluginSummaries: summaries(['official', 'demo']),
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(started[0]).toBe('official');
    expect(started.slice(1).sort()).toEqual(['one', 'two']);
    expect(maximumOther).toBe(2);
    gates.get('one')!.resolve();
    gates.get('two')!.resolve();
    await nextTurn();
    expect(started).toEqual(expect.arrayContaining(['three', 'four']));
    for (const gate of gates.values()) gate.resolve();
    controller.dispose();
  });

  it('does not repeat all probes on reload and explicitly rechecks only one source', async () => {
    const sources = [source('official', { primary: true }), source('team', { primary: false })];
    const probeCatalogFreshness = vi.fn(async (sourceId: string, options: { fullValidation: boolean }) => ({
      sourceId,
      state: 'current' as const,
      ...(options.fullValidation ? { activeVersion: '1.0.0' } : {}),
    }));
    const loadStatus = vi.fn().mockResolvedValue({
      payload: status({ sources }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const controller = new TuiController(dependencies({ loadStatus, probeCatalogFreshness }));
    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(2);

    await controller.reloadCatalog({ sourceId: 'official' });
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(2);

    await controller.recheckCatalogSource('team');
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(3);
    expect(probeCatalogFreshness.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'team', { fullValidation: true },
    ]);
    controller.dispose();
  });

  it('aborts probes on dispose and ignores their late result', async () => {
    let aborted = false;
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn((_sourceId, _options, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return pending.promise;
      }),
    }));
    await controller.load();
    await nextTurn();

    controller.dispose();
    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await nextTurn();

    expect(aborted).toBe(true);
    expect(controller.snapshot.phase).toBe('disposed');
    expect(controller.getCatalogFreshness('official')?.state).toBe('checking');
  });

  it('keeps a completed probe overlay but blocks Active switching while a source draft exists', async () => {
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn(() => pending.promise),
    }));
    await controller.load();
    await nextTurn();
    controller.setExternalDraftState('sourceDraft');

    expect(() => controller.startReviewPreparation({
      kind: 'catalogGeneration', action: 'update', sourceId: 'official',
    })).toThrowError(expect.objectContaining({ code: 'catalogActivationBlocked' }));
    await expect(controller.reloadCatalog({ sourceId: 'official' })).resolves.toBe(false);

    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('updateAvailable');
    controller.dispose();
  });
});

describe('TUI v4 Review safety', () => {
  it('shows refresh fallback in the ordinary Review and uses the refreshed plugin version', async () => {
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        source: { ...baseEvidence.source!, pluginVersion: '3.0.0' },
        preparationWarnings: ['catalogSourceRefreshFailed: official: safe failure'],
      }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    expect(review.subject.version).toBe('3.0.0');
    expect(review.changes).toContainEqual({
      kind: 'warning',
      group: 'portableWarnings',
      title: '来源刷新失败；本次使用旧 Active',
      description: '同步可以继续。再次刷新并同步时会重试来源刷新。',
    });
  });

  it.each([
    ['install', 'add', 'add'],
    ['refreshAndSync', 'keep', 'change'],
    ['reinstall', 'keep', 'change'],
    ['uninstall', 'remove', 'remove'],
    ['cleanup', 'keep', 'remove'],
    ['sync', 'keep', 'change'],
  ] as const)('keeps the no-plan %s user-visible target change consistent through execution', async (
    action,
    _intentKind,
    targetKind,
  ) => {
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const controller = new TuiController(dependencies({ executeIntent }));
    await controller.load();
    const intent = {
      kind: 'pluginWrite' as const,
      action,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
    };

    const review = await controller.buildOperationReview(intent);

    expect(review.changes).toContainEqual(expect.objectContaining({
      kind: targetKind,
      group: 'requested',
      pluginId: 'official/demo',
      relation: 'requested',
      title: 'Codex · 当前项目',
    }));

    await controller.executeOperation(review.reviewToken);
    expect(executeIntent).toHaveBeenCalledWith(intent, baseEvidence);
  });

  it.each([
    ['install', 'keep', 'add'],
    ['uninstall', 'keep', 'remove'],
    ['refreshAndSync', 'move', 'keep'],
    ['reinstall', 'move', 'keep'],
    ['sync', 'move', 'keep'],
  ] as const)('uses command desired intent for %s when the planned target action is %s', async (
    action,
    targetAction,
    expectedKind,
  ) => {
    const dependencyPlan: DependencyOperationPlan = {
      dependencyPlanSchemaVersion: 2,
      dependencyPlanDigest: `sha256:${action}`,
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/dependency', 'official/root'],
      dependencyEdges: [{ from: 'official/root', to: 'official/dependency', platform: 'codex' }],
      scopeOverrides: [],
      claimRoots: [],
      targets: [{
        pluginId: 'official/dependency', pluginName: 'Dependency', platform: 'codex',
        relation: 'dependency', depth: 1, requiredBy: ['official/root'], rootScope: 'project',
        minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project', 'user'],
        assignmentSource: 'userOverride', locked: false, affectsOtherProjects: false,
        state: 'present', action: targetAction, order: 0,
      }, {
        pluginId: 'official/root', pluginName: 'Root', platform: 'codex',
        relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
        minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
        assignmentSource: 'root', locked: true, affectsOtherProjects: false,
        state: 'present', action: targetAction, order: 1,
      }],
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, dependencyPlan }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action, pluginId: 'official/root', platform: 'codex', scope: 'project',
    });
    const intentRows = review.changes.filter((change) =>
      change.group === 'requested' || change.group === 'dependencies');

    expect(intentRows.length).toBeGreaterThan(0);
    expect(intentRows.every((change) => change.kind === expectedKind)).toBe(true);
  });

  it('shows an exact existing shared native as reuse without an ownership ledger', async () => {
    const codexReconcilePlans = [{
      sharedNativeActions: [{
        pluginId: 'official/demo', codexPluginId: 'demo@aw-official', action: 'reuse',
        desiredVersion: '1.0.0', affectsOtherScopes: false,
      }],
      activationActions: { user: [], project: [] },
      extensionWrites: [],
      extensionRemovals: [],
      review: { requiresConfirmation: false, sharedImpact: { pluginIds: [] } },
    }] as unknown as NonNullable<OperationEvidence['codexReconcilePlans']>;
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, codexReconcilePlans }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    expect(review.changes).toContainEqual(expect.objectContaining({
      group: 'sharedCodexNative',
      kind: 'keep',
      description: '复用已存在的精确 shared native；不建立 ownership ledger',
    }));
    expect(JSON.stringify(review.changes)).not.toContain('claim');
  });

  it('shows the frozen offline cleanup actions and exact targets in Review', async () => {
    const offlineCleanup: NonNullable<OperationEvidence['offlineCleanup']> = {
      reason: 'sourceMissing',
      pluginId: 'official/demo',
      pluginName: 'demo',
      sourceId: 'official',
      sourceIdentity: 'identity:official',
      platform: 'codex',
      scope: 'project',
      plan: {
        schemaVersion: 1,
        pluginId: 'official/demo',
        sourceIdentity: 'identity:official',
        platform: 'codex',
        scope: 'project',
        actions: [
          { action: 'removeOwnedOutput', kind: 'namespacedOwner', target: '/workspace/.codex/owners/demo.json' },
          { action: 'removeNativeRegistration', kind: 'namespacedMarketplace', target: 'demo@aw-official' },
        ],
      },
      planDigest: 'sha256:offline-plan',
      targetFingerprint: 'sha256:offline-plan',
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, offlineCleanup }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/demo',
      platform: 'codex', scope: 'project',
    });

    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'remove', title: '移除 AW-owned 输出',
        description: '/workspace/.codex/owners/demo.json',
      }),
      expect.objectContaining({
        kind: 'remove', title: '移除原生插件注册', description: 'demo@aw-official',
      }),
    ]));
    expect(review.technicalDetails).toEqual(expect.arrayContaining([
      '离线清理计划：2 个动作 · offline-',
      '离线清理动作：removeOwnedOutput · /workspace/.codex/owners/demo.json',
      '离线清理动作：removeNativeRegistration · demo@aw-official',
    ]));
  });

  it('shows managed Codex acquisition without making manager selection stale evidence', async () => {
    const evidence: OperationEvidence = {
      ...baseEvidence,
      codexManager: {
        state: 'requires-install',
        packageName: '@openai/codex',
        version: '0.151.0',
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    expect(review.changes).toContainEqual(expect.objectContaining({
      kind: 'add',
      group: 'runtime',
      title: '获取 Codex runtime',
      description: '@openai/codex@0.151.0 · AW-managed 缓存',
    }));
    expect(review.equivalentCommand).toContain('--allow-managed-codex-install');
    expect(operationEvidenceFingerprint(evidence)).toBe(operationEvidenceFingerprint({
      ...baseEvidence,
      codexManager: { state: 'system', packageName: '@openai/codex', version: '0.200.0' },
    }));
  });

  it.each([
    {
      label: 'managed acquisition failure',
      managerState: 'requires-install' as const,
      errorCode: 'managedCodexUnavailable' as const,
      recovery: '升级 AW',
    },
    {
      label: 'cached Review followed by a missing runtime',
      managerState: 'cached' as const,
      errorCode: 'managedCodexAuthorizationRequired' as const,
      recovery: '--allow-managed-codex-install',
    },
  ])('reports $label as a Codex pre-write blocker', async ({ managerState, errorCode, recovery }) => {
    const evidence: OperationEvidence = {
      ...baseEvidence,
      codexManager: {
        state: managerState,
        packageName: '@openai/codex',
        version: '0.151.0',
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: {
            pluginId: 'official/demo',
            platform: 'codex',
            scope: 'user',
          },
          action: 'install',
          state: 'failed',
          errorCode,
        }],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked',
      code: errorCode,
      message: expect.stringContaining('插件写入前停止'),
      summary: {
        code: 'operationFailed',
        targets: [expect.objectContaining({ errorCode })],
      },
    });
    expect(result.message).toContain(recovery);
    expect(result).not.toHaveProperty('writeMayHaveCompleted');
  });

  it('groups the frozen plan by intent layer while a skipped requested target keeps the result failed', async () => {
    const dependencyPlan = {
      dependencyPlanSchemaVersion: 1 as const,
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/base', 'official/toolkit', 'official/root'],
      dependencyEdges: [
        { from: 'official/root', to: 'official/toolkit' },
        { from: 'official/toolkit', to: 'official/base' },
      ],
      targets: [
        { pluginId: 'official/base', pluginName: 'base', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, depth: 2, requiredBy: ['official/toolkit'], state: 'absent' as const, action: 'install' as const, order: 0 },
        { pluginId: 'official/toolkit', pluginName: 'toolkit', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, depth: 1, requiredBy: ['official/root'], state: 'present' as const, action: 'keep' as const, order: 1 },
        { pluginId: 'official/root', pluginName: 'root', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'requested' as const, depth: 0, requiredBy: [], state: 'absent' as const, action: 'install' as const, order: 2 },
      ],
    };
    const codexReconcilePlans = [{
      sharedNativeActions: [{
        pluginId: 'official/root', codexPluginId: 'root@aw-official', action: 'replace',
        desiredVersion: '2.0.0', affectsOtherScopes: true,
      }],
      activationActions: {
        user: [{
          pluginId: 'official/root', codexPluginId: 'root@aw-official',
          scope: 'user', action: 'enable', desired: true,
        }],
        project: [{
          pluginId: 'official/root', codexPluginId: 'root@aw-official',
          scope: 'project', action: 'none', desired: false,
        }],
      },
      extensionWrites: [{
        pluginId: 'official/root', componentKey: 'extensions.instructions:guide',
        kind: 'instruction', scope: 'user', action: 'write',
      }],
      extensionRemovals: [],
      review: {
        requiresConfirmation: true,
        sharedImpact: {
          pluginIds: ['root@aw-official'],
          warning: 'Replacing shared native state can affect other projects.',
        },
      },
    }] as unknown as NonNullable<OperationEvidence['codexReconcilePlans']>;
    const evidence = { ...baseEvidence, dependencyPlan, codexReconcilePlans };
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
      expect.objectContaining({ pluginId: 'official/toolkit', group: 'dependencies', relation: 'direct', kind: 'add' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'sharedCodexNative', kind: 'change' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'userActivation', kind: 'change' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'projectActivation', kind: 'keep' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'awExtensions', kind: 'change' }),
      expect.objectContaining({ group: 'preserved' }),
    ]));
    expect(review).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: {
        pluginIds: ['root@aw-official'],
        warning: expect.stringContaining('other projects'),
      },
    });
    expect(review.equivalentCommand).toBe(
      'aw install official/root --platform codex --scope user --yes',
    );
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'blocked',
      code: 'operationFailed',
      summary: { code: 'operationFailed', targets: expect.arrayContaining([
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
          { target: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }, action: 'install', state: 'failed', errorCode: 'dependencyStillRequired' },
          { target: { pluginId: 'official/root', platform: 'codex', scope: 'user' }, action: 'skipped', state: 'failed', errorCode: 'writeFailed' },
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

  it.each([
    ['user'],
    ['project'],
  ] as const)('reviews an existing dependency move to %s with the safe adjustment contract', async (
    resolvedScope,
  ) => {
    const plan = (intent: Extract<import('../../src/tui/controller.js').OperationIntent, { kind: 'pluginWrite' }>): DependencyOperationPlan => ({
      dependencyPlanSchemaVersion: 2,
      dependencyPlanDigest: `sha256:${resolvedScope}`,
      requestedPluginIds: ['official/demo'],
      resolvedPluginIds: ['official/toolkit', 'official/demo'],
      dependencyEdges: [{ from: 'official/demo', to: 'official/toolkit', platform: 'codex' }],
      scopeOverrides: intent.dependencyScopeOverrides ?? [],
      claimRoots: [],
      targets: [
        {
          pluginId: 'official/toolkit', pluginName: 'Toolkit', platform: 'codex',
          relation: 'dependency', depth: 1, requiredBy: ['official/demo'],
          rootScope: 'project', minimumScope: 'project', resolvedScope,
          allowedScopes: ['project', 'user'], assignmentSource: 'userOverride', locked: false,
          affectsOtherProjects: resolvedScope === 'user', state: 'present',
          action: resolvedScope === 'project' ? 'keep' : 'move', order: 0,
        },
        {
          pluginId: 'official/demo', pluginName: 'Demo', platform: 'codex',
          relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
          minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
          assignmentSource: 'root', locked: true, affectsOtherProjects: false,
          state: 'present', action: 'keep', order: 1,
        },
      ],
    });
    const previewDependencyPlacement = vi.fn(async (intent: Extract<import('../../src/tui/controller.js').OperationIntent, { kind: 'pluginWrite' }>) =>
      plan(intent));
    const captureEvidence = vi.fn(async (intent: import('../../src/tui/controller.js').OperationIntent) => ({
      ...baseEvidence,
      dependencyPlan: plan(intent as Extract<typeof intent, { kind: 'pluginWrite' }>),
    }));
    const executeIntent = vi.fn().mockResolvedValue({
      platforms: ['codex'], plugins: ['official/demo'], warnings: [],
      targetResults: [], overallState: 'succeeded', rebuildResults: [], receiptTargets: [],
    });
    const existingDependencyTarget = target({
      pluginName: 'toolkit', scope: resolvedScope === 'project' ? 'user' : 'project', state: 'present',
    });
    existingDependencyTarget.components.push(
      {
        kind: 'intent', key: 'desired', state: 'enabled',
        metadata: {
          enabled: true,
          scopes: [resolvedScope === 'project' ? 'user' : 'project'],
          relation: 'dependency',
        },
      },
      { kind: 'sharedNative', key: 'toolkit@aw-official', state: 'usable' },
      { kind: 'activation', key: 'user', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
      { kind: 'activation', key: 'project', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
    );
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({
          targets: [existingDependencyTarget],
        }),
        pluginSummaries: summaries(['official', 'demo'], ['official', 'toolkit']),
      }),
      previewDependencyPlacement,
      captureEvidence,
      executeIntent,
    }));
    await controller.load();
    controller.beginInstallFlow('official/demo', 'project', { adjustingExisting: true });
    controller.setInstallPlatforms(['codex']);
    await controller.prepareInstallDependencyPlacement();
    await controller.setDependencyScope('official/toolkit', 'codex', resolvedScope);
    const intent = controller.installPlacementIntent();

    expect(intent).toMatchObject({
      action: 'install',
      dependencyPlacementAdjustment: true,
    });
    expect(intent).not.toHaveProperty('dependencyPlacementOnly');
    const review = await controller.buildOperationReview(intent);
    expect(review.title).toBe('调整依赖位置');
    expect(review.description).toContain('非破坏性变更');

    const result = await controller.executeOperation(review.reviewToken);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'install',
    }), expect.any(Object));
    expect(executeIntent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'cleanup' }), expect.anything());
    expect(result).toMatchObject({ state: 'succeeded' });
  });

  it('single-flights plugin execution without a second pre-dispatch freshness scan', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const validateIntent = vi.fn().mockResolvedValue(undefined);
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const controller = new TuiController(dependencies({
      validateIntent,
      captureEvidence,
      executeIntent,
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    const observedCodes: string[] = [];
    controller.subscribe((snapshot) => {
      if (snapshot.result?.state === 'blocked') observedCodes.push(snapshot.result.code);
    });

    const first = controller.executeOperation(review.reviewToken);
    const second = controller.executeOperation(review.reviewToken);
    expect(second).toBe(first);
    expect(controller.snapshot.router.current.route).toEqual({ name: 'progress', operationId: review.operationId });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(validateIntent).toHaveBeenCalledTimes(1);
    expect(captureEvidence).toHaveBeenCalledTimes(1);
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
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
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
      kind: 'pluginWrite' as const, action: 'refreshAndSync' as const, pluginId: 'official/demo',
      platform: 'codex' as const, scope: 'user' as const,
    }, baseEvidence, { name: 'pluginDetail' as const, pluginId: 'official/demo' }],
    ['sourceMutation', {
      kind: 'sourceMutation' as const, action: 'add' as const, sourceId: 'team',
      source: { id: 'team', type: 'path' as const, primary: false, path: '/safe/fixture' },
    }, {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:candidate',
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
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'both', scope: 'user',
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
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
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
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await controller.executeOperation(review.reviewToken);

    controller.leaveResult({ name: 'pluginDetail', pluginId: 'missing/plugin' });

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(controller.snapshot.result).toBeUndefined();
  });

  function issueWriteFixture(afterWrite: TuiStatusLoadResult | Error) {
    const initial: TuiStatusLoadResult = {
      payload: status({
        sources: [source('official', { type: 'path' })],
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
        sources: [source('official', { type: 'path' })],
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

  it('keeps an issue-origin dependency result failed when the requested target is skipped', async () => {
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
        sources: [source('official', { type: 'path' })],
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
      state: 'blocked',
      code: 'operationFailed',
      summary: {
        code: 'operationFailed',
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
        sources: [source('official', { type: 'path' })],
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
        sources: [source('official', { type: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce({
        payload: status({ sources: [source('official', { type: 'path' })] }),
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
    expect(controller.getTargetState('official/demo', 'codex', 'user')).toBe('needsSync');
  });

  it('leaves issue-origin freshness to the reviewed core write plan', async () => {
    const executeIntent = vi.fn();
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const value = new TuiController(dependencies({ executeIntent, captureEvidence }));
    await value.load();

    await expect(value.buildOperationReview({
      kind: 'pluginWrite', action: 'reinstall', pluginId: 'official/demo', platform: 'codex', scope: 'user',
      originIssue: {
        issueId: 'forged', issueKey: 'forged', category: 'incompleteInstallation', actionId: 'reinstall',
      },
    })).resolves.toMatchObject({ pluginAction: 'reinstall' });
    expect(captureEvidence).toHaveBeenCalledOnce();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('delegates dependency issue freshness to the locked plugin write executor', async () => {
    const consumer = target({ pluginName: 'root', scope: 'project', state: 'partial' });
    consumer.reasons = [{
      code: 'dependencyMissing',
      message: 'safe dependency evidence',
      dependencyPluginId: 'official/toolkit',
      dependencyPlatform: 'codex',
      dependencyScope: 'user',
      dependencyProject: null,
      severity: 'warning',
    }];
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
    const executeIntent = vi.fn().mockRejectedValue(new Error(
      'operationReviewStale: dependency issue changed under the mutation lock',
    ));
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
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not duplicate scope-conflict legality for %s + %s in the controller', async (userState, projectState) => {
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
    })).resolves.toMatchObject({ pluginAction: 'uninstall' });
    expect(captureEvidence).toHaveBeenCalledOnce();
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
      apply: true,
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

  it('reports a saved invalid config with no target writes as unapplied partial', async () => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'partial',
        applySkippedReason: 'invalidConfig',
        targetResults: [],
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
      apply: true,
      updates: { mode: 'strict' },
    });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'partial',
      summary: {
        code: 'operationPartial',
        configApplied: false,
        configApplySkippedReason: 'invalidConfig',
        message: '设置已保存，但没有应用。当前配置仍无效。',
      },
    });
  });

  it('reports a reset as unconfirmed when the post-write status reload fails', async () => {
    const initial = {
      payload: status({ sources: [source('official', { type: 'path', primary: true })] }),
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
      payload: status({ sources: [source('official', { type: 'path', primary: true })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const unavailable = {
      payload: status({
        sources: [source('official')],
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
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await expect(blocked.executeOperation(blockedReview.reviewToken)).resolves.toMatchObject({ state: 'blocked' });
    blocked.leaveResult();
    expect(blocked.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('confirms reset when the source remains ready after execution', async () => {
    const readyStatus = {
      payload: status({ sources: [source('official', { type: 'path', primary: true })] }),
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
      payload: status({ sources: [source('official', { type: 'path' })] }),
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
      apply: true,
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

  it('rebuilds a plugin Review after the locked executor reports that the intent became illegal', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:changed' };
    const executeIntent = vi.fn().mockRejectedValue(new Error(
      'operationReviewStale: locked target evidence changed',
    ));
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

    expect(executeIntent).toHaveBeenCalledTimes(1);
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
          affectedTargets: [],
        },
      }),
    }));
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      apply: false,
      updates: { token: secret },
      sensitiveKeys: ['token'],
    });

    const visible = JSON.stringify({ review, snapshot: controller.snapshot });
    expect(visible).not.toContain(secret);
    expect(visible).toContain('已设置 → 将更新');
    expect(visible).not.toContain('/Users/');
  });

  it.each([
    ['user and current project', 'user', [
      { platform: 'codex', scope: 'user' },
      { platform: 'codex', scope: 'project' },
    ], ['Codex · 所有项目', 'Codex · 当前项目']],
    ['project only', 'project', [
      { platform: 'claude', scope: 'project' },
    ], ['Claude Code · 当前项目']],
    ['user only', 'user', [
      { platform: 'claude', scope: 'user' },
    ], ['Claude Code · 所有项目']],
  ] as const)('uses evidence-owned affected targets for a %s config Review', async (_label, scope, affectedTargets, labels) => {
    const evidence: OperationEvidence = {
      ...baseEvidence,
      config: {
        scope,
        projectLayer: 'shared',
        schemaIdentity: 'sha256:schema',
        storeDigest: 'sha256:store',
        affectedTargets: [...affectedTargets],
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    }));

    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'official/demo', scope,
      projectLayer: 'shared', apply: true, updates: { mode: 'safe' },
      changes: [{ key: 'mode', title: '模式', before: '旧值', after: '新值' }],
    });

    expect(review.changes.filter((change) => change.group === 'configImpact').map((change) => change.title))
      .toEqual(labels.map((label) => `重新应用 ${label}`));
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
      apply: false,
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
      layer: { scope: 'project' as 'project' | 'user' },
    };
    router.push(route);
    route.layer.scope = 'user';
    expect(router.snapshot.current.route).toMatchObject({ layer: { scope: 'project' } });

    const loaded = {
      payload: status({ sources: [source('official', { type: 'path' })] }),
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
      apply: false,
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
      kind: 'configSave', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared', apply: false, updates: { mode: 'safe' },
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

  it('binds source writes to proposed config and inventory evidence without exposing private input', async () => {
    const privatePath = '/Users/private/catalog';
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before',
        proposedConfigDigest: 'sha256:candidate',
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

    expect(review.technicalDetails).toContain('新配置：candidat');
    expect(review.technicalDetails).toContain('引用清单：inventor · 0 项');
    expect(JSON.stringify(controller.snapshot)).not.toContain(privatePath);
    await controller.executeOperation(review.reviewToken);
    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded', operationKind: 'sourceMutation' });
    expect(vi.mocked(controller.dependencies.loadStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('describes an autoCheck-only Review as a settings save with unchanged Active and store', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'update',
      sourceId: 'official',
      update: { autoCheck: false },
      changes: [{ title: '自动检查更新', before: '开启', after: '关闭' }],
    });

    expect(review).toMatchObject({
      title: '保存自动检查设置',
      description: '只保存自动检查设置；Active Catalog 和 Catalog store 保持不变。',
      primaryLabel: '保存设置',
      changes: [expect.objectContaining({
        title: '自动检查更新', description: '开启 → 关闭',
      })],
    });
    expect(JSON.stringify(review)).not.toContain('source sync');
    controller.dispose();
  });

  it('rebuilds a source Review with zero writes when config evidence becomes stale', async () => {
    const first: OperationEvidence = {
      catalog: { configDigest: 'sha256:one', compositeDigest: 'sha256:candidate-one' },
      sourceWrite: { configDigest: 'sha256:one', proposedConfigDigest: 'sha256:candidate-one', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const second: OperationEvidence = {
      catalog: { configDigest: 'sha256:two', compositeDigest: 'sha256:candidate-two' },
      sourceWrite: { configDigest: 'sha256:two', proposedConfigDigest: 'sha256:candidate-two', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
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
    expect(controller.snapshot.activeReview?.technicalDetails).toContain('新配置：candidat');
  });

  it('maps a source config CAS conflict to the same typed stale Review', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:one', compositeDigest: 'sha256:candidate' },
      sourceWrite: { configDigest: 'sha256:one', proposedConfigDigest: 'sha256:candidate', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
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

  it('publishes ReviewPreparing before validation and replaces it with Review without growing the stack', async () => {
    const validation = deferred<void>();
    const captured = deferred<OperationEvidence>();
    const validateIntent = vi.fn(() => validation.promise);
    const captureEvidence = vi.fn(() => captured.promise);
    const controller = new TuiController(dependencies({ validateIntent, captureEvidence }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' }, { focusIndex: 3 });
    const depth = controller.snapshot.router.depth;

    const preparation = controller.startReviewPreparation({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    expect(controller.snapshot.router).toMatchObject({
      depth: depth + 1,
      current: { route: { name: 'reviewPreparing', preparationId: preparation.id } },
    });
    expect(controller.snapshot.reviewPreparation).toMatchObject({
      state: 'running',
      currentLabel: 'demo',
      stages: [
        { id: 'validate', state: 'running' },
        { id: 'evidence', state: 'pending' },
      ],
    });
    expect(validateIntent).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();

    await nextTurn();
    expect(validateIntent).toHaveBeenCalledOnce();
    validation.resolve();
    await nextTurn();
    expect(controller.snapshot.reviewPreparation?.stages).toEqual([
      { id: 'validate', label: '验证当前状态', state: 'completed' },
      { id: 'evidence', label: '准备确认信息', state: 'running' },
    ]);
    captured.resolve(baseEvidence);
    await nextTurn();

    expect(controller.snapshot.router).toMatchObject({
      depth: depth + 1,
      current: { route: { name: 'review' } },
    });
    expect(controller.snapshot.reviewPreparation).toBeUndefined();
    controller.back();
    expect(controller.snapshot.router.current).toEqual({
      route: { name: 'pluginDetail', pluginId: 'official/demo' },
      context: { focusIndex: 3 },
    });
  });

  it('single-flights identical preparation and discards late completion after cancellation', async () => {
    const captured = deferred<OperationEvidence>();
    const executeIntent = vi.fn();
    const captureEvidence = vi.fn(() => captured.promise);
    const controller = new TuiController(dependencies({ captureEvidence, executeIntent }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'reinstall' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };

    const first = controller.startReviewPreparation(intent);
    const second = controller.startReviewPreparation(structuredClone(intent));
    expect(second.id).toBe(first.id);
    expect(controller.snapshot.router.depth).toBe(3);
    await nextTurn();
    expect(captureEvidence).toHaveBeenCalledOnce();

    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.reviewPreparation).toBeUndefined();
    expect(captureEvidence.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
    captured.resolve(baseEvidence);
    await nextTurn();

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.activeReview).toBeUndefined();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('uses one preparation entry and publishes only stages reported by real review work', async () => {
    const prepareReviewEvidence: NonNullable<TuiControllerDependencies['prepareReviewEvidence']> = vi.fn(
      async (_intent, _signal, onStage) => {
        for (const stage of ['status', 'catalog', 'inventory', 'dependencyPlan', 'evidence'] as const) {
          await onStage(stage);
        }
        return baseEvidence;
      },
    );
    const validateIntent = vi.fn();
    const captureEvidence = vi.fn();
    const controller = new TuiController(dependencies({
      prepareReviewEvidence,
      validateIntent,
      captureEvidence,
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const observedStages: string[][] = [];
    controller.subscribe((snapshot) => {
      if (snapshot.reviewPreparation) {
        observedStages.push(snapshot.reviewPreparation.stages.map((stage) =>
          `${stage.id}:${stage.state}`));
      }
    });
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };

    controller.startReviewPreparation(intent);
    await nextTurn(2);

    expect(prepareReviewEvidence).toHaveBeenCalledOnce();
    expect(validateIntent).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(observedStages).toEqual(expect.arrayContaining([
      ['status:running'],
      ['status:completed', 'catalog:running'],
      ['status:completed', 'catalog:completed', 'inventory:running'],
      ['status:completed', 'catalog:completed', 'inventory:completed', 'dependencyPlan:running'],
      ['status:completed', 'catalog:completed', 'inventory:completed', 'dependencyPlan:completed', 'evidence:running'],
      ['status:completed', 'catalog:completed', 'inventory:completed', 'dependencyPlan:completed', 'evidence:completed'],
    ]));
    expect(controller.snapshot.router.current.route.name).toBe('review');

    await controller.buildOperationReview(intent);
    expect(prepareReviewEvidence).toHaveBeenCalledTimes(2);
    expect(validateIntent).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it('replaces a preparation when the same intent has a different return route', async () => {
    const firstCapture = deferred<OperationEvidence>();
    const secondCapture = deferred<OperationEvidence>();
    const captureEvidence = vi.fn()
      .mockImplementationOnce(() => firstCapture.promise)
      .mockImplementationOnce(() => secondCapture.promise);
    const controller = new TuiController(dependencies({ captureEvidence }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'reinstall' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };

    const first = controller.startReviewPreparation(intent, { name: 'home' });
    await nextTurn();
    const second = controller.startReviewPreparation(intent, {
      name: 'pluginDetail', pluginId: 'official/demo',
    });
    await nextTurn();

    expect(second.id).not.toBe(first.id);
    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(captureEvidence.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
    firstCapture.resolve(baseEvidence);
    secondCapture.resolve(baseEvidence);
    await nextTurn();

    expect(controller.snapshot.router.current.route.name).toBe('review');
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/demo',
    });
  });

  it('keeps a safe preparation failure on the page and supports retry and Back', async () => {
    const validateIntent = vi.fn()
      .mockRejectedValueOnce(new Error('/private/user/token failed'))
      .mockResolvedValueOnce(undefined);
    const controller = new TuiController(dependencies({ validateIntent }));
    await controller.load();
    controller.push({ name: 'sourceDetail', sourceId: 'official' }, { focusIndex: 2 });
    const intent = { kind: 'sourceMutation' as const, action: 'setPrimary' as const, sourceId: 'official' };

    controller.startReviewPreparation(intent);
    await nextTurn();
    expect(controller.snapshot.router.current.route.name).toBe('reviewPreparing');
    expect(controller.snapshot.reviewPreparation).toMatchObject({
      state: 'failed',
      currentLabel: 'official',
      code: 'reviewPreparationFailed',
      message: '无法准备确认信息。请返回检查选择，或重试。',
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain('/private/user/token');

    controller.retryReviewPreparation();
    await nextTurn();
    expect(controller.snapshot.router.current.route.name).toBe('review');
    expect(validateIntent).toHaveBeenCalledTimes(2);
    controller.back();
    expect(controller.snapshot.router.current).toEqual({
      route: { name: 'sourceDetail', sourceId: 'official' },
      context: { focusIndex: 2 },
    });
  });
});
