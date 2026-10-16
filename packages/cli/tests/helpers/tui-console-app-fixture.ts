import { vi } from 'vitest';

import type {
  StatusV8CodexTarget,
  StatusV8Payload,
  StatusV8Placement,
  StatusV8PluginSummary,
  StatusV8Target,
} from '../../src/commands/status-v6.js';
import {
  type DependencyOperationPlan,
} from '../../src/commands/dependency-operation-plan.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import {
  TuiController,
  operationEvidenceFingerprint,
  type OperationEvidence,
  type OperationIntent,
  type PluginWriteBatchEvidence,
  type PluginWriteTaskEvidence,
  type PluginWriteTaskExecutionResult,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel, PluginDependencyOverviewViewModel } from '../../src/tui/model.js';

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export const evidence: OperationEvidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
  source: {
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    snapshotDigest: 'sha256:snapshot',
    contentDigest: 'sha256:content',
  },
  targetFingerprint: 'sha256:target',
};

export function evidenceForIntent(intent: OperationIntent): OperationEvidence {
  if (intent.kind === 'configSaveBatch') {
    return {
      ...evidence,
      configBatch: {
        groups: intent.groups.map((group) => ({
          scope: group.scope,
          targetFingerprint: `sha256:config-${group.scope}`,
          config: {
            scope: group.scope,
            storeDigest: `sha256:config-store-${group.scope}`,
            impactState: 'known',
            affectedTargets: [{ platform: 'codex', scope: group.scope }],
          },
        })),
      },
    };
  }
  if (intent.kind === 'configSave') {
    return {
      ...evidence,
      config: {
        scope: intent.scope,
        storeDigest: 'sha256:config-store',
        impactState: 'known',
        affectedTargets: [{ platform: 'codex', scope: intent.scope }],
      },
    };
  }
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

export function batchEvidenceForIntent(intent: Extract<OperationIntent, { kind: 'pluginWriteBatch' }>): PluginWriteBatchEvidence {
  const targets = intent.selection.kind === 'targets'
    || intent.selection.kind === 'currentProjectIntentTargets'
    ? intent.selection.targets : [];
  const groups = new Map<string, typeof targets>();
  for (const target of targets) {
    const key = [target.pluginId.split('/')[0], target.platform, target.scope].join('\0');
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  return {
    ...evidence,
    requestedPluginIds: [...new Set(targets.map((target) => target.pluginId))],
    groups: [...groups.entries()].map(([groupId, groupTargets]) => ({
      groupId,
      sourceId: groupTargets[0]!.pluginId.split('/')[0]!,
      platform: groupTargets[0]!.platform,
      scope: groupTargets[0]!.scope,
      requestedPluginIds: groupTargets.map((target) => target.pluginId),
      executable: true,
      preview: {
        platforms: [groupTargets[0]!.platform],
        plugins: groupTargets.map((target) => target.pluginId),
        warnings: [], rebuildResults: [], targetResults: [], receiptTargets: [], overallState: 'succeeded',
        operationPlan: createOperationPlan({
          intentChanges: [], actions: [],
          changes: groupTargets.map((target) =>
            `${target.pluginId}:${target.platform}:${target.scope}:${intent.action}`),
          warnings: [],
          evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] },
        }),
      },
    })),
    ...(intent.selection.kind === 'currentProjectIntentTargets'
      ? { projectIntentDigest: 'sha256:project-intent' }
      : {}),
  };
}

export function target(options: {
  pluginName: string;
  sourceId?: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  state: 'present' | 'absent' | 'partial' | 'error';
  errorCode?: string;
  reasons?: StatusV8Placement['reasons'];
  recoveryActions?: StatusV8Placement['recoveryActions'];
}): StatusV8Target {
  const sourceId = options.sourceId ?? 'official';
  const state = options.state === 'present'
    ? 'ready' as const
    : options.state === 'partial'
      ? 'needsSync' as const
      : options.state === 'error' ? 'blocked' as const : 'absent' as const;
  const placement: StatusV8Placement = {
    scope: options.scope,
    state,
    components: [{ kind: 'ownership', key: 'fixture', state: options.state }],
    reasons: options.reasons ?? (options.state === 'partial'
      ? [{ code: 'missingContent', message: '安全说明', severity: 'warning' }]
      : options.state === 'error'
        ? [{ code: options.errorCode ?? 'targetError', message: '安全说明', severity: 'blocking' }]
        : []),
    recoveryActions: options.recoveryActions ?? (options.errorCode === 'sourceMissing'
      || options.errorCode === 'catalogSourceUnavailable'
      || options.errorCode === 'bundleUnavailable'
      ? [
          { command: 'sync', scope: options.scope, description: '来源恢复后同步 desired intent。' },
          { command: 'cleanup', scope: options.scope, description: '来源无法恢复时清理可证明属于 AW 的输出。' },
        ]
      : []),
  };
  const identity = {
    pluginName: options.pluginName,
    pluginId: `${sourceId}/${options.pluginName}`,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    version: '0.4.2',
    cwd: '/workspace',
  };
  if (options.platform === 'claude') return { ...identity, platform: 'claude', ...placement };
  return {
    ...identity,
    platform: 'codex',
    state,
    components: [],
    reasons: [...placement.reasons],
    recoveryActions: [...placement.recoveryActions],
    placements: [placement],
  };
}

