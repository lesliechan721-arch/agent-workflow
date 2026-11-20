import type { NativeToolChange } from '../utils/native-tool-review.js';
import type { CommandProducerResult, Scope } from '../types.js';
import type { AgentId } from '../intent/deployment-preferences.js';
import type { IntentObservation } from '../intent/intent-store.js';
import type { Delivery } from './types.js';
import type { DeploymentObservation, DeploymentReceipt, DeploymentExclusion, FrozenDeploymentPlan, ProductInstallation, RenderUnit } from '../platforms/contracts.js';

import type { ComponentUnmet } from '@lesliechan721/aw-plugin-core/manifest';

export interface RecoveryComponentGap extends ComponentUnmet {
  providerPluginId: string;
  agent: AgentId;
  renderScope: Scope;
}

export function scopeNativeComponentGaps(gaps: readonly ComponentUnmet[], target: RecoveryPosition,
  renderUnits: readonly RenderUnit[] = []): RecoveryComponentGap[] {
  return gaps.map((gap) => ({
    ...gap, providerPluginId: target.pluginId, agent: target.agent,
    renderScope: renderUnits.find((unit) => unit.kinds.includes(gap.kind))?.renderScope.kind ?? target.scope,
  }));
}

export function uniqueRecoveryComponentGaps(gaps: readonly RecoveryComponentGap[]): RecoveryComponentGap[] {
  return [...new Map(gaps.map((gap) => [JSON.stringify([
    gap.providerPluginId, gap.agent, gap.renderScope, gap.id, gap.reasonCode, gap.requiredFeatures,
  ]), gap])).values()];
}

export interface RecoveryDiagnostic {
  code: string; message: string; pluginId?: string;
  subject?: import('../output/public-result.js').Diagnostic['subject'];
  detail?: import('../output/public-result.js').Diagnostic['detail'];
}
export function retainedOutputDiagnostic(pluginId: string, agent: AgentId, scope: Scope, path: string, field?: string): RecoveryDiagnostic {
  return { code: 'previousDeploymentRetained', message: 'Previous output was retained and may still be active.',
    subject: { pluginId, target: agent, scope, ...(field ? { field } : {}) }, detail: { reasonCode: 'previousDeploymentRetained', path } };
}
export type RecoveryDelivery = Delivery;
export interface RecoveryTarget {
  pluginId: string;
  agent: AgentId;
  scope: Scope;
  delivery: RecoveryDelivery | null;
  execution: 'not-run' | 'no-op' | 'applied' | 'partial' | 'failed';
  observation: 'verified' | 'missing' | 'unknown';
  content?: 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
  blockers: RecoveryDiagnostic[];
  reasons?: RecoveryDiagnostic[];
  requiredBy: string[];
  /** Current read-only requirement paths. scope is the root demand; target.scope is the actual provider. */
  contributions?: Array<{ root: string; scope: Scope; path: string[] }>;
  expectedVersion?: string;
  installedVersion?: string;
  relation?: 'root' | 'dependency' | 'residue';
  requirementScope?: Scope;
  providerScope?: Scope;
  satisfaction?: 'installed' | 'inherited-user' | 'not-applicable' | 'unsupported' | 'excluded' | 'pending' | 'unknown';
  recoveryActions?: string[];
  backend?: unknown;
  componentGaps?: RecoveryComponentGap[];
  installedComponentCount?: number;
  installedComponentIds?: string[];
  deploymentExclusions?: DeploymentExclusion[];
  deploymentPlans?: FrozenDeploymentPlan[];
  deploymentReceipts?: Array<DeploymentReceipt & { products: ProductInstallation[] }>;
  deploymentObservations?: Array<{ bindingId: string; products: ProductInstallation[]; after: DeploymentObservation }>;
}
export interface RecoveryReceipt {
  schemaVersion: 1;
  kind: 'aw-recovery';
  scope: Scope;
  command: string;
  coverage?: { scopes: Scope[]; projectRoot?: string };
  allSatisfied?: boolean | null;
  inSync?: boolean | null;
  ok: boolean;
  intent: { state: IntentObservation['state']; digest?: string; roots: string[] | null };
  requestedRoots: string[];
  requestedTargets: Array<{ pluginId: string; agent: AgentId; scope: Scope; delivery: RecoveryDelivery | null }>;
  selection: { agents: AgentId[]; origin: 'argument' | 'preference' | 'none'; preferences: string };
  blockers: RecoveryDiagnostic[];
  errors: RecoveryDiagnostic[];
  targetResults: RecoveryTarget[];
  commandResults?: CommandProducerResult[];
  nativeToolChanges?: NativeToolChange[];
  remainingTargets: Array<{ pluginId: string; agent: AgentId; scope: Scope; delivery: RecoveryDelivery | null }>;
  recoveryActions: string[];
  declarationChanged: boolean;
  preferencesChanged: boolean;
  configChanged: boolean;
  outputsMayHaveChanged: boolean;
  /** A strong-state write returned, but the saved value could not be confirmed before deployment. */
  unconfirmedSavedState?: 'intent' | 'preferences';
  /** Requested roots also declared at User scope in this Review. null means unreadable. */
  reviewedUserRoots?: string[] | null;
  /** A public sync --rebuild selects declared roots; an internal update may select the dependency itself. */
  rebuildsRequestedRoots?: true;
}

