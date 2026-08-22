import fs from 'node:fs';
import path from 'node:path';

import type {
  CatalogSource,
  PlatformName,
  PluginMeta,
  PluginConfigSchemaField,
  Scope,
} from '../types.js';
import { hasCodexProjectManagedArtifacts } from '../utils/codex-project-surface.js';
import {
  catalogSourceErrorCode,
  sanitizeCatalogSourceError,
} from '../utils/catalog-public-error.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
import {
  inventoryCatalogSourceReferences,
  inventoryLegacyOwnerReferences,
  type CatalogSourceInventoryError,
} from '../utils/catalog-source-references.js';
import { readCatalogSourcesConfigSnapshot, resolveCatalogSourceRef } from '../utils/catalog-sources.js';
import {
  formatPluginId,
  parsePluginId,
  planPluginSelectorSourceIds,
  withResolvedMultiSourceCatalog,
} from '../utils/multi-source-catalog.js';
import { assertStrictSemVer, readPluginManifest } from '../utils/manifest.js';
import { resolveCliPackageRoot } from '../utils/paths.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { parsePlatformValue, parseScopeValue } from './options.js';
import { inspectRebuildTarget } from './rebuild-integration.js';
import { createNoopReporter } from '../output/reporter.js';
import { createNoopDebugLogger } from '../output/debug-log.js';
import { getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { resolveAwHome } from '../utils/paths.js';
import type { OwnedComponent, OwnershipInspection } from '../utils/ownership.js';
import { getClaudeHome, getCodexHome } from '../utils/state-paths.js';
import { resolveEffectivePluginConfig } from '../utils/plugin-config.js';
import {
  InstallationContractError,
  readInstallationContract,
} from '../utils/installation-contract-store.js';

export interface StatusV4CatalogSource {
  id: string;
  identity: string;
  type: CatalogSource['type'];
  primary: boolean;
  requestedRef: string;
  resolvedCommit?: string;
  catalogVersion?: string;
  channel?: string;
  freshness?: 'remote' | 'cache' | 'path';
  error?: string;
  errorCode?: string;
}

export interface StatusV4Target {
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  pluginId: string;
  version?: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  state: 'present' | 'absent' | 'partial' | 'error';
  components: StatusV4Component[];
  errors: Array<{ code: string; message: string }>;
  dependency?: {
    directCount: number;
    issueCount: number;
  };
}

export interface StatusV4Component {
  key: string;
  state: OwnershipInspection['components'][number]['state'];
  error?: { code: string; message: string };
}

export interface StatusV4Payload {
  schemaVersion: 4;
  catalog: {
    primarySourceId: string;
    configDigest: string;
    compositeDigest: string;
    sources: StatusV4CatalogSource[];
  };
  filters: {
    plugins: string[];
    platform: PlatformName | 'both';
    scope?: Scope;
    cwd: string;
  };
  targets: StatusV4Target[];
  errors: Array<{ code: string; message: string }>;
}

interface StatusPluginCapability {
  name: string;
  version: string;
  displayName: string;
  shortDescription: string;
  description: string;
  configSchema?: Record<string, PluginConfigSchemaField>;
  configIssues?: StatusV4PluginSummary['configIssues'];
  configDiagnostic?: StatusV4PluginSummary['configDiagnostic'];
  targets: Record<PlatformName, Record<Scope, boolean>>;
  states: Partial<Record<PlatformName, Partial<Record<Scope, {
    state: StatusV4Target['state'];
    errors: StatusV4Target['errors'];
    components: StatusV4Component[];
  }>>>>;
  dependencies: string[];
}

export interface StatusV4PluginSummary {
  pluginName: string;
  pluginId: string;
  displayName?: string;
  description: string;
  version?: string;
  supportedTargets?: Record<PlatformName, Scope[]>;
  configFieldCount?: number;
  configSchema?: Record<string, PluginConfigSchemaField>;
  configIssues?: Array<{
    type: 'missing-required' | 'invalid-config';
    key: string;
    title: string;
    source: 'default' | 'user' | 'project' | 'projectLocal' | 'missing';
  }>;
  configDiagnostic?: { code: 'configReadFailed'; message: string };
  dependencyDirectCount?: number;
  dependencyTotalCount?: number;
  dependencyIssueCount?: number;
}

let dependencyInspectionHookForTests: (() => void) | undefined;

export function setStatusDependencyInspectionHookForTests(hook: (() => void) | undefined): void {
  dependencyInspectionHookForTests = hook;
}

interface PlannedStatusSelector {
  raw: string;
  parsed: ReturnType<typeof parsePluginId>;
}

interface StatusInventoryError {
  code: 'nativeStateUnreadable' | 'stateInventoryFailed';
  message: string;
  relevance: CatalogSourceInventoryError['relevance'];
}

function projectStateInventoryError(
  error: unknown,
  env: NodeJS.ProcessEnv,
  cwd: string,
): StatusInventoryError {
  const sanitized = sanitizeCatalogSourceError(error, env, [
    getCodexHome(env),
    getClaudeHome(env),
    path.resolve(cwd),
  ]);
  const native = /(?:Codex|Claude|config\.toml|settings|installed_plugins)/iu.test(sanitized.message);
  const code = native ? 'nativeStateUnreadable' : 'stateInventoryFailed';
  return { code, message: `${code}: ${sanitized.message}`, relevance: { global: true } };
}

function inventoryErrorMatchesSelection(options: {
  error: StatusInventoryError;
  selectors: PlannedStatusSelector[];
  platformExplicit: boolean;
  scopeExplicit: boolean;
  platforms: PlatformName[];
  scopes: Scope[];
}): boolean {
  const relevance = options.error.relevance;
  if (relevance.global) return true;
  if (options.platformExplicit && relevance.platform
    && !options.platforms.includes(relevance.platform)) return false;
  if (options.scopeExplicit && relevance.scope
    && !options.scopes.includes(relevance.scope)) return false;
  if (options.selectors.length === 0 || (!relevance.sourceId && !relevance.pluginName)) return true;
  return options.selectors.some((selector) =>
    (!relevance.pluginName || selector.parsed.pluginName === relevance.pluginName)
    && (!relevance.sourceId
      || selector.parsed.sourceId === undefined
      || selector.parsed.sourceId === relevance.sourceId));
}

function projectTargetError(
  error: { code: string; message: string },
  env: NodeJS.ProcessEnv,
  cwd: string,
): { code: string; message: string } {
  const sanitized = sanitizeCatalogSourceError(new Error(error.message), env, [
    getCodexHome(env),
    getClaudeHome(env),
    path.resolve(cwd),
  ]);
  return { code: error.code, message: sanitized.message };
}

function sourceRequestedRef(source: CatalogSource, cliVersion: string): string {
  return source.type === 'git' ? resolveCatalogSourceRef(source.refPolicy, cliVersion) : 'path';
}

function selectedPlatforms(value: string | undefined): PlatformName[] {
  const selection = value === undefined ? 'both' : parsePlatformValue(value);
  return selection === 'both' ? ['codex', 'claude'] : [selection];
}

function selectedScopes(value: string | undefined): Scope[] {
  return value === undefined ? ['user', 'project'] : [parseScopeValue(value)];
}

function projectedLiveState(options: {
  inspection: OwnershipInspection;
  required: readonly OwnedComponent[];
  optional: readonly OwnedComponent[];
}): StatusV4Target['state'] {
  if (options.inspection.state === 'error'
    || options.inspection.components.some((entry) => entry.state === 'error')) return 'error';
  if (options.inspection.components.length === 0
    || options.inspection.components.every((entry) => entry.state === 'absent')) return 'absent';
  if (options.inspection.components.some((entry) => entry.state === 'partial')) return 'partial';
  const required = new Set(options.required);
  const optional = new Set(options.optional);
  if (options.inspection.components.some((entry) =>
    entry.state === 'present' && !required.has(entry.component) && !optional.has(entry.component))) {
    return 'partial';
  }
  if (!options.required.every((component) => options.inspection.components.some((entry) =>
    entry.component === component && entry.state === 'present'))) return 'partial';
  if (options.required.length > 0) return 'present';
  return options.optional.some((component) => options.inspection.components.some((entry) =>
    entry.component === component && entry.state === 'present')) ? 'present' : 'absent';
}

function renderStatusV4(payload: StatusV4Payload, verbose: boolean): string {
  const lines = [`Catalog sources: ${payload.catalog.sources.length}`];
  for (const source of payload.catalog.sources) {
    lines.push(`${source.primary ? '*' : '-'} ${source.id}: ${source.error ?? source.freshness ?? 'unavailable'}`);
  }
  for (const target of payload.targets) {
    const errors = target.errors.length > 0
      ? ` [${target.errors.map((error) => `${error.code}: ${error.message}`).join('; ')}]`
      : '';
    lines.push(`${target.pluginId} ${target.platform}/${target.scope}: ${target.state}${errors}`);
    if (verbose) {
      for (const component of target.components) {
        const error = component.error
          ? ` [${component.error.code}: ${component.error.message}]`
          : '';
        lines.push(`  component ${component.key}: ${component.state}${error}`);
      }
    }
  }
  for (const error of payload.errors) lines.push(`Error: ${error.message}`);
  return lines.join('\n');
}

export async function statusCommandV4(options: {
  plugins?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion?: string;
  platform?: string;
  scope?: string;
  json?: boolean;
  verbose?: boolean;
}): Promise<{
  payload: StatusV4Payload;
  output: string;
  hasErrors: boolean;
  pluginSummaries: StatusV4PluginSummary[];
}> {
  const env = options.env ?? process.env;
  const dependencyPluginCache = new Map<string, Promise<PluginMeta>>();
  const dependencyInspectionCache = new Map<
    string,
    Promise<StatusV4Target['state']>
  >();
  const cliVersion = options.cliVersion ?? assertStrictSemVer(
    (JSON.parse(fs.readFileSync(path.join(resolveCliPackageRoot(), 'package.json'), 'utf8')) as {
      version?: unknown;
    }).version,
    'packages/cli/package.json version',
  );
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const inventoryErrors: StatusInventoryError[] = [];
  const ownerInventory = await inventoryCatalogSourceReferences({ cwd: options.cwd, env }).catch(async (error) => {
    inventoryErrors.push(projectStateInventoryError(error, env, options.cwd));
    return inventoryLegacyOwnerReferences({ cwd: options.cwd, env }).catch((fallbackError) => {
      inventoryErrors.push(projectStateInventoryError(fallbackError, env, options.cwd));
      return { inventorySchemaVersion: 1 as const, references: [], errors: [] };
    });
  });
  for (const error of ownerInventory.errors ?? []) {
    const code = error.kind === 'nativeStateRead' ? 'nativeStateUnreadable' : 'stateInventoryFailed';
    inventoryErrors.push({
      code,
      message: `${code}: ${error.kind}@${error.location}: ${error.message}`,
      relevance: error.relevance,
    });
  }
  const configured = new Map(snapshot.config.sources.map((source) => [source.id, source]));
  const requested = options.plugins ?? [];
  const platforms = selectedPlatforms(options.platform);
  const scopes = selectedScopes(options.scope);
  const selectorErrors: Array<{ code: string; message: string }> = [];
  const parsedSelectors: PlannedStatusSelector[] = [];
  const plannedSelectors: PlannedStatusSelector[] = [];
  const liveOnlySelectors: PlannedStatusSelector[] = [];
  for (const selector of requested) {
    let parsed: ReturnType<typeof parsePluginId>;
    try {
      parsed = parsePluginId(selector);
    } catch (error) {
      selectorErrors.push({
        code: 'invalidPluginSelector',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    parsedSelectors.push({ raw: selector, parsed });
    if (parsed.sourceId !== undefined && !configured.has(parsed.sourceId)) {
      const hasLiveReference = ownerInventory.references.some((reference) =>
        (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
        && reference.sourceId === parsed.sourceId
        && reference.pluginName === parsed.pluginName
        && platforms.includes(reference.platform as PlatformName)
        && scopes.includes(reference.scope as Scope));
      if (hasLiveReference) {
        liveOnlySelectors.push({ raw: selector, parsed });
      } else if (!inventoryErrors.some((error) => inventoryErrorMatchesSelection({
        error,
        selectors: [{ raw: selector, parsed }],
        platformExplicit: options.platform !== undefined,
        scopeExplicit: options.scope !== undefined,
        platforms,
        scopes,
      }))) {
        selectorErrors.push({
          code: 'pluginNotFound',
          message: `Plugin "${selector}" was not found because catalog source "${parsed.sourceId}" is not configured.`,
        });
      }
      continue;
    }
    plannedSelectors.push({ raw: selector, parsed });
  }
  const selectedInventoryErrors = inventoryErrors.filter((error) => inventoryErrorMatchesSelection({
    error,
    selectors: parsedSelectors,
    platformExplicit: options.platform !== undefined,
    scopeExplicit: options.scope !== undefined,
    platforms,
    scopes,
  }));
  const plannedSourceIds = requested.length === 0
    ? undefined
    : planPluginSelectorSourceIds(plannedSelectors.map((selector) => selector.parsed));
  const selectedConfiguredSources = plannedSourceIds === undefined
    ? snapshot.config.sources
    : plannedSourceIds.map((sourceId) => configured.get(sourceId)!);
  const identityEntries = await Promise.all(selectedConfiguredSources.map(async (source): Promise<[
    string,
    { identity?: string; error?: string },
  ]> => {
    try {
      return [source.id, { identity: await calculateCatalogSourceIdentity(source) }];
    } catch (error) {
      const sanitized = sanitizeCatalogSourceError(error, env);
      return [source.id, {
        error: sanitized.message,
      }];
    }
  }));
  const identities = new Map(identityEntries);
  const catalog = await withResolvedMultiSourceCatalog({
    cliVersion,
    freshnessPolicy: 'cacheFirst',
    configSnapshot: snapshot,
    ...(plannedSourceIds === undefined ? {} : { sourceIds: plannedSourceIds }),
    env,
    consume: async (resolution) => ({
      primarySourceId: resolution.primarySourceId,
      configDigest: resolution.configDigest,
      compositeDigest: resolution.compositeDigest,
      sources: await Promise.all(resolution.sources.map(async (item) => {
        const source = configured.get(item.sourceId)!;
        const identity = identities.get(item.sourceId)!;
        const base = {
          id: item.sourceId,
          identity: identity.identity ?? 'unavailable',
          type: source.type,
          primary: source.primary,
          requestedRef: item.resolution?.requestedRef ?? sourceRequestedRef(source, cliVersion),
        };
        if (identity.error || item.error) {
          const error = item.error ?? new Error(identity.error);
          return {
            ...base,
            error: [identity.error, item.error?.message].filter(Boolean).join('; '),
            errorCode: catalogSourceErrorCode(error),
          };
        }
        try {
          const plugins: StatusPluginCapability[] = await Promise.all(
            item.resolution!.manifest.entries.map(async (entry) => {
              const plugin = await readPluginManifest(
                path.join(item.resolution!.rootDir, 'plugins', entry.name),
                { mode: 'bundle' },
              );
              const claude = supportsPlatform(plugin.manifest, 'claude');
              const codex = supportsPlatform(plugin.manifest, 'codex');
              plugin.sourceId = item.resolution!.sourceId;
              plugin.sourceIdentity = item.resolution!.sourceIdentity;
              plugin.pluginId = formatPluginId({ sourceId: item.resolution!.sourceId, pluginName: entry.name });
              let effectiveConfig: Awaited<ReturnType<typeof resolveEffectivePluginConfig>> | undefined;
              let configDiagnostic: StatusV4PluginSummary['configDiagnostic'];
              if (plugin.manifest.config?.schema) {
                try {
                  effectiveConfig = await resolveEffectivePluginConfig({
                    sourceId: plugin.sourceId,
                    sourceIdentity: plugin.sourceIdentity,
                    pluginName: plugin.manifest.name,
                    manifest: plugin.manifest,
                    cwd: options.cwd,
                    env,
                  });
                } catch {
                  configDiagnostic = {
                    code: 'configReadFailed',
                    message: '插件设置当前不可读。未读取或显示设置值。',
                  };
                }
              }
              const states: StatusPluginCapability['states'] = {};
              const marketplaceName = item.resolution!.sourceId === resolution.primarySourceId
                ? 'aw'
                : `aw-${item.resolution!.sourceId}`;
              const marketplaceRoot = path.join(resolveAwHome(env), 'marketplaces', item.resolution!.sourceId);
              for (const platform of ['codex', 'claude'] as const) {
                states[platform] = {};
                for (const scope of ['user', 'project'] as const) {
                  const supported = platform === 'claude'
                    ? claude
                    : codex && (scope === 'user' || hasCodexProjectManagedArtifacts(plugin));
                  if (!supported) continue;
                  const changedOwner = ownerInventory.references.find((reference) =>
                    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
                    && reference.sourceId === item.resolution!.sourceId
                    && reference.pluginName === entry.name
                    && reference.platform === platform
                    && reference.scope === scope
                    && reference.sourceIdentity
                    && reference.sourceIdentity !== item.resolution!.sourceIdentity);
                  if (changedOwner) {
                    states[platform]![scope] = {
                      state: 'error',
                      components: [],
                      errors: [{
                        code: 'sourceChanged',
                        message: `sourceChanged: owner at ${changedOwner.location} has a different source identity.`,
                      }],
                    };
                    continue;
                  }
                  try {
                    const inspected = await inspectRebuildTarget({
                      sourceId: item.resolution!.sourceId,
                      sourceIdentity: item.resolution!.sourceIdentity,
                      pluginId: plugin.pluginId,
                      marketplaceName,
                      marketplaceRoot,
                      plugin,
                      platform,
                      scope,
                      cwd: options.cwd,
                      catalog: {
                        rootDir: item.resolution!.rootDir,
                        source: 'local',
                      },
                      context: {
                        env,
                        nativeCliRunner: getDefaultNativeCliRunner(),
                        reporter: createNoopReporter(),
                        debugLogger: createNoopDebugLogger(),
                      },
                    });
                    const liveState = projectedLiveState({
                      inspection: inspected.inspection,
                      required: inspected.target.desiredOwnedComponents ?? inspected.target.ownedComponents,
                      optional: inspected.target.optionalOwnedComponents ?? [],
                    });
                    const dependencyErrors: Array<{ code: string; message: string }> = [];
                    const directDependencies = plugin.manifest.dependencies ?? [];
                    if (directDependencies.length > 0
                      && (liveState === 'present' || liveState === 'partial')) {
                      try {
                        const contract = await readInstallationContract({
                          sourceId: item.resolution!.sourceId,
                          sourceIdentity: item.resolution!.sourceIdentity,
                          pluginName: entry.name,
                          platform,
                          scope,
                          cwd: options.cwd,
                          env,
                        });
                        if (!contract) {
                          dependencyErrors.push({
                            code: 'dependencyContractMissing',
                            message: `dependencyContractMissing: ${plugin.pluginId} has no installation contract for this live target.`,
                          });
                        } else {
                          const currentEntry = item.resolution!.manifest.entries.find((candidate) =>
                            candidate.name === entry.name)!;
                          if (contract.metadata.sourceIdentity !== item.resolution!.sourceIdentity
                            || contract.metadata.contentDigest !== currentEntry.contentDigest) {
                            dependencyErrors.push({
                              code: 'sourceChanged',
                              message: `sourceChanged: ${plugin.pluginId} installation contract does not match the current source snapshot.`,
                            });
                          } else {
                            const recordedIds = contract.metadata.dependencies.map((dependency) =>
                              dependency.pluginId).sort();
                            const expectedIds = directDependencies.map((dependencyName) => formatPluginId({
                              sourceId: item.resolution!.sourceId,
                              pluginName: dependencyName,
                            })).sort();
                            if (recordedIds.join('\0') !== expectedIds.join('\0')) {
                              dependencyErrors.push({
                                code: 'dependencyContractInvalid',
                                message: `dependencyContractInvalid: ${plugin.pluginId} dependency edges do not match its installed content.`,
                              });
                            }
                            for (const dependency of contract.metadata.dependencies) {
                              if (dependency.sourceId !== item.resolution!.sourceId
                                || dependency.sourceIdentity !== item.resolution!.sourceIdentity) {
                                dependencyErrors.push({
                                  code: 'dependencyIdentityMismatch',
                                  message: `dependencyIdentityMismatch: ${plugin.pluginId} has dependency evidence for a different source identity.`,
                                });
                                continue;
                              }
                              if (dependency.platform !== platform) {
                                dependencyErrors.push({
                                  code: 'dependencyPlacementMismatch',
                                  message: `dependencyPlacementMismatch: ${plugin.pluginId} has dependency evidence for a different platform.`,
                                });
                                continue;
                              }
                              const dependencyName = parsePluginId(dependency.pluginId).pluginName;
                              const dependencyEntry = item.resolution!.manifest.entries.find((candidate) =>
                                candidate.name === dependencyName);
                              if (!dependencyEntry) {
                                dependencyErrors.push({
                                  code: 'dependencyMissing',
                                  message: `dependencyMissing: ${dependency.pluginId} is not available in the current source snapshot.`,
                                });
                                continue;
                              }
                              const pluginCacheKey = [
                                item.resolution!.sourceIdentity,
                                dependency.pluginId,
                              ].join('\0');
                              let dependencyPluginPromise = dependencyPluginCache.get(pluginCacheKey);
                              if (!dependencyPluginPromise) {
                                dependencyPluginPromise = readPluginManifest(
                                  path.join(item.resolution!.rootDir, 'plugins', dependencyName),
                                  { mode: 'bundle' },
                                ).then((dependencyPlugin) => {
                                  dependencyPlugin.sourceId = item.resolution!.sourceId;
                                  dependencyPlugin.sourceIdentity = item.resolution!.sourceIdentity;
                                  dependencyPlugin.pluginId = dependency.pluginId;
                                  return dependencyPlugin;
                                });
                                dependencyPluginCache.set(pluginCacheKey, dependencyPluginPromise);
                              }
                              const inspectionCacheKey = [
                                item.resolution!.sourceIdentity,
                                dependency.pluginId,
                                dependency.platform,
                                dependency.scope,
                                dependency.projectKey ?? '',
                              ].join('\0');
                              let dependencyInspection = dependencyInspectionCache.get(inspectionCacheKey);
                              if (!dependencyInspection) {
                                dependencyInspection = dependencyPluginPromise.then(async (dependencyPlugin) => {
                                  dependencyInspectionHookForTests?.();
                                  const dependencyInspected = await inspectRebuildTarget({
                                    sourceId: item.resolution!.sourceId,
                                    sourceIdentity: item.resolution!.sourceIdentity,
                                    pluginId: dependency.pluginId,
                                    marketplaceName,
                                    marketplaceRoot,
                                    plugin: dependencyPlugin,
                                    platform: dependency.platform,
                                    scope: dependency.scope,
                                    cwd: dependency.projectKey ?? options.cwd,
                                    catalog: { rootDir: item.resolution!.rootDir, source: 'local' },
                                    context: {
                                      env,
                                      nativeCliRunner: getDefaultNativeCliRunner(),
                                      reporter: createNoopReporter(),
                                      debugLogger: createNoopDebugLogger(),
                                    },
                                  });
                                  return projectedLiveState({
                                    inspection: dependencyInspected.inspection,
                                    required: dependencyInspected.target.desiredOwnedComponents
                                      ?? dependencyInspected.target.ownedComponents,
                                    optional: dependencyInspected.target.optionalOwnedComponents ?? [],
                                  });
                                });
                                dependencyInspectionCache.set(inspectionCacheKey, dependencyInspection);
                              }
                              const dependencyState = await dependencyInspection;
                              if (dependencyState === 'absent') {
                                dependencyErrors.push({
                                  code: 'dependencyMissing',
                                  message: `dependencyMissing: ${dependency.pluginId} is absent at its recorded target.`,
                                });
                              } else if (dependencyState !== 'present') {
                                dependencyErrors.push({
                                  code: 'dependencyNotReady',
                                  message: `dependencyNotReady: ${dependency.pluginId} is not ready at its recorded target.`,
                                });
                              }
                            }
                          }
                        }
                      } catch (error) {
                        const changedContract = ownerInventory.references.some((reference) =>
                          reference.kind === 'installationContract'
                          && reference.sourceId === item.resolution!.sourceId
                          && reference.pluginName === entry.name
                          && reference.platform === platform
                          && reference.scope === scope
                          && reference.sourceIdentity !== item.resolution!.sourceIdentity);
                        dependencyErrors.push({
                          code: changedContract
                            ? 'sourceChanged'
                            : error instanceof InstallationContractError
                            ? 'dependencyContractInvalid'
                            : 'dependencyNotReady',
                          message: changedContract
                            ? `sourceChanged: ${plugin.pluginId} installation contract has a different source identity.`
                            : error instanceof InstallationContractError
                            ? `dependencyContractInvalid: ${plugin.pluginId} installation contract is invalid.`
                            : `dependencyNotReady: ${plugin.pluginId} dependency state could not be inspected.`,
                        });
                      }
                    }
                    states[platform]![scope] = {
                      state: dependencyErrors.length > 0 && liveState === 'present' ? 'partial' : liveState,
                      errors: [...inspected.inspection.errors.map((error) => ({
                        code: 'componentInspectionFailed',
                        message: `${error.label}: ${error.message}`,
                      })), ...dependencyErrors],
                      components: options.verbose === true
                        ? inspected.inspection.components.map((component) => {
                            const projectedError = component.diagnostic
                              ? projectTargetError({
                                  code: 'componentInspectionFailed',
                                  message: component.diagnostic,
                                }, env, options.cwd)
                              : undefined;
                            return {
                              key: component.component.identity.artifactKey,
                              state: component.state,
                              ...(projectedError ? { error: projectedError } : {}),
                            };
                          })
                        : [],
                    };
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const code = message.split(':', 1)[0] || 'targetInspectionFailed';
                    states[platform]![scope] = {
                      state: 'error',
                      components: [],
                      errors: [{ code, message }],
                    };
                  }
                }
              }
              return {
                name: entry.name,
                version: entry.version,
                displayName: plugin.manifest.interface?.displayName ?? entry.name,
                shortDescription: plugin.manifest.interface?.shortDescription
                  ?? plugin.manifest.description,
                description: plugin.manifest.description,
                ...(plugin.manifest.config?.schema
                  ? { configSchema: plugin.manifest.config.schema }
                  : {}),
                ...(effectiveConfig?.issues.length
                  ? {
                      configIssues: effectiveConfig.issues.map((issue) => ({
                        type: issue.type,
                        key: issue.key,
                        title: plugin.manifest.config!.schema[issue.key]?.title ?? issue.key,
                        source: issue.source ?? 'missing',
                      })),
                    }
                  : {}),
                ...(configDiagnostic ? { configDiagnostic } : {}),
                targets: {
                  claude: { user: claude, project: claude },
                  codex: {
                    user: codex,
                    project: codex && hasCodexProjectManagedArtifacts(plugin),
                  },
                },
                states,
                dependencies: plugin.manifest.dependencies ?? [],
              };
            }),
          );
          return {
            ...base,
            resolvedCommit: item.resolution!.resolvedCommit,
            catalogVersion: item.resolution!.manifest.catalogVersion,
            channel: item.resolution!.manifest.channel,
            freshness: item.resolution!.source,
            plugins,
          };
        } catch (error) {
          const sanitized = sanitizeCatalogSourceError(error, env);
          return {
            ...base,
            error: sanitized.message,
            errorCode: catalogSourceErrorCode(sanitized),
          };
        }
      })),
    }),
  });
  const available = catalog.sources.flatMap((source) => 'plugins' in source
    ? source.plugins.map((plugin) => ({ ...plugin, source }))
    : []);
  const failedSourceIds = new Set(
    catalog.sources.filter((source) => 'error' in source).map((source) => source.id),
  );
  const selectedById = new Map<string, (typeof available)[number]>();
  if (requested.length === 0) {
    for (const entry of available) {
      selectedById.set(formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }), entry);
    }
  } else {
    for (const selector of plannedSelectors) {
      if (selector.parsed.sourceId === undefined && failedSourceIds.size > 0) {
        selectorErrors.push({
          code: 'catalogSourceUnavailable',
          message: `Cannot resolve bare plugin selector "${selector.raw}" while catalog sources are unavailable: ${[...failedSourceIds].join(', ')}.`,
        });
        continue;
      }
      if (selector.parsed.sourceId !== undefined && failedSourceIds.has(selector.parsed.sourceId)) {
        selectorErrors.push({
          code: 'catalogSourceUnavailable',
          message: `Cannot resolve plugin selector "${selector.raw}" because catalog source "${selector.parsed.sourceId}" is unavailable.`,
        });
        continue;
      }
      const matches = available.filter((entry) =>
        entry.name === selector.parsed.pluginName
        && (selector.parsed.sourceId === undefined || entry.source.id === selector.parsed.sourceId));
      if (matches.length === 0) {
        const selectorHasInventoryError = selectedInventoryErrors.some((error) =>
          inventoryErrorMatchesSelection({
            error,
            selectors: [selector],
            platformExplicit: options.platform !== undefined,
            scopeExplicit: options.scope !== undefined,
            platforms,
            scopes,
          }));
        if (!selectorHasInventoryError) {
          selectorErrors.push({
            code: 'pluginNotFound',
            message: `Plugin "${selector.raw}" was not found in the selected catalog source set.`,
          });
        }
        continue;
      }
      if (selector.parsed.sourceId === undefined && matches.length > 1) {
        selectorErrors.push({
          code: 'ambiguousPlugin',
          message: `Plugin "${selector.raw}" is ambiguous across sources: ${matches.map((entry) => entry.source.id).join(', ')}.`,
        });
        continue;
      }
      for (const entry of matches) {
        selectedById.set(formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }), entry);
      }
    }
  }
  const selected = [...selectedById.values()];
  const explicitTargetFilter = requested.length > 0
    && (options.platform !== undefined || options.scope !== undefined);
  const targets: StatusV4Target[] = selected.flatMap((entry) => platforms.flatMap((platform) =>
    scopes.flatMap((scope): StatusV4Target[] => {
      const target = {
        pluginName: entry.name,
        sourceId: entry.source.id,
        sourceIdentity: entry.source.identity,
        pluginId: formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
        version: entry.version,
        platform,
        scope,
        cwd: path.resolve(options.cwd),
        components: [] as StatusV4Component[],
      };
      if (entry.targets[platform][scope]) {
        const live = entry.states[platform]?.[scope];
        const dependencyIssueCount = (live?.errors ?? []).filter((error) =>
          error.code.startsWith('dependency') || error.code === 'sourceChanged').length;
        return [{
          ...target,
          state: live?.state ?? 'error',
          components: live?.components ?? [],
          errors: live?.errors ?? [{
            code: 'targetInspectionFailed',
            message: `No live inspection result exists for ${entry.source.id}/${entry.name}.`,
          }],
          ...(entry.dependencies.length > 0 ? {
            dependency: {
              directCount: entry.dependencies.length,
              issueCount: dependencyIssueCount,
            },
          } : {}),
        }];
      }
      const unsupportedLiveReference = ownerInventory.references.find((reference) =>
        (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
        && reference.sourceId === entry.source.id
        && reference.pluginName === entry.name
        && reference.platform === platform
        && reference.scope === scope);
      if (unsupportedLiveReference) {
        const sourceChanged = Boolean(
          unsupportedLiveReference.sourceIdentity
          && unsupportedLiveReference.sourceIdentity !== entry.source.identity,
        );
        return [{
          ...target,
          state: 'error',
          errors: [{
            code: sourceChanged ? 'sourceChanged' : 'noLongerSupported',
            message: sourceChanged
              ? `sourceChanged: live state for ${target.pluginId} has a different source identity.`
              : `noLongerSupported: ${target.pluginId} has live state for ${platform}/${scope}, but the current bundle no longer supports that target.`,
          }],
        }];
      }
      if (!explicitTargetFilter) return [];
      return [{
        ...target,
        state: 'error',
        errors: [{
          code: 'unsupportedTarget',
          message: `${entry.source.id}/${entry.name} does not support ${platform}/${scope}.`,
        }],
      }];
    })));
  const referenceSelectors = [...plannedSelectors, ...liveOnlySelectors];
  const referenceSelected = (reference: { sourceId?: string; pluginName?: string; platform?: string; scope?: string }): boolean => (
    reference.pluginName !== undefined
    && reference.platform !== undefined
    && reference.scope !== undefined
    && platforms.includes(reference.platform as PlatformName)
    && scopes.includes(reference.scope as Scope)
    && (requested.length === 0 || referenceSelectors.some((selector) =>
      selector.parsed.pluginName === reference.pluginName
      && (selector.parsed.sourceId === undefined || selector.parsed.sourceId === reference.sourceId)))
  );
  const legacyOwners = ownerInventory.references.filter((reference) =>
    (reference.kind === 'legacyOwner' || reference.kind === 'legacyMarketplace')
    && reference.pluginName !== undefined
    && reference.platform !== undefined
    && reference.scope !== undefined
    && platforms.includes(reference.platform as PlatformName)
    && scopes.includes(reference.scope as Scope)
    && (requested.length === 0 || plannedSelectors.some((selector) =>
      selector.parsed.pluginName === reference.pluginName)));
  const missingSourceOwners = ownerInventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
    && reference.sourceId
    && !configured.has(reference.sourceId)
    && referenceSelected(reference));
  const missingTargets = [...new Map(missingSourceOwners.flatMap((reference) => {
    if (!reference.sourceId || !reference.pluginName
      || (reference.platform !== 'codex' && reference.platform !== 'claude')
      || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
    const pluginId = formatPluginId({ sourceId: reference.sourceId, pluginName: reference.pluginName });
    const target: StatusV4Target = {
      pluginName: reference.pluginName,
      sourceId: reference.sourceId,
      sourceIdentity: reference.sourceIdentity ?? 'unavailable',
      pluginId,
      platform: reference.platform,
      scope: reference.scope,
      cwd: path.resolve(options.cwd),
      state: 'error',
      components: [],
      errors: [{
        code: 'sourceMissing',
        message: `sourceMissing: catalog source "${reference.sourceId}" is not configured for ${pluginId}.`,
      }],
    };
    return [[`${pluginId}\0${reference.platform}\0${reference.scope}`, target] as const];
  })).values()];
  targets.push(...missingTargets);
  const unavailableSourceReferences = ownerInventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
    && reference.sourceId
    && configured.has(reference.sourceId)
    && failedSourceIds.has(reference.sourceId)
    && referenceSelected(reference));
  const unavailableSourceTargets = [...new Map(unavailableSourceReferences.flatMap((reference) => {
    if (!reference.sourceId || !reference.pluginName
      || (reference.platform !== 'codex' && reference.platform !== 'claude')
      || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
    const pluginId = formatPluginId({ sourceId: reference.sourceId, pluginName: reference.pluginName });
    const target: StatusV4Target = {
      pluginName: reference.pluginName,
      sourceId: reference.sourceId,
      sourceIdentity: reference.sourceIdentity ?? 'unavailable',
      pluginId,
      platform: reference.platform,
      scope: reference.scope,
      cwd: path.resolve(options.cwd),
      state: 'error',
      components: [],
      errors: [{
        code: 'catalogSourceUnavailable',
        message: `catalogSourceUnavailable: catalog source "${reference.sourceId}" is unavailable for ${pluginId}.`,
      }],
    };
    return [[`${pluginId}\0${reference.platform}\0${reference.scope}`, target] as const];
  })).values()];
  targets.push(...unavailableSourceTargets);
  const availablePluginIds = new Set(available.map((entry) =>
    formatPluginId({ sourceId: entry.source.id, pluginName: entry.name })));
  const resolvedSourceIds = new Set(catalog.sources.flatMap((source) =>
    'plugins' in source ? [source.id] : []));
  const unavailableBundleReferences = ownerInventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
    && reference.sourceId
    && configured.has(reference.sourceId)
    && resolvedSourceIds.has(reference.sourceId)
    && reference.pluginName
    && referenceSelected(reference)
    && !availablePluginIds.has(formatPluginId({
      sourceId: reference.sourceId,
      pluginName: reference.pluginName,
    })));
  const unavailableBundleTargets = [...new Map(unavailableBundleReferences.flatMap((reference) => {
    if (!reference.sourceId || !reference.pluginName
      || (reference.platform !== 'codex' && reference.platform !== 'claude')
      || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
    const pluginId = formatPluginId({ sourceId: reference.sourceId, pluginName: reference.pluginName });
    if (requested.length > 0 && !plannedSelectors.some((selector) =>
      selector.parsed.pluginName === reference.pluginName
      && (selector.parsed.sourceId === undefined || selector.parsed.sourceId === reference.sourceId))) return [];
    const target: StatusV4Target = {
      pluginName: reference.pluginName,
      sourceId: reference.sourceId,
      sourceIdentity: reference.sourceIdentity ?? 'unavailable',
      pluginId,
      platform: reference.platform,
      scope: reference.scope,
      cwd: path.resolve(options.cwd),
      state: 'error',
      components: [],
      errors: [{
        code: 'bundleUnavailable',
        message: `bundleUnavailable: ${pluginId} has live state but is not present in the current source snapshot.`,
      }],
    };
    return [[`${pluginId}\0${reference.platform}\0${reference.scope}`, target] as const];
  })).values()];
  targets.push(...unavailableBundleTargets);
  const projectedInventoryErrors = [...new Map(selectedInventoryErrors.map((error) => [
    `${error.code}\0${error.message}`,
    { code: error.code, message: error.message },
  ])).values()];
  const errors = [
    ...projectedInventoryErrors,
    ...selectorErrors,
    ...legacyOwners.map((reference) => projectTargetError({
      code: 'legacyStateUnsupported',
      message: `legacyStateUnsupported: legacy live ${reference.kind} at ${reference.location}`,
    }, env, options.cwd)),
  ];
  const projectedTargets = targets.map((target) => ({
    ...target,
    errors: target.errors.map((error) => projectTargetError(error, env, options.cwd)),
  }));
  const payload: StatusV4Payload = {
    schemaVersion: 4,
    catalog: {
      primarySourceId: catalog.primarySourceId,
      configDigest: catalog.configDigest,
      compositeDigest: catalog.compositeDigest,
      sources: catalog.sources.map((source) => {
        if (!('plugins' in source)) return source;
        const { plugins: _plugins, ...projected } = source;
        return projected;
      }),
    },
    filters: {
      plugins: requested,
      platform: options.platform === undefined ? 'both' : parsePlatformValue(options.platform),
      ...(options.scope === undefined ? {} : { scope: parseScopeValue(options.scope) }),
      cwd: path.resolve(options.cwd),
    },
    targets: projectedTargets,
    errors,
  };
  const hasErrors = payload.catalog.sources.some((source) => source.error !== undefined)
    || payload.errors.length > 0
    || payload.targets.some((target) => target.state === 'error');
  return {
    payload,
    output: options.json ? JSON.stringify(payload) : renderStatusV4(payload, options.verbose === true),
    hasErrors,
    pluginSummaries: available.map((entry) => {
      const sourceEntries = available.filter((candidate) => candidate.source.id === entry.source.id);
      const byName = new Map(sourceEntries.map((candidate) => [candidate.name, candidate]));
      const transitive = new Set<string>();
      const visit = (name: string): void => {
        const candidate = byName.get(name);
        for (const dependency of candidate?.dependencies ?? []) {
          if (transitive.has(dependency)) continue;
          transitive.add(dependency);
          visit(dependency);
        }
      };
      visit(entry.name);
      const dependencyIssueCount = targets.filter((target) => target.pluginId === formatPluginId({
        sourceId: entry.source.id,
        pluginName: entry.name,
      })).reduce((count, target) => count + target.errors.filter((error) =>
        error.code.startsWith('dependency') || error.code === 'sourceChanged').length, 0);
      return {
        pluginName: entry.name,
        pluginId: formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
        displayName: entry.displayName,
        description: entry.shortDescription,
        version: entry.version,
        supportedTargets: {
          codex: (['user', 'project'] as const).filter((scope) => entry.targets.codex[scope]),
          claude: (['user', 'project'] as const).filter((scope) => entry.targets.claude[scope]),
        },
        configFieldCount: Object.keys(entry.configSchema ?? {}).length,
        ...(entry.configSchema ? { configSchema: entry.configSchema } : {}),
        ...(entry.configIssues ? { configIssues: entry.configIssues } : {}),
        ...(entry.configDiagnostic ? { configDiagnostic: entry.configDiagnostic } : {}),
        dependencyDirectCount: entry.dependencies.length,
        dependencyTotalCount: transitive.size,
        dependencyIssueCount,
      };
    }),
  };
}
