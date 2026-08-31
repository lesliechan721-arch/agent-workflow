import crypto from 'node:crypto';

import type {
  DependencyScopeOverride,
  DependencyScopeSelector,
  PlatformName,
  Scope,
} from '../types.js';

export type { DependencyScopeOverride } from '../types.js';

export const DEPENDENCY_PLAN_SCHEMA_VERSION = 2;

export type DependencyTargetAction =
  | 'install'
  | 'upgrade'
  | 'reinstall'
  | 'move'
  | 'keep'
  | 'block';
export type DependencyTargetState = 'absent' | 'present' | 'partial' | 'error';
export type DependencyAssignmentSource =
  | 'root'
  | 'default'
  | 'existingWiderTarget'
  | 'userOverride'
  | 'consumerPromotion'
  | 'platformRequirement';

export interface DependencyPlanTarget {
  pluginId: string;
  pluginName: string;
  platform: PlatformName;
  relation: 'requested' | 'dependency';
  depth: number;
  requiredBy: string[];
  rootScope: Scope;
  minimumScope: Scope;
  resolvedScope: Scope;
  allowedScopes: Scope[];
  assignmentSource: DependencyAssignmentSource;
  locked: boolean;
  lockReason?: string;
  affectsOtherProjects: boolean;
  state: DependencyTargetState;
  action: DependencyTargetAction;
  errorCode?: string;
  order: number;
}

export interface DependencyOperationPlan {
  dependencyPlanSchemaVersion: 2;
  dependencyPlanDigest: string;
  requestedPluginIds: string[];
  resolvedPluginIds: string[];
  dependencyEdges: Array<{ from: string; to: string; platform: PlatformName }>;
  scopeOverrides: DependencyScopeOverride[];
  targets: DependencyPlanTarget[];
  claimRoots: Array<{ pluginId: string; platform: PlatformName }>;
}

export interface DependencyOperationPlanInputTarget {
  pluginId: string;
  pluginName: string;
  platform: PlatformName;
  relation: 'requested' | 'dependency';
  requiredBy: string[];
  resolvedScope: Scope;
  state: DependencyTargetState;
  action: DependencyTargetAction;
  order: number;
  requestedScope?: Scope;
  depth?: number;
  rootScope?: Scope;
  minimumScope?: Scope;
  allowedScopes?: Scope[];
  assignmentSource?: DependencyAssignmentSource;
  locked?: boolean;
  lockReason?: string;
  affectsOtherProjects?: boolean;
  errorCode?: string;
}

export interface DependencyOperationPlanInput {
  requestedPluginIds: string[];
  resolvedPluginIds: string[];
  dependencyEdges: Array<{ from: string; to: string; platform?: PlatformName }>;
  scopeOverrides?: DependencyScopeOverride[];
  targets: DependencyOperationPlanInputTarget[];
  claimRoots?: Array<{ pluginId: string; platform: PlatformName }>;
}

export interface DependencyPlacementNodeInput {
  pluginId: string;
  pluginName: string;
  platform: PlatformName;
  relation: 'requested' | 'dependency';
  depth: number;
  allowedScopes: Scope[];
  current?: Partial<Record<Scope, DependencyTargetState>>;
}

export interface DependencyPlacementRootInput {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
}

export interface DependencyPlacementPlanInput {
  requestedPluginIds: string[];
  nodes: DependencyPlacementNodeInput[];
  roots: DependencyPlacementRootInput[];
  dependencyEdges: Array<{ from: string; to: string; platform: PlatformName }>;
  scopeOverrides?: DependencyScopeSelector[];
  operation?: 'install' | 'upgrade' | 'reinstall';
}

const SCOPE_RANK: Record<Scope, number> = { project: 0, user: 1 };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetKey(pluginId: string, platform: PlatformName): string {
  return `${pluginId}\0${platform}`;
}

function compareScope(left: Scope, right: Scope): number {
  return SCOPE_RANK[left] - SCOPE_RANK[right];
}

