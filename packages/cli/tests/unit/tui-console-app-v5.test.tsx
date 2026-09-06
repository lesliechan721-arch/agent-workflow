import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV7Payload, StatusV7PluginSummary } from '../../src/commands/status-v6.js';
import {
  createDependencyPlacementPlan,
  type DependencyOperationPlan,
} from '../../src/commands/dependency-operation-plan.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  CONSOLE_V4_SCREEN_IDS,
  ConsoleAppV4,
  resolveConsoleV4ScreenId,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  TuiConfigInvalidStoreError,
  TuiController,
  userIssueKey,
  type OperationEvidence,
  type OperationIntent,
  type PluginWriteBatchExecutionResult,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel, PluginDependencyOverviewViewModel } from '../../src/tui/model.js';
import { OperationHistoryStore } from '../../src/tui/operation-history.js';
import { CatalogProviderCompatibilityError } from '../../src/utils/catalog-public-error.js';

afterEach(() => cleanup());

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const evidence: OperationEvidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
  source: {
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    snapshotDigest: 'sha256:snapshot',
    contentDigest: 'sha256:content',
  },
  targetFingerprint: 'sha256:target',
};

function evidenceForIntent(intent: OperationIntent): OperationEvidence {
  if (intent.kind !== 'catalogGeneration') return evidence;
  return {
    ...evidence,
    catalogGeneration: {
      action: intent.action,
      candidate: {
        sourceConfigFingerprint: 'sha256:source-config',
        sourceIdentity: `identity:${intent.sourceId}`,
        logicalIdentity: `workspace:${intent.sourceId}`,
        catalogVersion: '2.4.0',
        channel: 'latest',
        requestedRef: 'catalog/stable',
        resolvedCommit: 'abc123',
        manifestDigest: 'sha256:manifest',
        snapshotDigest: 'sha256:snapshot',
      },
      configDigest: 'sha256:config',
      proposedConfigDigest: 'sha256:proposed-config',
      ...(intent.sourceMutation ? { sourceMutation: intent.sourceMutation } : {}),
    },
  };
}

function target(options: {
  pluginName: string;
  sourceId?: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  state: 'present' | 'absent' | 'partial' | 'error';
  errorCode?: string;
}): StatusV7Payload['targets'][number] {
  const sourceId = options.sourceId ?? 'official';
  const state = options.state === 'present'
    ? 'ready' as const
    : options.state === 'partial'
      ? 'needsSync' as const
      : options.state === 'error' ? 'blocked' as const : 'absent' as const;
  return {
    pluginName: options.pluginName,
    pluginId: `${sourceId}/${options.pluginName}`,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    version: '0.4.2',
    platform: options.platform,
    scope: options.scope,
    cwd: '/workspace',
    state,
    components: [{ kind: 'ownership', key: 'fixture', state: options.state }],
    reasons: options.state === 'partial'
      ? [{ code: 'missingContent', message: '安全说明', severity: 'warning' }]
      : options.state === 'error'
        ? [{ code: options.errorCode ?? 'targetError', message: '安全说明', severity: 'blocking' }]
        : [],
    recoveryActions: options.errorCode === 'sourceMissing'
      || options.errorCode === 'catalogSourceUnavailable'
      || options.errorCode === 'bundleUnavailable'
      ? [
          { command: 'sync', description: '来源恢复后同步 desired intent。' },
          { command: 'cleanup', description: '来源无法恢复时清理可证明属于 AW 的输出。' },
        ]
      : [],
  };
}

function mixedScopeConflictTarget(
  pluginName: string,
  sourceId = 'official',
): StatusV7Payload['targets'][number] {
  const value = target({ pluginName, sourceId, platform: 'codex', scope: 'user', state: 'present' });
  value.state = 'blocked';
  value.components.push(
    {
      kind: 'intent', key: 'desired', state: 'desired',
      metadata: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
    },
    { kind: 'sharedNative', key: `${pluginName}@aw-${sourceId}`, state: 'usable', metadata: { shared: true } },
    { kind: 'extension', key: 'aw', state: 'conflict', metadata: { kinds: ['instruction'] } },
  );
  value.reasons = [{
    code: 'codexExtensionScopeConflict',
    message: 'codexExtensionScopeConflict: mixed scope overlap',
    severity: 'blocking',
  }];
  value.recoveryActions = [
    {
      command: 'uninstall',
      scope: 'user',
      description: `运行 aw uninstall ${sourceId}/${pluginName} --platform codex --scope user，再运行 aw sync ${sourceId}/${pluginName} --platform codex --scope project。`,
    },
    {
      command: 'uninstall',
      scope: 'project',
      description: `运行 aw uninstall ${sourceId}/${pluginName} --platform codex --scope project，再运行 aw sync ${sourceId}/${pluginName} --platform codex --scope user。`,
    },
  ];
  return value;
}

type LegacyStatusTargetFixture = StatusV7Payload['targets'][number] & {
  desired?: {
    enabled: boolean;
    scopes: Array<'user' | 'project'>;
    relation: 'root' | 'dependency' | 'managed' | 'none';
  };
  actual?: { state: string };
  errors?: Array<StatusV7Payload['targets'][number]['reasons'][number] & { severity?: 'warning' | 'blocking' }>;
  recovery?: StatusV7Payload['targets'][number]['recoveryActions'];
  sharedNative?: {
    pluginId: string;
    state: string;
    shared?: boolean;
    reason?: string;
    version?: string;
    desiredVersion?: string;
    diagnostic?: string;
    staleCacheObserved?: boolean;
  };
  activation?: {
    user?: boolean;
    project?: boolean;
    effective?: boolean;
    evidence: 'observed' | 'assumed' | 'unobserved';
  };
  extensions?: { state: string; kinds: string[] };
};

function bridgeStatusV7Fixtures(result: TuiStatusLoadResult): TuiStatusLoadResult {
  for (const rawTarget of result.payload.targets) {
    const legacy = rawTarget as LegacyStatusTargetFixture;
    const legacyState = legacy.state as string;
    const actualState = legacy.actual?.state;
    const state = actualState === 'ready' ? 'ready'
      : actualState === 'needsSync' ? 'needsSync'
        : actualState === 'conflict' ? 'blocked'
          : legacyState === 'present' ? 'ready'
            : legacyState === 'partial' ? 'needsSync'
              : legacyState === 'error' ? 'blocked' : legacy.state;
    legacy.state = state;

    if (legacy.errors !== undefined) {
      legacy.reasons = legacy.errors.map((reason) => ({
        ...reason,
        severity: reason.severity ?? (state === 'needsSync' ? 'warning' : 'blocking'),
      }));
    }
    if (legacy.recovery !== undefined) legacy.recoveryActions = [...legacy.recovery];

    const ownershipState = legacyState === 'present'
      || legacyState === 'partial'
      || legacyState === 'error'
      || legacyState === 'absent'
      ? legacyState
      : undefined;
    legacy.components = legacy.components.map((component) => ({
      ...component,
      kind: component.kind ?? 'ownership',
      ...(ownershipState && (component.kind === undefined || component.kind === 'ownership')
        ? { state: ownershipState }
        : {}),
      ...(!component.kind && 'error' in component && component.error
        ? { metadata: { errorCode: component.error.code } }
        : {}),
    }));
    if (legacy.desired) {
      legacy.components.push({
        kind: 'intent',
        key: 'desired',
        state: legacy.desired.enabled ? 'enabled' : 'disabled',
        metadata: {
          enabled: legacy.desired.enabled,
          scopes: legacy.desired.scopes,
          relation: legacy.desired.relation,
        },
      });
    }
    if (legacy.sharedNative) {
      const { pluginId, state: sharedState, shared: _shared, ...metadata } = legacy.sharedNative;
      legacy.components.push({
        kind: 'sharedNative',
        key: pluginId,
        state: sharedState === 'present' ? 'usable' : sharedState,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    }
    if (legacy.activation) {
      for (const scope of ['user', 'project'] as const) {
        const enabled = legacy.activation[scope];
        if (enabled === undefined) continue;
        legacy.components.push({
          kind: 'activation',
          key: scope,
          state: enabled ? 'enabled' : 'disabled',
          metadata: {
            effective: legacy.activation.effective ?? false,
            evidence: legacy.activation.evidence,
          },
        });
      }
    }
    if (legacy.extensions) {
      legacy.components.push({
        kind: 'extension',
        key: 'aw',
        state: legacy.extensions.state,
        metadata: { kinds: legacy.extensions.kinds },
      });
    }
  }
  return result;
}

function loadResult(): TuiStatusLoadResult {
  const summaries: StatusV7PluginSummary[] = [
    {
      pluginName: 'agent-lab',
      pluginId: 'official/agent-lab',
      displayName: 'Agent Lab',
      description: '用于本地试验的 Agent 工具集合',
      version: '0.4.2',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 0,
    },
    {
      pluginName: 'review-gate',
      pluginId: 'official/review-gate',
      displayName: 'Review Gate',
      description: '轻量代码审查与合并检查',
      version: '0.2.1',
      supportedTargets: { codex: ['user', 'project'], claude: [] },
      configFieldCount: 1,
    },
    {
      pluginName: 'review-gate',
      pluginId: 'team-tools/review-gate',
      displayName: 'Review Gate',
      description: '团队发布审查、证据检查与发布门禁',
      version: '0.4.2',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 5,
      configIssues: [{ type: 'missing-required', key: 'rules', title: '规则文件', source: 'missing' }],
    },
  ];
  const allTargets = summaries.flatMap((summary) =>
    (['codex', 'claude'] as const).flatMap((platform) =>
      (summary.supportedTargets?.[platform] ?? []).map((scope) => target({
        pluginName: summary.pluginName,
        sourceId: summary.pluginId.split('/')[0],
        platform,
        scope,
        state: summary.pluginId === 'team-tools/review-gate'
          ? platform === 'codex' && scope === 'user' ? 'present'
            : platform === 'claude' && scope === 'project' ? 'partial' : 'absent'
          : 'absent',
      }))),
  );
  const payload: StatusV7Payload = {
      schemaVersion: 7,
      catalog: {
        primarySourceId: 'official',
        configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite',
        sources: [
          { id: 'official', identity: 'identity:official', type: 'path', primary: true, requestedRef: 'path', freshness: 'active' },
          { id: 'team-tools', identity: 'identity:team-tools', type: 'git', primary: false, requestedRef: 'catalog/stable', resolvedCommit: 'abc123', catalogVersion: '2.4.0', channel: 'latest', freshness: 'active' },
          { id: 'research', identity: 'identity:research', type: 'path', primary: false, requestedRef: 'path', error: 'unavailable', errorCode: 'catalogSourceUnavailable' },
        ],
      },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: allTargets,
      errors: [],
    };
  return {
    payload,
    pluginSummaries: summaries,
    configuredSources: [
      { id: 'official', type: 'path', primary: true, path: '/catalog/official', autoCheck: true },
      { id: 'team-tools', type: 'git', primary: false, url: 'https://example.test/team.git', refPolicy: { type: 'explicit', ref: 'catalog/stable' }, subdir: 'catalog', autoCheck: true },
      { id: 'research', type: 'path', primary: false, path: '/catalog/research', autoCheck: true },
    ],
    catalogGenerations: [
      {
        sourceId: 'official',
        sourceType: 'path',
        active: {
          catalogVersion: '1.0.0', channel: 'latest', requestedRef: 'path',
          resolvedCommit: 'path', storeKey: 'official-active', digestShort: 'official',
        },
        syncInstruction: 'aw catalog source sync official',
      },
      {
        sourceId: 'team-tools',
        sourceType: 'git',
        active: {
          catalogVersion: '2.4.0', channel: 'latest', requestedRef: 'catalog/stable',
          resolvedCommit: 'abc123', storeKey: 'team-tools-active', digestShort: 'abc12345',
        },
        syncInstruction: 'aw catalog source sync team-tools',
      },
      {
        sourceId: 'research', sourceType: 'path',
        errorCode: 'catalogGenerationUnavailable',
        syncInstruction: 'aw catalog source sync research',
      },
    ],
    sourceDetails: payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: source.type === 'git' ? 'https://example.test/team.git' : `已选择本地目录（${source.id}）`,
      ...(source.id === 'team-tools' ? { refPolicy: 'explicit' as const, explicitRef: 'catalog/stable', subdir: 'catalog' } : {}),
      pluginCount: summaries.filter((summary) => summary.pluginId.startsWith(`${source.id}/`)).length,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      ...(source.resolvedCommit ? { resolvedCommit: source.resolvedCommit } : {}),
      ...(source.catalogVersion ? { catalogVersion: source.catalogVersion } : {}),
      ...(source.channel ? { channel: source.channel } : {}),
      ...(source.freshness ? { freshness: source.freshness } : {}),
      ...(source.errorCode ? { errorCode: source.errorCode } : {}),
      configDigest: 'sha256:config',
    })),
  };
}

function capabilityUnsupportedLoadResult(): TuiStatusLoadResult {
  const loaded = loadResult();
  const unsupported = target({
    pluginName: 'review-gate',
    platform: 'codex',
    scope: 'user',
    state: 'error',
    errorCode: 'awCapabilityUnsupported',
  });
  unsupported.recoveryActions = [{
    command: 'manual',
    description: '升级 AW CLI 到支持插件所需 capability 的版本后重试。',
  }];
  loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
  loaded.payload.targets = [unsupported];
  loaded.pluginSummaries = [{
    ...loaded.pluginSummaries.find((summary) => summary.pluginId === 'official/review-gate')!,
    missingCapabilities: ['aw.future-feature.v1'],
  }];
  return loaded;
}

function orphanLoadResult(): TuiStatusLoadResult {
  const loaded = loadResult();
  loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
  loaded.payload.targets = [target({
    pluginName: 'retired-tool',
    platform: 'codex',
    scope: 'user',
    state: 'error',
    errorCode: 'bundleUnavailable',
  })];
  loaded.pluginSummaries = [];
  return loaded;
}

function forceCleanupLoadResult(): TuiStatusLoadResult {
  const loaded = loadResult();
  const offlineTarget = loaded.payload.targets.find((entry) =>
    entry.pluginId === 'team-tools/review-gate'
    && entry.platform === 'codex' && entry.scope === 'user')!;
  offlineTarget.state = 'blocked';
  offlineTarget.reasons = [{
    code: 'bundleUnavailable',
    message: 'Catalog no longer contains this plugin.',
    severity: 'blocking',
  }];
  offlineTarget.recoveryActions = [{
    command: 'cleanup',
    description: 'Clean only AW-owned content for this exact target.',
  }];
  return loaded;
}

function dependencyPlan(): DependencyOperationPlan {
  return {
    dependencyPlanSchemaVersion: 1,
    requestedPluginIds: ['official/agent-lab'],
    resolvedPluginIds: ['official/content-toolkit', 'official/skill-toolkit', 'official/agent-lab'],
    dependencyEdges: [
      { from: 'official/agent-lab', to: 'official/skill-toolkit' },
      { from: 'official/skill-toolkit', to: 'official/content-toolkit' },
    ],
    targets: [
      { pluginId: 'official/content-toolkit', pluginName: 'content-toolkit', platform: 'codex', requestedScope: 'project', resolvedScope: 'user', relation: 'dependency', requiredBy: ['official/skill-toolkit'], state: 'present', action: 'keep', order: 1 },
      { pluginId: 'official/skill-toolkit', pluginName: 'skill-toolkit', platform: 'codex', requestedScope: 'project', resolvedScope: 'project', relation: 'dependency', requiredBy: ['official/agent-lab'], state: 'absent', action: 'install', order: 2 },
      { pluginId: 'official/agent-lab', pluginName: 'agent-lab', platform: 'codex', requestedScope: 'project', resolvedScope: 'project', relation: 'requested', requiredBy: [], state: 'absent', action: 'install', order: 3 },
    ],
  };
}

function placementPlanFor(intent: {
  platform: 'codex' | 'claude' | 'both';
  scope: 'user' | 'project';
  dependencyScopeOverrides?: Array<{
    pluginId: string;
    platform: 'codex' | 'claude';
    scope: 'user' | 'project';
  }>;
}): DependencyOperationPlan;
function placementPlanFor(intent: {
  platform: 'codex' | 'claude' | 'both';
  scope: 'user' | 'project';
  dependencyScopeOverrides?: Array<{
    pluginId: string;
    platform: 'codex' | 'claude';
    scope: 'user' | 'project';
  }>;
}): DependencyOperationPlan {
  const platforms = intent.platform === 'both' ? ['codex', 'claude'] as const : [intent.platform];
  const overrideScope = (pluginId: string, platform: 'codex' | 'claude') =>
    intent.dependencyScopeOverrides?.find((entry) =>
      entry.pluginId === pluginId && entry.platform === platform)?.scope;
  const targets: DependencyOperationPlan['targets'] = platforms.flatMap((platform) => {
    const directOverride = overrideScope('official/skill-toolkit', platform);
    const directScope = directOverride ?? intent.scope;
    return [
      {
        pluginId: 'official/content-toolkit', pluginName: 'Agent Content Toolkit', platform,
        relation: 'dependency', depth: 2, requiredBy: ['official/skill-toolkit'],
        rootScope: intent.scope, minimumScope: directScope, resolvedScope: directScope,
        allowedScopes: ['project', 'user'], assignmentSource: directScope === 'user'
          ? 'consumerPromotion' : 'default', locked: false,
        affectsOtherProjects: directScope === 'user', state: 'present', action: 'keep', order: 0,
      },
      {
        pluginId: 'official/skill-toolkit', pluginName: 'Agent Skill Toolkit', platform,
        relation: 'dependency', depth: 1, requiredBy: ['official/agent-lab'],
        rootScope: intent.scope, minimumScope: intent.scope, resolvedScope: directScope,
        allowedScopes: ['project', 'user'], assignmentSource: directOverride
          ? 'userOverride' : 'default', locked: directOverride !== undefined,
        ...(directOverride ? { lockReason: 'dependencyScopeOverride' } : {}),
        affectsOtherProjects: directScope === 'user', state: 'absent', action: 'install', order: 1,
      },
      {
        pluginId: 'official/agent-lab', pluginName: 'Agent Lab', platform,
        relation: 'requested', depth: 0, requiredBy: [], rootScope: intent.scope,
        minimumScope: intent.scope, resolvedScope: intent.scope,
        allowedScopes: [intent.scope], assignmentSource: 'root', locked: true,
        affectsOtherProjects: intent.scope === 'user', state: 'absent', action: 'install', order: 2,
      },
    ];
  });
  return {
    dependencyPlanSchemaVersion: 2,
    dependencyPlanDigest: `sha256:${JSON.stringify(targets)}`,
    requestedPluginIds: ['official/agent-lab'],
    resolvedPluginIds: ['official/content-toolkit', 'official/skill-toolkit', 'official/agent-lab'],
    dependencyEdges: platforms.flatMap((platform) => [
      { from: 'official/agent-lab', to: 'official/skill-toolkit', platform },
      { from: 'official/skill-toolkit', to: 'official/content-toolkit', platform },
    ]),
    scopeOverrides: intent.dependencyScopeOverrides ?? [],
    targets,
    claimRoots: [],
  };
}

function dependencyOverview(options: {
  rootState?: 'notInstalled' | 'ready';
  blockers?: PluginDependencyOverviewViewModel['blockers'];
} = {}): PluginDependencyOverviewViewModel[] {
  const rootState = options.rootState ?? 'notInstalled';
  const notInstalled = (platform: 'codex' | 'claude') => ({ platform, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const });
  const readyUser = (platform: 'codex' | 'claude') => ({ platform, state: 'installed' as const, scope: 'user' as const, health: 'ready' as const });
  return [
    {
      pluginId: 'official/agent-lab',
      summary: { directCount: 1, transitiveCount: 1, totalCount: 2, readyCount: 1, missingCount: 1, issueCount: options.blockers?.length ?? 0 },
      dependencies: [
        { pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit', relation: 'direct', depth: 1, requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }], placements: [notInstalled('codex'), notInstalled('claude')], aggregateStatus: 'notInstalled', placementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }] },
        { pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit', relation: 'transitive', depth: 2, requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }], placements: [readyUser('codex'), readyUser('claude')], aggregateStatus: 'ready' },
      ],
      dependents: [],
      blockers: options.blockers ?? [],
    },
    {
      pluginId: 'official/skill-toolkit',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 1, missingCount: 0, issueCount: 0 },
      dependencies: [
        { pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit', relation: 'direct', depth: 1, requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }], placements: [readyUser('codex'), readyUser('claude')], aggregateStatus: 'ready' },
      ],
      dependents: [
        { pluginId: 'official/agent-lab', displayName: 'Agent Lab', relation: 'dependent', depth: 1, requiredBy: [], placements: rootState === 'ready' ? [readyUser('codex')] : [notInstalled('codex')], aggregateStatus: rootState, placementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }] },
      ],
      blockers: [],
    },
  ];
}

function dependencyLoadResult(options: {
  rootState?: 'absent' | 'present' | 'error';
  rootErrorCode?: string;
  rootErrorMessage?: string;
  blockers?: PluginDependencyOverviewViewModel['blockers'];
} = {}): TuiStatusLoadResult {
  const initial = loadResult();
  const rootState = options.rootState ?? 'absent';
  initial.payload.catalog.sources = [initial.payload.catalog.sources[0]!];
  initial.pluginSummaries = [
    { ...initial.pluginSummaries[0]!, supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] } },
    { pluginName: 'skill-toolkit', pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit', description: '提供 Skill 工具能力', version: '0.3.0', supportedTargets: { codex: ['user', 'project'], claude: [] }, configFieldCount: 0 },
    { pluginName: 'content-toolkit', pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit', description: '提供内容工具能力', version: '0.2.0', supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] }, configFieldCount: 0 },
  ];
  initial.payload.targets = [
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) => ({
      ...target({ pluginName: 'agent-lab', platform, scope, state: rootState }),
      errors: rootState === 'error' ? [{ code: options.rootErrorCode ?? 'targetError', message: options.rootErrorMessage ?? '安全说明' }] : [],
    }))),
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) =>
      target({ pluginName: 'skill-toolkit', platform, scope, state: 'absent' }))),
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) =>
      target({ pluginName: 'content-toolkit', platform, scope, state: scope === 'user' ? 'present' : 'absent' }))),
  ];
  initial.dependencyOverviews = dependencyOverview({
    rootState: rootState === 'present' ? 'ready' : 'notInstalled',
    blockers: options.blockers,
  });
  return initial;
}

function controller(overrides: Partial<TuiControllerDependencies> = {}): TuiController {
  const dependencies: TuiControllerDependencies = {
    loadStatus: vi.fn().mockResolvedValue(loadResult()),
    inspectSourceRemoval: vi.fn().mockResolvedValue({ blocked: false, inventoryComplete: true, installationCount: 0, configCount: 0, lifecycleCount: 0, marketplaceCount: 0, dependencies: [] }),
    captureEvidence: vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent)),
    executeIntent: vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'completed' },
      ],
    }),
    now: () => 1_000,
    reviewTtlMs: 10_000,
    ...overrides,
  };
  const loadStatus = dependencies.loadStatus;
  dependencies.loadStatus = async (...args) => bridgeStatusV7Fixtures(await loadStatus(...args));
  return new TuiController(dependencies);
}

function platformLoadResult(
  revision: 'current' | 'upgradeAvailable',
): TuiStatusLoadResult {
  const loaded = loadResult();
  loaded.payload.catalog.sources = loaded.payload.catalog.sources.filter((source) => source.id === 'official');
  loaded.sourceDetails = loaded.sourceDetails?.filter((source) => source.id === 'official');
  loaded.pluginSummaries = loaded.pluginSummaries.filter((summary) => summary.pluginId === 'official/review-gate');
  loaded.payload.targets = [target({
    pluginName: 'review-gate',
    platform: 'codex',
    scope: 'user',
    state: 'present',
  })];
  loaded.targetRevisions = [{
    pluginId: 'official/review-gate',
    platform: 'codex',
    scope: 'user',
    revision: {
      state: revision,
      availableVersion: revision === 'current' ? '0.2.1' : '0.3.0',
      installedVersion: '0.2.1',
    },
  }];
  return loaded;
}

function configPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
  const field = (
    key: string,
    type: ConfigPageViewModel['groups'][number]['fields'][number]['type'],
    extra: Partial<ConfigPageViewModel['groups'][number]['fields'][number]> = {},
  ): ConfigPageViewModel['groups'][number]['fields'][number] => {
    const value = {
      key,
      title: key,
      type,
      definition: { type },
      displayValue: '未设置',
      required: false,
      sensitive: false,
      writable: true,
      dirty: false,
      inherited: true,
      configured: false,
      sourceLabel: '未设置',
      effectiveDisplayValue: '未设置',
      effectiveSourceLabel: '未设置',
      allowCustom: true,
      advanced: false,
      ...extra,
    };
    return {
      ...value,
      effectiveDisplayValue: extra.effectiveDisplayValue ?? value.displayValue,
      effectiveSourceLabel: extra.effectiveSourceLabel ?? (value.configured ? '个人默认' : '未设置'),
      ...(extra.effectiveValue !== undefined
        ? { effectiveValue: extra.effectiveValue }
        : value.value !== undefined && !value.sensitive
          ? { effectiveValue: value.value }
          : {}),
    };
  };
  return {
    pluginId,
    layer: { scope: 'user', projectLayer: 'shared' },
    storedCount: 2,
    presets: [{
      id: 'team',
      title: '团队默认',
      description: '平衡审查与等待时间',
      values: { level: 'balanced', enabled: true, timeout: 20 },
    }],
    groups: [
      {
        id: 'basic',
        title: '基本设置',
        advanced: false,
        fields: [
          field('level', 'string', { definition: { type: 'string', choices: { allowCustom: false, presets: [{ id: 'fast', title: '快速', value: 'fast' }, { id: 'balanced', title: '平衡', value: 'balanced', recommended: true }, { id: 'strict', title: '严格', value: 'strict' }] } }, choices: [{ id: 'fast', title: '快速', value: 'fast' }, { id: 'balanced', title: '平衡', value: 'balanced', recommended: true }, { id: 'strict', title: '严格', value: 'strict' }], allowCustom: false, value: 'strict', draftValue: 'strict', displayValue: '严格', configured: true, inherited: false }),
          field('enabled', 'boolean', { definition: { type: 'boolean' }, value: true, draftValue: true, displayValue: '开启', configured: true, inherited: false }),
          field('timeout', 'number', { definition: { type: 'number', validation: { minimum: 1, maximum: 60 } }, min: 1, max: 60, unit: '分钟', value: 15, draftValue: 15, displayValue: '15', configured: true, inherited: false }),
          field('note', 'string', { placeholder: '输入说明' }),
          field('rules', 'string', { sensitive: true, configured: true, inherited: false, displayValue: '已设置' }),
          field('workspace', 'string'),
          field('token', 'string', { definition: { type: 'string', sensitive: true }, sensitive: true, configured: true, inherited: false, displayValue: '已设置' }),
        ],
      },
      {
        id: 'advanced',
        title: '高级设置',
        description: '模型与内部调优',
        advanced: true,
        fields: [field('model', 'string', { value: 'review-v2', displayValue: 'review-v2', configured: true, inherited: false })],
      },
    ],
  };
}

function objectConfigPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
  const effective = {
    owner: 'Alice',
    region: 'west',
    token: 'SECRET-BYTES',
    legacy: 'old',
  };
  return {
    pluginId,
    layer: { scope: 'user' },
    storedCount: 0,
    presets: [],
    groups: [{
      id: 'general',
      title: '插件设置',
      advanced: false,
      fields: [{
        key: 'settings',
        title: '服务设置',
        type: 'object',
        definition: {
          type: 'object',
          choices: {
            allowCustom: true,
            presets: [{
              id: 'service',
              title: '服务方案',
              value: { owner: 'Service', region: 'west', token: 'preset-secret' },
              recommended: true,
            }],
          },
          properties: {
            owner: { type: 'string', title: '负责人', required: true, validation: { format: 'identifier' } },
            region: {
              type: 'string',
              title: '区域',
              required: true,
              choices: {
                allowCustom: false,
                presets: [{ id: 'west', title: '西区', value: 'west' }, { id: 'east', title: '东区', value: 'east' }],
              },
            },
            token: { type: 'string', title: '令牌', sensitive: true },
          },
          additionalProperties: { type: 'string', validation: { minLength: 2 } },
          validation: { minProperties: 2, maxProperties: 6, key: { format: 'identifier' } },
        },
        choices: [{
          id: 'service',
          title: '服务方案',
          value: { owner: 'Service', region: 'west', token: 'preset-secret' },
          recommended: true,
        }],
        allowCustom: true,
        displayValue: '继承',
        required: true,
        sensitive: false,
        writable: true,
        dirty: false,
        inherited: true,
        configured: false,
        sourceLabel: '继承',
        effectiveDisplayValue: '已设置 · 4 项',
        effectiveSourceLabel: '当前项目',
        effectiveValue: effective,
        draftValue: effective,
        advanced: false,
      }],
    }],
  };
}

function configuredObjectPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
  const page = objectConfigPage(pluginId);
  const field = page.groups[0]!.fields[0]!;
  const current = {
    owner: 'Alice',
    region: 'west',
    token: 'CURRENT-SECRET',
  };
  page.storedCount = 1;
  field.configured = true;
  field.inherited = false;
  field.displayValue = '已设置 · 3 项';
  field.value = current;
  field.draftValue = current;
  field.fallbackDisplayValue = '已设置 · 3 项';
  field.fallbackSourceLabel = '当前项目';
  field.fallbackObjectChanges = [
    { property: 'owner', before: 'Alice', after: 'Service' },
    { property: 'token', before: '已设置', after: '已设置', private: true },
  ];
  return page;
}

async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
  }
}

async function confirmReview(
  instance: ReturnType<typeof render>,
  _value: TuiController,
): Promise<void> {
  await input(instance, '\r');
}

async function chooseConfigSave(
  instance: ReturnType<typeof render>,
  value: TuiController,
  action: 'only' | 'apply',
): Promise<void> {
  expect(value.snapshot.router.current.route.name).toBe('configSave');
  await input(instance, ...(action === 'only' ? ['\u001B[B'] : []), '\r');
  await nextTurn(3);
  expect(value.snapshot.router.current.route.name).toBe('review');
}

async function openConfigSave(
  instance: ReturnType<typeof render>,
  value: TuiController,
): Promise<void> {
  expect(value.snapshot.router.current.route.name).toBe('configFields');
  await input(instance, 's');
  expect(value.snapshot.router.current.route.name).toBe('configSave');
}

async function chooseSourceSave(
  instance: ReturnType<typeof render>,
  value: TuiController,
  action: 'only' | 'enable',
): Promise<void> {
  expect(value.snapshot.router.current.route.name).toBe('sourceSave');
  await input(instance, ...(action === 'only' ? ['\u001B[B'] : []), '\r');
  await nextTurn(3);
  expect(value.snapshot.router.current.route.name).toBe('review');
}

