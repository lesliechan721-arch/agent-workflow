import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import {
  canonicalizeIdentityValue,
  getCommandPackageId,
  getNativeToolConsumerClosure,
  getPluginConfigDependencyFields,
  getPluginConfigDependencyKeys,
  loadPluginNativeToolClosure,
  materializeNativeToolClosureFiles,
  normalizeCommandRoutes,
  normalizeProducerIdentity,
  selectPluginConfigProfile,
  validateCommandEntryFiles,
  validatePluginConfigCandidate,
  validatePluginConfigValue,
  type CommandRoutes,
  type InstalledCommandProducer,
  type NativeToolClosure,
  type PlatformName,
  type PluginConfigCompiledDefinition,
  type ProducerIdentity,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../types.js';
import { resolveArtifactRenderConfig, type ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import { selectManagedCommandRenderConfig } from './artifact-request.js';
import {
  calculateManagedCommandResourceDigest,
  commandInputDigest,
  commandRouteEntries,
  readManagedCommandSource,
  validateManagedCommandPackageClosure,
} from './managed-command-closure.js';
import {
  COMMAND_RUNTIME_CONFIG_READER,
  commandRuntimeConfigSnapshotPath,
  readCommandRuntimeConfigReaderSource,
  readManagedCommandRuntimeConfigSnapshot,
  type CommandRuntimeConfigSnapshot,
} from './managed-command-snapshots.js';
import {
  captureManagedCommandPackageEvidence,
  copyManagedCommandDirectory,
  ManagedCommandError,
  readManagedCommandPackage,
  readManagedCommandPackageView,
  syncManagedCommandPackage,
  validateManagedCommandResource,
  type ManagedCommandPackageEvidence,
  type ManagedCommandPackageView,
} from './managed-command-store.js';
import {
  assertReadyPluginConfigStore,
  readPluginConfigStore,
  resolveEffectivePluginConfig,
  type PluginConfigValue,
  type PluginConfigStore,
  type ResolvedEffectivePluginConfig,
} from './plugin-config.js';

export { readManagedCommandSource } from './managed-command-closure.js';

export type ManagedCommandPackageOperation =
  | { kind: 'materialize' }
  | { kind: 'explicit-sync' }
  | { kind: 'platform-sync'; platforms: readonly PlatformName[] }
  | { kind: 'config-apply'; platforms: readonly PlatformName[]; refreshRoutes: boolean };

export interface ManagedCommandRoutesRenderOptions {
  plugin: PluginMeta;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sourceDir: string;
  previous?: InstalledCommandProducer;
  commonConfig?: ResolvedArtifactRenderConfig;
  event: 'install' | 'refresh' | 'materialize';
  changedConfigKeys?: string[];
  referencePlugins?: readonly PluginMeta[];
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
}

interface PackageInputs {
  plugin: PluginMeta;
  cwd: string;
  env: NodeJS.ProcessEnv;
  referencePlugins?: readonly PluginMeta[];
  resolveConfig?: (platform?: PlatformName) => Promise<ResolvedEffectivePluginConfig>;
}

interface PreparedManagedCommandPackageOptions extends PackageInputs {
  operation: ManagedCommandPackageOperation;
  renderRoutes?: (options: ManagedCommandRoutesRenderOptions) => Promise<CommandRoutes>;
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
}

interface InstalledPackage {
  resourceRoot: string;
  record: InstalledCommandProducer;
}

interface RuntimeConfigChange {
  platform: PlatformName;
  before?: Record<string, PluginConfigValue>;
  after?: Record<string, PluginConfigValue>;
}

export interface PreparedManagedCommandPackage {
  resourceRoot: string;
  resourceDigest: string;
  record: InstalledCommandProducer;
  previous?: InstalledPackage;
  expectedPackage: ManagedCommandPackageEvidence | null;
  runtimeConfigChanges: RuntimeConfigChange[];
  /** Per-platform config inputs actually read to build or validate the reviewed snapshots. */
  runtimeConfigEvidence: ReadonlyMap<PlatformName, string>;
  /** Dynamic rendering uses the common user config store. */
  routeConfigEvidence?: string;
  cleanup(): Promise<void>;
}

type CommandPackageFiles = { closure: NativeToolClosure; files: Record<string, string> } | undefined;

export function managedCommandProducerIdentity(options: { plugin: PluginMeta }): ProducerIdentity {
  const { sourceId, sourceIdentity, manifest } = options.plugin;
  if (!sourceId || !sourceIdentity) {
    throw new ManagedCommandError('commandIdentityConflict', 'A verified source identity is required for the command package.');
  }
  return normalizeProducerIdentity({ sourceId, sourceIdentity, pluginName: manifest.name });
}

function declaredCommand(plugin: PluginMeta): NonNullable<PluginMeta['manifest']['command']> {
  if (!plugin.manifest.command) {
    throw new ManagedCommandError('commandPackageDeclarationMissing',
      'The active plugin no longer declares a command package. Run aw command package remove or aw plugin sync.');
  }
  return plugin.manifest.command;
}

async function nativeToolFiles(plugin: PluginMeta): Promise<CommandPackageFiles> {
  if (!plugin.manifest.nativeTools?.consumers.some((consumer) => consumer.kind === 'plugin-command')) return undefined;
  const closure = getNativeToolConsumerClosure(await loadPluginNativeToolClosure(plugin.rootDir, plugin.manifest), 'plugin-command');
  return closure === undefined ? undefined : materializeNativeToolClosureFiles(closure);
}

export async function nativeToolsForPluginCommand(plugin: PluginMeta): Promise<NativeToolClosure | undefined> {
  return (await nativeToolFiles(plugin))?.closure;
}

async function previousPackage(producer: ProducerIdentity, env: NodeJS.ProcessEnv, requireKnownSnapshots: boolean): Promise<{
  view?: ManagedCommandPackageView;
  previous?: InstalledPackage;
  expectedPackage: ManagedCommandPackageEvidence | null;
}> {
  let view: ManagedCommandPackageView;
  try { view = await readManagedCommandPackageView(getCommandPackageId(producer), env); }
  catch (error) {
    if (error instanceof ManagedCommandError && error.code === 'commandNotFound') return { expectedPackage: null };
    throw error;
  }
  if (requireKnownSnapshots && view.routes === null) {
    throw new ManagedCommandError('commandRuntimeConfigInvalid',
      `The previously applied platforms cannot be verified. Run aw command package remove ${view.packageId} --force, then sync the package again.`);
  }
  const expectedPackage = await captureManagedCommandPackageEvidence(view, env);
  if (!view.resourceRoot || view.routes === null) return { view, expectedPackage };
  const previous = await readManagedCommandPackage(producer, env, { validateFiles: false });
  if (previous?.resourceRoot !== view.resourceRoot) {
    throw new ManagedCommandError('operationReviewStale', 'The installed command package changed during preparation.');
  }
  return { view, previous, expectedPackage };
}

function configReadOptions(options: PackageInputs) {
  return {
    sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity, pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest, referencePlugins: options.referencePlugins,
    cwd: options.cwd, env: options.env,
  };
}

async function commonRouteConfig(options: PackageInputs): Promise<ResolvedArtifactRenderConfig> {
  if (options.resolveConfig && options.plugin.manifest.config) {
    return { ...await options.resolveConfig(), mode: 'artifact-render', targetScope: 'user' };
  }
  return resolveArtifactRenderConfig({ ...configReadOptions(options), scope: 'user' });
}

function routeConfigDigest(plugin: PluginMeta, config: ResolvedArtifactRenderConfig): string {
  const command = declaredCommand(plugin);
  return commandInputDigest(selectManagedCommandRenderConfig(config, command.mode === 'dynamic' ? command.refreshKeys : []));
}

function routeConfigKeyDigests(config: ReturnType<typeof selectManagedCommandRenderConfig>): Record<string, string> {
  return Object.fromEntries(Object.entries(config.sources).map(([key, source]) => [
    key, commandInputDigest({ field: config.schema?.[key], value: config.values[key], source,
      issues: config.issues.filter((issue) => issue.key === key) }),
  ]));
}

async function resolvePlatformRuntimeConfig(options: PackageInputs, platform: PlatformName): Promise<ResolvedEffectivePluginConfig> {
  return options.resolveConfig?.(platform)
    ?? resolveEffectivePluginConfig({ ...configReadOptions(options), platform, targetScope: 'user' });
}

function selectConfigValues(values: Record<string, PluginConfigValue>, keys: readonly string[]): Record<string, PluginConfigValue> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]!]));
}