function widerScope(left: Scope, right: Scope): Scope {
  return SCOPE_RANK[left] >= SCOPE_RANK[right] ? left : right;
}

function canonicalScopes(scopes: readonly Scope[]): Scope[] {
  return [...new Set(scopes)].sort(compareScope);
}

function canonicalOverrides(
  overrides: readonly DependencyScopeOverride[],
): DependencyScopeOverride[] {
  const byKey = new Map<string, DependencyScopeOverride>();
  for (const override of overrides) {
    if (override.platform !== 'codex' && override.platform !== 'claude') {
      throw new Error(`dependencyScopeOverrideInvalidPlatform: ${String(override.platform)}`);
    }
    if (override.scope !== 'project' && override.scope !== 'user') {
      throw new Error(`dependencyScopeOverrideInvalidScope: ${String(override.scope)}`);
    }
    const key = targetKey(override.pluginId, override.platform);
    const current = byKey.get(key);
    if (current && current.scope !== override.scope) {
      throw new Error(`dependencyScopeOverrideConflict: ${override.pluginId}#${override.platform}`);
    }
    byKey.set(key, { ...override });
  }
  return [...byKey.values()].sort((left, right) => compareText(
    targetKey(left.pluginId, left.platform),
    targetKey(right.pluginId, right.platform),
  ));
}

function canonicalScopeSelectors(
  selectors: readonly DependencyScopeSelector[],
): DependencyScopeSelector[] {
  const byKey = new Map<string, DependencyScopeSelector>();
  for (const selector of selectors) {
    if (selector.platform !== undefined
      && selector.platform !== 'codex'
      && selector.platform !== 'claude') {
      throw new Error(`dependencyScopeOverrideInvalidPlatform: ${String(selector.platform)}`);
    }
    if (selector.scope !== 'project' && selector.scope !== 'user') {
      throw new Error(`dependencyScopeOverrideInvalidScope: ${String(selector.scope)}`);
    }
    const key = `${selector.pluginId}\0${selector.platform ?? '*'}`;
    const current = byKey.get(key);
    if (current && current.scope !== selector.scope) {
      throw new Error(
        `dependencyScopeOverrideConflict: ${selector.pluginId}`
        + `${selector.platform ? `#${selector.platform}` : ''}`,
      );
    }
    byKey.set(key, { ...selector });
  }
  return [...byKey.values()].sort((left, right) => compareText(
    `${left.pluginId}\0${left.platform ?? '*'}`,
    `${right.pluginId}\0${right.platform ?? '*'}`,
  ));
}

function expandScopeSelectors(
  selectors: readonly DependencyScopeSelector[],
  nodesByKey: ReadonlyMap<string, DependencyPlacementNodeInput>,
): DependencyScopeOverride[] {
  const nodes = [...nodesByKey.values()];
  const expanded = canonicalScopeSelectors(selectors).flatMap((selector) => {
    const pluginNodes = nodes.filter((node) => node.pluginId === selector.pluginId);
    if (pluginNodes.length === 0) {
      throw new Error(`dependencyScopeOverrideOutsideClosure: ${selector.pluginId}`);
    }
    if (selector.platform) {
      if (!nodesByKey.has(targetKey(selector.pluginId, selector.platform))) {
        throw new Error(
          `dependencyScopeOverrideUnsupportedPlatform: ${selector.pluginId}#${selector.platform}`,
        );
      }
      return [{
        pluginId: selector.pluginId,
        platform: selector.platform,
        scope: selector.scope,
      }];
    }
    return pluginNodes.map((node) => ({
      pluginId: selector.pluginId,
      platform: node.platform,
      scope: selector.scope,
    }));
  });
  return canonicalOverrides(expanded);
}

