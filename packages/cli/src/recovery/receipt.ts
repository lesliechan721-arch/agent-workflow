import type { Scope } from '../types.js';
import type { AgentId } from '../intent/deployment-preferences.js';
import type { IntentObservation } from '../intent/intent-store.js';

export interface RecoveryDiagnostic { code: string; message: string; pluginId?: string }
export type RecoveryDelivery =
  | { kind: 'native'; platform: 'codex' | 'claude' }
  | { kind: 'agent-skills'; provider: 'skills-cli'; agentId: string };
export interface RecoveryTarget {
  pluginId: string;
  agent: AgentId;
  scope: Scope;
  delivery: RecoveryDelivery | null;
  execution: 'not-run' | 'no-op' | 'applied' | 'partial' | 'failed';
  observation: 'verified' | 'missing' | 'unknown';
  content?: 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
  blockers: RecoveryDiagnostic[];
  requiredBy: string[];
  relation?: 'root' | 'dependency' | 'residue';
  recoveryActions?: string[];
  backend?: unknown;
}
export interface RecoveryReceipt {
  schemaVersion: 1;
  kind: 'aw-recovery';
  scope: Scope;
  command: string;
  ok: boolean;
  intent: { state: IntentObservation['state']; digest?: string; roots: string[] | null };
  requestedRoots: string[];
  requestedTargets: Array<{ pluginId: string; agent: AgentId; scope: Scope; delivery: RecoveryDelivery | null }>;
  selection: { agents: AgentId[]; origin: 'argument' | 'preference' | 'none'; preferences: string };
  blockers: RecoveryDiagnostic[];
  errors: RecoveryDiagnostic[];
  targetResults: RecoveryTarget[];
  remainingTargets: Array<{ pluginId: string; agent: AgentId; scope: Scope; delivery: RecoveryDelivery | null }>;
  recoveryActions: string[];
  declarationChanged: boolean;
  preferencesChanged: boolean;
  configChanged: boolean;
  outputsMayHaveChanged: boolean;
}