type RecoveryPosition = Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope'>;

export function recoveryStatusContext(receipt: RecoveryReceipt): Scope {
  if (!receipt.coverage) return receipt.scope;
  return receipt.coverage.scopes.includes('project') ? 'project' : 'user';
}

export function retriesFromRequestedRoots(receipt: RecoveryReceipt): boolean {
  return receipt.command === 'install' || receipt.command === 'sync' || receipt.rebuildsRequestedRoots === true;
}

export function recoveryRetryTargets(receipt: RecoveryReceipt, targets: readonly RecoveryTarget[]): RecoveryPosition[] {
  if (receipt.unconfirmedSavedState || isRecoveryReviewStaleBeforeExecution(receipt)) return [];
  const positions = new Map<string, RecoveryPosition>();
  for (const target of targets) {
    const needsRequestedRoot = retriesFromRequestedRoots(receipt)
      && (target.relation === 'dependency' || !receipt.requestedRoots.includes(target.pluginId));
    const roots = needsRequestedRoot
      ? receipt.targetResults.filter((root) => root.agent === target.agent && receipt.requestedRoots.includes(root.pluginId)
        && root.relation !== 'dependency' && (target.contributions
          ? target.contributions.some((item) => item.root === root.pluginId && item.scope === root.scope)
          : target.relation === 'dependency' && target.requiredBy.includes(root.pluginId)
            && root.scope === (target.requirementScope ?? target.scope))
        && receipt.remainingTargets.some((item) => item.pluginId === root.pluginId && item.agent === root.agent && item.scope === root.scope))
      : [target];
    for (const { pluginId, agent, scope } of roots) positions.set([pluginId, agent, scope].join('\0'), { pluginId, agent, scope });
  }
  return [...positions.values()];
}

export type RecoveryRetryDisposition = RecoveryPosition & { kind: 'cli' | 'exact-project' };

export function recoveryRootDisposition(root: RecoveryPosition, bothPending: boolean, userMayBeVisited: boolean): RecoveryRetryDisposition {
  const scope = bothPending ? 'project' : root.scope;
  return { ...root, scope, kind: scope === 'project' && !bothPending && userMayBeVisited ? 'exact-project' : 'cli' };
}

/** A Project CLI sync also visits the same root and Agent in User scope. */
export function recoveryRetryDispositions(receipt: RecoveryReceipt, targets: readonly RecoveryTarget[]): RecoveryRetryDisposition[] {
  const actions = new Map<string, RecoveryRetryDisposition>();
  for (const root of recoveryRetryTargets(receipt, targets)) {
    const pending = (scope: Scope) => receipt.remainingTargets.some((item) =>
      item.pluginId === root.pluginId && item.agent === root.agent && item.scope === scope);
    if (!pending(root.scope)) continue;
    const otherScope = root.scope === 'user' ? 'project' : 'user';
    const both = pending(otherScope) && receipt.targetResults.some((item) =>
      item.pluginId === root.pluginId && item.agent === root.agent && item.scope === otherScope && item.relation === 'root');
    const userMayBeVisited = retriesFromRequestedRoots(receipt)
      ? receipt.reviewedUserRoots?.includes(root.pluginId) !== false
      : receipt.targetResults.some((item) => item.pluginId === root.pluginId && item.agent === root.agent && item.scope === 'user'
        && item.observation === 'verified' && !item.blockers.length && (item.execution === 'applied' || item.execution === 'no-op')
        && item.satisfaction !== 'excluded' && item.satisfaction !== 'unsupported');
    const action = recoveryRootDisposition(root, both, userMayBeVisited);
    actions.set([root.pluginId, root.agent, action.scope].join('\0'), action);
  }
  return [...actions.values()];
}

export function isRecoveryReviewStaleBeforeExecution(receipt: RecoveryReceipt): boolean {
  return receipt.blockers.some(({ code }) => code === 'operationReviewStale')
    && !receipt.unconfirmedSavedState && !receipt.configChanged && !receipt.declarationChanged && !receipt.preferencesChanged
    && !receipt.outputsMayHaveChanged && !receipt.commandResults?.length
    && receipt.targetResults.every((target) => target.execution === 'not-run'
      || target.execution === 'no-op' && (target.satisfaction === 'excluded' || target.satisfaction === 'unsupported'));
}

/** Joint receipts also collect child errors. A localized stale reason already has a target. */
export function recoverySummaryErrors(receipt: RecoveryReceipt): RecoveryDiagnostic[] {
  if (!receipt.errors.some(({ code }) => code === 'operationReviewStale')
    || receipt.blockers.some(({ code }) => code === 'operationReviewStale')) return receipt.errors;
  const localized = new Set(receipt.targetResults.flatMap((target) => target.blockers
    .filter(({ code }) => code === 'operationReviewStale').map((blocker) => JSON.stringify(blocker))));
  return receipt.errors.filter((error) => error.code !== 'operationReviewStale' || !localized.has(JSON.stringify(error)));
}