function canonicalEdges(
  edges: readonly { from: string; to: string; platform: PlatformName }[],
): Array<{ from: string; to: string; platform: PlatformName }> {
  const byKey = new Map<string, { from: string; to: string; platform: PlatformName }>();
  for (const edge of edges) {
    byKey.set(`${edge.from}\0${edge.to}\0${edge.platform}`, { ...edge });
  }
  return [...byKey.values()].sort((left, right) => compareText(
    `${left.platform}\0${left.from}\0${left.to}`,
    `${right.platform}\0${right.from}\0${right.to}`,
  ));
}

function calculateDependencyPlanDigest(
  plan: Omit<DependencyOperationPlan, 'dependencyPlanDigest'>,
): string {
  const digest = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return `sha256:${digest}`;
}

function inferEdgePlatforms(
  edge: { from: string; to: string; platform?: PlatformName },
  targets: readonly DependencyOperationPlanInputTarget[],
): PlatformName[] {
  if (edge.platform) return [edge.platform];
  const fromPlatforms = new Set(targets
    .filter((target) => target.pluginId === edge.from)
    .map((target) => target.platform));
  return [...new Set(targets
    .filter((target) => target.pluginId === edge.to && fromPlatforms.has(target.platform))
    .map((target) => target.platform))].sort(compareText);
}

export function createDependencyOperationPlan(
  input: DependencyOperationPlanInput,
): DependencyOperationPlan {
  const targets = input.targets.map((target): DependencyPlanTarget => {
    const rootScope = target.rootScope ?? target.requestedScope ?? target.resolvedScope;
    return {
      pluginId: target.pluginId,
      pluginName: target.pluginName,
      platform: target.platform,
      relation: target.relation,
      depth: target.depth ?? (target.relation === 'requested' ? 0 : 1),
      requiredBy: [...new Set(target.requiredBy)].sort(compareText),
      rootScope,
      minimumScope: target.minimumScope ?? rootScope,
      resolvedScope: target.resolvedScope,
      allowedScopes: canonicalScopes(target.allowedScopes ?? ['project', 'user']),
      assignmentSource: target.assignmentSource
        ?? (target.relation === 'requested'
          ? 'root'
          : target.resolvedScope !== rootScope ? 'existingWiderTarget' : 'default'),
      locked: target.locked ?? target.relation === 'requested',
      ...(target.lockReason ? { lockReason: target.lockReason } : {}),
      affectsOtherProjects: target.affectsOtherProjects ?? target.resolvedScope === 'user',
      state: target.state,
      action: target.action,
      ...(target.errorCode ? { errorCode: target.errorCode } : {}),
      order: target.order,
    };
  }).sort((left, right) => left.order - right.order || compareText(
    targetKey(left.pluginId, left.platform),
    targetKey(right.pluginId, right.platform),
  ));
  const dependencyEdges = canonicalEdges(input.dependencyEdges.flatMap((edge) =>
    inferEdgePlatforms(edge, input.targets).map((platform) => ({ ...edge, platform }))));
  const planWithoutDigest: Omit<DependencyOperationPlan, 'dependencyPlanDigest'> = {
    dependencyPlanSchemaVersion: DEPENDENCY_PLAN_SCHEMA_VERSION,
    requestedPluginIds: [...new Set(input.requestedPluginIds)].sort(compareText),
    resolvedPluginIds: [...new Set(input.resolvedPluginIds)].sort(compareText),
    dependencyEdges,
    scopeOverrides: canonicalOverrides(input.scopeOverrides ?? []),
    targets,
    claimRoots: [...new Map((input.claimRoots ?? []).map((root) => [
      targetKey(root.pluginId, root.platform),
      { ...root },
    ])).values()].sort((left, right) => compareText(
      targetKey(left.pluginId, left.platform),
      targetKey(right.pluginId, right.platform),
    )),
  };
  return {
    ...planWithoutDigest,
    dependencyPlanDigest: calculateDependencyPlanDigest(planWithoutDigest),
  };
}

interface MutablePlacement {
  node: DependencyPlacementNodeInput;
  rootScope: Scope;
  minimumScope: Scope;
  resolvedScope: Scope;
  assignmentSource: DependencyAssignmentSource;
  locked: boolean;
  lockReason?: string;
  errorCode?: string;
}