function runtimeConfigEvidence(config: ResolvedEffectivePluginConfig, keys: readonly string[]): string {
  const dependencies = getPluginConfigDependencyKeys(config.definition, keys, config.referenceContext);
  return commandInputDigest({
    values: selectConfigValues(config.values, dependencies),
    issues: config.issues.filter((issue) => dependencies.includes(issue.key)),
  });
}

function commonRuntimeConfigDigest(plugin: PluginMeta, platform: PlatformName, store: PluginConfigStore, keys: readonly string[]): string {
  assertReadyPluginConfigStore(store);
  const definition = selectPluginConfigProfile(plugin.manifest.config!, platform);
  const dependencies = getPluginConfigDependencyKeys(definition, keys);
  return commandInputDigest(selectConfigValues(store.common ?? (store.platform ? {} : store.values), dependencies));
}

async function readCommandCommonStore(options: PackageInputs): Promise<PluginConfigStore> {
  return options.resolveConfig ? (await options.resolveConfig()).stores.user!
    : readPluginConfigStore({ ...configReadOptions(options), scope: 'user' });
}

function applyRuntimeConfig(config: ResolvedEffectivePluginConfig, keys: readonly string[]): Record<string, PluginConfigValue> {
  const dependencies = getPluginConfigDependencyKeys(config.definition, keys, config.referenceContext);
  if (config.issues.some((issue) => dependencies.includes(issue.key))
    || validatePluginConfigCandidate(config.definition, config.values, keys, config.referenceContext).length > 0) {
    throw new ManagedCommandError('commandRuntimeConfigInvalid', 'The effective command runtime config is invalid. Fix the configuration and sync again.');
  }
  return selectConfigValues(config.values, keys);
}

