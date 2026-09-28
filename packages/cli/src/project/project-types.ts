import type { ProjectAgentId, ProjectPreferencesObservation } from './project-preferences.js';
import type { ProjectIntentObservation } from './project-state.js';

export type ProjectDelivery =
  | { kind: 'native'; platform: 'codex' | 'claude' }
  | { kind: 'agent-skills'; provider: 'skills-cli'; agentId: string };

export type ProjectExecution = 'not-run' | 'no-op' | 'applied' | 'partial' | 'failed';
export type ProjectObservation = 'verified' | 'missing' | 'unknown';

export interface ProjectDiagnostic {
  code: string;
  message: string;
}

export interface ProjectTargetResult {
  pluginId: string;
  agent: ProjectAgentId;
  delivery: ProjectDelivery | null;
  execution: ProjectExecution;
  observation: ProjectObservation;
  content?: 'absent' | 'satisfied' | 'drifted' | 'conflict' | 'unknown';
  blockers: ProjectDiagnostic[];
  requiredBy: string[];
  recoveryActions?: string[];
  backend?: unknown;
}

export interface ProjectStatusV1 {
  schemaVersion: 1;
  kind: 'aw-project-status';
  ok: boolean;
  intent: {
    state: ProjectIntentObservation['state'];
    digest?: string;
  };
  selection: {
    agents: ProjectAgentId[];
    origin: 'argument' | 'preference' | 'none';
    preferences: ProjectPreferencesObservation['state'];
  };
  inventory: Array<{
    pluginId: string;
    source: string;
    sourceState: string;
    blockers: ProjectDiagnostic[];
    targetResults: ProjectTargetResult[];
  }> | null;
  allSatisfied: boolean | null;
  errors: ProjectDiagnostic[];
}

export interface ProjectRecoveryReceiptV1 {
  schemaVersion: 1;
  kind: 'aw-project-recovery';
  command: string;
  ok: boolean;
  intent: {
    state: ProjectIntentObservation['state'];
    digest?: string;
    roots: string[] | null;
  };
  requestedRoots: string[];
  selection: {
    agents: ProjectAgentId[];
    origin: 'argument' | 'preference' | 'none';
  };
  blockers: ProjectDiagnostic[];
  targetResults: ProjectTargetResult[];
  remainingTargets: Array<{ pluginId: string; agent: ProjectAgentId }>;
  recoveryActions: string[];
  declarationChanged: boolean;
  preferencesChanged: boolean;
  outputsMayHaveChanged: boolean;
}
