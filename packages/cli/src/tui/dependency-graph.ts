import type {
  DependencyPlacementReferenceViewModel,
  PluginDependencyBlockerViewModel,
  PluginDependencyItemViewModel,
  PluginDependencyOverviewViewModel,
} from './model.js';

export type DependencyGraphDirection = 'dependencies' | 'dependents';

export type DependencyGraphNodeState =
  | 'ready'
  | 'missing'
  | 'needsAttention'
  | 'unavailable'
  | 'unknown';

export interface DependencyGraphBreadcrumb {
  pluginId: string;
  label: string;
  sourceLabel?: string;
}

export interface DependencyGraphScopeSummary {
  references: Array<{
    platform: DependencyPlacementReferenceViewModel['consumer']['platform'];
    scope: DependencyPlacementReferenceViewModel['consumer']['scope'];
    project: DependencyPlacementReferenceViewModel['consumer']['project'];
    count: number;
  }>;
  availableConsumerPluginIds: string[];
  unknownConsumerPluginIds: string[];
  unverifiedDependencyPluginIds: string[];
}

export interface DependencyGraphRow {
  id: string;
  pluginId: string;
  parentRowId?: string;
  depth: number;
  label: string;
  displayName: string;
  sourceLabel?: string;
  nodeState: DependencyGraphNodeState;
  hasChildren: boolean;
  expanded: boolean;
  canExpand: boolean;
  canOpenSubtree: boolean;
  hiddenDescendantCount: number;
  ancestorHasNextSibling: boolean[];
  lastChild: boolean;
  focused: boolean;
  sharedWithRowId?: string;
  pathPluginIds: string[];
  relationship: 'root' | 'directAvailable' | 'indirectAvailable' | 'declared' | 'unknown';
  pathReferences: DependencyPlacementReferenceViewModel[][];
  edge?: {
    declared: boolean;
    availablePlacementReferences: DependencyPlacementReferenceViewModel[];
  };
}

export interface DependencyGraphStatus {
  state: 'ready' | 'invalid' | 'unknown';
  blockers: PluginDependencyBlockerViewModel[];
  invalidBlockers: PluginDependencyBlockerViewModel[];
  message?: string;
}

export interface DependencyGraphProjection {
  direction: DependencyGraphDirection;
  root: DependencyGraphBreadcrumb;
  breadcrumbs: DependencyGraphBreadcrumb[];
  rows: DependencyGraphRow[];
  defaultExpandedPluginIds: string[];
  focusRowId?: string;
  scopeSummary: DependencyGraphScopeSummary;
  status: DependencyGraphStatus;
}

export interface DependencyGraphProjectionOptions {
  overviews: readonly PluginDependencyOverviewViewModel[];
  rootPluginId: string;
  direction?: DependencyGraphDirection;
  expandedPluginIds?: ReadonlySet<string> | readonly string[];
  focusPluginId?: string;
  breadcrumbPluginIds?: readonly string[];
}

interface NodeRecord {
  pluginId: string;
  displayName: string;
  item?: PluginDependencyItemViewModel;
}

interface EdgeRecord {
  fromPluginId: string;
  toPluginId: string;
  declared: boolean;
  availablePlacementReferences: DependencyPlacementReferenceViewModel[];
}

interface GraphFacts {
  nodes: Map<string, NodeRecord>;
  forward: Map<string, EdgeRecord[]>;
  reverse: Map<string, EdgeRecord[]>;
  references: DependencyPlacementReferenceViewModel[];
}

const INVALID_BLOCKER_CODES = new Set([
  'dependencyGraphInvalid',
]);

function pluginParts(pluginId: string): { sourceId?: string; pluginName: string } {
  const separator = pluginId.indexOf('/');
  if (separator <= 0 || separator === pluginId.length - 1) return { pluginName: pluginId };
  return {
    sourceId: pluginId.slice(0, separator),
    pluginName: pluginId.slice(separator + 1),
  };
}

function edgeKey(fromPluginId: string, toPluginId: string): string {
  return `${fromPluginId}\0${toPluginId}`;
}

function referenceKey(reference: DependencyPlacementReferenceViewModel): string {
  const { consumer, dependency } = reference;
  return [
    consumer.pluginId,
    consumer.platform,
    consumer.scope,
    consumer.project ?? '',
    dependency.pluginId,
    dependency.platform,
    dependency.scope,
    dependency.project ?? '',
  ].join('\0');
}

