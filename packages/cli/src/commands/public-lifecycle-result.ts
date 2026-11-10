import type { Scope, CommandProducerResult } from '../types.js';
import type { RecoveryReceipt, RecoveryTarget, RecoveryDiagnostic } from '../recovery/receipt.js';
import type { NativeToolChange } from '../utils/native-tool-review.js';
import type { CommandResult, Confirmation, Diagnostic } from '../output/public-result.js';
import { commandResult, safePublicMessage } from '../output/public-result.js';
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
  after: Pick<DeploymentObservation, 'physicalKey' | 'package' | 'registration' | 'ownership' | 'consumers' | 'components' | 'nativeIdentity'> & {
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
export type PublicComponentGap = ComponentUnmet & { providerPluginId: string; agent: 'generic'; renderScope: Scope };

export interface PublicTargetResult {
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
  satisfaction?: RecoveryTarget['satisfaction'];
  deploymentReceipts?: PublicDeploymentResult[];
  deploymentPlans?: PublicDeploymentPlan[];
  deploymentObservations?: PublicDeploymentObservation[];
  deploymentExclusions?: PublicDeploymentExclusion[];
  componentGaps?: PublicComponentGap[];
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
  commandResults?: Array<Omit<CommandProducerResult, 'errors' | 'recoveryActions'> & { blockerCodes: string[] }>;
  nativeToolChanges?: NativeToolChange[];
}

const messages: Record<string, string> = {
  confirmationRequired: 'Repeat this request with --yes to confirm the listed effects.',
  noTargetsEnabled: 'No effective deployment targets are enabled. Set targets or choose --only requirements.',
  projectRootUnavailable: 'A valid project root is required for this request.',
  sourceActiveUnavailable: 'The selected source has no usable Active Catalog.',
  catalogSnapshotInvalid: 'The complete Active snapshot could not be verified. Requirements and outputs were retained.',
  pluginIntentStateInvalid: 'The requirements document is invalid or cannot be read.',
  operationReviewStale: 'The operation evidence changed. Review the current state and repeat the request.',
  pluginSelectorAmbiguous: 'The plugin name is ambiguous. Use a source-qualified plugin ID.',
  pluginUnavailable: 'The plugin is not available in the selected Active Catalog.',
  outputsRetainedRequirements: 'Requirements were retained. A later sync can deploy these outputs again.',
};

export function publicDiagnostic(value: RecoveryDiagnostic | string, subject?: Diagnostic['subject'], severity: Diagnostic['severity'] = 'error'): Diagnostic {
  const code = typeof value === 'string' ? value : value.code;
  const sourceMessage = typeof value === 'string' ? undefined : value.message;
  const publicMessage = sourceMessage && !/[\u3400-\u9fff]/u.test(sourceMessage)
    && !/(?:\/(?:Users|home|tmp|private|var)\/|[A-Za-z]:[\\/])/u.test(sourceMessage)
    ? safePublicMessage(sourceMessage, code) : undefined;
  return { code, severity, message: messages[code] ?? publicMessage ?? `The operation could not complete (${code}).`,
    ...(subject || typeof value !== 'string' && value.pluginId ? { subject: { ...(typeof value !== 'string' && value.pluginId ? { pluginId: value.pluginId } : {}), ...subject } } : {}) };
}

export function projectTarget(value: RecoveryTarget): PublicTargetResult {
  return { pluginId: value.pluginId, target: value.agent, scope: value.scope, delivery: value.delivery,
    execution: value.execution, observation: value.observation, content: value.content ?? 'unknown',
    requiredBy: [...value.requiredBy], blockerCodes: [...new Set(value.blockers.map((entry) => entry.code))],
    ...(value.relation ? { relation: value.relation } : {}),
    ...(value.requirementScope ? { requirementScope: value.requirementScope } : {}),
    ...(value.providerScope ? { providerScope: value.providerScope } : {}),
    ...(value.satisfaction ? { satisfaction: value.satisfaction } : {}),
    ...(value.deploymentExclusions ? { deploymentExclusions: value.deploymentExclusions.map(projectDeploymentExclusion) } : {}),
    ...(value.componentGaps ? { componentGaps: value.componentGaps.map((gap) => ({
      id: gap.id, kind: gap.kind, providerPluginId: gap.providerPluginId, agent: gap.agent, renderScope: gap.renderScope,
      ...(gap.name ? { name: gap.name } : {}), ...(gap.componentId ? { componentId: gap.componentId } : {}),
      reasonCode: gap.reasonCode, requiredFeatures: gap.requiredFeatures.map((requirement) => ({ feature: requirement.feature,
        ...(requirement.values ? { values: [...requirement.values] } : {}) })),
    })) } : {}),
    ...(value.deploymentPlans ? { deploymentPlans: value.deploymentPlans.map(projectDeploymentPlan) } : {}),
    ...(value.deploymentObservations ? { deploymentObservations: value.deploymentObservations.map(projectDeploymentObservation) } : {}),
    ...(value.deploymentReceipts ? { deploymentReceipts: value.deploymentReceipts.map(projectDeploymentReceipt) } : {}) };
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
      unmet: value.expected.unmet.map((gap) => ({ id: gap.id, kind: gap.kind,
        ...(gap.name ? { name: gap.name } : {}), ...(gap.componentId ? { componentId: gap.componentId } : {}),
        requiredFeatures: gap.requiredFeatures.map((requirement) => ({ feature: requirement.feature,
          ...(requirement.values ? { values: [...requirement.values] } : {}) })), reasonCode: gap.reasonCode })) },
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
      ownership: value.after.ownership, consumers: value.after.consumers.map((consumer) => ({ productId: consumer.productId,
        activationKey: consumer.activationKey, activation: consumer.activation, trust: consumer.trust, load: consumer.load })),
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

export function projectDeploymentReceipt(value: NonNullable<RecoveryTarget['deploymentReceipts']>[number]): PublicDeploymentResult {
  return {
    ...projectDeploymentObservation(value),
    effects: value.effects.map((effect) => ({ id: effect.id, status: effect.status, mutation: effect.mutation,
      diagnostics: effect.diagnostics.map((entry) => publicDiagnostic(entry, entry.subject, entry.severity)) })),
    unmet: value.unmet.map((gap) => ({ id: gap.id, kind: gap.kind,
      ...(gap.name ? { name: gap.name } : {}), ...(gap.componentId ? { componentId: gap.componentId } : {}),
      requiredFeatures: gap.requiredFeatures.map((requirement) => ({ feature: requirement.feature,
        ...(requirement.values ? { values: [...requirement.values] } : {}) })),
      reasonCode: gap.reasonCode, productIds: [...gap.productIds] })),
    reload: value.reload,
    diagnostics: value.diagnostics.map((entry) => publicDiagnostic(entry, entry.subject, entry.severity)),
  };
}

export function mergeProducerResults(previous: Pick<LifecycleData, 'commandResults' | 'nativeToolChanges'>, data: LifecycleData): void {
  const commands = new Map((previous.commandResults ?? []).map((entry) => [getCommandPackageId(entry.producer), entry]));
  for (const entry of data.commandResults ?? []) {
    const key = getCommandPackageId(entry.producer);
    const before = commands.get(key);
    commands.set(key, before ? { ...entry,
      state: before.state === 'completed' && entry.state === 'completed' ? 'completed'
        : before.state === 'failed' && entry.state === 'failed' ? 'failed' : 'partial',
      commandIds: [...new Set([...before.commandIds, ...entry.commandIds])],
      removedCommandIds: [...new Set([...before.removedCommandIds, ...entry.removedCommandIds])],
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
  data.targetResults = receipt.targetResults.map(projectTarget);
  data.remainingTargets = receipt.remainingTargets.map(({ pluginId, agent, scope }) => ({ pluginId, target: agent, scope }));
  if (receipt.coverage) data.coverage = { scopes: [...receipt.coverage.scopes], currentProject: receipt.coverage.scopes.includes('project'), otherProjects: 'unobserved' };
  data.changes.requirements = receipt.declarationChanged ? 'changed' : data.changes.requirements;
  data.changes.preferences = receipt.preferencesChanged ? 'changed' : data.changes.preferences;
  data.changes.config = receipt.configChanged ? 'changed' : data.changes.config;
  if (receipt.outputsMayHaveChanged) data.changes.outputs = receipt.targetResults.some((target) => target.execution === 'applied' && target.observation !== 'unknown') ? 'changed' : 'unknown';
  // A started backend or script may have changed external state before it failed.
  if (data.changes.outputs === 'none' && receipt.targetResults.some((target) => ['failed', 'partial'].includes(target.execution))) data.changes.outputs = 'unknown';
  if (receipt.allSatisfied !== undefined) data.allSatisfied = receipt.allSatisfied;
  if (receipt.inSync !== undefined) data.inSync = receipt.inSync;
  if (receipt.commandResults) data.commandResults = receipt.commandResults.map(({ producer, state, commandIds, removedCommandIds, errors }) => ({ producer, state, commandIds, removedCommandIds, blockerCodes: errors.map((entry) => entry.code) }));
  if (receipt.nativeToolChanges) data.nativeToolChanges = receipt.nativeToolChanges.map(({ producer, before, after }) => ({ producer, before, after }));
  const diagnostics = [...receipt.blockers, ...receipt.errors].map((entry) => publicDiagnostic(entry));
  for (const target of receipt.targetResults) {
    const subject = { pluginId: target.pluginId, target: target.agent, scope: target.scope };
    diagnostics.push(...target.blockers.map((entry) => publicDiagnostic(entry, subject)));
    diagnostics.push(...(target.reasons ?? []).map((entry) => publicDiagnostic(entry, subject, 'warning')));
  }
  for (const result of receipt.commandResults ?? []) diagnostics.push(...result.errors.map((entry) => publicDiagnostic(entry,
    { pluginId: `${result.producer.sourceId}/${result.producer.pluginName}`, scope: result.producer.scope })));
  const changed = Object.values(data.changes).some((value) => value !== 'none');
  const status = receipt.ok ? 'success' : changed || receipt.targetResults.some((target) => ['applied', 'partial'].includes(target.execution)) ? 'partial' : 'blocked';
  const result = commandResult(command, data, { status, diagnostics: [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()] });
  if (data.request.mode === 'outputs-only') result.diagnostics.push(publicDiagnostic('outputsRetainedRequirements', undefined, 'info'));
  if (!receipt.ok) {
    if (command === 'plugin.remove') result.nextActions.push({ kind: 'manual', message: 'Review the remaining output ownership. Use --only requirements to cancel requirements or --only outputs with explicit targets to clean proven owned outputs.' });
    else for (const target of data.remainingTargets) result.nextActions.push({ kind: 'command', argv: ['aw', 'plugin', 'sync', target.pluginId, '--context', data.request.context, '--target', target.target], reason: 'Retry the selected incomplete target after resolving its diagnostics.', requiresConfirmation: true });
  }
  result.nextActions.push(...cleanupRecoveryActions(receipt));
  return result;
}
