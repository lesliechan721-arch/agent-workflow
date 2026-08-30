import crypto from 'node:crypto';

import { getCodexOperationRequirement } from './agent-version.js';
import type { CodexSharedNativeState } from './codex-shared-native.js';
import type {
  CodexSurfaceAnalysis,
  CodexSurfaceComponent,
} from './codex-surface-analysis.js';
import type { PluginIntentState } from './plugin-intent-state.js';
import type { CodexOperationRequirement, Scope } from '../types.js';

export type CodexReconcileOperation =
  | 'install'
  | 'uninstall'
  | 'upgrade'
  | 'reinstall'
  | 'cleanup'
  | 'sync';

export type CodexSharedNativeAction =
  | 'reuse'
  | 'claim'
  | 'install'
  | 'replace'
  | 'repair'
  | 'none';

export type CodexActivationAction = 'enable' | 'disable' | 'remove' | 'none';

export interface CodexReconcilerCatalogTarget {
  pluginId: string;
  pluginName: string;
  codexPluginId: string;
  version: string;
  payloadDigest: string;
  relation: 'requested' | 'dependency';
  resolvedScope: Scope;
  desiredScopes?: Scope[];
  intentScopes?: Scope[];
  surface: CodexSurfaceAnalysis;
}

export type CodexLiveExtensionState = 'absent' | 'present' | 'drifted' | 'foreign';

export interface CodexReconcilerLiveEvidence {
  codexPluginId: string;
  sharedNative: CodexSharedNativeState;
  sharedNativePayloadDigest?: string;
  sharedNativePayloadPath?: string;
  repairableSharedNative?: boolean;
  activations: {
    user?: boolean;
    project?: boolean;
  };
  extensions?: Array<{
    componentKey: string;
    scope: Scope;
    state: CodexLiveExtensionState;
    owner?: string;
  }>;
  projectionDigest?: string;
}

export interface CodexReconcilerInput {
  scope: Scope;
  cwd: string;
  operation: CodexReconcileOperation;
  intentBefore: PluginIntentState;
  intentAfter: PluginIntentState;
  relatedIntentBefore?: PluginIntentState;
  relatedIntentAfter?: PluginIntentState;
  catalogClosure: CodexReconcilerCatalogTarget[];
  liveEvidence: CodexReconcilerLiveEvidence[];
  activationSupport?: 'observed' | 'assumed';
}

export interface CodexSharedNativePlanAction {
  pluginId: string;
  codexPluginId: string;
  action: CodexSharedNativeAction;
  desiredVersion: string;
  affectsOtherScopes: boolean;
}

export interface CodexActivationPlanAction {
  pluginId: string;
  codexPluginId: string;
  scope: Scope;
  action: CodexActivationAction;
  desired: boolean;
}

export interface CodexExtensionPlanAction {
  pluginId: string;
  componentKey: string;
  kind: CodexSurfaceComponent['kind'];
  scope: Scope;
  action: 'write' | 'remove';
}

export interface CodexReconcilePostcheckDescriptor {
  requirement: CodexOperationRequirement;
  support: 'observed' | 'assumed';
  plugins: Array<{
    pluginId: string;
    codexPluginId: string;
    expectedUserEnabled: boolean;
    expectedProjectEnabled: boolean;
    exactCwd: string;
    neutralCwdRequired: boolean;
  }>;
}

export interface CodexReconcileReviewDescriptor {
  evidenceDigest: string;
  planDigest: string;
  requiresConfirmation: boolean;
  sharedImpact: {
    pluginIds: string[];
    warning?: string;
  };
}

export interface CodexReconcilePlan {
  requirement: CodexOperationRequirement;
  desiredTargets: Array<{ pluginId: string; scopes: Scope[] }>;
  sharedNativeActions: CodexSharedNativePlanAction[];
  activationActions: {
    user: CodexActivationPlanAction[];
    project: CodexActivationPlanAction[];
  };
  extensionWrites: CodexExtensionPlanAction[];
  extensionRemovals: CodexExtensionPlanAction[];
  staleActivationRemovals: Array<{ scope: Scope; codexPluginId: string }>;
  managedInventory: {
    before: string[];
    desired: string[];
    ownershipSuperset: string[];
    converged: string[];
    related: {
      before: string[];
      desired: string[];
      ownershipSuperset: string[];
      converged: string[];
    };
  };
  warnings: string[];
  postcheck: CodexReconcilePostcheckDescriptor;
  review: CodexReconcileReviewDescriptor;
}

