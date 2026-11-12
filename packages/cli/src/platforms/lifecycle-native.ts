import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { NativeCliError, runNativeCliChecked } from '../utils/native-cli.js';
import { installationInvocation } from './discovery.js';
import type { DeploymentBinding, DeploymentObservation, DeploymentReceipt, InstallRoute, MutationContext, MutationOutcome, NativeIdentity, PlannedEffect, PreparationEvidence, PreparedDeployment } from './contracts.js';
import type { PlatformDriverState } from './lifecycle.js';
import { inspectDeployment } from './inspection.js';

export function nativeRoute(route: InstallRoute): boolean {
  return ['codex-marketplace', 'claude-marketplace', 'antigravity-cli', 'pi-package',
    'gemini-extension', 'copilot-marketplace', 'grok-cli'].includes(route);
}
export function routeReload(route: InstallRoute): DeploymentReceipt['reload'] {
  if (route === 'generic-skills') return 'none';
  if (route === 'cursor-workspace-hook') return 'workspace-reload';
  return 'new-session';
}
function blocked(code: string): never {
  throw Object.assign(new Error(code), { code, mutation: 'none' });
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
  const run = async (args: string[]): Promise<void> => {
    if (!product) blocked('clientInstallEntryUnavailable');
    const invocation = await installationInvocation(product, { ...ctx, cwd }, args);
    try {
      await runNativeCliChecked({ ...invocation, timeoutMs: Math.max(60_000, DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS) }, ctx.runner);
      confirmed = true;
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
    if (enabled && before.consumers.some((consumer) => consumer.trust === 'required' || consumer.trust === 'blocked')) {
      blocked('nativeTrustRequired');
    }
    if (binding.route === 'gemini-extension') {
      await run(['extensions', enabled ? 'enable' : 'disable', identity.packageId, '--scope', binding.scope.kind === 'project' ? 'Workspace' : 'User']);
    } else if (binding.route === 'claude-marketplace') {
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
    case 'antigravity-cli':
      if (effect.kind === 'unregister' || effect.kind === 'refresh') await run(['plugin', 'uninstall', identity.packageId]);
      if (effect.kind !== 'unregister') await run(['plugin', 'install', evidence.layout.packageRoot]);
      break;
    case 'pi-package':
      await run([effect.kind === 'unregister' ? 'remove' : 'install', ...(binding.scope.kind === 'project' ? ['--local'] : []), identity.sourceLocation]);
      break;
    case 'gemini-extension':
      if (effect.kind === 'unregister') await run(['extensions', 'uninstall', identity.packageId]);
      else if (effect.kind === 'refresh') await run(['extensions', 'update', identity.packageId]);
      else {
        if (binding.scope.kind === 'project') blocked('nativeScopeIsolationUnverified');
        await run(['extensions', 'install', evidence.layout.packageRoot]);
      }
      break;
    case 'copilot-marketplace':
      await run(['plugin', effect.kind === 'unregister' ? 'uninstall' : 'install', id]);
      if (effect.kind !== 'unregister') {
        const outcome = await ctx.services.setActivation(binding, identity, true);
        if (outcome.mutation === 'possible') throw Object.assign(new Error('activationUnknown'), { mutation: 'possible' });
      }
      break;
    case 'grok-cli':
      // --trust is host authorization and is never inferred from AW --yes.
      if (effect.kind !== 'unregister' && (!before.consumers.length
        || binding.consumers.some((product) => !before.consumers.some((consumer) => consumer.productId === product.id && consumer.trust === 'trusted')))) blocked('nativeTrustRequired');
      if (effect.kind === 'unregister' || effect.kind === 'refresh') {
        const current = await (ctx.inspect ? ctx.inspect(binding) : inspectDeployment(ctx, binding));
        if (!grokRegistrationOwned(binding, evidence, current, identity)) blocked('nativeIdentityUnconfirmed');
        await run(['plugin', 'uninstall', identity.packageId, '--confirm']);
      }
      // Local update can leave an old copy while claiming it is a live symlink.
      // The reviewed refresh uses native uninstall/install and retains the AW source on failure.
      if (effect.kind !== 'unregister') await run(['plugin', 'install', evidence.layout.packageRoot, '--trust']);
      break;
    default: blocked('nativeRouteUnsupported');
  }
  return { mutation: confirmed ? 'confirmed' : 'none', changed: confirmed };
}