function previousConfigCompatible(
  definition: PluginConfigCompiledDefinition, keys: readonly string[], old: CommandRuntimeConfigSnapshot,
): boolean {
  return keys.every((key) => {
    const field = definition.fields[key]!;
    if (!Object.hasOwn(old.effectiveValues, key)) return field.required !== true;
    if (validatePluginConfigValue(field, old.effectiveValues[key], key).length > 0) return false;

    // Validate references with the applied values when the previous snapshot includes the full dependency closure.
    // Unpublished dependencies must not draw this platform's pending Config Store values into an unrelated sync.
    let dependencies;
    try { dependencies = getPluginConfigDependencyFields(definition, [key]); }
    catch { return true; } // Cross-plugin providers are outside this snapshot.
    if (dependencies.some(({ field }) => !old.allowedKeys.includes(field))) return true;
    return validatePluginConfigCandidate(definition, old.effectiveValues, [key]).length === 0;
  });
}

async function readPreviousSnapshots(previous?: InstalledPackage): Promise<Map<PlatformName, CommandRuntimeConfigSnapshot>> {
  const snapshots = new Map<PlatformName, CommandRuntimeConfigSnapshot>();
  if (!previous) return snapshots;
  for (const platform of previous.record.runtimeConfigPlatforms) {
    try {
      snapshots.set(platform, await readManagedCommandRuntimeConfigSnapshot(previous.resourceRoot, previous.record, platform));
    } catch (error) {
      if (!(error instanceof ManagedCommandError)) throw error;
      // The package record still identifies the platform. A sync can rebuild a damaged snapshot.
    }
  }
  return snapshots;
}

