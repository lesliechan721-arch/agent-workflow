import crypto from 'node:crypto';

import { canonicalizeIdentityValue, canonicalizePluginConfigValues, getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';

import type { PlatformName, PlatformTarget, PluginConfigValue, Scope } from '../types.js';
import type { OwnedSharedLocator, OwnerIdentity } from '../utils/ownership.js';
import type { ProducerIdentity } from '../types.js';
import type { NativeToolClosure } from '@lesliechan721/aw-plugin-core/manifest';
import type { InstalledCommandSet } from '../utils/managed-command-store.js';
import type { RetainedManagedCommandPackage } from '../utils/managed-command-materialization.js';
import type { DeploymentExclusion, FrozenDeploymentPlan } from '../platforms/contracts.js';

export interface OperationArtifactFile {
  relativePath: string;
  contentBase64: string;
  contentDigest: string;
  mode?: number;
}

export interface OperationPlanEvidence {
  catalogDigests: Array<{ sourceId: string; digest: string }>;
  intentDigests: Array<{ scope: Scope; digest: string }>;
  configDigests: Array<{ pluginId: string; scope: Scope; platform?: PlatformName; digest: string }>;
  targetOwnerFingerprints: Array<{
    pluginId: string;
    platform: PlatformName;
    scope: Scope;
    fingerprint: string;
  }>;
}

import type { NativeToolChange } from '../utils/native-tool-review.js';

export type OperationAction = OperationActionDefinition & { nativeToolChanges?: NativeToolChange[] };

type OperationActionDefinition =
  | (RetainedManagedCommandPackage & {
      kind: 'retainManagedCommandPackage';
      pluginId: string;
      platform?: undefined;
      scope: Scope;
    })
  | {
      kind: 'materializeNativeSkill';
      artifactId?: string;
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      skillKey: string;
      files: OperationArtifactFile[];
      contentDigest: string;
    }
  | {
      kind: 'syncManagedCommandPackage';
      pluginId: string;
      platform?: undefined;
      scope: Scope;
      producer: ProducerIdentity;
      sets: InstalledCommandSet[];
      nativeTools?: NativeToolClosure;
      files: Array<OperationArtifactFile & { mode: number }>;
      contentDigest: string;
    }
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
      kind: 'removePluginConfig';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      path: string;
      fingerprint: string;
    }
  | {
      kind: 'removeActivation';
      pluginId: string;
      platform: 'codex';
      scope: Scope;
      registration: string;
    }
  | {
      kind: 'removeMarketplaceProjection';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      marketplaceRoot: string;
    }
  | {
      kind: 'runPreApply';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      script: string;
      scriptDigest?: string;
    };

