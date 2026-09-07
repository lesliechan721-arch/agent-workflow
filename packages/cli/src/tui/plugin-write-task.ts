import type { PlatformName, Scope } from '../types.js';
import type {
  PluginListItemViewModel,
  TuiViewModel,
  UserIssueViewModel,
} from './model.js';

export type PluginWriteTaskGoal = 'restore' | 'update';
export type PluginWriteTaskMethod = 'sync' | 'reinstall';

export interface PluginWriteTaskExpectedUpdate {
  installedVersion: string;
  activeVersion: string;
  sourceIdentity: string;
  generationKey: string;
}

export interface PluginWriteTaskTarget {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  expectedUpdate?: PluginWriteTaskExpectedUpdate;
}

export interface PluginWriteTaskIntent {
  kind: 'pluginWriteTask';
  goal: PluginWriteTaskGoal;
  targets: PluginWriteTaskTarget[];
  executionPolicy: 'all' | 'executableSubset';
  scriptTimeoutMs?: number;
}

export type PluginWriteTaskBlockReason =
  | 'catalogActivationRequired'
  | 'updateEvidenceIncomplete'
  | 'updateIncompatible'
  | 'restoreVersionChanged'
  | 'restoreVersionUnverified'
  | 'manualRecoveryRequired'
  | 'taskActionConflict'
  | 'targetUnavailable';

export interface PluginWriteTaskCandidate {
  target: PluginWriteTaskTarget;
  displayName: string;
  sourceId: string;
  eligible: boolean;
  blockReason?: PluginWriteTaskBlockReason;
  recommendedMethod?: PluginWriteTaskMethod;
  issueIds: string[];
}

export interface PluginWriteTaskCause {
  causeKey: string;
  issueId: string;
  sourceId: string;
  sourceIdentity: string;
  repairTarget: Omit<PluginWriteTaskTarget, 'expectedUpdate'>;
  method: PluginWriteTaskMethod;
  consumers: Array<Omit<PluginWriteTaskTarget, 'expectedUpdate'>>;
  restoreVersionEvidence?: {
    state: 'preserved' | 'absent';
    activeVersion: string;
    installedVersion?: string;
  };
}

export interface PluginWriteTaskBlockedTarget {
  target: PluginWriteTaskTarget;
  reason: PluginWriteTaskBlockReason;
  issueIds: string[];
  errorCodes?: string[];
}

export interface PluginWriteTaskDraft {
  requestedTargets: PluginWriteTaskTarget[];
  executableTargets: PluginWriteTaskTarget[];
  causes: PluginWriteTaskCause[];
  blockedTargets: PluginWriteTaskBlockedTarget[];
}

function targetKey(target: Pick<PluginWriteTaskTarget, 'pluginId' | 'platform' | 'scope'>): string {
  return [target.pluginId, target.platform, target.scope].join('\0');
}

function canonicalTargets(targets: readonly PluginWriteTaskTarget[]): PluginWriteTaskTarget[] {
  return [...new Map(targets.map((target) => [targetKey(target), structuredClone(target)])).values()]
    .sort((left, right) => targetKey(left).localeCompare(targetKey(right), 'en'));
}

function exactTarget(target: PluginWriteTaskTarget): Omit<PluginWriteTaskTarget, 'expectedUpdate'> {
  return { pluginId: target.pluginId, platform: target.platform, scope: target.scope };
}

function issueConsumers(issue: UserIssueViewModel): Array<Omit<PluginWriteTaskTarget, 'expectedUpdate'>> {
  const affected = issue.affectedTargets ?? [];
  if (affected.length > 0) {
    return canonicalTargets(affected.map((target) => ({
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
    }))).map(exactTarget);
  }
  const root = issue.rootEntity
    ?? (issue.pluginId && issue.platform && issue.scope
      ? { pluginId: issue.pluginId, platform: issue.platform, scope: issue.scope }
      : undefined);
  return root ? [root] : [];
}