export class CodexReconcilePlanError extends Error {
  readonly code:
    | 'codexSharedNativeForeign'
    | 'codexSharedNativeCorrupt'
    | 'codexExtensionScopeConflict'
    | 'codexSurfaceOwnerCollision'
    | 'codexReconcileEvidenceInvalid';

  constructor(code: CodexReconcilePlanError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'CodexReconcilePlanError';
    this.code = code;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function targetKey(target: Pick<CodexReconcilerCatalogTarget, 'pluginId' | 'codexPluginId'>): string {
  return `${target.pluginId}\0${target.codexPluginId}`;
}

function desiredScopes(target: CodexReconcilerCatalogTarget): Scope[] {
  return [...new Set(target.desiredScopes ?? [target.resolvedScope])].sort(compareText);
}

function assertTarget(target: CodexReconcilerCatalogTarget): void {
  if (!target.surface.ok) {
    throw new CodexReconcilePlanError(
      'codexSurfaceOwnerCollision',
      `${target.pluginId} has an ambiguous or unsupported Codex surface.`,
    );
  }
  if (!target.codexPluginId.includes('@')) {
    throw new CodexReconcilePlanError(
      'codexReconcileEvidenceInvalid',
      `${target.pluginId} has an invalid Codex plugin ID.`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(target.payloadDigest)) {
    throw new CodexReconcilePlanError(
      'codexReconcileEvidenceInvalid',
      `${target.pluginId} has an invalid payload digest.`,
    );
  }
}

function nativeAction(options: {
  operation: CodexReconcileOperation;
  target: CodexReconcilerCatalogTarget;
  evidence: CodexReconcilerLiveEvidence;
}): CodexSharedNativeAction {
  const { operation, target, evidence } = options;
  const requiresNative = target.surface.nativeKinds.length > 0
    && desiredScopes(target).length > 0;
  if (!requiresNative || operation === 'uninstall') return 'none';
  const state = evidence.sharedNative;
  if (state.state === 'foreign') {
    throw new CodexReconcilePlanError(
      'codexSharedNativeForeign',
      `${target.codexPluginId} collides with foreign native state.`,
    );
  }
  if (state.state === 'corrupt') {
    if (evidence.repairableSharedNative) return 'repair';
    throw new CodexReconcilePlanError(
      'codexSharedNativeCorrupt',
      `${target.codexPluginId} is corrupt and is not safely repairable.`,
    );
  }
  if (operation === 'reinstall') {
    return state.state === 'absent' ? 'install' : 'replace';
  }
  if (state.state === 'absent') return 'install';
  if (state.state === 'outdated') return 'replace';
  if (state.state === 'claimable') return 'claim';
  return 'reuse';
}

function activationAction(options: {
  actual: boolean | undefined;
  desired: boolean;
  scope: Scope;
  nativeDesiredSomewhere: boolean;
}): CodexActivationAction {
  if (options.desired) return options.actual === true ? 'none' : 'enable';
  if (options.scope === 'user' && options.nativeDesiredSomewhere) {
    return options.actual === false ? 'none' : 'disable';
  }
  return options.actual === undefined ? 'none' : 'remove';
}

function liveExtensionState(
  evidence: CodexReconcilerLiveEvidence,
  componentKey: string,
  scope: Scope,
): CodexLiveExtensionState {
  return evidence.extensions?.find((entry) =>
    entry.componentKey === componentKey && entry.scope === scope)?.state ?? 'absent';
}

function addExtensionActions(options: {
  input: CodexReconcilerInput;
  target: CodexReconcilerCatalogTarget;
  evidence: CodexReconcilerLiveEvidence;
  writes: CodexExtensionPlanAction[];
  removals: CodexExtensionPlanAction[];
}): void {
  const scopes = desiredScopes(options.target);
  const awComponents = options.target.surface.components.filter((component) =>
    component.owner === 'aw');
  if (awComponents.length > 0 && scopes.includes('user') && scopes.includes('project')) {
    throw new CodexReconcilePlanError(
      'codexExtensionScopeConflict',
      `${options.target.pluginId} has AW-owned output at both user and project scope.`,
    );
  }
  for (const component of awComponents) {
    for (const scope of ['user', 'project'] as const) {
      const state = liveExtensionState(options.evidence, component.key, scope);
      if (state === 'foreign') {
        throw new CodexReconcilePlanError(
          'codexSurfaceOwnerCollision',
          `${options.target.pluginId} extension ${component.key} is foreign at ${scope} scope.`,
        );
      }
      const desired = scopes.includes(scope) && component.scopes.includes(scope);
      const shouldWrite = desired && (
        state !== 'present'
        || options.input.operation === 'upgrade'
        || options.input.operation === 'reinstall'
      );
      if (shouldWrite) {
        options.writes.push({
          pluginId: options.target.pluginId,
          componentKey: component.key,
          kind: component.kind,
          scope,
          action: 'write',
        });
      } else if (!desired && state !== 'absent') {
        options.removals.push({
          pluginId: options.target.pluginId,
          componentKey: component.key,
          kind: component.kind,
          scope,
          action: 'remove',
        });
      }
    }
  }
}

function sortActivationActions(actions: CodexActivationPlanAction[]): void {
  actions.sort((left, right) => compareText(
    `${left.codexPluginId}\0${left.pluginId}`,
    `${right.codexPluginId}\0${right.pluginId}`,
  ));
}

function sortExtensionActions(actions: CodexExtensionPlanAction[]): void {
  actions.sort((left, right) => compareText(
    `${left.scope}\0${left.pluginId}\0${left.componentKey}`,
    `${right.scope}\0${right.pluginId}\0${right.componentKey}`,
  ));
}

function evidenceFor(
  target: CodexReconcilerCatalogTarget,
  evidenceById: ReadonlyMap<string, CodexReconcilerLiveEvidence>,
): CodexReconcilerLiveEvidence {
  const evidence = evidenceById.get(target.codexPluginId);
  if (!evidence) {
    throw new CodexReconcilePlanError(
      'codexReconcileEvidenceInvalid',
      `Missing live evidence for ${target.codexPluginId}.`,
    );
  }
  return evidence;
}

export function createCodexReconcilePlan(input: CodexReconcilerInput): CodexReconcilePlan {
  const sortedTargets = [...input.catalogClosure].sort((left, right) =>
    compareText(targetKey(left), targetKey(right)));
  const duplicateTarget = sortedTargets.find((target, index) =>
    index > 0 && targetKey(sortedTargets[index - 1]!) === targetKey(target));
  if (duplicateTarget) {
    throw new CodexReconcilePlanError(
      'codexReconcileEvidenceInvalid',
      `Duplicate catalog target ${duplicateTarget.pluginId}.`,
    );
  }
  sortedTargets.forEach(assertTarget);
  const ownersByCodexPluginId = new Map<string, Set<string>>();
  for (const target of sortedTargets) {
    const owners = ownersByCodexPluginId.get(target.codexPluginId) ?? new Set<string>();
    owners.add(target.pluginId);
    ownersByCodexPluginId.set(target.codexPluginId, owners);
  }
  const ownerCollision = [...ownersByCodexPluginId.entries()].find(([, owners]) => owners.size > 1);
  if (ownerCollision) {
    throw new CodexReconcilePlanError(
      'codexSurfaceOwnerCollision',
      `${ownerCollision[0]} is claimed by ${[...ownerCollision[1]].sort(compareText).join(', ')}.`,
    );
  }

  const evidenceById = new Map<string, CodexReconcilerLiveEvidence>();
  for (const evidence of input.liveEvidence) {
    if (evidenceById.has(evidence.codexPluginId)) {
      throw new CodexReconcilePlanError(
        'codexReconcileEvidenceInvalid',
        `Duplicate live evidence for ${evidence.codexPluginId}.`,
      );
    }
    evidenceById.set(evidence.codexPluginId, evidence);
  }

  const sharedNativeActions: CodexSharedNativePlanAction[] = [];
  const userActions: CodexActivationPlanAction[] = [];
  const projectActions: CodexActivationPlanAction[] = [];
  const extensionWrites: CodexExtensionPlanAction[] = [];
  const extensionRemovals: CodexExtensionPlanAction[] = [];
  const warnings: string[] = [];
  const postcheckPlugins: CodexReconcilePostcheckDescriptor['plugins'] = [];
  let projectContractRequired = input.scope === 'project'
    || sortedTargets.some((target) => target.resolvedScope === 'project');

  for (const target of sortedTargets) {
    const evidence = evidenceFor(target, evidenceById);
    const scopes = desiredScopes(target);
    const hasNative = target.surface.nativeKinds.length > 0;
    const userDesired = hasNative && scopes.includes('user');
    const projectDesired = hasNative && scopes.includes('project');
    const nativeDesiredSomewhere = userDesired || projectDesired;
    projectContractRequired ||= projectDesired;

    const action = nativeAction({ operation: input.operation, target, evidence });
    if (hasNative || action !== 'none') {
      sharedNativeActions.push({
        pluginId: target.pluginId,
        codexPluginId: target.codexPluginId,
        action,
        desiredVersion: target.version,
        affectsOtherScopes: action === 'replace' || action === 'repair',
      });
    }
    if (action === 'claim') warnings.push(`codexSharedNativeClaim:${target.codexPluginId}`);
    if (action === 'replace' || action === 'repair') {
      warnings.push(`codexSharedNativeAffectsOtherScopes:${target.codexPluginId}`);
    }

    const userAction: CodexActivationPlanAction = {
      pluginId: target.pluginId,
      codexPluginId: target.codexPluginId,
      scope: 'user',
      action: activationAction({
        actual: evidence.activations.user,
        desired: userDesired,
        scope: 'user',
        nativeDesiredSomewhere,
      }),
      desired: userDesired,
    };
    const projectAction: CodexActivationPlanAction = {
      pluginId: target.pluginId,
      codexPluginId: target.codexPluginId,
      scope: 'project',
      action: activationAction({
        actual: evidence.activations.project,
        desired: projectDesired,
        scope: 'project',
        nativeDesiredSomewhere,
      }),
      desired: projectDesired,
    };
    userActions.push(userAction);
    projectActions.push(projectAction);
    addExtensionActions({
      input,
      target,
      evidence,
      writes: extensionWrites,
      removals: extensionRemovals,
    });
    if (hasNative && (userDesired || projectDesired)) {
      postcheckPlugins.push({
        pluginId: target.pluginId,
        codexPluginId: target.codexPluginId,
        expectedUserEnabled: userDesired,
        expectedProjectEnabled: projectDesired,
        exactCwd: input.cwd,
        neutralCwdRequired: projectDesired,
      });
    }
  }

  const actualDesiredIds = canonicalStrings(sortedTargets.flatMap((target) =>
    target.surface.nativeKinds.length > 0 && desiredScopes(target).length > 0
      ? [target.codexPluginId]
      : []));
  const desiredIds = canonicalStrings(sortedTargets.flatMap((target) =>
    (target.intentScopes ?? desiredScopes(target)).includes(input.scope)
      ? [target.codexPluginId]
      : []));
  const relatedScope: Scope = input.scope === 'user' ? 'project' : 'user';
  const relatedDesiredIds = canonicalStrings(sortedTargets.flatMap((target) =>
    (target.intentScopes ?? desiredScopes(target)).includes(relatedScope)
      ? [target.codexPluginId]
      : []));
  const beforeIds = canonicalStrings(input.intentBefore.managed.codexPluginIds);
  const relatedBeforeIds = canonicalStrings(
    input.relatedIntentBefore?.managed.codexPluginIds ?? [],
  );
  const nativeReconciledPluginNames = new Set(sortedTargets.flatMap((target) =>
    target.surface.nativeKinds.length > 0 ? [target.pluginName] : []));
  const reconciledPluginNames = new Set(sortedTargets.map((target) => target.pluginName));
  const managedPluginName = (codexPluginId: string): string =>
    codexPluginId.slice(0, codexPluginId.lastIndexOf('@'));
  const staleActivationRemovals = canonicalStrings(
    [...beforeIds, ...relatedBeforeIds].filter((pluginId) =>
      nativeReconciledPluginNames.has(managedPluginName(pluginId))
      && !actualDesiredIds.includes(pluginId)),
  ).flatMap((codexPluginId) => [
    { scope: 'user' as const, codexPluginId },
    { scope: 'project' as const, codexPluginId },
  ]);
  const requirement = getCodexOperationRequirement(projectContractRequired ? 'project' : 'user');
  const support = input.activationSupport ?? 'observed';
  if (support === 'assumed') warnings.push('codexProjectActivationAssumed');

  sharedNativeActions.sort((left, right) => compareText(left.codexPluginId, right.codexPluginId));
  sortActivationActions(userActions);
  sortActivationActions(projectActions);
  sortExtensionActions(extensionWrites);
  sortExtensionActions(extensionRemovals);
  postcheckPlugins.sort((left, right) => compareText(left.codexPluginId, right.codexPluginId));
  const ownershipSuperset = canonicalStrings([...beforeIds, ...desiredIds]);
  const convergedIds = canonicalStrings([
    ...beforeIds.filter((pluginId) =>
      !reconciledPluginNames.has(managedPluginName(pluginId))),
    ...desiredIds,
  ]);
  const relatedOwnershipSuperset = canonicalStrings([...relatedBeforeIds, ...relatedDesiredIds]);
  const relatedConvergedIds = canonicalStrings([
    ...relatedBeforeIds.filter((pluginId) =>
      !reconciledPluginNames.has(managedPluginName(pluginId))),
    ...relatedDesiredIds,
  ]);
  const evidenceDescriptor = {
    scope: input.scope,
    cwd: input.cwd,
    operation: input.operation,
    intentBefore: input.intentBefore,
    intentAfter: input.intentAfter,
    relatedIntentBefore: input.relatedIntentBefore,
    relatedIntentAfter: input.relatedIntentAfter,
    catalogClosure: sortedTargets,
    liveEvidence: [...input.liveEvidence]
      .map((evidence) => ({
        ...evidence,
        ...(evidence.extensions
          ? { extensions: [...evidence.extensions].sort((left, right) => compareText(
              `${left.scope}\0${left.componentKey}\0${left.state}\0${left.owner ?? ''}`,
              `${right.scope}\0${right.componentKey}\0${right.state}\0${right.owner ?? ''}`,
            )) }
          : {}),
      }))
      .sort((left, right) => compareText(left.codexPluginId, right.codexPluginId)),
    activationSupport: support,
  };
  const evidenceDigest = digest(evidenceDescriptor);
  const planDescriptor = {
    requirement,
    desiredTargets: sortedTargets.map((target) => ({
      pluginId: target.pluginId,
      scopes: desiredScopes(target),
    })),
    sharedNativeActions,
    activationActions: { user: userActions, project: projectActions },
    extensionWrites,
    extensionRemovals,
    staleActivationRemovals,
    managedInventory: {
      before: beforeIds,
      desired: desiredIds,
      ownershipSuperset,
      converged: convergedIds,
      related: {
        before: relatedBeforeIds,
        desired: relatedDesiredIds,
        ownershipSuperset: relatedOwnershipSuperset,
        converged: relatedConvergedIds,
      },
    },
    warnings: canonicalStrings(warnings),
    postcheck: { requirement, support, plugins: postcheckPlugins },
  };
  const planDigest = digest(planDescriptor);
  const sharedImpactPluginIds = sharedNativeActions.flatMap((entry) =>
    entry.affectsOtherScopes ? [entry.codexPluginId] : []);

  return {
    ...planDescriptor,
    review: {
      evidenceDigest,
      planDigest,
      requiresConfirmation: sharedImpactPluginIds.length > 0,
      sharedImpact: {
        pluginIds: sharedImpactPluginIds,
        ...(sharedImpactPluginIds.length > 0 ? {
          warning: 'Replacing or reinstalling shared Codex native state can affect other projects.',
        } : {}),
      },
    },
  };
}

export const planCodexReconciliation = createCodexReconcilePlan;