export function aggregateCodexTargets(targets: StatusV8Target[]): StatusV8Target[] {
  const results: StatusV8Target[] = [];
  const codex = new Map<string, StatusV8CodexTarget>();
  for (const entry of targets) {
    if (entry.platform === 'claude') {
      results.push(entry);
      continue;
    }
    const current = codex.get(entry.pluginId);
    if (!current) {
      const clone = structuredClone(entry);
      codex.set(entry.pluginId, clone);
      results.push(clone);
      continue;
    }
    current.placements.push(...entry.placements);
    current.reasons = [...new Map(current.placements.flatMap((placement) => placement.reasons)
      .map((reason) => [`${reason.code}\0${reason.message}`, reason])).values()];
    current.recoveryActions = [...new Map(current.placements.flatMap((placement) => placement.recoveryActions)
      .map((action) => [`${action.command}\0${action.scope ?? ''}\0${action.description}`, action])).values()];
    current.state = (['blocked', 'needsSync', 'orphaned', 'ready', 'absent'] as const)
      .find((state) => current.placements.some((placement) => placement.state === state))!;
  }
  return results;
}

export function placement(target: StatusV8Target, scope: 'user' | 'project'): StatusV8Placement {
  if (target.platform === 'claude') {
    if (target.scope !== scope) throw new Error(`Missing ${scope} fixture placement.`);
    return target;
  }
  const value = target.placements.find((entry) => entry.scope === scope);
  if (!value) throw new Error(`Missing ${scope} fixture placement.`);
  return value;
}

export function updatePlacement(
  target: StatusV8Target,
  scope: 'user' | 'project',
  update: Partial<Pick<StatusV8Placement, 'state' | 'components' | 'reasons' | 'recoveryActions'>>,
): void {
  Object.assign(placement(target, scope), update);
  if (target.platform === 'claude') return;
  target.state = (['blocked', 'needsSync', 'orphaned', 'ready', 'absent'] as const)
    .find((state) => target.placements.some((entry) => entry.state === state))!;
  target.reasons = [...new Map(target.placements.flatMap((entry) => entry.reasons)
    .map((reason) => [`${reason.code}\0${reason.message}`, reason])).values()];
  target.recoveryActions = [...new Map(target.placements.flatMap((entry) => entry.recoveryActions)
    .map((action) => [`${action.command}\0${action.scope ?? ''}\0${action.description}`, action])).values()];
}

export function setAllPlacementsAbsent(target: StatusV8Target): StatusV8Target {
  const clone = structuredClone(target);
  if (clone.platform === 'claude') {
    clone.state = 'absent';
    clone.components = clone.components.map((component) => component.kind === 'ownership'
      ? { ...component, state: 'absent' } : component);
    clone.reasons = [];
    clone.recoveryActions = [];
    return clone;
  }
  for (const entry of clone.placements) {
    entry.state = 'absent';
    entry.components = entry.components.map((component) => component.kind === 'ownership'
      ? { ...component, state: 'absent' } : component);
    entry.reasons = [];
    entry.recoveryActions = [];
  }
  clone.state = 'absent';
  clone.reasons = [];
  clone.recoveryActions = [];
  return clone;
}

export function loadResult(): TuiStatusLoadResult {
  const summaries: StatusV8PluginSummary[] = [
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
  const payload: StatusV8Payload = {
      schemaVersion: 8,
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
      targets: aggregateCodexTargets(allTargets),
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

export function dependencyPlan(): DependencyOperationPlan {
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

export function placementPlanFor(intent: {
  platform: 'codex' | 'claude' | 'both';
  scope: 'user' | 'project';
  dependencyScopeOverrides?: Array<{
    pluginId: string;
    platform: 'codex' | 'claude';
    scope: 'user' | 'project';
  }>;
}): DependencyOperationPlan;

export function placementPlanFor(intent: {
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

export function dependencyOverview(options: {
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
        { pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit', relation: 'direct', depth: 1, requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }], placements: [notInstalled('codex'), notInstalled('claude')], aggregateStatus: 'notInstalled', placementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }], availablePlacementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }] },
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
        { pluginId: 'official/agent-lab', displayName: 'Agent Lab', relation: 'dependent', depth: 1, requiredBy: [], placements: rootState === 'ready' ? [readyUser('codex')] : [notInstalled('codex')], aggregateStatus: rootState, placementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }], availablePlacementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }] },
      ],
      blockers: [],
    },
  ];
}

export function dependencyLoadResult(options: {
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
  initial.payload.targets = aggregateCodexTargets([
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) => ({
      ...target({
        pluginName: 'agent-lab', platform, scope, state: rootState,
        reasons: rootState === 'error' ? [{
        code: options.rootErrorCode ?? 'targetError',
        message: options.rootErrorMessage ?? '安全说明',
        severity: 'blocking' as const,
      }] : [],
      }),
    }))),
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) =>
      target({ pluginName: 'skill-toolkit', platform, scope, state: 'absent' }))),
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) =>
      target({ pluginName: 'content-toolkit', platform, scope, state: scope === 'user' ? 'present' : 'absent' }))),
  ]);
  initial.dependencyOverviews = dependencyOverview({
    rootState: rootState === 'present' ? 'ready' : 'notInstalled',
    blockers: options.blockers,
  });
  return initial;
}

