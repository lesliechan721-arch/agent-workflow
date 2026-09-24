import type { PlatformName, Scope } from '../types.js';
import {
  flattenStatusTargets,
  statusTargetActivation,
  statusTargetIntent,
  statusTargetOwnershipState,
  statusTargetSharedNative,
  type StatusTargetRevision,
  type StatusV8Payload,
  type StatusV8PluginSummary,
  type StatusV8State,
} from '../commands/status-v6.js';
import { platformLabel, scopeLabel } from './glossary.js';
import { hasActualScopeEvidence, type PluginDependencyOverviewViewModel,
  type PluginListItemViewModel } from './model.js';
import type { ProjectInventoryState, ProjectInventoryViewModel } from './project-inventory.js';

export interface PluginDetailPlacement {
  platform: PlatformName;
  scope: Scope;
  platformLabel: string;
  scopeLabel: string;
  statusState?: StatusV8State;
  projectState?: ProjectInventoryState;
  observation: 'known' | 'unknown';
  declared: boolean;
  actual: boolean;
  sharedWithCurrentProject: boolean;
  expectedVersion?: string;
  installedVersion?: string;
  reasonCodes: string[];
}

export interface PluginDetailRelation {
  pluginId: string;
  displayName: string;
  declared: boolean;
  verified: boolean;
}

export interface PluginDetailSubject {
  pluginId: string;
  sourceId: string;
  displayName: string;
  description?: string;
  catalogVersion?: string;
  definitionAvailable: boolean;
  savedConfigScopes: Scope[];
  /** Existing overview is retained only for actions that already accept it. */
  plugin?: PluginListItemViewModel;
  placements: PluginDetailPlacement[];
  relations: {
    outgoing: PluginDetailRelation[];
    incoming: PluginDetailRelation[];
    checkState: 'checked' | 'unknown';
    hasKnownRelations: boolean;
  };
}

type RelationFact = { from: string; to: string; declared: boolean; verified: boolean };

function relationFacts(overviews: readonly PluginDependencyOverviewViewModel[]): {
  facts: Map<string, RelationFact>;
  names: Map<string, string>;
  ids: Set<string>;
} {
  const facts = new Map<string, RelationFact>();
  const names = new Map<string, string>();
  const ids = new Set<string>();
  const add = (from: string, to: string, declared: boolean, verified: boolean): void => {
    if (!from || !to) return;
    ids.add(from);
    ids.add(to);
    const key = `${from}\0${to}`;
    const old = facts.get(key);
    facts.set(key, {
      from,
      to,
      declared: declared || old?.declared === true,
      verified: verified || old?.verified === true,
    });
  };
  for (const overview of overviews) {
    for (const item of [...overview.dependencies, ...overview.dependents]) {
      ids.add(item.pluginId);
      names.set(item.pluginId, item.displayName);
      for (const parent of item.requiredBy) {
        names.set(parent.pluginId, parent.displayName);
        add(parent.pluginId, item.pluginId, true, false);
      }
      if (item.relation === 'direct' && item.requiredBy.length === 0) {
        add(overview.pluginId, item.pluginId, true, false);
      }
      if (item.relation === 'dependent') add(item.pluginId, overview.pluginId, true, false);
      for (const reference of item.placementReferences ?? []) {
        add(reference.consumer.pluginId, reference.dependency.pluginId, true, false);
      }
      for (const reference of item.availablePlacementReferences ?? []) {
        add(reference.consumer.pluginId, reference.dependency.pluginId, true, true);
      }
    }
  }
  return { facts, names, ids };
}