function issueMethod(issue: UserIssueViewModel): PluginWriteTaskMethod | undefined {
  for (const action of issue.actions) {
    if (action.writeAction === 'sync') return 'sync';
    if (action.writeAction === 'reinstall') return 'reinstall';
    if (action.writeAction === 'install' && issue.dependencyPluginId) return 'sync';
  }
  return undefined;
}

function issueRepairTarget(
  issue: UserIssueViewModel,
): Omit<PluginWriteTaskTarget, 'expectedUpdate'> | undefined {
  if (issue.dependencyPluginId && issue.dependencyPlatform && issue.dependencyScope) {
    return {
      pluginId: issue.dependencyPluginId,
      platform: issue.dependencyPlatform,
      scope: issue.dependencyScope,
    };
  }
  return issue.rootEntity
    ?? (issue.pluginId && issue.platform && issue.scope
      ? { pluginId: issue.pluginId, platform: issue.platform, scope: issue.scope }
      : undefined);
}

export function evaluatePluginWriteTaskRestoreVersion(
  target: Omit<PluginWriteTaskTarget, 'expectedUpdate'>,
  allowAbsent: boolean,
  model: Pick<TuiViewModel, 'plugins'>,
): {
  evidence?: PluginWriteTaskCause['restoreVersionEvidence'];
  blockReason?: 'restoreVersionChanged' | 'restoreVersionUnverified';
} {
  const plugin = model.plugins.find((candidate) => candidate.pluginId === target.pluginId);
  const revision = plugin?.update.targets.find((candidate) =>
    candidate.platform === target.platform && candidate.scope === target.scope);
  if (revision?.installedVersion && revision.activeVersion
    && revision.installedVersion !== revision.activeVersion) {
    return { blockReason: 'restoreVersionChanged' };
  }
  if (!revision?.activeVersion) {
    return allowAbsent && plugin?.version
      ? { evidence: { state: 'absent', activeVersion: plugin.version } }
      : { blockReason: 'restoreVersionUnverified' };
  }
  if (revision.installedVersion) {
    return {
      evidence: {
          state: 'preserved',
          installedVersion: revision.installedVersion,
          activeVersion: revision.activeVersion,
      },
    };
  }
  return allowAbsent
    ? { evidence: { state: 'absent', activeVersion: revision.activeVersion } }
    : { blockReason: 'restoreVersionUnverified' };
}

function restoreIssueVersionEvidence(
  issue: UserIssueViewModel,
  model: Pick<TuiViewModel, 'plugins'>,
): PluginWriteTaskCause['restoreVersionEvidence'] | undefined {
  const repairTarget = issueRepairTarget(issue);
  return repairTarget
    ? evaluatePluginWriteTaskRestoreVersion(
        repairTarget,
        issue.category === 'dependencyMissing',
        model,
      ).evidence
    : undefined;
}

function restoreIssueVersionBlockReason(
  issue: UserIssueViewModel,
  model: Pick<TuiViewModel, 'plugins'>,
): PluginWriteTaskBlockReason | undefined {
  const repairTarget = issueRepairTarget(issue);
  return repairTarget
    ? evaluatePluginWriteTaskRestoreVersion(
        repairTarget,
        issue.category === 'dependencyMissing',
        model,
      ).blockReason
    : 'restoreVersionUnverified';
}