function placementKey(
  placement: DependencyPlacementReferenceViewModel['consumer'],
): string {
  return [
    placement.pluginId,
    placement.platform,
    placement.scope,
    placement.project ?? '',
  ].join('\0');
}

function extendPlacementPaths(
  paths: readonly DependencyPlacementReferenceViewModel[][],
  edge: EdgeRecord,
  direction: DependencyGraphDirection,
  direct: boolean,
): DependencyPlacementReferenceViewModel[][] {
  const references = edge.availablePlacementReferences;
  if (direct) return references.map((reference) => [reference]);
  return paths.flatMap((path) => {
    const previous = path.at(-1);
    if (!previous) return [];
    const expected = direction === 'dependencies' ? previous.dependency : previous.consumer;
    return references
      .filter((reference) => placementKey(direction === 'dependencies'
        ? reference.consumer : reference.dependency) === placementKey(expected))
      .map((reference) => [...path, reference]);
  });
}

function comparePluginIds(
  left: string,
  right: string,
  nodes: ReadonlyMap<string, NodeRecord>,
): number {
  const nameOrder = (nodes.get(left)?.displayName ?? left).localeCompare(
    nodes.get(right)?.displayName ?? right,
    'en',
  );
  return nameOrder || left.localeCompare(right, 'en');
}

function nodeState(node: NodeRecord | undefined): DependencyGraphNodeState {
  if (!node?.item) return 'unknown';
  switch (node.item.aggregateStatus) {
    case 'ready': return 'ready';
    case 'notInstalled': return 'missing';
    case 'needsAttention': return 'needsAttention';
    case 'unavailable': return 'unavailable';
  }
}

function addNode(
  nodes: Map<string, NodeRecord>,
  pluginId: string,
  displayName?: string,
  item?: PluginDependencyItemViewModel,
): void {
  if (!pluginId) return;
  const current = nodes.get(pluginId);
  const fallbackName = pluginParts(pluginId).pluginName;
  if (!current) {
    nodes.set(pluginId, {
      pluginId,
      displayName: displayName || fallbackName,
      ...(item ? { item } : {}),
    });
    return;
  }
  if (item && !current.item) current.item = item;
  if (displayName && current.displayName === fallbackName) current.displayName = displayName;
}

function graphFacts(overviews: readonly PluginDependencyOverviewViewModel[]): GraphFacts {
  const nodes = new Map<string, NodeRecord>();
  const edges = new Map<string, EdgeRecord>();
  const references = new Map<string, DependencyPlacementReferenceViewModel>();
  const addEdge = (
    fromPluginId: string,
    toPluginId: string,
    declared: boolean,
    reference?: DependencyPlacementReferenceViewModel,
  ): void => {
    if (!fromPluginId || !toPluginId) return;
    addNode(nodes, fromPluginId);
    addNode(nodes, toPluginId);
    const key = edgeKey(fromPluginId, toPluginId);
    const edge = edges.get(key) ?? {
      fromPluginId,
      toPluginId,
      declared: false,
      availablePlacementReferences: [],
    };
    edge.declared ||= declared;
    if (reference && !edge.availablePlacementReferences.some((entry) => referenceKey(entry) === referenceKey(reference))) {
      edge.availablePlacementReferences.push(reference);
      references.set(referenceKey(reference), reference);
    }
    edges.set(key, edge);
  };
  const addItem = (item: PluginDependencyItemViewModel): void => {
    addNode(nodes, item.pluginId, item.displayName, item);
    for (const parent of item.requiredBy) {
      addNode(nodes, parent.pluginId, parent.displayName);
      addEdge(parent.pluginId, item.pluginId, true);
    }
    for (const reference of item.availablePlacementReferences ?? []) {
      addNode(nodes, reference.consumer.pluginId);
      addNode(nodes, reference.dependency.pluginId);
      addEdge(reference.consumer.pluginId, reference.dependency.pluginId, false, reference);
    }
  };
  for (const overview of overviews) {
    addNode(nodes, overview.pluginId);
    for (const item of overview.dependencies) addItem(item);
    for (const item of overview.dependents) addItem(item);
  }
  const forward = new Map<string, EdgeRecord[]>();
  const reverse = new Map<string, EdgeRecord[]>();
  for (const edge of edges.values()) {
    forward.set(edge.fromPluginId, [...(forward.get(edge.fromPluginId) ?? []), edge]);
    if (edge.availablePlacementReferences.length > 0) {
      reverse.set(edge.toPluginId, [...(reverse.get(edge.toPluginId) ?? []), edge]);
    }
  }
  for (const adjacency of forward.values()) {
    adjacency.sort((left, right) => comparePluginIds(left.toPluginId, right.toPluginId, nodes));
  }
  for (const adjacency of reverse.values()) {
    adjacency.sort((left, right) => comparePluginIds(left.fromPluginId, right.fromPluginId, nodes));
  }
  return { nodes, forward, reverse, references: [...references.values()] };
}

