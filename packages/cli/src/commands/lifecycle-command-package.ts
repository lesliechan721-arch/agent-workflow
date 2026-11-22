import { canonicalizeIdentityValue, getCommandPackageId, type InstalledCommandProducer } from '@lesliechan721/aw-plugin-core/manifest';

import type { CommandProducerResult, PlatformName, PluginMeta } from '../types.js';
import { inspectManagedCommandRouteChanges } from '../utils/managed-command-cli-review.js';
import {
  managedCommandProducerIdentity, prepareManagedCommandPackage, publishPreparedManagedCommandPackage, verifyPreparedManagedCommandPackage,
} from '../utils/managed-command-materialization.js';
import {
  captureManagedCommandPackageEvidence, listManagedCommandPackages, managedCommandDiagnostic, ManagedCommandError,
  readInstalledCommandProducer, readManagedCommandPackageView, removeManagedCommandPackage, type ManagedCommandPackageView,
} from '../utils/managed-command-store.js';
import { nativeToolChangesForPackage } from '../utils/native-tool-review.js';
import type { OperationAction } from './operation-plan.js';
import type { RebuildExecutionContext } from './rebuild-integration.js';
import type { DesiredTarget } from './rebuild-operations.js';

export type RetainedManagedCommandPackage = Pick<ManagedCommandPackageView,
  'packageId' | 'selector' | 'availability' | 'subcommands' | 'hasFallback' | 'errors' | 'recoveryActions'> & {
  producer: InstalledCommandProducer['producer'];
};

function summary(view: ManagedCommandPackageView): RetainedManagedCommandPackage {
  const { packageId, selector, availability, subcommands, hasFallback, errors } = view;
  const recoveryActions = [...view.recoveryActions];
  if (!recoveryActions.some((action) => action.startsWith(`aw command package remove ${packageId} `))) {
    recoveryActions.push(`aw command package remove ${packageId}${availability === 'unavailable' ? ' --force' : ''} --yes`);
  }
  return { producer: view.owner.producer, packageId, selector, availability, subcommands, hasFallback, errors, recoveryActions };
}

export async function discoverRetainedManagedCommandPackages(options: {
  selectors: readonly { sourceId?: string; pluginName: string }[];
  all?: boolean; env: NodeJS.ProcessEnv;
}): Promise<RetainedManagedCommandPackage[]> {
  const inventory = await listManagedCommandPackages(options.env);
  return [...inventory.packages, ...inventory.orphanedPackages].filter(({ owner }) => options.all || options.selectors.some(
    (selector) => selector.sourceId === owner.producer.sourceId && selector.pluginName === owner.producer.pluginName,
  )).map(summary);
}

export function retainedManagedCommandPackageResult(entry: RetainedManagedCommandPackage): CommandProducerResult {
  const { producer, packageId, selector, availability, subcommands, hasFallback, errors, recoveryActions } = entry;
  return { producer, packageId, selector, availability, subcommands, hasFallback, errors, recoveryActions,
    state: availability === 'unavailable' ? 'partial' : 'completed', action: 'unchanged' };
}

async function installedPackage(id: string, env: NodeJS.ProcessEnv): Promise<ManagedCommandPackageView | undefined> {
  try { return await readManagedCommandPackageView(id, env); }
  catch (error) {
    if (error instanceof ManagedCommandError && error.code === 'commandNotFound') return undefined;
    throw error;
  }
}

type PreparedPackageAction = { record: InstalledCommandProducer | null; actions: OperationAction[] };
export type ManagedCommandWithdrawal = Extract<OperationAction, { kind: 'removeManagedCommandPackage' }>;

async function prepareWithdrawal(installed: ManagedCommandPackageView, cwd: string, env: NodeJS.ProcessEnv): Promise<ManagedCommandWithdrawal> {
  const retained = summary(installed);
  const force = installed.availability === 'unavailable';
  return { ...retained, kind: 'removeManagedCommandPackage', scope: 'user', pluginId: installed.selector, force,
    expectedPackage: await captureManagedCommandPackageEvidence(installed, env, { force }),
    routeReview: await inspectManagedCommandRouteChanges({ before: installed.routes ?? undefined, selector: installed.selector, cwd, env }),
    nativeToolChanges: nativeToolChangesForPackage(retained.producer, installed.nativeTools, null),
  };
}

export async function preparePortableCommandWithdrawal(plugin: PluginMeta, cwd: string, env: NodeJS.ProcessEnv): Promise<ManagedCommandWithdrawal | undefined> {
  if (plugin.manifest.command || !plugin.sourceId || !plugin.sourceIdentity) return;
  const installed = await installedPackage(getCommandPackageId(managedCommandProducerIdentity({ plugin })), env);
  if (installed) return prepareWithdrawal(installed, cwd, env);
}

