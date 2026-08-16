import fs from 'node:fs';
import path from 'node:path';

import type {
  CatalogSource,
  PlatformName,
  PluginConfigSchemaField,
  Scope,
} from '../types.js';
import { hasCodexProjectManagedArtifacts } from '../utils/codex-project-surface.js';
import {
  catalogSourceErrorCode,
  sanitizeCatalogSourceError,
} from '../utils/catalog-public-error.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
import { inventoryLegacyOwnerReferences } from '../utils/catalog-source-references.js';
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
  components: [];
  errors: Array<{ code: string; message: string }>;
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
  description: string;
  configSchema?: Record<string, PluginConfigSchemaField>;
  targets: Record<PlatformName, Record<Scope, boolean>>;
}

export interface StatusV4PluginSummary {
  pluginName: string;
  pluginId: string;
  description: string;
  configSchema?: Record<string, PluginConfigSchemaField>;
}

interface PlannedStatusSelector {
  raw: string;
  parsed: ReturnType<typeof parsePluginId>;
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

function renderStatusV4(payload: StatusV4Payload): string {
  const lines = [`Catalog sources: ${payload.catalog.sources.length}`];
  for (const source of payload.catalog.sources) {
    lines.push(`${source.primary ? '*' : '-'} ${source.id}: ${source.error ?? source.freshness ?? 'unavailable'}`);
  }
  for (const target of payload.targets) {
    lines.push(`${target.pluginId} ${target.platform}/${target.scope}: ${target.state}`);
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
}): Promise<{
  payload: StatusV4Payload;
  output: string;
  hasErrors: boolean;
  pluginSummaries: StatusV4PluginSummary[];
}> {
  const env = options.env ?? process.env;
  const cliVersion = options.cliVersion ?? assertStrictSemVer(
    (JSON.parse(fs.readFileSync(path.join(resolveCliPackageRoot(), 'package.json'), 'utf8')) as {
      version?: unknown;
    }).version,
    'packages/cli/package.json version',
  );
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const configured = new Map(snapshot.config.sources.map((source) => [source.id, source]));
  const requested = options.plugins ?? [];
  const selectorErrors: Array<{ code: string; message: string }> = [];
  const plannedSelectors: PlannedStatusSelector[] = [];
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
    if (parsed.sourceId !== undefined && !configured.has(parsed.sourceId)) {
      selectorErrors.push({
        code: 'pluginNotFound',
        message: `Plugin "${selector}" was not found because catalog source "${parsed.sourceId}" is not configured.`,
      });
      continue;
    }
    plannedSelectors.push({ raw: selector, parsed });
  }
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
              return {
                name: entry.name,
                version: entry.version,
                description: plugin.manifest.description,
                ...(plugin.manifest.config?.schema
                  ? { configSchema: plugin.manifest.config.schema }
                  : {}),
                targets: {
                  claude: { user: claude, project: claude },
                  codex: {
                    user: codex,
                    project: codex && hasCodexProjectManagedArtifacts(plugin),
                  },
                },
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
        selectorErrors.push({
          code: 'pluginNotFound',
          message: `Plugin "${selector.raw}" was not found in the selected catalog source set.`,
        });
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
  const platforms = selectedPlatforms(options.platform);
  const scopes = selectedScopes(options.scope);
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
        components: [] as [],
      };
      if (entry.targets[platform][scope]) {
        return [{ ...target, state: 'absent', errors: [] }];
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
  const inventory = await inventoryLegacyOwnerReferences({ cwd: options.cwd, env });
  const legacyOwners = inventory.references.filter((reference) => reference.kind === 'legacyOwner');
  const errors = [
    ...selectorErrors,
    ...legacyOwners.map((reference) => ({
      code: 'legacyStateUnsupported',
      message: `legacyStateUnsupported: schema 1 owner at ${reference.location}`,
    })),
  ];
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
    targets,
    errors,
  };
  const hasErrors = payload.catalog.sources.some((source) => source.error !== undefined)
    || payload.errors.length > 0
    || payload.targets.some((target) => target.state === 'error');
  return {
    payload,
    output: options.json ? JSON.stringify(payload) : renderStatusV4(payload),
    hasErrors,
    pluginSummaries: available.map((entry) => ({
      pluginName: entry.name,
      pluginId: formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
      description: entry.description,
      ...(entry.configSchema ? { configSchema: entry.configSchema } : {}),
    })),
  };
}
