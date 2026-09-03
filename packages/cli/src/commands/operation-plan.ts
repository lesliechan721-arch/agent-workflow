import crypto from 'node:crypto';

import type { PlatformName, PluginConfigValue, Scope } from '../types.js';
import type { OwnedSharedLocator, OwnerIdentity } from '../utils/ownership.js';

export interface OperationArtifactFile {
  relativePath: string;
  contentBase64: string;
  contentDigest: string;
}

export interface OperationPlanEvidence {
  catalogDigests: Array<{ sourceId: string; digest: string }>;
  intentDigests: Array<{ scope: Scope; digest: string }>;
  configDigests: Array<{ pluginId: string; scope: Scope; digest: string }>;
  targetOwnerFingerprints: Array<{
    pluginId: string;
    platform: PlatformName;
    scope: Scope;
    fingerprint: string;
  }>;
}

export type OperationAction =
  | {
      kind: 'ensureNativeRegistration';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      registration: string;
      marketplaceName?: string;
      marketplaceRoot?: string;
    }
  | {
      kind: 'removeNativeRegistration';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      registration: string;
    }
  | {
      kind: 'setActivation';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      enabled: boolean;
      configPath?: string;
      registration?: string;
    }
  | {
      kind: 'writeOwnedArtifact';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      path: string;
      contentDigest: string;
      content?: string;
      sourceContent?: string;
      owner?: OwnerIdentity;
      allowedRoot?: string;
      artifactKind?: 'owned-text-file' | 'skill-directory';
      files?: OperationArtifactFile[];
      allowPristineUnowned?: boolean;
    }
  | {
      kind: 'updateSharedConfig';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      owner: OwnerIdentity;
      locator: OwnedSharedLocator;
      contentDigest: string;
      mutation:
        | { kind: 'claude-permissions'; permissions: unknown }
        | { kind: 'codex-instruction'; block?: { pluginName: string; value: string } }
        | { kind: 'codex-role-registration'; roleKey: string; configFile: string; description: string }
        | { kind: 'codex-activation'; codexPluginId: string; enabled: boolean };
    }
  | {
      kind: 'removeOwnedArtifact';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      path: string;
      ownerFingerprint: string;
    }
  | {
      kind: 'runPostApply';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      script: string;
      scriptDigest?: string;
    };

export interface OperationPlan {
  intentChanges: Array<{
    scope: Scope;
    beforeDigest: string;
    afterDigest: string;
  }>;
  actions: OperationAction[];
  changes: string[];
  warnings: string[];
  evidence: OperationPlanEvidence;
  planFingerprint: string;
}

export type OperationPlanInput = Omit<OperationPlan, 'planFingerprint'>;

export function createOperationPlanConfigDigest(options: {
  pluginId: string;
  scope: Scope;
  effectiveValues: Readonly<Record<string, PluginConfigValue>>;
}): OperationPlanEvidence['configDigests'][number] {
  const values = Object.entries(options.effectiveValues)
    .sort(([left], [right]) => compareText(left, right));
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
  return {
    pluginId: options.pluginId,
    scope: options.scope,
    digest: `sha256:${digest}`,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareText(key(left), key(right)));
}

function canonicalizeOperationPlanInput(input: OperationPlanInput): OperationPlanInput {
  return {
    intentChanges: canonical(input.intentChanges, (change) => change.scope),
    actions: [...input.actions],
    changes: [...input.changes].sort(compareText),
    warnings: [...input.warnings].sort(compareText),
    evidence: {
      catalogDigests: canonical(input.evidence.catalogDigests, (entry) => entry.sourceId),
      intentDigests: canonical(input.evidence.intentDigests, (entry) => entry.scope),
      configDigests: canonical(
        input.evidence.configDigests,
        (entry) => `${entry.pluginId}\0${entry.scope}`,
      ),
      targetOwnerFingerprints: canonical(
        input.evidence.targetOwnerFingerprints,
        (entry) => `${entry.pluginId}\0${entry.platform}\0${entry.scope}`,
      ),
    },
  };
}

export function createOperationPlan(input: OperationPlanInput): OperationPlan {
  const canonicalInput = canonicalizeOperationPlanInput(input);
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalInput))
    .digest('hex');
  return { ...canonicalInput, planFingerprint: `sha256:${digest}` };
}

export function assertOperationPlanFingerprint(
  expectedFingerprint: string,
  currentPlan: OperationPlan,
): void {
  if (expectedFingerprint !== currentPlan.planFingerprint) {
    throw new Error('operationPlanStale: the reviewed operation plan changed.');
  }
}
