import type { Scope } from '../types.js';
import type { AgentId, PreferencesObservation } from '../intent/deployment-preferences.js';
import type { IntentObservation } from '../intent/intent-store.js';

export type Delivery =
  | { kind: 'native'; platform: 'codex' | 'claude' }
  | { kind: 'agent-skills'; provider: 'skills-cli'; agentId: AgentId };

export type Execution = 'not-run' | 'no-op' | 'applied' | 'partial' | 'failed';
export type Observation = 'verified' | 'missing' | 'unknown';
export type ContentState = 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
export interface Diagnostic { code: string; message: string }

export interface TargetKey { pluginId: string; agent: AgentId; scope: Scope }
export interface TargetResult extends TargetKey {
  delivery: Delivery | null;
  execution: Execution;
  observation: Observation;
  content?: ContentState;
  blockers: Diagnostic[];
  requiredBy: string[];
  recoveryActions?: string[];
  backend?: unknown;
}

export interface RecoveryReceiptV1 {
  schemaVersion: 1;
  kind: 'aw-recovery';
  scope: Scope;
  command: string;
  ok: boolean;
  intent: { state: IntentObservation['state']; digest?: string; roots: string[] | null };
  requestedTargets: TargetKey[];
  selection: { agents: AgentId[]; origin: 'argument' | 'preference' | 'none' };
  blockers: Diagnostic[];
  errors: Diagnostic[];
  targetResults: TargetResult[];
  remainingTargets: TargetKey[];
  recoveryActions: string[];
  declarationChanged: boolean;
  preferencesChanged: boolean;
  configChanged: boolean;
  outputsMayHaveChanged: boolean;
}

export interface RecoveryStatusV1 {
  schemaVersion: 1;
  kind: 'aw-recovery-status';
  scope: Scope;
  ok: boolean;
  intent: { state: IntentObservation['state']; digest?: string };
  selection: {
    agents: AgentId[];
    origin: 'argument' | 'preference' | 'none';
    preferences: PreferencesObservation['state'];
  };
  inventory: Array<{
    pluginId: string;
    source: string;
    sourceState: string;
    blockers: Diagnostic[];
    targetResults: TargetResult[];
  }> | null;
  extraObserved: unknown[];
  coverage: unknown;
  counts: unknown;
  allSatisfied: boolean | null;
  errors: Diagnostic[];
}
