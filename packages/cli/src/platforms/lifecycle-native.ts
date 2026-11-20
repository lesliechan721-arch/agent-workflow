import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { NativeCliError, runNativeCliChecked, type NativeCliResult } from '../utils/native-cli.js';
import { installationInvocation } from './discovery.js';
import type { DeploymentBinding, DeploymentObservation, DeploymentReceipt, FrozenDeploymentPlan, InstallRoute, MutationContext, MutationOutcome, NativeIdentity, PlannedEffect, PreparationEvidence, PreparedDeployment } from './contracts.js';
import type { PlatformDriverState } from './lifecycle.js';
import { inspectDeployment, selectedNativeConsumer } from './inspection.js';

export function nativeRoute(route: InstallRoute): boolean {
  return ['codex-marketplace', 'claude-marketplace', 'antigravity-cli', 'pi-package',
    'copilot-marketplace', 'grok-cli'].includes(route);
}
export function routeReload(route: InstallRoute): DeploymentReceipt['reload'] {
  if (route === 'generic-skills') return 'none';
  if (route === 'cursor-workspace-hook') return 'workspace-reload';
  return 'new-session';
}
function blocked(code: string): never {
  throw Object.assign(new Error(code), { code, mutation: 'none' });
}

/** A valid list can hide an empty or untrusted Project scope. Query failures cannot. */
export function piProjectRegistrationHidden(binding: DeploymentBinding, observation: DeploymentObservation): boolean {
  return binding.route === 'pi-package' && binding.scope.kind === 'project'
    && binding.consumers.length > 0
    && observation.physicalKey === binding.physicalKey && observation.registration === 'unknown'
    && observation.diagnostics.some((diagnostic) => diagnostic.code === 'piProjectRegistrationNotVisible')
    && !observation.diagnostics.some((diagnostic) => ['piNativeObservationUnconfirmed', 'deploymentPostcheckFailed'].includes(diagnostic.code));
}

export function piProjectEmptyDeliveryObserved(binding: DeploymentBinding, observation: DeploymentObservation): boolean {
  return piProjectRegistrationHidden(binding, observation) && observation.package === 'absent'
    && observation.ownership === 'absent' && observation.configuration?.activation === 'absent';
}

/** Action success does not rewrite the later read-only registration observation. */
export function piProjectRemovalConfirmed(plan: FrozenDeploymentPlan, receipt: DeploymentReceipt): boolean {
  return receipt.bindingId === plan.binding.id && piProjectRegistrationHidden(plan.binding, receipt.after)
    && plan.effects.some((effect) => effect.kind === 'unregister' && receipt.effects.some((result) =>
      result.id === effect.id && result.status === 'applied' && result.mutation === 'confirmed'));
}

/** Grok uninstall can remove a whole repository, so the exact registration must be exclusive. */
export function grokRegistrationOwned(binding: DeploymentBinding, evidence: PreparationEvidence,
  before: DeploymentObservation, identity: NativeIdentity | null): boolean {
  return binding.route === 'grok-cli' && binding.scope.kind === 'user' && before.registration === 'present'
    && before.physicalKey === binding.physicalKey
    && before.ownership === 'aw' && evidence.sharedReferences === 'none' && identity?.route === binding.route
    && identity.sourceLocation === evidence.layout.packageRoot && !!identity.registrationId
    && before.nativeIdentity?.packageId === identity.packageId
    && before.nativeIdentity.registrationId === identity.registrationId
    && before.nativeIdentity.sourceLocation === identity.sourceLocation;
}

/** Claude registrations are scoped; the other native registration routes are physical-package scoped. */
export function nativeLifecycleEffectKey(binding: DeploymentBinding, effect: PlannedEffect): string | null {
  if (!['register', 'refresh', 'unregister'].includes(effect.kind)) return null;
  return JSON.stringify([binding.route, binding.physicalKey, effect.kind,
    binding.route === 'claude-marketplace' || binding.route === 'pi-package' ? binding.activationKey : null]);
}