export function buildPluginDetailSubject(options: {
  pluginId: string;
  status: StatusV8Payload;
  pluginSummaries: readonly StatusV8PluginSummary[];
  targetRevisions?: readonly StatusTargetRevision[];
  plugins: readonly PluginListItemViewModel[];
  projectInventory?: ProjectInventoryViewModel;
  dependencyOverviews?: readonly PluginDependencyOverviewViewModel[];
}): PluginDetailSubject | undefined {
  const { pluginId } = options;
  const summary = options.pluginSummaries.find((item) => item.pluginId === pluginId);
  const plugin = options.plugins.find((item) => item.pluginId === pluginId);
  const targets = flattenStatusTargets(options.status.targets)
    .filter((target) => target.pluginId === pluginId);
  const roots = [...(options.projectInventory?.declaredRoots ?? []),
    ...(options.projectInventory?.extraInstalledRoots ?? [])]
    .filter((root) => root.pluginId === pluginId);
  const dependencies = [...(options.projectInventory?.declaredRoots ?? []),
    ...(options.projectInventory?.extraInstalledRoots ?? [])]
    .flatMap((root) => root.dependencies.filter((item) => item.pluginId === pluginId));
  const graph = relationFacts(options.dependencyOverviews ?? []);
  if (!summary && !plugin && targets.length === 0 && roots.length === 0
    && dependencies.length === 0 && !graph.ids.has(pluginId)) return undefined;

  const sourceId = plugin?.sourceId ?? targets[0]?.sourceId ?? roots[0]?.sourceId
    ?? pluginId.slice(0, pluginId.indexOf('/'));
  const displayName = summary?.displayName ?? summary?.pluginName ?? plugin?.displayName
    ?? roots[0]?.displayName ?? dependencies[0]?.displayName ?? graph.names.get(pluginId)
    ?? targets[0]?.pluginName ?? pluginId.split('/').at(-1) ?? pluginId;
  const revisions = new Map((options.targetRevisions ?? [])
    .filter((item) => item.pluginId === pluginId)
    .map((item) => [`${item.platform}\0${item.scope}`, item.revision]));
  const placements = new Map<string, PluginDetailPlacement>();
  const ensure = (platform: PlatformName, scope: Scope): PluginDetailPlacement => {
    const key = `${platform}\0${scope}`;
    const current = placements.get(key);
    if (current) return current;
    const placement: PluginDetailPlacement = {
      platform,
      scope,
      platformLabel: platformLabel(platform),
      scopeLabel: scopeLabel(scope),
      observation: 'unknown',
      declared: false,
      actual: false,
      sharedWithCurrentProject: false,
      reasonCodes: [],
    };
    placements.set(key, placement);
    return placement;
  };
  for (const target of targets) {
    const intent = statusTargetIntent(target);
    const actual = hasActualScopeEvidence(target);
    if (target.state === 'absent' && !actual && !intent.scopes.includes(target.scope)) continue;
    const placement = ensure(target.platform, target.scope);
    const unobserved = statusTargetSharedNative(target)?.state === 'unobserved'
      || statusTargetActivation(target)?.evidence === 'unobserved'
      || statusTargetOwnershipState(target) === 'error';
    placement.statusState = target.state;
    placement.observation = unobserved ? 'unknown' : 'known';
    placement.declared = intent.scopes.includes(target.scope);
    placement.actual = actual;
    placement.reasonCodes = [...new Set([...target.reasons, ...(target.sharedReasons ?? [])]
      .map((reason) => reason.code))];
    const revision = revisions.get(`${target.platform}\0${target.scope}`);
    if (revision?.installedVersion) placement.installedVersion = revision.installedVersion;
  }
  for (const root of roots) {
    for (const target of root.targets) {
      const placement = ensure(target.platform, target.scope);
      placement.projectState = target.state;
      placement.declared ||= root.section === 'declared';
      placement.sharedWithCurrentProject ||= target.location === 'sharedUser';
      placement.reasonCodes = [...new Set([...placement.reasonCodes, ...target.reasonCodes])];
      const revision = revisions.get(`${target.platform}\0${target.scope}`);
      if (revision?.installedVersion) placement.installedVersion = revision.installedVersion;
    }
  }
  for (const dependency of dependencies) {
    for (const target of dependency.targets) {
      const placement = ensure(target.platform, target.scope);
      placement.projectState = target.state;
      placement.sharedWithCurrentProject ||= target.location === 'sharedUser';
      placement.reasonCodes = [...new Set([...placement.reasonCodes, ...target.reasonCodes])];
      const revision = revisions.get(`${target.platform}\0${target.scope}`);
      if (revision?.installedVersion) placement.installedVersion = revision.installedVersion;
    }
  }
  const toRelation = (fact: RelationFact, otherId: string): PluginDetailRelation => ({
    pluginId: otherId,
    displayName: graph.names.get(otherId) ?? otherId.split('/').at(-1) ?? otherId,
    declared: fact.declared,
    verified: fact.verified,
  });
  const known = [...graph.facts.values()];
  const outgoing = known.filter((fact) => fact.from === pluginId)
    .map((fact) => toRelation(fact, fact.to));
  const incoming = known.filter((fact) => fact.to === pluginId)
    .map((fact) => toRelation(fact, fact.from));
  const overview = options.dependencyOverviews?.find((item) => item.pluginId === pluginId);
  const source = options.status.catalog.sources.find((item) => item.id === sourceId);
  return {
    pluginId,
    sourceId,
    displayName,
    ...(summary?.description ? { description: summary.description } : {}),
    ...(summary?.version ? { catalogVersion: summary.version } : {}),
    definitionAvailable: summary !== undefined && source?.error === undefined,
    savedConfigScopes: plugin?.savedConfigScopes ?? [],
    ...(plugin ? { plugin } : {}),
    placements: [...placements.values()].sort((left, right) =>
      `${left.platform}\0${left.scope}`.localeCompare(`${right.platform}\0${right.scope}`, 'en')),
    relations: {
      outgoing,
      incoming,
      checkState: overview && source && !source.error
        && !overview.blockers.some((blocker) => blocker.code === 'dependencyGraphInvalid')
        ? 'checked' : 'unknown',
      hasKnownRelations: outgoing.length > 0 || incoming.length > 0,
    },
  };
}
