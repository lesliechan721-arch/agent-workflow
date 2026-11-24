import { canonicalizeIdentityValue, getManagedCommandInvocationSelectors, selectPluginConfigProfile, type PlatformName } from '@lesliechan721/aw-plugin-core/manifest';

import type { CommandProducerResult, PluginMeta } from '../types.js';
import {
  describeManagedCommandRouteReview,
  describeManagedCommandRuntimeConfigChanges,
  inspectManagedCommandRouteChanges, reviewInvocationPlatforms,
  type ManagedCommandRouteReview,
} from './managed-command-cli-review.js';
import {
  inspectManagedCommandConfigApply,
  prepareManagedCommandPackage,
  type PreparedManagedCommandPackage,
} from './managed-command-materialization.js';
import { ManagedCommandError, managedCommandDiagnostic } from './managed-command-store.js';
import { recoveryInterruptionCode } from '../recovery/interruption.js';
import {
  coercePluginConfigUpdates,
  readPluginConfigStore,
  replacePluginConfigStoreLayer,
  resolveEffectivePluginConfigFromStores,
} from './plugin-config.js';
import { pluginConfigHasExternalReferences, resolvePluginConfigReferenceContext } from './plugin-config-references.js';
import type { ConfigCommandPackage, PluginConfigImpactMutation } from './plugin-config-impact.js';
import type { ApplyPluginConfigOptions } from './plugin-config-write.js';

export interface ConfigCommandPackageReview extends ManagedCommandRouteReview {
  selector: string;
  runtimeConfigChanges: PreparedManagedCommandPackage['runtimeConfigChanges'];
}

export interface ConfigCommandPackageEvidence {
  packageId: string;
  expectedPackage?: PreparedManagedCommandPackage['expectedPackage'];
  record?: PreparedManagedCommandPackage['record'];
  resourceDigest?: string;
  blocker?: ReturnType<typeof managedCommandDiagnostic>;
  review?: ConfigCommandPackageReview;
}

export interface ConfigCommandApplyCandidate {
  plugin: PluginMeta;
  target: ConfigCommandPackage;
  candidate?: PreparedManagedCommandPackage;
  evidence: ConfigCommandPackageEvidence;
}

export function describeConfigCommandPackageReviews(reviews: readonly ConfigCommandPackageReview[]): string[] {
  return reviews.flatMap((review) => [
    ...describeManagedCommandRouteReview(review),
    ...describeManagedCommandRuntimeConfigChanges(review.runtimeConfigChanges)
      .map((change) => `${review.selector} — ${change}`),
  ]);
}

const packageSelector = (target: ConfigCommandPackage) => `${target.producer.sourceId}/${target.producer.pluginName}`;

export async function inspectConfigCommandPackageReview(
  options: ApplyPluginConfigOptions, target: ConfigCommandPackage, candidate: PreparedManagedCommandPackage,
): Promise<ConfigCommandPackageReview> {
  const selector = packageSelector(target);
  const routeReview = await inspectManagedCommandRouteChanges({ selector,
    before: candidate.previous?.record.routes, beforePlatforms: reviewInvocationPlatforms(candidate.previous?.record), after: candidate.record.routes, afterPlatforms: reviewInvocationPlatforms(candidate.record), cwd: options.cwd,
    env: options.env ?? process.env, userOnly: (options.context ?? options.scope) === 'user' });
  return { ...routeReview, selector, runtimeConfigChanges: candidate.runtimeConfigChanges };
}

export function configPackageResult(
  target: ConfigCommandPackage, errors: CommandProducerResult['errors'], candidate?: PreparedManagedCommandPackage,
  published?: { errors: ReturnType<typeof managedCommandDiagnostic>[]; recoveryActions: string[] },
): CommandProducerResult {
  const { packageId, producer } = target;
  const selector = packageSelector(target);
  const record = published ? candidate?.record : candidate?.previous?.record;
  const routes = record?.routes;
  const subcommands = routes?.subcommands.map(({ name }) => name) ?? target.subcommands ?? [];
  const hasFallback = routes ? routes.fallback !== undefined : target.hasFallback ?? false;
  const invocationSelectors = getManagedCommandInvocationSelectors(selector,
    record ? !!record.runtimeConfigKeys?.length : target.requiresPlatformContext ?? null,
    record?.runtimeConfigPlatforms ?? target.runtimeConfigPlatforms);
  return { producer, packageId, selector, action: published ? 'updated' : 'unchanged',
    availability: routes ? subcommands.length || hasFallback ? 'ready' : 'empty' : target.availability ?? 'unavailable',
    subcommands, hasFallback, invocationSelectors, state: published ? published.errors.length ? 'partial' : 'completed' : 'failed',
    errors: published?.errors ?? errors,
    recoveryActions: published?.recoveryActions
      ?? [`aw plugin sync ${selector}`, `aw command package sync ${selector}`] };
}

