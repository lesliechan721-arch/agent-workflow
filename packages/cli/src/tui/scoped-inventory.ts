import path from 'node:path';

import type { PlatformName, Scope } from '../types.js';
import type { AgentId } from '../intent/deployment-preferences.js';
import { flattenStatusTargets, statusTargetActivation, statusTargetIntent,
  statusTargetOwnershipState, statusTargetSharedNative, type StatusScopedTarget,
  type StatusTargetRevision, type StatusV8Payload, type StatusV8PluginSummary } from '../commands/status-v6.js';
import type { RecoveryTarget } from '../recovery/receipt.js';
import { hasActualScopeEvidence, type PluginDependencyOverviewViewModel } from './model.js';

export type InventoryState = 'blocked' | 'unknown' | 'pending' | 'ready';

export interface InventoryTarget {
  platform?: PlatformName;
  scope: Scope;
  location: 'scope' | 'sharedUser';
  state: InventoryState;
  expectedVersion?: string;
  installedVersion?: string;
  reasonCodes: string[];
  agent?: AgentId;
  delivery?: 'native' | 'agent-skills';
  observation?: 'known' | 'unknown';
  actual?: boolean;
}

export interface InventoryDependency {
  pluginId: string;
  displayName: string;
  targets: InventoryTarget[];
}

export interface InventoryRoot {
  scope?: Scope;
  pluginId: string;
  sourceId: string;
  displayName: string;
  section: 'declared' | 'extraInstalled';
  state: InventoryState;
  targets: InventoryTarget[];
  dependencies: InventoryDependency[];
  agentResults?: Array<Pick<RecoveryTarget, 'agent' | 'delivery' | 'blockers' | 'observation' | 'content'>>;
  blockers?: Array<{ code: string; message: string }>;
  sourceState?: string;
}

export interface ScopedInventoryViewModel {
  scope: Scope;
  projectRoot?: string;
  projectName?: string;
  declarationState: 'ready' | 'absent' | 'invalid' | 'unavailable' | 'notProject';
  preferenceState: string;
  selectedAgents: AgentId[];
  declaredRoots: InventoryRoot[];
  extraInstalledRoots: InventoryRoot[];
  syncTargets: Array<{ pluginId: string; agent: AgentId; scope: Scope }>;
  counts: Record<InventoryState, number>;
  errors: Array<{ code: string; message: string }>;
  allSatisfied: boolean | null;
  coverage?: { native: boolean; portable: boolean };
}

export interface RecoveryInventoryInput {
  scope: Scope;
  intent: { state: string };
  selection: { agents: AgentId[]; preferences: string };
  inventory: Array<{
    pluginId: string;
    source: string;
    sourceState: string;
    blockers: Array<{ code: string; message: string }>;
    targetResults: RecoveryTarget[];
  }> | null;
  errors: Array<{ code: string; message: string }>;
  allSatisfied: boolean | null;
  coverage?: { native: boolean; portable: boolean };
  extraObserved?: Array<{
    pluginId: string; agent: AgentId | null; scope: Scope;
    delivery: RecoveryTarget['delivery']; observation: RecoveryTarget['observation'];
    content?: RecoveryTarget['content']; backend?: unknown;
  }>;
}

export interface ScopedInventoryLoadResult extends RecoveryInventoryInput {
  nativeSnapshot: {
    payload: StatusV8Payload;
    pluginSummaries: readonly (Pick<StatusV8PluginSummary, 'pluginId'> & Partial<StatusV8PluginSummary>)[];
    targetRevisions: readonly StatusTargetRevision[];
    dependencyOverviews: readonly PluginDependencyOverviewViewModel[];
  };
}

const stateOrder: Record<InventoryState, number> = {
  blocked: 0, unknown: 1, pending: 2, ready: 3,
};

function agentForPlatform(platform: PlatformName): AgentId {
  return platform === 'claude' ? 'claude-code' : 'codex';
}

function targetIdentity(target: Pick<InventoryTarget, 'platform' | 'scope' | 'agent' | 'delivery'>): string {
  return [target.agent ?? '', target.delivery ?? '', target.platform ?? '', target.scope].join('\0');
}

