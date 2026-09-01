import type {
  DependencyScopeOverride,
  DependencyScopeSelector,
  PlatformName,
  Scope,
} from '../types.js';

export type { DependencyScopeOverride } from '../types.js';

export type DependencyAssignmentSource =
  | 'root'
  | 'default'
  | 'existingWiderTarget'
  | 'userOverride'
  | 'consumerPromotion'
  | 'platformRequirement';

export interface DependencyPlacementTarget {
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
  placementErrorCode?: string;
}

export interface DependencyPlacementPlan {
  requestedPluginIds: string[];
  resolvedPluginIds: string[];
  dependencyEdges: Array<{ from: string; to: string; platform: PlatformName }>;
  scopeOverrides: DependencyScopeOverride[];
  targets: DependencyPlacementTarget[];
}

export interface DependencyPlacementNodeInput {
  pluginId: string;
  pluginName: string;
  platform: PlatformName;
  relation: 'requested' | 'dependency';
  depth: number;
  allowedScopes: Scope[];
  preferredScope?: Scope;
  preferredScopeReason?: 'existingWiderTarget';
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

interface MutablePlacement {
  node: DependencyPlacementNodeInput;
  rootScope: Scope;
  minimumScope: Scope;
  resolvedScope: Scope;
  assignmentSource: DependencyAssignmentSource;
  locked: boolean;
  lockReason?: string;
  placementErrorCode?: string;
}

export function createDependencyPlacementPlan(
  input: DependencyPlacementPlanInput,
): DependencyPlacementPlan {
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
    let placementErrorCode: string | undefined;

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
    } else if (node.preferredScope) {
      resolvedScope = node.preferredScope;
      assignmentSource = node.preferredScopeReason ?? 'default';
    } else if (allowedScopes.includes('project')) {
      resolvedScope = 'project';
      assignmentSource = 'default';
    } else {
      resolvedScope = 'user';
      assignmentSource = 'platformRequirement';
    }
    if (!allowedScopes.includes(resolvedScope)) {
      placementErrorCode = root
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
      ...(placementErrorCode ? { placementErrorCode } : {}),
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
        dependency.placementErrorCode = 'dependencyScopeOverrideTooNarrow';
        continue;
      }
      if (!dependency.node.allowedScopes.includes(dependency.minimumScope)) {
        dependency.placementErrorCode = 'dependencyTargetUnsupported';
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
  const targets = [...placements.values()].map((placement): DependencyPlacementTarget => ({
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
    ...(placement.placementErrorCode
      ? { placementErrorCode: placement.placementErrorCode }
      : {}),
  })).sort((left, right) => left.depth - right.depth || compareText(
    targetKey(left.pluginId, left.platform),
    targetKey(right.pluginId, right.platform),
  ));

  return {
    requestedPluginIds: [...new Set(input.requestedPluginIds)].sort(compareText),
    resolvedPluginIds: [...new Set(input.nodes.map((node) => node.pluginId))].sort(compareText),
    dependencyEdges: edges,
    scopeOverrides: overrides,
    targets,
  };
}
