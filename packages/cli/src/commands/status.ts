import path from 'node:path';

import type {
  CatalogResolution,
  PlatformName,
  PluginMeta,
  Scope,
} from '../types.js';
import { createNoopDebugLogger } from '../output/debug-log.js';
import { createNoopReporter } from '../output/reporter.js';
import { resolvePluginsFromCatalog } from '../utils/manifest.js';
import { getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { hasCodexProjectManagedArtifacts } from '../utils/codex-project-surface.js';
import type {
  OwnedComponent,
  OwnershipComponentState,
  OwnershipInspection,
} from '../utils/ownership.js';
import {
  discoverRebuildTargetNames,
  inspectRebuildTarget,
  type RebuildExecutionContext,
} from './rebuild-integration.js';
import { normalizeStatusCommandOptions, type RawStatusCommandOptions } from './options.js';
import { statusCommandV5, type StatusV5PluginSummary } from './status-v5.js';

export type LiveStatusState = 'present' | 'absent' | 'partial' | 'error';

export interface LiveStatusTargetIdentity {
  plugin: string;
  version?: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
}

export interface LiveStatusComponentCheck {
  kind?: OwnedComponent['kind'];
  label?: string;
  artifactKey: string;
  state: OwnershipComponentState;
  error?: string;
  errorCode?: string;
}

export interface LiveStatusError {
  code: string;
  message: string;
  component?: string;
}

export interface LiveStatusRecommendation {
  command: string;
  reason: 'absent' | 'partial';
}

export interface LiveStatusTarget {
  target: LiveStatusTargetIdentity;
  state: LiveStatusState;
  components: LiveStatusComponentCheck[];
  errors: LiveStatusError[];
  recommendation?: LiveStatusRecommendation;
}

export interface LiveStatusCatalogInfo {
  source?: CatalogResolution['source'];
  channel?: CatalogResolution['channel'];
  catalogVersion?: CatalogResolution['catalogVersion'];
  error?: {
    code: 'catalogUnavailable';
    message: string;
  };
}

export interface StatusJsonPayload {
  schemaVersion: 3;
  catalog: LiveStatusCatalogInfo;
  filters: {
    plugins: string[];
    platform: PlatformName | 'both';
    scope?: Scope;
    cwd: string;
  };
  targets: LiveStatusTarget[];
  errors: LiveStatusError[];
}

export interface LiveConsoleItem {
  pluginName: string;
  version?: string;
  plugin?: PluginMeta;
  pluginSummary?: Omit<StatusV5PluginSummary, 'pluginName' | 'pluginId'>;
  targets: LiveStatusTarget[];
}

export interface ConsoleItemsLoadResult {
  items: LiveConsoleItem[];
  catalog?: CatalogResolution;
  catalogUnavailable: boolean;
  status: StatusJsonPayload;
}

type InspectTarget = typeof inspectRebuildTarget;
type DiscoverTargets = typeof discoverRebuildTargetNames;

export type StatusCommandRuntime = Partial<RebuildExecutionContext> & {
  catalogResolution?: CatalogResolution;
  catalogPlugins?: PluginMeta[];
  inspectTarget?: InspectTarget;
  discoverTargets?: DiscoverTargets;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function catalogFailureMessage(failure: Error): string {
  return failure.message;
}

function selectedPlatforms(platform: PlatformName | 'both' | undefined): PlatformName[] {
  return platform === 'codex' || platform === 'claude' ? [platform] : ['codex', 'claude'];
}

function selectedScopes(scope: Scope | undefined): Scope[] {
  return scope ? [scope] : ['user', 'project'];
}

function componentLabel(component: OwnedComponent): string {
  if ('path' in component) return component.path;
  if (component.kind === 'native-plugin') return component.pluginId;
  return component.label;
}

function componentChecks(inspection: OwnershipInspection): LiveStatusComponentCheck[] {
  return inspection.components.map((entry) => ({
    kind: entry.component.kind,
    label: componentLabel(entry.component),
    artifactKey: entry.component.identity.artifactKey,
    state: entry.state,
    ...(entry.diagnostic ? { error: entry.diagnostic } : {}),
  }));
}

function inspectionErrors(inspection: OwnershipInspection): LiveStatusError[] {
  return inspection.errors.map((entry) => ({
    code: 'inspectionFailed',
    component: entry.label,
    message: entry.message,
  }));
}

function projectLiveState(options: {
  inspection: OwnershipInspection;
  requiredComponents: readonly OwnedComponent[];
  optionalComponents: readonly OwnedComponent[];
}): LiveStatusState {
  if (
    options.inspection.state === 'error'
    || options.inspection.components.some((entry) => entry.state === 'error')
  ) return 'error';
  const owned = options.inspection.components.filter((entry) => (
    entry.state === 'present' || entry.state === 'partial'
  ));
  if (owned.length === 0) return 'absent';
  if (owned.some((entry) => entry.state === 'partial')) return 'partial';
  const required = new Set(options.requiredComponents);
  const optional = new Set(options.optionalComponents);
  const stalePresent = options.inspection.components.some((entry) =>
    entry.state === 'present'
    && !required.has(entry.component)
    && !optional.has(entry.component));
  if (stalePresent) return 'partial';
  const requiredPresent = options.requiredComponents.every((component) =>
    options.inspection.components.some((entry) =>
      entry.component === component && entry.state === 'present'));
  if (!requiredPresent) return 'partial';
  if (options.requiredComponents.length > 0) return 'present';
  return options.optionalComponents.some((component) =>
    options.inspection.components.some((entry) =>
      entry.component === component && entry.state === 'present'))
    ? 'present'
    : 'absent';
}

function recommendation(
  target: LiveStatusTargetIdentity,
  state: LiveStatusState,
): LiveStatusRecommendation | undefined {
  const suffix = `-p ${target.platform} -s ${target.scope}`;
  if (state === 'absent') {
    return {
      command: `aw install ${target.plugin} ${suffix}`,
      reason: 'absent',
    };
  }
  if (state === 'partial') {
    return {
      command: `aw reinstall ${target.plugin} ${suffix}`,
      reason: 'partial',
    };
  }
  return undefined;
}

function createErrorTarget(options: {
  plugin: string;
  version?: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  code: LiveStatusError['code'];
  message: string;
}): LiveStatusTarget {
  return {
    target: {
      plugin: options.plugin,
      ...(options.version ? { version: options.version } : {}),
      platform: options.platform,
      scope: options.scope,
      cwd: options.cwd,
    },
    state: 'error',
    components: [],
    errors: [{ code: options.code, message: options.message }],
  };
}

function supportsTarget(plugin: PluginMeta, platform: PlatformName, scope: Scope): boolean {
  if (!supportsPlatform(plugin.manifest, platform)) return false;
  return platform !== 'codex' || scope !== 'project' || hasCodexProjectManagedArtifacts(plugin);
}

function catalogInfo(
  catalog: CatalogResolution | undefined,
  failure?: Error,
): LiveStatusCatalogInfo {
  return {
    ...(catalog?.source ? { source: catalog.source } : {}),
    ...(catalog?.channel ? { channel: catalog.channel } : {}),
    ...(catalog?.catalogVersion ? { catalogVersion: catalog.catalogVersion } : {}),
    ...(failure ? {
      error: {
        code: 'catalogUnavailable',
        message: catalogFailureMessage(failure),
      },
    } : {}),
  };
}

function sortTargets(targets: LiveStatusTarget[]): LiveStatusTarget[] {
  return targets.sort((left, right) =>
    left.target.plugin.localeCompare(right.target.plugin)
    || left.target.platform.localeCompare(right.target.platform)
    || left.target.scope.localeCompare(right.target.scope));
}

function renderHuman(payload: StatusJsonPayload, verbose: boolean): string {
  const lines: string[] = [];
  if (payload.catalog.error) {
    lines.push(`Catalog 错误：${payload.catalog.error.message}`);
  } else if (payload.catalog.catalogVersion) {
    lines.push(`Catalog：${payload.catalog.catalogVersion}${payload.catalog.channel ? ` (${payload.catalog.channel})` : ''}`);
  }
  if (payload.targets.length === 0) lines.push('没有发现可检查的目标。');
  for (const entry of payload.targets) {
    const identity = `${entry.target.plugin} ${entry.target.platform}/${entry.target.scope}`;
    lines.push(`${identity}: ${entry.state}`);
    for (const error of entry.errors) lines.push(`  错误：${error.message}`);
    if (verbose) {
      for (const component of entry.components) {
        lines.push(
          `  组件：${component.kind ?? 'component'} ${component.label ?? component.artifactKey} ${component.state}`
          + (component.error ? ` · ${component.error}` : ''),
        );
      }
    }
    if (entry.state === 'partial' && entry.recommendation) {
      lines.push(`  建议：${entry.recommendation.command}`);
    }
    if (entry.state === 'absent') lines.push('  当前目标没有 AW-owned 组件。');
  }
  for (const error of payload.errors) lines.push(`发现错误：${error.message}`);
  return lines.join('\n');
}

async function resolveCatalogState(options: {
  env: NodeJS.ProcessEnv;
  raw: ReturnType<typeof normalizeStatusCommandOptions>;
  runtime: StatusCommandRuntime;
}): Promise<{
  catalog?: CatalogResolution;
  plugins: PluginMeta[];
  failure?: Error;
  failureKind?: 'catalog' | 'bundle';
}> {
  const catalog = options.runtime.catalogResolution;
  if (!catalog) {
    return {
      plugins: [],
      failureKind: 'catalog',
      failure: new Error('A resolved multi-source catalog is required.'),
    };
  }
  try {
    const plugins = options.runtime.catalogPlugins
      ?? await resolvePluginsFromCatalog(catalog.rootDir, undefined);
    return { catalog, plugins };
  } catch (error) {
    return {
      catalog,
      plugins: [],
      failureKind: 'bundle',
      failure: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function targetKey(plugin: string, platform: PlatformName, scope: Scope): string {
  return `${plugin}\0${platform}\0${scope}`;
}

export async function statusCommand(
  pluginNames: string[] = [],
  rawOptions: RawStatusCommandOptions = {},
  runtime: StatusCommandRuntime = {},
): Promise<{
  output: string;
  payload: StatusJsonPayload;
  catalog?: CatalogResolution;
  plugins: PluginMeta[];
  hasErrors: boolean;
}> {
  const options = normalizeStatusCommandOptions(rawOptions);
  const env = runtime.env ?? process.env;
  const context: RebuildExecutionContext = {
    env,
    nativeCliRunner: runtime.nativeCliRunner ?? getDefaultNativeCliRunner(),
    reporter: runtime.reporter ?? createNoopReporter(),
    debugLogger: runtime.debugLogger ?? createNoopDebugLogger(),
  };
  const catalogState = await resolveCatalogState({ env, raw: options, runtime });
  const catalogByName = new Map(
    catalogState.plugins.map((plugin) => [plugin.manifest.name, plugin]),
  );
  const platforms = selectedPlatforms(options.platform);
  const scopes = selectedScopes(options.scope);
  const explicitNames = [...new Set(pluginNames)];
  const globalErrors: LiveStatusError[] = catalogState.failureKind === 'bundle'
    ? [{ code: 'bundleUnavailable', message: catalogFailureMessage(catalogState.failure!) }]
    : [];
  const namesByLocation = new Map<string, Set<string>>();
  const discoveredByLocation = new Map<string, Set<string>>();

  for (const platform of platforms) {
    for (const scope of scopes) {
      const names = new Set(explicitNames);
      const discovered = new Set<string>();
      if (explicitNames.length === 0) {
        for (const plugin of catalogState.plugins) {
          if (supportsTarget(plugin, platform, scope)) names.add(plugin.manifest.name);
        }
        try {
          for (const name of await (runtime.discoverTargets ?? discoverRebuildTargetNames)({
            cwd: options.cwd,
            env,
            platform,
            scope,
            nativeCliRunner: context.nativeCliRunner,
            nativeFailureMode: 'error',
          })) {
            names.add(name);
            discovered.add(name);
          }
        } catch (error) {
          globalErrors.push({
            code: 'discoveryFailed',
            message: `${platform}/${scope}: ${errorMessage(error)}`,
          });
        }
      }
      namesByLocation.set(targetKey('', platform, scope), names);
      discoveredByLocation.set(targetKey('', platform, scope), discovered);
    }
  }

  const targets: LiveStatusTarget[] = [];
  for (const platform of platforms) {
    for (const scope of scopes) {
      for (const pluginName of namesByLocation.get(targetKey('', platform, scope)) ?? []) {
        const plugin = catalogByName.get(pluginName);
        if (!plugin) {
          targets.push(createErrorTarget({
            plugin: pluginName,
            platform,
            scope,
            cwd: path.resolve(options.cwd),
            code: catalogState.failureKind === 'catalog' ? 'catalogUnavailable' : 'bundleUnavailable',
            message: catalogState.failureKind === 'catalog'
              ? `Current catalog 不可用：${catalogFailureMessage(catalogState.failure!)}`
              : catalogState.failureKind === 'bundle'
                ? `Current bundle 不可用：${catalogFailureMessage(catalogState.failure!)}`
                : `Current catalog 中没有插件 ${pluginName}。`,
          }));
          continue;
        }
        const staleProjectTarget = explicitNames.length === 0
          && platform === 'codex'
          && scope === 'project'
          && !plugin.manifest.apps
          && supportsPlatform(plugin.manifest, platform)
          && discoveredByLocation.get(targetKey('', platform, scope))?.has(pluginName) === true;
        if (!supportsTarget(plugin, platform, scope) && !staleProjectTarget) {
          if (explicitNames.length > 0) {
            targets.push(createErrorTarget({
              plugin: pluginName,
              version: plugin.manifest.version,
              platform,
              scope,
              cwd: path.resolve(options.cwd),
              code: 'bundleUnavailable',
              message: `${pluginName} 的 current bundle 不支持 ${platform}/${scope}。`,
            }));
          }
          continue;
        }
        try {
          const live = await (runtime.inspectTarget ?? inspectRebuildTarget)({
            plugin,
            platform,
            scope,
            cwd: options.cwd,
            catalog: catalogState.catalog!,
            context,
          });
          const identity: LiveStatusTargetIdentity = {
            plugin: live.target.identity.pluginName,
            version: live.target.identity.pluginVersion,
            platform,
            scope,
            cwd: path.resolve(live.target.identity.cwd),
          };
          const state = projectLiveState({
            inspection: live.inspection,
            requiredComponents: live.target.desiredOwnedComponents ?? live.target.ownedComponents,
            optionalComponents: live.target.optionalOwnedComponents ?? [],
          });
          const next = recommendation(identity, state);
          targets.push({
            target: identity,
            state,
            components: componentChecks(live.inspection),
            errors: inspectionErrors(live.inspection),
            ...(next ? { recommendation: next } : {}),
          });
        } catch (error) {
          targets.push(createErrorTarget({
            plugin: pluginName,
            version: plugin.manifest.version,
            platform,
            scope,
            cwd: path.resolve(options.cwd),
            code: 'inspectionFailed',
            message: errorMessage(error),
          }));
        }
      }
    }
  }

  const payload: StatusJsonPayload = {
    schemaVersion: 3,
    catalog: catalogInfo(
      catalogState.catalog,
      catalogState.failureKind === 'catalog' ? catalogState.failure : undefined,
    ),
    filters: {
      plugins: explicitNames,
      platform: options.platform ?? 'both',
      ...(options.scope ? { scope: options.scope } : {}),
      cwd: path.resolve(options.cwd),
    },
    targets: sortTargets(targets),
    errors: globalErrors,
  };
  const hasErrors = Boolean(payload.catalog.error)
    || payload.errors.length > 0
    || payload.targets.some((target) => target.state === 'error');
  return {
    output: options.json ? JSON.stringify(payload) : renderHuman(payload, Boolean(options.verbose)),
    payload,
    ...(catalogState.catalog ? { catalog: catalogState.catalog } : {}),
    plugins: catalogState.plugins,
    hasErrors,
  };
}

export async function loadConsoleItemsResult(
  rawOptions: RawStatusCommandOptions & { includeCatalogOnly?: boolean } = {},
  runtime: StatusCommandRuntime = {},
): Promise<ConsoleItemsLoadResult> {
  if (
    runtime.catalogResolution === undefined
    && runtime.catalogPlugins === undefined
    && runtime.inspectTarget === undefined
    && runtime.discoverTargets === undefined
  ) {
    const result = await statusCommandV5({
      cwd: rawOptions.cwd ?? process.cwd(),
      env: runtime.env,
      platform: rawOptions.platform,
      scope: rawOptions.scope,
      verbose: rawOptions.verbose,
    });
    const targets: LiveStatusTarget[] = result.payload.targets.map((entry) => ({
      target: {
        plugin: entry.pluginId,
        ...(entry.version ? { version: entry.version } : {}),
        platform: entry.platform,
        scope: entry.scope,
        cwd: entry.cwd,
      },
      state: entry.state,
      components: entry.components.map((component) => ({
        artifactKey: component.key,
        state: component.state,
        ...(component.error ? {
          errorCode: component.error.code,
          error: component.error.message,
        } : {}),
      })),
      errors: entry.errors,
    }));
    const groups = new Map<string, LiveConsoleItem>();
    const summaries = new Map(result.pluginSummaries.map((summary) => [summary.pluginId, summary]));
    for (const target of targets) {
      const summary = summaries.get(target.target.plugin);
      const current = groups.get(target.target.plugin) ?? {
        pluginName: target.target.plugin,
        ...(target.target.version ? { version: target.target.version } : {}),
        ...(summary ? {
          pluginSummary: {
            description: summary.description,
            ...(summary.configSchema ? { configSchema: summary.configSchema } : {}),
          },
        } : {}),
        targets: [],
      };
      current.targets.push(target);
      groups.set(target.target.plugin, current);
    }
    const allSourcesFailed = result.payload.catalog.sources.length > 0
      && result.payload.catalog.sources.every((source) => source.error !== undefined);
    const status: StatusJsonPayload = {
      schemaVersion: 3,
      catalog: allSourcesFailed ? {
        error: {
          code: 'catalogUnavailable',
          message: result.payload.catalog.sources.map((source) => source.error).join('; '),
        },
      } : {},
      filters: result.payload.filters,
      targets,
      errors: [
        ...result.payload.catalog.sources.flatMap((source) => source.error
          ? [{ code: 'discoveryFailed' as const, message: `${source.id}: ${source.error}` }]
          : []),
        ...result.payload.errors.map((error) => ({
          code: 'discoveryFailed' as const,
          message: error.message,
        })),
      ],
    };
    return {
      items: [...groups.values()].sort((left, right) =>
        left.pluginName.localeCompare(right.pluginName)),
      catalogUnavailable: allSourcesFailed,
      status,
    };
  }
  const result = await statusCommand([], rawOptions, runtime);
  const groups = new Map<string, LiveConsoleItem>();
  const pluginsByName = new Map(result.plugins.map((plugin) => [plugin.manifest.name, plugin]));
  for (const target of result.payload.targets) {
    const current = groups.get(target.target.plugin) ?? {
      pluginName: target.target.plugin,
      ...(target.target.version ? { version: target.target.version } : {}),
      ...(pluginsByName.get(target.target.plugin)
        ? { plugin: pluginsByName.get(target.target.plugin) }
        : {}),
      targets: [],
    };
    current.targets.push(target);
    groups.set(target.target.plugin, current);
  }
  return {
    items: [...groups.values()].sort((left, right) =>
      left.pluginName.localeCompare(right.pluginName)),
    ...(result.catalog ? { catalog: result.catalog } : {}),
    catalogUnavailable: Boolean(result.payload.catalog.error),
    status: result.payload,
  };
}

export async function loadConsoleItems(
  rawOptions: RawStatusCommandOptions & { includeCatalogOnly?: boolean } = {},
  runtime: StatusCommandRuntime = {},
): Promise<LiveConsoleItem[]> {
  return (await loadConsoleItemsResult(rawOptions, runtime)).items;
}