function restoreCandidate(options: {
  plugin: PluginListItemViewModel;
  target: Omit<PluginWriteTaskTarget, 'expectedUpdate'>;
  issues: UserIssueViewModel[];
  model: Pick<TuiViewModel, 'plugins'>;
}): PluginWriteTaskCandidate {
  const matchingIssues = options.issues.filter((issue) => issueConsumers(issue)
    .some((consumer) => targetKey(consumer) === targetKey(options.target)));
  const actionable = matchingIssues.map((issue) => issueMethod(issue));
  const update = options.plugin.update.targets.find((candidate) =>
    candidate.platform === options.target.platform && candidate.scope === options.target.scope);
  let blockReason: PluginWriteTaskBlockReason | undefined;
  if (!update?.installedVersion || !update.activeVersion) blockReason = 'restoreVersionUnverified';
  else if (update.installedVersion !== update.activeVersion) blockReason = 'restoreVersionChanged';
  else {
    blockReason = matchingIssues.map((issue) => restoreIssueVersionBlockReason(issue, options.model))
      .find((reason) => reason !== undefined);
  }
  if (!blockReason && (matchingIssues.length === 0 || actionable.some((method) => method === undefined))) {
    blockReason = 'manualRecoveryRequired';
  }
  const methods = new Set(actionable.filter((method): method is PluginWriteTaskMethod => Boolean(method)));
  return {
    target: options.target,
    displayName: options.plugin.displayName,
    sourceId: options.plugin.sourceId,
    eligible: blockReason === undefined,
    ...(blockReason ? { blockReason } : {}),
    ...(methods.has('reinstall') ? { recommendedMethod: 'reinstall' as const }
      : methods.has('sync') ? { recommendedMethod: 'sync' as const } : {}),
    issueIds: matchingIssues.map((issue) => issue.issueId).sort((left, right) =>
      left.localeCompare(right, 'en')),
  };
}

function updateCandidate(options: {
  plugin: PluginListItemViewModel;
  platform: PlatformName;
  scope: Scope;
}): PluginWriteTaskCandidate {
  const update = options.plugin.update.targets.find((candidate) =>
    candidate.platform === options.platform && candidate.scope === options.scope)!;
  let blockReason: PluginWriteTaskBlockReason | undefined;
  if (update.requiresCatalogActivation) blockReason = 'catalogActivationRequired';
  else if (update.eligibility === 'incompatible') blockReason = 'updateIncompatible';
  else if (!update.installedVersion || !update.availableVersion
    || !options.plugin.update.sourceIdentity || !options.plugin.update.generationKey) {
    blockReason = 'updateEvidenceIncomplete';
  }
  const expectedUpdate = blockReason === undefined ? {
    installedVersion: update.installedVersion!,
    activeVersion: update.availableVersion!,
    sourceIdentity: options.plugin.update.sourceIdentity!,
    generationKey: options.plugin.update.generationKey!,
  } : undefined;
  return {
    target: {
      pluginId: options.plugin.pluginId,
      platform: options.platform,
      scope: options.scope,
      ...(expectedUpdate ? { expectedUpdate } : {}),
    },
    displayName: options.plugin.displayName,
    sourceId: options.plugin.sourceId,
    eligible: blockReason === undefined,
    ...(blockReason ? { blockReason } : {}),
    recommendedMethod: update.eligibility === 'needsRepair' ? 'reinstall' : 'sync',
    issueIds: [],
  };
}

export function buildPluginWriteTaskCandidates(
  model: Pick<TuiViewModel, 'plugins' | 'issues'>,
  goal: PluginWriteTaskGoal,
): PluginWriteTaskCandidate[] {
  if (goal === 'update') {
    return model.plugins.flatMap((plugin) => plugin.update.targets
      .filter((target) => target.availableVersion !== undefined)
      .map((target) => updateCandidate({
        plugin,
        platform: target.platform,
        scope: target.scope,
      }))).sort((left, right) => targetKey(left.target).localeCompare(targetKey(right.target), 'en'));
  }
  const candidates = new Map<string, PluginWriteTaskCandidate>();
  for (const issue of model.issues) {
    for (const target of issueConsumers(issue)) {
      const plugin = model.plugins.find((candidate) => candidate.pluginId === target.pluginId);
      if (!plugin) continue;
      candidates.set(targetKey(target), restoreCandidate({
        plugin,
        target,
        issues: model.issues,
        model,
      }));
    }
  }
  return [...candidates.values()].sort((left, right) =>
    targetKey(left.target).localeCompare(targetKey(right.target), 'en'));
}