// Rechecking a second host after this operation's own publication still uses the
// package changes approved for that host in the original multi-host Review.
const reviewedPackages = new WeakMap<NonNullable<RebuildExecutionContext['packagePreparationCache']>, Map<string, PreparedPackageAction>>();

export async function prepareLifecycleCommandPackage(options: {
  plugin: PluginMeta; platform: PlatformName; platforms: readonly PlatformName[]; cwd: string;
  removing: boolean; context: RebuildExecutionContext;
}): Promise<PreparedPackageAction> {
  const { plugin, platform, context, cwd } = options;
  const declaration = plugin.manifest.command;
  const empty = { record: null, actions: [] };
  if (!declaration && (!plugin.sourceId || !plugin.sourceIdentity)) return empty;
  if (declaration && !declaration.platforms.includes(platform) && !options.removing && !context.retainCommandPackages) return empty;
  const producer = managedCommandProducerIdentity({ plugin });
  const packageId = getCommandPackageId(producer);
  const pluginId = `${producer.sourceId}/${producer.pluginName}`;
  const env = context.env;
  const cache = context.packagePreparationCache!;
  if (context.configApply) {
    if (!declaration || options.removing) return empty;
    const prepared = await cache.get(packageId);
    if (prepared) return { record: prepared.record, actions: [] };
    const installed = await installedPackage(packageId, env);
    if (installed?.availability === 'unavailable' || !installed?.resourceRoot) return empty;
    return { record: await readInstalledCommandProducer(installed.resourceRoot), actions: [] };
  }
  let reviewed = reviewedPackages.get(cache);
  if (!reviewed) {
    reviewed = new Map();
    reviewedPackages.set(cache, reviewed);
  }
  const reviewKey = JSON.stringify([packageId, cwd]);
  const prior = reviewed.get(reviewKey);
  if (!options.removing && !context.retainCommandPackages && prior && context.managedCommandProducerCache?.has(packageId)) return prior;
  if (options.removing || context.retainCommandPackages || !declaration) {
    const installed = await installedPackage(packageId, env);
    if (!installed) return empty;
    if (options.removing || context.retainCommandPackages) {
      const record = !options.removing && declaration?.platforms.includes(platform) && installed.availability !== 'unavailable' && installed.resourceRoot
        ? await readInstalledCommandProducer(installed.resourceRoot) : null;
      return { record, actions: [{ ...summary(installed), kind: 'retainManagedCommandPackage', scope: 'user', pluginId }] };
    }
    const prepared: PreparedPackageAction = { record: null, actions: [await prepareWithdrawal(installed, cwd, env)] };
    reviewed.set(reviewKey, prepared);
    return prepared;
  }

  let preparation = cache.get(packageId);
  const reused = !!preparation;
  if (!preparation) {
    preparation = prepareManagedCommandPackage({ plugin, cwd, env, referencePlugins: context.referencePlugins,
      operation: { kind: 'platform-sync', platforms: options.platforms }, signal: context.signal, scriptTimeoutMs: context.scriptTimeoutMs });
    cache.set(packageId, preparation);
  }
  const candidate = await preparation;
  if (reused) {
    await verifyPreparedManagedCommandPackage({ plugin, cwd, env, referencePlugins: context.referencePlugins, candidate });
    const installed = await installedPackage(packageId, env);
    const current = installed ? await captureManagedCommandPackageEvidence(installed, env) : null;
    if (canonicalizeIdentityValue(current) !== canonicalizeIdentityValue(candidate.expectedPackage)) {
      throw new ManagedCommandError('operationReviewStale', 'The installed command package changed after Review.');
    }
  }
  const { record, previous } = candidate;
  const routeReview = await inspectManagedCommandRouteChanges({ before: previous?.record.routes, after: record.routes, selector: pluginId, cwd, env });
  const prepared: PreparedPackageAction = { record, actions: [{ kind: 'syncManagedCommandPackage', pluginId, scope: 'user', producer, record,
    expectedPackage: candidate.expectedPackage, contentDigest: candidate.resourceDigest, routeReview, runtimeConfigChanges: candidate.runtimeConfigChanges,
    nativeToolChanges: nativeToolChangesForPackage(producer, previous?.record.nativeTools, record.nativeTools),
  }] };
  reviewed.set(reviewKey, prepared);
  return prepared;
}

type PublicationAction = Extract<OperationAction, { kind: 'syncManagedCommandPackage' | 'removeManagedCommandPackage' }>;

export function commandPackageProviderSatisfied(result: CommandProducerResult): boolean {
  // A created or updated package has switched the active revision. Cleanup may still need a retry.
  return result.state === 'completed'
    || (result.state === 'partial' && (result.action === 'created' || result.action === 'updated'));
}

