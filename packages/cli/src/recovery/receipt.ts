import type { NativeToolChange } from '../utils/native-tool-review.js';
import type { CommandProducerResult, Scope } from '../types.js';
import type { AgentId } from '../intent/deployment-preferences.js';
import type { IntentObservation } from '../intent/intent-store.js';
import type { Delivery } from './types.js';
import type { DeploymentObservation, DeploymentReceipt, DeploymentExclusion, FrozenDeploymentPlan, ProductInstallation } from '../platforms/contracts.js';

import type { PortableComponentGap } from '../portable/recovery.js';

export interface RecoveryDiagnostic {
  code: string; message: string; pluginId?: string;
  subject?: import('../output/public-result.js').Diagnostic['subject'];
  detail?: import('../output/public-result.js').Diagnostic['detail'];
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
  satisfaction?: 'installed' | 'inherited-user' | 'unsupported' | 'excluded' | 'pending' | 'unknown';
  recoveryActions?: string[];
  backend?: unknown;
  componentGaps?: PortableComponentGap[];
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
}

type RecoveryPosition = Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope'>;

export function canRetryRecoveryRootWithCli(receipt: RecoveryReceipt, position: RecoveryPosition): boolean {
  // A Project sync also visits the User declaration for that same plugin and Agent.
  return position.scope !== 'project' || !receipt.targetResults.some((item) => item.scope === 'user'
    && item.pluginId === position.pluginId && item.agent === position.agent && item.observation === 'verified'
    && !item.blockers.length && (item.execution === 'applied' || item.execution === 'no-op')
    && item.satisfaction !== 'excluded' && item.satisfaction !== 'unsupported');
}

export function recoveryRetryTargets(receipt: RecoveryReceipt, targets: readonly RecoveryTarget[]): RecoveryPosition[] {
  if (receipt.unconfirmedSavedState || isRecoveryReviewStaleBeforeExecution(receipt)) return [];
  const positions = new Map<string, RecoveryPosition>();
  for (const target of targets) {
    const roots = target.relation === 'dependency' && (receipt.command === 'sync' || receipt.command === 'install')
      ? receipt.targetResults.filter((root) => root.agent === target.agent && receipt.requestedRoots.includes(root.pluginId)
        && root.relation !== 'dependency' && (target.contributions
          ? target.contributions.some((item) => item.root === root.pluginId && item.scope === root.scope)
          : target.requiredBy.includes(root.pluginId) && root.scope === (target.requirementScope ?? target.scope))
        && receipt.remainingTargets.some((item) => item.pluginId === root.pluginId && item.agent === root.agent && item.scope === root.scope))
      : [target];
    for (const { pluginId, agent, scope } of roots) positions.set([pluginId, agent, scope].join('\0'), { pluginId, agent, scope });
  }
  return [...positions.values()];
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