export function controller(overrides: Partial<TuiControllerDependencies> = {}): TuiController {
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
  return new TuiController(dependencies);
}

export function pluginWriteTaskExecution(
  evidence: PluginWriteTaskEvidence,
  failedKeys: ReadonlySet<string> = new Set(),
): PluginWriteTaskExecutionResult {
  const sourceResults = evidence.taskPlan.sources.map((source) => {
    const targetResults = source.requestedTargets.map((target) => {
      const failed = failedKeys.has([target.pluginId, target.platform, target.scope].join('\0'));
      return {
        target: {
          pluginId: target.pluginId,
          pluginName: target.pluginId.split('/').at(-1)!,
          sourceId: source.sourceId,
          platform: target.platform,
          scope: target.scope,
        },
        action: 'sync',
        state: failed ? 'failed' as const : 'completed' as const,
        requiredBy: [],
        ...(failed ? { errorCode: 'preApplyExited' } : {}),
      };
    });
    return {
      sourceId: source.sourceId,
      sourceIdentity: source.sourceIdentity,
      requestedTargets: source.requestedTargets,
      result: {
        ...source.preview,
        targetResults,
        overallState: targetResults.some((target) => target.state === 'failed')
          ? targetResults.some((target) => target.state === 'completed') ? 'partial' as const : 'failed' as const
          : 'succeeded' as const,
      },
    };
  });
  const targetResults = sourceResults.flatMap((source) => source.result.targetResults);
  return {
    ...(evidence.taskPlan.sources[0]?.preview ?? {
      platforms: [], plugins: [], warnings: [], rebuildResults: [], receiptTargets: [],
    }),
    taskPlan: evidence.taskPlan,
    sourceResults,
    targetResults,
    overallState: targetResults.some((target) => target.state === 'failed')
      ? targetResults.some((target) => target.state === 'completed') ? 'partial' : 'failed'
      : 'succeeded',
  } as PluginWriteTaskExecutionResult;
}

export function pluginWriteTaskEvidence(
  intent: Extract<OperationIntent, { kind: 'pluginWriteTask' }>,
): PluginWriteTaskEvidence {
  const sources = [...new Set(intent.targets.map((target) => target.pluginId.split('/')[0]!))]
    .map((sourceId) => {
      const requestedTargets = intent.targets.filter((target) => target.pluginId.startsWith(`${sourceId}/`));
      const receiptTargets = requestedTargets.map((target) => ({
        pluginName: target.pluginId.split('/').at(-1)!, sourceId, ...target,
      }));
      const preview = {
        platforms: [...new Set(requestedTargets.map((target) => target.platform))],
        plugins: [...new Set(requestedTargets.map((target) => target.pluginId))],
        warnings: [], rebuildResults: [], receiptTargets,
        targetResults: receiptTargets.map((target) => ({
          target, action: 'sync', state: 'completed' as const,
          relation: 'requested' as const, requiredBy: [],
        })),
        overallState: 'succeeded' as const,
        operationPlan: createOperationPlan({
          intentChanges: [], actions: [], changes: ['selected task targets'], warnings: [],
          evidence: {
            catalogDigests: [{ sourceId, digest: 'sha256:catalog' }],
            intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
          },
        }),
      };
      return {
        sourceId,
        sourceIdentity: `identity:${sourceId}`,
        requestedTargets,
        causes: [],
        preview,
        executable: true,
      };
    });
  const evidence: PluginWriteTaskEvidence = {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    taskPlan: {
      goal: intent.goal,
      requestedTargets: intent.targets,
      executableTargets: intent.targets,
      causes: [],
      blockedTargets: [],
      sources,
      targetFingerprint: 'sha256:selected-targets',
      planFingerprint: '',
    },
  };
  evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
  return evidence;
}

export function platformLoadResult(
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

export function configPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
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

export function objectConfigPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
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