export function hasStatusInstallationEvidence(target: StatusScopedTarget): boolean {
  return hasActualScopeEvidence(target)
    || target.reasons.some((reason) => reason.code === 'sourceMissing'
      || reason.code === 'catalogSourceUnavailable' || reason.code === 'bundleUnavailable');
}

function targetState(target: RecoveryTarget): InventoryState {
  if (target.blockers.length) return canPreparePortable(target) ? 'pending' : 'blocked';
  if (target.content === 'conflict') return 'blocked';
  if (target.observation === 'missing' || target.content === 'absent'
    || target.content === 'drifted') return 'pending';
  if (target.observation === 'unknown' || target.content === 'unknown') return 'unknown';
  return 'ready';
}

function canPreparePortable(target: RecoveryTarget): boolean {
  return target.delivery?.kind === 'agent-skills'
    && target.blockers.length > 0
    && target.blockers.every((blocker) => blocker.code === 'needs-preparation');
}

function rootState(root: NonNullable<RecoveryInventoryInput['inventory']>[number]): InventoryState {
  if (root.blockers.length) return 'blocked';
  const states = root.targetResults.map(targetState);
  return (['blocked', 'unknown', 'pending', 'ready'] as const)
    .find((state) => states.includes(state)) ?? 'unknown';
}

function sortedRoots(roots: InventoryRoot[]): InventoryRoot[] {
  return roots.sort((a, b) => stateOrder[a.state] - stateOrder[b.state]
    || a.displayName.localeCompare(b.displayName, 'en') || a.pluginId.localeCompare(b.pluginId, 'en'));
}

function statusState(target: StatusScopedTarget): InventoryState {
  const reasons = [...target.reasons, ...(target.sharedReasons ?? [])];
  if (target.state === 'blocked' || reasons.some((reason) => reason.severity === 'blocking')) return 'blocked';
  if (statusTargetSharedNative(target)?.state === 'unobserved'
    || statusTargetActivation(target)?.evidence === 'unobserved'
    || statusTargetOwnershipState(target) === 'error'
    || reasons.some((reason) => reason.code.includes('Unobserved')
      || reason.code.includes('ObservationFailed') || reason.code === 'nativeStateUnreadable')) return 'unknown';
  if (target.state === 'ready') return 'ready';
  if (target.state === 'needsSync' && (hasActualScopeEvidence(target)
    || statusTargetOwnershipState(target) === 'absent'
    || statusTargetOwnershipState(target) === 'partial')) return 'pending';
  return 'unknown';
}