export async function publishLifecycleCommandPackage(action: PublicationAction, target: { cwd: string; plugin?: PluginMeta },
  context: Pick<RebuildExecutionContext, 'env'> & Partial<Pick<RebuildExecutionContext, 'reporter' | 'packagePreparationCache' | 'referencePlugins'>>,
): Promise<CommandProducerResult> {
  const { producer } = action;
  const packageId = getCommandPackageId(producer);
  const selector = `${producer.sourceId}/${producer.pluginName}`;
  const { env } = context;
  const { cwd, plugin } = target;
  const base = { packageId, producer, selector };
  const event = (phase: 'start' | 'success' | 'failure') => context.reporter?.event({ type: 'managed-command:producer',
    source: { plugin: producer.pluginName, scope: 'user' }, data: { selector, phase } });
  await event('start');
  try {
    const installed = await installedPackage(packageId, env);
    const candidate = action.kind === 'syncManagedCommandPackage' ? await context.packagePreparationCache?.get(packageId) : undefined;
    const routeReview = await inspectManagedCommandRouteChanges({ before: installed?.routes ?? undefined, after: candidate?.record.routes, selector, env, cwd });
    if (canonicalizeIdentityValue(routeReview) !== canonicalizeIdentityValue(action.routeReview)) {
      throw new ManagedCommandError('operationReviewStale', 'The reviewed routes or visible permissions changed.');
    }
    if (action.kind === 'removeManagedCommandPackage') {
      await removeManagedCommandPackage(packageId, env, { force: action.force, expectedPackage: action.expectedPackage });
      await event('success');
      return { ...base, state: 'completed', action: 'removed', availability: 'removed', subcommands: [], hasFallback: false, errors: [], recoveryActions: [] };
    }
    if (!plugin || !candidate || candidate.resourceDigest !== action.contentDigest || canonicalizeIdentityValue(candidate.record) !== canonicalizeIdentityValue(action.record)
      || canonicalizeIdentityValue(candidate.expectedPackage) !== canonicalizeIdentityValue(action.expectedPackage)) {
      throw new ManagedCommandError('operationReviewStale', 'The reviewed command package changed.');
    }
    const { errors, recoveryActions } = await publishPreparedManagedCommandPackage({ candidate, plugin, referencePlugins: context.referencePlugins, cwd, env });
    const subcommands = candidate.record.routes.subcommands.map(({ name }) => name);
    const hasFallback = !!candidate.record.routes.fallback;
    await event(errors.length ? 'failure' : 'success');
    return { ...base, action: candidate.expectedPackage ? 'updated' : 'created', availability: subcommands.length || hasFallback ? 'ready' : 'empty',
      subcommands, hasFallback, state: errors.length ? 'partial' : 'completed', errors, recoveryActions };
  } catch (error) {
    const remaining = await installedPackage(packageId, env).catch(() => undefined);
    const recovery = action.kind === 'removeManagedCommandPackage' ? `aw command package remove ${packageId}${remaining?.availability !== 'ready' && remaining?.availability !== 'empty' ? ' --force' : ''} --yes`
      : `aw command package sync ${selector} --yes`;
    await event('failure');
    const diagnostic = managedCommandDiagnostic(error);
    const partialRemoval = action.kind === 'removeManagedCommandPackage' && diagnostic.code === 'commandPackageRemovalFailed'
      && (!remaining || remaining.availability === 'unavailable');
    return { ...base, state: partialRemoval ? 'partial' : 'failed', action: 'unchanged', availability: remaining?.availability ?? 'unavailable',
      subcommands: remaining?.subcommands ?? [], hasFallback: remaining?.hasFallback ?? false, errors: [diagnostic], recoveryActions: [recovery] };
  }
}

export async function publishLifecycleCommandPackages(target: DesiredTarget, context: RebuildExecutionContext): Promise<void> {
  const cache = context.managedCommandProducerCache ??= new Map();
  for (const action of target.operationActions ?? []) {
    if (action.kind !== 'syncManagedCommandPackage' && action.kind !== 'removeManagedCommandPackage') continue;
    const key = getCommandPackageId(action.producer);
    let publication = cache.get(key);
    if (!publication) {
      publication = publishLifecycleCommandPackage(action, { cwd: target.identity.cwd, plugin: target.plugin }, context);
      cache.set(key, publication);
    }
    const result = await publication;
    context.commandResults ??= [];
    if (!context.commandResults.some((entry) => entry.packageId === key)) context.commandResults.push(result);
    if (!commandPackageProviderSatisfied(result)) {
      const issue = result.errors[0];
      const code = issue?.code ?? 'commandPackagePublishFailed';
      throw new ManagedCommandError(code, `${code}: ${issue?.message ?? 'The command package could not be published.'}`);
    }
  }
}
