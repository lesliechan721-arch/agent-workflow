import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { NativeCliError, runNativeCliChecked, type NativeCliInput } from '../utils/native-cli.js';
import { installationInvocation } from './discovery.js';
import type { DeploymentBinding, DeploymentObservation, DeploymentReceipt, InstallRoute, MutationContext, MutationOutcome, NativeIdentity, PlannedEffect, PreparationEvidence, PreparedDeployment } from './contracts.js';
import type { PlatformDriverState } from './lifecycle.js';
import { inspectDeployment } from './inspection.js';
import { assertGeminiNativeOwner, assertGeminiProjectRules, assertGeminiRefreshSource, assertGeminiReplacementContent,
  finishGeminiNativeMutation, geminiActivationEvidence, geminiActivationRules, geminiRefreshNeedsReplacement,
  readGeminiActivationSnapshot, restoreGeminiReplacementActivation } from './gemini-activation.js';
import { geminiConsentInput } from './gemini-consent.js';

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
  const run = async (args: string[], input?: NativeCliInput): Promise<void> => {
    if (!product) blocked('clientInstallEntryUnavailable');
    const invocation = await installationInvocation(product, { ...ctx, cwd }, args);
    try {
      await runNativeCliChecked({ ...invocation, ...(input ? { input } : {}), timeoutMs: Math.max(60_000, DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS) }, ctx.runner);
      confirmed = true;
    } catch (error) {
      if (input && error instanceof NativeCliError
        && (error.cause as { code?: string } | undefined)?.code === 'nativeConsentPromptUnsupported') {
        throw Object.assign(error, { code: 'nativeConsentPromptUnsupported', mutation: 'possible' });
      }
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
      return ctx.services.setActivation(binding, identity, enabled);
    } else if (binding.route === 'claude-marketplace') {
      // Install already enables this scope. Claude rejects a repeated enable,
      // so confirm the current owned registration before invoking the verb.
      const current = await (ctx.inspect ? ctx.inspect(binding) : inspectDeployment(ctx, binding));
      if (current.physicalKey === binding.physicalKey && current.ownership === 'aw'
        && current.registration === 'present' && current.nativeIdentity !== null && current.nativeIdentity.registrationId === identity.registrationId
        && current.nativeIdentity.sourceLocation === identity.sourceLocation
        && binding.consumers.length > 0 && current.consumers.length === binding.consumers.length
        && binding.consumers.every((consumer) => current.consumers.filter((observed) => observed.productId === consumer.id
          && observed.activation === (enabled ? 'enabled' : 'disabled')).length === 1)) {
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
    case 'pi-package':
      await run([effect.kind === 'unregister' ? 'remove' : 'install', ...(binding.scope.kind === 'project' ? ['--local'] : []), identity.sourceLocation]);
      break;
    case 'gemini-extension': {
      if (effect.kind === 'register' || effect.kind === 'refresh') {
        if (ctx.geminiNativeConsent !== prepared.plan) blocked('nativeConsentRequired');
        if (product?.version !== '0.67.0') blocked('nativeConsentVersionUnsupported');
      }
      if (!ctx.geminiActivationSnapshot) blocked('nativeActivationEvidenceUnknown');
      const snapshot = await readGeminiActivationSnapshot(ctx, ctx.geminiActivationSnapshot);
      await assertGeminiProjectRules(ctx, binding, geminiActivationRules(snapshot, identity.packageId));
      if (effect.kind !== 'register' && effect.kind !== 'refresh' && effect.kind !== 'unregister') blocked('nativeRouteUnsupported');
      const replace = effect.kind === 'refresh'
        ? await geminiRefreshNeedsReplacement(ctx, binding, identity, evidence, before) : false;
      if (effect.kind === 'unregister') await assertGeminiNativeOwner(ctx, binding, identity, evidence);
      await readGeminiActivationSnapshot(ctx, ctx.geminiActivationSnapshot);
      if (effect.kind === 'unregister') await run(['extensions', 'uninstall', identity.packageId]);
      else if (replace) {
        await assertGeminiRefreshSource(prepared.plan);
        const step = async (kind: 'register' | 'unregister', args: string[], input?: NativeCliInput): Promise<void> => {
          let nativeError: unknown;
          try { await run(args, input); } catch (error) { nativeError = error; }
          // Keep all reviewed activations even if a fixed native step changed
          // its config before failing. Unexpected changes remain stale.
          try { await restoreGeminiReplacementActivation(ctx, identity, kind, snapshot, nativeError !== undefined); }
          catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error('nativeActivationRestoreFailed'),
              { mutation: confirmed ? 'confirmed' : (nativeError as { mutation?: string } | undefined)?.mutation === 'none' ? 'none' : 'possible' });
          }
          Object.assign(ctx.geminiActivationSnapshot!, geminiActivationEvidence(snapshot));
          if (nativeError !== undefined) throw nativeError;
        };
        try {
          await step('unregister', ['extensions', 'uninstall', identity.packageId]);
          await assertGeminiRefreshSource(prepared.plan);
          await step('register', ['extensions', 'install', evidence.layout.packageRoot, '--consent', '--skip-settings'],
            geminiConsentInput('register', evidence.layout.packageRoot, cwd, identity.packageId));
          await assertGeminiReplacementContent(ctx, prepared.plan, identity);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error('nativeMutationFailed');
          if (!('code' in failure)) Object.assign(failure, { code: 'nativeInstallContentPostcheckFailed' });
          throw Object.assign(failure,
            { mutation: confirmed ? 'confirmed' : (error as { mutation?: string })?.mutation === 'none' ? 'none' : 'possible' });
        }
      } else if (effect.kind === 'refresh') await run(['extensions', 'update', identity.packageId],
        geminiConsentInput('refresh', evidence.layout.packageRoot, cwd, identity.packageId));
      else await run(['extensions', 'install', evidence.layout.packageRoot, '--consent', '--skip-settings'],
        geminiConsentInput('register', evidence.layout.packageRoot, cwd, identity.packageId));
      try {
        await finishGeminiNativeMutation(ctx, evidence, binding, identity, effect.kind, snapshot);
        Object.assign(ctx.geminiActivationSnapshot, geminiActivationEvidence(snapshot));
      } catch (error) {
        // The host already changed its package. Keep extra configuration changes
        // and report the partial action rather than overwriting a stale snapshot.
        throw Object.assign(error instanceof Error ? error : new Error('nativeActivationRestoreFailed'), { mutation: 'confirmed' });
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
      // --trust is host authorization and is never inferred from AW --yes.
      if (effect.kind !== 'unregister' && (!before.consumers.length
        || binding.consumers.some((product) => !before.consumers.some((consumer) => consumer.productId === product.id && consumer.trust === 'trusted')))) blocked('nativeTrustRequired');
      if (effect.kind === 'unregister' || effect.kind === 'refresh') {
        const current = await (ctx.inspect ? ctx.inspect(binding) : inspectDeployment(ctx, binding));
        if (!grokRegistrationOwned(binding, evidence, current, identity)) blocked('nativeIdentityUnconfirmed');
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
