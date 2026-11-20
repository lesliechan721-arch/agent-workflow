import type { Scope } from '../types.js';
import { addRequirements, intentAdd, intentRemove } from '../commands/intent-command.js';
import { calculateIntentDigest, canonicalPluginId } from '../intent/intent-codec.js';
import { observeIntent, resolveIntentPath,
  type IntentLocation, type IntentObservation } from '../intent/intent-store.js';
import { normalizeAgents, observePreferences, resetTargets, setAgents,
  resolvePreferencesPath, type AgentId, type PreferencesLocation,
  type PreferencesObservation } from '../intent/deployment-preferences.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import type { RecoveryPlan } from '../recovery/coordinator.js';
import type { RetirePlan } from '../recovery/retirement.js';
import { isRecoveryReviewStaleBeforeExecution, recoveryRetryDispositions, recoveryStatusContext,
  recoverySummaryErrors, type RecoveryReceipt, type RecoveryTarget } from '../recovery/receipt.js';
import { projectComponentDeliveryHistory, projectDeliveryNoticeHistory, projectSkillInvocationHistory } from './diagnostic-projection.js';
import { projectDeploymentNotices } from '../commands/public-lifecycle-result.js';
import { safeDiagnosticCode } from './diagnostics.js';
import { recoveryReason } from './glossary.js';
import type { OperationHistoryRecord, OperationHistoryTarget, SafeOperationDiagnostic } from './operation-history.js';

export interface TargetsPlan {
  kind: 'targets';
  scope: Scope;
  action: 'set' | 'reset';
  agents: AgentId[];
  previousAgents: AgentId[];
  overrideCount: number;
  expected: PreferencesObservation;
  canonicalPath: string;
  changes: string[];
  warnings: string[];
}

export interface IntentPlan {
  kind: 'intent'; scope: Scope; action: 'add' | 'remove'; selector: string;
  expected: IntentObservation; canonicalPath: string; proposedDigest?: string;
  changes: string[]; warnings: string[];
}

export type ScopedTuiPlan = { kind: 'recovery'; scope: Scope; plan: RecoveryPlan }
  | { kind: 'retire'; scope: Scope; plan: RetirePlan } | TargetsPlan | IntentPlan;

function nativePermissionCodes(target: RecoveryTarget): string[] {
  if (target.agent !== 'grok') return [];
  const diagnostics = [...target.blockers, ...target.reasons ?? [], ...(target.deploymentReceipts ?? []).flatMap((item) =>
    [...item.diagnostics, ...item.effects.flatMap((effect) => effect.diagnostics)])];
  return diagnostics.filter(({ subject }) => subject?.field === 'nativeSource' && subject.pluginId === target.pluginId
    && subject.target === target.agent && subject.scope === target.scope).map(({ code }) => code);
}