function findCycle(rootPluginId: string, forward: ReadonlyMap<string, EdgeRecord[]>): boolean {
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (pluginId: string): boolean => {
    if (active.has(pluginId)) return true;
    if (visited.has(pluginId)) return false;
    visited.add(pluginId);
    active.add(pluginId);
    for (const edge of forward.get(pluginId) ?? []) {
      if (visit(edge.toPluginId)) return true;
    }
    active.delete(pluginId);
    return false;
  };
  return visit(rootPluginId);
}

function labels(nodes: ReadonlyMap<string, NodeRecord>): Map<string, DependencyGraphBreadcrumb> {
  const nameCounts = new Map<string, number>();
  for (const node of nodes.values()) {
    nameCounts.set(node.displayName, (nameCounts.get(node.displayName) ?? 0) + 1);
  }
  return new Map([...nodes.values()].map((node): [string, DependencyGraphBreadcrumb] => {
    const sourceLabel = pluginParts(node.pluginId).sourceId;
    const showSource = sourceLabel && (nameCounts.get(node.displayName) ?? 0) > 1;
    return [node.pluginId, {
      pluginId: node.pluginId,
      label: showSource ? `${node.displayName} · ${sourceLabel}` : node.displayName,
      ...(showSource ? { sourceLabel } : {}),
    }];
  }));
}

function descendants(
  pluginId: string,
  direction: DependencyGraphDirection,
  facts: GraphFacts,
): Array<{ pluginId: string; edge: EdgeRecord }> {
  const edges = direction === 'dependencies'
    ? facts.forward.get(pluginId) ?? []
    : facts.reverse.get(pluginId) ?? [];
  const priority = (pluginId: string): number => {
    const state = nodeState(facts.nodes.get(pluginId));
    return state === 'unavailable' ? 0
      : state === 'needsAttention' ? 1
        : state === 'missing' ? 2
          : state === 'unknown' ? 3 : 4;
  };
  return edges.map((edge) => ({
    pluginId: direction === 'dependencies' ? edge.toPluginId : edge.fromPluginId,
    edge,
  })).sort((left, right) => priority(left.pluginId) - priority(right.pluginId)
    || comparePluginIds(left.pluginId, right.pluginId, facts.nodes));
}

function countDescendants(
  pluginId: string,
  direction: DependencyGraphDirection,
  facts: GraphFacts,
): number {
  const seen = new Set([pluginId]);
  const pending = [pluginId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of descendants(current, direction, facts)) {
      if (seen.has(child.pluginId)) continue;
      seen.add(child.pluginId);
      pending.push(child.pluginId);
    }
  }
  return seen.size - 1;
}

function pathExpansion(
  rootPluginId: string,
  direction: DependencyGraphDirection,
  facts: GraphFacts,
  targetPluginId: string,
): string[] {
  const pending: Array<{ pluginId: string; path: string[] }> = [{
    pluginId: rootPluginId,
    path: [rootPluginId],
  }];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (seen.has(current.pluginId)) continue;
    seen.add(current.pluginId);
    if (current.pluginId === targetPluginId) return current.path.slice(0, -1);
    for (const child of descendants(current.pluginId, direction, facts)) {
      pending.push({ pluginId: child.pluginId, path: [...current.path, child.pluginId] });
    }
  }
  return [];
}

function defaultExpansion(
  rootPluginId: string,
  direction: DependencyGraphDirection,
  facts: GraphFacts,
): Set<string> {
  const expanded = new Set<string>([rootPluginId]);
  for (const child of descendants(rootPluginId, direction, facts)) expanded.add(child.pluginId);
  const pending = [rootPluginId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const pluginId = pending.pop()!;
    if (seen.has(pluginId)) continue;
    seen.add(pluginId);
    for (const child of descendants(pluginId, direction, facts)) {
      if (nodeState(facts.nodes.get(child.pluginId)) !== 'ready') {
        for (const parent of pathExpansion(rootPluginId, direction, facts, child.pluginId)) {
          expanded.add(parent);
        }
      }
      pending.push(child.pluginId);
    }
  }
  return expanded;
}

