import path from 'node:path';
import type { OwnedComponent } from '../utils/ownership.js';
import type {
  DeploymentBinding, DeploymentObservation, DeploymentReceipt, Diagnostic,
  FrozenDeploymentPlan, HostContribution, LifecyclePrepareInput, MutationContext,
  NativeIdentity, PlannedEffect, PreparedDeployment, PrepareResult, ProductInstallation,
  ProjectionResult,
} from './contracts.js';
import { inspectDeployment } from './inspection.js';
import { executeNativeLifecycle, grokRegistrationOwned, nativeLifecycleEffectKey, nativeRoute, routeReload } from './lifecycle-native.js';
import { geminiConsentMessages } from './gemini-consent.js';
import { geminiReplacementMessages } from './gemini-activation.js';

interface PreparedContribution {
  effectId: string;
  contribution: HostContribution;
  component: OwnedComponent;
}
export interface PlatformDriverState {
  readonly before: DeploymentObservation;
  readonly identity: NativeIdentity | null;
  readonly product: ProductInstallation | null;
  readonly packageComponent: OwnedComponent | null;
  readonly bundle: ProjectionResult['bundle'];
  readonly contributions: PreparedContribution[];
  readonly removals: Array<{ effectId: string; component: OwnedComponent }>;
}

export function lifecycleDiagnostic(binding: DeploymentBinding, code: string, message: string): Diagnostic {
  return { code, severity: 'error', message,
    subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } };
}
function componentPath(component: OwnedComponent): string | null {
  return 'path' in component ? component.path : null;
}
function contributionDestination(component: OwnedComponent): string | null {
  if ('path' in component) return component.path;
  if (!('locator' in component)) return null;
  if (component.locator.kind === 'claude-permissions') return component.locator.settingsPath;
  if (component.locator.kind === 'cursor-workspace-hook') return component.locator.hooksPath;
  return null;
}
function matchesContribution(component: OwnedComponent, contribution: HostContribution): boolean {
  if ('path' in component) return component.path === contribution.destination
    && (contribution.kind === 'owned-file' && component.kind === 'owned-text-file'
      || contribution.kind === 'owned-directory' && (component.kind === 'owned-directory' || component.kind === 'skill-directory'));
  if (!('locator' in component) || contribution.kind !== 'config-entry') return false;
  if (component.locator.kind === 'claude-permissions') return component.locator.settingsPath === contribution.destination;
  if (component.locator.kind === 'cursor-workspace-hook') return component.locator.hooksPath === contribution.destination
    && component.locator.ownerKey === contribution.mergeKey;
  return false;
}
function belowRoot(root: string | null, destination: string): boolean {
  if (!root) return false;
  const relative = path.relative(root, destination);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sameOwner(binding: DeploymentBinding, component: OwnedComponent): boolean {
  return component.identity.sourceId === binding.plugin.sourceId
    && component.identity.pluginId === binding.plugin.pluginId
    && component.identity.platform === binding.platform;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function exactScope(binding: DeploymentBinding, component: OwnedComponent): boolean {
  return component.identity.scope === binding.scope.kind;
}

/** Selects fixed route operations from observed facts. It performs no I/O. */
export function preparePlatformLifecycle(input: LifecyclePrepareInput): PrepareResult<PlatformDriverState> {
  const { binding, observation, evidence, expected, operation } = input;
  const removing = operation === 'remove' || operation === 'cleanup';
  const retainPackage = !removing && evidence.retainPackage === true;
  const blocked = (code: string, message: string): PrepareResult<PlatformDriverState> => ({
    status: 'blocked', diagnostics: [lifecycleDiagnostic(binding, code, message)],
  });
  if (observation.physicalKey !== binding.physicalKey) {
    return blocked('deploymentEvidenceMismatch', 'The observation does not belong to this deployment. Prepare the operation again.');
  }
  if (!removing && !expected.components.length && expected.unmet.length) {
    return blocked('noSupportedComponents', 'No requested component can be installed. Existing output was kept.');
  }
  const bundles = input.projections.flatMap((projection) => projection.bundle ? [projection.bundle] : []);
  if (bundles.length > 1) return blocked('shared-projection-conflict', 'This deployment has conflicting package projections. Existing output was kept.');
  const allContributions = input.projections.flatMap((projection) => projection.supplements);
  if (!removing && !retainPackage && bundles.length && (observation.ownership === 'foreign' || observation.ownership === 'unknown')) {
    return blocked('deploymentOwnershipUnconfirmed', 'The deployment ownership is not safe for replacement. Check the output and prepare again.');
  }
  if (!removing && expected.components.length && !bundles.length && !allContributions.length) {
    return blocked('platformProjectionEmpty', 'The requested components have no prepared output. Existing output was kept.');
  }
  if (allContributions.length && binding.renderUnitIds.length > 1
    && input.projections.some((projection) => projection.supplements.length > 0 && !evidence.renderUnits?.some((unit) => unit.id === projection.renderUnitId))) {
    return blocked('supplementPhysicalIdentityUnconfirmed', 'A host contribution has no verified physical render unit. Prepare the operation again.');
  }
  if (input.projections.some((projection) => projection.diagnostics.some((item) => item.severity === 'error'))) {
    return blocked('platformProjectionFailed', 'A required projection failed. Existing output was kept.');
  }
  const slots = evidence.ownership;
  if (slots.some((slot) => !sameOwner(binding, slot.component))) {
    return blocked('deploymentOwnerIdentityMismatch', 'An ownership candidate belongs to a different deployment. Prepare the operation again.');
  }
  const packageSlot = slots.find((slot) => componentPath(slot.component) === evidence.layout.packageRoot);
  if (retainPackage && (!packageSlot || !['present', 'partial'].includes(packageSlot.state) || !expected.unmet.length)) {
    return blocked('packageRetentionEvidenceInvalid', 'The package retention evidence is incomplete. Prepare the operation again.');
  }
  if (binding.renderUnitIds.length > 1 && slots.some((slot) => slot !== packageSlot
    && ['present', 'partial'].includes(slot.state) && !slot.physicalKey)) {
    return blocked('supplementPhysicalIdentityUnconfirmed', 'An existing host contribution has no verified physical identity. Prepare the operation again.');
  }
  const identity = evidence.nativeIdentity ?? observation.nativeIdentity;
  if (identity && identity.route !== binding.route) return blocked('nativeIdentityMismatch', 'The native identity belongs to a different installation route.');
  const product = binding.consumers.find((consumer) => consumer.entry?.kind === 'cli' && consumer.availability === 'available') ?? null;
  if (!removing && !retainPackage && bundles.length && nativeRoute(binding.route) && !product) return blocked('clientInstallEntryUnavailable', 'The required native client entry is unavailable. Install or repair the client and retry.');
  if (!removing && !retainPackage && bundles.length && nativeRoute(binding.route) && !identity) return blocked('nativeIdentityUnconfirmed', 'The precise native package identity is unavailable. Prepare the operation again.');
  if (!removing && !retainPackage && bundles.length && binding.scope.kind === 'project' && ['codex-marketplace', 'copilot-marketplace'].includes(binding.route)
    && typeof evidence.userActivationEnabled !== 'boolean') {
    return blocked('nativeActivationEvidenceUnknown', 'The user activation could not be confirmed. Prepare again before changing a project activation.');
  }
  if (binding.route === 'gemini-extension' && (bundles.length || observation.registration !== 'absent')
    && typeof evidence.userActivationEnabled !== 'boolean') {
    return blocked('nativeActivationEvidenceUnknown', 'The global user activation could not be confirmed. Check the extension rules and prepare again.');
  }
  const effects: PlannedEffect[] = [];
  const add = (kind: PlannedEffect['kind'], destination: string, componentIds: string[], destructive = false, slot = '', physicalKey = binding.physicalKey): string => {
    const id = `${binding.id}:${kind}:${slot || destination}`;
    effects.push({ id, kind, physicalKey, activationKey: binding.activationKey,
      componentIds, destination, destructive });
    return id;
  };
  const state: PlatformDriverState = { before: observation, identity, product,
    packageComponent: packageSlot?.component ?? null, bundle: bundles[0] ?? null, contributions: [], removals: [] };
  const retainedGaps: LifecyclePrepareInput['expected']['unmet'] = [];
  const ids = input.projections.filter((projection) => projection.bundle).flatMap((projection) => projection.components.map((component) => component.id));
  const independentContribution = (contribution: HostContribution): boolean => binding.platform === 'codex'
    && contribution.kind !== 'config-entry' && belowRoot(evidence.layout.supplementRoot, contribution.destination)
    && contribution.componentIds.length > 0 && contribution.componentIds.every((id) => expected.components.some((component) => component.id === id && component.kind === 'agent')
      && !expected.unmet.some((gap) => gap.componentId === id || gap.id === id));
  if (retainPackage) {
    const skippedIds = new Set([...ids, ...allContributions.filter((contribution) => !independentContribution(contribution)).flatMap((contribution) => contribution.componentIds)]);
    retainedGaps.push(...expected.components.filter((component) => skippedIds.has(component.id)).map((component) => ({
      id: `package-retained:${binding.id}:${component.id}`, componentId: component.id, kind: component.kind,
      reasonCode: 'packageUpdateBlockedByUnmet', requiredFeatures: [],
    })));
  }
  // Gemini can retain an explicit rule that is currently disabled by a parent.
  const revokeActivation = binding.route === 'gemini-extension'
    || observation.consumers.some((consumer) => consumer.activation === 'enabled' || consumer.activation === 'unknown');
  const hasReferences = evidence.sharedReferences !== 'none';
  const empty = !expected.components.length && !expected.unmet.length;
  if (removing || empty) {
    // Scope-local entries are revoked before any package or native registration.
    if (nativeRoute(binding.route) && identity && observation.registration !== 'absent'
      && (observation.ownership === 'aw' || observation.ownership === 'shared') && revokeActivation) {
      add('deactivate', evidence.layout.activationPath, [], true);
    }
    const removable = slots.filter((slot) => (slot.state === 'present' || slot.state === 'partial')
      && exactScope(binding, slot.component) && slot !== packageSlot);
    for (const slot of removable.filter((item) => !('path' in item.component))) {
      state.removals.push({ effectId: add('remove-owned', contributionDestination(slot.component) ?? evidence.layout.activationPath, [], true, slot.component.identity.artifactKey, slot.physicalKey), component: slot.component });
    }
    if (nativeRoute(binding.route) && identity && !hasReferences && observation.ownership === 'aw'
      && observation.registration === 'present') add('unregister', identity.sourceLocation, [], true);
    for (const slot of removable.filter((item) => 'path' in item.component)) {
      state.removals.push({ effectId: add('remove-owned', componentPath(slot.component)!, [], true, '', slot.physicalKey), component: slot.component });
    }
    if (!hasReferences && packageSlot && (packageSlot.state === 'present' || packageSlot.state === 'partial')
      && observation.ownership === 'aw') {
      state.removals.push({ effectId: add('remove-owned', evidence.layout.packageRoot, [], true), component: packageSlot.component });
    }
  } else {
    const packageChanged = operation === 'reinstall' || !evidence.contentMatches || observation.package !== 'present';
    const nativeCopyChanged = ['gemini-extension', 'grok-cli'].includes(binding.route) && !!state.bundle
      && (observation.nativePackageContentDigest !== state.bundle.contentDigest || binding.route === 'grok-cli'
        && ids.some((id) => !observation.components.some((component) =>
          component.id === id && component.presence === 'present' && !component.reasonCodes.length)));
    if (!retainPackage && state.bundle && (packageChanged || nativeCopyChanged) && binding.route === 'grok-cli'
      && observation.registration === 'present' && !grokRegistrationOwned(binding, evidence, observation, identity)) {
      return blocked('nativeIdentityUnconfirmed', 'The Grok registration is not an exclusive installation from this AW source. Check its identity and shared references before replacement.');
    }
    if (!retainPackage && state.bundle && packageChanged) {
      if (!packageSlot || !['present', 'partial', 'absent'].includes(packageSlot.state)) {
        return blocked('exclusiveOwnerEvidenceInvalid', 'The package slot cannot be safely written. Check ownership and retry.');
      }
      add('publish-package', evidence.layout.packageRoot, ids);
    }
    if (!retainPackage && nativeRoute(binding.route) && state.bundle) {
      if (observation.registration === 'unknown') return blocked('nativeObservationUnknown', 'The native registration could not be observed. Check the client and retry.');
      if (observation.registration === 'absent') add('register', identity!.sourceLocation, ids);
      else if ((packageChanged || nativeCopyChanged) && binding.route !== 'pi-package' && binding.route !== 'copilot-marketplace') {
        add('refresh', identity!.sourceLocation, ids, ['codex-marketplace', 'antigravity-cli', 'grok-cli'].includes(binding.route));
      }
      if (binding.route !== 'pi-package' && (operation === 'reinstall' || packageChanged || nativeCopyChanged || observation.consumers.some((consumer) => consumer.activation !== 'enabled'))) {
        add('activate', evidence.layout.activationPath, ids);
      }
    } else if (!retainPackage && nativeRoute(binding.route) && identity && observation.registration === 'present'
      && (observation.ownership === 'aw' || observation.ownership === 'shared')) {
      // A valid supplement-only set withdraws this binding's previous package.
      // It does not install or register an empty native source.
      if (revokeActivation) add('deactivate', evidence.layout.activationPath, [], true);
      if (!hasReferences && observation.ownership === 'aw') add('unregister', identity.sourceLocation, [], true);
    }
    for (const contribution of allContributions) {
      if (retainPackage && !independentContribution(contribution)) continue;
      const slot = slots.find((candidate) => matchesContribution(candidate.component, contribution));
      if (!slot || !['present', 'partial', 'absent'].includes(slot.state) || !exactScope(binding, slot.component)) {
        return blocked('supplementOwnershipUnconfirmed', 'A host contribution cannot be safely written. Check ownership and retry.');
      }
      if (operation !== 'reinstall' && slot.contentDigest === contribution.contentDigest && slot.state === 'present') continue;
      const projection = input.projections.find((item) => item.supplements.includes(contribution))!;
      const unit = evidence.renderUnits?.find((item) => item.id === projection.renderUnitId);
      state.contributions.push({ effectId: add('write-supplement', contribution.destination, contribution.componentIds, false, contribution.id, slot.physicalKey ?? unit?.physicalKey), contribution, component: slot.component });
    }
    // A complete new set may revoke only precisely owned output in this scope.
    for (const slot of slots) {
      if (slot === packageSlot || !['present', 'partial'].includes(slot.state) || !exactScope(binding, slot.component)) continue;
      // Missing contributions in an unmet set can still be required. Preserve
      // them even when this deployment has no native package to retain.
      if (retainPackage || expected.unmet.length) continue;
      const destination = contributionDestination(slot.component);
      if (!destination || allContributions.some((item) => matchesContribution(slot.component, item))) continue;
      state.removals.push({ effectId: add('remove-owned', destination, [], true, slot.component.identity.artifactKey, slot.physicalKey), component: slot.component });
    }
    if (!retainPackage && !state.bundle && !hasReferences && packageSlot && ['present', 'partial'].includes(packageSlot.state)
      && observation.ownership === 'aw') {
      state.removals.push({ effectId: add('remove-owned', evidence.layout.packageRoot, [], true), component: packageSlot.component });
    }
  }
  const frozenExpected = retainedGaps.length ? { ...expected, unmet: [...expected.unmet, ...retainedGaps] } : expected;
  const plan: FrozenDeploymentPlan = { binding, operation, expected: frozenExpected, projections: input.projections, effects, evidence };
  // Clone before freezing so prepare cannot freeze or mutate a caller's inputs.
  return { status: 'ready', prepared: freeze(structuredClone({ plan, driverState: state })) };
}

/** The caller supplies these services only while it holds the existing AW_HOME lock. */
export async function executePlatformLifecycle(ctx: MutationContext,
  prepared: PreparedDeployment<PlatformDriverState>): Promise<DeploymentReceipt> {
  const { plan, driverState: state } = prepared;
  const { binding } = plan;
  const receipt: DeploymentReceipt = { bindingId: binding.id, effects: [], after: state.before,
    unmet: plan.expected.unmet.map((gap) => ({ ...gap, productIds: binding.consumers.map((item) => item.id) })),
    reload: 'none', diagnostics: [] };
  const observe = async (): Promise<DeploymentObservation> => {
    try { return await (ctx.inspect ? ctx.inspect(binding) : inspectDeployment(ctx, binding)); }
    catch { return { ...state.before, package: 'unknown', registration: 'unknown', consumers: state.before.consumers.map((item) => ({ ...item, activation: 'unknown', load: 'unknown' })),
      diagnostics: [lifecycleDiagnostic(binding, 'deploymentPostcheckFailed', 'The final deployment state could not be observed. Check status before retrying.')] }; }
  };
  let evidenceValid = false;
  try { evidenceValid = await ctx.services.verifyEvidence(plan); } catch { /* Unreadable evidence is stale. */ }
  if (!evidenceValid) {
    const diagnostic = lifecycleDiagnostic(binding, 'operationPlanStale', 'The deployment evidence changed. Prepare and confirm a new operation.');
    receipt.diagnostics.push(diagnostic);
    receipt.effects = plan.effects.map((effect) => ({ id: effect.id, status: 'blocked', mutation: 'none', diagnostics: [diagnostic] }));
    receipt.after = await observe();
    return receipt;
  }
  let packageReady = true;
  let nativeReady = true;
  let nativeRemoved = !nativeRoute(binding.route) || state.before.registration === 'absent';
  let activationRemoved = true;
  for (const effect of plan.effects) {
    const result: DeploymentReceipt['effects'][number] = { id: effect.id, status: 'skipped', mutation: 'none', diagnostics: [] };
    receipt.effects.push(result);
    const removal = state.removals.find((item) => item.effectId === effect.id);
    const contribution = state.contributions.find((item) => item.effectId === effect.id);
    const packageRemoval = removal && componentPath(removal.component) === plan.evidence.layout.packageRoot;
    const dependencyFailed = !packageReady && ['register', 'refresh', 'activate'].includes(effect.kind)
      || !nativeReady && effect.kind === 'activate'
      || !packageReady && contribution?.contribution.kind === 'config-entry'
      || removal && (plan.operation === 'ensure' || plan.operation === 'reinstall') && (!packageReady || !nativeReady)
      || packageRemoval && (!nativeRemoved || !activationRemoved);
    if (ctx.signal?.aborted || dependencyFailed) {
      result.diagnostics.push(lifecycleDiagnostic(binding, ctx.signal?.aborted ? 'operationInterrupted' : 'deploymentDependencyFailed',
        ctx.signal?.aborted ? 'The operation was interrupted. Check status before retrying.' : 'A required deployment action failed. The dependent action was skipped.'));
      for (const componentId of effect.componentIds) {
        const component = plan.expected.components.find((item) => item.id === componentId);
        if (component) receipt.unmet.push({ id: `execution:${effect.id}:${componentId}`, componentId, kind: component.kind,
          reasonCode: ctx.signal?.aborted ? 'operationInterrupted' : 'deploymentDependencyFailed', requiredFeatures: [],
          productIds: binding.consumers.map((item) => item.id) });
      }
      continue;
    }
    let started = false;
    try {
      started = true;
      let outcome;
      if (effect.kind === 'publish-package') {
        outcome = await ctx.services.publishPackage(binding, state.bundle!, effect.destination, state.packageComponent!);
      } else if (contribution) {
        outcome = await ctx.services.writeContribution(binding, contribution.contribution, contribution.component);
      } else if (removal) {
        outcome = await ctx.services.removeOwned(binding, removal.component);
      } else {
        outcome = await executeNativeLifecycle(ctx, prepared, effect);
      }
      result.mutation = outcome.mutation;
      result.status = outcome.mutation === 'possible' ? 'unknown' : outcome.changed ? 'applied' : 'unchanged';
      if (outcome.mutation === 'possible') throw Object.assign(new Error('nativeMutationUnknown'), { mutation: 'possible' });
      if (binding.route === 'grok-cli' && (effect.kind === 'register' || effect.kind === 'refresh')) {
        const checked = await observe();
        if (checked.physicalKey !== binding.physicalKey || checked.registration !== 'present' || checked.ownership !== 'aw'
          || !state.bundle || checked.nativePackageContentDigest !== state.bundle.contentDigest) {
          throw Object.assign(new Error('nativeInstallContentPostcheckFailed'), { mutation: 'possible' });
        }
      }
      if (effect.kind === 'unregister') {
        if (binding.platform === 'codex') ctx.codexObservationSession?.invalidate(plan.evidence.layout.marketplaceName ?? undefined);
        const checked = await observe();
        if (checked.physicalKey !== binding.physicalKey || checked.registration !== 'absent') {
          throw Object.assign(new Error('nativeUnregisterPostcheckFailed'), { mutation: 'possible' });
        }
        nativeRemoved = true;
      }
      if (effect.kind === 'deactivate') activationRemoved = true;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const mutation = error && typeof error === 'object' && 'mutation' in error ? error.mutation : undefined;
      const consentCode = binding.route === 'gemini-extension' && Object.hasOwn(geminiConsentMessages, code)
        ? code as keyof typeof geminiConsentMessages : undefined;
      const replacementCode = binding.route === 'gemini-extension' && Object.hasOwn(geminiReplacementMessages, code)
        ? code as keyof typeof geminiReplacementMessages : undefined;
      const geminiCode = consentCode ?? replacementCode;
      const definite = !(binding.route === 'gemini-extension' && mutation === 'confirmed')
        && (code === 'clientInstallEntryUnavailable' || code === 'nativeIdentityUnconfirmed' || code === 'nativeTrustRequired');
      result.mutation = mutation === 'none' || definite ? 'none' : mutation === 'confirmed' ? 'confirmed' : started ? 'possible' : 'none';
      result.status = definite || (geminiCode !== undefined && result.mutation === 'none') ? 'blocked' : result.mutation === 'possible' ? 'unknown' : 'failed';
      const geminiMessage = consentCode ? geminiConsentMessages[consentCode] : replacementCode ? geminiReplacementMessages[replacementCode] : undefined;
      const failureDiagnostic = lifecycleDiagnostic(binding, geminiCode ?? (code === 'operationPlanStale' ? code : definite ? code : 'platformMutationFailed'),
        geminiMessage ? `${geminiMessage} In the same workspace, review and run aw plugin sync ${binding.plugin.pluginId} --context ${binding.scope.kind} --target gemini --native-consent.`
          : definite ? 'A required native identity, client entry, or host trust is unavailable. Complete it in the host and retry.' : 'A platform action did not complete. Check status and retry the remaining actions.');
      result.diagnostics.push(failureDiagnostic);
      if (geminiCode) receipt.diagnostics.push(failureDiagnostic);
      if (binding.route === 'grok-cli' && (effect.kind === 'register' || effect.kind === 'refresh')
        && (!definite || code === 'nativeTrustRequired')) {
        result.diagnostics.push(lifecycleDiagnostic(binding, 'grokNativeInstallRecovery',
          `The Grok installation may be missing or stale. The AW source package is kept. With the same Grok client and configuration root, use arguments ${JSON.stringify(['plugin', 'install', plan.evidence.layout.packageRoot, '--trust'])}; --trust grants Grok plugin trust. Then run aw plugin sync ${binding.plugin.pluginId} --context user --target grok.`));
      }
      if (effect.kind === 'publish-package') packageReady = false;
      if (effect.kind === 'register' || effect.kind === 'refresh') nativeReady = false;
      if (effect.kind === 'deactivate') activationRemoved = false;
      if (removal && !('path' in removal.component)) activationRemoved = false;
      for (const componentId of effect.componentIds) {
        const component = plan.expected.components.find((item) => item.id === componentId);
        if (component) receipt.unmet.push({ id: `execution:${effect.id}:${componentId}`, componentId, kind: component.kind,
          reasonCode: geminiCode ?? (result.status === 'unknown' ? 'platformMutationUnknown' : 'platformMutationFailed'), requiredFeatures: [], productIds: binding.consumers.map((item) => item.id) });
      }
    }
  }
  if (binding.platform === 'codex' && receipt.effects.some((effect) => effect.mutation !== 'none')) {
    ctx.codexObservationSession?.invalidate(plan.evidence.layout.marketplaceName ?? undefined);
  }
  receipt.after = await observe();
  const grokContentReady = binding.route !== 'grok-cli' || receipt.after.ownership === 'aw'
    && !!state.bundle && receipt.after.nativePackageContentDigest === state.bundle.contentDigest
    && plan.projections.filter((projection) => projection.bundle).flatMap((projection) => projection.components).every((component) =>
      receipt.after.components.some((observed) => observed.id === component.id && observed.presence === 'present' && !observed.reasonCodes.length));
  const nativeContentReady = grokContentReady && (binding.route !== 'gemini-extension'
    || receipt.after.ownership === 'aw' && !!state.bundle && receipt.after.nativePackageContentDigest === state.bundle.contentDigest);
  for (const result of receipt.effects) {
    if (result.status !== 'applied') continue;
    const effect = plan.effects.find((item) => item.id === result.id)!;
    const incomplete = (effect.kind === 'register' || effect.kind === 'refresh') && (receipt.after.registration !== 'present' || !nativeContentReady)
      || effect.kind === 'activate' && receipt.after.consumers.some((item) => item.activation !== 'enabled');
    if (incomplete) {
      result.status = receipt.after.registration === 'unknown' || receipt.after.consumers.some((item) => item.activation === 'unknown')
        || binding.route === 'grok-cli' && receipt.after.components.some((component) => component.presence === 'unknown') ? 'unknown' : 'failed';
      const code = binding.route === 'gemini-extension' && !nativeContentReady ? 'nativeInstallContentPostcheckFailed' : 'nativeMutationPostcheckFailed';
      const diagnostic = lifecycleDiagnostic(binding, code, code === 'nativeInstallContentPostcheckFailed'
        ? `${geminiReplacementMessages.nativeInstallContentPostcheckFailed} In the same workspace, review and run aw plugin sync ${binding.plugin.pluginId} --context ${binding.scope.kind} --target gemini --native-consent.`
        : 'The native command completed, but the final state does not confirm the requested result. Check status before retrying.');
      result.diagnostics.push(diagnostic);
      if (code === 'nativeInstallContentPostcheckFailed') receipt.diagnostics.push(diagnostic);
      for (const componentId of effect.componentIds) {
        const component = plan.expected.components.find((item) => item.id === componentId);
        if (component) receipt.unmet.push({ id: `execution:${effect.id}:${componentId}`, componentId, kind: component.kind,
          reasonCode: code, requiredFeatures: [], productIds: binding.consumers.map((item) => item.id) });
      }
    }
  }
  // A bounded postcheck can resolve uncertain native effects. File publication
  // still requires byte evidence; mere existence cannot confirm those effects.
  for (const result of receipt.effects) {
    if (result.status !== 'unknown' || receipt.after.ownership !== 'aw') continue;
    const effect = plan.effects.find((item) => item.id === result.id)!;
    const exactIdentity = state.identity && receipt.after.nativeIdentity
      && state.identity.packageId === receipt.after.nativeIdentity.packageId
      && (state.identity.registrationId === receipt.after.nativeIdentity.registrationId || binding.route === 'grok-cli')
      && state.identity.sourceLocation === receipt.after.nativeIdentity.sourceLocation;
    const verified = exactIdentity && (effect.kind === 'register' && state.before.registration === 'absent' && receipt.after.registration === 'present' && nativeContentReady
      || effect.kind === 'unregister' && state.before.registration === 'present' && receipt.after.registration === 'absent'
      || effect.kind === 'activate' && state.before.consumers.some((item) => item.activation === 'disabled')
        && receipt.after.consumers.length > 0 && receipt.after.consumers.every((item) => item.activation === 'enabled')
      || effect.kind === 'deactivate' && state.before.consumers.some((item) => item.activation === 'enabled')
        && receipt.after.consumers.length > 0 && receipt.after.consumers.every((item) => item.activation === 'disabled'));
    if (verified) {
      result.status = 'applied';
      result.mutation = 'confirmed';
      result.diagnostics = [{ ...lifecycleDiagnostic(binding, 'nativeMutationConfirmedByPostcheck', 'The native command did not complete normally. The final state confirms this action.'), severity: 'warning' }];
      const gapPrefix = `execution:${effect.id}:`;
      receipt.unmet = receipt.unmet.filter((gap) => !gap.id.startsWith(gapPrefix));
      const sharedKey = nativeLifecycleEffectKey(binding, effect);
      if (sharedKey) ctx.nativeEffects?.set(sharedKey, Promise.resolve({ mutation: 'confirmed', changed: true }));
    }
  }
  if ((plan.operation === 'ensure' || plan.operation === 'reinstall') && plan.expected.components.length) {
    const untrusted = receipt.after.consumers.filter((consumer) => consumer.trust === 'required' || consumer.trust === 'blocked');
    if (untrusted.length) {
      receipt.diagnostics.push(lifecycleDiagnostic(binding, 'nativeTrustRequired',
        'The package was prepared, but the host has not trusted this deployment. Complete trust in the host and retry.'));
      const productIds = untrusted.map((consumer) => consumer.productId);
      for (const component of plan.expected.components) receipt.unmet.push({
        id: `trust:${binding.id}:${component.id}`, componentId: component.id, kind: component.kind,
        requiredFeatures: [], reasonCode: 'nativeTrustRequired', productIds,
      });
    }
  }
  if (receipt.effects.some((effect) => effect.mutation !== 'none')) receipt.reload = routeReload(binding.route);
  receipt.diagnostics.push(...receipt.after.diagnostics);
  return receipt;
}