export function buildPluginWriteTaskDraft(
  intent: PluginWriteTaskIntent,
  model: Pick<TuiViewModel, 'plugins' | 'issues'>,
  providedCandidates?: readonly PluginWriteTaskCandidate[],
): PluginWriteTaskDraft {
  const requestedTargets = canonicalTargets(intent.targets);
  const candidates = new Map((providedCandidates ?? buildPluginWriteTaskCandidates(model, intent.goal))
    .map((candidate) => [targetKey(candidate.target), candidate]));
  const blockedTargets: PluginWriteTaskBlockedTarget[] = [];
  const executableTargets: PluginWriteTaskTarget[] = [];
  for (const target of requestedTargets) {
    const candidate = candidates.get(targetKey(target));
    const expectedMatches = intent.goal !== 'update' || JSON.stringify(target.expectedUpdate)
      === JSON.stringify(candidate?.target.expectedUpdate);
    if (!candidate || !candidate.eligible || !expectedMatches) {
      blockedTargets.push({
        target,
        reason: candidate?.blockReason ?? (expectedMatches
          ? 'targetUnavailable' : 'updateEvidenceIncomplete'),
        issueIds: candidate?.issueIds ?? [],
      });
      continue;
    }
    executableTargets.push(target);
  }

  const executableKeys = new Set(executableTargets.map(targetKey));
  const causes = new Map<string, PluginWriteTaskCause>();
  if (intent.goal === 'update') {
    for (const target of executableTargets) {
      const candidate = candidates.get(targetKey(target))!;
      const sourceIdentity = target.expectedUpdate!.sourceIdentity;
      const causeKey = ['update', sourceIdentity, targetKey(target),
        target.expectedUpdate!.activeVersion].join('\0');
      causes.set(causeKey, {
        causeKey,
        issueId: causeKey,
        sourceId: candidate.sourceId,
        sourceIdentity,
        repairTarget: exactTarget(target),
        method: candidate.recommendedMethod!,
        consumers: [exactTarget(target)],
      });
    }
  } else {
    for (const issue of model.issues) {
      const consumers = issueConsumers(issue).filter((target) => executableKeys.has(targetKey(target)));
      const repairTarget = issueRepairTarget(issue);
      const method = issueMethod(issue);
      if (consumers.length === 0 || !repairTarget || !method || !issue.sourceIdentity || !issue.sourceId) continue;
      const causeKey = [issue.issueId, issue.sourceIdentity, targetKey(repairTarget)].join('\0');
      const current = causes.get(causeKey);
      if (current && current.method !== method) {
        for (const consumer of consumers) {
          executableKeys.delete(targetKey(consumer));
          blockedTargets.push({
            target: requestedTargets.find((target) => targetKey(target) === targetKey(consumer))!,
            reason: 'taskActionConflict',
            issueIds: [issue.issueId],
          });
        }
        causes.delete(causeKey);
        continue;
      }
      causes.set(causeKey, {
        causeKey,
        issueId: issue.issueId,
        sourceId: issue.sourceId,
        sourceIdentity: issue.sourceIdentity,
        repairTarget,
        method,
        consumers: canonicalTargets([...(current?.consumers ?? []), ...consumers]).map(exactTarget),
        restoreVersionEvidence: restoreIssueVersionEvidence(issue, model)!,
      });
    }
  }
  const finalExecutable = executableTargets.filter((target) => executableKeys.has(targetKey(target)));
  return {
    requestedTargets,
    executableTargets: finalExecutable,
    causes: [...causes.values()].filter((cause) => cause.consumers.some((consumer) =>
      executableKeys.has(targetKey(consumer)))).sort((left, right) =>
      left.causeKey.localeCompare(right.causeKey, 'en')),
    blockedTargets: [...new Map(blockedTargets.map((blocked) => [targetKey(blocked.target), blocked]))
      .values()].sort((left, right) => targetKey(left.target).localeCompare(targetKey(right.target), 'en')),
  };
}

export function pluginWriteTaskTargetKey(
  target: Pick<PluginWriteTaskTarget, 'pluginId' | 'platform' | 'scope'>,
): string {
  return targetKey(target);
}