function invalidBlockers(
  overview: PluginDependencyOverviewViewModel | undefined,
  cyclic: boolean,
): PluginDependencyBlockerViewModel[] {
  const blockers = (overview?.blockers ?? []).filter((blocker) => INVALID_BLOCKER_CODES.has(blocker.code));
  if (!cyclic || blockers.some((blocker) => blocker.code === 'dependencyGraphInvalid')) return blockers;
  return [...blockers, {
    code: 'dependencyGraphInvalid',
    title: '依赖关系无效',
    explanation: '依赖关系形成环，不能显示为正常树。',
  }];
}

function scopeSummary(
  rootPluginId: string,
  overview: PluginDependencyOverviewViewModel | undefined,
  facts: GraphFacts,
): DependencyGraphScopeSummary {
  const scoped = new Map<string, DependencyGraphScopeSummary['references'][number]>();
  for (const reference of facts.references) {
    if (reference.consumer.pluginId !== rootPluginId && reference.dependency.pluginId !== rootPluginId) continue;
    const descriptor = reference.consumer.pluginId === rootPluginId
      ? reference.consumer : reference.dependency;
    const key = [descriptor.platform, descriptor.scope, descriptor.project ?? ''].join('\0');
    const current = scoped.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    scoped.set(key, {
      platform: descriptor.platform,
      scope: descriptor.scope,
      project: descriptor.project,
      count: 1,
    });
  }
  const availableConsumerPluginIds = [...new Set((facts.reverse.get(rootPluginId) ?? [])
    .flatMap((edge) => edge.availablePlacementReferences
      .map((reference) => reference.consumer.pluginId)))].sort();
  const declaredConsumers = overview?.dependents.map((item) => item.pluginId) ?? [];
  const unknownConsumerPluginIds = [...new Set(declaredConsumers
    .filter((pluginId) => !availableConsumerPluginIds.includes(pluginId)))].sort();
  const unverifiedDependencyPluginIds = [...new Set((facts.forward.get(rootPluginId) ?? [])
    .filter((edge) => edge.declared && edge.availablePlacementReferences.length === 0)
    .map((edge) => edge.toPluginId))].sort();
  return {
    references: [...scoped.values()].sort((left, right) =>
      `${left.platform}\0${left.scope}\0${left.project ?? ''}`.localeCompare(
        `${right.platform}\0${right.scope}\0${right.project ?? ''}`,
        'en',
      )),
    availableConsumerPluginIds,
    unknownConsumerPluginIds,
    unverifiedDependencyPluginIds,
  };
}

