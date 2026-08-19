import type {
  CatalogFreshnessPolicy,
} from '../types.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { catalogSourceErrorCode } from '../utils/catalog-public-error.js';
import { withResolvedMultiSourceCatalog } from '../utils/multi-source-catalog.js';

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

export async function initCommand(
  options: InitCommandV4Options,
): Promise<InitCommandResult> {
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
