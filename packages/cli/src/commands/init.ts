import type {
  CatalogFreshnessPolicy,
  CatalogResolution,
  CatalogSelectionOptions,
  CatalogSelector,
} from '../types.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { catalogSourceErrorCode } from '../utils/catalog-public-error.js';
import { withResolvedMultiSourceCatalog } from '../utils/multi-source-catalog.js';
import { resolveCurrentCatalog } from '../utils/plugin-catalog.js';

export interface InitCatalogSourceResult {
  id: string;
  ok: boolean;
  requestedRef?: string;
  resolvedCommit?: string;
  catalogVersion?: string;
  channel?: string;
  freshness?: 'remote' | 'cache' | 'path';
  error?: string;
  errorCode?: string;
}

export interface InitCommandResult {
  ok: boolean;
  changed: boolean;
  warnings: string[];
  primarySourceId: string;
  configDigest: string;
  compositeDigest: string;
  sources: InitCatalogSourceResult[];
}

interface InitCommandV4Options {
  force?: boolean;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
}

type LegacyInitCommandOptions = {
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  selectorOverrideSource?: CatalogSelector['overrideSource'];
} & CatalogSelectionOptions;

type LegacyInitCommandResult = {
  rootDir: string;
  changed: boolean;
  warnings: string[];
  catalog: CatalogResolution;
};

export function initCommand(options: InitCommandV4Options): Promise<InitCommandResult>;
/** @deprecated Test-only compatibility for the removed npm catalog resolver contract. */
export function initCommand(options?: LegacyInitCommandOptions): Promise<LegacyInitCommandResult>;
export async function initCommand(
  options: InitCommandV4Options | LegacyInitCommandOptions = {},
): Promise<InitCommandResult | LegacyInitCommandResult> {
  if (!('cliVersion' in options)) {
    const force = options.force === true;
    const catalog = await resolveCurrentCatalog(options.env, {
      ...(options.catalogChannel === undefined ? {} : { channel: options.catalogChannel }),
      ...(options.catalogVersion === undefined ? {} : { catalogVersion: options.catalogVersion }),
      freshnessPolicy: force ? 'forceRemote' : 'requireRemote',
      forceRefresh: force,
    });
    const selector = options.selectorOverrideSource && catalog.selector
      ? { ...catalog.selector, overrideSource: options.selectorOverrideSource }
      : catalog.selector;
    const projected = selector ? { ...catalog, selector } : catalog;
    return {
      rootDir: projected.rootDir,
      changed: force || projected.source !== 'cache',
      warnings: [],
      catalog: projected,
    };
  }
  const env = options.env ?? process.env;
  const freshnessPolicy: CatalogFreshnessPolicy = options.force ? 'forceRemote' : 'requireRemote';
  const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
  return withResolvedMultiSourceCatalog({
    cliVersion: options.cliVersion,
    freshnessPolicy,
    configSnapshot,
    env,
    consume: (catalog) => {
      const sources = catalog.sources.map((item): InitCatalogSourceResult => {
        if (item.error) {
          return {
            id: item.sourceId,
            ok: false,
            error: item.error.message,
            errorCode: catalogSourceErrorCode(item.error),
          };
        }
        const resolution = item.resolution!;
        return {
          id: item.sourceId,
          ok: true,
          requestedRef: resolution.requestedRef,
          resolvedCommit: resolution.resolvedCommit,
          catalogVersion: resolution.manifest.catalogVersion,
          channel: resolution.manifest.channel,
          freshness: resolution.source,
        };
      });
      return {
        ok: sources.every((source) => source.ok),
        changed: sources.some((source) => source.ok && source.freshness !== 'cache'),
        warnings: [],
        primarySourceId: catalog.primarySourceId,
        configDigest: catalog.configDigest,
        compositeDigest: catalog.compositeDigest,
        sources,
      };
    },
  });
}
