import path from 'node:path';
import type { ProjectStatusV1, ProjectTargetResult, ProjectDiagnostic } from '../project/project-types.js';

import type { PlatformName, Scope } from '../types.js';
import {
  flattenStatusTargets,
  statusTargetActivation,
  statusTargetIntent,
  statusTargetOwnershipState,
  statusTargetSharedNative,
  type StatusScopedTarget,
  type StatusTargetRevision,
  type StatusV8Payload,
} from '../commands/status-v6.js';
import {
  hasActualScopeEvidence,
  type PluginDependencyOverviewViewModel,
  type PluginListItemViewModel,
} from './model.js';

export type ProjectInventoryState = 'blocked' | 'pending' | 'unknown' | 'ready';

export interface ProjectInventoryTarget {
  platform: PlatformName;
  scope: Scope;
  location: 'project' | 'sharedUser';
  state: ProjectInventoryState;
  expectedVersion?: string;
  installedVersion?: string;
  reasonCodes: string[];
}

export interface ProjectInventoryDependency {
  pluginId: string;
  displayName: string;
  targets: ProjectInventoryTarget[];
}

export interface ProjectInventoryRoot {
  pluginId: string;
  sourceId: string;
  displayName: string;
  section: 'declared' | 'extraInstalled';
  state: ProjectInventoryState;
  targets: ProjectInventoryTarget[];
  dependencies: ProjectInventoryDependency[];
  agentResults?: ProjectTargetResult[];
  blockers?: ProjectDiagnostic[];
  sourceState?: string;
}

export interface ProjectInventoryViewModel {
  projectRoot?: string;
  projectName?: string;
  declarationState: 'ready' | 'absent' | 'invalid' | 'unavailable' | 'notProject';
  declaredRoots: ProjectInventoryRoot[];
  extraInstalledRoots: ProjectInventoryRoot[];
  syncTargets: Array<{ pluginId: string; platform: PlatformName; scope: 'project' }>;
  counts: Record<ProjectInventoryState, number>;
  recovery?: ProjectStatusV1;
}

type ProjectIntent =
  | { state: 'ready'; roots: Array<{ pluginId: string; platforms: PlatformName[] }> }
  | { state: 'absent' }
  | { state: 'invalid' | 'unavailable'; code: string; message: string };

const stateOrder: Record<ProjectInventoryState, number> = {
  blocked: 0,
  pending: 1,
  unknown: 2,
  ready: 3,
};

