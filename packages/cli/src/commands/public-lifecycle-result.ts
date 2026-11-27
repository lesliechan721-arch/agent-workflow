import type { Scope } from '../types.js';
import { isRecoveryReviewStaleBeforeExecution, recoveryRetryDispositions, recoveryStatusContext, recoverySummaryErrors, userSkillProviderRepairs,
  type RecoveryDiagnostic, type RecoveryReceipt, type RecoveryRetryDisposition, type RecoveryTarget } from '../recovery/receipt.js';
import type { NativeToolChange } from '../utils/native-tool-review.js';
import path from 'node:path';
import type { CommandResult, Confirmation, Diagnostic, NextAction } from '../output/public-result.js';
import { commandPackageRecoveryActions, commandResult, safePublicMessage, type PublicCommandProducerResult } from '../output/public-result.js';
import { isOpenCodePermission } from '../platforms/opencode-permissions.js';
import { redactString } from '../output/redact.js';
import { isConfigDiagnostic, isInstallConfigBlocked } from '../utils/plugin-config-diagnostics.js';
import { skillInvocationDiagnostics } from '../output/skill-invocation-notices.js';
import { deliveryNoticeMessage, HOST_PERMISSION_ADDITIONAL_IMPACT, hostPermissionImpactMessage,
  INVOCATION_POLICY_NOT_APPLIED, isDeliveryNoticeCode, isSkippedPermissionReason, projectComponentDelivery, projectComponentGap,
  PREVIOUS_DEPLOYMENT_RETAINED, publicHostPermissionResource, safeComponentIdentity, safeSkippedPermissionActions, type ComponentDelivery } from '../output/component-delivery.js';