export function projectScopedRecoveryHistory(receipt: RecoveryReceipt,
  identity: Pick<OperationHistoryRecord['summary'], 'recordId' | 'epoch' | 'operationId' | 'createdAtMs'>,
): OperationHistoryRecord {
  const diagnostics: SafeOperationDiagnostic[] = [];
  const componentDiagnostics: SafeOperationDiagnostic[] = [];
  const notices = projectDeploymentNotices(receipt.targetResults);
  const advisoryDiagnostics = [...projectSkillInvocationHistory(notices, identity.recordId, 'execute'),
    ...projectDeliveryNoticeHistory(notices, identity.recordId, 'execute')];
  const addDiagnostic = (rawCode: string, target?: SafeOperationDiagnostic['target'], detailLines: string[] = []) => {
    const code = safeDiagnosticCode(rawCode, 'recoveryFailed');
    const id = `${identity.recordId}:diagnostic:${diagnostics.length}`;
    diagnostics.push({ id, code, stage: 'execute', safeMessage: recoveryReason(code),
      target, causes: [], detailLines });
    return id;
  };
  const staleBeforeExecution = isRecoveryReviewStaleBeforeExecution(receipt);
  const targetWorkNotStarted = staleBeforeExecution || Boolean(receipt.unconfirmedSavedState);
  const checkStatus = `aw plugin status --context ${recoveryStatusContext(receipt)} --json`;
  const globalIds = new Map<string, string>();
  for (const code of new Set([...receipt.blockers, ...recoverySummaryErrors(receipt)].map((entry) => entry.code))) {
    const details = receipt.unconfirmedSavedState || code === 'statusUnavailable' ? [checkStatus] : [];
    globalIds.set(code, addDiagnostic(code, undefined, details));
  }
  for (const result of receipt.commandResults ?? []) {
    for (const error of result.errors) addDiagnostic(error.code);
  }
  const targets = receipt.targetResults.map((entry, index): OperationHistoryTarget => {
    const target = { pluginId: entry.pluginId, platform: entry.agent, scope: entry.scope };
    const state = entry.execution === 'failed' || entry.execution === 'partial' ? 'failed'
      : entry.satisfaction === 'unsupported' || entry.satisfaction === 'excluded' || entry.satisfaction === 'not-applicable' ? 'skipped'
      : entry.execution === 'not-run' ? 'skipped'
        : entry.blockers.length > 0 || entry.observation !== 'verified' ? 'failed'
          : entry.execution === 'applied' ? 'completed' : entry.execution === 'no-op' ? 'kept' : 'failed';
    const remaining = !targetWorkNotStarted && receipt.remainingTargets.some((position) => position.pluginId === entry.pluginId
      && position.agent === entry.agent && position.scope === entry.scope);
    const permissionCodes = remaining ? nativePermissionCodes(entry) : [];
    const diagnosticIds = [...new Set([...entry.blockers.map((blocker) => blocker.code), ...permissionCodes])]
      .map((code) => {
        const globalId = targetWorkNotStarted && globalIds.get(code);
        if (globalId) return globalId;
        const details: string[] = [];
        const permission = permissionCodes.includes(code);
        const stale = code === 'operationReviewStale' && (receipt.command === 'install' || receipt.command === 'sync');
        const retry = remaining && entry.execution === 'failed' && (entry.observation === 'missing' || entry.content === 'absent');
        if (remaining || stale) details.push(checkStatus);
        if (permission || stale || retry) {
          if (permission) details.push('从插件详情重新审阅安装位置。打开结果详情，在同一 Grok 客户端核对来源并完成信任步骤。');
          // Store reviewable commands from structured positions only. Backend prose may contain private data.
          for (const position of recoveryRetryDispositions(receipt, [entry])) {
            try {
              const root = canonicalPluginId(position.pluginId);
              if (permission) {
                const alsoUser = position.scope === 'project' && position.kind === 'cli' && receipt.remainingTargets.some((item) =>
                  item.pluginId === root && item.agent === position.agent && item.scope === 'user');
                const scope = alsoUser ? '个人和项目' : position.scope === 'user' ? '个人' : '项目';
                details.push(`在 TUI 中重新检查 ${root} 的 ${position.agent} ${scope}位置。`);
              } else details.push(position.kind === 'cli'
                ? `aw plugin sync ${root} --context ${position.scope} --target ${position.agent}`
                : `在 TUI 中重新检查 ${root} 的 ${position.agent} 项目位置。`);
            } catch { /* An invalid identity cannot be offered as a command. */ }
          }
        }
        return addDiagnostic(code, target, details);
      });
    const advisories = advisoryDiagnostics.filter((diagnostic) => diagnostic.target?.pluginId === target.pluginId
      && diagnostic.target.platform === target.platform && diagnostic.target.scope === target.scope);
    const delivery = projectComponentDeliveryHistory(entry, advisories, `${identity.recordId}:${index}`, 'execute',
      state === 'completed' || state === 'kept' || state === 'skipped' && entry.satisfaction === 'not-applicable' && !entry.blockers.length);
    componentDiagnostics.push(...delivery.diagnostics);
    diagnosticIds.push(...[...advisories, ...delivery.diagnostics].map(({ id }) => id));
    return { ...target, state, diagnosticIds,
      ...(delivery.facts ? { componentDelivery: delivery.facts } : {}),
      ...(entry.execution === 'partial' && (entry.installedComponentCount ?? 0) > 0 ? { partialDelivery: true } : {}),
      ...(entry.blockers[0] ? { errorCode: safeDiagnosticCode(entry.blockers[0].code, 'recoveryFailed') } : {}) };
  });
  const verified = targets.some(({ state }) => state === 'completed' || state === 'kept');
  const changed = receipt.configChanged || receipt.declarationChanged || receipt.preferencesChanged || receipt.outputsMayHaveChanged;
  const state = receipt.ok ? 'succeeded' : verified || changed ? 'partial' : 'blocked';
  return {
    summary: {
      ...identity,
      state, operationKind: 'pluginWriteBatch',
      code: receipt.ok ? 'operationSucceeded' : diagnostics[0]?.code ?? 'recoveryFailed',
      message: receipt.ok ? '批量恢复已完成。' : staleBeforeExecution ? recoveryReason('operationReviewStale')
        : receipt.unconfirmedSavedState ? '保存后的内容需要重新检查，平台目标尚未执行。' : '批量恢复仍有目标未完成。',
      diagnosticCount: diagnostics.length + advisoryDiagnostics.length + componentDiagnostics.length,
      effects: {
        configCommit: receipt.configChanged ? 'completed' : 'notApplicable',
        awWrite: receipt.outputsMayHaveChanged ? 'possible' : targetWorkNotStarted ? 'notStarted' : 'notApplicable',
        preApplyExternalEffect: targetWorkNotStarted ? 'notStarted' : 'unknown',
        finalVerification: receipt.ok ? 'completed' : verified ? 'partial' : targetWorkNotStarted ? 'notStarted' : 'unknown',
      },
    },
    diagnostics: [...diagnostics, ...componentDiagnostics, ...advisoryDiagnostics],
    targets,
  };
}

const intentPath = async (location: IntentLocation): Promise<string> =>
  canonicalizePathThroughExistingAncestor(await resolveIntentPath(location));