export interface OperationPlan {
  deploymentExclusions?: DeploymentExclusion[];
  nativeToolChanges?: NativeToolChange[];
  deploymentPlans?: FrozenDeploymentPlan[];
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

/** One review surface for native declarations carried by packages or platform Skills. */
export function operationPlanNativeToolChanges(plan: Pick<OperationPlan, 'actions' | 'nativeToolChanges'> | undefined): NativeToolChange[] {
  if (!plan) return [];
  const changes = new Map<string, NativeToolChange>();
  for (const change of [...plan.nativeToolChanges ?? [], ...plan.actions.flatMap((action) => action.nativeToolChanges ?? [])]) {
    const key = getCommandPackageId(change.producer);
    const previous = changes.get(key);
    if (previous && canonicalizeIdentityValue(previous) !== canonicalizeIdentityValue(change)) throw new Error('nativeToolPlanConflict: one producer has conflicting frozen changes.');
    changes.set(key, change);
  }
  return [...changes.entries()].sort(([left], [right]) => compareText(left, right)).map(([, change]) => change);
}


export function createOperationPlanConfigDigest(options: {
  pluginId: string;
  scope: Scope;
  platform?: PlatformName;
  effectiveValues: Readonly<Record<string, PluginConfigValue>>;
}): OperationPlanEvidence['configDigests'][number] {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizePluginConfigValues(options.effectiveValues)))
    .digest('hex');
  return {
    pluginId: options.pluginId,
    scope: options.scope,
    ...(options.platform ? { platform: options.platform } : {}),
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
    ...(input.deploymentExclusions?.length ? { deploymentExclusions: canonical(input.deploymentExclusions,
      (entry) => `${entry.platform}:${entry.pluginId}:${entry.scope.kind}:${entry.scope.kind === 'project' ? entry.scope.projectRoot : ''}:${entry.productId}:${entry.reasonCode}`) } : {}),
    ...(input.nativeToolChanges?.length ? { nativeToolChanges: operationPlanNativeToolChanges({ actions: [], nativeToolChanges: input.nativeToolChanges }) } : {}),
    ...(input.deploymentPlans ? { deploymentPlans: canonical(input.deploymentPlans, (plan) => plan.binding.id) } : {}),
    intentChanges: canonical(input.intentChanges, (change) => change.scope),
    actions: [...input.actions],
    changes: [...input.changes].sort(compareText),
    warnings: [...input.warnings].sort(compareText),
    evidence: {
      catalogDigests: canonical(input.evidence.catalogDigests, (entry) => entry.sourceId),
      intentDigests: canonical(input.evidence.intentDigests, (entry) => entry.scope),
      configDigests: canonical(
        input.evidence.configDigests,
        (entry) => `${entry.pluginId}\0${entry.scope}\0${entry.platform ?? ''}`,
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
    .update(JSON.stringify(canonicalInput, (key, value) => key === 'stagingRoot' || key === 'stagingPath' ? undefined : value))
    .digest('hex');
  return { ...canonicalInput, planFingerprint: `sha256:${digest}` };
}

export function createBatchIntentCompatiblePlanFingerprint(
  plan: OperationPlan,
  ignoredTargetKeys: ReadonlySet<string> = new Set(),
): string {
  const targetKey = (target: { pluginId: string; platform?: PlatformTarget; scope: Scope }): string =>
    `${target.pluginId}\0${target.platform}\0${target.scope}`;
  return createOperationPlan({
    deploymentPlans: plan.deploymentPlans?.filter((entry) => !ignoredTargetKeys.has(targetKey({
      pluginId: entry.binding.plugin.pluginId, platform: entry.binding.platform, scope: entry.binding.scope.kind }))),
    deploymentExclusions: plan.deploymentExclusions?.filter((entry) => !ignoredTargetKeys.has(targetKey({
      pluginId: entry.pluginId, platform: entry.platform, scope: entry.scope.kind }))),
    nativeToolChanges: plan.nativeToolChanges?.filter((entry) => !ignoredTargetKeys.has(targetKey({
      pluginId: `${entry.producer.sourceId}/${entry.producer.pluginName}`, platform: entry.producer.platform ?? undefined,
      scope: entry.producer.scope }))),
    intentChanges: plan.intentChanges.map(({ scope }) => ({
      scope,
      beforeDigest: 'batch-intent',
      afterDigest: 'batch-intent',
    })),
    actions: plan.actions.filter((action) => !ignoredTargetKeys.has(targetKey(action))),
    changes: plan.changes.filter((change) => ![...ignoredTargetKeys].some((key) => {
      const [pluginId, platform, scope] = key.split('\0');
      return change.startsWith(`${pluginId}:${platform}:${scope}:`);
    })),
    warnings: plan.warnings,
    evidence: {
      ...plan.evidence,
      intentDigests: plan.evidence.intentDigests.map(({ scope }) => ({
        scope,
        digest: 'batch-intent',
      })),
      targetOwnerFingerprints: plan.evidence.targetOwnerFingerprints.filter((target) =>
        !ignoredTargetKeys.has(targetKey(target))),
    },
  }).planFingerprint;
}

export function assertOperationPlanFingerprint(
  expectedFingerprint: string,
  currentPlan: OperationPlan,
): void {
  if (expectedFingerprint !== currentPlan.planFingerprint) {
    throw new Error('operationPlanStale: the reviewed operation plan changed.');
  }
}