import { SKILL_INVOCATION_NOTICE } from '../utils/skill-invocation-warning.js';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';
import type { DeploymentReceipt, DeploymentObservation, ProductInstallation, FrozenDeploymentPlan, PlannedEffect, DeploymentExclusion } from '../platforms/contracts.js';
import { identityDigest } from '../platforms/identity.js';
import type { ComponentUnmet, ComponentOmission, PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';

export interface PublicDeploymentPlan {
  bindingId: string;
  physicalKey: string;
  products: ProductInstallation[];
  expected: { components: Array<Pick<PluginComponent, 'id' | 'kind' | 'name'>>; omitted: ComponentOmission[]; unmet: ComponentUnmet[] };
  effects: PlannedEffect[];
  sharedReferences: FrozenDeploymentPlan['evidence']['sharedReferences'];
}

export interface PublicDeploymentResult extends Omit<DeploymentReceipt, 'after'> {
  products: ProductInstallation[];
  after: Pick<DeploymentObservation, 'physicalKey' | 'package' | 'nativePackage' | 'registration' | 'scopeRegistration' | 'scopeActivation' | 'ownership' | 'consumers' | 'components' | 'nativeIdentity' | 'configuration' | 'workspaceOpen'> & {
    prerequisites?: { nativeSources: {
      observation: 'complete' | 'unknown'; configurationEvidence: string;
      sources: Array<Omit<NonNullable<DeploymentObservation['prerequisites']['nativeSources']>['sources'][number], 'path'>>;
      overlaps: string[];
    } };
  };
}
export type PublicDeploymentObservation = Pick<PublicDeploymentResult, 'bindingId' | 'products' | 'after'>;
export type PublicDeploymentExclusion = Omit<DeploymentExclusion, 'scope' | 'product'> & {
  scope: Scope;
  product: Pick<ProductInstallation, 'id' | 'product' | 'version' | 'availability' | 'reasonCodes'> | null;
};
export interface PublicTargetResult extends ComponentDelivery {
  pluginId: string;
  target: string;
  scope: Scope;
  delivery: RecoveryTarget['delivery'];
  execution: RecoveryTarget['execution'];
  observation: RecoveryTarget['observation'];
  content: NonNullable<RecoveryTarget['content']>;
  requiredBy: string[];
  blockerCodes: string[];
  relation?: RecoveryTarget['relation'];
  requirementScope?: Scope;
  providerScope?: Scope;
  deploymentReceipts?: PublicDeploymentResult[];
  deploymentPlans?: PublicDeploymentPlan[];
  deploymentObservations?: PublicDeploymentObservation[];
  deploymentExclusions?: PublicDeploymentExclusion[];
}

export interface LifecycleData {
  request: { plugins: string[]; scope: Scope | null; context: Scope; targets: string[];
    targetOrigin: 'argument' | 'preference' | 'none'; mode: 'apply' | 'requirements-only' | 'outputs-only' };
  confirmation: Confirmation | null;
  changes: Record<'requirements' | 'preferences' | 'config' | 'sources' | 'outputs', 'none' | 'changed' | 'unknown'>;
  requirements: RecoveryReceipt['intent'];
  targetResults: PublicTargetResult[];
  remainingTargets: Array<{ pluginId: string; target: string; scope: Scope }>;
  coverage: { scopes: Scope[]; currentProject: boolean; otherProjects: 'unobserved' };
  allSatisfied?: boolean | null;
  inSync?: boolean | null;
  commandResults?: PublicCommandProducerResult[];
  nativeToolChanges?: NativeToolChange[];
}

const messages: Record<string, string> = {
  dependencyExcluded: 'A required plugin is excluded from this target by the local deployment policy.',
  confirmationRequired: 'Repeat this request with --yes to confirm the listed effects.',
  noTargetsEnabled: 'No effective deployment targets are enabled. Set targets or choose --only requirements.',
  projectRootUnavailable: 'A valid project root is required for this request.',
  sourceActiveUnavailable: 'The selected source has no usable Active Catalog.',
  catalogSnapshotInvalid: 'The complete Active snapshot could not be verified. Requirements and outputs were retained.',
  pluginIntentStateInvalid: 'The requirements document is invalid or cannot be read.',
  operationInterrupted: 'The command was interrupted. Completed changes are retained in the result.',
  processCleanupUnconfirmed: 'Process cleanup could not be confirmed. Check status before retrying.',
  operationReviewStale: 'The operation evidence changed. Review the current state and repeat the request.',
  pluginSelectorAmbiguous: 'The plugin name is ambiguous. Use a source-qualified plugin ID.',
  pluginUnavailable: 'The plugin is not available in the selected Active Catalog.',
  nativeActivationDisabled: 'The selected scope is disabled in the native client.',
  nativeActivationUnconfirmed: 'The native client did not confirm effective activation for the selected scope.',
  nativeActivationBlocked: 'The native client blocked activation in the selected scope.',
  grokProjectAuthorizationDenied: 'Grok denied authorization for the selected project. Review it in Grok before syncing.',
  deploymentOwnershipConflict: 'The native deployment conflicts with another owner or registration.',
  platformPackageMissing: 'The required AW source package is missing.',
  nativeRegistrationMissing: 'The native client reports no required registration.',
  nativeRegistrationUnconfirmed: 'The native client did not confirm registration for the selected deployment.',
  nativePackageMissing: 'The registered native client copy is missing.',
  nativePackageContentDrift: 'The native client copy is out of date.',
  nativePackageContentUnconfirmed: 'The native client copy could not be verified.',
  platformInputDrift: 'The plugin inputs changed and its deployment needs to be synced.',
  userSkillProviderNotReady: 'Sync the declared User plugin to repair its Skill dependency, then retry the Project plugin.',
  projectSkillProviderConflict: 'Check the existing Project package, permissions and activation before reusing the User Skill dependency.',
  providerSwitchVerificationFailed: 'The replacement could not be verified. The previous copy was retained.',
  platformContentDrift: 'The deployed plugin content changed and needs to be synced.',
  platformExpectationUnconfirmed: 'The package projection could not be verified.',
  platformPreparationPartial: 'The package has only a partial projection.',
  componentOutputMissing: 'A required deployed component is missing.',
  componentOutputUnconfirmed: 'The deployed component output could not be verified.',
  dynamicExpectationUnconfirmed: 'The required dynamic output could not be verified.',
  cursorWorkspaceOpenMissing: 'The selected scope is missing the managed Cursor workspaceOpen entry.',
  cursorWorkspaceOpenUnconfirmed: 'The managed Cursor workspaceOpen entry could not be verified.',
  outputsRetainedRequirements: 'Requirements were retained. A later sync can deploy these outputs again.',
  stateInventoryFailed: 'The local output inventory is incomplete. Inspect the detected location before recovery.',
};

export function safeRecoveryDetail(detail: Diagnostic['detail']): Diagnostic['detail'] {
  if (!detail || typeof detail.reasonCode !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(detail.reasonCode)) return undefined;
  const safe = (value: unknown): value is string => typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && redactString(value) === value;
  const fieldKeys = Array.isArray(detail.fieldKeys) ? [...new Set(detail.fieldKeys.filter((key) => typeof key === 'string' && key.length > 0 && safe(key)))].sort() : [];
  return { reasonCode: detail.reasonCode,
    ...(fieldKeys.length ? { fieldKeys } : {}),
    ...(detail.path && safe(detail.path) && (path.isAbsolute(detail.path) || path.win32.isAbsolute(detail.path))
      ? { path: detail.path } : {}),
    ...(detail.configKey && safe(detail.configKey) ? { configKey: detail.configKey } : {}),
  };
}

export function publicDiagnostic(value: RecoveryDiagnostic | string, subject?: Diagnostic['subject'], severity: Diagnostic['severity'] = 'error'): Diagnostic {
  const code = typeof value === 'string' ? value : value.code;
  const sourceMessage = typeof value === 'string' ? undefined : value.message;
  const publicMessage = sourceMessage && !/[\u3400-\u9fff]/u.test(sourceMessage)
    && !/(?:\/(?:Users|home|tmp|private|var)\/|[A-Za-z]:[\\/])/u.test(sourceMessage)
    ? safePublicMessage(sourceMessage, code) : undefined;
  let detail = typeof value === 'string' ? undefined : safeRecoveryDetail(value.detail);
  const combinedSubject: NonNullable<Diagnostic['subject']> = { ...(typeof value !== 'string' && value.pluginId ? { pluginId: value.pluginId } : {}),
    ...(typeof value !== 'string' ? value.subject : {}), ...subject };
  if (code === 'permissionRelatedProjectUpdated' && typeof value !== 'string') {
    const permissionChanges = (value.detail?.permissionChanges ?? []).flatMap(({ change, effect, resource }) =>
      (change === 'add' || change === 'remove') && isOpenCodePermission({ action: 'shell', effect, resource })
        ? [{ change, effect, resource: publicHostPermissionResource(resource)
          .replace(/(?:^|(?<=[ =]))(?:\/(?:Users|home|tmp|private|var)\/|[A-Za-z]:[\\/])[^ ]*/gu, '[local path]') }]
        : []);
    const message = ['Updated OpenCode Project permissions.', ...permissionChanges.map(({ change, effect, resource }) =>
      `${change === 'add' ? 'Add' : 'Remove'} ${effect} shell ${resource}`)].join('\n');
    return { code, severity: 'info', message, subject: combinedSubject,
      ...(detail ? { detail: { ...detail, permissionChanges } } : {}) };
  }
  if (code === HOST_PERMISSION_ADDITIONAL_IMPACT && typeof value !== 'string') {
    const action = value.detail?.permissionAction;
    const resource = value.detail?.permissionResource;
    if (detail && (action === 'allow' || action === 'ask' || action === 'deny')) detail.permissionAction = action;
    if (detail && resource) detail.permissionResource = publicHostPermissionResource(resource);
    if (combinedSubject.field && safeComponentIdentity(combinedSubject.field) !== combinedSubject.field) delete combinedSubject.field;
    const configured = detail?.permissionAction && detail.permissionResource ? detail.permissionAction + ' ' + detail.permissionResource : undefined;
    const message = [configured, hostPermissionImpactMessage(sourceMessage)].filter(Boolean).join(' · ');
    return { code, severity: 'warning', message, subject: combinedSubject, ...(detail ? { detail } : {}) };
  }
  if (isDeliveryNoticeCode(code) && code !== PREVIOUS_DEPLOYMENT_RETAINED) {
    if (detail) {
      const actions = code === INVOCATION_POLICY_NOT_APPLIED && typeof value !== 'string'
        ? safeSkippedPermissionActions(value.detail?.skippedPermissionActions) : [];
      const relatedProjectPath = code === INVOCATION_POLICY_NOT_APPLIED && detail.reasonCode === 'permission-rule-conflict'
        && combinedSubject.target === 'opencode' ? detail.path : undefined;
      detail = code === INVOCATION_POLICY_NOT_APPLIED && !isSkippedPermissionReason(detail.reasonCode) ? undefined
        : { reasonCode: detail.reasonCode, ...(actions.length ? { skippedPermissionActions: actions } : {}),
          ...(relatedProjectPath ? { path: relatedProjectPath } : {}) };
    }
    if (combinedSubject.field && safeComponentIdentity(combinedSubject.field) !== combinedSubject.field) delete combinedSubject.field;
  }
  return { code, severity, message: isDeliveryNoticeCode(code) ? deliveryNoticeMessage(code, detail, combinedSubject.field)
    : messages[code] ?? publicMessage ?? `The operation could not complete (${code}).`,
    ...(Object.keys(combinedSubject).length ? { subject: combinedSubject } : {}), ...(detail ? { detail } : {}) };
}

/** Configuration fixes must name the affected provider and target, not its consumer. */
export function configRecoveryActions(diagnostics: readonly Diagnostic[]): NextAction[] {
  const actions = new Map<string, NextAction>();
  const shellWord = (value: string): string => /^[A-Za-z0-9_./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  for (const diagnostic of diagnostics.filter(isConfigDiagnostic)) {
    const { pluginId, target } = diagnostic.subject ?? {};
    if (!pluginId || !target) continue;
    const key = `${pluginId}\0${target}`;
    if (diagnostic.detail?.fieldKeys?.length) for (const field of diagnostic.detail.fieldKeys) {
      const command = `aw plugin config set ${shellWord(pluginId)} ${shellWord(field)} --platform ${shellWord(target)} --value-json '...'`;
      actions.set(`${key}\0${field}`, { kind: 'manual', message: `Set the field using ${command} (replace '...' with valid JSON), or open aw to configure the target.` });
    } else actions.set(key, { kind: 'manual', message: `Open aw to inspect or repair the configuration for ${pluginId} (${target}).` });
  }
  return [...actions.values()];
}

export function projectDeploymentNotices(targets: readonly RecoveryTarget[]): Diagnostic[] {
  const diagnostics = [...skillInvocationDiagnostics(targets)];
  for (const target of targets) {
    const subject = { pluginId: target.pluginId, target: target.agent, scope: target.scope };
    const deployment = (target.deploymentReceipts ?? []).flatMap(({ diagnostics, effects }) =>
      [...diagnostics, ...effects.flatMap((effect) => effect.diagnostics)]);
    for (const blocker of target.blockers) {
      if (isDeliveryNoticeCode(blocker.code)) diagnostics.push(publicDiagnostic(blocker, blocker.subject ?? subject));
    }
    for (const notice of deployment) {
      if (isDeliveryNoticeCode(notice.code)) diagnostics.push(publicDiagnostic(notice, notice.subject ?? subject, notice.severity));
    }
    for (const notice of target.reasons ?? []) {
      if (isDeliveryNoticeCode(notice.code) && !deployment.some((entry) => entry.code === notice.code
        && JSON.stringify(entry.subject ?? subject) === JSON.stringify(notice.subject ?? subject)
        && entry.detail?.reasonCode === notice.detail?.reasonCode
        && (notice.code !== HOST_PERMISSION_ADDITIONAL_IMPACT
          || entry.message === notice.message && JSON.stringify(entry.detail) === JSON.stringify(notice.detail))
        && JSON.stringify(entry.detail?.skippedPermissionActions) === JSON.stringify(notice.detail?.skippedPermissionActions))) {
        diagnostics.push(publicDiagnostic(notice, notice.subject ?? subject, 'warning'));
      }
    }
  }
  return [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()];
}

export function projectRelatedProjectPermissionFailures(targets: readonly RecoveryTarget[]): Diagnostic[] {
  const failures = targets.flatMap(({ blockers }) => blockers.filter(({ code, detail }) =>
    code === 'permissionRelatedProjectUpdateIncomplete' && detail?.path).map((entry) => publicDiagnostic(entry)));
  return [...new Map(failures.map((entry) => [JSON.stringify(entry), entry])).values()];
}

type DeploymentRecoveryContext = { receipt: RecoveryReceipt; target: RecoveryTarget };

function matchesRecoveryPosition(subject: Diagnostic['subject'], target: Pick<RecoveryTarget, 'pluginId' | 'scope' | 'agent'>): boolean {
  return subject?.pluginId === target.pluginId && subject.target === target.agent && subject.scope === target.scope;
}

function retryCommand(root: RecoveryRetryDisposition): string[] {
  return ['aw', 'plugin', 'sync', root.pluginId, '--context', root.scope, '--target', root.agent];
}

function exactProjectRetry(root: RecoveryRetryDisposition): string {
  return `In the TUI, review only the Project location for ${root.pluginId} on ${root.agent}.`;
}

export function recoverySyncAction(root: RecoveryRetryDisposition, reason: string): NextAction {
  return root.kind === 'exact-project' ? { kind: 'manual', message: exactProjectRetry(root) }
    : { kind: 'command', argv: retryCommand(root), reason, requiresConfirmation: true };
}

/** Native permissions belong to the physical provider. Only pending declared roots can authorize an AW retry. */
function nativeSourceRecovery(diagnostic: Diagnostic, diagnostics: readonly Diagnostic[], context?: DeploymentRecoveryContext) {
  const { subject, detail } = diagnostic;
  if (subject?.field !== 'nativeSource' || !detail) return;
  if (subject.target !== 'grok' || diagnostic.code !== 'grokNativeInstallRecovery') return;
  if (context && (context.receipt.unconfirmedSavedState || isRecoveryReviewStaleBeforeExecution(context.receipt)
    || !matchesRecoveryPosition(subject, context.target)
    || !context.receipt.remainingTargets.some((target) => matchesRecoveryPosition(subject, target)))) return;
  const roots = context ? recoveryRetryDispositions(context.receipt, [context.target]) : [];
  const location = (field: string): Diagnostic['detail'] => diagnostics.find((entry) => entry.subject?.field === field
    && entry.subject.target === subject.target && entry.subject.pluginId === subject.pluginId && entry.subject.scope === subject.scope)?.detail;
  const workspace = location('workspace')?.path;
  const configRoot = location('nativeConfigRoot')?.path;
  const source = detail.path;
  const clientContext = `With the same Grok client and configuration root${configRoot ? ` ${JSON.stringify(configRoot)}` : ''}${workspace ? ` in workspace ${JSON.stringify(workspace)}` : ''}`;
  let nativeStep: string;
  if (detail.reasonCode === 'grokNativeRefreshWorkspaceTrust') {
    nativeStep = workspace
      ? `${clientContext}, keep the existing registered copy. If you approve this exact folder, grant folder trust in Grok. For Grok 1.0.77, review [folders.${JSON.stringify(workspace)}] in trusted_folders.toml, set trusted = true and decided_at to the current Unix timestamp in seconds, and preserve the other entries. From this workspace run grok inspect --json and verify projectRoot is null and projectTrusted is true. AW checks both your saved folder decision and the runtime result.`
      : 'Keep the existing registered copy. Check $AW_HOME/runtime/user and its ancestors for links or project configuration. Restore a safe User workspace, then review the same target again for its exact Grok folder trust step.';
  } else {
    nativeStep = `${clientContext}, ${source
      ? `check the current registration. If it is absent and you approve this source, run Grok with arguments ${JSON.stringify(['plugin', 'install', source, '--trust'])}. This grants Grok trust for the source. Keep any existing foreign or unverified registration and inspect it in Grok before retrying.`
      : 'identify the exact retained AW source and check its registration in a fresh Review before making changes.'}`;
  }
  const retries = roots.map((root) => root.kind === 'exact-project' ? exactProjectRetry(root)
    : `Then run ${retryCommand(root).join(' ')}.`);
  const message = [nativeStep, 'Continue after verifying the native registration.',
    ...(retries.length ? retries : ['Recheck the original location in AW before retrying.'])].join(' ');
  return { message, roots };
}

/** Recovery locations are diagnostic facts, never permission to delete their contents. */
type InventoryDiagnostic = Pick<RecoveryDiagnostic, 'code' | 'subject' | 'detail'>;
export function inventoryRecoveryActions(values: readonly InventoryDiagnostic[], receipt?: RecoveryReceipt): NextAction[] {
  return inventoryRecovery(values, receipt).actions;
}

function inventoryRecovery(values: readonly InventoryDiagnostic[], receipt?: RecoveryReceipt) {
  const exactProjects = new Set<string>();
  const diagnostics = values.map((value) => publicDiagnostic({ ...value, message: '' }));
  const actions = new Map<string, NextAction>();
  for (const diagnostic of diagnostics) {
    const detail = diagnostic.detail;
    if (!detail) continue;
    const subject = diagnostic.subject;
    const identity = [subject?.pluginId, subject?.target, subject?.scope].filter(Boolean).join(' / ') || 'The affected inventory scope';
    let message: string;
    const target = receipt?.targetResults.find((item) => matchesRecoveryPosition(subject, item));
    const native = nativeSourceRecovery(diagnostic, diagnostics, receipt && target ? { receipt, target } : undefined);
    if (native) {
      for (const root of native.roots) if (root.kind === 'exact-project') exactProjects.add(JSON.stringify([root.pluginId, root.agent]));
      message = `${identity}: ${native.message}`;
    } else if (['workspace', 'nativeConfigRoot'].includes(subject?.field ?? '')) continue;
    else if (diagnostic.code === 'nativeStateUnreadable' || detail.reasonCode.startsWith('config')) {
      message = `${identity}: Back up ${detail.path ? JSON.stringify(detail.path) : 'the affected configuration'} and inspect its format and permissions (${detail.reasonCode}). Repair only the invalid entries after review; retain unrelated configuration. Then run status for the same context and target.`;
    }
    else if (diagnostic.code === 'permissionRelatedProjectUpdateIncomplete' && detail.path) {
      const retryUserFirst = receipt?.targetResults.some((target) => target.scope === 'user' && target.agent === 'opencode'
        && (target.execution === 'failed' || target.blockers.some(({ code }) => code === 'preApplyFailed')));
      message = receipt?.command === 'cleanup'
        ? `OpenCode: Review ${JSON.stringify(detail.path)}. Open the TUI from that project and select only the Project OpenCode location to keep the User outputs removed.`
        : `OpenCode: ${retryUserFirst ? 'Retry the failed User OpenCode targets first. ' : ''}Review ${JSON.stringify(detail.path)} and run \`aw plugin sync --context project --target opencode\` from that project.`;
    } else if (diagnostic.code === PREVIOUS_DEPLOYMENT_RETAINED) {
      message = `${identity}: Check ${detail.path ? `the previous output at ${JSON.stringify(detail.path)}` : 'the previous output'} in the affected scope before preparing the retry.`;
    } else if (detail.path && ['antigravityLegacyPackageUnconfirmed', 'antigravityProjectPackageConflict'].includes(diagnostic.code)) {
      message = `${identity}: Back up and inspect ${JSON.stringify(detail.path)}. If this copy should no longer load in the project, move that directory or link outside .agents/plugins. Run status again for the same project and plugin.`;
    } else if (diagnostic.code === 'stateInventoryFailed' || diagnostic.code === 'forceCleanupPathUnavailable') {
      message = `${identity}: Automatic cleanup cannot prove exclusive ownership (${detail.reasonCode}). Back up ${detail.path
        ? `the detected item ${JSON.stringify(detail.path)}` : 'the affected host output identified by the inventory scan'} and the related host configuration. ${detail.configKey
        ? `Check ${JSON.stringify(detail.configKey)} and remove that reference only if it still points to this exact item and you confirm it is no longer needed.`
        : 'Check configuration references to this exact item; do not assume the owner header proves ownership.'} After your confirmation, move only this item outside the host scan directories. Keep shared directories and stores. Run status again for the same plugin, target, and context; sync only after this inventory error is gone.`;
    } else continue;
    actions.set(message, { kind: 'manual', message });
  }
  return { actions: [...actions.values()], exactProjects };
}

export function projectTarget(value: RecoveryTarget, receipt?: RecoveryReceipt): PublicTargetResult {
  return { pluginId: value.pluginId, target: value.agent, scope: value.scope, delivery: value.delivery,
    execution: value.execution, observation: value.observation, content: value.content ?? 'unknown',
    requiredBy: [...value.requiredBy], blockerCodes: [...new Set(value.blockers.map((entry) => entry.code))],
    ...(value.relation ? { relation: value.relation } : {}),
    ...(value.requirementScope ? { requirementScope: value.requirementScope } : {}),
    ...(value.providerScope ? { providerScope: value.providerScope } : {}),
    ...projectComponentDelivery(value),
    ...(value.deploymentExclusions ? { deploymentExclusions: value.deploymentExclusions.map(projectDeploymentExclusion) } : {}),
    ...(value.deploymentPlans ? { deploymentPlans: value.deploymentPlans.map(projectDeploymentPlan) } : {}),
    ...(value.deploymentObservations ? { deploymentObservations: value.deploymentObservations.map(projectDeploymentObservation) } : {}),
    ...(value.deploymentReceipts ? { deploymentReceipts: value.deploymentReceipts.map((entry) => projectDeploymentReceipt(entry, receipt ? { receipt, target: value } : undefined)) } : {}) };
}

export function projectDeploymentExclusion(value: DeploymentExclusion): PublicDeploymentExclusion {
  const productId = identityDigest({ productId: value.productId });
  return { platform: value.platform, pluginId: value.pluginId, scope: value.scope.kind, productId,
    product: value.product ? { id: productId, product: value.product.product, version: value.product.version,
      availability: value.product.availability, reasonCodes: [...value.product.reasonCodes] } : null,
    reasonCode: value.reasonCode, execution: 'not-run', recoveryActions: value.recoveryActions.map((action) => safePublicMessage(action, 'productRecovery')) };
}

export function projectDeploymentPlan(value: FrozenDeploymentPlan): PublicDeploymentPlan {
  return { bindingId: value.binding.id, physicalKey: value.binding.physicalKey,
    products: value.binding.consumers.map((product) => ({ id: product.id, product: product.product,
      version: product.version, availability: product.availability, reasonCodes: [...product.reasonCodes],
      entry: product.entry ? { ...product.entry } : null })),
    expected: { components: value.expected.components.map((component) => ({ id: component.id, kind: component.kind, name: component.name })),
      omitted: value.expected.omitted.map((component) => ({ id: component.id, kind: component.kind, reason: component.reason })),
      unmet: value.expected.unmet.map(projectComponentGap) },
    effects: value.effects.map((effect) => ({ id: effect.id, kind: effect.kind, physicalKey: effect.physicalKey,
      ...(effect.activationKey ? { activationKey: effect.activationKey } : {}), componentIds: [...effect.componentIds], destination: effect.destination, destructive: effect.destructive })),
    sharedReferences: value.evidence.sharedReferences };
}

export function projectDeploymentObservation(value: NonNullable<RecoveryTarget['deploymentObservations']>[number]): PublicDeploymentObservation {
  return {
    bindingId: value.bindingId,
    products: value.products.map((product) => ({ id: product.id, product: product.product, version: product.version,
      availability: product.availability, reasonCodes: [...product.reasonCodes], entry: product.entry
        ? product.entry.kind === 'cli' ? { kind: 'cli', executable: product.entry.executable, configRoot: product.entry.configRoot }
          : product.entry.kind === 'directory' ? { kind: 'directory', configRoot: product.entry.configRoot }
            : { kind: 'generic', root: product.entry.root } : null })),
    after: { physicalKey: value.after.physicalKey, package: value.after.package, registration: value.after.registration,
      ...(value.after.nativePackage ? { nativePackage: value.after.nativePackage } : {}),
      ...(value.after.workspaceOpen ? { workspaceOpen: value.after.workspaceOpen } : {}),
      ...(value.after.scopeRegistration ? { scopeRegistration: value.after.scopeRegistration } : {}),
      ...(value.after.scopeActivation ? { scopeActivation: value.after.scopeActivation } : {}),
      ownership: value.after.ownership, consumers: value.after.consumers.map((consumer) => ({ productId: consumer.productId,
        activationKey: consumer.activationKey, activation: consumer.activation, load: consumer.load })),
      ...(value.after.configuration ? { configuration: { scope: value.after.configuration.scope,
        activation: value.after.configuration.activation,
        ...(value.after.configuration.marketplace ? { marketplace: value.after.configuration.marketplace } : {}),
        reasonCodes: [...value.after.configuration.reasonCodes] } } : {}),
      components: value.after.components.map((component) => ({ id: component.id, presence: component.presence, reasonCodes: [...component.reasonCodes] })),
      ...(value.after.prerequisites.nativeSources ? { prerequisites: { nativeSources: {
        observation: value.after.prerequisites.nativeSources.observation,
        configurationEvidence: value.after.prerequisites.nativeSources.configurationEvidence,
        sources: value.after.prerequisites.nativeSources.sources.map(({ name, version, scope, origin, enabled, effectiveComponents }) =>
          ({ name, version, scope, origin, enabled, effectiveComponents: [...effectiveComponents] })),
        overlaps: [...value.after.prerequisites.nativeSources.overlaps],
      } } } : {}),
      nativeIdentity: value.after.nativeIdentity ? { route: value.after.nativeIdentity.route, packageId: value.after.nativeIdentity.packageId,
        ...(value.after.nativeIdentity.registrationId ? { registrationId: value.after.nativeIdentity.registrationId } : {}), sourceLocation: value.after.nativeIdentity.sourceLocation } : null },
  };
}

export function projectDeploymentReceipt(value: NonNullable<RecoveryTarget['deploymentReceipts']>[number], context?: DeploymentRecoveryContext): PublicDeploymentResult {
  const all = [...value.diagnostics, ...value.effects.flatMap((effect) => effect.diagnostics)]
    .map((entry) => publicDiagnostic(entry, entry.subject, entry.severity));
  const project = (entry: Diagnostic): Diagnostic => {
    const diagnostic = publicDiagnostic(entry, entry.subject, entry.severity);
    const native = nativeSourceRecovery(diagnostic, all, context);
    return native ? { ...diagnostic, message: `${diagnostic.message} ${native.message}` } : diagnostic;
  };
  return {
    ...projectDeploymentObservation(value),
    effects: value.effects.map((effect) => ({ id: effect.id, status: effect.status, mutation: effect.mutation,
      diagnostics: effect.diagnostics.filter(({ code }) => code !== SKILL_INVOCATION_NOTICE).map(project) })),
    unmet: value.unmet.map((gap) => ({ ...projectComponentGap(gap), productIds: [...gap.productIds] })),
    reload: value.reload,
    diagnostics: value.diagnostics.filter(({ code }) => code !== SKILL_INVOCATION_NOTICE).map(project),
  };
}

export function mergeProducerResults(previous: Pick<LifecycleData, 'commandResults' | 'nativeToolChanges'>, data: LifecycleData): void {
  const commands = new Map((previous.commandResults ?? []).map((entry) => [entry.packageId, entry]));
  for (const entry of data.commandResults ?? []) {
    const key = entry.packageId;
    const before = commands.get(key);
    commands.set(key, before ? { ...entry,
      state: before.state === 'completed' && entry.state === 'completed' ? 'completed'
        : before.state === 'failed' && entry.state === 'failed' ? 'failed' : 'partial',
      action: entry.action === 'unchanged' ? before.action : entry.action,
      blockerCodes: [...new Set([...before.blockerCodes, ...entry.blockerCodes])],
    } : entry);
  }
  const tools = new Map((previous.nativeToolChanges ?? []).map((entry) => [getCommandPackageId(entry.producer), entry]));
  for (const entry of data.nativeToolChanges ?? []) {
    const key = getCommandPackageId(entry.producer);
    const before = tools.get(key);
    tools.set(key, before ? { ...entry, before: before.before } : entry);
  }
  if (previous.commandResults || data.commandResults) data.commandResults = [...commands.values()];
  if (previous.nativeToolChanges || data.nativeToolChanges) data.nativeToolChanges = [...tools.values()];
}

/** Keep exact cleanup recovery locations attached to their actual target. */
function cleanupRecoveryActions(receipt: RecoveryReceipt): Array<{ kind: 'manual'; message: string }> {
  const actions = new Map<string, { kind: 'manual'; message: string }>();
  for (const target of receipt.targetResults) {
    const backend = target.backend && typeof target.backend === 'object'
      ? target.backend as { targetResults?: unknown } : undefined;
    const entries = Array.isArray(target.backend) ? target.backend.filter((entry) => entry && typeof entry === 'object'
      && Array.isArray(entry.quarantined) && Array.isArray(entry.residual)) : backend?.targetResults;
    if (!Array.isArray(entries)) continue;
    for (const value of entries) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as { target?: { pluginId?: unknown; platform?: unknown; scope?: unknown }; quarantined?: unknown; residual?: unknown };
      if (entry.target?.pluginId !== target.pluginId || entry.target.platform !== target.agent
        || entry.target.scope !== target.scope) continue;
      for (const [kind, locations] of [['quarantined', entry.quarantined], ['residual', entry.residual]] as const) {
        if (!Array.isArray(locations)) continue;
        for (const location of locations) {
          if (typeof location !== 'string' || !location) continue;
          const key = `${target.pluginId}\0${target.agent}\0${target.scope}\0${kind}\0${location}`;
          actions.set(key, { kind: 'manual', message: kind === 'quarantined'
            ? `${target.pluginId} (${target.agent}/${target.scope}): Inspect quarantined output at ${JSON.stringify(location)}. Restore any needed files manually before retrying; they were not restored.`
            : `${target.pluginId} (${target.agent}/${target.scope}): Inspect retained output or recovery item ${JSON.stringify(location)}. Resolve it before retrying; it was not removed.` });
        }
      }
    }
  }
  return [...actions.values()];
}

export function receiptResult(command: string, data: LifecycleData, receipt: RecoveryReceipt): CommandResult<LifecycleData> {
  data.requirements = { ...receipt.intent, roots: receipt.intent.roots ? [...receipt.intent.roots] : null };
  data.request.plugins = [...receipt.requestedRoots];
  data.targetResults = receipt.targetResults.map((target) => projectTarget(target, receipt));
  data.remainingTargets = receipt.remainingTargets.map(({ pluginId, agent, scope }) => ({ pluginId, target: agent, scope }));
  if (receipt.coverage) data.coverage = { scopes: [...receipt.coverage.scopes], currentProject: receipt.coverage.scopes.includes('project'), otherProjects: 'unobserved' };
  data.changes.requirements = receipt.declarationChanged ? 'changed' : data.changes.requirements;
  data.changes.preferences = receipt.preferencesChanged ? 'changed' : data.changes.preferences;
  data.changes.config = receipt.configChanged ? 'changed' : data.changes.config;
  const commandPackageChanged = receipt.commandResults?.some(({ action, state }) => action !== 'unchanged' && state === 'completed');
  if (data.changes.outputs !== 'changed' && (commandPackageChanged || receipt.outputsMayHaveChanged)) data.changes.outputs = commandPackageChanged
    || receipt.targetResults.some((target) => target.execution === 'applied' && target.observation !== 'unknown') ? 'changed' : 'unknown';
  // A started backend or script may have changed external state before it failed.
  if (data.changes.outputs === 'none' && receipt.targetResults.some((target) => ['failed', 'partial'].includes(target.execution))) data.changes.outputs = 'unknown';
  if (receipt.allSatisfied !== undefined) data.allSatisfied = receipt.allSatisfied;
  if (receipt.inSync !== undefined) data.inSync = receipt.inSync;
  if (receipt.commandResults) data.commandResults = receipt.commandResults.map(({
    producer, packageId, selector, action, availability, subcommands, hasFallback, invocationSelectors, state, errors,
  }) => ({ producer, packageId, selector, action, availability, subcommands, hasFallback, state,
    ...(invocationSelectors === undefined ? {} : { invocationSelectors }),
    blockerCodes: errors.map((entry) => entry.code) }));
  if (receipt.nativeToolChanges) data.nativeToolChanges = receipt.nativeToolChanges.map(({ producer, before, after }) => ({ producer, before, after }));
  const diagnostics = [...receipt.blockers, ...recoverySummaryErrors(receipt)].map((entry) => publicDiagnostic(entry));
  const excludedProviders = new Map<string, NextAction>();
  for (const target of receipt.targetResults) {
    const subject = { pluginId: target.pluginId, target: target.agent, scope: target.scope };
    diagnostics.push(...target.blockers.filter(({ code }) => !isDeliveryNoticeCode(code)).map((entry) =>
      publicDiagnostic(entry, isConfigDiagnostic(entry) || ['userSkillProviderNotReady', 'permissionRelatedProjectUpdateIncomplete'].includes(entry.code) ? entry.subject ?? subject : subject)));
    diagnostics.push(...(target.reasons ?? []).filter(({ code }) => code !== SKILL_INVOCATION_NOTICE && !isDeliveryNoticeCode(code))
      .map((entry) => publicDiagnostic(entry, entry.subject ?? subject, entry.code === 'hostPermissionRestored' ? 'info' : 'warning')));
    for (const blocker of target.blockers) if (blocker.code === 'dependencyExcluded' && blocker.pluginId) {
      excludedProviders.set(`${blocker.pluginId}\0${target.agent}`, { kind: 'command',
        argv: ['aw', 'target', 'include', blocker.pluginId, '--target', target.agent],
        reason: 'If you want this dependency on this target, remove its local exclusion before retrying.',
        requiresConfirmation: true });
    }
  }
  diagnostics.push(...projectDeploymentNotices(receipt.targetResults));
  for (const result of receipt.commandResults ?? []) diagnostics.push(...result.errors.map((entry) => publicDiagnostic({ code: entry.code, message: entry.message },
    { pluginId: result.selector, scope: 'user' })));
  const changed = Object.values(data.changes).some((value) => value !== 'none');
  const completedOutput = receipt.targetResults.some((target) => ['applied', 'partial'].includes(target.execution)
    || (receipt.command === 'sync' || receipt.command === 'install') && target.execution === 'no-op'
    && target.observation === 'verified' && !target.blockers.length && target.satisfaction !== 'excluded' && target.satisfaction !== 'unsupported'
    && target.satisfaction !== 'not-applicable');
  const status = receipt.ok ? 'success' : changed || completedOutput ? 'partial' : 'blocked';
  const result = commandResult(command, data, { status, diagnostics: [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()] });
  if (data.request.mode === 'outputs-only') result.diagnostics.push(publicDiagnostic('outputsRetainedRequirements', undefined, 'info'));
  const inventory = inventoryRecovery(result.diagnostics, receipt);
  result.nextActions.push(...inventory.actions, ...configRecoveryActions(result.diagnostics));
  if (!receipt.ok) {
    const statusContext = recoveryStatusContext(receipt);
    result.nextActions.push(...excludedProviders.values());
    if (receipt.errors.some((error) => error.code === 'statusUnavailable')) {
      result.nextActions.push({ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', statusContext, '--json'],
        reason: 'Recheck the current status after the completed writes.', requiresConfirmation: false });
    }
    if (receipt.unconfirmedSavedState) {
      result.nextActions.push({ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', statusContext, '--json'],
        reason: 'Inspect the current requirements and local target policy.', requiresConfirmation: false },
      { kind: 'manual', message: `Check the current ${receipt.unconfirmedSavedState === 'intent' ? 'requirements' : 'target policy'} before preparing the original request again.` });
    } else if (isInstallConfigBlocked(receipt)) {
      result.nextActions.push({ kind: 'manual', message: 'Retry the original plugin install request after resolving the configuration diagnostics.' });
    } else if ((receipt.command === 'sync' || receipt.command === 'install') && isRecoveryReviewStaleBeforeExecution(receipt)) {
      result.nextActions.push({ kind: 'manual',
        message: `Review the original plugin ${receipt.command} request again with the same plugins, context, scope, targets and options.` });
    } else if (receipt.command === 'intent:retire') {
      const activeUnavailable = receipt.blockers.some(({ code }) => code === 'removedPluginActiveUnavailable');
      if (activeUnavailable) {
        result.nextActions.push({ kind: 'manual',
          message: 'Restore a healthy Active Catalog before retrying retirement. Offline output cleanup can remove only proven selected-scope outputs, not shared native packages.' });
      } else {
        result.nextActions.push({ kind: 'command',
          argv: ['aw', 'plugin', 'remove', ...receipt.requestedRoots, '--scope', receipt.scope],
          reason: 'Resolve the retirement diagnostics, then review the removal again to finish retiring the plugin.',
          requiresConfirmation: true });
      }
      if (receipt.retirementConfigDeletionPending) result.nextActions.push({ kind: 'manual',
        message: 'Review the remaining user-wide plugin configuration before requesting a new removal with --delete-config.' });
    } else if (command === 'plugin.remove') {
      result.nextActions.push({ kind: 'manual', message: 'Review the remaining output ownership. Use --only requirements to cancel requirements or --only outputs with explicit targets to clean proven owned outputs.' });
      for (const target of receipt.targetResults) {
        if (target.scope !== 'user' || !target.blockers.some(({ code }) => code === 'providerSwitchVerificationFailed')) continue;
        result.nextActions.push({ kind: 'manual', message: `Restore the Project dependency and verify it with aw plugin status --context project. If the User copy is no longer needed, review aw plugin remove ${target.pluginId} --only outputs --scope user --target ${target.agent}.` });
      }
    } else {
      const prerequisites = new Map<string, RecoveryRetryDisposition>();
      const retries = new Map<string, { root: RecoveryRetryDisposition; nativeManual: boolean }>();
      let checkRoot = false;
      for (const target of receipt.targetResults) {
        if (!receipt.remainingTargets.some((entry) => entry.pluginId === target.pluginId && entry.agent === target.agent && entry.scope === target.scope)) continue;
        const local = result.diagnostics.filter((entry) => matchesRecoveryPosition(entry.subject, target));
        if (local.some((entry) => entry.code === 'stateInventoryFailed' && entry.detail)) continue;
        for (const root of userSkillProviderRepairs(target)) prerequisites.set(JSON.stringify([root.pluginId, root.agent, root.scope]), root);
        const nativeManual = target.agent === 'grok' && local.some((entry) => entry.code === 'grokNativeInstallRecovery');
        const roots = recoveryRetryDispositions(receipt, [target]);
        if (!roots.length) checkRoot = true;
        for (const root of roots) {
          const key = JSON.stringify([root.pluginId, root.agent, root.scope]);
          const previous = retries.get(key);
          retries.set(key, { root, nativeManual: nativeManual || previous?.nativeManual === true });
        }
      }
      if (checkRoot) result.nextActions.push({ kind: 'command',
        argv: ['aw', 'plugin', 'status', '--context', statusContext, '--json'],
        reason: 'Identify the current declared root for this dependency before retrying.', requiresConfirmation: false });
      for (const [key, root] of prerequisites) {
        result.nextActions.push(recoverySyncAction(root, messages.userSkillProviderNotReady));
        retries.delete(key);
      }
      for (const { root, nativeManual } of retries.values()) {
        if (root.kind === 'exact-project' && inventory.exactProjects.has(JSON.stringify([root.pluginId, root.agent]))) continue;
        result.nextActions.push(recoverySyncAction(root, nativeManual ? 'Complete the host recovery and verify its effects before reviewing this retry.'
          : 'Retry the selected incomplete target after resolving its diagnostics.'));
      }
    }
  }
  result.nextActions.push(...commandPackageRecoveryActions(receipt.commandResults), ...cleanupRecoveryActions(receipt));
  return result;
}