const preferencesPath = async (location: PreferencesLocation): Promise<string> =>
  canonicalizePathThroughExistingAncestor(await resolvePreferencesPath(location));

export async function prepareIntentPlan(location: IntentLocation, action: 'add' | 'remove',
  selector: string): Promise<IntentPlan> {
  const canonicalPath = await intentPath(location);
  const expected = await observeIntent(location);
  if (expected.state !== 'valid' && expected.state !== 'absent') throw new Error('pluginIntentStateInvalid');
  if (action === 'remove' && (expected.state === 'absent'
    || !expected.value.roots.some((root) => root.pluginId === selector))) {
    throw new Error('pluginIntentRootMissing');
  }
  const proposed = action === 'add'
    ? await addRequirements({ ...location, selectors: [selector], dryRun: true }) : undefined;
  if (proposed?.errors.length || action === 'add' && !proposed?.state) {
    throw new Error(proposed?.errors[0]?.code ?? 'pluginIntentAddUnavailable');
  }
  if (await intentPath(location) !== canonicalPath) throw new Error('operationReviewStale');
  return { kind: 'intent', scope: location.scope, action, selector, expected, canonicalPath,
    ...(proposed?.state ? { proposedDigest: calculateIntentDigest(proposed.state) } : {}),
    changes: [action === 'add' ? `声明插件需求：${selector}` : `移除插件需求：${selector}`],
    warnings: action === 'remove' ? ['只修改需求声明；已有安装内容会保留。'] : ['只修改需求声明；不会安装插件。'],
  };
}

export async function executeIntentPlan(location: IntentLocation, plan: IntentPlan): Promise<RecoveryReceipt> {
  if (location.scope !== plan.scope) throw new Error('operationReviewStale');
  return withAwHomeMutationLock({ env: location.env, action: async (token) => {
    if (await intentPath(location) !== plan.canonicalPath) throw new Error('operationReviewStale');
    const current = await observeIntent(location);
    if (current.state !== plan.expected.state || ('rawDigest' in current ? current.rawDigest : undefined)
      !== ('rawDigest' in plan.expected ? plan.expected.rawDigest : undefined)
      || await intentPath(location) !== plan.canonicalPath) {
      throw new Error('operationReviewStale');
    }
    if (plan.action === 'add') {
      const proposed = await addRequirements({ ...location, token, selectors: [plan.selector], dryRun: true });
      if (proposed.errors.length || !proposed.state
        || calculateIntentDigest(proposed.state) !== plan.proposedDigest
        || await intentPath(location) !== plan.canonicalPath) {
        throw new Error('operationReviewStale');
      }
      return intentAdd({ ...location, token, selectors: [plan.selector] });
    }
    return intentRemove({ ...location, token, selector: plan.selector });
  } });
}

function sameObservation(left: PreferencesObservation, right: PreferencesObservation): boolean {
  return left.state === right.state && ('rawDigest' in left ? left.rawDigest : undefined)
    === ('rawDigest' in right ? right.rawDigest : undefined);
}

export async function prepareTargetsPlan(
  location: PreferencesLocation,
  action: 'set' | 'reset',
  agents: readonly string[],
): Promise<TargetsPlan> {
  const canonicalPath = await preferencesPath(location);
  const expected = await observePreferences(location);
  if (expected.state === 'unreadable' || action === 'set' && expected.state === 'invalid') {
    throw new Error('deploymentPreferencesUnavailable');
  }
  const previousAgents = expected.state === 'valid' ? expected.value.targets : [];
  const overrideCount = expected.state === 'valid' ? expected.value.exclusions.length : 0;
  const nextAgents = action === 'reset' ? [] : normalizeAgents(agents);
  if (await preferencesPath(location) !== canonicalPath) throw new Error('operationReviewStale');
  return {
    kind: 'targets', scope: location.scope, action, agents: nextAgents, previousAgents,
    overrideCount, expected, canonicalPath,
    changes: action === 'reset'
      ? ['清空本机工具选择', `清空 ${overrideCount} 项插件排除`]
      : [`本机工具：${previousAgents.join('、') || '未选择'} → ${nextAgents.join('、') || '未选择'}`,
        '保留已有插件排除'],
    warnings: [],
  };
}

export async function executeTargetsPlan(location: PreferencesLocation, plan: TargetsPlan): Promise<{
  changed: boolean; agents: AgentId[];
}> {
  if (location.scope !== plan.scope) throw new Error('operationReviewStale');
  return withAwHomeMutationLock({ env: location.env, action: async (token) => {
    if (await preferencesPath(location) !== plan.canonicalPath) throw new Error('operationReviewStale');
    const current = await observePreferences(location);
    if (!sameObservation(plan.expected, current)
      || await preferencesPath(location) !== plan.canonicalPath) throw new Error('operationReviewStale');
    const saved = plan.action === 'reset'
      ? await resetTargets({ ...location, token })
      : await setAgents({ ...location, token }, plan.agents);
    return { changed: saved.changed, agents: saved.value.targets };
  } });
}