function stateFor(
  node: DependencyPlacementNodeInput,
  scope: Scope,
): DependencyTargetState {
  return node.current?.[scope] ?? 'absent';
}

function actionFor(
  placement: MutablePlacement,
  operation: 'install' | 'upgrade' | 'reinstall',
): DependencyTargetAction {
  if (placement.errorCode) return 'block';
  const state = stateFor(placement.node, placement.resolvedScope);
  const otherScope: Scope = placement.resolvedScope === 'project' ? 'user' : 'project';
  if (state === 'error') return 'block';
  if (state === 'present') {
    return operation === 'install' && placement.node.relation === 'dependency'
      ? 'keep'
      : operation;
  }
  if (state === 'partial') return 'reinstall';
  if (stateFor(placement.node, otherScope) !== 'absent') return 'move';
  return operation;
}

export function createDependencyPlacementPlan(
  input: DependencyPlacementPlanInput,
): DependencyOperationPlan {
  const operation = input.operation ?? 'install';
  const nodesByKey = new Map<string, DependencyPlacementNodeInput>();
  for (const node of input.nodes) {
    const key = targetKey(node.pluginId, node.platform);
    if (nodesByKey.has(key)) throw new Error(`dependencyPlacementDuplicateTarget: ${key}`);
    const allowedScopes = canonicalScopes(node.allowedScopes);
    if (allowedScopes.length === 0) throw new Error(`dependencyPlacementNoAllowedScope: ${key}`);
    nodesByKey.set(key, { ...node, allowedScopes });
  }

  const rootsByKey = new Map<string, DependencyPlacementRootInput>();
  for (const root of input.roots) {
    const key = targetKey(root.pluginId, root.platform);
    if (rootsByKey.has(key)) {
      throw new Error(`dependencyPlacementDuplicateRoot: ${root.pluginId}#${root.platform}`);
    }
    rootsByKey.set(key, root);
  }
  for (const [key] of rootsByKey) {
    if (!nodesByKey.has(key)) throw new Error(`dependencyPlacementRootOutsideClosure: ${key}`);
  }
  const overrides = expandScopeSelectors(input.scopeOverrides ?? [], nodesByKey);
  for (const override of overrides) {
    const key = targetKey(override.pluginId, override.platform);
    if (!nodesByKey.has(key)) {
      throw new Error(`dependencyScopeOverrideOutsideClosure: ${override.pluginId}#${override.platform}`);
    }
    if (rootsByKey.has(key)) {
      throw new Error(`dependencyScopeOverrideTargetsRoot: ${override.pluginId}#${override.platform}`);
    }
  }
  const overrideByKey = new Map(overrides.map((override) => [
    targetKey(override.pluginId, override.platform),
    override,
  ]));

  const edges = canonicalEdges(input.dependencyEdges);
  for (const edge of edges) {
    if (!nodesByKey.has(targetKey(edge.from, edge.platform))
      || !nodesByKey.has(targetKey(edge.to, edge.platform))) {
      throw new Error(`dependencyPlacementEdgeOutsideClosure: ${edge.from}->${edge.to}#${edge.platform}`);
    }
  }

  const placements = new Map<string, MutablePlacement>();
  for (const [key, node] of nodesByKey) {
    const root = rootsByKey.get(key);
    const override = overrideByKey.get(key);
    const allowedScopes = node.allowedScopes;
    let rootScope = root?.scope ?? 'project';
    let minimumScope = rootScope;
    let resolvedScope: Scope;
    let assignmentSource: DependencyAssignmentSource;
    let locked = false;
    let lockReason: string | undefined;
    let errorCode: string | undefined;

    if (root) {
      resolvedScope = root.scope;
      assignmentSource = 'root';
      locked = true;
      lockReason = 'requestedRootScope';
    } else if (override) {
      resolvedScope = override.scope;
      assignmentSource = 'userOverride';
      locked = true;
      lockReason = 'dependencyScopeOverride';
    } else if (stateFor(node, 'user') === 'present') {
      resolvedScope = 'user';
      assignmentSource = 'existingWiderTarget';
    } else if (allowedScopes.includes('project')) {
      resolvedScope = 'project';
      assignmentSource = 'default';
    } else {
      resolvedScope = 'user';
      assignmentSource = 'platformRequirement';
    }
    if (!allowedScopes.includes(resolvedScope)) {
      errorCode = root
        ? 'dependencyRootScopeUnsupported'
        : override ? 'dependencyScopeOverrideUnsupported' : 'dependencyTargetUnsupported';
    }
    placements.set(key, {
      node,
      rootScope,
      minimumScope,
      resolvedScope,
      assignmentSource,
      locked,
      ...(lockReason ? { lockReason } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const consumer = placements.get(targetKey(edge.from, edge.platform))!;
      const dependency = placements.get(targetKey(edge.to, edge.platform))!;
      const consumerMinimum = widerScope(consumer.minimumScope, consumer.resolvedScope);
      const nextMinimum = widerScope(dependency.minimumScope, consumerMinimum);
      const nextRootScope = widerScope(dependency.rootScope, consumer.rootScope);
      if (nextMinimum !== dependency.minimumScope) {
        dependency.minimumScope = nextMinimum;
        changed = true;
      }
      if (nextRootScope !== dependency.rootScope) {
        dependency.rootScope = nextRootScope;
        changed = true;
      }
      if (SCOPE_RANK[dependency.resolvedScope] >= SCOPE_RANK[dependency.minimumScope]) continue;
      if (dependency.assignmentSource === 'userOverride') {
        dependency.errorCode = 'dependencyScopeOverrideTooNarrow';
        continue;
      }
      if (!dependency.node.allowedScopes.includes(dependency.minimumScope)) {
        dependency.errorCode = 'dependencyTargetUnsupported';
        continue;
      }
      dependency.resolvedScope = dependency.minimumScope;
      dependency.assignmentSource = 'consumerPromotion';
      changed = true;
    }
  }

  const requiredByByKey = new Map<string, string[]>();
  for (const edge of edges) {
    const key = targetKey(edge.to, edge.platform);
    requiredByByKey.set(key, [...(requiredByByKey.get(key) ?? []), edge.from]);
  }
  const claimRoots = edges.flatMap((edge) => {
    const consumer = placements.get(targetKey(edge.from, edge.platform))!;
    const dependency = placements.get(targetKey(edge.to, edge.platform))!;
    return consumer.resolvedScope === 'project' && dependency.resolvedScope === 'user'
      ? [{ pluginId: edge.to, platform: edge.platform }]
      : [];
  });
  const targets = [...placements.values()].map((placement): DependencyOperationPlanInputTarget => ({
    pluginId: placement.node.pluginId,
    pluginName: placement.node.pluginName,
    platform: placement.node.platform,
    relation: placement.node.relation,
    depth: placement.node.depth,
    requiredBy: requiredByByKey.get(targetKey(
      placement.node.pluginId,
      placement.node.platform,
    )) ?? [],
    rootScope: placement.rootScope,
    minimumScope: placement.minimumScope,
    resolvedScope: placement.resolvedScope,
    allowedScopes: placement.node.allowedScopes,
    assignmentSource: placement.assignmentSource,
    locked: placement.locked,
    ...(placement.lockReason ? { lockReason: placement.lockReason } : {}),
    affectsOtherProjects: placement.resolvedScope === 'user',
    state: stateFor(placement.node, placement.resolvedScope),
    action: actionFor(placement, operation),
    ...(placement.errorCode ? { errorCode: placement.errorCode } : {}),
    order: placement.node.depth,
  }));

  return createDependencyOperationPlan({
    requestedPluginIds: input.requestedPluginIds,
    resolvedPluginIds: input.nodes.map((node) => node.pluginId),
    dependencyEdges: edges,
    scopeOverrides: overrides,
    targets,
    claimRoots,
  });
}