/** Read the proposed Store document in memory while preparing a save-and-apply Review. */
function createMutationConfigReader(options: ApplyPluginConfigOptions & {
  mutation: PluginConfigImpactMutation;
}, referencePlugins: readonly PluginMeta[]) {
  const env = options.env ?? process.env;
  const commonOptions = { cwd: options.cwd, env };
  const identity = (plugin: PluginMeta) => ({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
    logicalIdentity: plugin.catalogLogicalIdentity, pluginName: plugin.manifest.name });
  const candidateStore = (async () => {
    const user = await readPluginConfigStore({ ...identity(options.plugin), ...commonOptions, scope: 'user', platform: options.platform });
    if (options.mutation.kind === 'reset') {
      return replacePluginConfigStoreLayer(user.state === 'invalid'
        ? { ...user, values: {}, common: {}, platforms: {}, state: 'missing', issues: [] }
        : user, {}, options.platform);
    }
    const schema = selectPluginConfigProfile(options.plugin.manifest.config!, options.platform).fields;
    const values = { ...user.values };
    for (const key of options.mutation.removeKeys ?? []) delete values[key];
    Object.assign(values, await coercePluginConfigUpdates({ schema,
      updates: options.mutation.updates ?? {}, cwd: options.cwd }));
    return replacePluginConfigStoreLayer(user, values, options.platform);
  })();

  return (plugin: PluginMeta) => async (platform?: PlatformName) => {
    const candidate = await candidateStore;
    const { manifest } = plugin;
    const user = plugin.manifest.name === options.plugin.manifest.name ? candidate
      : await readPluginConfigStore({ ...identity(plugin), ...commonOptions, scope: 'user', platform });
    const references = pluginConfigHasExternalReferences(manifest)
      ? await resolvePluginConfigReferenceContext({ ...identity(plugin), ...commonOptions,
        manifest, scope: 'user', platform, plugins: referencePlugins,
        storeOverrides: new Map([[options.plugin.manifest.name, { user: candidate }]]) })
      : undefined;
    return resolveEffectivePluginConfigFromStores({ manifest, platform, targetScope: 'user', projectRoot: '',
      stores: { user }, referenceContext: references?.context, referenceEvidence: references?.evidence });
  };
}

export async function prepareConfigCommandPackages(options: ApplyPluginConfigOptions, targets: readonly ConfigCommandPackage[],
  plugins: readonly PluginMeta[], referencePlugins: readonly PluginMeta[],
  { inspectOnly = false } = {},
): Promise<ConfigCommandApplyCandidate[]> {
  const env = options.env ?? process.env;
  const signal = options.rebuildRuntime?.signal;
  const reviewed = options.expectedCommandPackageEvidence;
  const readMutationConfig = options.mutation && options.plugin.manifest.config && targets.length
    ? createMutationConfigReader({ ...options, mutation: options.mutation }, referencePlugins) : undefined;
  const entries: ConfigCommandApplyCandidate[] = [];
  const stale = () => new ManagedCommandError('operationReviewStale', 'The reviewed command package or configuration changed. Prepare a new Review.');
  try {
    for (const target of targets) {
      signal?.throwIfAborted();
      const plugin = plugins.find((entry) => entry.manifest.name === target.producer.pluginName)!;
      const prior = reviewed?.find(({ packageId }) => packageId === target.packageId);
      const input = { plugin, cwd: options.cwd, env, referencePlugins,
        resolveConfig: readMutationConfig?.(plugin) };
      const evidence: ConfigCommandPackageEvidence = { packageId: target.packageId };
      const entry = { target, plugin, evidence, candidate: undefined as PreparedManagedCommandPackage | undefined };
      entries.push(entry);
      try {
        if (options.platform === 'generic') continue;
        const operation = await inspectManagedCommandConfigApply({ ...input, platform: options.platform });
        if (!operation || inspectOnly) continue;
        if (prior?.blocker) { evidence.blocker = prior.blocker; continue; }
        if (reviewed && !prior?.record && operation.refreshRoutes) throw stale();
        const reviewedRoutes = prior?.record?.routes;
        const candidate = await prepareManagedCommandPackage({ ...input, operation, signal,
          scriptTimeoutMs: options.rebuildRuntime?.scriptTimeoutMs,
          ...(reviewedRoutes ? { renderRoutes: async () => reviewedRoutes } : {}) });
        entry.candidate = candidate;
        evidence.expectedPackage = candidate.expectedPackage;
        evidence.record = candidate.record;
        evidence.resourceDigest = candidate.resourceDigest;
        evidence.review = await inspectConfigCommandPackageReview(options, target, candidate);
      } catch (error) {
        if (recoveryInterruptionCode(error, signal)
          || error instanceof ManagedCommandError && error.code === 'operationReviewStale') throw error;
        evidence.blocker = managedCommandDiagnostic(error);
        if (entry.candidate) await entry.candidate.cleanup();
        entry.candidate = undefined;
        delete evidence.expectedPackage;
        delete evidence.record;
        delete evidence.resourceDigest;
      }
    }
    const selected = entries.filter(({ evidence }) => evidence.record || evidence.blocker);
    if (!inspectOnly && reviewed && canonicalizeIdentityValue(reviewed) !== canonicalizeIdentityValue(selected.map(({ evidence }) => evidence))) throw stale();
    return selected;
  } catch (error) {
    await Promise.all(entries.map(({ candidate }) => candidate?.cleanup()));
    throw error;
  }
}