async function prepareRuntimeConfig(options: PreparedManagedCommandPackageOptions & {
  record: InstalledCommandProducer;
  previous?: InstalledPackage;
  packageExists: boolean;
}): Promise<{
  snapshots: Map<PlatformName, CommandRuntimeConfigSnapshot>;
  changes: RuntimeConfigChange[];
  evidence: ReadonlyMap<PlatformName, string>;
}> {
  const { operation, previous, record } = options;
  const command = declaredCommand(options.plugin);
  const oldSnapshots = await readPreviousSnapshots(previous);
  const oldPlatforms = previous?.record.runtimeConfigPlatforms ?? [];
  const keys = record.runtimeConfigKeys;
  const snapshots = new Map<PlatformName, CommandRuntimeConfigSnapshot>();
  const evidence = new Map<PlatformName, string>();
  const commonDigests: Partial<Record<PlatformName, string>> = {};
  const refresh = new Set(operation.kind === 'explicit-sync'
    ? options.packageExists ? oldPlatforms : command.platforms
    : 'platforms' in operation ? operation.platforms : []);
  if (keys) for (const platform of command.platforms) {
    const old = oldSnapshots.get(platform);
    if (!refresh.has(platform) && !oldPlatforms.includes(platform)) continue;

    let effectiveValues: Record<string, PluginConfigValue>;
    if (!refresh.has(platform) && !old) {
      throw new ManagedCommandError('commandRuntimeConfigInvalid', 'A previously applied snapshot is damaged. Run aw command package sync to refresh it.');
    }
    if (old && !refresh.has(platform) && (
      old.sourceContentDigest === record.sourceContentDigest
      || previousConfigCompatible(selectPluginConfigProfile(options.plugin.manifest.config!, platform), keys, old)
    )) {
      effectiveValues = selectConfigValues(old.effectiveValues, keys);
    } else {
      const config = await resolvePlatformRuntimeConfig(options, platform);
      effectiveValues = applyRuntimeConfig(config, keys);
      evidence.set(platform, runtimeConfigEvidence(config, keys));
      commonDigests[platform] = commonRuntimeConfigDigest(options.plugin, platform, config.stores.user!, keys);
    }
    const previousDigest = previous?.record.runtimeConfigCommonDigests?.[platform];
    if (previousDigest !== undefined) commonDigests[platform] ??= previousDigest;
    snapshots.set(platform, {
      schemaVersion: 1, kind: 'aw-command-runtime-config',
      producer: record.producer, pluginVersion: record.pluginVersion, sourceContentDigest: record.sourceContentDigest,
      platform, allowedKeys: keys, effectiveValues,
    });
  }
  const changes: RuntimeConfigChange[] = [];
  for (const platform of new Set([...oldPlatforms, ...snapshots.keys()])) {
    const before = oldSnapshots.get(platform)?.effectiveValues;
    const after = snapshots.get(platform)?.effectiveValues;
    if (canonicalizeIdentityValue(before) !== canonicalizeIdentityValue(after)) {
      changes.push({ platform, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
    }
  }
  if (Object.keys(commonDigests).length) record.runtimeConfigCommonDigests = commonDigests;
  return { snapshots, changes, evidence };
}

async function verifyCommandConfigApplySource(
  plugin: PluginMeta, previous: InstalledPackage | undefined, view: ManagedCommandPackageView | undefined, native?: NativeToolClosure,
) {
  if (!previous) {
    throw new ManagedCommandError('commandBindingInvalid', 'Configuration apply requires a usable installed command package. Run aw command package sync.');
  }
  if (canonicalizeIdentityValue(previous.record.nativeTools) !== canonicalizeIdentityValue(native)) {
    throw new ManagedCommandError('nativeToolSyncRequired', 'Native tool changes require aw plugin sync or aw command package sync before configuration apply.');
  }
  const mismatch = () => new ManagedCommandError('configApplyVersionMismatch',
    'The installed command package differs from Active Catalog. Run aw plugin sync or aw command package sync.');
  if (!plugin.manifest.command || previous.record.pluginVersion !== plugin.manifest.version) throw mismatch();
  const source = await readManagedCommandSource(plugin);
  if (previous.record.sourceContentDigest !== source.sourceContentDigest) throw mismatch();
  if (view?.availability === 'unavailable') {
    throw new ManagedCommandError('commandBindingInvalid', 'Configuration apply requires a usable installed command package. Run aw command package sync.');
  }
  return source;
}

/** Select only the snapshots and routes whose applied inputs differ. */
export async function inspectManagedCommandConfigApply(options: PackageInputs & {
  platform?: PlatformName;
}): Promise<Extract<ManagedCommandPackageOperation, { kind: 'config-apply' }> | undefined> {
  const { plugin, platform } = options;
  const { previous, view } = await previousPackage(managedCommandProducerIdentity(options), options.env, false);
  if (!view) return undefined;
  await verifyCommandConfigApplySource(plugin, previous, view, await nativeToolsForPluginCommand(plugin));
  const record = previous!.record;
  const command = declaredCommand(plugin);
  const keys = command.runtimeConfig?.keys;
  const platforms: PlatformName[] = [];
  if (platform && keys && command.platforms.includes(platform)) {
    const config = await resolvePlatformRuntimeConfig(options, platform);
    const values = applyRuntimeConfig(config, keys);
    const snapshot = record.runtimeConfigPlatforms.includes(platform)
      ? await readManagedCommandRuntimeConfigSnapshot(previous!.resourceRoot, record, platform) : undefined;
    if (canonicalizeIdentityValue(values) !== canonicalizeIdentityValue(snapshot?.effectiveValues)) platforms.push(platform);
  } else if (!platform && keys && record.runtimeConfigPlatforms.length) {
    const store = await readCommandCommonStore(options);
    for (const target of record.runtimeConfigPlatforms) {
      if (command.platforms.includes(target)
        && record.runtimeConfigCommonDigests?.[target] !== commonRuntimeConfigDigest(plugin, target, store, keys)) platforms.push(target);
    }
  }
  const refreshRoutes = !platform && command.mode === 'dynamic' && command.refreshKeys.length > 0
    && record.routeConfigDigest !== routeConfigDigest(plugin, await commonRouteConfig(options));
  return platforms.length || refreshRoutes ? { kind: 'config-apply', platforms, refreshRoutes } : undefined;
}

export async function prepareManagedCommandPackage(options: PreparedManagedCommandPackageOptions): Promise<PreparedManagedCommandPackage> {
  options.signal?.throwIfAborted();
  const { plugin, operation } = options;
  const declaration = declaredCommand(plugin);
  if (operation.kind === 'platform-sync' && !operation.platforms.some((platform) => declaration.platforms.includes(platform))) {
    throw new ManagedCommandError('commandDefinitionInvalid', 'No selected platform supports this command package.');
  }
  const producer = managedCommandProducerIdentity(options);
  const requireKnownSnapshots = operation.kind === 'explicit-sync' && declaration.runtimeConfig !== undefined;
  // Author profiles validate the route and closure without applying platform config.
  const { previous, view, expectedPackage } = operation.kind === 'materialize'
    ? { expectedPackage: null } : await previousPackage(producer, options.env, requireKnownSnapshots);
  const native = await nativeToolFiles(plugin);

  const source = operation.kind === 'config-apply'
    ? await verifyCommandConfigApplySource(plugin, previous, view, native?.closure)
    : await readManagedCommandSource(plugin);

  let routes: CommandRoutes;
  let routeEvidence: string | undefined;
  const previousKeyDigests = previous?.record.routeConfigKeyDigests;
  let appliedKeyDigests = previousKeyDigests;
  if (declaration.mode === 'static') routes = declaration.routes;
  else if (operation.kind === 'config-apply' && !operation.refreshRoutes && previous) routes = previous.record.routes;
  else {
    const renderRoutes = options.renderRoutes ?? (await import('./managed-command-preparation.js')).renderManagedCommandRoutes;
    const commonConfig = await commonRouteConfig(options);
    const selectedConfig = selectManagedCommandRenderConfig(commonConfig, declaration.refreshKeys);
    routeEvidence = commandInputDigest(selectedConfig);
    appliedKeyDigests = routeConfigKeyDigests(selectedConfig);
    const changedConfigKeys = operation.kind === 'config-apply' && previousKeyDigests
      ? Object.entries(appliedKeyDigests).filter(([key, digest]) => previousKeyDigests[key] !== digest).map(([key]) => key)
      : [];
    routes = normalizeCommandRoutes(await renderRoutes({ ...options, sourceDir: source.sourceRoot, previous: previous?.record,
      commonConfig, changedConfigKeys,
      event: operation.kind === 'config-apply' ? 'refresh' : operation.kind === 'platform-sync' ? 'install' : 'materialize' }));
    if (routeEvidence !== routeConfigDigest(plugin, await commonRouteConfig(options))) {
      throw new ManagedCommandError('operationReviewStale', 'Command configuration changed while preparing its routes.');
    }
  }

  const appliedRouteDigest = routeEvidence ?? previous?.record.routeConfigDigest;
  const record: InstalledCommandProducer = {
    schemaVersion: 2, producer, pluginVersion: plugin.manifest.version, sourceContentDigest: source.sourceContentDigest, routes,
    ...(declaration.mode === 'dynamic' ? { dynamicRefreshKeys: declaration.refreshKeys } : {}),
    ...(declaration.mode === 'dynamic' && appliedRouteDigest ? { routeConfigDigest: appliedRouteDigest } : {}),
    ...(declaration.mode === 'dynamic' && appliedKeyDigests ? { routeConfigKeyDigests: appliedKeyDigests } : {}),
    ...(native ? { nativeTools: native.closure } : {}),
    ...(declaration.runtimeConfig ? { runtimeConfigKeys: declaration.runtimeConfig.keys } : {}),
    runtimeConfigPlatforms: [],
  };
  const runtime = await prepareRuntimeConfig({ ...options, record, previous, packageExists: view !== undefined });
  record.runtimeConfigPlatforms = [...runtime.snapshots.keys()];

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-command-package-'));
  const resourceRoot = path.join(tempRoot, 'resource');
  const cleanup = () => fs.remove(tempRoot);
  try {
    await copyManagedCommandDirectory(source.sourceRoot, resourceRoot, options.env, { trustedPluginSource: true });
    if (source.sourceTreeDigest !== await calculateManagedCommandResourceDigest(resourceRoot)) {
      throw new ManagedCommandError('operationReviewStale', 'Command package resources changed while staging.');
    }
    const entries = commandRouteEntries(record.routes);
    // An entry must come from the author package, even when the script imports AW's helper files.
    await validateCommandEntryFiles(resourceRoot, entries);
    if (record.runtimeConfigKeys) {
      await fs.outputFile(path.join(resourceRoot, COMMAND_RUNTIME_CONFIG_READER), await readCommandRuntimeConfigReaderSource(), { flag: 'wx' });
    }
    for (const [platform, snapshot] of runtime.snapshots) {
      await fs.outputFile(path.join(resourceRoot, commandRuntimeConfigSnapshotPath(platform)), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    for (const [relative, content] of Object.entries(native?.files ?? {})) {
      await fs.outputFile(path.join(resourceRoot, relative), content, { flag: 'wx' });
    }
    await validateManagedCommandPackageClosure(resourceRoot, entries);
    for (const entry of entries) await validateManagedCommandResource(resourceRoot, entry);
    options.signal?.throwIfAborted();
    const resourceDigest = await calculateManagedCommandResourceDigest(resourceRoot);
    return { resourceRoot, resourceDigest, record, previous, expectedPackage, cleanup,
      runtimeConfigChanges: runtime.changes, runtimeConfigEvidence: runtime.evidence, routeConfigEvidence: routeEvidence };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Recheck inputs under the caller's existing write lock, without repeating the renderer. */
export async function verifyPreparedManagedCommandPackage(options: PackageInputs & {
  candidate: PreparedManagedCommandPackage;
}): Promise<void> {
  const { candidate } = options;
  const stale = () => new ManagedCommandError('operationReviewStale', 'The reviewed command source or configuration changed. Review the command package again.');
  try {
    const producer = managedCommandProducerIdentity(options);
    const native = await nativeToolsForPluginCommand(options.plugin);
    const source = await readManagedCommandSource(options.plugin);
    if (canonicalizeIdentityValue(producer) !== canonicalizeIdentityValue(candidate.record.producer)
      || canonicalizeIdentityValue(native) !== canonicalizeIdentityValue(candidate.record.nativeTools)
      || candidate.record.pluginVersion !== options.plugin.manifest.version
      || candidate.record.sourceContentDigest !== source.sourceContentDigest) throw stale();
    if (candidate.routeConfigEvidence !== undefined && candidate.routeConfigEvidence !== routeConfigDigest(options.plugin, await commonRouteConfig(options))) throw stale();
    for (const [platform, digest] of candidate.runtimeConfigEvidence) {
      const config = await resolvePlatformRuntimeConfig(options, platform);
      const keys = candidate.record.runtimeConfigKeys!;
      if (digest !== runtimeConfigEvidence(config, keys)
        || candidate.record.runtimeConfigCommonDigests?.[platform] !== commonRuntimeConfigDigest(options.plugin, platform, config.stores.user!, keys)) throw stale();
    }
  } catch (error) {
    if (error instanceof ManagedCommandError && error.code === 'operationReviewStale') throw error;
    throw stale();
  }
}

export async function publishPreparedManagedCommandPackage(options: PackageInputs & {
  candidate: PreparedManagedCommandPackage;
}) {
  await verifyPreparedManagedCommandPackage(options);
  return syncManagedCommandPackage({ producer: options.candidate.record.producer, record: options.candidate.record,
    sourceDirectory: options.candidate.resourceRoot, expectedPackage: options.candidate.expectedPackage,
    expectedResourceDigest: options.candidate.resourceDigest, env: options.env });
}