describe('ConsoleAppV4', () => {
  it('keeps the complete reachable screen map free of duplicate identities', () => {
    expect(CONSOLE_V4_SCREEN_IDS).toHaveLength(106);
    expect(new Set(CONSOLE_V4_SCREEN_IDS)).toHaveProperty('size', 106);
    expect(CONSOLE_V4_SCREEN_IDS).toEqual([
      'G01', 'G02', 'G03', 'G04', 'G05',
      'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
      'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
      'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
      'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
      'S01', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
      'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18',
      'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09',
      'I10', 'I11', 'I12', 'I13',
      'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09',
      'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17',
      'D18', 'D19', 'D20',
      'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'U10', 'U11',
      'K02',
      'B01', 'B02',
    ]);
  });

  it('routes typed I01-I09 issues and the empty state through mounted pages', async () => {
    const loaded = loadResult();
    const conflictTargetIndex = loaded.payload.targets.findIndex((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    loaded.payload.targets.splice(
      conflictTargetIndex,
      1,
      mixedScopeConflictTarget('review-gate', 'team-tools'),
    );
    loaded.payload.targets.push(
      target({ pluginName: 'missing', sourceId: 'archive', platform: 'codex', scope: 'user', state: 'error', errorCode: 'sourceMissing' }),
      target({ pluginName: 'changed', sourceId: 'team-tools', platform: 'codex', scope: 'project', state: 'error', errorCode: 'sourceChanged' }),
    );
    loaded.payload.errors.push({ code: 'legacyStateUnsupported', message: 'private legacy location' });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const expected = new Map([
      ['incompleteInstallation', 'I03'],
      ['sourceUnavailable', 'I04'],
      ['sourceMissing', 'I05'],
      ['sourceIdentityChanged', 'I06'],
      ['requiredConfigMissing', 'I07'],
      ['scopeConflict', 'I08'],
      ['legacyState', 'I09'],
    ] as const);
    const reached = new Set<ConsoleV4ScreenId>();
    value.push({ name: 'issueList' });
    const listInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached).toContain('I01');
    expect((listInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    listInstance.unmount();
    for (const [category, screen] of expected) {
      const selected = value.listUserIssues().find((entry) => entry.category === category);
      expect(selected, category).toBeDefined();
      value.push({ name: 'issueDetail', issueId: selected!.issueId });
      const detailInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(current) => reached.add(current)} />);
      await nextTurn(2);
      expect(reached).toContain(screen);
      expect(detailInstance.lastFrame()).not.toContain('private legacy location');
      if (category === 'sourceMissing') {
        expect(detailInstance.lastFrame()).toContain('清理 AW 管理内容');
        expect(detailInstance.lastFrame()).toContain('重新添加同一来源');
        expect(detailInstance.lastFrame()).toContain('技术详情');
        expect(detailInstance.lastFrame()).not.toContain('aw cleanup');
        expect(detailInstance.lastFrame()).not.toContain('--force');
      }
      expect((detailInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
      detailInstance.unmount();
      value.back();
    }

    const empty = loadResult();
    empty.payload.catalog.sources = [empty.payload.catalog.sources[0]!];
    empty.payload.targets = empty.payload.targets.map((entry) => ({ ...entry, state: 'absent' as const, errors: [] }));
    empty.payload.errors = [];
    empty.pluginSummaries = empty.pluginSummaries.map(({ configIssues: _issues, ...summary }) => summary);
    const emptyController = controller({ loadStatus: vi.fn().mockResolvedValue(empty) });
    await emptyController.load();
    emptyController.push({ name: 'issueList' });
    const emptyScreens: ConsoleV4ScreenId[] = [];
    const emptyInstance = render(<ConsoleAppV4 controller={emptyController} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => emptyScreens.push(screen)} />);
    await nextTurn(2);
    expect(emptyScreens).toContain('I02');
    expect(emptyInstance.lastFrame()).toContain('当前没有需要处理的问题');
  });

  it.each([
    ['shortcut', 80, 24],
    ['action', 80, 24],
    ['shortcut', 60, 18],
    ['action', 60, 18],
  ] as const)('shows every I09 manual recovery step through %s at %ix%i', async (
    entry,
    columns,
    rows,
  ) => {
    const loaded = loadResult();
    loaded.payload.errors.push({ code: 'legacyStateUnsupported', message: 'private legacy location' });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'legacyState')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    await input(instance, entry === 'shortcut' ? 'd' : '\r');
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('建议 1');
    expect(frame).toContain('运行 aw status --json，记录公开错误 code。');
    expect(frame).toContain('备份相关 AW 配置。');
    let allTechnicalPages = frame;
    for (let page = 0; page < 3; page += 1) {
      await input(instance, '\u001B[6~');
      allTechnicalPages += instance.lastFrame() ?? '';
    }
    expect(allTechnicalPages).toContain('按技术详情使用受支持命令或人工处理。');
    expect(allTechnicalPages).toContain('再次运行状态检查。');
    expect(frame).toContain('› 查看手动处理说明');
    expect(frame).toContain('d 技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(frame).not.toContain('private legacy location');
  });

  it('uses typed issue origin for I10-I12 and reloads the issue list after success', async () => {
    const initial = loadResult();
    initial.payload.catalog.sources = [initial.payload.catalog.sources[0]!];
    initial.payload.targets = [target({ pluginName: 'review-gate', platform: 'codex', scope: 'user', state: 'partial' })];
    initial.pluginSummaries = [initial.pluginSummaries[1]!];
    const resolved = structuredClone(initial);
    resolved.payload.targets[0] = { ...resolved.payload.targets[0]!, state: 'present', errors: [] };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(resolved);
    let completeExecution!: (value: unknown) => void;
    const execution = new Promise((resolve) => { completeExecution = resolve; });
    const executeIntent = vi.fn().mockReturnValue(execution);
    const value = controller({ loadStatus, executeIntent });
    await value.load();
    const selected = value.listUserIssues().find((entry) => entry.category === 'incompleteInstallation')!;
    value.push({ name: 'issueDetail', issueId: selected.issueId });
    const screens: ConsoleV4ScreenId[] = [];
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    await input(instance, '\r');
    expect(value.snapshot.activeReview?.originIssue).toMatchObject({
      issueId: selected.issueId,
      category: 'incompleteInstallation',
      actionId: 'sync',
    });
    instance.unmount();
    const reviewInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('I10');
    await confirmReview(reviewInstance, value);
    reviewInstance.unmount();
    const progressInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('I11');
    completeExecution({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(10);
    progressInstance.unmount();
    const resultInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('I12');
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      originIssue: expect.objectContaining({ issueId: selected.issueId }),
    }), evidence);
    expect(value.listUserIssues().some((entry) => entry.issueId === selected.issueId)).toBe(false);
    resultInstance.unmount();
  });

  it('cleans a Catalog orphan through ordinary cleanup and removes it from both lists after refresh', async () => {
    const initial = orphanLoadResult();
    const resolved = structuredClone(initial);
    resolved.payload.targets = [];
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(resolved);
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const value = controller({ loadStatus, executeIntent });
    await value.load();

    expect(value.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId))
      .toEqual(['official/retired-tool']);
    expect(value.listPlugins({ mode: 'installed' }).map((plugin) => plugin.pluginId))
      .toEqual(['official/retired-tool']);
    const issue = value.listUserIssues()[0]!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('当前插件目录不再包含此插件');
    expect(instance.lastFrame()).toContain('清理 AW 管理内容');
    expect(instance.lastFrame()).not.toContain('--force');
    await input(instance, '\r');

    const reviewFrame = instance.lastFrame() ?? '';
    expect(value.snapshot.activeReview).toMatchObject({
      pluginAction: 'cleanup',
      originIssue: { actionId: 'cleanup' },
      equivalentCommand: 'aw cleanup official/retired-tool --platform codex --scope user',
    });
    expect(reviewFrame).toContain('只清理可证明属于 AW 的现场内容');
    expect(reviewFrame).toContain('保留插件设置');
    expect(reviewFrame).not.toContain('lifecycle');
    expect(reviewFrame).not.toContain('等价命令：');
    expect(reviewFrame).not.toContain('--force');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('等价命令：aw cleanup official/retired-tool --platform codex --scope user');

    await confirmReview(instance, value);
    await nextTurn(4);

    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: 'cleanup',
      pluginId: 'official/retired-tool',
      platform: 'codex',
      scope: 'user',
    }), evidence);
    expect(executeIntent.mock.calls[0]?.[0]).not.toHaveProperty('force');
    expect(value.listPlugins({ mode: 'browse' })).toEqual([]);
    expect(value.listPlugins({ mode: 'installed' })).toEqual([]);
    expect(value.listUserIssues()).toEqual([]);
    expect(instance.lastFrame()).toContain('问题已处理');
  });

  it('keeps the Catalog orphan issue when ordinary cleanup is blocked by a dependent', async () => {
    const initial = orphanLoadResult();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(initial),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: { pluginId: 'official/retired-tool', platform: 'codex', scope: 'user' },
          action: 'cleanup',
          state: 'failed',
          errorCode: 'dependencyStillRequired',
        }],
      }),
    });
    await value.load();
    const issue = value.listUserIssues()[0]!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(instance, '\r');
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({
      state: 'blocked',
      code: 'dependencyStillRequired',
      originIssue: { issueId: issue.issueId, actionId: 'cleanup' },
    });
    expect(value.listUserIssues()).toContainEqual(expect.objectContaining({ issueId: issue.issueId }));
    expect(value.snapshot.result).not.toHaveProperty('writeMayHaveCompleted');
    expect(instance.lastFrame()).toContain('问题仍未解决');
    expect(instance.lastFrame()).toContain('操作被安全阻止');
    expect(instance.lastFrame()).not.toContain('dependencyStillRequired');
    expect(instance.lastFrame()).not.toContain('--force');
  });

  it('keeps a failed issue and routes I13 back to its detail with a fixed error', async () => {
    const initial = loadResult();
    initial.payload.catalog.sources = [initial.payload.catalog.sources[0]!];
    initial.payload.targets = [target({ pluginName: 'review-gate', platform: 'codex', scope: 'user', state: 'partial' })];
    initial.pluginSummaries = [initial.pluginSummaries[1]!];
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(initial),
      executeIntent: vi.fn().mockRejectedValue(new Error('/Users/private/raw failure')),
    });
    await value.load();
    const selected = value.listUserIssues().find((entry) => entry.category === 'incompleteInstallation')!;
    value.push({ name: 'issueDetail', issueId: selected.issueId });
    const screens: ConsoleV4ScreenId[] = [];
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    await input(instance, '\r');
    await confirmReview(instance, value);
    await nextTurn(3);
    expect(screens).toContain('I13');
    expect(instance.lastFrame()).not.toContain('/Users/private');
    expect(instance.lastFrame()).toContain('返回问题详情');
    expect(instance.lastFrame()).toContain('重新检查问题');
    expect(instance.lastFrame()).not.toContain('重试失败部分…');
    expect(value.listUserIssues().some((entry) => entry.issueId === selected.issueId)).toBe(true);
  });

  it.each([
    { key: '', actionId: 'keepProjectScope', removedScope: 'user' },
    { key: '\u001B[B', actionId: 'keepUserScope', removedScope: 'project' },
  ] as const)('maps the canonical scope choice $actionId to removing $removedScope', async ({ key, actionId, removedScope }) => {
    const loaded = loadResult();
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.payload.targets = [mixedScopeConflictTarget('review-gate')];
    loaded.pluginSummaries = [loaded.pluginSummaries[1]!];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const conflict = value.listUserIssues().find((entry) => entry.category === 'scopeConflict')!;
    value.push({ name: 'issueDetail', issueId: conflict.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    await input(instance, ...(key ? [key] : []), '\r');
    expect(value.snapshot.activeReview).toMatchObject({
      pluginAction: 'uninstall',
      originIssue: { issueId: conflict.issueId, issueKey: userIssueKey(conflict), category: 'scopeConflict', actionId },
    });
    expect((value.dependencies.captureEvidence as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
      pluginId: 'official/review-gate',
      scope: removedScope,
    });
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not mount keep-one-scope actions for %s + %s', async (userState, projectState) => {
    const loaded = loadResult();
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.payload.targets = [
      target({ pluginName: 'review-gate', platform: 'codex', scope: 'user', state: userState }),
      target({ pluginName: 'review-gate', platform: 'codex', scope: 'project', state: projectState }),
    ];
    loaded.pluginSummaries = [loaded.pluginSummaries[1]!];
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    const diagnostic = value.listUserIssues().find((entry) => entry.category === 'diagnostic')!;
    value.push({ name: 'issueDetail', issueId: diagnostic.issueId });

    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).not.toContain('保留所有项目');
    expect(instance.lastFrame()).not.toContain('保留当前项目');
    expect(value.listUserIssues().some((entry) => entry.category === 'scopeConflict')).toBe(false);
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();

    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('targetError');
    await input(instance, 'd');
    const technicalIndex = diagnostic.actions.findIndex((action) => action.id === 'viewTechnical');
    for (let index = 0; index < technicalIndex; index += 1) await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('targetError');
  });

  it('reaches every P state through a real mounted controller snapshot', async () => {
    const reached = new Set<ConsoleV4ScreenId>();
    const mountRoute = async (
      route: Parameters<TuiController['push']>[0],
      expected: ConsoleV4ScreenId,
      value = controller(),
    ): Promise<void> => {
      value.push(route);
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns: 80, rows: 24 }}
        onScreenChange={(screen) => reached.add(screen)}
      />);
      await nextTurn(3);
      expect(reached.has(expected), `${expected} was not reached`).toBe(true);
      instance.unmount();
      instance.cleanup();
    };

    await mountRoute({ name: 'pluginList', mode: 'browse' }, 'P01');
    const search = controller();
    search.push({ name: 'pluginList', mode: 'browse' });
    const searchInstance = render(<ConsoleAppV4 controller={search} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    await input(searchInstance, '/');
    expect(reached.has('P02')).toBe(true);
    searchInstance.unmount();
    searchInstance.cleanup();
    await mountRoute({ name: 'pluginList', mode: 'browse', sourceId: 'research' }, 'P03');
    await mountRoute({ name: 'pluginPreview', pluginId: 'official/agent-lab' }, 'P04');
    await mountRoute({ name: 'installPlacement', pluginId: 'official/agent-lab' }, 'P05');
    await mountRoute({ name: 'installTargets', pluginId: 'official/agent-lab' }, 'P06');
    await mountRoute({ name: 'pluginList', mode: 'installed' }, 'P11');
    const emptyData = loadResult();
    emptyData.payload.targets = emptyData.payload.targets.map((entry) => ({ ...entry, state: 'absent', errors: [] }));
    await mountRoute({ name: 'pluginList', mode: 'installed' }, 'P12', controller({
      loadStatus: vi.fn().mockResolvedValue(emptyData),
    }));
    await mountRoute({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' }, 'P13');
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' }, 'P14');
    await mountRoute({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' }, 'P15');
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'claude' }, 'P16');
    const unavailableData = loadResult();
    unavailableData.payload.catalog.sources = unavailableData.payload.catalog.sources.map((entry) =>
      entry.id === 'team-tools'
        ? { ...entry, error: 'unavailable', errorCode: 'catalogSourceUnavailable', freshness: undefined }
        : entry);
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' }, 'P17', controller({
      loadStatus: vi.fn().mockResolvedValue(unavailableData),
    }));
    await mountRoute({ name: 'pluginAbout', pluginId: 'team-tools/review-gate' }, 'P20');
    await mountRoute({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' }, 'P21');

    const prepare = async (
      action: 'install' | 'reinstall' | 'uninstall',
      executeIntent: TuiControllerDependencies['executeIntent'] = vi.fn().mockResolvedValue({
        targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
      }),
    ): Promise<{ value: TuiController; token: string }> => {
      const value = controller({ executeIntent });
      await value.load();
      const review = await value.buildOperationReview({
        kind: 'pluginWrite',
        action,
        pluginId: action === 'install' ? 'official/agent-lab' : 'team-tools/review-gate',
        platform: 'codex',
        scope: 'user',
      });
      return { value, token: review.reviewToken };
    };
    for (const [action, expected] of [['install', 'P07'], ['reinstall', 'P18'], ['uninstall', 'P19']] as const) {
      const prepared = await prepare(action);
      const instance = render(<ConsoleAppV4 controller={prepared.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
      await nextTurn(3);
      expect(reached.has(expected)).toBe(true);
      instance.unmount();
      instance.cleanup();
    }
    const pending = new Promise<unknown>(() => undefined);
    const progress = await prepare('install', vi.fn(() => pending));
    void progress.value.executeOperation(progress.token);
    await nextTurn(2);
    const progressInstance = render(<ConsoleAppV4 controller={progress.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P08')).toBe(true);
    progressInstance.unmount();
    progressInstance.cleanup();
    const success = await prepare('install');
    await success.value.executeOperation(success.token);
    const successInstance = render(<ConsoleAppV4 controller={success.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P09')).toBe(true);
    successInstance.unmount();
    successInstance.cleanup();
    const partial = await prepare('install', vi.fn().mockResolvedValue({ targetResults: [
      { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
      { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
    ] }));
    await partial.value.executeOperation(partial.token);
    const partialInstance = render(<ConsoleAppV4 controller={partial.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P10')).toBe(true);
    partialInstance.unmount();
    partialInstance.cleanup();

    expect([...reached].filter((screen) => screen.startsWith('P')).sort()).toEqual(
      CONSOLE_V4_SCREEN_IDS.filter((screen) => screen.startsWith('P')).sort(),
    );
  }, 30_000);

  it('mounts the loading skeleton and keeps ordinary exit separate from G04 discard', async () => {
    const screens: ConsoleV4ScreenId[] = [];
    const exit = vi.fn();
    const value = controller();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onExit={exit}
      onScreenChange={(screen) => screens.push(screen)}
    />);
    expect(instance.lastFrame()).toContain('正在检查插件状态');
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('管理你的 Agent 工作流插件');

    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
    await input(instance, '?', 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    await input(instance, '\u001B[B', '\r');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
    expect(screens).toEqual(expect.arrayContaining(['G01', 'G02', 'G03']));
    expect(screens).not.toContain('G04');
  });

  it('shows the stable primary root cause on an installed plugin row', async () => {
    const loaded = loadResult();
    const consumer = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate' && entry.platform === 'codex');
    expect(consumer).toBeDefined();
    consumer!.state = 'partial';
    consumer!.errors = [{
      code: 'dependencyNotReady',
      message: 'safe dependency symptom',
      dependencyPluginId: 'team-tools/toolkit',
      rootIssueId: 'artifactCollision:team-tools/toolkit:codex:user:agent:toolkit',
      rootIssueCode: 'artifactCollision',
      severity: 'warning',
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).not.toContain('artifactCollision');
    expect(instance.lastFrame()).toContain('团队发布审查、证据检查与发布门禁');
    expect(instance.lastFrame()).toContain('AW 不会覆盖或删除');
    instance.unmount();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps batch and current-project sync menus reachable at %ix%i',
    async (columns, rows) => {
      const value = controller();
      await value.load();
      value.push({ name: 'pluginList', mode: 'installed' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      const installedCount = value.listPlugins({ mode: 'installed' }).length;

      await input(instance, ...Array.from({ length: installedCount }, () => '\u001B[B'));
      let frame = instance.lastFrame() ?? '';
      expect(frame).toContain('› 批量操作…');
      expect(frame.split('\n')).toSatisfy((lines: string[]) =>
        lines.length <= rows && lines.every((line) => stringWidth(line) <= columns));
      await input(instance, '\r');
      expect(value.snapshot.router.current.route.name).toBe('batchSelection');

      value.replace({ name: 'pluginList', mode: 'installed' });
      await nextTurn(2);
      await input(instance, ...Array.from({ length: installedCount + 1 }, () => '\u001B[B'));
      frame = instance.lastFrame() ?? '';
      expect(frame).toContain('› 同步当前项目全部插件…');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route.name).toBe('batchPlacement');
      expect(instance.lastFrame()).toContain('同步当前项目全部保存目标');
    },
  );

  it('retries only failed batch roots through a new Review and returns to the stable installed list', async () => {
    const root = 'team-tools/review-gate';
    const rebuild = (state: 'failed' | 'succeeded') => ({
      platforms: ['codex'],
      plugins: [root],
      warnings: [],
      rebuildResults: [],
      receiptTargets: [],
      overallState: state,
      targetResults: [{
        target: {
          pluginName: 'review-gate', pluginId: root, sourceId: 'team-tools',
          platform: 'codex' as const, scope: 'project' as const,
        },
        state: state === 'failed' ? 'failed' as const : 'completed' as const,
        ...(state === 'failed' ? { errorCode: 'preApplyExited' } : {}),
      }],
    });
    const captureEvidence = vi.fn(async (intent: OperationIntent) => intent.kind === 'pluginWriteBatch'
      ? {
          ...evidence,
          requestedPluginIds: intent.selection.kind === 'selected' ? [...intent.selection.pluginIds] : [root],
          groups: [{
            groupId: 'team-tools:codex', sourceId: 'team-tools', platform: 'codex' as const,
            requestedPluginIds: intent.selection.kind === 'selected' ? [...intent.selection.pluginIds] : [root],
            preview: rebuild('failed'), executable: false,
          }],
        }
      : evidence);
    const failedGroup = rebuild('failed');
    const executeIntent = vi.fn().mockResolvedValue({
      ...failedGroup,
      requestedPluginIds: [root],
      groupResults: [{
        groupId: 'team-tools:codex', sourceId: 'team-tools', platform: 'codex',
        requestedPluginIds: [root], result: failedGroup,
      }],
    } satisfies PluginWriteBatchExecutionResult);
    const value = controller({ captureEvidence, executeIntent });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, '/', 'review', '\u001B[B', 'm', '\u001B[B', '\u001B[B', '\r', '\r', 'c');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchPlacement' });
    await input(instance, ...Array.from({ length: 5 }, () => '\u001B[B'), '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    await input(instance, '\r');
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({
      state: 'blocked',
      summary: { batch: { requestedPluginIds: [root], failedRequestedPluginIds: [root] } },
    });
    expect(instance.lastFrame()).toContain('仅重试失败插件');
    await input(instance, '\r');
    await nextTurn(4);
    expect(['reviewPreparing', 'review']).toContain(value.snapshot.router.current.route.name);
    expect(captureEvidence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'pluginWriteBatch',
        selection: { kind: 'selected', pluginIds: [root] },
      }),
      expect.any(AbortSignal),
    );

    if (value.snapshot.router.current.route.name === 'reviewPreparing') await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(value.snapshot.router.current.context.query).toBe('review');
    expect(value.snapshot.result).toBeUndefined();
    instance.unmount();
  });

  it('guards batch selection for h navigation and keeps 100 narrow-screen candidates reachable', async () => {
    const loaded = loadResult();
    loaded.pluginSummaries = Array.from({ length: 100 }, (_, index): StatusV7PluginSummary => ({
      pluginName: `plugin-${String(index).padStart(3, '0')}`,
      pluginId: `official/plugin-${String(index).padStart(3, '0')}`,
      displayName: `Plugin ${String(index).padStart(3, '0')}`,
      description: `批量候选 ${index}`,
      version: '1.0.0',
      supportedTargets: { codex: ['project'], claude: [] },
      configFieldCount: 0,
    }));
    loaded.payload.targets = loaded.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'project',
      state: 'present',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const navigate = vi.fn().mockResolvedValue('draftBlocked');
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 60, rows: 18 }}
      onSessionNavigation={navigate}
    />);
    await nextTurn(2);

    await input(instance, 'm', '\u001B[B', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('Plugin 000');
    await input(instance, ...Array.from({ length: 99 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('Plugin 099');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, 'h');
    expect(navigate).toHaveBeenCalledWith('home', { discardDrafts: false });
    expect(instance.lastFrame()).toContain('放弃未保存修改');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    await input(instance, 'b', 'H');
    expect(navigate).toHaveBeenLastCalledWith('reload', { discardDrafts: false });
    expect(instance.lastFrame()).toContain('放弃未保存修改');
    instance.unmount();
  });

  it('canonicalizes reverse-order batch choices before starting Review', async () => {
    const captureEvidence = vi.fn(async (intent: OperationIntent) => {
      if (intent.kind !== 'pluginWriteBatch') return evidence;
      const pluginIds = intent.selection.kind === 'selected' ? intent.selection.pluginIds : [];
      const preview = {
        platforms: ['codex'], plugins: pluginIds, warnings: [], rebuildResults: [],
        targetResults: [], receiptTargets: [], overallState: 'succeeded' as const,
        operationPlan: {
          schemaVersion: 1 as const,
          kind: 'aw-operation-plan' as const,
          operation: 'sync' as const,
          planFingerprint: 'sha256:batch',
          target: { pluginId: pluginIds[0]!, platform: 'codex' as const, scope: 'project' as const },
          changes: [],
        },
      };
      return {
        ...evidence,
        requestedPluginIds: pluginIds,
        groups: [{
          groupId: 'official:codex', sourceId: 'official', platform: 'codex' as const,
          requestedPluginIds: pluginIds, preview, executable: true,
        }],
      };
    });
    const loaded = loadResult();
    const secondRoot = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/review-gate'
      && entry.platform === 'codex'
      && entry.scope === 'project');
    expect(secondRoot).toBeDefined();
    secondRoot!.state = 'ready';
    secondRoot!.components = [{ kind: 'ownership', key: 'fixture', state: 'present' }];
    const executeIntent = vi.fn().mockResolvedValue({
      platforms: ['codex'], plugins: ['official/review-gate', 'team-tools/review-gate'],
      warnings: [], rebuildResults: [], targetResults: [], receiptTargets: [],
      overallState: 'succeeded',
      requestedPluginIds: ['official/review-gate', 'team-tools/review-gate'],
      groupResults: [],
    });
    const value = controller({
      captureEvidence,
      executeIntent,
      loadStatus: vi.fn().mockResolvedValue(loaded),
    });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', '\u001B[B', '\u001B[B', '\r', '\u001B[B', '\r', '\u001B[A', '\r', 'c');
    await input(instance, ...Array.from({ length: 5 }, () => '\u001B[B'), '\r');
    await nextTurn(4);

    const batchIntent = captureEvidence.mock.calls.at(-1)?.[0];
    expect(batchIntent).toMatchObject({
      kind: 'pluginWriteBatch',
      selection: {
        kind: 'selected',
        pluginIds: ['official/review-gate', 'team-tools/review-gate'],
      },
    });
    expect(value.snapshot.router.current.route.name).toBe('review');
    const oldReviewToken = value.snapshot.activeReview!.reviewToken;

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('scriptTimeout');
    await input(instance, '\u0015', '4500', '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'pluginWriteBatch',
      action: 'sync',
      scriptTimeoutMs: 4_500,
    });
    expect(value.snapshot.activeReview!.reviewToken).not.toBe(oldReviewToken);
    await expect(value.executeOperation(oldReviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });

    await input(instance, '\r');
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pluginWriteBatch', action: 'sync', scriptTimeoutMs: 4_500,
      }),
      expect.objectContaining({ requestedPluginIds: ['official/review-gate', 'team-tools/review-gate'] }),
    );
    instance.unmount();
  });

  it('runs the explicit all-source check without leaving the source list', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceList' });
    const checkAll = vi.spyOn(value, 'recheckAllCatalogSources').mockResolvedValue();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(checkAll).toHaveBeenCalledTimes(1);
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceList' });
    instance.unmount();
  });

  it('scrolls a 100-target batch Result to both ends and Esc restores installed list context', async () => {
    const root = 'team-tools/review-gate';
    const targetResults = Array.from({ length: 100 }, (_, index) => ({
      target: {
        pluginName: `target-${String(index).padStart(3, '0')}`,
        pluginId: index === 0 ? root : `team-tools/target-${String(index).padStart(3, '0')}`,
        sourceId: 'team-tools', platform: 'codex' as const, scope: 'project' as const,
      },
      state: 'completed' as const,
      relation: index === 0 ? 'requested' as const : 'transitive' as const,
      ...(index === 0 ? {} : { requiredBy: [root] }),
    }));
    const rebuild = {
      platforms: ['codex'], plugins: [root], warnings: [], rebuildResults: [], receiptTargets: [],
      overallState: 'succeeded' as const, targetResults,
    };
    const captureEvidence = vi.fn(async (intent: OperationIntent) => intent.kind === 'pluginWriteBatch'
      ? {
          ...evidence,
          requestedPluginIds: [root],
          groups: [{
            groupId: 'team-tools:codex', sourceId: 'team-tools', platform: 'codex' as const,
            requestedPluginIds: [root], preview: rebuild, executable: false,
          }],
        }
      : evidence);
    const execution: PluginWriteBatchExecutionResult = {
      ...rebuild,
      requestedPluginIds: [root],
      groupResults: [{
        groupId: 'team-tools:codex', sourceId: 'team-tools', platform: 'codex',
        requestedPluginIds: [root], result: rebuild,
      }],
    };
    const value = controller({ captureEvidence, executeIntent: vi.fn().mockResolvedValue(execution) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    value.updatePageContext({ query: 'review', focusIndex: 0, scrollOffset: 0 });
    value.beginPluginWriteBatch();
    await value.buildOperationReview({
      kind: 'pluginWriteBatch', action: 'sync',
      selection: { kind: 'selected', pluginIds: [root] },
      platform: 'codex', scope: 'project',
    }, { name: 'batchPlacement' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    await input(instance, '\r');
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('Review Gate');
    expect(instance.lastFrame()).toContain('↓ 后面还有');
    await input(instance, ...Array.from({ length: 110 }, () => '\u001B[6~'));
    expect(instance.lastFrame()).toContain('target-099');
    expect(instance.lastFrame()).toContain('↑ 前面还有');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(value.snapshot.router.current.context).toMatchObject({ query: 'review', focusIndex: 0 });
    expect(value.snapshot.result).toBeUndefined();
    instance.unmount();
  });

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('keeps every G03 shortcut meaning and the single close focus visible at %ix%i', async (columns, rows) => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    await value.load();
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns, rows }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(2);
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 我的插件');

    await input(instance, '?');
    for (const [key, meaning] of [
      ['↑/↓ · j/k', '移动当前唯一焦点'],
      ['Enter', '打开、选择或继续'],
      ['q / Ctrl-C', '退出控制台'],
      ['? / o', '关闭帮助 / 查看操作记录'],
    ]) {
      expect(instance.lastFrame()).toContain(`${key}  ${meaning}`);
    }
    for (const direction of ['\u001B[A', '\u001B[B', '\u001B[D', '\u001B[C']) {
      await input(instance, direction);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('› 关闭');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    }
    expect(screens).toContain('G03');

    await input(instance, '\r');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 我的插件');
    await input(instance, '?');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 我的插件');
    await input(instance, '?', '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 我的插件');

    value.push({ name: 'pluginList', mode: 'browse' });
    await nextTurn(2);
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('←/→ · [ / ]  切换来源');
    expect(instance.lastFrame()).toContain('/  进入搜索');
    await input(instance, '?');

    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).not.toContain('Space  切换目标平台选择');

    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    await nextTurn(2);
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('d  打开技术详情');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');

    value.replace({ name: 'sourceList' });
    await nextTurn(2);
    await input(instance, '?');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');

    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    await nextTurn(3);
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('s  查看保存汇总');
    expect(instance.lastFrame()).toContain('u  恢复当前字段继承');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');
  });

  it('keeps unfinished loading work active or pending without claiming completion', async () => {
    const pendingLoad = deferred<TuiStatusLoadResult>();
    const value = controller({ loadStatus: vi.fn(() => pendingLoad.promise) });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('● 读取插件来源');
    expect(instance.lastFrame()).toContain('○ 检查当前项目');
    expect(instance.lastFrame()).not.toContain('✓ 读取插件来源');
    pendingLoad.resolve(loadResult());
    await nextTurn(3);
  });

  it('shows unavailable source counts on the mounted home page', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const instance = render(<ConsoleAppV4 controller={controller()} size={size} />);
      await nextTurn(3);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('1 个来源不可用');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
      instance.cleanup();
    }
  });

  it('shows structured dependency diagnostics when legacy technical details are empty', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyMissing',
      rootErrorMessage: 'dependencyMissing: official/skill-toolkit has changed state.',
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === 'dependencyMissing' && candidate.scope === 'project')!;
    const issuesWithoutDetails = value.listUserIssues().map((candidate) => candidate.issueId === issue.issueId
      ? { ...candidate, technicalDetails: [] }
      : candidate);
    vi.spyOn(value, 'listUserIssues').mockReturnValue(issuesWithoutDetails);
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('技术详情');
    expect(frame).toContain('d 技术详情');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('dependencyMissing');
    expect(instance.lastFrame()).not.toContain('has changed state');
  });

  it('does not treat target platform selection as an unsaved write', async () => {
    const screens: ConsoleV4ScreenId[] = [];
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.push(screen)}
      onExit={exit}
    />);
    await nextTurn(3);

    await input(instance, '\r', 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(screens).not.toContain('G04');
    await input(instance, '\u001B[B', '\r');

    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('keeps the same-scope target selection after Back and lets Ctrl-C exit from help', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);

    await input(instance, '\r', '\r', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(exit).not.toHaveBeenCalled();

    await input(instance, '?', '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('lets Ctrl-C exit while the ordinary exit overlay is open', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    await input(instance, '\r', 'q', '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('uses Enter for each target and only confirms from the visible confirmation action', async () => {
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ captureEvidence });
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await input(instance, '\r', '\r');

    expect(instance.lastFrame()).toContain('◇ Codex');
    expect(instance.lastFrame()).toContain('◇ Claude Code');
    expect(instance.lastFrame()).not.toContain('● Codex');
    expect(instance.lastFrame()).toContain('确认目标平台');
    expect(instance.lastFrame()).toContain('返回选择位置');
    expect(instance.lastFrame()).toContain('至少选择一个目标平台');
    expect(instance.lastFrame()).toContain('↑↓ 移动 · Enter 选择/确认 · Esc 返回');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('installTargets');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(captureEvidence).not.toHaveBeenCalled();

    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite', action: 'install', platform: 'codex', scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('invalidates the old Review and binds a first script-timeout value to a new Review', async () => {
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn();
    const value = controller({ captureEvidence, executeIntent });
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await input(instance, '\r', '\r', '\r', '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    const oldToken = value.snapshot.activeReview?.reviewToken;
    expect(oldToken).toBeDefined();

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('scriptTimeout');
    expect(value.snapshot.activeReview).toBeUndefined();
    await input(instance, '\u0015', '12000', '\r');
    await nextTurn(12);

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(value.snapshot.activeReview?.reviewToken).not.toBe(oldToken);
    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(captureEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ scriptTimeoutMs: 12_000 }), expect.any(AbortSignal));
    await expect(value.executeOperation(oldToken!)).resolves.toMatchObject({ state: 'blocked', code: 'reviewTicketInvalid' });
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('mounts ReviewPreparing before deferred validation and lets Esc cancel without creating Review', async () => {
    const validation = deferred<void>();
    const captured = deferred<OperationEvidence>();
    const executeIntent = vi.fn();
    const value = controller({
      validateIntent: vi.fn(() => validation.promise),
      captureEvidence: vi.fn(() => captured.promise),
      executeIntent,
    });
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' }, { focusIndex: 1 });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('reviewPreparing');
    expect(instance.lastFrame()).toContain('正在准备插件操作确认');
    expect(instance.lastFrame()).toContain('● 验证当前状态');
    expect(instance.lastFrame()).toContain('○ 准备确认信息');
    expect(instance.lastFrame()).toContain('当前');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('Esc 取消 · Ctrl-C 完成后退出');
    expect(executeIntent).not.toHaveBeenCalled();

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(value.snapshot.router.current.context).toEqual({
      focusIndex: 2, scrollOffset: 0, query: '', installFilter: 'all', sourceTabId: undefined,
    });
    expect(instance.lastFrame()).toContain('◆ Codex');
    validation.resolve();
    captured.resolve(evidence);
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('installTargets');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('keeps accepted Progress non-cancellable by Esc', async () => {
    const execution = deferred<unknown>();
    const value = controller({ executeIntent: vi.fn(() => execution.promise) });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    await nextTurn(2);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);

    expect(value.snapshot.router.current.route).toEqual({ name: 'progress', operationId: review.operationId });
    expect(instance.lastFrame()).toContain('Ctrl-C 完成后退出');
    execution.resolve({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(3);
  });

  it('renders a safe failed preparation with focused retry and Back actions', async () => {
    const validateIntent = vi.fn()
      .mockRejectedValueOnce(new Error('/Users/private/raw failure'))
      .mockResolvedValueOnce(undefined);
    const value = controller({ validateIntent });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    value.startReviewPreparation({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools',
    });
    await nextTurn(2);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('无法准备确认信息');
    expect(frame).not.toContain('reviewPreparationFailed');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('reviewPreparationFailed');
    await input(instance, 'd');
    expect(frame).toContain('› 重试');
    expect(frame).toContain('返回修改');
    expect(frame).not.toContain('/Users/private/raw failure');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(validateIntent).toHaveBeenCalledTimes(2);
  });

  it('automatically selects the only compatible target platform after the scope choice', async () => {
    const loaded = loadResult();
    const summary = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/agent-lab')!;
    summary.supportedTargets = { codex: ['user'], claude: [] };
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'official/agent-lab'
      || entry.platform === 'codex' && entry.scope === 'user');
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\r', '\r');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).not.toContain('Claude Code');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite', action: 'install', platform: 'codex', scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('recomputes and replaces target selection when the scope changes', async () => {
    const loaded = loadResult();
    const summary = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/agent-lab')!;
    summary.supportedTargets = { codex: ['user', 'project'], claude: ['user'] };
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'official/agent-lab'
      || entry.platform === 'codex'
      || entry.platform === 'claude' && entry.scope === 'user');
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\r', '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    await input(instance, '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).toContain('Claude Code');
    expect(instance.lastFrame()).toContain('不支持所选位置');
    await input(instance, 'b', '\u001B[A', '\r');
    expect(instance.lastFrame()).toContain('◇ Codex');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
  });

  it('preselects a compatible target platform from its platform detail add action', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'claude' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\r', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(instance.lastFrame()).toContain('◇ Codex');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
  });

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('skips a disabled first target platform while keeping it inert at %ix%i', async (columns, rows) => {
    const loaded = dependencyLoadResult();
    const dependency = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    dependency.supportedTargets = { codex: [], claude: ['user', 'project'] };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    const initial = instance.lastFrame() ?? '';
    expect(initial).toContain('◇ Codex');
    expect(initial).toContain('Agent Skill Toolkit 不支持Codex');
    expect(initial).toContain('› ◇ Claude Code');
    expect(initial).toContain('确认目标平台');
    expect(initial.match(/›/gu)).toHaveLength(1);
    expect(initial.split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, ' ');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('◇ Codex');

    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 返回选择位置');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\u001B[A');
    expect(instance.lastFrame()).toContain('› ◇ Claude Code');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
    expect(captureEvidence).not.toHaveBeenCalled();
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it('routes a fully incompatible install directly to the blocked target page', async () => {
    const loaded = dependencyLoadResult();
    const dependency = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    dependency.supportedTargets = { codex: [], claude: [] };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('所选目标平台不可用');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/agent-lab', view: 'blocked',
    });
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
  });

  it('makes the P05 scope choice enter P06 directly with one visible focus', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const value = controller();
      value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toMatch(/› ● (所有项目|当前项目)/u);
      expect(frame).not.toContain('继续');
      expect(frame).not.toContain('调整目标平台');
      expect(frame).not.toContain('根插件和缺失依赖使用同一个位置');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      if (size.columns === 80) expect(frame).toContain('适合个人常用能力');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
      instance.unmount();
      instance.cleanup();
    }
  });

  it('does not dispose an externally owned controller and exits initial load failure nonzero', async () => {
    const exit = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockRejectedValue(new Error('statusUnavailable: private')) });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('无法读取插件状态');
    await input(instance, '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 1, reason: 'initialError' });
    instance.unmount();
    expect(value.snapshot.phase).toBe('error');
  });

  it('handles Ctrl-C before search input and exits without changing the query', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    await input(instance, '/', '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
    expect(instance.lastFrame()).toContain('/ 输入搜索内容');
  });

  it('exits once after a busy stale operation returns to Review', async () => {
    const pending = deferred<unknown>();
    const exit = vi.fn();
    const value = controller({ executeIntent: vi.fn(() => pending.promise) });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');

    await input(instance, '\u0003');
    pending.reject(new Error('operationReviewStale: changed'));
    await nextTurn(4);

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'stale' });
  });

  it.each([
    ['Ctrl-C', '\u0003'],
    ['q', 'q'],
  ])('defers %s while a busy screen is too small and exits once after completion', async (_label, exitInput) => {
    const pending = deferred<unknown>();
    const exit = vi.fn();
    const value = controller({ executeIntent: vi.fn(() => pending.promise) });
    const dispose = vi.spyOn(value, 'dispose');
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} ownsController />);
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');

    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 52, rows: 14 }} onExit={exit} ownsController />);
    await input(instance, exitInput, '\r');
    expect(instance.lastFrame()).toContain('终端空间不足');
    expect(exit).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    pending.resolve({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(4);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'completed' });
  });

  it('keeps an installed plugin visible when its source is unavailable', async () => {
    const unavailable = loadResult();
    unavailable.payload.catalog.sources = unavailable.payload.catalog.sources.map((entry) =>
      entry.id === 'team-tools'
        ? { ...entry, error: 'unavailable', errorCode: 'catalogSourceUnavailable', freshness: undefined }
        : entry);
    unavailable.pluginSummaries.push({
      pluginName: 'catalog-only',
      pluginId: 'team-tools/catalog-only',
      displayName: 'Catalog Only',
      description: 'Only in the unavailable catalog',
      supportedTargets: { codex: ['user'], claude: [] },
    });
    unavailable.payload.targets = [
      ...unavailable.payload.targets.map((entry) => entry.pluginId === 'team-tools/review-gate'
        ? { ...entry, state: entry.platform === 'codex' && entry.scope === 'user' ? 'error' as const : 'absent' as const,
            errors: entry.platform === 'codex' && entry.scope === 'user'
              ? [{ code: 'nativeStateUnreadable', message: 'safe live owner failure' }]
              : [] }
        : entry),
      target({ pluginName: 'catalog-only', sourceId: 'team-tools', platform: 'codex', scope: 'user', state: 'absent' }),
    ];
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(unavailable),
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('✓ 1 个插件可用');
    await input(instance, '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('Review Gate');
    expect(instance.lastFrame()).toContain('来源不可用');
    expect(instance.lastFrame()).not.toContain('Catalog Only');
    await input(instance, '\r', '\r');
    expect(screens).toContain('P17');
    expect(instance.lastFrame()).toContain('来源不可用');
  });

  it('shows AW CLI capability recovery without routing a healthy source to a missing source issue', async () => {
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(capabilityUnsupportedLoadResult()),
    });
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('需要升级 AW CLI 才能管理 Codex');
    expect(frame).toContain('升级 AW CLI');
    expect(frame).toContain('查看功能支持详情');
    expect(frame).toContain('升级 AW CLI 到支持此插件的版本后重试。');
    expect(frame).not.toContain('查看来源问题');
    expect(frame).not.toContain('重新加载状态');
    expect(frame).not.toContain('来源不可用');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginTechnical', pluginId: 'official/review-gate',
    });
    expect(instance.lastFrame()).toContain('Capability 技术详情');
    expect(instance.lastFrame()).toContain('aw.future-feature.v1');
    expect(instance.lastFrame()).toContain('awCapabilityUnsupported');
    expect(value.snapshot.router.current.route.name).not.toBe('sourceDetail');
    expect(value.snapshot.router.current.route.name).not.toBe('issueDetail');
  });

  it('counts source tabs from the active browse or installed list mode', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    expect((instance.lastFrame() ?? '').replace(/\s+/gu, ' ')).toContain('[全部 3] official 2 team-tools 1');

    value.replace({ name: 'pluginList', mode: 'installed' });
    await nextTurn(2);
    expect((instance.lastFrame() ?? '').replace(/\s+/gu, ' ')).toContain('[全部 1] official 0 team-tools 1');
  });

  it('normalizes a mounted detail route when reload removes its current plugin', async () => {
    const initial = loadResult();
    const removed = loadResult();
    initial.payload.catalog.sources = initial.payload.catalog.sources.map((source) => source.id === 'team-tools'
      ? { ...source, type: 'path' as const, requestedRef: 'path', freshness: 'active' as const }
      : source);
    removed.payload.catalog.sources = removed.payload.catalog.sources.map((source) => source.id === 'team-tools'
      ? { ...source, type: 'path' as const, requestedRef: 'path', freshness: 'active' as const }
      : source);
    removed.pluginSummaries = removed.pluginSummaries.filter((entry) => entry.pluginId !== 'team-tools/review-gate');
    removed.payload.targets = removed.payload.targets.filter((entry) => entry.pluginId !== 'team-tools/review-gate');
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(removed),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('Review Gate');

    await value.reloadCatalog();
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(instance.lastFrame()).not.toContain('后续阶段');
  });

  it('routes platform errors to typed issues without offering reinstall or removal', async () => {
    const loaded = loadResult();
    const failed = loaded.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex' && entry.scope === 'user');
    if (failed) {
      failed.state = 'error';
      failed.errors = [{
        code: 'sourceChanged',
        message: '/private/source changed',
        severity: 'blocking',
      }];
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('查看对应问题');
    expect(instance.lastFrame()).not.toContain('重新连接缺失内容');
    expect(instance.lastFrame()).not.toContain('移除');
    expect(instance.lastFrame()).not.toContain('/private/source');
  });

  it('shows the catalog version in the refresh-and-sync action only from revision sidecar evidence', async () => {
    const loaded = loadResult();
    loaded.targetRevisions = [{
      pluginId: 'team-tools/review-gate',
      platform: 'codex',
      scope: 'user',
      revision: {
        state: 'upgradeAvailable',
        availableVersion: '0.5.0',
        installedVersion: '0.4.2',
      },
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('刷新并同步到 0.5.0…');
    expect(instance.lastFrame()).toContain('已安装版本 0.4.2');
  });

  it('keeps the focused platform action by ID when a live reload inserts refresh-and-sync first', async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(platformLoadResult('current'))
      .mockResolvedValue(platformLoadResult('upgradeAvailable'));
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\u001B[B', '\u001B[B');
    expect(instance.lastFrame()).toContain('› 查看安装详情');

    await value.load();
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('刷新并同步到 0.3.0…');
    expect(instance.lastFrame()).toContain('› 查看安装详情');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginTechnical',
      pluginId: 'official/review-gate',
    });
  });

  it('focuses and runs the first platform action when a live refresh removes the focused action', async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(platformLoadResult('upgradeAvailable'))
      .mockResolvedValue(platformLoadResult('current'));
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› 刷新并同步到 0.3.0…');

    await value.load();
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› 重新安装…');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);

    await input(instance, '\r');
    expect(value.snapshot.activeReview).toMatchObject({
      operationKind: 'pluginWrite',
      pluginAction: 'reinstall',
    });
    expect(value.dependencies.captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: 'reinstall',
      pluginId: 'official/review-gate',
      platform: 'codex',
      scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('shows only safe verbose component fields on P21 and keeps non-verbose P21 unchanged', async () => {
    const verbose = loadResult();
    const targetWithComponent = verbose.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex' && entry.scope === 'user');
    if (targetWithComponent) targetWithComponent.components = [{
      key: 'skill:review', state: 'error', error: { code: 'componentInspectionFailed', message: '/private/raw component label' },
    }];
    const verboseValue = controller({ loadStatus: vi.fn().mockResolvedValue(verbose) });
    await verboseValue.load();
    verboseValue.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const verboseInstance = render(<ConsoleAppV4 controller={verboseValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(verboseInstance.lastFrame()).toContain('skill:review');
    expect(verboseInstance.lastFrame()).toContain('componentInspectionFailed');
    expect(verboseInstance.lastFrame()).not.toContain('/private/raw');

    const normalValue = controller();
    normalValue.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const normalInstance = render(<ConsoleAppV4 controller={normalValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(normalInstance.lastFrame()).not.toContain('skill:review');
  });

  it.each([
    [60, 18, 10],
    [80, 24, 14],
  ] as const)('prioritizes exceptional P21 components and preserves return at %ix%i with %i items', async (
    columns,
    rows,
    componentCount,
  ) => {
    const loaded = loadResult();
    const selected = loaded.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex' && entry.scope === 'user')!;
    selected.components = [
      ...Array.from({ length: componentCount - 2 }, (_, index) => ({
        key: `ordinary:${index}`,
        state: 'present' as const,
      })),
      { key: 'error-code', state: 'error' as const, error: { code: 'componentInspectionFailed', message: '/private/component' } },
      { key: 'partial-code', state: 'partial' as const },
    ];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('error-code');
    expect(frame).toContain('componentInspectionFailed');
    expect(frame).toContain('partial-code');
    expect(frame).toMatch(/后面还有 \d+ 个组件/u);
    expect(frame).toContain('› 返回插件');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(frame).not.toContain('/private/component');

    let componentPages = frame;
    for (let page = 0; page < componentCount + 2; page += 1) {
      await input(instance, '\u001B[6~');
      componentPages += instance.lastFrame() ?? '';
    }
    const lastPage = instance.lastFrame() ?? '';
    expect(lastPage).toContain(`ordinary:${componentCount - 3}`);
    for (let index = 0; index < componentCount - 2; index += 1) {
      expect(componentPages).toContain(`ordinary:${index}`);
    }
    expect(lastPage).toContain('↑ 前面还有');
    expect(lastPage.split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
  });

  it('keeps source tabs out of the vertical focus and searches same-name plugins by canonical identity', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const initial = instance.lastFrame() ?? '';
    expect(initial).toContain('全部 3');
    expect(initial.match(/Review Gate/g)?.length).toBeGreaterThanOrEqual(2);
    expect(initial.match(/›/g)).toHaveLength(1);

    await input(instance, '\u001B[C');
    const afterTab = instance.lastFrame() ?? '';
    expect(afterTab).toContain('[official 2]');
    expect(afterTab.match(/›/g)).toHaveLength(1);

    await input(instance, '/', 'review');
    const searched = instance.lastFrame() ?? '';
    expect(searched).toContain('/ review');
    expect(searched).toContain('轻量代码审查与合并检查');
  });

  it('runs the normal install chain through Controller review and execute, then renders a partial result', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'failed',
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'failed', errorCode: 'writeFailed' },
      ],
    });
    const value = controller({ executeIntent });
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('你希望在哪里使用 Agent Lab？');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('至少选择一个目标平台');
    await input(instance, '\r', '\u001B[B', '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('确认添加插件 Agent Lab');
    await confirmReview(instance, value);
    await nextTurn(3);

    expect(executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'official/agent-lab', platform: 'both', scope: 'user' }),
      evidence,
    );
    expect(instance.lastFrame()).toContain('只完成了一部分');
    expect(instance.lastFrame()).toContain('Claude Code · 所有项目');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('重试失败部分…');
    await confirmReview(instance, value);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform',
      pluginId: 'official/agent-lab',
      platform: 'claude',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route.name).not.toBe('sourceEdit');
    expect(value.snapshot.result).toBeUndefined();
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
  ] as const)('returns from a mounted %s Result without exposing Progress or a fallback page', async (state, execution) => {
    const value = controller({
      executeIntent: execution instanceof Error
        ? vi.fn().mockRejectedValue(execution)
        : vi.fn().mockResolvedValue(execution),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'team-tools/review-gate', platform: 'both', scope: 'user',
    });
    await expect(value.executeOperation(review.reviewToken)).resolves.toMatchObject({ state });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'b');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
    expect(instance.lastFrame()).not.toContain('后续阶段');
    expect(instance.lastFrame()).not.toContain('正在执行');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
    expect(value.snapshot.result).toBeUndefined();
  });

  it.each(['add', 'update'] as const)('renders real feed phase changes and bounded technical messages for source %s', async (sourceAction) => {
    const execution = deferred<unknown>();
    const progress = createRebuildProgressFeed();
    const value = new TuiController({
      ...controller().dependencies,
      captureEvidence: vi.fn().mockResolvedValue({
        catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
        sourceWrite: {
          configDigest: 'sha256:before', proposedConfigDigest: 'sha256:candidate',
          inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
        },
      }),
      executeIntent: vi.fn(() => execution.promise),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview(sourceAction === 'add'
      ? {
          kind: 'sourceMutation', action: 'add', sourceId: 'new-source',
          source: { id: 'new-source', type: 'path', primary: false, path: '/fixture/catalog' },
        }
      : {
          kind: 'sourceMutation', action: 'update', sourceId: 'team-tools',
          update: { type: 'path', path: '/fixture/catalog' },
        });
    const running = value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).not.toContain('d 技术进度');
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('q / Ctrl-C  操作完成后退出');
    expect(instance.lastFrame()).not.toContain('d  打开技术详情');
    await input(instance, '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');

    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'safe-plugin', platform: 'codex', scope: 'user' },
      data: { name: 'preflight.inspect', phase: 'start' },
    });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('检查当前组件');
    expect(instance.lastFrame()).toContain('safe-plugin · Codex/当前用户');

    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'safe-plugin', platform: 'codex', scope: 'user' },
      data: { name: 'native.write', phase: 'start' },
    });
    for (let index = 0; index < 7; index += 1) {
    progress.addNotice({ level: 'warning', identity: `warning-${index}`, message: '/private/raw-error' });
    }
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('d 技术进度');
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, 'd');
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain('写入平台插件');
    expect(technical.match(/收到警告/g)).toHaveLength(4);
    expect(technical).not.toContain('/private/raw-error');
    expect(technical.split('\n').length).toBeLessThanOrEqual(18);

    execution.resolve({ targetResults: [] });
    await running;
  });

  it('marks a failed target and current operation step as error instead of active', async () => {
    const execution = deferred<unknown>();
    const progress = createRebuildProgressFeed();
    const plan = dependencyPlan();
    const value = new TuiController({
      ...controller().dependencies,
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn(() => execution.promise),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const running = value.executeOperation(review.reviewToken);
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'agent-lab', platform: 'codex', scope: 'project', action: 'install' },
      data: { name: 'postcheck.inspect', phase: 'failure', message: 'safe failure' },
    });
    await nextTurn(2);
    expect(screens).toContain('D06');
    expect(instance.lastFrame()).toContain('× 执行依赖闭包');
    expect(instance.lastFrame()).toContain('× 验证完整结果');
    expect(instance.lastFrame()).not.toContain('● 验证完整结果');
    expect(instance.lastFrame()).toContain('× Agent Lab');
    expect(instance.lastFrame()).toContain('另有 2 个目标');
    expect(instance.lastFrame()).toContain('d 技术进度');
    execution.resolve({ overallState: 'partial', targetResults: [
      { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'failed' },
    ] });
    await running;
  });

  it('grows a large dependency progress target viewport from 60x18 through 80x40 without clipping', async () => {
    const execution = deferred<unknown>();
    const loaded = dependencyLoadResult();
    const targetIds = Array.from({ length: 12 }, (_, index) =>
      index === 11 ? 'official/agent-lab' : `official/progress-target-${index + 1}`);
    loaded.pluginSummaries.push(...targetIds.slice(0, -1).map((pluginId, index) => ({
      pluginName: pluginId.split('/')[1]!,
      pluginId,
      displayName: `Progress Target ${index + 1}`,
      description: `Dependency ${index + 1}`,
      supportedTargets: { codex: ['user' as const], claude: [] },
      configFieldCount: 0,
    })));
    loaded.payload.targets.push(...targetIds.slice(0, -1).map((pluginId) => target({
      pluginName: pluginId.split('/')[1]!,
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    })));
    const plan: DependencyOperationPlan = {
      dependencyPlanSchemaVersion: 1,
      requestedPluginIds: ['official/agent-lab'],
      resolvedPluginIds: targetIds,
      dependencyEdges: targetIds.slice(0, -1).map((pluginId) => ({ from: 'official/agent-lab', to: pluginId })),
      targets: targetIds.map((pluginId, index) => ({
        pluginId,
        pluginName: pluginId.split('/')[1]!,
        platform: 'codex' as const,
        requestedScope: 'user' as const,
        resolvedScope: 'user' as const,
        relation: index === targetIds.length - 1 ? 'requested' as const : 'dependency' as const,
        requiredBy: index === targetIds.length - 1 ? [] : ['official/agent-lab'],
        state: 'absent' as const,
        action: 'install' as const,
        order: index + 1,
      })),
    };
    const value = new TuiController({
      ...controller().dependencies,
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn(() => execution.promise),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    const running = value.executeOperation(review.reviewToken);
    const visibleCounts: number[] = [];
    for (const size of [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ]) {
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      const frame = instance.lastFrame() ?? '';
      visibleCounts.push(frame.match(/Progress Target \d+/gu)?.length ?? 0);
      expect(frame).toContain('执行目标');
      expect(frame).toContain('? 帮助');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }
    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    execution.resolve({ targetResults: [] });
    await running;
  });

  it('renders multiple saved result messages with standard and compact viewport budgets', async () => {
    const progress = createRebuildProgressFeed();
    const value = new TuiController({
      ...controller().dependencies,
      executeIntent: vi.fn(async () => {
        for (let index = 1; index <= 10; index += 1) {
          progress.addNotice({ level: 'notice', identity: `message-${index}`, message: `safe ${index}` });
        }
        return {
          configWrite: 'succeeded',
          overallState: 'succeeded',
          apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        };
      }),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'configSave', pluginId: 'team-tools/review-gate', scope: 'user', projectLayer: 'shared', apply: false, updates: { mode: 'safe' },
    });
    await value.executeOperation(review.reviewToken);

    const standard = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const standardFrame = standard.lastFrame() ?? '';
    expect(standardFrame.match(/收到通知/g)).toHaveLength(4);
    expect(standardFrame.match(/›/g)).toHaveLength(1);
    standard.unmount();

    const compact = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const compactFrame = compact.lastFrame() ?? '';
    expect(compactFrame.match(/收到通知/g)).toHaveLength(2);
    expect(compactFrame.match(/›/g)).toHaveLength(1);
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('bounds many Result targets and keeps the last action with HelpBar at 60x18', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        targetResults: Array.from({ length: 12 }, (_, index) => ({
          target: { pluginId: `official/target-${index}`, platform: 'codex' as const, scope: 'user' as const },
          state: 'completed' as const,
        })),
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('↓ 后面还有');
    expect(instance.lastFrame()).toContain('9 个目标');
    expect(instance.lastFrame()).not.toContain('变更：undefined');
    let targetPages = instance.lastFrame() ?? '';
    for (let page = 0; page < 15; page += 1) {
      await input(instance, '\u001B[6~');
      targetPages += instance.lastFrame() ?? '';
    }
    expect(instance.lastFrame()).toContain('target-11');
    for (let index = 0; index < 12; index += 1) {
      expect(targetPages).toContain(`target-${index}`);
    }
    expect(instance.lastFrame()).toContain('↑ 前面还有');
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 返回首页');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
  });

  it('grows a large dependency result target viewport with available terminal rows', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        targetResults: Array.from({ length: 12 }, (_, index) => ({
          target: { pluginId: `official/result-target-${index + 1}`, platform: 'codex' as const, scope: 'user' as const },
          state: 'completed' as const,
        })),
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);

    const visibleCounts: number[] = [];
    for (const size of [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ]) {
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      const frame = instance.lastFrame() ?? '';
      visibleCounts.push(frame.match(/result-target-\d+/gu)?.length ?? 0);
      await input(instance, '\u001B[B');
      expect(instance.lastFrame()).toContain('› 返回首页');
      expect(instance.lastFrame()).toContain('? 帮助');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }
    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    expect(visibleCounts[2]).toBe(12);
  });

  it('keeps the last source action visible with HelpBar at 60x18', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    await input(instance, ...Array.from({ length: 4 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› 技术详情');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
  });

  it('uses the light source check for r and keeps full validation separate', async () => {
    const value = controller();
    await value.load();
    const recheck = vi.spyOn(value, 'recheckCatalogSource').mockResolvedValue(undefined);
    const fullValidate = vi.spyOn(value, 'fullValidateCatalogSource');
    const reload = vi.spyOn(value, 'reloadCatalog');
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('重新检查');
    expect(instance.lastFrame()).toContain('完整验证');
    await input(instance, 'r');

    expect(recheck).toHaveBeenCalledWith('team-tools');
    expect(fullValidate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('keeps all source detail actions reachable at %ix%i and opens the focused technical route', async (columns, rows) => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('远端 Catalog 检查失败');

    for (const [index, label] of ['重新检查', '编辑来源…', '设为主来源…', '移除来源…', '技术详情'].entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    }

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceTechnical', sourceId: 'team-tools' });
  });

  it('shows no-Active recovery and redacts every unavailable-source technical field', async () => {
    const privateFailure = 'native stderr Authorization: Bearer bearer-secret '
      + 'https://alice:url-secret@example.test/catalog?access_token=query-secret '
      + '/Users/private-user /workspace/private /tmp/private /private/source/root';
    const unavailableLoad = loadResult();
    unavailableLoad.payload.catalog.sources = unavailableLoad.payload.catalog.sources.map((source) =>
      source.id === 'research' ? {
        ...source,
        type: 'git' as const,
        requestedRef: 'https://alice:url-secret@example.test/catalog?access_token=query-secret',
        error: privateFailure,
        errorCode: 'catalogSourceUnavailable',
      } : source);
    unavailableLoad.sourceDetails = unavailableLoad.sourceDetails?.map((source) =>
      source.id === 'research' ? {
        ...source,
        type: 'git' as const,
        requestedRef: 'catalog/stable',
        resolvedCommit: 'Authorization: Bearer commit-secret',
        locationSummary: 'Git 仓库位置已隐藏',
        errorCode: 'catalogSourceUnavailable',
      } : source);
    const unavailable = controller({ loadStatus: vi.fn().mockResolvedValue(unavailableLoad) });
    await unavailable.load();
    unavailable.push({ name: 'sourceDetail', sourceId: 'research' });
    const unavailableInstance = render(<ConsoleAppV4 controller={unavailable} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const unavailableDefault = unavailableInstance.lastFrame() ?? '';
    expect(unavailableDefault).toContain('来源没有可用的启用版本');
    expect(unavailableDefault).toContain('获取并启用');
    expect(unavailableDefault).not.toContain('aw catalog source sync research');
    expect(unavailableDefault).not.toContain('catalogSourceUnavailable');
    for (const privateText of ['native stderr', 'bearer-secret', 'alice', 'url-secret', 'query-secret',
      '/Users/private-user', '/workspace/private', '/tmp/private', '/private/source/root']) {
      expect(unavailableDefault).not.toContain(privateText);
    }
    await input(unavailableInstance, ...Array.from({ length: 4 }, () => '\u001B[B'), '\r');
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceTechnical', sourceId: 'research' });
    const unavailableTechnical = unavailableInstance.lastFrame() ?? '';
    expect(unavailableTechnical).toContain('catalogGenerationUnavailable');
    expect(unavailableTechnical).toContain('resolve-source');
    expect(unavailableTechnical).not.toContain('last good');
    expect(unavailableTechnical).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    expect(unavailableTechnical).not.toContain('sha256:');
    for (const privateText of ['native stderr', 'Authorization', 'Bearer', 'bearer-secret', 'alice', 'url-secret', 'query-secret',
      '/Users/private-user', '/workspace/private', '/tmp/private', '/private/source/root', 'commit-secret']) {
      expect(unavailableTechnical).not.toContain(privateText);
    }
    await input(unavailableInstance, '\r');
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'research' });
  });

  it('opens source editing from the unavailable source issue edit action', async () => {
    const value = controller();
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'sourceUnavailable')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('› 编辑来源');
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceEdit', sourceId: 'research' });
  });

  it('shows platform state diagnostics as a safe product layer before the technical layer', async () => {
    const loaded = loadResult();
    loaded.payload.errors = [{
      code: 'nativeStateUnreadable',
      message: 'stderr Authorization: Bearer platform-secret /Users/private/platform',
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.issueId === 'status:nativeStateUnreadable')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('当前不能安全读取平台状态');
    expect(productFrame).toContain('现有安装和已保存设置不会因本页自动改变');
    expect(productFrame).toContain('下一步');
    expect(productFrame).not.toContain('nativeStateUnreadable');
    expect(productFrame).not.toContain('platform-secret');
    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('nativeStateUnreadable');
    expect(technicalFrame).toContain('read-platform-state');
    expect(technicalFrame).not.toContain('platform-secret');
    expect(technicalFrame).not.toContain('/Users/private/platform');
  });

  it('uses the shared diagnostic summary from the platform route and preserves its typed issue action', async () => {
    const loaded = loadResult();
    loaded.payload.targets = loaded.payload.targets.map((entry) => entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex' && entry.scope === 'user'
      ? {
          ...entry,
          state: 'error' as const,
          errors: [{
            code: 'nativeTargetUnreadable',
            message: 'native stderr Bearer platform-route-secret /Users/private/platform-route',
            severity: 'blocking',
          }],
        }
      : entry);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('现有安装和已保存设置不会因本页自动改变');
    expect(productFrame).toContain('› 查看对应问题');
    expect(productFrame).not.toContain('nativeTargetUnreadable');
    expect(productFrame).not.toContain('platform-route-secret');

    await input(instance, '\r', 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('nativeTargetUnreadable');
    expect(technicalFrame).toContain('read-platform-state');
    expect(technicalFrame).not.toContain('platform-route-secret');
  });

  it('shows dependency diagnostics without exposing the status message and keeps recovery actions', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyMissing',
      rootErrorMessage: 'dependencyMissing: official/skill-toolkit Authorization: Bearer dependency-secret /tmp/source',
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'dependencyMissing')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('查看依赖关系');
    expect(productFrame).toContain('现有安装和已保存设置不会因本页自动改变');
    expect(productFrame).not.toContain('dependencyMissing');
    expect(productFrame).not.toContain('dependency-secret');
    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('dependencyMissing');
    expect(technicalFrame).toContain('resolve-dependencies');
    expect(technicalFrame).not.toContain('dependency-secret');
    expect(technicalFrame).not.toContain('/tmp/source');
  });

  it('keeps typed config failure information without exposing the rejected Error', async () => {
    const getConfigPage = vi.fn().mockRejectedValue(Object.assign(
      new Error('stderr token=config-secret /Users/private/config'),
      { code: 'configReadFailed' },
    ));
    const value = controller({ getConfigPage });
    await value.load();
    value.push({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configUnavailable',
      diagnosticCode: 'configReadFailed',
      diagnosticStage: 'read-config',
    });
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('当前无法取得可信的字段定义');
    expect(productFrame).toContain('已保存的设置保持不变');
    expect(productFrame).toContain('修复插件来源');
    expect(productFrame).not.toContain('aw catalog source sync team-tools');
    expect(productFrame).not.toContain('configReadFailed');
    expect(productFrame).not.toContain('config-secret');
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('configReadFailed');
    expect(technicalFrame).toContain('read-config');
    expect(technicalFrame).not.toContain('config-secret');
    expect(technicalFrame).not.toContain('sha256:');
  });

  it('uses the shared diagnostic layers for Portable blockers and keeps its recovery flow', async () => {
    const value = controller();
    await value.load();
    value.push({
      name: 'portableBlocker',
      pluginId: 'official/agent-lab',
      code: 'portableValidationFailed',
      diagnosticCode: 'portableSkillInvalid',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('候选 Skill 没有通过 Portable 安全校验');
    expect(productFrame).toContain('Portable 草稿保持不变');
    expect(productFrame).toContain('重新检查');
    expect(productFrame).toContain('返回插件预览');
    expect(productFrame).not.toContain('portableSkillInvalid');
    await input(instance, '\u001B[B', '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('portableSkillInvalid');
    expect(technicalFrame).toContain('prepare-portable');
    expect(technicalFrame).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('返回插件预览');
  });

  it('ignores a second Enter after the Review primary action becomes busy', async () => {
    const execution = deferred<unknown>();
    const executeIntent = vi.fn(() => execution.promise);
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent,
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    instance.stdin.write('\r');
    instance.stdin.write('\r');
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');
    expect(instance.lastFrame()).not.toContain('reviewTicketInvalid');
    expect(executeIntent).toHaveBeenCalledTimes(1);
    execution.resolve({
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(4);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(value.snapshot.result).toMatchObject({
      state: 'succeeded', operationId: review.operationId,
    });
  });

  it('retries only the failed target with the canonical plugin identity', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/agent-lab',
      platform: 'both',
      scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.activeReview).toMatchObject({
      pluginAction: 'install',
      subject: { sourceLabel: 'official' },
      changes: expect.arrayContaining([
        expect.objectContaining({
          group: 'requested', pluginId: 'official/agent-lab', kind: 'add',
          title: 'Claude Code · 所有项目',
        }),
      ]),
    });
  });

  it.each(['install', 'refreshAndSync'] as const)(
    'retries a reloaded partial target with reinstall after a failed %s',
    async (originalAction) => {
      const before = loadResult();
      const after = loadResult();
      const targetAfterReload = after.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'claude'
        && entry.scope === 'user');
      if (targetAfterReload) targetAfterReload.state = 'partial';
      const value = controller({
        loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
        executeIntent: vi.fn().mockResolvedValue({ targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ] }),
      });
      await value.load();
      const review = await value.buildOperationReview({
        kind: 'pluginWrite', action: originalAction, pluginId: 'official/agent-lab', platform: 'both', scope: 'user',
      });
      await value.executeOperation(review.reviewToken);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await nextTurn(2);

      await input(instance, '\u001B[B', '\r');
      await nextTurn(3);

      expect(value.snapshot.activeReview).toMatchObject({
        pluginAction: 'reinstall',
        originIssue: expect.objectContaining({ actionId: 'reinstall' }),
        changes: expect.arrayContaining([expect.objectContaining({ title: 'Claude Code · 所有项目' })]),
      });
      instance.unmount();
      instance.cleanup();
    },
  );

  it('opens the canonical reloaded partial issue instead of a synthesized error route', async () => {
    const before = loadResult();
    const after = loadResult();
    const failed = after.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'claude'
      && entry.scope === 'user');
    if (failed) failed.state = 'partial';
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'both', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'issueDetail',
      issueId: 'incompleteInstallation:official/agent-lab:claude:user',
    });
  });

  it('shows a new review after the locked executor reports stale evidence before business writes', async () => {
    const changed = { ...evidence, targetFingerprint: 'sha256:changed' };
    const businessWrite = vi.fn();
    const executeIntent = vi.fn(async (
      _intent: Parameters<TuiControllerDependencies['executeIntent']>[0],
      expected: OperationEvidence,
    ) => {
      if (expected.targetFingerprint !== changed.targetFingerprint) {
        throw new Error('operationReviewStale: locked target evidence changed');
      }
      return businessWrite();
    });
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValue(changed);
    const value = controller({
      captureEvidence,
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({ kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'both', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await confirmReview(instance, value);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(businessWrite).not.toHaveBeenCalled();
    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(instance.lastFrame()).toContain('状态已变化');
    expect(instance.lastFrame()).toContain('再次确认');
  });

  it('restores list context and keeps 60x18 and 80x24 frames within their row budgets', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const value = controller();
      value.push({ name: 'pluginList', mode: 'browse' }, { focusIndex: 1, query: 'review', sourceTabId: 'all' });
      value.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);
      await input(instance, 'b');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('/ review');
      expect(frame).toContain('Review Gate');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      if (size.columns === 60) expect(frame).toMatch(/来源\s+\[全部\]\s+1 \/ 4/);
    }
  });

  it('keeps the browse install filter with source, query, preview, and Back navigation', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'f', '\u001B[C', ']');
    expect(instance.lastFrame()).toContain('没有匹配插件');
    expect(instance.lastFrame()).not.toContain('团队发布审查');
    await input(instance, '[', '/', 'review');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('[未安装]');
    expect(instance.lastFrame()).toContain('› Review Gate');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse', sourceId: 'official' });

    await input(instance, ']');
    expect(instance.lastFrame()).toContain('没有匹配插件');
    expect(instance.lastFrame()).not.toContain('团队发布审查');
    await input(instance, '[');
    expect(instance.lastFrame()).toContain('› Review Gate');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginPreview', pluginId: 'official/review-gate' });

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse', sourceId: 'official' });
    expect(value.snapshot.router.current.context).toMatchObject({
      query: 'review',
      installFilter: 'uninstalled',
      sourceTabId: 'official',
    });
    expect(instance.lastFrame()).toContain('[未安装]');
    expect(instance.lastFrame()).toContain('/ review');
    expect(instance.lastFrame()).toContain('› Review Gate');
  });

  it('treats search shortcut letters as query text and keeps the query after Esc', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '/', 'fjkbq');
    expect(instance.lastFrame()).toContain('fjkbq▌');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('fjkbq');
    expect(instance.lastFrame()).toContain('/ 编辑');
    expect(instance.lastFrame()).not.toContain('退出控制台？');
  });

  it.each([
    [60, 18],
    [80, 24],
  ] as const)('keeps a complex search cursor visible and bounded at %i x %i', async (columns, rows) => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(4);

    await input(instance, '/', `${'前'.repeat(35)}😀🇨🇳👨‍👩‍👧‍👦e\u0301中文`, '\u007f');

    const frame = instance.lastFrame()!;
    expect(frame).toContain('▌');
    expect(frame).not.toContain('中文▌');
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(Math.max(...frame.split('\n').map((line) => stringWidth(line)))).toBeLessThanOrEqual(columns);
  });

  it('uses the same Arrow or Enter event to leave search and navigate or open a result', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '/', 'review', '\u001B[B');
    expect(instance.lastFrame()).toMatch(/› Review Gate\s+team-tools/u);
    expect(instance.lastFrame()).not.toContain('review▌');
    await input(instance, '/', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginPreview',
      pluginId: 'team-tools/review-gate',
    });
  });

  it('keeps source and status visible when a plugin name is truncated at 60 columns', async () => {
    const data = loadResult();
    const displayName = 'This Plugin Name Is Intentionally Much Too Long For The Available Width';
    data.pluginSummaries = [{
      pluginName: 'long-name',
      pluginId: 'team-tools/long-name',
      displayName,
      description: '用途说明',
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }];
    data.payload.targets = [target({ pluginName: 'long-name', sourceId: 'team-tools', platform: 'codex', scope: 'user', state: 'absent' })];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('team-tools');
    expect(frame).toContain('未添加');
    expect(frame).not.toContain(displayName);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('keeps the current longest legal source tab and last plugin focus visible on one line at 80x24', async () => {
    const data = loadResult();
    const sourceIds = Array.from({ length: 4 }, (_, index) => `${String(index + 1).repeat(31)}a`);
    data.payload.catalog.sources = sourceIds.map((id, index) => ({
      id,
      identity: `identity:${id}`,
      type: 'path' as const,
      primary: index === 0,
      requestedRef: 'path',
      freshness: 'active' as const,
    }));
    data.payload.catalog.primarySourceId = sourceIds[0]!;
    data.pluginSummaries = sourceIds.flatMap((sourceId, sourceIndex) =>
      Array.from({ length: sourceIndex === sourceIds.length - 1 ? 8 : 1 }, (_, pluginIndex) => ({
        pluginName: `source-${sourceIndex}-plugin-${pluginIndex}`,
        pluginId: `${sourceId}/source-${sourceIndex}-plugin-${pluginIndex}`,
        displayName: `Source ${sourceIndex + 1} Plugin ${pluginIndex + 1}`,
        description: `Description ${pluginIndex + 1}`,
        supportedTargets: { codex: ['user' as const], claude: [] },
        configFieldCount: 0,
      })));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      sourceId: summary.pluginId.split('/')[0],
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    }));
    data.sourceDetails = data.payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: `已选择本地目录（${source.id}）`,
      pluginCount: data.pluginSummaries.filter((plugin) => plugin.pluginId.startsWith(`${source.id}/`)).length,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      freshness: source.freshness,
      configDigest: 'sha256:config',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, ']', ']', ']', ']');
    expect(instance.lastFrame()).toContain(`[${sourceIds.at(-1)}]  5 / 5`);
    await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('› Source 4 Plugin 8');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('grows the same plugin viewport with terminal rows and keeps the last focus visible', async () => {
    const sizes = [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ];
    const visibleCounts: number[] = [];
    for (const size of sizes) {
      const data = loadResult();
      data.pluginSummaries = Array.from({ length: 8 }, (_, index) => ({
        pluginName: `viewport-${index + 1}`,
        pluginId: `official/viewport-${index + 1}`,
        displayName: `Viewport Plugin ${index + 1}`,
        description: `Viewport description ${index + 1}`,
        supportedTargets: { codex: ['user'], claude: [] },
        configFieldCount: 0,
      }));
      data.payload.targets = data.pluginSummaries.map((summary) => target({
        pluginName: summary.pluginName,
        platform: 'codex',
        scope: 'user',
        state: 'absent',
      }));
      data.payload.catalog.sources = [data.payload.catalog.sources[0]!];
      data.sourceDetails = data.sourceDetails?.filter((source) => source.id === 'official');
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
      value.push({ name: 'pluginList', mode: 'browse' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);

      const initialFrame = instance.lastFrame() ?? '';
      visibleCounts.push(initialFrame.match(/Viewport Plugin \d+/gu)?.length ?? 0);
      expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
      await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
      expect(instance.lastFrame()).toContain('› Viewport Plugin 8');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }

    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    expect(visibleCounts[2]).toBe(8);
  });

  it('keeps the focused item visible in a 60x18 viewport and opens that exact item', async () => {
    const data = loadResult();
    data.pluginSummaries = Array.from({ length: 8 }, (_, index) => ({
      pluginName: `plugin-${index + 1}`,
      pluginId: `official/plugin-${index + 1}`,
      displayName: `Plugin ${index + 1}`,
      description: `Description ${index + 1}`,
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, ...Array.from({ length: 6 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› Plugin 7');
    expect(instance.lastFrame()).not.toContain('Plugin 1');
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginPreview',
      pluginId: 'official/plugin-7',
    });
  });

  it('keeps plugin and issue focus visible at item 10 in an 80x24 viewport and opens the exact object', async () => {
    const data = loadResult();
    data.pluginSummaries = Array.from({ length: 12 }, (_, index) => ({
      pluginName: `plugin-${String(index + 1).padStart(2, '0')}`,
      pluginId: `official/plugin-${String(index + 1).padStart(2, '0')}`,
      displayName: `Plugin ${String(index + 1).padStart(2, '0')}`,
      description: `Description ${index + 1}`,
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'user',
      state: 'partial',
    }));
    data.payload.catalog.sources = [data.payload.catalog.sources[0]!];
    data.sourceDetails = data.sourceDetails?.filter((source) => source.id === 'official');
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse' });
    const plugins = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(plugins, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(plugins.lastFrame()).toContain('› Plugin 10');
    expect(plugins.lastFrame()).not.toContain('Plugin 01');
    await input(plugins, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginPreview', pluginId: 'official/plugin-10' });
    plugins.unmount();

    value.push({ name: 'issueList' });
    const issues = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(issues, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(issues.lastFrame()).toContain('› official/plugin-10');
    expect(issues.lastFrame()).not.toContain('official/plugin-01');
    await input(issues, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'issueDetail',
      issueId: 'incompleteInstallation:official/plugin-10:codex:user',
    });
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('keeps source 10 visible and opens its exact identity at $columns x $rows', async (size) => {
    const data = loadResult();
    data.payload.catalog.sources = Array.from({ length: 10 }, (_, index) => ({
      id: `source-${String(index + 1).padStart(2, '0')}`,
      identity: `identity:source-${index + 1}`,
      type: 'path' as const,
      primary: index === 0,
      requestedRef: 'path',
      freshness: 'active' as const,
    }));
    data.sourceDetails = data.payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: `已选择本地目录（${source.id}）`,
      pluginCount: 0,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      freshness: source.freshness,
      configDigest: 'sha256:config',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(2);
    await input(instance, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› source-10');
    expect(instance.lastFrame()).not.toContain('source-01');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'source-10' });
  });

  it('masks absolute source paths in input frames while preserving editing', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceList' });
    const source = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(source, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\u001B[B', '\r', ...'private-source'.split(''), '\r');
    const privateSourcePath = '/Users/alice/private/catalog';
    await input(source, ...privateSourcePath.split(''));
    expect(source.lastFrame()).toContain('已选择 / … / catalog');
    expect(source.lastFrame()).not.toContain('/Users/alice/private');
    expect(source.lastFrame()).toContain('已隐藏父目录');
  });

  it('renders only the minimum-size hint and ignores business input below 60x18', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 59, rows: 18 }} onExit={exit} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('请将终端调整到至少 60 列 × 18 行');
    expect(instance.lastFrame()).not.toContain('添加插件');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginList');
    await input(instance, 'q');
    expect(exit).toHaveBeenCalledOnce();
  });

  it('uses visible group tabs and opens a focused effective field through layer selection into its editor', async () => {
    const reached = new Set<ConsoleV4ScreenId>();
    const getConfigPage = vi.fn(async (
      pluginId: string,
      layer: ConfigPageViewModel['layer'],
    ) => {
      const page = configPage(pluginId);
      return {
        ...page,
        layer,
        groups: layer.scope === 'effective'
          ? page.groups.map((group) => ({
              ...group,
              fields: group.fields.map((field) => ({
                ...field,
                displayValue: field.effectiveDisplayValue,
                sourceLabel: field.effectiveSourceLabel,
                ...(field.effectiveValue !== undefined ? { value: field.effectiveValue } : {}),
              })),
            }))
          : page.groups,
      };
    });
    const value = controller({ getConfigPage });
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => reached.add(screen)}
    />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(reached).toContain('C02');
    const effectiveFrame = instance.lastFrame() ?? '';
    expect(effectiveFrame).toContain('当前插件设置');
    expect(effectiveFrame).toContain('基本设置');
    expect(effectiveFrame).toContain('来自个人默认');
    expect(effectiveFrame).toContain('没有任何位置提供值');
    expect(effectiveFrame).not.toContain('保存修改');
    expect(effectiveFrame).toContain('快速方案 1');
    expect(effectiveFrame).toContain('› level');
    expect(effectiveFrame).not.toContain('/Users/private');

    const depth = value.snapshot.router.depth;
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.context.configGroupId).toBe('advanced');
    expect(instance.lastFrame()).toContain('› model');
    expect(instance.lastFrame()).not.toContain('› level');
    await input(instance, '\u001B[D');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(instance.lastFrame()).toContain('› level');

    await input(instance, '\r');
    expect(reached).toContain('C01');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configLayer', fieldKey: 'level', groupId: 'basic',
    });
    const chooserFrame = instance.lastFrame() ?? '';
    expect(chooserFrame).toContain('修改“level”');
    expect(chooserFrame).toContain('个人默认');
    expect(chooserFrame).toContain('当前项目');
    expect(chooserFrame).not.toContain('有效设置');
    const layerRoute = value.snapshot.router.current.route;
    await input(instance, '\t');
    expect(value.snapshot.router.current.route).toEqual(layerRoute);

    await input(instance, '\r');
    await nextTurn(3);
    expect(reached).toContain('C04');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, '\r');
    expect(reached).toContain('C05');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'level',
    });
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'user' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });
    expect(instance.lastFrame()).toContain('› level');
    expect(instance.lastFrame()).toContain('平衡');
  });

  it('opens the preview settings action on the effective read-only homepage', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    value.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'configFields',
      pluginId: 'official/review-gate',
      layer: { scope: 'effective' },
    });
    expect(instance.lastFrame()).toContain('当前插件设置');
    expect(instance.lastFrame()).not.toContain('保存修改');
  });

  it('uses preset-first scalar choices and retains invalid Core-validated input', async () => {
    const page = configPage();
    const getConfigPage = vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer }));
    const closed = controller({ getConfigPage });
    closed.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    closed.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'level',
      editor: 'string',
      mode: 'choices',
    });
    const closedInstance = render(<ConsoleAppV4 controller={closed} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(closedInstance.lastFrame()).toContain('快速');
    expect(closedInstance.lastFrame()).toContain('平衡（推荐）');
    expect(closedInstance.lastFrame()).not.toContain('自定义');

    closedInstance.unmount();
    const invalidPage = configPage();
    const note = invalidPage.groups[0]!.fields.find((field) => field.key === 'note')!;
    note.definition = { type: 'string', validation: { pattern: '^[A-Z]+$', maxLength: 20 } };
    const invalid = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...invalidPage, pluginId, layer })),
    });
    invalid.push({ name: 'configFields', pluginId: invalidPage.pluginId, layer: { scope: 'user' } });
    invalid.push({
      name: 'configFieldEditor',
      pluginId: invalidPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'note',
      editor: 'string',
      mode: 'custom',
    });
    const invalidInstance = render(<ConsoleAppV4 controller={invalid} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(invalidInstance, 'bad', '\r');
    expect(invalid.snapshot.router.current.route.name).toBe('configFieldEditor');
    expect(invalidInstance.lastFrame()).not.toContain('pattern');
    expect(invalidInstance.lastFrame()).toContain('Expected a value that matches');
    expect(invalidInstance.lastFrame()).toContain('bad');
  });

  it('keeps top-level boolean presets closed or open and saves the actual value', async () => {
    const page = configPage();
    const field = page.groups[0]!.fields.find((candidate) => candidate.key === 'enabled')!;
    field.definition = {
      type: 'boolean',
      choices: {
        allowCustom: false,
        presets: [{ id: 'on', title: '仅开启', value: true, recommended: true }],
      },
    };
    field.choices = [{ id: 'on', title: '仅开启', value: true, recommended: true }];
    field.allowCustom = false;
    field.configured = false;
    field.inherited = true;
    delete field.value;
    delete field.draftValue;
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'enabled',
      editor: 'boolean',
      mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('仅开启（推荐）');
    expect(instance.lastFrame()).not.toContain('○ 关闭');
    await input(instance, '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      updates: { enabled: true },
    }), evidence);

    instance.unmount();
    const openPage = configPage();
    const openField = openPage.groups[0]!.fields.find((candidate) => candidate.key === 'enabled')!;
    openField.definition = {
      type: 'boolean',
      choices: {
        allowCustom: true,
        presets: [{ id: 'on', title: '开启方案', value: true }],
      },
    };
    openField.choices = [{ id: 'on', title: '开启方案', value: true }];
    openField.allowCustom = true;
    const open = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...openPage, pluginId, layer })),
    });
    open.push({ name: 'configFields', pluginId: openPage.pluginId, layer: { scope: 'user' } });
    open.push({
      name: 'configFieldEditor',
      pluginId: openPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'enabled',
      editor: 'boolean',
      mode: 'choices',
    });
    const openInstance = render(<ConsoleAppV4 controller={open} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const openFrame = openInstance.lastFrame() ?? '';
    expect(openFrame).toContain('开启方案');
    expect(openFrame).toContain('关闭');
    expect(openFrame.match(/开启方案/gu)).toHaveLength(1);
    expect(openFrame).not.toContain('自定义…');
  });

  it('edits a mixed fixed and dynamic object from the effective seed and reviews one full top-level update', async () => {
    const page = objectConfigPage();
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
    const onSessionNavigation = vi.fn(async (
      _navigation: 'home' | 'reload',
      options?: { discardDrafts?: boolean },
    ) => value.hasSessionDraft && !options?.discardDrafts ? 'draftBlocked' as const : 'completed' as const);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('服务方案（推荐）');
    expect(instance.lastFrame()).toContain('自定义');

    await input(instance, '\u001B[B', '\r');
    const seededFrame = instance.lastFrame() ?? '';
    expect(seededFrame).toContain('草稿来自当前完整有效对象');
    expect(seededFrame).toContain('legacy');
    expect(seededFrame).toContain('令牌');
    expect(seededFrame).not.toContain('SECRET-BYTES');

    await input(instance, '\r', '\r', 'hHqb');
    expect(instance.lastFrame()).toContain('AlicehHqb');
    expect(onSessionNavigation).not.toHaveBeenCalled();
    await input(instance, ...Array.from({ length: 9 }, () => '\u007F'), 'bad-name', '\r');
    expect(instance.lastFrame()).toContain('format');
    expect(instance.lastFrame()).toContain('bad-name');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configObjectPropertyEditor', propertyKey: 'owner', stage: 'custom',
    });
    await input(instance, ...Array.from({ length: 8 }, () => '\u007F'), 'Bob', '\r');

    await input(instance, 'h');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(instance.lastFrame()).toContain('继续编辑');
    await input(instance, '\r');
    expect(value.hasSessionDraft).toBe(true);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'settings', editor: 'object',
    });

    await input(instance, ...Array.from({ length: 3 }, () => '\u001B[B'), '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).not.toContain('legacy');
    await input(instance, '\r', 'new_key', '\r', 'ready', '\r');
    expect(instance.lastFrame()).toContain('new_key');
    expect(instance.lastFrame()).not.toContain('SECRET-BYTES');

    await input(instance, ...Array.from({ length: 2 }, () => '\u001B[B'), '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '个人默认 · 服务设置',
        description: expect.stringContaining('owner: Alice → Bob'),
      }),
    ]));
    expect(instance.lastFrame()).toContain('设置变更');
    expect(instance.lastFrame()).toContain('3 个子');
    expect(instance.lastFrame()).not.toContain('SECRET-BYTES');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      updates: {
        settings: {
          owner: 'Bob',
          region: 'west',
          token: 'SECRET-BYTES',
          new_key: 'ready',
        },
      },
    }), evidence);
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('keeps one object focus and its add/save actions visible at $columns x $rows', async (size) => {
    const page = objectConfigPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'custom',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('添加键值');
    expect(frame).toContain('使用此完整对象');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
  });

  it('stores the actual complete object value selected by an object preset', async () => {
    const page = objectConfigPage();
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).not.toContain('preset-secret');
    await input(instance, '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('3 个子项变化');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('owner: Alice → Service');
    expect(instance.lastFrame()).toContain('已设置 · 3 项');
    expect(instance.lastFrame()).not.toContain('方案“服务方案”');
    expect(instance.lastFrame()).not.toContain('preset-secret');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      updates: {
        settings: { owner: 'Service', region: 'west', token: 'preset-secret' },
      },
    }), evidence);
  });

  it('does not show which object preset matches a sensitive child and still applies a selected preset', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    const first = field.choices![0]!;
    const second = {
      ...first,
      id: 'service-b',
      title: '备用服务方案',
      value: { owner: 'Service', region: 'west', token: 'other-preset-secret' },
    };
    field.choices = [first, second];
    if (field.definition.type !== 'object' || !field.definition.choices) {
      throw new Error('expected object choices fixture');
    }
    field.definition.choices.presets = [first, second];
    field.draftValue = first.value;
    field.effectiveValue = first.value;
    field.effectiveDisplayValue = '已设置 · 3 项';
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const editorFrame = instance.lastFrame() ?? '';
    expect(editorFrame).toContain('○ 服务方案');
    expect(editorFrame).toContain('○ 备用服务方案');
    expect(editorFrame).not.toContain('● 服务方案');
    expect(editorFrame).not.toContain('preset-secret');

    await input(instance, '\u001B[B', '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('token: 已设置 → 将更新');
    expect(value.snapshot.activeReview?.changes[0]?.description).not.toContain('服务方案');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('preset-secret');
    expect(instance.lastFrame()).not.toContain('preset-secret');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      updates: { settings: second.value },
    }), evidence);
  });

  it('does not show which object preset matches sensitive additional properties', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    if (field.definition.type !== 'object') throw new Error('expected object fixture');
    const presets = [
      { id: 'primary', title: '主账户', value: { account: 'secret-a' } },
      { id: 'secondary', title: '备用账户', value: { account: 'secret-b' } },
    ];
    field.definition.properties = {};
    field.definition.additionalProperties = { type: 'string', sensitive: true };
    field.definition.choices = { allowCustom: true, presets };
    field.choices = presets;
    field.draftValue = presets[0]!.value;
    field.effectiveValue = presets[0]!.value;
    field.effectiveDisplayValue = '已设置 · 1 项';
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('已设置 · 1 项');
    expect(instance.lastFrame()).not.toContain('主账户');
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
    await nextTurn(2);
    const editorFrame = instance.lastFrame() ?? '';
    expect(editorFrame).toContain('○ 主账户');
    expect(editorFrame).toContain('○ 备用账户');
    expect(editorFrame).not.toContain('● 主账户');
    expect(editorFrame).not.toContain('secret-a');
  });

  it('uses a closed child choice without a custom route', async () => {
    const page = objectConfigPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configObjectPropertyEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'region',
      dynamic: false,
      stage: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('西区');
    expect(frame).toContain('东区');
    expect(frame).not.toContain('自定义');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('saves a closed true-only fixed boolean child and offers only missing KV custom values', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    if (field.definition.type !== 'object') throw new Error('expected object fixture');
    field.definition.properties = {
      enabled: {
        type: 'boolean',
        title: '启用模式',
        choices: {
          allowCustom: false,
          presets: [{ id: 'on', title: '仅开启', value: true, recommended: true }],
        },
      },
    };
    field.definition.additionalProperties = false;
    field.definition.validation = undefined;
    field.choices = undefined;
    field.allowCustom = true;
    field.draftValue = {};
    field.effectiveValue = {};
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', editor: 'object', mode: 'custom',
    });
    value.push({
      name: 'configObjectPropertyEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', propertyKey: 'enabled', dynamic: false, stage: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('仅开启（推荐）');
    expect(instance.lastFrame()).not.toContain('○ 关闭');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'settings', editor: 'object',
    });
    expect(instance.lastFrame()).toContain('仅开启');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', pluginId: page.pluginId,
    });
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.operationKind).toBe('configSave');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      updates: { settings: { enabled: true } },
    }), evidence);

    instance.unmount();
    const kvPage = objectConfigPage();
    const kvField = kvPage.groups[0]!.fields[0]!;
    if (kvField.definition.type !== 'object') throw new Error('expected object fixture');
    kvField.definition.properties = {};
    kvField.definition.additionalProperties = {
      type: 'boolean',
      choices: {
        allowCustom: true,
        presets: [{ id: 'on', title: 'KV 开启', value: true, recommended: true }],
      },
    };
    kvField.draftValue = { flag: true };
    kvField.effectiveValue = { flag: true };
    const kv = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...kvPage, pluginId, layer })),
    });
    kv.push({ name: 'configFields', pluginId: kvPage.pluginId, layer: { scope: 'user' } });
    kv.push({
      name: 'configObjectPropertyEditor', pluginId: kvPage.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', propertyKey: 'flag', dynamic: true, stage: 'choices',
    });
    const kvInstance = render(<ConsoleAppV4 controller={kv} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const kvFrame = kvInstance.lastFrame() ?? '';
    expect(kvFrame).toContain('KV 开启（推荐）');
    expect(kvFrame).toContain('关闭');
    expect(kvFrame).not.toContain('○ 开启');
  });

  it('hides existing string children when either the parent or child is sensitive', async () => {
    const parentPage = objectConfigPage();
    const parentField = parentPage.groups[0]!.fields[0]!;
    parentField.sensitive = true;
    parentField.draftValue = { owner: 'PARENT-SECRET', region: 'west' };
    parentField.effectiveValue = parentField.draftValue;
    const parent = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...parentPage, pluginId, layer })),
    });
    parent.push({ name: 'configFields', pluginId: parentPage.pluginId, layer: { scope: 'user' } });
    const parentInstance = render(<ConsoleAppV4 controller={parent} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    parent.push({
      name: 'configObjectPropertyEditor',
      pluginId: parentPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'owner',
      dynamic: false,
      stage: 'custom',
    });
    await nextTurn(2);
    expect(parentInstance.lastFrame()).toContain('输入敏感值');
    expect(parentInstance.lastFrame()).toContain('输入已隐藏');
    expect(parentInstance.lastFrame()).not.toContain('PARENT-SECRET');

    parentInstance.unmount();
    const childPage = objectConfigPage();
    const child = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...childPage, pluginId, layer })),
    });
    child.push({ name: 'configFields', pluginId: childPage.pluginId, layer: { scope: 'user' } });
    const childInstance = render(<ConsoleAppV4 controller={child} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    child.push({
      name: 'configObjectPropertyEditor',
      pluginId: childPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'token',
      dynamic: false,
      stage: 'custom',
    });
    await nextTurn(2);
    expect(childInstance.lastFrame()).toContain('输入敏感值');
    expect(childInstance.lastFrame()).not.toContain('SECRET-BYTES');
  });

  it.each(['key', 'custom'] as const)('clears object property %s input with Ctrl-U without deleting the property', async (stage) => {
    const page = objectConfigPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    value.push({
      name: 'configObjectPropertyEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', ...(stage === 'custom' ? { propertyKey: 'owner' } : {}),
      dynamic: stage === 'key', stage,
    });
    await nextTurn(2);

    await input(instance, ...'temporary-value');
    expect(instance.lastFrame()).toContain('emporary-value');
    expect(instance.lastFrame()).toContain('Ctrl-U 清空输入');
    await input(instance, '\u0015');

    expect(instance.lastFrame()).not.toContain('emporary-value');
    expect(value.snapshot.router.current.route.name).toBe('configObjectPropertyEditor');
    expect(instance.lastFrame()).not.toContain('删除动态键');
  });

  it('does not project sensitive boolean or preset values as the current child choice', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    if (field.definition.type !== 'object') throw new Error('expected object fixture');
    field.definition.properties = {
      ...field.definition.properties,
      enabled: {
        type: 'boolean',
        title: '启用',
        sensitive: true,
        choices: {
          allowCustom: false,
          presets: [
            { id: 'on', title: '敏感开启', value: true },
            { id: 'off', title: '敏感关闭', value: false },
          ],
        },
      },
      mode: {
        type: 'string',
        title: '模式',
        sensitive: true,
        choices: {
          allowCustom: false,
          presets: [
            { id: 'fast', title: '快速方案', value: 'fast-secret' },
            { id: 'safe', title: '安全方案', value: 'safe-secret' },
          ],
        },
      },
    };
    field.draftValue = {
      owner: 'Alice',
      region: 'west',
      token: 'SECRET-BYTES',
      enabled: true,
      mode: 'fast-secret',
    };
    field.effectiveValue = field.draftValue;

    const booleanValue = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    booleanValue.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    booleanValue.push({
      name: 'configObjectPropertyEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'enabled',
      dynamic: false,
      stage: 'choices',
    });
    const booleanInstance = render(<ConsoleAppV4 controller={booleanValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const booleanFrame = booleanInstance.lastFrame() ?? '';
    expect(booleanFrame).toContain('○ 敏感开启');
    expect(booleanFrame).toContain('○ 敏感关闭');
    expect(booleanFrame).not.toContain('● 敏感开启');

    booleanInstance.unmount();
    const choiceValue = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    choiceValue.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    choiceValue.push({
      name: 'configObjectPropertyEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'mode',
      dynamic: false,
      stage: 'choices',
    });
    const choiceInstance = render(<ConsoleAppV4 controller={choiceValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const choiceFrame = choiceInstance.lastFrame() ?? '';
    expect(choiceFrame).toContain('○ 快速方案');
    expect(choiceFrame).toContain('○ 安全方案');
    expect(choiceFrame).not.toContain('● 快速方案');
    expect(choiceFrame).not.toContain('fast-secret');
  });

  it('reviews object unset with inherited preset and redacted child changes', async () => {
    const page = configuredObjectPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'u');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');

    expect(value.snapshot.activeReview?.operationKind).toBe('configSave');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '个人默认 · 删除 服务设置 中的值',
        description: expect.stringContaining('已设置 · 3 项'),
      }),
    ]));
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('owner: Alice → Service');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('token: 已设置 → 将更新');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('CURRENT-SECRET');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('preset-secret');
    expect(instance.lastFrame()).not.toContain('CURRENT-SECRET');
    expect(instance.lastFrame()).not.toContain('preset-secret');
  });

  it('reviews a valid layer reset with inherited object preset and redacted child changes', async () => {
    const page = configuredObjectPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\r');
    await nextTurn(4);

    expect(value.snapshot.activeReview?.operationKind).toBe('configReset');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '个人默认 · 服务设置',
        description: expect.stringContaining('已设置 · 3 项'),
      }),
    ]));
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('owner: Alice → Service');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('token: 已设置 → 将更新');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('CURRENT-SECRET');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('preset-secret');
    expect(instance.lastFrame()).not.toContain('CURRENT-SECRET');
    expect(instance.lastFrame()).not.toContain('preset-secret');
  });

  it('returns editor completion or cancellation to the original mutable field and then restores the config origin', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    await input(instance, '\r', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldAction', fieldKey: 'level' });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'level' });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields',
      layer: { scope: 'user' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields',
      layer: { scope: 'effective' },
    });
    expect(value.snapshot.router.current.context.focusIndex).toBe(0);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail',
      pluginId: 'team-tools/review-gate',
    });
    expect(value.snapshot.router.current.context.focusIndex).toBe(2);
  });

  it.each([
    {
      label: 'preview primary action',
      previous: { name: 'pluginList', mode: 'browse' as const },
      origin: { name: 'pluginPreview', pluginId: 'official/review-gate' } as const,
      openSettings: ['\u001B[B', '\r'],
      leaveResult: '\r',
    },
    {
      label: 'detail Esc',
      previous: { name: 'pluginList', mode: 'installed' as const },
      origin: { name: 'pluginDetail', pluginId: 'team-tools/review-gate' } as const,
      openSettings: ['\u001B[B', '\u001B[B', '\r'],
      leaveResult: '\u001B',
    },
  ])('clears the mounted C14 settings flow for $label and preserves the original Back stack', async ({
    previous,
    origin,
    openSettings,
    leaveResult,
  }) => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
      }),
    });
    value.push(previous);
    value.push(origin);
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(4);

    await input(instance, ...openSettings);
    await nextTurn(3);
    await input(instance, '\r', '\r', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    await input(instance, '\r');
    await nextTurn(5);
    expect(screens).toContain('C14');

    if (leaveResult === '\u001B') {
      instance.stdin.write(leaveResult);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await nextTurn(2);
    } else {
      await input(instance, leaveResult);
    }
    expect(value.snapshot.router.current.route).toEqual(origin);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(previous);
  });

  it('treats Advanced as an ordinary tab without adding a route frame', async () => {
    const page = configPage();
    page.presets = [];
    page.groups = [
      { ...page.groups[0]!, fields: [page.groups[0]!.fields[3]!] },
      {
        id: 'advanced', title: '高级设置', advanced: true,
        fields: [{ ...page.groups[1]!.fields[0]!, title: '字段级高级模型' }],
      },
    ];
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);

    expect(screens).toContain('C03');
    expect(instance.lastFrame()).toContain('高级设置');
    expect(instance.lastFrame()).not.toContain('字段级高级模型');
    const depth = value.snapshot.router.depth;
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.context.configGroupId).toBe('advanced');
    expect(instance.lastFrame()).toContain('字段级高级模型');
    expect(instance.lastFrame()).toContain('› 字段级高级模型');
  });

  it('preserves preset, manifest group, and advanced headings on the mutable settings page', async () => {
    const page = configPage();
    page.groups[0]!.fields = [page.groups[0]!.fields[0]!];
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('快速方案');
    expect(frame).toContain('基本设置');
    expect(frame).toContain('高级设置');
    expect(frame).not.toContain('设置字段');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('applies an effective preset to one selected layer, preserves its draft across tabs, and keeps u field-only', async () => {
    const page = configPage();
    page.presets[0]!.privateFieldTitles = ['token'];
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[C', '\u001B[C');
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    expect(instance.lastFrame()).toContain('› 团队默认');
    expect(instance.lastFrame()).toContain('token需手动输入');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configLayer', presetId: 'team' });
    await input(instance, '\r');
    await nextTurn(5);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'user' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });
    expect(instance.lastFrame()).toContain('2 项未保存');
    expect(instance.lastFrame()).toContain('token需手动输入');
    await input(instance, '\u001B[C', '\u001B[C');
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    await input(instance, '\r');
    expect(value.snapshot.router.current.context.configGroupId).toBe('basic');
    expect(instance.lastFrame()).toContain('2 项未保存');
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain('2 项未保存');
    expect(instance.lastFrame()).toContain('› model');
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toContain('平衡');
    await input(instance, 'u');
    expect(instance.lastFrame()).toContain('恢复继承');

    await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› 查看保存汇总');
    await input(instance, 'u');
    expect(instance.lastFrame()).toContain('2 项未保存');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
  });

  it('does not apply a preset after leaving its mutable layer while the page is loading', async () => {
    const page = configPage();
    let resolveUser!: (page: ConfigPageViewModel) => void;
    const userPage = new Promise<ConfigPageViewModel>((resolve) => {
      resolveUser = resolve;
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => layer.scope === 'user'
        ? userPage
        : { ...page, pluginId, layer }),
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[C', '\u001B[C', '\r', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'user' },
    });
    await input(instance, 'b');
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'effective', projectLayer: 'shared' },
    });

    await input(instance, '\u001B[D', '\u001B[D', '\r', '\r');
    resolveUser({ ...page, layer: { scope: 'user', projectLayer: 'shared' } });
    await nextTurn(5);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('严格');
    expect(instance.lastFrame()).not.toContain('项未保存');
  });

  it('shows one fallback plugin-settings tab when presentation groups are absent', async () => {
    const page = configPage();
    page.presets = [];
    page.groups = [{
      id: 'general', title: '插件设置', advanced: false,
      fields: [page.groups[0]!.fields[0]!],
    }];
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('[插件设置 1]');
    expect(instance.lastFrame()).not.toContain('高级设置');
    expect(instance.lastFrame()).not.toContain('快速方案');
  });

  it('renders config partial retry, reset Review, unavailable terminal state, and compact field viewport', async () => {
    const partialScreens = new Set<ConsoleV4ScreenId>();
    const partialReload = loadResult();
    const failedTarget = partialReload.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'claude'
      && entry.scope === 'user');
    if (failedTarget) failedTarget.state = 'partial';
    const partial = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(loadResult()).mockResolvedValue(partialReload),
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'partial',
        apply: {
          state: 'partial',
          targetResults: [
            { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
            { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
          ],
        },
      }),
    });
    await partial.load();
    partial.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    partial.beginConfigFlow('team-tools/review-gate');
    partial.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const partialInstance = render(<ConsoleAppV4 controller={partial} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => partialScreens.add(screen)} />);
    await nextTurn(4);
    await input(partialInstance, '\u001B[B', '\r', '\u001B[B', '\r');
    await openConfigSave(partialInstance, partial);
    await chooseConfigSave(partialInstance, partial, 'apply');
    await confirmReview(partialInstance, partial);
    await nextTurn(4);
    expect(partialScreens).toContain('C15');
    expect(partialInstance.lastFrame()).toContain('部分应用失败');
    expect(partialInstance.lastFrame()).toContain('删除字段或重置设置层');
    expect(partialInstance.lastFrame()).toContain('选择清理');
    expect(partialInstance.lastFrame()).toContain('重新安装或同步');
    await input(partialInstance, '\u001B[B', '\r');
    expect(partial.snapshot.router.current.route).toMatchObject({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
    expect(partial.snapshot.result).toBeUndefined();
    expect(partial.snapshot.router.depth).toBe(2);

    const resetScreens = new Set<ConsoleV4ScreenId>();
    const reset = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    reset.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'project' } });
    const resetInstance = render(<ConsoleAppV4 controller={reset} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => resetScreens.add(screen)} />);
    await nextTurn(4);
    await input(resetInstance, ...Array.from({ length: 7 }, () => '\u001B[B'), '\r');
    await nextTurn(3);
    expect(resetScreens).toContain('C16');
    expect(resetInstance.lastFrame()).toContain('当前项目');
    expect(resetInstance.lastFrame()).toContain('个人默认保持不变');

    const unavailableScreens = new Set<ConsoleV4ScreenId>();
    const unavailable = controller({
      getConfigPage: vi.fn().mockRejectedValue(new Error('catalogSourceUnavailable: private manifest error /Users/private')),
    });
    await unavailable.load();
    unavailable.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    unavailable.beginConfigFlow('team-tools/review-gate');
    unavailable.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const unavailableInstance = render(<ConsoleAppV4 controller={unavailable} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => unavailableScreens.add(screen)} />);
    await nextTurn(5);
    expect(unavailableScreens).toContain('C17');
    expect(unavailableInstance.lastFrame()).toContain('插件定义或来源不可用');
    expect(unavailableInstance.lastFrame()).toContain('修复插件来源');
    expect(unavailableInstance.lastFrame()).not.toContain('aw catalog source sync team-tools');
    expect(unavailableInstance.lastFrame()).not.toContain('/Users/private');
    expect(unavailableInstance.lastFrame()).not.toContain('重置此设置层');
    await input(unavailableInstance, '\r');
    await nextTurn(4);
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });

    const longPage = configPage();
    longPage.presets = [];
    longPage.groups = [{
      id: 'long',
      title: '长设置组',
      advanced: false,
      fields: Array.from({ length: 12 }, (_, index) => ({
        ...longPage.groups[0]!.fields[3]!,
        key: `field-${index + 1}`,
        title: `字段 ${index + 1}`,
      })),
    }];
    const compact = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...longPage, layer })) });
    compact.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const compactInstance = render(<ConsoleAppV4 controller={compact} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(compactInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    const compactFrame = compactInstance.lastFrame() ?? '';
    expect(compactFrame).toContain('› 字段 9');
    expect(compactFrame).not.toContain('字段 1\n');
    expect(compactFrame).not.toContain('保存并应用');
    expect(compactFrame).toContain('清空个人默认');
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);

    const effective = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...longPage, layer })) });
    effective.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'effective', projectLayer: 'shared' } });
    const effectiveInstance = render(<ConsoleAppV4 controller={effective} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(effectiveInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(effectiveInstance.lastFrame()).toContain('字段 9');
    expect(effectiveInstance.lastFrame()).toContain('› 字段 9');
    expect((effectiveInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('opens source-missing saved settings only for their recorded reset scope', async () => {
    const loaded = loadResult();
    loaded.configStoreInventory = [{
      pluginId: 'team-tools/retired-settings',
      sourceId: 'team-tools',
      pluginName: 'retired-settings',
      scope: 'project',
    }];
    const getConfigResetAvailability = vi.fn().mockResolvedValue({
      exists: true,
      state: 'invalid',
      sourceIdentityPresent: false,
      targetKind: 'regularFile',
      resettable: true,
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      getConfigResetAvailability,
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/retired-settings' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('查看已保存设置');
    expect(instance.lastFrame()).toContain('查看来源问题');
    expect(instance.lastFrame()).not.toContain('添加到');
    await input(instance, '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'configUnavailable',
      pluginId: 'team-tools/retired-settings',
      storedScopes: ['project'],
      layer: { scope: 'project' },
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
    });
    expect(getConfigResetAvailability).toHaveBeenCalledWith(
      'team-tools/retired-settings',
      { scope: 'project' },
      expect.any(AbortSignal),
    );
    expect(instance.lastFrame()).toContain('重置当前项目设置层');
    expect(instance.lastFrame()).not.toContain('重置个人默认设置层');
    expect(instance.lastFrame()).not.toContain('修复插件来源');
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('offers invalid-layer reset through Review and keeps its details private at $columns x $rows', async (size) => {
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const storeDigest = `sha256:${'b'.repeat(64)}`;
    const value = controller({
      getConfigResetAvailability: vi.fn().mockResolvedValue({
        exists: true,
        state: 'invalid',
        invalidCode: 'invalidJson',
        sourceIdentityPresent: true,
        sourceIdentity,
        storeDigest,
      }),
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        source: { sourceId: 'team-tools', sourceIdentity },
        config: { scope: 'user', storeDigest, affectedTargets: [] },
      }),
    });
    await value.load();
    value.push({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' },
      invalidStores: [{
        scope: 'user',
        code: 'invalidJson',
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json',
      }],
      diagnosticCode: 'invalidJson',
      diagnosticStage: 'read-config',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('重置个人默认设置层');
    expect(instance.lastFrame()).not.toContain('查看安全路径摘要');
    expect(instance.lastFrame()).not.toContain(sourceIdentity);
    expect(instance.lastFrame()).not.toContain(storeDigest);
    expect(instance.lastFrame()).not.toContain('/Users/private');
    expect(instance.lastFrame()).not.toContain('invalidJson');
    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('invalidJson');
    expect(technicalFrame).toContain('read-config');
    expect(technicalFrame).not.toContain(sourceIdentity);
    expect(technicalFrame).not.toContain(storeDigest);
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.activeReview?.operationKind).toBe('configReset');
    expect(instance.lastFrame()).toContain('重置插件设置');
  });

  it('keeps one reset action when the other invalid layer inspection fails', async () => {
    const value = controller({
      getConfigResetAvailability: vi.fn(async (_pluginId, layer: { scope: 'user' | 'project' }) => {
        if (layer.scope === 'user') throw new Error('unsafe user ancestor');
        return {
          exists: true,
          state: 'invalid' as const,
          sourceIdentityPresent: false,
          targetKind: 'directory' as const,
          resettable: true,
          storeDigest: 'sha256:project',
        };
      }),
    });
    value.push({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      invalidStores: [
        { scope: 'user', code: 'invalidJson', pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json' },
        { scope: 'project', code: 'invalidValues', pathSummary: '<project>/.agent-workflows/plugin-config/team-tools/review-gate/config.json' },
      ],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('重置当前项目设置层');
    expect(instance.lastFrame()).not.toContain('重置个人默认设置层');
  });

  it('shows a special reset target as manual recovery without an automatic action', async () => {
    const value = controller({
      getConfigResetAvailability: vi.fn().mockResolvedValue({
        exists: true,
        state: 'invalid',
        sourceIdentityPresent: false,
        targetKind: 'special',
        resettable: false,
        storeDigest: 'sha256:special',
      }),
    });
    value.push({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      invalidStores: [{
        scope: 'user', code: 'invalidValues',
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json',
      }],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('个人默认设置层不能自动重置');
    expect(instance.lastFrame()).toContain('特殊节点，请手动移动');
    expect(instance.lastFrame()).not.toContain('重置个人默认设置层…');
  });

  it.each([
    { invalidScope: 'user' as const, readyScope: 'project' as const },
    { invalidScope: 'project' as const, readyScope: 'user' as const },
  ])('binds an effective-entry invalid store to $invalidScope without offering $readyScope reset', async ({
    invalidScope,
    readyScope,
  }) => {
    const invalidStores = [{
      scope: invalidScope,
      code: 'invalidJson' as const,
      pathSummary: invalidScope === 'user'
        ? 'AW_HOME/plugin-config/team-tools/review-gate/config.json'
        : '<project>/.agent-workflows/plugin-config/team-tools/review-gate/config.json',
    }];
    const getConfigResetAvailability = vi.fn(async (_pluginId, layer: { scope: 'user' | 'project' }) => ({
      exists: true,
      state: layer.scope === invalidScope ? 'invalid' as const : 'ready' as const,
      ...(layer.scope === invalidScope ? { invalidCode: 'invalidJson' as const } : {}),
      sourceIdentityPresent: true,
      sourceIdentity: `identity:${layer.scope}`,
      storeDigest: `digest:${layer.scope}`,
    }));
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      getConfigPage: vi.fn().mockRejectedValue(new TuiConfigInvalidStoreError(invalidStores)),
      getConfigResetAvailability,
      captureEvidence,
    });
    value.push({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'effective' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(6);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configUnavailable',
      layer: { scope: invalidScope },
      invalidStores,
    });
    expect(instance.lastFrame()).toContain(
      `重置${invalidScope === 'user' ? '个人默认' : '当前项目'}设置层`,
    );
    expect(instance.lastFrame()).not.toContain(
      `重置${readyScope === 'user' ? '个人默认' : '当前项目'}设置层`,
    );
    expect(getConfigResetAvailability).toHaveBeenCalledTimes(1);
    expect(getConfigResetAvailability.mock.calls[0]?.[1]).toEqual({ scope: invalidScope });

    await input(instance, '\r');
    await nextTurn(4);
    expect(captureEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'configReset', scope: invalidScope }),
      expect.any(AbortSignal),
    );
  });

  it('lists two invalid stores in user-project order and can review either exact reset', async () => {
    const invalidStores = [
      {
        scope: 'user' as const,
        code: 'invalidJson' as const,
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json',
      },
      {
        scope: 'project' as const,
        code: 'invalidValues' as const,
        pathSummary: '<project>/.agent-workflows/plugin-config/team-tools/review-gate/config.json',
      },
    ];
    const openReset = async (scope: 'user' | 'project') => {
      const captureEvidence = vi.fn().mockResolvedValue(evidence);
      const value = controller({
        getConfigPage: vi.fn().mockRejectedValue(new TuiConfigInvalidStoreError(invalidStores)),
        getConfigResetAvailability: vi.fn(async (_pluginId, layer: { scope: 'user' | 'project' }) => ({
          exists: true,
          state: 'invalid' as const,
          invalidCode: layer.scope === 'user' ? 'invalidJson' as const : 'invalidValues' as const,
          sourceIdentityPresent: true,
          sourceIdentity: `identity:${layer.scope}`,
          storeDigest: `digest:${layer.scope}`,
        })),
        captureEvidence,
      });
      value.push({
        name: 'configFields',
        pluginId: 'team-tools/review-gate',
        layer: { scope: 'effective' },
      });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await nextTurn(6);
      const frame = instance.lastFrame() ?? '';
      expect(frame.indexOf('重置个人默认设置层')).toBeLessThan(frame.indexOf('重置当前项目设置层'));
      if (scope === 'project') await input(instance, '\u001B[B');
      await input(instance, '\r');
      await nextTurn(4);
      expect(captureEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'configReset', scope }),
        expect.any(AbortSignal),
      );
      instance.unmount();
    };

    await openReset('user');
    await openReset('project');
  });

  it('does not let an aborted config layer response overwrite the newer layer page', async () => {
    let resolveUser!: (page: ConfigPageViewModel) => void;
    const userPage = new Promise<ConfigPageViewModel>((resolve) => {
      resolveUser = resolve;
    });
    const projectPage = configPage();
    projectPage.groups[0]!.fields[0]!.title = '新项目字段';
    const getConfigPage = vi.fn((_pluginId: string, layer: ConfigPageViewModel['layer']) =>
      layer.scope === 'user' ? userPage : Promise.resolve({ ...projectPage, layer }));
    const value = controller({ getConfigPage });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    value.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'project', projectLayer: 'shared' } });
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('新项目字段');

    const oldPage = configPage();
    oldPage.groups[0]!.fields[0]!.title = '过期个人字段';
    resolveUser(oldPage);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('新项目字段');
    expect(instance.lastFrame()).not.toContain('过期个人字段');
  });

  it('keeps the config group and field viewport when config loading enters source recovery', async () => {
    const value = controller({
      getConfigPage: vi.fn().mockRejectedValue(Object.assign(
        new Error('catalogSourceUnavailable'),
        { code: 'catalogSourceUnavailable' },
      )),
    });
    value.push({
      name: 'configFieldAction',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' },
      fieldKey: 'model',
    }, { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configUnavailable',
      resumeRoute: {
        name: 'configFieldAction',
        pluginId: 'team-tools/review-gate',
        layer: { scope: 'user' },
        fieldKey: 'model',
      },
      resumeContext: { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 },
    });
    expect(instance.lastFrame()).toContain('修复插件来源');
  });

  it('uses G04 when leaving a dirty config layer and can discard its draft', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await input(instance, '\r', '\r', '\u001B[B', '\r', 'b', 'b');
    expect(screens).toContain('G04');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('keeps a config draft when h defaults to continue editing', async () => {
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const onSessionNavigation = vi.fn(async (
      _navigation: 'home' | 'reload',
      options?: { discardDrafts?: boolean },
    ) => value.hasSessionDraft && !options?.discardDrafts ? 'draftBlocked' as const : 'completed' as const);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(4);
    await input(instance, '\r', '\r', '\u001B[B', '\r');
    await nextTurn(2);
    expect(value.hasSessionDraft).toBe(true);
    const draftRoute = value.snapshot.router.current.route;

    await input(instance, 'h');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(instance.lastFrame()).toContain('继续编辑');
    await input(instance, '\r');

    expect(value.hasSessionDraft).toBe(true);
    expect(value.snapshot.router.current.route).toEqual(draftRoute);
  });

  it('returns from read-only history without discarding or confirming the parent config draft', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    const recordId = value.recordSafeUiFailure('fixtureFailure', 'fixture-stage');
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', '\r', '\u001B[B', '\r');
    expect(value.hasSessionDraft).toBe(true);
    const draftRoute = value.snapshot.router.current.route;

    await input(instance, '?', 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationDiagnostic', recordId });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationReportPreview', recordId });
    await input(instance, 'b', 'b', 'b');

    expect(value.snapshot.router.current.route).toEqual(draftRoute);
    expect(value.hasSessionDraft).toBe(true);
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('resets home focus and list context after global home navigation', async () => {
    const value = controller();
    await value.load();
    const onSessionNavigation = vi.fn(async (navigation: 'home' | 'reload') => {
      if (navigation === 'home') value.goHome();
      return 'completed' as const;
    });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\u001B[B', 'h');
    expect(value.snapshot.router).toMatchObject({
      depth: 1,
      current: { route: { name: 'home' }, context: {} },
    });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });

    await input(instance, 'h', '\u001B[B', '\u001B[B', '?', '\u001B[B', '\r', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    expect(onSessionNavigation.mock.calls.filter(([navigation]) => navigation === 'home')).toHaveLength(3);
    instance.unmount();
  });

  it('cancels a pending Host navigation when Enter chooses continue editing', async () => {
    const value = controller();
    const draft = { kind: 'configDraft' as const, owner: 'plugin\0user', flowId: 'flow-1', revision: 1 };
    const cancelPending = vi.fn(() => true);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      pendingSessionNavigation="home"
      pendingSessionNavigationDrafts={[draft]}
      onCancelPendingSessionNavigation={cancelPending}
      onSessionNavigation={vi.fn().mockResolvedValue('draftBlocked')}
    />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('放弃未保存修改？');

    await input(instance, '\r');
    expect(cancelPending).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps an object draft through read-only history and guards the real config-flow exit', async () => {
    const page = objectConfigPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', editor: 'object', mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r');
    const draftRoute = value.snapshot.router.current.route;
    expect(value.externalDrafts).toEqual([
      expect.objectContaining({ kind: 'configDraft', owner: `${page.pluginId}\0user` }),
    ]);

    value.push({ name: 'operationHistory' });
    await nextTurn(2);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(draftRoute);
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps a source draft through read-only history and guards the real source-flow exit', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'sourceAdd', step: 'type' });
    const sourceRoute = value.snapshot.router.current.route;
    expect(value.externalDrafts).toEqual([
      expect.objectContaining({ kind: 'sourceDraft', owner: expect.any(String) }),
    ]);

    value.push({ name: 'operationHistory' });
    await nextTurn(2);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(sourceRoute);
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps a recovered source draft visible and blocks a field removed by the new schema', async () => {
    const initialPage = configPage();
    const refreshedPage = configPage();
    refreshedPage.groups[0]!.fields = refreshedPage.groups[0]!.fields
      .filter((field) => field.key !== 'level');
    const getConfigPage = vi.fn()
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(refreshedPage);
    const value = controller({ getConfigPage });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.beginConfigFlow('team-tools/review-gate');
    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', '\r', '\u001B[B', '\r');
    expect(value.hasSessionDraft).toBe(true);

    const resumeRoute = {
      name: 'configFields' as const,
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' as const, projectLayer: 'shared' as const },
    };
    value.replace({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
      resumeRoute,
    });
    await nextTurn(2);
    value.replace(resumeRoute);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('字段已变化');
    expect(instance.lastFrame()).toContain('放弃已变化字段的草稿');
    expect(instance.lastFrame()).not.toContain('保存并应用');
    expect(value.hasSessionDraft).toBe(true);
  });

  it('returns a dirty source recovery to its field and blocks a now-unwritable draft', async () => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools'
        ? { ...generation, state: 'repairRequired' as const }
        : generation);
    const initialPage = configPage();
    const refreshedPage = configPage();
    const refreshedLevel = refreshedPage.groups[0]!.fields.find((field) => field.key === 'level')!;
    refreshedLevel.writable = false;
    refreshedLevel.canSet = false;
    refreshedLevel.canUnset = false;
    const getConfigPage = vi.fn()
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(refreshedPage);
    const captureEvidence = vi.fn(async (intent: OperationIntent) => {
      const prepared = evidenceForIntent(intent);
      return intent.kind === 'catalogGeneration' && prepared.catalogGeneration
        ? {
            ...prepared,
            catalogGeneration: {
              ...prepared.catalogGeneration,
              exactRepair: intent.action === 'repair',
              activationMode: 'normal' as const,
            },
          }
        : prepared;
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      getConfigPage,
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({ status: 'succeeded' }),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.beginConfigFlow('team-tools/review-gate');
    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    }, { configGroupId: 'basic', focusIndex: 0, scrollOffset: 0 });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', '\r', '\r');
    await nextTurn(2);
    expect(value.hasSessionDraft).toBe(true);

    const resumeRoute = {
      name: 'configFieldAction' as const,
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' as const },
      fieldKey: 'level',
    };
    value.replace({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' },
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
      resumeRoute,
      resumeContext: { configGroupId: 'basic', focusIndex: 0, scrollOffset: 0 },
    }, { configGroupId: 'basic', focusIndex: 0, scrollOffset: 0 });
    await nextTurn(2);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });
    expect(instance.lastFrame()).toContain('重新下载旧版本并精确修复');
    await input(instance, '\r');
    await nextTurn(4);
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogGeneration', action: 'repair', sourceId: 'team-tools',
    }), expect.any(AbortSignal));
    await confirmReview(instance, value);
    await nextTurn(6);
    expect(value.snapshot.router.current.route.name).toBe('result');

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, '\r', '\u001B[A', '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route).toEqual(resumeRoute);
    expect(value.snapshot.router.current.context).toMatchObject({
      configGroupId: 'basic', focusIndex: 0, scrollOffset: 0,
    });
    expect(value.hasSessionDraft).toBe(true);

    await input(instance, 'b');
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('字段已变化');
    expect(instance.lastFrame()).toContain('放弃已变化字段的草稿');
    expect(instance.lastFrame()).toContain('字段不存在、不可编辑或不再可删除');
    expect(instance.lastFrame()).not.toContain('保存并应用');
  });

  it('opens a stored field action but sends an unstored field directly to its cursor editor', async () => {
    const page = configPage();
    const level = page.groups[0]!.fields[0]!;
    level.fallbackDisplayValue = '平衡';
    level.fallbackSourceLabel = '默认值';
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldAction', fieldKey: 'level' });
    expect(instance.lastFrame()).toContain('当前实际生效');
    expect(instance.lastFrame()).toContain('删除后将恢复');
    expect(instance.lastFrame()).toContain('平衡 · 来自默认值');
    await input(instance, 'b', ...Array.from({ length: 3 }, () => '\u001B[B'), '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'note' });
    expect(instance.lastFrame()).toContain('▌');
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('shows and unsets a legacy project native override at $columns x $rows', async (size) => {
    const page = configPage();
    page.layer = { scope: 'project' };
    page.storedCount = 1;
    const legacy = page.groups[0]!.fields[0]!;
    page.groups = [{
      id: 'basic', title: '基本设置', advanced: false,
      fields: [{
        ...legacy,
        title: '共享模式',
        writable: false,
        canSet: false,
        canUnset: true,
        sharedNativeRender: true,
        configured: true,
        inherited: false,
        displayValue: '旧项目值',
        effectiveDisplayValue: '个人默认值',
        effectiveSourceLabel: '个人默认',
        fallbackDisplayValue: '个人默认值',
        fallbackSourceLabel: '个人默认',
      }],
    }];
    const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
    const value = controller({
      getConfigPage: vi.fn().mockResolvedValue(page),
      captureEvidence,
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId, layer: { scope: 'project' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('不再支持的');
    expect(instance.lastFrame()).toContain('project override');
    expect(instance.lastFrame()).toContain('user/default');
    expect(instance.lastFrame()).toContain('删除旧值');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: legacy.key,
    });
    expect(instance.lastFrame()).not.toContain('修改值');
    expect(instance.lastFrame()).toContain('删除当前项目中的值');
    await input(instance, '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');

    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSave',
      scope: 'project',
      updates: {},
      removeKeys: [legacy.key],
    }), expect.any(AbortSignal));
    expect(instance.lastFrame()).not.toContain('Shared impact 需要显式确认');
    instance.unmount();
  });

  it('does not present a user invalid override as a project-layer unset or fallback', async () => {
    const page = configPage();
    page.layer = { scope: 'project' };
    page.storedCount = 0;
    const inherited = page.groups[0]!.fields.find((field) => field.key === 'note')!;
    inherited.invalidOverrideIssue = '字段“note”在个人默认中的值无效。请切换到该设置层修改或删除此字段。';
    inherited.invalidOverrideOwnedByLayer = false;
    inherited.effectiveDisplayValue = '值无效';
    inherited.effectiveSourceLabel = '个人默认';
    const value = controller({ getConfigPage: vi.fn().mockResolvedValue(page) });
    value.push({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'project' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, ...Array.from({ length: 3 }, () => '\u001B[B'));

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('在个人默认中的值无效');
    expect(frame).toContain('切换到该设置层');
    expect(frame).not.toContain('删除后恢复');
    expect(frame).not.toContain('u 恢复继承');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', layer: { scope: 'project' }, fieldKey: 'note',
    });
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('shows shared native user-only fields as project read-only guidance at $columns x $rows', async (size) => {
    const page = configPage();
    const userOnly = page.groups[0]!.fields[0]!;
    userOnly.title = '共享等待窗口';
    userOnly.writable = false;
    userOnly.sharedNativeRender = true;
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({
      name: 'configFields',
      pluginId: page.pluginId,
      layer: { scope: 'project', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);

    const frame = (instance.lastFrame() ?? '').replace(/\s+/gu, '');
    expect(frame).toContain('个人默认控制平台共享内容');
    expect(frame).toContain('项目不可改');
    expect(frame).toContain('影响所有项目');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).not.toMatchObject({
      name: 'configFieldAction',
      fieldKey: userOnly.key,
    });
  });

  it.each([
    ['configured enum', 'level', 'configFieldAction'],
    ['unstored string', 'note', 'configFieldEditor'],
    ['configured secret', 'token', 'configFieldAction'],
  ] as const)('routes an effective %s through the selected layer stored state', async (_label, fieldKey, expectedRoute) => {
    const page = configPage();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'effective', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    value.push({ name: 'configLayer', pluginId: page.pluginId, fieldKey, groupId: 'basic' });
    await nextTurn(2);

    await input(instance, '\r');
    await nextTurn(4);

    expect(value.snapshot.router.current.route).toMatchObject({ name: expectedRoute, fieldKey });
    if (expectedRoute === 'configFieldEditor') expect(instance.lastFrame()).toContain('▌');
    else expect(instance.lastFrame()).toContain('当前实际生效');
  });

  it('stages a stored field removal without executing a write and shows inherited Review text', async () => {
    const page = configPage();
    const level = page.groups[0]!.fields[0]!;
    level.fallbackDisplayValue = '平衡';
    level.fallbackSourceLabel = '个人默认';
    const executeIntent = vi.fn();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'project', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r', '\u001B[B', '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('1 项未保存');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldAction', fieldKey: 'level' });
    expect(instance.lastFrame()).toContain('撤销删除');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('1 项未保存');
    await openConfigSave(instance, value);
    expect(instance.lastFrame()).toContain('设置变更');
    expect(instance.lastFrame()).toContain('恢复继承（平衡 · 个人默认）');
    expect(instance.lastFrame()).toContain('应用影响');
    expect(instance.lastFrame()).toContain('保持不变');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['secret', 'token'],
    ['path', 'rules'],
  ] as const)('renders a %s removal as a redacted inherited change', async (_label, fieldKey) => {
    const page = configPage();
    const field = page.groups.flatMap((group) => group.fields).find((candidate) => candidate.key === fieldKey)!;
    field.fallbackDisplayValue = '已设置';
    field.fallbackSourceLabel = '个人默认';
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    const layer = { scope: 'project' as const, projectLayer: 'shared' as const };
    value.push({ name: 'configFields', pluginId: page.pluginId, layer });
    value.push({ name: 'configFieldAction', pluginId: page.pluginId, layer, fieldKey });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\r');
    await openConfigSave(instance, value);

    const frame = instance.lastFrame()!;
    expect(frame).toContain(`删除 ${fieldKey} 中的值`);
    expect(frame).toContain('已设置 → 恢复继承（已设置 · 个人默认）');
    expect(frame).not.toContain('sk-private');
    expect(frame).not.toContain('/Users/private');
  });

  it('treats h, H, q, and b as config text, normalizes no-op drafts, and hides reset for an empty layer', async () => {
    const page = configPage();
    page.storedCount = 0;
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('Ctrl-U 清空输入');

    await input(instance, 'hHqb', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('hHqb');
    expect(instance.lastFrame()).toContain('1 项未保存');

    await input(instance, 'b', '\u001B[B', '\r');
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    await nextTurn(4);
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'level',
      editor: 'enum',
    });
    await input(instance, '\u001B[B', '\u001B[B', '\r', ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(value.snapshot.activeReview).toBeUndefined();
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    await nextTurn(2);
    await input(instance, '\u0015', ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(value.snapshot.activeReview).toBeUndefined();
    await input(instance, 's', '\r');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(instance.lastFrame()).not.toContain('清空个人默认');
  });

  it('isolates private drafts by canonical plugin and layer before the next page renders', async () => {
    const alpha = configPage('team-tools/review-gate');
    const beta = configPage('official/agent-lab');
    beta.presets = [];
    beta.groups = [{
      id: 'basic',
      title: '基本设置',
      advanced: false,
      fields: [{
        ...beta.groups[0]!.fields[3]!,
        key: 'token',
        title: '普通 token 字段',
      }],
    }];
    const getConfigPage = vi.fn(async (pluginId: string, layer: ConfigPageViewModel['layer']) => ({
      ...(pluginId === alpha.pluginId ? alpha : beta),
      pluginId,
      layer,
    }));
    const value = controller({ getConfigPage });
    value.push({ name: 'configFields', pluginId: alpha.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: alpha.pluginId,
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'token',
      editor: 'sensitive',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'LEAK-VALUE', '\r');

    value.replace({ name: 'configFields', pluginId: beta.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    expect(instance.lastFrame()).not.toContain('LEAK-VALUE');
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('普通 token 字段');
    expect(instance.lastFrame()).not.toContain('LEAK-VALUE');
    await input(instance, 's', '\r');
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('shows a committed config write with one failed target as partial', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'partial',
        apply: {
          state: 'partial',
          targetResults: [
            { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
            { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
          ],
        },
      }),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await input(instance, 'DRAFT-KEEP', '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'apply');
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({ state: 'partial' });
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(instance.lastFrame()).toContain('设置已保存，但插件内容重新应用失败或部分失败');
    expect(instance.lastFrame()).toContain('已完成');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('返回修改');
    expect(instance.lastFrame()).toContain('选择清理');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(screens).toContain('C15');
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('重试应用插件设置');
  });

  it('shows a saved invalid config as unapplied instead of an apply failure', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'partial',
        apply: { state: 'unavailable', reason: 'invalidConfig', targetResults: [] },
      }),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'SAVED', '\r', ...Array.from({ length: 8 }, () => '\u001B[B'), '\r');
    await nextTurn(3);
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({
      state: 'partial',
      summary: { configApplied: false },
    });
    expect(instance.lastFrame()).toContain('设置已保存，但未应用');
    expect(instance.lastFrame()).toContain('当前配置仍无效');
    expect(instance.lastFrame()).not.toContain('部分应用失败');
    expect(instance.lastFrame()).not.toContain('重试应用');
    expect(instance.lastFrame()).not.toContain('cleanup');
    expect(instance.lastFrame()).not.toContain('reinstall');
    expect(instance.lastFrame()).not.toContain('sync');
  });

  it.each([
    ['absent', '设置层原本不存在；没有删除内容', undefined],
    ['deletedFile', '已删除设置文件', undefined],
    ['unlinkedSymlink', '已解除设置路径符号链接；链接目标未修改', undefined],
    ['quarantinedDirectory', '设置路径是目录；已隔离为 config.broken-safe.json', 'config.broken-safe.json'],
  ] as const)('renders the safe %s reset result at 60x18', async (
    resetDisposition,
    expected,
    quarantineBasename,
  ) => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        resetDisposition,
        ...(quarantineBasename ? { quarantineBasename } : {}),
      }),
    });
    const review = await value.buildOperationReview({
      kind: 'configReset',
      pluginId: 'team-tools/review-gate',
      scope: 'user',
      projectLayer: 'shared',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain(expected);
    expect(frame).not.toContain('/Users/private');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('keeps every compact Review change and confirmation in one bounded focus viewport', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({ executeIntent });
    await value.load();
    await value.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/agent-lab',
      scope: 'user',
      projectLayer: 'shared',
      apply: true,
      updates: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field-${index + 1}`, index + 1])),
      changes: Array.from({ length: 9 }, (_, index) => ({
        key: `field-${index + 1}`,
        title: `变更 ${index + 1}`,
        before: '旧值',
        after: '新值',
      })),
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('~ 个人默认 · 变更 1');
    expect(instance.lastFrame()).not.toContain('› ~ 个人默认 · 变更 1');
    expect(instance.lastFrame()).toMatch(/后面还有 \d+ 项/u);
    expect(instance.lastFrame()).toContain('› 保存并应用');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it('summarizes many kept and warning Review rows without clipping actions or HelpBar', async () => {
    const value = controller();
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user', force: true,
    });
    const snapshot = structuredClone(value.snapshot);
    if (!snapshot.activeReview) throw new Error('expected active review');
    snapshot.activeReview.changes = [
      { kind: 'remove', group: 'requested', title: 'Codex · 所有项目', description: '目标安装' },
      ...Array.from({ length: 18 }, (_, index) => ({ kind: 'keep' as const, group: 'preserved' as const, title: `保留项 ${index + 1}`, description: '保持安装' })),
      ...Array.from({ length: 12 }, (_, index) => ({ kind: 'warning' as const, group: 'portableWarnings' as const, title: `风险 ${index + 1}`, description: '共同风险原因' })),
    ];
    Object.defineProperty(value, 'snapshot', { configurable: true, get: () => snapshot });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('共同风险原因');
    expect(frame).toContain('保持不变');
    expect(frame).toMatch(/后面还有 \d+ 项/u);
    expect(frame).toContain(`› ${review.primaryLabel}`);
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
  });

  it.each(['cleanup', 'uninstall'] as const)('does not offer script timeout for %s Review', async (action) => {
    const value = controller();
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action, pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).not.toContain('高级选项：脚本超时');
    expect(instance.lastFrame()).toContain(value.snapshot.activeReview?.primaryLabel);
  });

  it('reaches S01-S13 through the real Git wizard and treats b as input text', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const loaded = loadResult();
    loaded.cliChannel = 'beta';
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 60, rows: 18 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('单个来源失败不会阻止其他来源继续工作');
    expect(screens).toContain('S01');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    expect(screens).toContain('S05');
    await input(instance, 'team-b2', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'sourceAdd', step: 'location' });
    await input(instance, 'https://example.test/catalog.git', '\r');
    expect(instance.lastFrame()).toContain('当前 CLI beta → catalog/beta');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(screens).toContain('S08');
    await input(instance, 'catalog/stable', '\r', 'catalog', '\r');
    await nextTurn(3);
    expect(screens).toContain('S14');
    await input(instance, ...Array.from({ length: 4 }, () => '\u001B[B'), '\r');
    expect(screens).toContain('S15');
    await input(instance, '\r');
    await nextTurn(3);
    expect(screens).toContain('S10');
    expect(instance.lastFrame()).toContain('team-b2');
    expect(instance.lastFrame()).not.toContain('Catalog 版本');
    expect(instance.lastFrame()).not.toContain('resolvedCommit');
    await confirmReview(instance, value);
    await nextTurn(5);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogGeneration',
      action: 'activate',
      sourceId: 'team-b2',
    }), expect.anything(), expect.any(AbortSignal));
    expect(screens).toContain('S12');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(value.snapshot.router).toMatchObject({
      depth: 3,
      current: { route: { name: 'result' } },
    });

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(value.snapshot.router).toMatchObject({
      depth: 2,
      current: { route: { name: 'sourceList' } },
    });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(value.snapshot.router).toMatchObject({
      depth: 1,
      current: { route: { name: 'home' } },
    });
  });

  it('keeps h, H, q, and b as characters in a source field', async () => {
    const value = controller();
    const onSessionNavigation = vi.fn().mockResolvedValue('completed');
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await input(instance, 'hHqb');

    expect(instance.lastFrame()).toContain('hHqb');
    expect(onSessionNavigation).not.toHaveBeenCalled();
    expect(value.hasSessionDraft).toBe(true);
  });

  it('discards the complete add-source route segment from S07 and returns to the source list', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await input(instance, 'discard-me', '\r', 'https://example.test/catalog.git', '\r');
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S07');

    await input(instance, 'b', '\u001B[B', '\r');

    expect(value.snapshot.router).toMatchObject({
      depth: 2,
      current: { route: { name: 'sourceList' } },
    });
    expect(value.snapshot.activeReview).toBeUndefined();
    value.back();
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('discards an add-source draft from its unified parent but q confirmation still exits', async () => {
    const exit = vi.fn();
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await input(instance, 'review-draft', '\r', 'https://example.test/catalog.git', '\r', '\r', '\r');
    await nextTurn(3);
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S14');

    await input(instance, 'q', '\u001B[B', '\r');

    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('backs from an edit-source Review to the source save summary', async () => {
    const value = controller();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    value.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r');
    await nextTurn(4);
    await input(instance, ...Array.from({ length: 'https://example.test/team.git'.length }, () => '\u007F'), 'https://example.test/team-v2.git');
    expect(instance.lastFrame()).toContain('team-v2.git');
    await input(instance, '\r');
    await input(instance, ...Array.from({ length: 4 }, () => '\u001B[B'), '\r');
    await chooseSourceSave(instance, value, 'enable');
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S15');

    await input(instance, 'b');

    expect(value.snapshot.router).toMatchObject({
      current: { route: { name: 'sourceSave' } },
    });
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('saves a changed path source when the private path display has the same basename', async () => {
    const loaded = loadResult();
    const official = loaded.configuredSources.find((source) => source.id === 'official');
    if (!official || official.type !== 'path') throw new Error('expected path source fixture');
    official.path = '/a/catalog';
    const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
    });
    await value.load();
    value.push({ name: 'sourceEdit', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r');
    await nextTurn(4);
    await input(instance, ...Array.from({ length: '/a/catalog'.length }, () => '\u007F'), '/b/catalog');
    expect(instance.lastFrame()).toContain('已选择 / … / catalog');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('sourceEdit');
    expect(instance.lastFrame()).toContain('1 项未保存');
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('sourceSave');
    await chooseSourceSave(instance, value, 'only');

    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sourceMutation',
      action: 'update',
      sourceId: 'official',
      update: expect.objectContaining({ type: 'path', path: '/b/catalog' }),
    }), expect.any(AbortSignal));
  });

  it('drops an unchanged edit-source draft before returning home', async () => {
    const value = controller();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r', '\u001B', 'h');

    expect(value.snapshot.router.current.route.name).not.toBe('sourceEdit');
    expect(value.hasSessionDraft).toBe(false);
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
  });

  it('reviews an official HTTPS to SSH transport switch before any source write', async () => {
    const loaded = loadResult();
    loaded.payload.catalog.sources[0] = {
      id: 'official',
      identity: 'identity:official-workspace',
      type: 'git',
      primary: true,
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'abc123',
      freshness: 'active',
    };
    loaded.configuredSources![0] = {
      id: 'official',
      type: 'git',
      primary: true,
      url: 'https://github.com/lesliechan721-arch/agent-workflow.git',
      refPolicy: { type: 'cliChannel' },
      autoCheck: true,
    };
    loaded.sourceDetails![0] = {
      id: 'official',
      type: 'git',
      primary: true,
      locationSummary: 'https://github.com/lesliechan721-arch/agent-workflow.git',
      refPolicy: 'cliChannel',
      pluginCount: 2,
      sourceIdentity: 'identity:official-workspace',
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'abc123',
      freshness: 'active',
      configDigest: 'sha256:config',
    };
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    value.push({ name: 'sourceEdit', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    expect(instance.lastFrame()).toContain('HTTPS');
    expect(instance.lastFrame()).toContain('SSH');
    expect(instance.lastFrame()).toContain('BatchMode');
    await input(instance, '\u001B[B', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('Git URL');
    expect(instance.lastFrame()).not.toContain('http://');
  });

  it('cancels a fixed-ref field without changing its parent source draft', async () => {
    const loaded = loadResult();
    loaded.configuredSources![1] = {
      id: 'team-tools', type: 'git', primary: false,
      url: 'https://example.test/team.git',
      refPolicy: { type: 'cliChannel' }, autoCheck: true,
    };
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    value.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    await input(instance, '\u001B[B', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'sourceAdd', step: 'ref' });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(3);

    expect(value.snapshot.router.current.route.name).toBe('sourceEdit');
    expect(value.hasSessionDraft).toBe(false);
  });

  it('renders safe source detail and technical data without raw path, credentials, or failure text', async () => {
    const secretPath = '/Users/private/acme/catalog';
    const secretUrl = 'https://token:secret@example.test/team.git';
    const loaded = loadResult();
    loaded.sourceDetails = loaded.sourceDetails!.map((detail) => detail.id === 'team-tools'
      ? { ...detail, locationSummary: 'https://example.test/team.git' }
      : detail.id === 'research' ? { ...detail, locationSummary: '已选择本地目录（catalog）' } : detail);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(5);
    expect(instance.lastFrame()).toContain('https://example.test/team.git');
    expect(instance.lastFrame()).not.toContain(secretPath);
    expect(instance.lastFrame()).not.toContain(secretUrl);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(screens).toContain('S03');
    expect(instance.lastFrame()).toContain('catalogSourceReady');
    expect(instance.lastFrame()).toContain('requested ref');
    expect(instance.lastFrame()).not.toContain('sourceIdentity');
    expect(instance.lastFrame()).not.toContain('configDigest');
    expect(instance.lastFrame()).not.toContain('/Users/private');
    expect(instance.lastFrame()).not.toContain('token:secret');
  });

  it('shows structured candidate capability diagnostics while preserving the old Active', async () => {
    const missing = ['aw.catalog.future-one.v1', 'aw.catalog.future-two.v1'];
    const value = controller({
      probeCatalogFreshness: vi.fn(async (sourceId: string) => {
        if (sourceId === 'team-tools') throw new CatalogProviderCompatibilityError({
          sourceId,
          requiredCapabilities: missing,
          missingCapabilities: missing,
          availableCapabilities: ['aw.current.v1'],
        });
        return { sourceId, state: 'current' as const };
      }),
    });
    await value.load();
    await nextTurn(5);
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 28 }} />);
    await nextTurn(2);

    const detail = instance.lastFrame() ?? '';
    expect(detail).toContain('当前 AW 缺少 2 项待检查版本所需功能');
    expect(detail).toContain('当前目录版本 2.4.0 仍可浏览和使用');
    expect(detail).not.toContain('更新到候选版本');
    await input(instance, ...Array.from({ length: 5 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› 重新检查');
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 完整验证');

    value.push({ name: 'sourceTechnical', sourceId: 'team-tools' });
    await nextTurn(2);
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain(missing[0]);
    expect(technical).toContain(missing[1]);
    expect(technical).not.toContain('aw.current.v1');
    instance.unmount();
  });

  it('shows no-Active capability diagnostics without offering an activation action', async () => {
    const missing = ['aw.catalog.future-one.v1', 'aw.catalog.future-two.v1'];
    const loaded = loadResult();
    loaded.payload.catalog.sources = loaded.payload.catalog.sources.map((source) => {
      if (source.id !== 'team-tools') return source;
      const { resolvedCommit: _resolvedCommit, catalogVersion: _catalogVersion,
        channel: _channel, freshness: _freshness, ...rest } = source;
      return { ...rest, error: 'unavailable', errorCode: 'catalogSourceUnavailable' };
    });
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools' ? {
        sourceId: 'team-tools', sourceType: 'git' as const,
        state: 'activationRequired' as const,
        errorCode: 'catalogGenerationUnavailable',
      } : generation);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      probeCatalogFreshness: vi.fn(async (sourceId: string) => {
        if (sourceId === 'team-tools') throw new CatalogProviderCompatibilityError({
          sourceId,
          requiredCapabilities: missing,
          missingCapabilities: missing,
          availableCapabilities: ['aw.current.v1'],
        });
        return { sourceId, state: 'current' as const };
      }),
    });
    await value.load();
    await nextTurn(5);
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 28 }} />);
    await nextTurn(2);

    const detail = instance.lastFrame() ?? '';
    expect(detail).toContain('当前 AW 缺少 2 项待检查版本所需功能');
    expect(detail).toContain('这个来源没有可用目录版本');
    expect(detail).toContain('编辑来源…');
    expect(detail).toContain('重新检查');
    expect(detail).toContain('完整验证');
    expect(detail).not.toContain('获取并启用');
    expect(detail).not.toContain('启用并设为主来源');
    expect(detail).not.toContain('当前 Active Catalog 保持不变');

    value.push({ name: 'sourceTechnical', sourceId: 'team-tools' });
    await nextTurn(2);
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain('awCapabilityUnsupported');
    expect(technical).toContain(missing[0]);
    expect(technical).toContain(missing[1]);
    expect(technical).not.toContain('aw.current.v1');
    instance.unmount();
  });

  it('never echoes Git credentials or query tokens while S06 is receiving input', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await input(instance, 'safe-input', '\r');
    await input(instance, 'https://user:secret@example.test/catalog.git?token=private#fragment');

    expect(instance.lastFrame()).toContain('https://example.test/catalog.git');
    expect(instance.lastFrame()).not.toMatch(/user:secret|token=private|#fragment/u);
    expect(JSON.stringify(value.snapshot)).not.toMatch(/user:secret|token=private|#fragment/u);
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('Git URL 不符合来源规范');
    expect(instance.lastFrame()).not.toMatch(/user:secret|token=private|#fragment/u);
  });

  it('opens removal Review without consulting an incomplete reference inventory', async () => {
    const inspectSourceRemoval = vi.fn().mockResolvedValue({
      blocked: true,
      inventoryComplete: false,
      dependencies: [{
        category: 'installation',
        pluginId: 'team-tools/review-gate',
        sourceId: 'team-tools',
        platform: 'codex',
        scope: 'project',
      }],
    });
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const value = controller({
      inspectSourceRemoval,
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        sourceWrite: {
          configDigest: 'sha256:before',
          proposedConfigDigest: 'sha256:after',
          inventoryDigest: 'sha256:inventory',
          referenceCount: 4,
          inventoryComplete: false,
          impact: {
            impactSchemaVersion: 3,
            primaryChange: null,
            sourceId: 'team-tools',
            inventoryComplete: false,
            references: [
              { category: 'installation', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'config', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'lifecycle', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'marketplace', sourceId: 'team-tools', marketplaceName: 'aw-team' },
            ],
            affectedReferences: [
              { category: 'installation', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'config', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'lifecycle', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'marketplace', sourceId: 'team-tools', marketplaceName: 'aw-team' },
            ],
            changes: {
              added: [], removed: [], changed: [], newlyIncompatible: [],
              dependencyChanged: [], platformSupportChanged: [],
            },
            errors: [{ code: 'stateInventoryFailed', kind: 'nativeStateRead' }],
          },
        },
      }),
      executeIntent,
    });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(screens).toContain('S18');
    expect(value.snapshot.activeReview?.sourceAction).toBe('remove');
    expect(inspectSourceRemoval).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('安装引用受影响');
    expect(instance.lastFrame()).toContain('生命周期意图引用受影响');
    expect(instance.lastFrame()).toContain('来源影响未知');
    expect(instance.lastFrame()).toContain('请先确认共享影响');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('reaches the last blocked source reference at 60x18', async () => {
    const dependencies = Array.from({ length: 20 }, (_, index) => ({
      category: 'installation' as const,
      pluginId: `ref-${index}`,
      sourceId: 'team-tools',
      platform: 'codex' as const,
      scope: 'project' as const,
    }));
    const value = controller({
      inspectSourceRemoval: vi.fn().mockResolvedValue({
        blocked: true, inventoryComplete: true, installationCount: 20,
        dependencies,
      }),
    });
    await value.load();
    value.push({ name: 'sourceRemoveBlocked', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('PgUp/PgDn 查看全部引用');
    for (let page = 0; page < 25; page += 1) await input(instance, '\u001B[6~');

    expect(instance.lastFrame()).toContain('ref-19');
    expect(instance.lastFrame()).toContain('↑ 前面还有');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it.each([
    ['repairRequired', '需要修复'],
    ['stateInvalid', '版本状态需要恢复'],
    ['configMismatch', '来源设置已变化'],
    ['unavailable', '不可用'],
    ['incompatible', '当前 AW 不兼容'],
  ] as const)('projects a missing source version state %s as %s', async (state, label) => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools' ? { ...generation, active: undefined, state } : generation);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain(label);
    expect(instance.lastFrame()).not.toContain(state);
  });


  it('reaches the last dependency relation at 60x18', async () => {
    const loaded = dependencyLoadResult();
    const overview = loaded.dependencyOverviews![0]!;
    overview.dependencies = Array.from({ length: 20 }, (_, index) => ({
      ...overview.dependencies[0]!,
      pluginId: `official/dependency-${index}`,
      displayName: `Dependency ${index}`,
    }));
    overview.summary = { ...overview.summary, directCount: 20, totalCount: 20 };
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: overview.pluginId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('PgUp/PgDn 查看全部依赖关系');
    let allPages = instance.lastFrame() ?? '';
    for (let page = 0; page < 25; page += 1) {
      await input(instance, '\u001B[6~');
      allPages += instance.lastFrame() ?? '';
    }

    expect(instance.lastFrame()).toContain('Dependency 19');
    for (let index = 0; index < 20; index += 1) {
      expect(allPages).toContain(`Dependency ${index}`);
    }
    expect(instance.lastFrame()).toContain('↑ 前面还有');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('opens the damaged Active replacement Review and requires explicit impact confirmation', async () => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools'
        ? { ...generation, state: 'repairRequired' as const }
        : generation);
    const executeIntent = vi.fn().mockResolvedValue({ status: 'succeeded' });
    const captureEvidence = vi.fn(async (intent: OperationIntent) => {
      const prepared = evidenceForIntent(intent);
      if (intent.kind !== 'catalogGeneration' || !prepared.catalogGeneration) return prepared;
      return {
        ...prepared,
        catalogGeneration: {
          ...prepared.catalogGeneration,
          previousActive: {
            sourceConfigFingerprint: 'sha256:old-config',
            sourceIdentity: 'identity:team-tools',
            logicalIdentity: 'workspace:team-tools',
            requestedRef: 'catalog/stable',
            resolvedCommit: 'old123',
            manifestDigest: 'sha256:old-manifest',
            snapshotDigest: 'sha256:old-snapshot',
            activatedAt: 500,
          },
          impact: {
            impactSchemaVersion: 3,
            primaryChange: null,
            sourceId: 'team-tools',
            inventoryComplete: false,
            references: [{ category: 'lifecycle' as const, sourceId: 'team-tools', pluginId: 'team-tools/review-gate' }],
            affectedReferences: [],
            changes: {
              added: [], removed: [], changed: [], newlyIncompatible: [],
              dependencyChanged: [], platformSupportChanged: [],
            },
            errors: [{ code: 'catalogManifestUnavailable' as const, kind: 'currentManifestRead' }],
          },
        },
      };
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    expect(instance.lastFrame()).toContain('重新下载旧版本并精确修复');
    expect(instance.lastFrame()).toContain('使用待检查版本替换损坏版本');

    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogGeneration', action: 'replaceDamaged', sourceId: 'team-tools',
    }), expect.anything());
    expect(instance.lastFrame()).toContain('替换损坏的当前启用版本');
    expect(instance.lastFrame()).toContain('待检查版本的影响未知');
    expect(instance.lastFrame()).toContain('请先确认共享影响');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('已确认共享影响');
    await input(instance, '\r');
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it('reaches edit, primary, and safe removal Review pages through mounted keyboard actions', async () => {
    const edit = controller();
    edit.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const editScreens = new Set<ConsoleV4ScreenId>();
    const editView = render(<ConsoleAppV4 controller={edit} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => editScreens.add(screen)} />);
    await nextTurn(5);
    await input(editView, '\r');
    await nextTurn(4);
    await input(editView, ...Array.from({ length: 'https://example.test/team.git'.length }, () => '\u007F'), 'https://example.test/team-v2.git');
    expect(editView.lastFrame()).toContain('team-v2.git');
    await input(editView, '\r');
    await input(editView, ...Array.from({ length: 4 }, () => '\u001B[B'), '\r');
    await chooseSourceSave(editView, edit, 'enable');
    expect(editScreens).toContain('S14');
    expect(editScreens).toContain('S15');
    cleanup();

    const primary = controller();
    primary.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const primaryScreens = new Set<ConsoleV4ScreenId>();
    const primaryView = render(<ConsoleAppV4 controller={primary} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => primaryScreens.add(screen)} />);
    await nextTurn(5);
    await input(primaryView, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(primaryScreens).toContain('S16');
    cleanup();

    const removal = controller();
    removal.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const removalScreens = new Set<ConsoleV4ScreenId>();
    const removalView = render(<ConsoleAppV4 controller={removal} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => removalScreens.add(screen)} />);
    await nextTurn(5);
    await input(removalView, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(removalScreens).toContain('S18');
  });

  it('keeps a source draft and reports uncertainty after a sanitized command failure', async () => {
    const rawFailure = 'remote failed https://token:secret@example.test/private.git /Users/private/catalog';
    const value = controller({ executeIntent: vi.fn().mockRejectedValue(new Error(`catalogSourceResolutionFailed: ${rawFailure}`)) });
    await value.load();
    await value.buildOperationReview({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'safe-id',
      source: { id: 'safe-id', type: 'git', primary: false, url: 'https://example.test/catalog.git', refPolicy: { type: 'cliChannel' } },
      changes: [{ title: '添加来源 safe-id', after: 'Git 仓库' }],
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(screens).toContain('S13');
    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).not.toContain('来源列表没有被修改');
    expect(instance.lastFrame()).not.toContain('token:secret');
    expect(instance.lastFrame()).not.toContain('/Users/private');
  });

  it('renders a plugin write with failed status reload as unconfirmed and keeps its return route', async () => {
    const value = controller({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(loadResult())
        .mockRejectedValueOnce(new Error('/private/reload failed')),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).toContain('结果未确认');
    expect(instance.lastFrame()).not.toContain('插件操作未完成');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
  });

  it('renders an all-failed receipt as unconfirmed after showing the refreshed target state', async () => {
    const before = loadResult();
    const after = loadResult();
    const refreshed = after.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    if (refreshed) refreshed.state = 'partial';
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: { platform: 'codex', scope: 'user' },
          state: 'failed',
          errorCode: 'durableCleanupFailed',
        }],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('结果未确认');
    expect(instance.lastFrame()).not.toContain('operationFailed');
    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).toContain('查看插件');
    expect(value.getTargetState('team-tools/review-gate', 'codex', 'user')).toBe('needsSync');
  });

  it('does not claim a source list was unchanged after a source write reload fails', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:candidate',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const value = controller({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(loadResult())
        .mockRejectedValueOnce(new Error('/private/reload failed')),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
    });
    await value.load();
    value.push({ name: 'sourceList' });
    const review = await value.buildOperationReview({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).not.toContain('来源列表没有被修改');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceList' });
  });

  it('shows dependency installation content, opens the single relation route, and keeps a plugin without dependencies on P04', async () => {
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D01');
    expect(instance.lastFrame()).toContain('安装内容');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('直接依赖');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');
    expect(instance.lastFrame()).not.toContain('planDigest');
    await input(instance, '\u001B[B', '\r');
    expect(screens).toContain('D02');
    expect(instance.lastFrame()).toContain('安装所需插件');
    expect(instance.lastFrame()).toContain('你选择的插件');
    expect(instance.lastFrame()).toContain('必需依赖');
    expect(instance.lastFrame()).toContain('依赖优先');
    expect(instance.lastFrame()).toContain('› 技术详情');
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginPreview', pluginId: 'official/agent-lab' });

    const plain = controller();
    await plain.load();
    plain.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
    const plainInstance = render(<ConsoleAppV4 controller={plain} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(plainInstance.lastFrame()).not.toContain('安装内容');
    expect(resolveConsoleV4ScreenId(plain.snapshot, plain)).toBe('P04');
  });

  it('keeps Portable capability, dependency summary, primary action, and HelpBar visible on D01 at 60x18', async () => {
    const loaded = dependencyLoadResult();
    loaded.portablePluginIds = ['official/agent-lab'];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D01');
    expect(frame).toContain('通用 Skills');
    expect(frame).toContain('Agent Skill Toolkit');
    expect(frame).toContain('Agent Content Toolkit');
    expect(frame).toContain('› 添加插件');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, ...Array.from({ length: 3 }, () => '\u001B[B'));
    const lastActionFrame = instance.lastFrame() ?? '';
    expect(lastActionFrame).toContain('› 查看来源');
    expect(lastActionFrame).toContain('↑↓ 移动');
    expect(lastActionFrame.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
  });

  it('keeps every D01 action and HelpBar visible with Portable and eight dependencies at 80x24', async () => {
    const loaded = dependencyLoadResult();
    loaded.portablePluginIds = ['official/agent-lab'];
    const overview = loaded.dependencyOverviews?.find((entry) => entry.pluginId === 'official/agent-lab');
    expect(overview).toBeDefined();
    overview!.summary = { directCount: 4, transitiveCount: 4, totalCount: 8, readyCount: 1, missingCount: 7, issueCount: 0 };
    overview!.dependencies.push(
      ...Array.from({ length: 3 }, (_, index) => ({
        pluginId: `official/direct-${index}`,
        displayName: `Direct ${index}`,
        relation: 'direct' as const,
        depth: 1,
        requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }],
        placements: [
          { platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
          { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
        ],
        aggregateStatus: index === 2 ? 'needsAttention' as const : 'notInstalled' as const,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        pluginId: `official/transitive-${index}`,
        displayName: `Transitive ${index}`,
        relation: 'transitive' as const,
        depth: 2,
        requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }],
        placements: [
          { platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
          { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
        ],
        aggregateStatus: 'notInstalled' as const,
      })),
    );
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    for (const [index, label] of ['添加插件', '安装通用 Skills…', '查看依赖关系', '查看来源'].entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    }
    expect(instance.lastFrame()).toContain('Direct 2');
    expect(instance.lastFrame()).toContain('需要处理');
    expect(instance.lastFrame()).toContain('另有 3 个直接依赖');
    expect(instance.lastFrame()).toContain('另有 3 个间接依赖');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
  });

  it('renders P04 and P13 Portable capability cards without materializing candidates', async () => {
    const loaded = loadResult();
    loaded.portablePluginIds = ['official/review-gate', 'team-tools/review-gate'];
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    const screens = new Set<ConsoleV4ScreenId>();
    value.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
    const preview = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('P04');
    expect(preview.lastFrame()).toContain('通用 Skills');
    expect(preview.lastFrame()).toContain('可安装');
    expect(preview.lastFrame()).not.toContain('候选');
    expect(captureEvidence).not.toHaveBeenCalled();
    preview.unmount();

    value.replace({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(screens).toContain('P13');
    expect(frame).toContain('通用 Skills');
    expect(frame).toContain('可安装');
    expect(frame).toContain('选择 Skill 和 Agent 后交给 Skills CLI 安装');
    expect(frame).not.toContain('安装状态未知');
    expect(frame).not.toContain('候选');
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['D09', dependencyLoadResult({ rootState: 'present' }), 'official/agent-lab', ['Codex', 'Claude Code', '必需依赖', '通用 Skills', '关于与技术详情']],
    ['P13', loadResult(), 'team-tools/review-gate', ['Codex', 'Claude Code', '通用 Skills', '设置', '关于与技术详情']],
  ] as const)('keeps every %s action and HelpBar visible while moving through a mounted 60x18 detail', async (
    expectedScreen,
    loaded,
    pluginId,
    labels,
  ) => {
    loaded.portablePluginIds = [pluginId];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    for (const [index, label] of labels.entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
    }
    expect(screens).toContain(expectedScreen);
  });

  it.each([
    ['D09', dependencyLoadResult({ rootState: 'present' }), 'official/agent-lab', ['Codex', 'Claude Code', '必需依赖', '通用 Skills', '关于与技术详情']],
    ['P13', loadResult(), 'team-tools/review-gate', ['Codex', 'Claude Code', '通用 Skills', '设置', '关于与技术详情']],
  ] as const)('keeps every %s action and HelpBar visible while moving through a mounted 80x24 detail', async (
    expectedScreen,
    loaded,
    pluginId,
    labels,
  ) => {
    loaded.portablePluginIds = [pluginId];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    for (const [index, label] of labels.entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    }
    expect(screens).toContain(expectedScreen);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginAbout', pluginId });
  });

  it('mounts dependency placement, target platforms, installed detail, and installed relation templates', async () => {
    const available = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()) });
    await available.load();
    const availableScreens = new Set<ConsoleV4ScreenId>();
    available.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    const placement = render(<ConsoleAppV4 controller={available} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => availableScreens.add(screen)} />);
    await nextTurn(2);
    expect(availableScreens).toContain('D03');
    expect(placement.lastFrame()).toContain('依赖位置');
    expect(placement.lastFrame()).toContain('依赖将在下一步单独确认');
    expect(placement.lastFrame()).toContain('这里只选择根插件位置');
    expect(placement.lastFrame()).toContain('依赖可以在下一步单独调整');
    expect(placement.lastFrame()).not.toContain('缺失依赖使用同一个位置');
    expect(placement.lastFrame()?.match(/›/gu)).toHaveLength(1);
    placement.unmount();

    available.replace({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const targetsPage = render(<ConsoleAppV4 controller={available} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => availableScreens.add(screen)} />);
    await nextTurn(2);
    expect(availableScreens).toContain('D04');
    expect(targetsPage.lastFrame()).toContain('目标平台兼容性');
    expect(targetsPage.lastFrame()).toContain('至少选择一个目标平台');
    expect(targetsPage.lastFrame()?.match(/›/gu)).toHaveLength(1);
    targetsPage.unmount();

    const installed = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })) });
    await installed.load();
    const installedScreens = new Set<ConsoleV4ScreenId>();
    installed.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const detail = render(<ConsoleAppV4 controller={installed} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => installedScreens.add(screen)} />);
    await nextTurn(2);
    expect(installedScreens).toContain('D09');
    expect(detail.lastFrame()).toContain('查看直接、间接依赖和被使用情况');
    expect(detail.lastFrame()).toContain('1 个直接 · 2 个总计');
    detail.unmount();

    installed.replace({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const relations = render(<ConsoleAppV4 controller={installed} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => installedScreens.add(screen)} />);
    await nextTurn(2);
    expect(installedScreens).toContain('D10');
    expect(relations.lastFrame()).toContain('依赖与被使用情况');
    expect(relations.lastFrame()).toContain('根节点');
    expect(relations.lastFrame()).not.toContain('› Agent Skill Toolkit');
  });

  it('runs scope to platform to per-target placement to Review and restores the draft on Back', async () => {
    const planFor = (intent: OperationIntent): DependencyOperationPlan => {
      if (intent.kind !== 'pluginWrite') throw new Error('expected plugin write');
      return placementPlanFor(intent);
    };
    const previewDependencyPlacement = vi.fn(async (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>) =>
      planFor(intent));
    const captureEvidence = vi.fn(async (intent: OperationIntent) => ({
      ...evidence,
      dependencyPlan: planFor(intent),
    }));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      previewDependencyPlacement,
      captureEvidence,
    });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, '\r', '\u001B[B', '\r', '\u001B[B', '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacement', pluginId: 'official/agent-lab',
    });
    expect(instance.lastFrame()).toContain('选择每个平台的依赖位置');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit · Codex');
    expect(instance.lastFrame()).toContain('Agent Content Toolkit · Codex');
    expect(instance.lastFrame()).not.toContain('Space');
    const beforeSpace = value.snapshot.installPlacementDraft;
    await input(instance, ' ');
    expect(value.snapshot.installPlacementDraft).toEqual(beforeSpace);

    await input(instance, '\u001B[B', '\r', '\u001B[B', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacement', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user',
        assignmentSource: 'userOverride',
      }),
      expect.objectContaining({
        pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user',
        assignmentSource: 'consumerPromotion',
      }),
    ]));
    expect(instance.lastFrame()).toContain('因依赖自动调整');

    await input(instance, '\u001B[B', '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/skill-toolkit', group: 'dependencies' }),
      expect.objectContaining({ pluginId: 'official/content-toolkit', group: 'dependencies' }),
    ]));
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      dependencyScopeOverrides: [expect.objectContaining({
        pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user',
      })],
    }), expect.any(AbortSignal));

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacement', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user',
    });
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, '\u001B[A', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacementEditor',
      pluginId: 'official/agent-lab',
      dependencyPluginId: 'official/skill-toolkit',
      platform: 'codex',
    });
  });

  it('mounts a legal user install when a dependency currently exists only in project scope', async () => {
    const loaded = dependencyLoadResult();
    for (const entry of loaded.payload.targets.filter((target) =>
      target.pluginId === 'official/skill-toolkit' && target.platform === 'codex')) {
      entry.state = entry.scope === 'project' ? 'present' : 'absent';
    }
    const rootOverview = loaded.dependencyOverviews?.find((entry) =>
      entry.pluginId === 'official/agent-lab');
    const installedDependency = rootOverview?.dependencies.find((entry) =>
      entry.pluginId === 'official/skill-toolkit');
    if (installedDependency) {
      installedDependency.placements = [{
        platform: 'codex', state: 'installed', scope: 'project', health: 'ready',
      }];
      installedDependency.aggregateStatus = 'ready';
    }
    const planFor = (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>) =>
      createDependencyPlacementPlan({
        requestedPluginIds: ['official/agent-lab'],
        operation: 'install',
        roots: [{ pluginId: 'official/agent-lab', platform: 'codex', scope: intent.scope }],
        dependencyEdges: [
          { from: 'official/agent-lab', to: 'official/skill-toolkit', platform: 'codex' },
          { from: 'official/skill-toolkit', to: 'official/content-toolkit', platform: 'codex' },
        ],
        scopeOverrides: intent.dependencyScopeOverrides,
        nodes: [
          {
            pluginId: 'official/agent-lab', pluginName: 'Agent Lab', platform: 'codex',
            relation: 'requested', depth: 0, allowedScopes: ['project', 'user'],
            current: { project: 'absent', user: 'absent' },
          },
          {
            pluginId: 'official/skill-toolkit', pluginName: 'Agent Skill Toolkit', platform: 'codex',
            relation: 'dependency', depth: 1, allowedScopes: ['project', 'user'],
            current: { project: 'present', user: 'absent' },
          },
          {
            pluginId: 'official/content-toolkit', pluginName: 'Agent Content Toolkit', platform: 'codex',
            relation: 'dependency', depth: 2, allowedScopes: ['project', 'user'],
            current: { project: 'absent', user: 'present' },
          },
        ],
      });
    const previewDependencyPlacement = vi.fn(async (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>) =>
      planFor(intent));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      previewDependencyPlacement,
      captureEvidence: vi.fn(async (intent) => ({
        ...evidence,
        dependencyPlan: planFor(intent as Extract<OperationIntent, { kind: 'pluginWrite' }>),
      })),
    });
    await value.load();
    value.beginInstallFlow('official/agent-lab', 'user');
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(value.listInstallTargets('official/agent-lab', 'user')).toContainEqual({
      platform: 'codex', compatible: true,
    });
    expect(instance.lastFrame()).toContain('› ◇ Codex');
    expect(instance.lastFrame()).not.toContain('只在当前项目可用');
    await input(instance, '\r', '\u001B[B', '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(planFor({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab',
      platform: 'codex', scope: 'user',
    }).targets).toContainEqual(expect.objectContaining({
      pluginId: 'official/skill-toolkit',
      resolvedScope: 'user',
      assignmentSource: 'consumerPromotion',
    }));
    expect(value.snapshot.activeReview?.changes).toContainEqual(expect.objectContaining({
      pluginId: 'official/skill-toolkit', group: 'dependencies', kind: 'add',
    }));
    expect(instance.lastFrame()).toContain('skill-toolkit');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps a long dependency placement list, current focus, actions, and HelpBar visible at %ix%i',
    async (columns, rows) => {
      const plan: DependencyOperationPlan = {
        dependencyPlanSchemaVersion: 2,
        dependencyPlanDigest: 'sha256:long-placement',
        requestedPluginIds: ['official/agent-lab'],
        resolvedPluginIds: [
          ...Array.from({ length: 12 }, (_, index) => `official/dependency-${index + 1}`),
          'official/agent-lab',
        ],
        dependencyEdges: Array.from({ length: 12 }, (_, index) => ({
          from: 'official/agent-lab',
          to: `official/dependency-${index + 1}`,
          platform: 'codex' as const,
        })),
        scopeOverrides: [],
        claimRoots: [],
        targets: [
          ...Array.from({ length: 12 }, (_, index): DependencyOperationPlan['targets'][number] => ({
            pluginId: `official/dependency-${index + 1}`,
            pluginName: `Dependency ${index + 1}`,
            platform: 'codex', relation: 'dependency', depth: 1,
            requiredBy: ['official/agent-lab'], rootScope: 'project', minimumScope: 'project',
            resolvedScope: 'project', allowedScopes: ['project', 'user'],
            assignmentSource: 'default', locked: false, affectsOtherProjects: false,
            state: 'absent', action: 'install', order: index,
          })),
          {
            pluginId: 'official/agent-lab', pluginName: 'Agent Lab', platform: 'codex',
            relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
            minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
            assignmentSource: 'root', locked: true, affectsOtherProjects: false,
            state: 'absent', action: 'install', order: 12,
          },
        ],
      };
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
        previewDependencyPlacement: vi.fn().mockResolvedValue(plan),
      });
      await value.load();
      value.beginInstallFlow('official/agent-lab', 'project');
      value.setInstallPlatforms(['codex']);
      await value.prepareInstallDependencyPlacement();
      value.push({ name: 'dependencyPlacement', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      await input(instance, ...Array.from({ length: 12 }, () => '\u001B[B'));
      let frame = instance.lastFrame() ?? '';
      expect(frame).toContain('› 继续到确认');
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, '\u001B[A', '\r', 'b');
      frame = instance.lastFrame() ?? '';
      expect(value.snapshot.router.current.route.name).toBe('dependencyPlacement');
      expect(frame).toContain('› Dependency 12 · Codex');
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'mounts a user-to-project adjustment as one normal install plan without automatic cleanup at %ix%i',
    async (columns, rows) => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    for (const entry of loaded.payload.targets.filter((target) =>
      target.pluginId === 'official/agent-lab')) {
      entry.state = entry.platform === 'codex' && entry.scope === 'project' ? 'present' : 'absent';
    }
    for (const entry of loaded.payload.targets.filter((target) =>
      target.pluginId === 'official/skill-toolkit' && target.platform === 'codex')) {
      entry.state = 'present';
      entry.desired = { enabled: true, scopes: ['user'], relation: 'dependency' };
      entry.actual = { state: 'ready' };
      entry.sharedNative = { pluginId: 'skill-toolkit@aw-official', state: 'present', shared: true };
      entry.activation = { user: true, project: true, effective: true, evidence: 'observed' };
    }
    const planFor = (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>): DependencyOperationPlan => {
      const selected = intent.dependencyScopeOverrides?.find((entry) =>
        entry.pluginId === 'official/skill-toolkit' && entry.platform === 'codex')?.scope;
      const resolvedScope = selected ?? 'user';
      return {
        dependencyPlanSchemaVersion: 2,
        dependencyPlanDigest: `sha256:adjust-${resolvedScope}`,
        requestedPluginIds: ['official/agent-lab'],
        resolvedPluginIds: ['official/skill-toolkit', 'official/agent-lab'],
        dependencyEdges: [{
          from: 'official/agent-lab', to: 'official/skill-toolkit', platform: 'codex',
        }],
        scopeOverrides: intent.dependencyScopeOverrides ?? [],
        claimRoots: [],
        targets: [
          {
            pluginId: 'official/skill-toolkit', pluginName: 'Agent Skill Toolkit',
            platform: 'codex', relation: 'dependency', depth: 1,
            requiredBy: ['official/agent-lab'], rootScope: 'project', minimumScope: 'project',
            resolvedScope, allowedScopes: ['project', 'user'],
            assignmentSource: selected ? 'userOverride' : 'existingWiderTarget',
            locked: selected !== undefined,
            ...(selected ? { lockReason: 'dependencyScopeOverride' } : {}),
            affectsOtherProjects: resolvedScope === 'user', state: 'present',
            action: 'keep', order: 0,
          },
          {
            pluginId: 'official/agent-lab', pluginName: 'Agent Lab', platform: 'codex',
            relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
            minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
            assignmentSource: 'root', locked: true, affectsOtherProjects: false,
            state: 'present', action: 'keep', order: 1,
          },
        ],
      };
    };
    const executeIntent = vi.fn().mockResolvedValue({ desiredPlacementUpdated: true });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      previewDependencyPlacement: vi.fn(async (intent) => planFor(intent)),
      captureEvidence: vi.fn(async (intent) => ({
        ...evidence,
        dependencyPlan: planFor(intent as Extract<OperationIntent, { kind: 'pluginWrite' }>),
      })),
      executeIntent,
    });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› 调整依赖位置…');

    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('dependencyPlacement');
    expect(instance.lastFrame()).toContain('复用健康的所有项目安装');

    await input(instance, '\r', '\r');
    await nextTurn(3);
    expect(value.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project',
    });
    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(value.snapshot.activeReview).toMatchObject({
      title: '调整依赖位置',
      requiresConfirmation: false,
    });
    expect(instance.lastFrame()).toContain('根插件和插件设置保持不变');
    expect(instance.lastFrame()).not.toContain('自动 cleanup');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, '\r');
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'install',
      dependencyPlacementAdjustment: true,
    }), expect.any(Object));
    expect(executeIntent.mock.calls[0]?.[0]).not.toHaveProperty('dependencyPlacementOnly');
    expect(executeIntent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'cleanup' }), expect.anything());
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(instance.lastFrame()).toContain('操作已完成');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it('groups a layered Review without giving its headings a separate focus and keeps the primary action reachable', async () => {
    const plan = dependencyPlan();
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D05');
    expect(instance.lastFrame()).toContain('根插件');
    expect(instance.lastFrame()).toContain('依赖');
    expect(instance.lastFrame()).not.toContain('Project intent');
    expect(instance.lastFrame()).not.toContain('User intent');
    expect(instance.lastFrame()).toContain('保持');
    expect(instance.lastFrame()).toContain('skill-toolkit');
    expect(instance.lastFrame()).toContain('content-toolkit');
    expect(instance.lastFrame()).toContain('› 添加插件 3 个插件');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\r');
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it.each([
    ['install', 'keep', 'add'],
    ['uninstall', 'keep', 'remove'],
    ['refreshAndSync', 'move', 'keep'],
    ['reinstall', 'move', 'keep'],
    ['sync', 'move', 'keep'],
  ] as const)('mounts %s Review intent rows from the command desired action when targets %s', async (
    action,
    targetAction,
    expectedKind,
  ) => {
    const plan = placementPlanFor({ platform: 'codex', scope: 'project' });
    plan.targets = plan.targets.map((entry) => ({ ...entry, action: targetAction }));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action, pluginId: 'official/agent-lab',
      platform: 'codex', scope: 'project',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const intentRows = value.snapshot.activeReview?.changes.filter((change) =>
      change.group === 'requested' || change.group === 'dependencies') ?? [];

    expect(intentRows.length).toBeGreaterThan(0);
    expect(intentRows.every((change) => change.kind === expectedKind)).toBe(true);
    expect(instance.lastFrame()).toContain(action === 'uninstall' ? '移除插件' : '你选择的插件');
    instance.unmount();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'requires the Phase4 shared impact confirmation before executing at %ix%i',
    async (columns, rows) => {
      const intent = {
        kind: 'pluginWrite' as const,
        action: 'install' as const,
        pluginId: 'official/agent-lab',
        platform: 'codex' as const,
        scope: 'project' as const,
        dependencyScopeOverrides: [{
          pluginId: 'official/skill-toolkit', platform: 'codex' as const, scope: 'user' as const,
        }],
      };
      const plan = placementPlanFor(intent);
      const codexReconcilePlans = [{
        sharedNativeActions: [{
          pluginId: 'official/agent-lab', codexPluginId: 'agent-lab@aw-official',
          action: 'replace', desiredVersion: '2.0.0', affectsOtherScopes: true,
        }],
        activationActions: {
          user: [{
            pluginId: 'official/skill-toolkit', codexPluginId: 'skill-toolkit@aw-official',
            scope: 'user', action: 'enable', desired: true,
          }],
          project: [{
            pluginId: 'official/agent-lab', codexPluginId: 'agent-lab@aw-official',
            scope: 'project', action: 'enable', desired: true,
          }],
        },
        extensionWrites: [{
          pluginId: 'official/agent-lab', componentKey: 'extensions.instructions:guide',
          kind: 'instruction', scope: 'project', action: 'write',
        }],
        extensionRemovals: [],
        review: {
          requiresConfirmation: true,
          sharedImpact: {
            pluginIds: ['agent-lab@aw-official'],
            warning: '共享 native 内容会影响其他项目。',
          },
        },
      }] as unknown as NonNullable<OperationEvidence['codexReconcilePlans']>;
      const executeIntent = vi.fn().mockResolvedValue({
        overallState: 'succeeded', dependencyPlan: plan, targetResults: [],
      });
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
        captureEvidence: vi.fn().mockResolvedValue({
          ...evidence, dependencyPlan: plan, codexReconcilePlans,
        }),
        executeIntent,
      });
      await value.load();
      await value.buildOperationReview(intent);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      const initial = instance.lastFrame() ?? '';
      expect(initial).toContain('需要确认共享影响');
      expect(initial).toContain('确认共享影响');
      expect(initial).toContain('请先确认共享影响');
      for (const layer of [
        'Project intent', 'User intent', 'Shared Codex native',
        'User activation', 'Project activation', 'AW extensions',
      ]) expect(initial).not.toContain(layer);
      expect(initial).toContain('↑↓ 移动');
      expect(initial.split('\n').length).toBeLessThanOrEqual(rows);
      await input(instance, 'd');
      expect(instance.lastFrame()).toContain('Codex 平台共享内容');
      expect(instance.lastFrame()).toMatch(/另有 \d+ 项/u);
      await input(instance, '\r');
      expect(executeIntent).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('已确认共享影响');
      expect(instance.lastFrame()).toContain(`› 添加插件 ${plan.resolvedPluginIds.length} 个插件`);

      await input(instance, '\r');
      await nextTurn(3);
      expect(executeIntent).toHaveBeenCalledTimes(1);
    },
  );

  it('requires explicit confirmation before a shared native config retry executes', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded', targetResults: [],
    });
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        config: {
          scope: 'user',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          affectedTargets: [{ platform: 'codex', scope: 'user' }],
          sharedNativeRenderTargets: [{
            id: 'explore', skillKey: 'codex-explore', refreshKeys: ['exploreWait'],
          }],
        },
      }),
      executeIntent,
    });
    await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/enhance', scope: 'user',
      apply: true, retryApply: true,
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('需要确认共享影响');
    expect(instance.lastFrame()).toContain('请先确认共享影响');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('已确认共享影响');
    await input(instance, '\r');
    await nextTurn(3);
    expect(executeIntent).toHaveBeenCalledOnce();
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSave', retryApply: true,
    }), expect.anything());
  });

  it('executes an ordinary config retry without shared confirmation', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded', targetResults: [],
    });
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        config: {
          scope: 'user',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          affectedTargets: [{ platform: 'claude', scope: 'user' }],
        },
      }),
      executeIntent,
    });
    await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/enhance', scope: 'user',
      apply: true, retryApply: true,
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).not.toContain('Shared impact 需要显式确认');
    await input(instance, '\r');
    await nextTurn(3);
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it('enters the existing Review chain from a mounted needsSync platform action', async () => {
    const loaded = loadResult();
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'official/agent-lab');
    loaded.payload.targets.push({
      pluginName: 'agent-lab',
      pluginId: 'official/agent-lab',
      sourceId: 'official',
      sourceIdentity: 'identity:official',
      version: '0.4.2',
      platform: 'codex',
      scope: 'project',
      cwd: '/workspace',
      desired: { enabled: true, scopes: ['project'], relation: 'root' },
      actual: { state: 'needsSync' },
      state: 'present',
      components: [],
      errors: [],
      recovery: [{
        command: 'sync',
        scope: 'project',
        description: '同步当前项目 desired intent',
      }],
      sharedNative: {
        pluginId: 'agent-lab@aw-official',
        state: 'present',
        shared: true,
      },
      activation: {
        user: false,
        project: false,
        effective: false,
        evidence: 'observed',
      },
    });
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
    });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const initial = instance.lastFrame() ?? '';
    expect(initial).toContain('需要同步');
    expect(initial).toContain('位置');
    expect(initial).toContain('状态');
    expect(initial).toContain('› 同步已保存的使用位置…');
    expect(initial.split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, '\r');
    await nextTurn(3);

    expect(captureEvidence).toHaveBeenCalledWith({
      kind: 'pluginWrite',
      action: 'sync',
      pluginId: 'official/agent-lab',
      platform: 'codex',
      scope: 'project',
    }, expect.any(AbortSignal));
    expect(value.snapshot.router.current.route.name).toBe('review');
  });

  it.each([
    ['user', 'project', '\u001B[B'],
    ['project', 'user', ''],
  ] as const)('adds a second pure-native scope from %s to %s by reusing exact shared native', async (
    enabledScope,
    addedScope,
    scopeKey,
  ) => {
    const loaded = loadResult();
    loaded.pluginSummaries = [loaded.pluginSummaries[0]!];
    loaded.pluginSummaries[0]!.supportedTargets = { codex: ['user', 'project'], claude: [] };
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.payload.targets = [{
      pluginName: 'agent-lab',
      pluginId: 'official/agent-lab',
      sourceId: 'official',
      sourceIdentity: 'identity:official',
      version: '0.4.2',
      platform: 'codex',
      scope: enabledScope,
      cwd: '/workspace',
      desired: { enabled: true, scopes: [enabledScope], relation: 'root' },
      actual: { state: 'ready' },
      state: 'present',
      components: [],
      errors: [],
      recovery: [],
      sharedNative: {
        pluginId: 'agent-lab@aw-official', state: 'present', shared: true,
      },
      activation: {
        user: enabledScope === 'user',
        project: enabledScope === 'project',
        effective: true,
        evidence: 'observed',
      },
    }];
    const codexReconcilePlans = [{
      sharedNativeActions: [{
        pluginId: 'official/agent-lab',
        codexPluginId: 'agent-lab@aw-official',
        action: 'reuse',
        desiredVersion: '0.4.2',
        affectsOtherScopes: false,
      }],
      activationActions: {
        user: [{
          pluginId: 'official/agent-lab', codexPluginId: 'agent-lab@aw-official',
          scope: 'user', action: addedScope === 'user' ? 'enable' : 'none',
          desired: true,
        }],
        project: [{
          pluginId: 'official/agent-lab', codexPluginId: 'agent-lab@aw-official',
          scope: 'project', action: addedScope === 'project' ? 'enable' : 'none',
          desired: true,
        }],
      },
      extensionWrites: [],
      extensionRemovals: [],
      review: { requiresConfirmation: false, sharedImpact: { pluginIds: [] } },
    }] as unknown as NonNullable<OperationEvidence['codexReconcilePlans']>;
    const captureEvidence = vi.fn().mockResolvedValue({ ...evidence, codexReconcilePlans });
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{
        target: { pluginId: 'official/agent-lab', platform: 'codex', scope: addedScope },
        state: 'completed',
      }],
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain(`在${addedScope === 'user' ? '所有项目' : '当前项目'}中启用…`);
    await input(instance, '\r', ...(scopeKey ? [scopeKey] : []), '\r');
    expect(value.snapshot.router.current.route.name).toBe('installTargets');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).not.toContain('Space');

    await input(instance, '\u001B[B', '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab',
      platform: 'codex', scope: addedScope,
    }), expect.any(AbortSignal));
    const reviewFrame = instance.lastFrame() ?? '';
    expect(reviewFrame).not.toContain('Shared Codex native');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'sharedCodexNative', kind: 'keep',
        description: '复用完全相同的平台共享内容',
      }),
      expect.objectContaining({
        group: addedScope === 'user' ? 'userActivation' : 'projectActivation',
        kind: 'change', description: `启用${addedScope === 'user' ? '所有项目' : '当前项目'}位置 · 将更新`,
      }),
    ]));
    await input(instance, 'd');
    const technicalReviewFrame = instance.lastFrame() ?? '';
    expect(technicalReviewFrame).toContain('Codex 平台共享内容');
    expect(technicalReviewFrame).toContain('复用完全相同的平台共享内');
    expect(technicalReviewFrame).not.toContain('claim');
    expect(technicalReviewFrame).not.toContain('install · shared');

    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent.mock.calls[0]?.[0]).toMatchObject({ scope: addedScope });
  });

  it('shows two real mixed-conflict recovery paths in detail, issue, and platform, then executes only the selected uninstall', async () => {
    const recovery = [
      {
        command: 'uninstall' as const,
        scope: 'user' as const,
        description: '运行 aw uninstall official/agent-lab --platform codex --scope user，再运行 aw sync official/agent-lab --platform codex --scope project。',
      },
      {
        command: 'uninstall' as const,
        scope: 'project' as const,
        description: '运行 aw uninstall official/agent-lab --platform codex --scope project，再运行 aw sync official/agent-lab --platform codex --scope user。',
      },
    ];
    const loaded = loadResult();
    loaded.pluginSummaries = [loaded.pluginSummaries[0]!];
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    const conflictTarget: StatusV7Payload['targets'][number] = {
      pluginName: 'agent-lab', pluginId: 'official/agent-lab', sourceId: 'official',
      sourceIdentity: 'identity:official', version: '0.4.2', platform: 'codex',
      scope: 'user', cwd: '/workspace',
      desired: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
      actual: { state: 'conflict' }, state: 'present', components: [],
      errors: [{
        code: 'codexExtensionScopeConflict',
        message: 'codexExtensionScopeConflict: mixed scope overlap',
        severity: 'warning',
      }],
      recovery,
      sharedNative: { pluginId: 'agent-lab@aw-official', state: 'present', shared: true },
      activation: { user: true, project: true, effective: true, evidence: 'observed' },
      extensions: { state: 'conflict', kinds: ['instruction'] },
    };
    loaded.payload.targets = [conflictTarget];
    const resolved = structuredClone(loaded);
    resolved.payload.targets = [{
      ...conflictTarget,
      desired: { enabled: true, scopes: ['project'], relation: 'root' },
      actual: { state: 'ready' },
      errors: [], recovery: [],
      activation: { user: false, project: true, effective: true, evidence: 'observed' },
      extensions: { state: 'ready', kinds: ['instruction'] },
    }];
    const loadStatus = vi.fn().mockResolvedValueOnce(loaded).mockResolvedValue(resolved);
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{
        target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'user' },
        state: 'completed',
      }],
    });
    const value = controller({ loadStatus, captureEvidence, executeIntent });
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'scopeConflict')!;
    expect(issue).toBeDefined();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('保留当前项目，移除所有项目 root…');
    expect(instance.lastFrame()).toContain('保留所有项目，移除当前项目 root…');

    value.replace({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('保留当前项目，移除所有项目 root…');
    expect(instance.lastFrame()).toContain('保留所有项目，移除当前项目 root…');

    value.replace({ name: 'issueDetail', issueId: issue.issueId });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('保留当前项目');
    expect(instance.lastFrame()).toContain('保留所有项目');
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('后续：同步当前项目位置');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: '完成此操作后，同步要保留的使用位置。' }),
    ]));
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      action: 'uninstall', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    }), expect.any(AbortSignal));

    await confirmReview(instance, value);
    await nextTurn(5);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent.mock.calls[0]?.[0]).toMatchObject({ action: 'uninstall', scope: 'user' });
    expect(instance.lastFrame()).toContain('后续：同步当前项目位置');
  });

  it('renders kept, failed, and skipped dependency targets as target-level results', async () => {
    const plan = dependencyPlan();
    const loaded = dependencyLoadResult();
    const executeIntent = vi.fn().mockResolvedValue({
      dependencyPlan: plan,
      overallState: 'failed',
      targetResults: [
        { target: { pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user' }, state: 'completed', action: 'keep' },
        { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'failed' },
        { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'completed', action: 'skipped' },
      ],
    });
    const captureEvidence = vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(screens).toContain('D08');
    expect(instance.lastFrame()).toContain('Agent Content Toolkit');
    expect(instance.lastFrame()).toContain('已保留');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('未执行 · 依赖未完成');
    expect(instance.lastFrame()).toContain('已保留');
    expect(instance.lastFrame()).not.toContain('根插件没有留下部分安装');

    await input(instance, '\u001B[B', '\r');
    expect(captureEvidence.mock.calls.at(-1)?.[0]).toMatchObject({
      action: 'install', pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project',
    });
  });

  it('renders a successful dependency result with bounded target rows and visible actions at 60x18', async () => {
    const plan = dependencyPlan();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'succeeded',
        targetResults: [
          { target: { pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user' }, state: 'completed', action: 'keep' },
          { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'completed', action: 'install' },
          { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'completed', action: 'install' },
        ],
      }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D07');
    expect(frame).toContain('操作已完成');
    expect(frame).toContain('Agent Lab');
    expect(frame).toContain('Agent Content Toolkit');
    expect(frame).toContain('Agent Skill Toolkit');
    expect(frame).not.toContain('另有 1 个目标');
    expect(frame).toContain('› 查看插件');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it.each([
    ['dependencyMissing', 'installDependency', 'install', 'absent', 'D14'],
    ['dependencyNotReady', 'reinstallDependency', 'sync', 'partial', 'D15'],
  ] as const)('uses the contract dependency placement for a project consumer %s action', async (
    category,
    actionId,
    writeAction,
    dependencyState,
    expectedScreen,
  ) => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: category,
      rootErrorMessage: `${category}: official/skill-toolkit has changed state.`,
    });
    const dependencyTarget = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/skill-toolkit' && entry.platform === 'codex' && entry.scope === 'user')!;
    dependencyTarget.state = dependencyState;
    dependencyTarget.errors = dependencyState === 'partial'
      ? [{ code: 'missingContent', message: '安全说明' }] : [];
    for (const target of loaded.payload.targets.filter((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex'
      && entry.scope === 'project')) {
      target.errors = [{
        code: category,
        message: `${category}: official/skill-toolkit has changed state.`,
        dependencyPluginId: 'official/skill-toolkit',
        dependencyPlatform: 'codex',
        dependencyScope: 'user',
        dependencyProject: null,
      }];
    }
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === category && candidate.platform === 'codex' && candidate.scope === 'project')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain(expectedScreen);
    expect(instance.lastFrame()).toContain('受影响的根插件');
    expect(instance.lastFrame()).toContain('依赖目标');
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');

    await input(instance, ...(actionId === 'reinstallDependency' ? ['\u001B[B'] : []), '\r');

    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: writeAction,
      pluginId: 'official/skill-toolkit',
      platform: 'codex',
      scope: 'user',
      originIssue: expect.objectContaining({
        actionId,
        consumerPluginId: 'official/agent-lab',
        consumerPlatform: 'codex',
        consumerScope: 'project',
        dependencyPluginId: 'official/skill-toolkit',
        dependencyPlatform: 'codex',
        dependencyScope: 'user',
        dependencyProject: null,
      }),
    }), expect.any(AbortSignal));
  });

  it.each([
    ['dependencyStillRequired', 'codex', 'D12', 80, 24],
    ['dependencyMissing', 'codex', 'D14', 80, 24],
    ['dependencyNotReady', 'codex', 'D15', 80, 24],
    ['dependencyTargetUnsupported', 'claude', 'D16', 80, 24],
    ['dependencyStillRequired', 'codex', 'D12', 60, 18],
    ['dependencyMissing', 'codex', 'D14', 60, 18],
    ['dependencyNotReady', 'codex', 'D15', 60, 18],
    ['dependencyTargetUnsupported', 'claude', 'D16', 60, 18],
  ] as const)('shows bounded safe details for %s on %s as %s at %ix%i', async (
    category,
    platform,
    expectedScreen,
    columns,
    rows,
  ) => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: category,
      rootErrorMessage: `${category}: official/skill-toolkit has changed state.`,
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === category && candidate.platform === platform)!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns, rows }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(2);

    await input(instance, 'd');
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain(expectedScreen);
    expect(frame).toContain(category);
    let allTechnicalPages = frame;
    for (let page = 0; page < 3; page += 1) {
      await input(instance, '\u001B[6~');
      allTechnicalPages += instance.lastFrame() ?? '';
    }
    expect(allTechnicalPages).toContain(category);
    expect(frame).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    expect(frame).toContain('d 技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, 'd');
    for (let index = 0; index < 8 && !instance.lastFrame()?.includes('› 技术详情'); index += 1) {
      await input(instance, '\u001B[B');
    }
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain(category);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it.each(['partial', 'blocked'] as const)(
    'uses D08 dependency recovery for an issue-origin %s dependency result',
    async (resultState) => {
      const loaded = dependencyLoadResult();
      const originTarget = loaded.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'codex'
        && entry.scope === 'project')!;
      originTarget.state = 'partial';
      originTarget.errors = [{ code: 'missingContent', message: '安全说明', severity: 'warning' }];
      const refreshed = structuredClone(loaded);
      const refreshedOrigin = refreshed.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'codex'
        && entry.scope === 'project')!;
      expect(refreshedOrigin.state).toBe('partial');
      const plan = dependencyPlan();
      if (resultState === 'blocked') {
        plan.resolvedPluginIds = ['official/skill-toolkit', 'official/agent-lab'];
        plan.targets = plan.targets.filter((target) => target.pluginId !== 'official/content-toolkit');
      }
      const dependencyEvidence = { ...evidence, dependencyPlan: plan };
      const captureEvidence = vi.fn()
        .mockResolvedValueOnce(dependencyEvidence)
        .mockResolvedValueOnce(dependencyEvidence)
        .mockResolvedValue(evidence);
      const targetResults = resultState === 'partial'
        ? [
            { target: { pluginId: 'official/content-toolkit', platform: 'codex' as const, scope: 'user' as const }, state: 'completed', action: 'keep' },
            { target: { pluginId: 'official/skill-toolkit', platform: 'codex' as const, scope: 'project' as const }, state: 'failed', action: 'install' },
            { target: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'project' as const }, state: 'completed', action: 'skipped' },
          ]
        : [
            { target: { pluginId: 'official/skill-toolkit', platform: 'codex' as const, scope: 'project' as const }, state: 'failed', action: 'install' },
            { target: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'project' as const }, state: 'failed', action: 'skipped' },
          ];
      const executeIntent = vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'failed',
        targetResults,
      });
      const value = controller({
        loadStatus: vi.fn().mockResolvedValueOnce(loaded).mockResolvedValue(refreshed),
        captureEvidence,
        executeIntent,
      });
      await value.load();
      const issue = value.listUserIssues().find((candidate) =>
        candidate.category === 'incompleteInstallation'
        && candidate.pluginId === 'official/agent-lab'
        && candidate.platform === 'codex'
        && candidate.scope === 'project')!;
      value.push({ name: 'issueDetail', issueId: issue.issueId });
      const screens = new Set<ConsoleV4ScreenId>();
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
      await nextTurn(2);
      await input(instance, '\r');
      await confirmReview(instance, value);
      await nextTurn(4);

      const frame = instance.lastFrame() ?? '';
      expect(screens).toContain('D08');
      expect(frame).toContain('Agent Skill Toolkit');
      expect(frame).toContain('失败');
      expect(frame).toContain('查看失败项');
      expect(frame).toContain('重试失败部分…');
      expect(frame).not.toContain('返回问题详情');
      expect(frame).not.toContain('重新检查问题');
      if (resultState === 'partial') {
        expect(frame).toContain('Agent Content Toolkit');
        expect(frame).toContain('已保留');
        expect(frame).toContain('Agent Lab');
        expect(frame).toContain('未执行 · 依赖未完成');
      }

      await input(instance, '\u001B[B', '\r');
      expect(value.snapshot.activeReview).toMatchObject({
        pluginAction: 'install',
        subject: { name: 'Agent Skill Toolkit', sourceLabel: 'official' },
      });
      expect(captureEvidence.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: 'pluginWrite',
        action: 'install',
        pluginId: 'official/skill-toolkit',
        platform: 'codex',
        scope: 'project',
      });
      expect(executeIntent).toHaveBeenCalledTimes(1);
    },
  );

  it('renders failed and skipped dependency targets as a failure without preserved-success claims', async () => {
    const plan = dependencyPlan();
    plan.resolvedPluginIds = ['official/skill-toolkit', 'official/agent-lab'];
    plan.targets = plan.targets.filter((target) => target.pluginId !== 'official/content-toolkit');
    const before = dependencyLoadResult();
    const after = dependencyLoadResult();
    const captureEvidence = vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'failed',
        targetResults: [
          { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'failed', action: 'install' },
          { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'failed', action: 'skipped' },
        ],
      }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(screens).toContain('D08');
    expect(value.snapshot.result).toMatchObject({
      state: 'blocked', code: 'operationFailed', summary: { code: 'operationFailed' },
    });
    expect(instance.lastFrame()).toContain('依赖安装没有完成');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('未执行 · 依赖未完成');
    expect(instance.lastFrame()).not.toContain('只完成了一部分');
    expect(instance.lastFrame()).not.toContain('已完成或已保留的目标保持可用');
    expect(instance.lastFrame()).not.toContain('写入可能已完成');
    const captureCalls = captureEvidence.mock.calls.length;
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform', pluginId: 'official/skill-toolkit', platform: 'codex',
    });
    expect(captureEvidence).toHaveBeenCalledTimes(captureCalls);
  });

  it('allows an unreferenced Claude placement removal while Codex remains required', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    for (const platform of ['codex', 'claude'] as const) {
      const target = loaded.payload.targets.find((entry) =>
        entry.pluginId === 'official/skill-toolkit' && entry.platform === platform && entry.scope === 'user')!;
      target.state = 'present';
    }
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/skill-toolkit', platform: 'claude' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\r');

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      action: 'uninstall', pluginId: 'official/skill-toolkit', platform: 'claude', scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('keeps a target available when refresh requires promoting a dependency to user scope', async () => {
    const permissive = dependencyLoadResult();
    const restricted = structuredClone(permissive);
    restricted.payload.targets = restricted.payload.targets.filter((target) => !(
      target.pluginId === 'official/skill-toolkit'
      && target.platform === 'codex' && target.scope === 'project'));
    const skillSummary = restricted.pluginSummaries.find((summary) => summary.pluginId === 'official/skill-toolkit')!;
    skillSummary.supportedTargets = { codex: ['user'], claude: [] };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(permissive).mockResolvedValue(restricted),
      captureEvidence,
    });
    await value.load();
    value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    await value.load();
    await nextTurn(3);

    expect(screens).toContain('D04');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).not.toContain('所选目标平台不可用');
    expect(instance.lastFrame()).not.toContain('Agent Skill Toolkit 不支持所选位置');
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it('shows the requested root and preserved dependencies in the root removal Review', async () => {
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D11');
    expect(instance.lastFrame()).toContain('你选择的插件');
    expect(instance.lastFrame()).toContain('Codex · 当前项目');
    expect(instance.lastFrame()).toContain('保持不变');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
  });

  it('does not expose force cleanup from a dependency removal blocker', async () => {
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })),
      executeIntent,
    });
    await value.load();
    value.push({
      name: 'pluginDependencies', pluginId: 'official/skill-toolkit', view: 'removeBlocked',
      platform: 'codex', scope: 'user',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D12');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).not.toContain('强制清理');
    expect(instance.lastFrame()).not.toContain('› Agent Lab');
    expect(instance.lastFrame()).toContain('› 查看完整依赖关系');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('dependencyStillRequired');
    expect(technicalFrame).toContain('已安装插件仍在使用这个依赖');
    expect(technicalFrame).not.toContain('强制清理');
    expect(technicalFrame).toContain('d 技术详情');
    expect(technicalFrame).toContain('↑↓ 移动');
    expect(technicalFrame.match(/›/gu)).toHaveLength(1);
    expect(technicalFrame.split('\n').length).toBeLessThanOrEqual(18);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('keeps a restricted cleanup outside Review when no exact candidate exists', async () => {
    const getForceCleanupCandidate = vi.fn().mockResolvedValue(undefined);
    const startForceCleanupReview = vi.fn();
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(forceCleanupLoadResult()),
      executeIntent,
    });
    await value.load();
    vi.spyOn(value, 'getForceCleanupCandidate').mockImplementation(getForceCleanupCandidate);
    vi.spyOn(value, 'startForceCleanupReview').mockImplementation(startForceCleanupReview);
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('检查受限清理…');
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);

    expect(getForceCleanupCandidate).toHaveBeenCalledWith('team-tools/review-gate', 'codex', 'user');
    expect(startForceCleanupReview).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex',
    });
    expect(instance.lastFrame()).toContain('当前没有可安全确认的受限清理目标');
  });

  it('uses the core exact candidate to prepare restricted cleanup Review without reinstalling', async () => {
    const candidate = {
      pluginId: 'team-tools/review-gate',
      platform: 'codex' as const,
      scope: 'user' as const,
      actionCount: 1,
    };
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(forceCleanupLoadResult()),
      executeIntent,
    });
    await value.load();
    const getForceCleanupCandidate = vi.spyOn(value, 'getForceCleanupCandidate')
      .mockResolvedValue(candidate);
    const startForceCleanupReview = vi.spyOn(value, 'startForceCleanupReview')
      .mockImplementation((exact) => value.startReviewPreparation({
        kind: 'pluginWrite',
        action: 'cleanup',
        pluginId: exact.pluginId,
        platform: exact.platform,
        scope: exact.scope,
        force: true,
      }));
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);

    expect(getForceCleanupCandidate).toHaveBeenCalledWith('team-tools/review-gate', 'codex', 'user');
    expect(startForceCleanupReview).toHaveBeenCalledWith(candidate);
    expect(['reviewPreparing', 'review']).toContain(value.snapshot.router.current.route.name);
    expect(value.snapshot.activeReview?.pluginAction).not.toBe('reinstall');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('renders dependency target incompatibility as D16 and only offers compatible target platforms', async () => {
    const loaded = dependencyLoadResult();
    const unsupported = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab' && entry.platform === 'claude' && entry.scope === 'user')!;
    unsupported.state = 'error';
    unsupported.errors = [{
      code: 'dependencyTargetUnsupported',
      message: 'official/skill-toolkit 不支持 Claude Code',
      severity: 'blocking',
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'dependencyTargetUnsupported')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D16');
    expect(instance.lastFrame()).toContain('无法添加到 Claude Code');
    expect(instance.lastFrame()).toContain('只添加到 Codex');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
  });

  it('budgets D10 with dependency and dependent rows and projects mixed placement status consistently', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    const mixedDependency = overview.dependencies.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    mixedDependency.aggregateStatus = 'needsAttention';
    mixedDependency.placements = [
      { platform: 'codex', state: 'installed', scope: 'user', health: 'ready' },
      { platform: 'claude', state: 'installed', scope: 'user', health: 'incomplete' },
    ];
    overview.dependents.push({
      pluginId: 'official/content-toolkit',
      displayName: 'Agent Content Toolkit',
      relation: 'dependent',
      depth: 1,
      requiredBy: [],
      placements: [{ platform: 'codex', state: 'installed', scope: 'user', health: 'ready' }],
      aggregateStatus: 'ready',
      placementReferences: [{
        consumer: { pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user', project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'user', project: null },
      }],
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D10');
    expect(frame).toContain('根插件 · Agent Lab');
    expect(frame).toContain('需要处理');
    expect(frame).toContain('必需依赖 · Agent Skill Toolkit');
    expect(frame).toContain('被依赖 · Agent Content Toolkit');
    expect(frame).not.toContain('Agent Skill Toolkit             所有项目 · 已可用');
    expect(frame).toContain('› 调整依赖位置…');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('mounts the dependency issue list and invalid graph recovery page as D13 and D17', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyGraphInvalid',
      rootErrorMessage: 'dependencyGraphInvalid: cycle in public dependency graph.',
    });
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    const graphIssue = value.listUserIssues().find((entry) => entry.category === 'dependencyGraphInvalid');
    expect(graphIssue).toBeDefined();
    const screens = new Set<ConsoleV4ScreenId>();
    value.push({ name: 'issueList' });
    const list = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('D13');
    expect(list.lastFrame()).toContain('4 项');
    expect(list.lastFrame()).toMatch(/依赖\s+\d+ 项/u);
    expect(list.lastFrame()).not.toContain('依赖 ·');
    expect(list.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(list.lastFrame()).toContain('↑↓ 移动');
    list.unmount();

    value.push({ name: 'issueDetail', issueId: graphIssue!.issueId });
    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(screens).toContain('D17');
    expect(frame).toContain('来源中的依赖关系无效');
    expect(frame).toContain('没有修改任何安');
    expect(frame).not.toContain('dependencyGraphInvalid');
    expect(frame).toContain('› 查看来源问题');
    expect(frame).toContain('查看依赖关系');
    expect(frame).toContain('技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);

    await input(detail, 'd');
    expect(detail.lastFrame()).toContain('dependencyGraphInvalid');
    expect(detail.lastFrame()).toContain('official/agent-lab');
    await input(detail, 'd');
    const technicalIndex = graphIssue!.actions.findIndex((action) => action.id === 'viewTechnical') + 1;
    for (let index = 0; index < technicalIndex; index += 1) await input(detail, '\u001B[B');
    expect(detail.lastFrame()).toContain('› 技术详情');
    await input(detail, '\r');
    expect(detail.lastFrame()).toContain('dependencyGraphInvalid');
    await input(detail, 'd', ...Array.from({ length: technicalIndex }, () => '\u001B[A'));
    await input(detail, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('does not invent a source recovery action for D17 without a source ID', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyGraphInvalid',
      rootErrorMessage: 'dependencyGraphInvalid: cycle in public dependency graph.',
    });
    const targetWithoutSource = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    expect(targetWithoutSource).toBeDefined();
    (targetWithoutSource as { sourceId?: string }).sourceId = undefined;

    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const graphIssue = value.listUserIssues().find((entry) =>
      entry.category === 'dependencyGraphInvalid'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    expect(graphIssue).toBeDefined();
    expect(graphIssue!.sourceId).toBeUndefined();
    value.push({ name: 'issueDetail', issueId: graphIssue!.issueId });

    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(frame).not.toContain('查看来源问题');
    expect(frame).toContain('› 查看依赖关系');
    expect(frame).toContain('技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('summarizes dependency relations as static rows and keeps the only action visible at 60x18', async () => {
    const loaded = dependencyLoadResult();
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    overview.dependencies.push(...Array.from({ length: 6 }, (_, index) => ({
      pluginId: `official/extra-${index + 1}`,
      displayName: `额外依赖 ${index + 1}`,
      relation: 'transitive' as const,
      depth: 3,
      requiredBy: [{ pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit' }],
      placements: [{ platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] }],
      aggregateStatus: 'notInstalled' as const,
    })));
    overview.summary.totalCount += 6;
    overview.summary.transitiveCount += 6;
    overview.summary.missingCount += 6;
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Agent Skill Toolkit');
    expect(frame).toContain('Agent Content Toolkit');
    expect(frame).toMatch(/后面还有 \d+ 项/u);
    expect(frame).toContain('› 技术详情');
    expect(frame).not.toContain('› Agent Skill Toolkit');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
  });

  it.each([
    ['D02', 'absent', 80, 24],
    ['D10', 'present', 80, 24],
    ['D02', 'absent', 60, 18],
    ['D10', 'present', 60, 18],
  ] as const)('jointly budgets high-volume %s relations with root %s at %ix%i', async (
    expectedScreen,
    rootState,
    columns,
    rows,
  ) => {
    const loaded = dependencyLoadResult({ rootState });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    overview.summary = { directCount: 1, transitiveCount: 7, totalCount: 8, readyCount: 1, missingCount: 7, issueCount: 1 };
    overview.blockers.push({ code: 'dependencyUnavailable', title: '高优先级阻塞', explanation: '来源中的依赖不可用。' });
    overview.dependencies.push(...Array.from({ length: 6 }, (_, index) => ({
      pluginId: `official/high-dependency-${index}`,
      displayName: `高数量依赖 ${index}`,
      relation: 'transitive' as const,
      depth: 2,
      requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }],
      placements: [{ platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] }],
      aggregateStatus: index === 5 ? 'needsAttention' as const : 'notInstalled' as const,
    })));
    overview.dependents.push(...Array.from({ length: 5 }, (_, index) => ({
      pluginId: `official/high-dependent-${index}`,
      displayName: `高数量依赖者 ${index}`,
      relation: 'dependent' as const,
      depth: 1,
      requiredBy: [],
      placements: [{ platform: 'codex' as const, state: 'installed' as const, scope: 'user' as const, health: 'ready' as const }],
      aggregateStatus: 'ready' as const,
      placementReferences: [{
        consumer: { pluginId: `official/high-dependent-${index}`, platform: 'codex' as const, scope: 'user' as const, project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'user' as const, project: null },
      }],
    })));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    const initial = instance.lastFrame() ?? '';
    expect(screens).toContain(expectedScreen);
    const focusedAction = expectedScreen === 'D10' ? '› 调整依赖位置…' : '› 技术详情';
    expect(initial).toContain(focusedAction);
    expect(initial).toContain('阻塞 · 高优先级阻塞');
    expect(initial).toContain('必需依赖 · 高数量依赖 5');
    expect(initial).toContain('需要处理');
    expect(initial).toContain('↑↓ 移动');
    expect(initial.match(/›/gu)).toHaveLength(1);
    expect(initial.split('\n').length).toBeLessThanOrEqual(rows);
    let relationPages = initial;
    for (let page = 0; page < 8; page += 1) {
      await input(instance, '\u001B[6~');
      relationPages += instance.lastFrame() ?? '';
    }
    expect(relationPages).toContain('被依赖 · 高数量依赖者');
    for (let page = 0; page < 8; page += 1) await input(instance, '\u001B[5~');

    await input(instance, 'd');
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain('技术详情');
    expect(technical).toContain('8 依赖 · 5 被依赖 · 已折叠');
    expect(technical).toContain('PgUp/PgDn 查看全部依赖关系');
    expect(technical).toContain(focusedAction);
    expect(technical).toContain('↑↓ 移动');
    expect(technical.match(/›/gu)).toHaveLength(1);
    expect(technical.split('\n').length).toBeLessThanOrEqual(rows);

    if (expectedScreen === 'D10') await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).not.toContain('8 依赖 · 5 被依赖 · 已折叠');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
  });

  it('closes a completed install with two real Esc presses and preserves the browse anchor', async () => {
    const value = controller();
    await value.load();
    value.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      {
        focusIndex: 0,
        scrollOffset: 0,
        query: 'agent',
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/agent-lab',
      },
    );
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    value.beginInstallFlow('official/agent-lab', 'user');
    value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/agent-lab',
      platform: 'codex',
      scope: 'user',
    });
    await value.executeOperation(review.reviewToken);

    expect(value.snapshot.router).toMatchObject({
      depth: 4,
      current: { route: { name: 'result', operationId: review.operationId } },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/agent-lab',
    });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(value.snapshot.router.current).toEqual({
      route: { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      context: {
        focusIndex: 0,
        scrollOffset: 0,
        query: 'agent',
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/agent-lab',
      },
    });
    expect(instance.lastFrame()).toContain('/ agent');

    await input(instance, '\r', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installPlacement', pluginId: 'official/agent-lab',
    });
  });

  it('returns a removed config field route to its surviving layer', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    await value.load();
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' },
      fieldKey: 'removed-field',
      editor: 'string',
    });
    render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' },
    });
  });

  it('restores list focus by entity ID after a reload changes row order', async () => {
    const initial = loadResult();
    const reordered = loadResult();
    reordered.pluginSummaries.unshift({
      pluginName: 'aardvark',
      pluginId: 'official/aardvark',
      displayName: 'Aardvark',
      description: '排序变化夹具',
      version: '1.0.0',
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(reordered),
    });
    await value.load();
    value.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      {
        focusIndex: 1,
        scrollOffset: 10,
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/review-gate',
      },
    );
    value.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await value.load();

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› Review Gate');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginPreview', pluginId: 'official/review-gate',
    });
  });

  it('uses the adjacent list row when the focused entity disappears during reload', async () => {
    const initial = loadResult();
    const withoutFocusedPlugin = loadResult();
    withoutFocusedPlugin.pluginSummaries = withoutFocusedPlugin.pluginSummaries
      .filter((plugin) => plugin.pluginId !== 'official/review-gate');
    withoutFocusedPlugin.payload.targets = withoutFocusedPlugin.payload.targets
      .filter((target) => target.pluginId !== 'official/review-gate');
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(withoutFocusedPlugin),
    });
    await value.load();
    value.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      {
        focusIndex: 1,
        scrollOffset: 10,
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/review-gate',
      },
    );
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await value.load();
    const remaining = value.listPlugins({
      mode: 'browse', sourceId: 'official', installFilter: 'all',
    });
    const adjacent = remaining[Math.min(1, remaining.length - 1)];
    if (!adjacent) throw new Error('expected an adjacent plugin row');

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginPreview', pluginId: adjacent.pluginId,
    });
  });

  it('keeps all diagnostics and the oldest of 20 reports after a failed save at 60 × 18', async () => {
    const value = controller();
    const history = new OperationHistoryStore();
    history.record({
      summary: {
        recordId: '1:operation-1',
        epoch: 1,
        operationId: 'operation-1',
        createdAtMs: 1,
        state: 'partial',
        code: 'operationPartial',
        message: '部分目标没有完成。',
        diagnosticCount: 1,
        effects: {
          configCommit: 'completed',
          awWrite: 'partial',
          preApplyExternalEffect: 'possible',
          finalVerification: 'failed',
        },
      },
      diagnostics: [{
        id: '1:operation-1:target-0',
        code: 'preApplyExited',
        stage: 'preApply',
        safeMessage: '安装前检查没有完成。',
        target: { pluginId: 'official/target-0', platform: 'codex', scope: 'project' },
        causes: [{ code: 'EACCES', safeMessage: '服务报告 EACCES。' }],
        detailLines: ['安全详情第 1 行'],
      }],
      targets: Array.from({ length: 100 }, (_, index) => ({
        pluginId: `official/target-${index}`,
        platform: 'codex' as const,
        scope: 'project' as const,
        state: index === 0 ? 'failed' as const : 'completed' as const,
        ...(index === 0 ? { errorCode: 'preApplyExited', diagnosticIds: ['1:operation-1:target-0'] } : { diagnosticIds: [] }),
      })),
    });
    for (let index = 2; index <= 20; index += 1) {
      history.record({
        summary: {
          recordId: `1:operation-${index}`,
          epoch: 1,
          operationId: `operation-${index}`,
          createdAtMs: index,
          state: 'succeeded',
          code: 'operationSucceeded',
          message: `操作 ${index} 已完成。`,
          diagnosticCount: 0,
          effects: {
            configCommit: 'notApplicable',
            awWrite: 'completed',
            preApplyExternalEffect: 'notApplicable',
            finalVerification: 'completed',
          },
        },
        diagnostics: [],
        targets: [],
      });
    }
    value.attachOperationHistory(history, 1);
    value.push({ name: 'home' });
    const saveReport = vi.spyOn(value, 'saveOperationReport')
      .mockRejectedValueOnce(new Error('private write error'))
      .mockResolvedValueOnce({ path: '/private/tmp/operation-report.md' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, '?', 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    expect(instance.lastFrame()).toContain('操作 20 已完成。');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, ...Array.from({ length: 19 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('部分目标没有完成。');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('安全技术详情');
    expect(instance.lastFrame()).toContain('↓ 还有');
    await input(instance, '\u001B[6~', '\u001B[6~', '\u001B[6~');
    expect(instance.lastFrame()).toContain('official/target-0');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('State: partial');
    await input(instance, '\r', 'temporary-report-path');
    expect(instance.lastFrame()).toContain('temporary-report-path');
    expect(instance.lastFrame()).toContain('Ctrl-U 清空输入');
    await input(instance, '\u0015');
    expect(instance.lastFrame()).not.toContain('temporary-report-path');
    await input(instance, '/tmp/operation-report.md', '\r');
    expect(saveReport).toHaveBeenCalledWith('1:operation-1', '/tmp/operation-report.md');
    expect(instance.lastFrame()).toContain('报告未保存');
    expect(instance.lastFrame()).not.toContain('private write error');
    expect(instance.lastFrame()).toContain('Record: 1:operation-1');
    expect(value.listOperationHistory()).toHaveLength(20);
    expect(value.previewOperationReport('1:operation-1')).toMatchObject({ recordId: '1:operation-1' });
    await input(instance, '\u001B[B', '\r');
    expect(saveReport).toHaveBeenLastCalledWith('1:operation-1');
    expect(instance.lastFrame()).toContain('报告已保存到临时目录');
    expect(instance.lastFrame()).not.toContain('/private/tmp/operation-report.md');

    value.replace({ name: 'result' });
    await nextTurn(2);
    await input(instance, 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });

    const issue = value.listUserIssues()[0]!;
    value.replace({ name: 'issueDetail', issueId: issue.issueId });
    await nextTurn(2);
    await input(instance, 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
  });
});