export async function executeNativeLifecycle(ctx: MutationContext,
  prepared: PreparedDeployment<PlatformDriverState>, effect: PlannedEffect): Promise<MutationOutcome> {
  const key = nativeLifecycleEffectKey(prepared.plan.binding, effect);
  if (!key || !ctx.nativeEffects) return executeNativeLifecycleEffect(ctx, prepared, effect);
  let outcome = ctx.nativeEffects.get(key);
  if (!outcome) {
    outcome = executeNativeLifecycleEffect(ctx, prepared, effect);
    ctx.nativeEffects.set(key, outcome);
  }
  return outcome;
}

/** Native verbs are fixed by the adapter, never supplied by a renderer. */
async function executeNativeLifecycleEffect(ctx: MutationContext,
  prepared: PreparedDeployment<PlatformDriverState>, effect: PlannedEffect): Promise<MutationOutcome> {
  const { binding, evidence } = prepared.plan;
  const { identity, product, before } = prepared.driverState;
  if (!identity) blocked('nativeIdentityUnconfirmed');
  if (!product && !(effect.kind === 'deactivate' && binding.route === 'codex-marketplace')) blocked('clientInstallEntryUnavailable');
  const scope = binding.scope.kind === 'user' ? 'user' : 'local';
  const cwd = binding.scope.kind === 'project' ? binding.scope.projectRoot : ctx.cwd;
  const id = identity.registrationId ?? identity.packageId;
  let confirmed = false;
  const run = async (args: string[]): Promise<NativeCliResult> => {
    if (!product) blocked('clientInstallEntryUnavailable');
    const invocation = await installationInvocation(product, { ...ctx, cwd }, args);
    try {
      const result = await runNativeCliChecked({ ...invocation, timeoutMs: Math.max(60_000, DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS) }, ctx.runner);
      confirmed = true;
      return result;
    } catch (error) {
      // A non-zero exit does not prove that a third-party CLI made no changes.
      if (error instanceof NativeCliError && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        throw Object.assign(error, { mutation: confirmed ? 'confirmed' : 'none' });
      }
      throw Object.assign(error instanceof Error ? error : new Error('nativeMutationFailed'), { mutation: 'possible' });
    }
  };
  const activation = async (enabled: boolean): Promise<MutationOutcome> => {
    if (binding.route === 'codex-marketplace' || binding.route === 'copilot-marketplace') {
      return ctx.services.setActivation(binding, identity, enabled);
    }
    if (binding.route === 'pi-package') return { mutation: 'none', changed: false };
    if (enabled && binding.route === 'grok-cli' && before.grokScopeAuthorization === 'denied') {
      blocked('nativeTrustRequired');
    }
    if (binding.route === 'claude-marketplace') {
      // Install already enables this scope. Claude rejects a repeated enable,
      // so confirm the current owned registration before invoking the verb.
      const current = await (ctx.inspect ? ctx.inspect(binding) : inspectDeployment(ctx, binding));
      if (current.physicalKey === binding.physicalKey && current.ownership === 'aw'
        && current.registration === 'present' && current.nativeIdentity !== null && current.nativeIdentity.registrationId === identity.registrationId
        && current.nativeIdentity.sourceLocation === identity.sourceLocation
        && (enabled ? selectedNativeConsumer(binding, current)?.activation === 'enabled'
          : binding.consumers.length > 0 && current.consumers.length === binding.consumers.length
            && binding.consumers.every((consumer) => current.consumers.filter((observed) => observed.productId === consumer.id
              && observed.activation === 'disabled').length === 1))) {
        return { mutation: 'none', changed: false };
      }
      await run(['plugin', enabled ? 'enable' : 'disable', id, '--scope', scope]);
    } else {
      await run(['plugin', enabled ? 'enable' : 'disable', identity.packageId]);
    }
    return { mutation: 'confirmed', changed: true };
  };
  if (effect.kind === 'activate' || effect.kind === 'deactivate') return activation(effect.kind === 'activate');
  if (effect.kind === 'register' && ['codex-marketplace', 'claude-marketplace', 'copilot-marketplace'].includes(binding.route)) {
    const outcome = await ctx.services.registerMarketplace(binding, identity);
    confirmed = outcome.mutation === 'confirmed';
    if (outcome.mutation === 'possible') throw Object.assign(new Error('marketplaceRegistrationUnknown'), { mutation: 'possible' });
  }
  switch (binding.route) {
    case 'codex-marketplace':
      if (effect.kind === 'unregister') await run(['plugin', 'remove', id]);
      else {
        if (effect.kind === 'refresh') await run(['plugin', 'remove', id]);
        await run(['plugin', 'add', id]);
        // Native add enables the user scope. Restore the reviewed activation immediately.
        const outcome = await ctx.services.setActivation(binding, identity, true);
        if (outcome.mutation === 'possible') throw Object.assign(new Error('activationUnknown'), { mutation: 'possible' });
      }
      break;
    case 'claude-marketplace':
      await run(['plugin', effect.kind === 'unregister' ? 'uninstall' : effect.kind === 'refresh' ? 'update' : 'install', id, '--scope', scope]);
      break;
    case 'antigravity-cli': {
      if (effect.kind === 'unregister' || effect.kind === 'refresh') {
        const current = await (ctx.inspect ? ctx.inspect(binding) : inspectDeployment(ctx, binding));
        if (current.physicalKey !== binding.physicalKey || current.registration !== 'present' || current.ownership !== 'aw'
          || !current.nativePackageContentDigest || evidence.sharedReferences !== 'none'
          || current.nativeIdentity?.packageId !== identity.packageId || current.nativeIdentity.sourceLocation !== identity.sourceLocation) {
          blocked('nativeIdentityUnconfirmed');
        }
      }
      // Fixed 1.3.4 install refreshes both version changes and same-version bytes.
      await run(effect.kind === 'unregister' ? ['plugin', 'uninstall', identity.packageId]
        : ['plugin', 'install', evidence.layout.packageRoot]);
      break;
    }
    case 'pi-package': {
      const result = await run([effect.kind === 'unregister' ? 'remove' : 'install', ...(binding.scope.kind === 'project' ? ['--local'] : []), identity.sourceLocation]);
      if (effect.kind === 'unregister' && binding.scope.kind === 'project'
        && !result.stderr.trim() && result.stdout.replace(/\u001b\[[0-9;]*m/gu, '').replace(/\r\n/gu, '\n').trimEnd()
          === `Removing ${identity.sourceLocation}...\nRemoved ${identity.sourceLocation}`) {
        return { mutation: 'confirmed', changed: true, unregisterConfirmed: true };
      }
      break;
    }
    case 'copilot-marketplace':
      await run(['plugin', effect.kind === 'unregister' ? 'uninstall' : 'install', id]);
      if (effect.kind !== 'unregister') {
        const outcome = await ctx.services.setActivation(binding, identity, true);
        if (outcome.mutation === 'possible') throw Object.assign(new Error('activationUnknown'), { mutation: 'possible' });
      }
      break;
    case 'grok-cli':
      // projectTrusted reports folder/runtime trust, not consent to a new source.
      // Only an existing exact, exclusive native registration can be refreshed
      // with --trust. First install and recovery require explicit host consent.
      if (effect.kind === 'register') blocked('nativeTrustRequired');
      if (effect.kind !== 'unregister' && before.grokScopeAuthorization !== 'granted') blocked('nativeTrustRequired');
      if (effect.kind === 'unregister' || effect.kind === 'refresh') {
        const current = await (ctx.inspect ? ctx.inspect(binding) : inspectDeployment(ctx, binding));
        if (!grokRegistrationOwned(binding, evidence, current, identity)) blocked('nativeIdentityUnconfirmed');
        if (effect.kind === 'refresh' && current.grokScopeAuthorization !== 'granted') blocked('nativeTrustRequired');
        await run(['plugin', 'uninstall', identity.packageId, '--confirm', ...(effect.kind === 'refresh' ? ['--keep-data'] : [])]);
      }
      // Local update can leave an old copy while claiming it is a live symlink.
      // Refresh preserves native plugin data and retains the AW source on failure.
      if (effect.kind !== 'unregister') await run(['plugin', 'install', evidence.layout.packageRoot, '--trust']);
      break;
    default: blocked('nativeRouteUnsupported');
  }
  return { mutation: confirmed ? 'confirmed' : 'none', changed: confirmed };
}