function reasonCodes(target: StatusScopedTarget): string[] {
  return [...new Set([...target.reasons, ...(target.sharedReasons ?? [])]
    .flatMap((reason) => [reason.code, ...(reason.rootIssueCode ? [reason.rootIssueCode] : [])]))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function hasStatusInstallationEvidence(target: StatusScopedTarget): boolean {
  return hasActualScopeEvidence(target)
    || target.reasons.some((reason) => reason.code === 'sourceMissing'
      || reason.code === 'catalogSourceUnavailable'
      || reason.code === 'bundleUnavailable');
}

function targetState(target: StatusScopedTarget): ProjectInventoryState {
  const reasons = [...target.reasons, ...(target.sharedReasons ?? [])];
  if (target.state === 'blocked' || reasons.some((reason) => reason.severity === 'blocking')) {
    return 'blocked';
  }
  if (target.state === 'ready') return 'ready';
  if (statusTargetSharedNative(target)?.state === 'unobserved'
    || statusTargetActivation(target)?.evidence === 'unobserved'
    || statusTargetOwnershipState(target) === 'error'
    || reasons.some((reason) => reason.code.includes('Unobserved')
      || reason.code.includes('ObservationFailed')
      || reason.code === 'nativeStateUnreadable')) return 'unknown';
  if (target.state === 'needsSync' && (hasActualScopeEvidence(target)
    || statusTargetOwnershipState(target) === 'absent'
    || statusTargetOwnershipState(target) === 'partial')) return 'pending';
  return 'unknown';
}

function combinedState(targets: readonly ProjectInventoryTarget[]): ProjectInventoryState {
  return (['blocked', 'pending', 'unknown', 'ready'] as const)
    .find((state) => targets.some((target) => target.state === state)) ?? 'unknown';
}

function sortedRoots(roots: ProjectInventoryRoot[]): ProjectInventoryRoot[] {
  return roots.sort((left, right) => stateOrder[left.state] - stateOrder[right.state]
    || left.displayName.localeCompare(right.displayName, 'en')
    || left.pluginId.localeCompare(right.pluginId, 'en'));
}

export function buildProjectInventory(options: {
  projectRoot?: string;
  projectIntent?: ProjectIntent;
  status: StatusV8Payload;
  pluginSummaries: readonly PluginListItemViewModel[];
  targetRevisions?: readonly StatusTargetRevision[];
  dependencyOverviews?: readonly PluginDependencyOverviewViewModel[];
  actionableTargets?: readonly { pluginId: string; platform: PlatformName; scope: Scope }[];
  projectRecovery?: ProjectStatusV1;
}): ProjectInventoryViewModel {
  const targets = flattenStatusTargets(options.status.targets);
  const targetsById = new Map<string, StatusScopedTarget[]>();
  for (const target of targets) {
    targetsById.set(target.pluginId, [...(targetsById.get(target.pluginId) ?? []), target]);
  }
  const plugins = new Map(options.pluginSummaries.map((plugin) => [plugin.pluginId, plugin]));
  const sources = new Map(options.status.catalog.sources.map((source) => [source.id, source]));
  const dependencies = new Map((options.dependencyOverviews ?? [])
    .map((overview) => [overview.pluginId, overview]));
  const revisions = new Map((options.targetRevisions ?? []).map((revision) => [
    `${revision.pluginId}\0${revision.platform}\0${revision.scope}`, revision.revision,
  ]));
  const targetView = (target: StatusScopedTarget, location: ProjectInventoryTarget['location']): ProjectInventoryTarget => {
    const revision = revisions.get(`${target.pluginId}\0${target.platform}\0${target.scope}`);
    return {
      platform: target.platform,
      scope: target.scope,
      location,
      state: targetState(target),
      ...(revision?.availableVersion ?? target.version
        ? { expectedVersion: revision?.availableVersion ?? target.version }
        : {}),
      ...(revision?.installedVersion ? { installedVersion: revision.installedVersion } : {}),
      reasonCodes: reasonCodes(target),
    };
  };
  const nameFor = (pluginId: string): string => plugins.get(pluginId)?.displayName
    ?? targetsById.get(pluginId)?.[0]?.pluginName
    ?? pluginId.split('/').at(-1) ?? pluginId;
  const declared = !options.projectRecovery && options.projectIntent?.state === 'ready'
    ? options.projectIntent.roots : [];
  const recoveryIds = new Set(options.projectRecovery?.inventory?.map((root) => root.pluginId) ?? []);
  const declaredIds = new Set([...declared.map((root) => root.pluginId), ...recoveryIds]);
  const dependencyIds = new Set<string>();
  const declaredRoots = declared.map((root): ProjectInventoryRoot => {
    const rootTargets: ProjectInventoryTarget[] = [];
    const sharedDependencyKeys = new Set<string>();
    const rootStatusTargets = targetsById.get(root.pluginId) ?? [];
    const sourceId = root.pluginId.split('/')[0] ?? root.pluginId;
    const source = sources.get(sourceId);
    const missingReason = !source ? 'sourceMissing'
      : source.error ? 'catalogSourceUnavailable'
        : !plugins.has(root.pluginId) ? 'bundleUnavailable' : 'projectTargetUnavailable';
    for (const platform of root.platforms) {
      const projectTarget = rootStatusTargets.find((target) =>
        target.platform === platform && target.scope === 'project');
      if (projectTarget) rootTargets.push(targetView(projectTarget, 'project'));
      else rootTargets.push({
        platform,
        scope: 'project',
        location: 'project',
        state: missingReason === 'projectTargetUnavailable' ? 'unknown' : 'blocked',
        ...(plugins.get(root.pluginId)?.version
          ? { expectedVersion: plugins.get(root.pluginId)!.version }
          : {}),
        reasonCodes: [missingReason],
      });
    }
    const overview = dependencies.get(root.pluginId);
    const allDependencies = overview?.dependencies ?? [];
    for (const dependency of allDependencies) dependencyIds.add(dependency.pluginId);
    const rootDependencyIds = new Set(allDependencies.map((dependency) => dependency.pluginId));
    const consumers = rootStatusTargets.filter((target) =>
      root.platforms.includes(target.platform) && target.scope === 'project');
    const seenConsumers = new Set(consumers.map((target) =>
      `${target.pluginId}\0${target.platform}\0${target.scope}`));
    for (let index = 0; index < consumers.length; index += 1) {
      for (const component of consumers[index]!.components) {
        if (component.kind !== 'dependency' || component.state !== 'ready'
          || !rootDependencyIds.has(component.key)) continue;
        const candidate = (targetsById.get(component.key) ?? []).find((target) =>
          target.platform === consumers[index]!.platform
          && target.scope === component.metadata?.scope
          && hasActualScopeEvidence(target));
        if (!candidate) continue;
        if (candidate.scope === 'user') {
          sharedDependencyKeys.add(`${candidate.pluginId}\0${candidate.platform}`);
        }
        const key = `${candidate.pluginId}\0${candidate.platform}\0${candidate.scope}`;
        if (!seenConsumers.has(key)) {
          seenConsumers.add(key);
          consumers.push(candidate);
        }
      }
    }
    const nested = allDependencies.map((dependency): ProjectInventoryDependency => ({
      pluginId: dependency.pluginId,
      displayName: dependency.displayName,
      targets: (targetsById.get(dependency.pluginId) ?? [])
        .filter((target) => root.platforms.includes(target.platform)
          && (target.scope === 'project'
            && (statusTargetIntent(target).scopes.includes('project') || hasActualScopeEvidence(target))
            || target.scope === 'user'
              && sharedDependencyKeys.has(`${dependency.pluginId}\0${target.platform}`)))
        .map((target) => targetView(target, target.scope === 'user' ? 'sharedUser' : 'project')),
    }));
    return {
      pluginId: root.pluginId,
      sourceId,
      displayName: nameFor(root.pluginId),
      section: 'declared',
      state: combinedState(rootTargets.filter((target) => target.location === 'project')),
      targets: rootTargets,
      dependencies: nested,
    };
  });
  if (options.projectRecovery?.inventory) {
    for (const root of options.projectRecovery.inventory) {
      const agentResults = root.targetResults;
      const states = agentResults.map((target): ProjectInventoryState => {
        if (target.blockers.length > 0) return 'blocked';
        if (target.observation === 'verified') return 'ready';
        if (target.observation === 'missing' || target.content === 'drifted') return 'pending';
        return 'unknown';
      });
      declaredRoots.push({
        pluginId: root.pluginId,
        sourceId: root.source,
        displayName: nameFor(root.pluginId),
        section: 'declared',
        state: root.blockers.length > 0 ? 'blocked'
          : states.includes('blocked') ? 'blocked'
            : states.includes('pending') ? 'pending'
              : states.includes('unknown') || states.length === 0 ? 'unknown' : 'ready',
        targets: [], dependencies: [], agentResults,
        blockers: root.blockers, sourceState: root.sourceState,
      });
    }
  }
  const extraById = new Map<string, ProjectInventoryTarget[]>();
  if (options.projectRoot) {
    for (const target of targets) {
      if (target.scope !== 'project' || !hasStatusInstallationEvidence(target)
        || declaredIds.has(target.pluginId) || dependencyIds.has(target.pluginId)
        || statusTargetIntent(target).relation === 'dependency') continue;
      extraById.set(target.pluginId, [
        ...(extraById.get(target.pluginId) ?? []), targetView(target, 'project'),
      ]);
    }
  }
  const extraInstalledRoots = [...extraById].map(([pluginId, extraTargets]): ProjectInventoryRoot => ({
    pluginId,
    sourceId: pluginId.split('/')[0] ?? pluginId,
    displayName: nameFor(pluginId),
    section: 'extraInstalled',
    state: combinedState(extraTargets),
    targets: extraTargets,
    dependencies: [],
  }));
  const counts = { blocked: 0, pending: 0, unknown: 0, ready: 0 };
  for (const root of declaredRoots) counts[root.state] += 1;
  const declaredPlatforms = new Set(declared.flatMap((root) => root.platforms.map((platform) =>
    `${root.pluginId}\0${platform}`)));
  const syncTargets = [...new Map((options.projectRecovery ? [] : options.actionableTargets ?? [])
    .filter((target) => target.scope === 'project'
      && declaredPlatforms.has(`${target.pluginId}\0${target.platform}`))
    .map((target) => [`${target.pluginId}\0${target.platform}`, {
      pluginId: target.pluginId,
      platform: target.platform,
      scope: 'project' as const,
    }])).values()];
  return {
    ...(options.projectRoot ? {
      projectRoot: options.projectRoot,
      projectName: path.basename(options.projectRoot),
    } : {}),
    declarationState: options.projectRoot
      ? options.projectRecovery
        ? options.projectRecovery.intent.state === 'valid' ? 'ready'
          : options.projectRecovery.intent.state === 'absent' ? 'absent' : 'invalid'
        : options.projectIntent?.state ?? 'absent' : 'notProject',
    declaredRoots: sortedRoots(declaredRoots),
    extraInstalledRoots: sortedRoots(extraInstalledRoots),
    syncTargets,
    counts,
    ...(options.projectRecovery ? { recovery: options.projectRecovery } : {}),
  };
}