export function buildDependencyGraphProjection(
  options: DependencyGraphProjectionOptions,
): DependencyGraphProjection {
  const direction = options.direction ?? 'dependencies';
  const overview = options.overviews.find((entry) => entry.pluginId === options.rootPluginId);
  const facts = graphFacts(options.overviews);
  addNode(facts.nodes, options.rootPluginId);
  const nodeLabels = labels(facts.nodes);
  const root = nodeLabels.get(options.rootPluginId) ?? {
    pluginId: options.rootPluginId,
    label: pluginParts(options.rootPluginId).pluginName,
  };
  const cyclic = findCycle(options.rootPluginId, facts.forward);
  const invalid = invalidBlockers(overview, cyclic);
  const blockers = [
    ...(overview?.blockers ?? []),
    ...invalid.filter((blocker) => !(overview?.blockers ?? []).some((entry) =>
      entry.code === blocker.code && entry.title === blocker.title && entry.explanation === blocker.explanation)),
  ];
  const hasInvalidGraph = invalid.length > 0;
  const status: DependencyGraphStatus = hasInvalidGraph
    ? {
        state: 'invalid',
        blockers,
        invalidBlockers: invalid,
        message: '依赖声明无效，不能显示为正常关系树。',
      }
    : !overview
      ? {
          state: 'unknown',
          blockers: [],
          invalidBlockers: [],
          message: direction === 'dependencies'
            ? '没有可用的依赖清单。'
            : '没有完整依赖清单；只显示已观察到的使用者。',
        }
      : { state: 'ready', blockers, invalidBlockers: [] };
  const defaults = defaultExpansion(options.rootPluginId, direction, facts);
  const expanded = options.expandedPluginIds === undefined
    ? defaults
    : new Set([options.rootPluginId, ...options.expandedPluginIds]);
  if (options.focusPluginId) {
    for (const pluginId of pathExpansion(options.rootPluginId, direction, facts, options.focusPluginId)) {
      expanded.add(pluginId);
    }
  }
  const rows: DependencyGraphRow[] = [];
  const visibleRows = new Map<string, string>();
  const mayRenderTree = !hasInvalidGraph || direction === 'dependents';
  const append = (input: {
    pluginId: string;
    parentRowId?: string;
    depth: number;
    edge?: EdgeRecord;
    pathPluginIds: string[];
    pathReferences: DependencyPlacementReferenceViewModel[][];
    ancestorHasNextSibling: boolean[];
    lastChild: boolean;
  }): void => {
    const sharedWithRowId = visibleRows.get(input.pluginId);
    const children = descendants(input.pluginId, direction, facts).flatMap((child) => {
      const paths = extendPlacementPaths(
        input.pathReferences,
        child.edge,
        direction,
        input.depth === 0,
      );
      return direction === 'dependents' && paths.length === 0 ? [] : [{ ...child, paths }];
    });
    const rowId = input.parentRowId
      ? `${input.parentRowId}>${input.pluginId}`
      : input.pluginId;
    const label = nodeLabels.get(input.pluginId) ?? {
      pluginId: input.pluginId,
      label: pluginParts(input.pluginId).pluginName,
    };
    const hasChildren = children.length > 0;
    const row: DependencyGraphRow = {
      id: rowId,
      pluginId: input.pluginId,
      ...(input.parentRowId ? { parentRowId: input.parentRowId } : {}),
      depth: input.depth,
      label: label.label,
      displayName: facts.nodes.get(input.pluginId)?.displayName ?? label.label,
      ...(label.sourceLabel ? { sourceLabel: label.sourceLabel } : {}),
      nodeState: nodeState(facts.nodes.get(input.pluginId)),
      hasChildren,
      expanded: hasChildren && expanded.has(input.pluginId) && !sharedWithRowId,
      canExpand: hasChildren && !sharedWithRowId,
      canOpenSubtree: hasChildren,
      hiddenDescendantCount: hasChildren && (!expanded.has(input.pluginId) || Boolean(sharedWithRowId))
        ? countDescendants(input.pluginId, direction, facts) : 0,
      ancestorHasNextSibling: input.ancestorHasNextSibling,
      lastChild: input.lastChild,
      focused: false,
      pathPluginIds: input.pathPluginIds,
      relationship: input.depth === 0 ? 'root'
        : input.pathReferences.length > 0
          ? input.depth === 1 ? 'directAvailable' : 'indirectAvailable'
          : (input.edge?.availablePlacementReferences.length ?? 0) > 0 ? 'unknown' : 'declared',
      pathReferences: input.pathReferences,
      ...(sharedWithRowId ? { sharedWithRowId } : {}),
      ...(input.edge ? {
        edge: {
          declared: input.edge.declared,
          availablePlacementReferences: [...input.edge.availablePlacementReferences],
        },
      } : {}),
    };
    rows.push(row);
    if (sharedWithRowId) return;
    visibleRows.set(input.pluginId, row.id);
    if (!row.expanded) return;
    for (const [index, child] of children.entries()) {
      append({
        pluginId: child.pluginId,
        parentRowId: row.id,
        depth: row.depth + 1,
        edge: child.edge,
        pathPluginIds: [...input.pathPluginIds, child.pluginId],
        pathReferences: child.paths,
        ancestorHasNextSibling: [...input.ancestorHasNextSibling, !input.lastChild],
        lastChild: index === children.length - 1,
      });
    }
  };
  if (mayRenderTree) {
    append({
      pluginId: options.rootPluginId,
      depth: 0,
      pathPluginIds: [options.rootPluginId],
      pathReferences: [],
      ancestorHasNextSibling: [],
      lastChild: true,
    });
  }
  const requestedFocus = options.focusPluginId ?? options.rootPluginId;
  const focusRow = rows.find((row) => row.pluginId === requestedFocus) ?? rows[0];
  if (focusRow) focusRow.focused = true;
  const breadcrumbs = [...(options.breadcrumbPluginIds ?? []), options.rootPluginId]
    .filter((pluginId, index, ids) => pluginId && ids.indexOf(pluginId) === index)
    .map((pluginId) => nodeLabels.get(pluginId) ?? {
      pluginId,
      label: pluginParts(pluginId).pluginName,
    });
  return {
    direction,
    root,
    breadcrumbs,
    rows,
    defaultExpandedPluginIds: [...defaults].sort((left, right) => comparePluginIds(left, right, facts.nodes)),
    ...(focusRow ? { focusRowId: focusRow.id } : {}),
    scopeSummary: scopeSummary(options.rootPluginId, overview, facts),
    status,
  };
}