export function buildScopedInventory(options: {
  recovery: RecoveryInventoryInput;
  status: StatusV8Payload;
  pluginSummaries: readonly Pick<StatusV8PluginSummary, 'pluginId' | 'displayName'>[];
  targetRevisions?: readonly StatusTargetRevision[];
  dependencyOverviews?: readonly PluginDependencyOverviewViewModel[];
  projectRoot?: string;
}): ScopedInventoryViewModel {
  const { recovery } = options;
  const statusTargets = flattenStatusTargets(options.status.targets);
  const targetsById = new Map<string, StatusScopedTarget[]>();
  for (const target of statusTargets) targetsById.set(target.pluginId,
    [...(targetsById.get(target.pluginId) ?? []), target]);
  const revisions = new Map((options.targetRevisions ?? []).map((entry) => [
    `${entry.pluginId}\0${entry.platform}\0${entry.scope}`, entry.revision,
  ]));
  const targetView = (target: StatusScopedTarget, location: InventoryTarget['location']): InventoryTarget => {
    const revision = revisions.get(`${target.pluginId}\0${target.platform}\0${target.scope}`);
    return {
      platform: target.platform, scope: target.scope, location, state: statusState(target),
      agent: agentForPlatform(target.platform), delivery: 'native',
      ...(revision?.availableVersion ?? target.version
        ? { expectedVersion: revision?.availableVersion ?? target.version } : {}),
      ...(revision?.installedVersion ? { installedVersion: revision.installedVersion } : {}),
      reasonCodes: [...new Set([...target.reasons, ...(target.sharedReasons ?? [])]
        .flatMap((reason) => [reason.code, ...(reason.rootIssueCode ? [reason.rootIssueCode] : [])]))],
    };
  };
  const names = new Map(options.pluginSummaries.map((plugin) => [plugin.pluginId, plugin.displayName]));
  const nameFor = (pluginId: string): string => names.get(pluginId) ?? pluginId.split('/').at(-1) ?? pluginId;
  const dependencyIds = new Set<string>();
  const declaredRoots = (recovery.inventory ?? []).map((root): InventoryRoot => {
    const nativeTargets = (targetsById.get(root.pluginId) ?? [])
      .filter((target) => target.scope === recovery.scope
        && (statusTargetIntent(target).scopes.includes(recovery.scope) || hasActualScopeEvidence(target)));
    const recoveryTargets = root.targetResults.flatMap((target): InventoryTarget[] =>
      target.delivery ? [{
        ...(target.delivery.kind === 'native' ? { platform: target.delivery.platform } : {}),
        scope: target.scope, location: 'scope', state: targetState(target),
        reasonCodes: target.blockers.map((blocker) => blocker.code),
        agent: target.agent, delivery: target.delivery.kind,
        ...(target.delivery.kind === 'agent-skills' ? {
          observation: target.content === 'drifted' || target.observation === 'verified' || target.observation === 'missing'
            ? 'known' as const : 'unknown' as const,
          actual: target.content === 'satisfied' || target.content === 'drifted',
        } : {}),
      }] : []);
    const observedTargets = nativeTargets.map((target) => targetView(target, 'scope'));
    for (const target of recoveryTargets) {
      const current = observedTargets.find((entry) => targetIdentity(entry) === targetIdentity(target));
      if (current) {
        current.state = target.state;
        current.reasonCodes = [...new Set([...current.reasonCodes, ...target.reasonCodes])];
        current.agent = target.agent;
        current.delivery = target.delivery;
      } else observedTargets.push(target);
    }
    const overview = options.dependencyOverviews?.find((entry) => entry.pluginId === root.pluginId);
    const dependencies = (overview?.dependencies ?? []).map((dependency): InventoryDependency => {
      dependencyIds.add(dependency.pluginId);
      const linkedUser = new Set(nativeTargets.flatMap((consumer) => consumer.components
        .filter((component) => component.kind === 'dependency' && component.key === dependency.pluginId
          && component.metadata?.scope === 'user' && component.state === 'ready')
        .map(() => consumer.platform)));
      const targets = (targetsById.get(dependency.pluginId) ?? []).filter((target) =>
        target.scope === recovery.scope
          && (statusTargetIntent(target).scopes.includes(recovery.scope) || hasActualScopeEvidence(target))
        || recovery.scope === 'project' && target.scope === 'user'
          && linkedUser.has(target.platform) && hasActualScopeEvidence(target))
        .map((target) => targetView(target, target.scope === recovery.scope ? 'scope' : 'sharedUser'));
      if (recovery.scope === 'project') {
        for (const consumer of nativeTargets) {
          for (const component of consumer.components) {
            if (component.kind !== 'dependency' || component.key !== dependency.pluginId
              || component.metadata?.scope !== 'user'
              || targets.some((target) => target.platform === consumer.platform && target.scope === 'user')) continue;
            targets.push({ platform: consumer.platform, scope: 'user', location: 'sharedUser',
              state: component.state === 'ready' ? 'ready'
                : component.state === 'absent' || component.state === 'incomplete' ? 'pending'
                  : component.state === 'error' ? 'unknown' : 'blocked',
              reasonCodes: typeof component.metadata.rootIssueCode === 'string'
                ? [component.metadata.rootIssueCode] : [],
            });
          }
        }
      }
      return { pluginId: dependency.pluginId, displayName: dependency.displayName, targets };
    });
    return {
    scope: recovery.scope,
    pluginId: root.pluginId,
    sourceId: root.source,
    displayName: nameFor(root.pluginId),
    section: 'declared',
    state: rootState(root),
    targets: observedTargets,
    dependencies,
    agentResults: root.targetResults,
    blockers: root.blockers,
    sourceState: root.sourceState,
  }; });
  const declaredIds = new Set(declaredRoots.map((root) => root.pluginId));
  const extras = new Map<string, InventoryTarget[]>();
  for (const target of recovery.extraObserved ?? []) {
    if (target.scope !== recovery.scope || declaredIds.has(target.pluginId)) continue;
    if (!target.delivery && !target.agent) {
      if (!extras.has(target.pluginId)) extras.set(target.pluginId, []);
      continue;
    }
    const state: InventoryState = target.content === 'conflict' ? 'blocked'
      : target.observation === 'missing' || target.content === 'absent' || target.content === 'drifted' ? 'pending'
        : target.observation === 'unknown' || target.content === 'unknown' ? 'unknown' : 'ready';
    extras.set(target.pluginId, [...(extras.get(target.pluginId) ?? []), {
      ...(target.delivery?.kind === 'native' ? { platform: target.delivery.platform } : {}),
      scope: recovery.scope, location: 'scope', state, reasonCodes: [],
      ...(target.agent ? { agent: target.agent } : {}),
      ...(target.delivery ? { delivery: target.delivery.kind } : {}),
      ...(target.delivery?.kind === 'agent-skills' ? {
        observation: target.content === 'drifted' || target.observation === 'verified' || target.observation === 'missing'
          ? 'known' as const : 'unknown' as const,
        actual: target.content === 'satisfied' || target.content === 'drifted',
      } : {}),
    }]);
  }
  for (const target of statusTargets) {
    if (target.scope !== recovery.scope || !hasActualScopeEvidence(target)
      || declaredIds.has(target.pluginId) || dependencyIds.has(target.pluginId)
      || statusTargetIntent(target).relation === 'dependency') continue;
    const observed = targetView(target, 'scope');
    const current = extras.get(target.pluginId) ?? [];
    const index = current.findIndex((entry) => targetIdentity(entry) === targetIdentity(observed));
    if (index < 0) extras.set(target.pluginId, [...current, observed]);
    else extras.set(target.pluginId, current.map((entry, entryIndex) => entryIndex === index
      ? { ...entry, ...observed, state: stateOrder[entry.state] < stateOrder[observed.state] ? entry.state : observed.state,
        reasonCodes: [...new Set([...entry.reasonCodes, ...observed.reasonCodes])] } : entry));
  }
  const extraInstalledRoots = [...extras].map(([pluginId, targets]): InventoryRoot => ({
    scope: recovery.scope,
    pluginId, sourceId: pluginId.split('/')[0] ?? pluginId, displayName: nameFor(pluginId),
    section: 'extraInstalled', state: (['blocked', 'unknown', 'pending', 'ready'] as const)
      .find((state) => targets.some((target) => target.state === state)) ?? 'unknown',
    targets, dependencies: [],
  }));
  const counts = { blocked: 0, unknown: 0, pending: 0, ready: 0 };
  for (const root of declaredRoots) counts[root.state] += 1;
  const syncTargets = (recovery.intent.state === 'valid' ? recovery.inventory ?? [] : [])
    .flatMap((root) => root.blockers.length ? [] : root.targetResults.filter((target) =>
    (!target.blockers.length || canPreparePortable(target)) && targetState(target) === 'pending')
    .map((target) => ({ pluginId: target.pluginId, agent: target.agent, scope: recovery.scope })));
  return {
    scope: recovery.scope,
    ...(options.projectRoot ? { projectRoot: options.projectRoot, projectName: path.basename(options.projectRoot) } : {}),
    declarationState: recovery.intent.state === 'valid' ? 'ready'
      : recovery.intent.state === 'absent' ? 'absent' : 'invalid',
    preferenceState: recovery.selection.preferences,
    selectedAgents: recovery.selection.agents,
    declaredRoots: sortedRoots(declaredRoots), extraInstalledRoots: sortedRoots(extraInstalledRoots),
    syncTargets, counts, errors: recovery.errors, allSatisfied: recovery.allSatisfied,
    ...(recovery.coverage ? { coverage: recovery.coverage } : {}),
  };
}
