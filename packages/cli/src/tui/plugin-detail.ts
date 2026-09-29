import type { PlatformName, Scope } from '../types.js';
import type { AgentId } from '../intent/deployment-preferences.js';
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
import { agentLabel, platformLabel, scopeLabel } from './glossary.js';
import { hasActualScopeEvidence, type PluginDependencyOverviewViewModel,
  type PluginListItemViewModel } from './model.js';
import type { InventoryState as ProjectInventoryState,
  InventoryRoot, ScopedInventoryViewModel, ScopedInventoryLoadResult } from './scoped-inventory.js';

export interface PluginDetailPlacement {
  platform?: PlatformName;
  agent?: AgentId;
  delivery?: 'native' | 'agent-skills';
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

function agentForPlatform(platform: PlatformName): AgentId {
  return platform === 'claude' ? 'claude-code' : 'codex';
}

function placementIdentity(placement: Pick<PluginDetailPlacement,
  'platform' | 'agent' | 'delivery' | 'scope'>): string {
  return [placement.agent ?? '', placement.delivery ?? '', placement.platform ?? '', placement.scope].join('\0');
}

export interface PluginDetailRelation {
  pluginId: string;
  displayName: string;
  declared: boolean;
  verified: boolean;
}

export interface PluginDetailDeclaration {
  state: 'declared' | 'not-declared' | 'unobserved';
  sourceState?: string;
  targets: 'selected' | 'empty' | 'unobserved';
  agents: AgentId[];
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
  declarations: Record<Scope, PluginDetailDeclaration>;
  placements: PluginDetailPlacement[];
  relations: {
    outgoing: PluginDetailRelation[];
    incoming: PluginDetailRelation[];
    checkState: 'checked' | 'unknown';
    hasKnownRelations: boolean;
  };
}

type RelationFact = { from: string; to: string; declared: boolean; verified: boolean };

function declarationFact(inventory: ScopedInventoryViewModel | undefined,
  pluginId: string): PluginDetailDeclaration {
  const root = inventory?.declaredRoots.find((entry) => entry.pluginId === pluginId);
  const state = root && inventory?.declarationState === 'ready' ? 'declared'
    : inventory?.declarationState === 'ready' || inventory?.declarationState === 'absent'
      ? 'not-declared' : 'unobserved';
  const agents = inventory?.selectedAgents.filter((agent): agent is AgentId =>
    agent === 'codex' || agent === 'claude-code' || agent === 'cursor') ?? [];
  return {
    state,
    ...(state === 'declared' && root?.sourceState ? { sourceState: root.sourceState } : {}),
    targets: !inventory || inventory.preferenceState === 'invalid'
      || inventory.preferenceState === 'unreadable' ? 'unobserved'
      : agents.length ? 'selected' : 'empty',
    agents,
  };
}

function relationFacts(overviews: readonly PluginDependencyOverviewViewModel[],
  observed: Array<{ scope: Scope; overviews: readonly PluginDependencyOverviewViewModel[] }>): {
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

    }
  }
  for (const observation of observed) {
    for (const overview of observation.overviews) {
      for (const item of [...overview.dependencies, ...overview.dependents]) {
        for (const reference of item.availablePlacementReferences ?? []) {
          if (reference.consumer.scope !== observation.scope) continue;
          add(reference.consumer.pluginId, reference.dependency.pluginId, true, true);
        }
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
  projectInventory?: { declaredRoots: InventoryRoot[]; extraInstalledRoots: InventoryRoot[] };
  scopedInventories?: Partial<Record<Scope, ScopedInventoryViewModel>>;
  dependencyOverviews?: readonly PluginDependencyOverviewViewModel[];
  scopedSnapshots?: Partial<Record<Scope, ScopedInventoryLoadResult['nativeSnapshot']>>;
  latestScope?: Scope;
}): PluginDetailSubject | undefined {
  const { pluginId } = options;
  const latest = options.latestScope ? options.scopedSnapshots?.[options.latestScope] : undefined;
  const overviews = latest?.dependencyOverviews ?? options.dependencyOverviews ?? [];
  const summary = (latest?.pluginSummaries ?? options.pluginSummaries).find((item) => item.pluginId === pluginId);
  const plugin = options.plugins.find((item) => item.pluginId === pluginId);
  const observed = (['user', 'project'] as const).map((scope) => ({ scope,
    snapshot: options.scopedSnapshots?.[scope],
  }));
  const targets = observed.flatMap(({ scope, snapshot }) =>
    flattenStatusTargets((snapshot?.payload ?? options.status).targets)
      .filter((target) => target.scope === scope && target.pluginId === pluginId));
  const roots = [...(options.projectInventory?.declaredRoots ?? []),
    ...(options.projectInventory?.extraInstalledRoots ?? []),
    ...Object.values(options.scopedInventories ?? {}).flatMap((inventory) => [
      ...inventory.declaredRoots, ...inventory.extraInstalledRoots,
    ])]
    .filter((root) => root.pluginId === pluginId);
  const dependencies = [...(options.projectInventory?.declaredRoots ?? []),
    ...(options.projectInventory?.extraInstalledRoots ?? []),
    ...Object.values(options.scopedInventories ?? {}).flatMap((inventory) => [
      ...inventory.declaredRoots, ...inventory.extraInstalledRoots,
    ])]
    .flatMap((root) => root.dependencies.filter((item) => item.pluginId === pluginId));
  const graph = relationFacts(overviews, observed.map(({ scope, snapshot }) => ({ scope,
    overviews: snapshot?.dependencyOverviews ?? options.dependencyOverviews ?? [],
  })));
  if (!summary && !plugin && targets.length === 0 && roots.length === 0
    && dependencies.length === 0 && !graph.ids.has(pluginId)) return undefined;

  const sourceId = plugin?.sourceId ?? targets[0]?.sourceId ?? roots[0]?.sourceId
    ?? pluginId.slice(0, pluginId.indexOf('/'));
  const displayName = summary?.displayName ?? summary?.pluginName ?? plugin?.displayName
    ?? roots[0]?.displayName ?? dependencies[0]?.displayName ?? graph.names.get(pluginId)
    ?? targets[0]?.pluginName ?? pluginId.split('/').at(-1) ?? pluginId;
  const revisions = new Map(observed.flatMap(({ scope, snapshot }) =>
    (snapshot?.targetRevisions ?? options.targetRevisions ?? [])
      .filter((item) => item.scope === scope && item.pluginId === pluginId))
    .map((item) => [`${item.platform}\0${item.scope}`, item.revision]));
  const placements = new Map<string, PluginDetailPlacement>();
  const ensure = (identity: { platform?: PlatformName; agent?: AgentId;
    delivery?: 'native' | 'agent-skills' }, scope: Scope): PluginDetailPlacement => {
    const resolvedAgent = identity.agent ?? (identity.platform ? agentForPlatform(identity.platform) : undefined);
    const resolvedDelivery = identity.delivery ?? (identity.platform ? 'native' : undefined);
    const key = placementIdentity({ ...identity, agent: resolvedAgent, delivery: resolvedDelivery, scope });
    const current = placements.get(key);
    if (current) return current;
    const placement: PluginDetailPlacement = {
      ...identity,
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
      ...(resolvedDelivery ? { delivery: resolvedDelivery } : {}),
      scope,
      platformLabel: identity.platform ? platformLabel(identity.platform)
        : resolvedAgent ? agentLabel(resolvedAgent) : '目标',
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
    const placement = ensure({ platform: target.platform, agent: agentForPlatform(target.platform),
      delivery: 'native' }, target.scope);
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
      if (target.delivery === 'agent-skills' && target.state === 'pending' && !target.actual) continue;
      const placement = ensure({ ...(target.platform ? { platform: target.platform } : {}),
        ...(target.agent ? { agent: target.agent } : {}),
        ...(target.delivery ? { delivery: target.delivery } : {}) }, target.scope);
      placement.projectState = target.state;
      if (target.delivery === 'agent-skills') {
        placement.observation = target.observation ?? 'unknown';
        placement.actual ||= target.actual === true;
      }
      if (target.state === 'unknown' || target.state === 'blocked') {
        placement.observation = 'unknown';
        placement.statusState = target.state === 'blocked' ? 'blocked' : undefined;
      }
      placement.declared ||= root.section === 'declared';
      placement.sharedWithCurrentProject ||= target.location === 'sharedUser';
      placement.reasonCodes = [...new Set([...placement.reasonCodes, ...target.reasonCodes])];
      const revision = target.platform ? revisions.get(`${target.platform}\0${target.scope}`) : undefined;
      if (revision?.installedVersion) placement.installedVersion = revision.installedVersion;
    }
  }
  for (const dependency of dependencies) {
    for (const target of dependency.targets) {
      if (target.delivery === 'agent-skills' && target.state === 'pending' && !target.actual) continue;
      const key = target.platform ? `${target.platform}\0${target.scope}` : undefined;
      // A later direct scope observation takes precedence over an older shared dependency check.
      if (target.location === 'sharedUser' && options.latestScope === target.scope
        && options.scopedSnapshots?.[target.scope]) continue;
      const placement = ensure({ ...(target.platform ? { platform: target.platform } : {}),
        ...(target.agent ? { agent: target.agent } : {}),
        ...(target.delivery ? { delivery: target.delivery } : {}) }, target.scope);
      placement.projectState = target.state;
      if (target.delivery === 'agent-skills') {
        placement.observation = target.observation ?? 'unknown';
        placement.actual ||= target.actual === true;
      }
      placement.sharedWithCurrentProject ||= target.location === 'sharedUser';
      placement.reasonCodes = [...new Set([...placement.reasonCodes, ...target.reasonCodes])];
      if (!target.platform || !targets.some((entry) => entry.platform === target.platform && entry.scope === target.scope)) {
        placement.observation = target.delivery === 'agent-skills' ? target.observation ?? 'unknown'
          : target.state === 'ready' ? 'known' : 'unknown';
        if (target.installedVersion) placement.installedVersion = target.installedVersion;
      } else {
        const revision = key ? revisions.get(key) : undefined;
        if (revision?.installedVersion) placement.installedVersion = revision.installedVersion;
      }
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
  const overview = overviews.find((item) => item.pluginId === pluginId);
  const source = (latest?.payload ?? options.status).catalog.sources.find((item) => item.id === sourceId);
  const definitionAvailable = summary !== undefined && source !== undefined && !source.error;
  return {
    pluginId,
    sourceId,
    displayName,
    ...(summary?.description ? { description: summary.description } : {}),
    ...(summary?.version ? { catalogVersion: summary.version } : {}),
    definitionAvailable,
    savedConfigScopes: plugin?.savedConfigScopes ?? [],
    ...(plugin ? { plugin } : {}),
    declarations: {
      user: declarationFact(options.scopedInventories?.user, pluginId),
      project: declarationFact(options.scopedInventories?.project, pluginId),
    },
    placements: [...placements.values()].sort((left, right) =>
      placementIdentity(left).localeCompare(placementIdentity(right), 'en')),
    relations: {
      outgoing,
      incoming,
      checkState: overview && definitionAvailable
        && !overview.blockers.some((blocker) => blocker.code === 'dependencyGraphInvalid')
        ? 'checked' : 'unknown',
      hasKnownRelations: outgoing.length > 0 || incoming.length > 0,
    },
  };
}
