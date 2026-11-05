import type { NativeToolChange } from '../utils/native-tool-review.js';
import type { CommandProducerResult, Scope } from '../types.js';
import type { AgentId } from '../intent/deployment-preferences.js';
import type { IntentObservation } from '../intent/intent-store.js';

export interface RecoveryDiagnostic { code: string; message: string; pluginId?: string }
export type RecoveryDelivery =
  | { kind: 'native'; platform: 'codex' | 'claude' }
  | { kind: 'agent-skills'; provider: 'aw'; agentId: string };
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
  relation?: 'root' | 'dependency' | 'residue';
  requirementScope?: Scope;
  providerScope?: Scope;
  satisfaction?: 'installed' | 'inherited-user' | 'unsupported' | 'excluded' | 'pending' | 'unknown';
  recoveryActions?: string[];
  backend?: unknown;
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
}
