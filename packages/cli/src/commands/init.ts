import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { catalogSourceErrorCode } from '../utils/catalog-public-error.js';
import { resolvePartialCatalogOperationContext } from '../utils/catalog-operation-context.js';

export interface InitCatalogSourceResult {
  id: string;
  ok: boolean;
  activeReady: boolean;
  requestedRef?: string;
  resolvedCommit?: string;
  catalogVersion?: string;
  channel?: string;
  error?: string;
  errorCode?: string;
  recovery?: string;
}

export interface InitCommandResult {
  ok: boolean;
  primarySourceId: string;
  configDigest: string;
  compositeDigest: string;
  sources: InitCatalogSourceResult[];
  recovery: string[];
}

interface InitCommandOptions {
  env?: NodeJS.ProcessEnv;
}

export async function initCommand(
  options: InitCommandOptions,
): Promise<InitCommandResult> {
  const env = options.env ?? process.env;
  const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
  const context = await resolvePartialCatalogOperationContext({
    configSnapshot,
    env,
  });
  const sources = context.catalog.sources.map((item): InitCatalogSourceResult => {
    if (item.error) {
      return {
        id: item.sourceId,
        ok: false,
        activeReady: false,
        error: item.error.message,
        errorCode: catalogSourceErrorCode(item.error),
        recovery: `Run aw catalog source sync ${item.sourceId}.`,
      };
    }
    const resolution = item.resolution!;
    return {
      id: item.sourceId,
      ok: true,
      activeReady: true,
      requestedRef: resolution.requestedRef,
      resolvedCommit: resolution.resolvedCommit,
      catalogVersion: resolution.manifest.catalogVersion,
      channel: resolution.manifest.channel,
    };
  });
  return {
    ok: sources.every((source) => source.ok),
    primarySourceId: context.catalog.primarySourceId,
    configDigest: context.catalog.configDigest,
    compositeDigest: context.catalog.compositeDigest,
    sources,
    recovery: sources.flatMap((source) => source.recovery ? [source.recovery] : []),
  };
}
