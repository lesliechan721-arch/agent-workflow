import {
  resolveCurrentCatalog,
} from '../utils/plugin-catalog.js';
import type { CatalogResolution, CatalogSelectionOptions, CatalogSelector } from '../types.js';

function withSelectorOverrideSource(
  catalog: CatalogResolution,
  overrideSource: CatalogSelector['overrideSource'] | undefined,
): CatalogResolution {
  if (!overrideSource || !catalog.selector) {
    return catalog;
  }

  const selector = {
    ...catalog.selector,
    overrideSource,
  };
  return {
    ...catalog,
    selector,
    ...(catalog.cacheFallback?.matchedSelector
      ? {
          cacheFallback: {
            ...catalog.cacheFallback,
            matchedSelector: {
              ...catalog.cacheFallback.matchedSelector,
              overrideSource,
            },
          },
        }
      : {}),
  };
}

export async function initCommand(
  options: {
    force?: boolean;
    env?: NodeJS.ProcessEnv;
    selectorOverrideSource?: CatalogSelector['overrideSource'];
  } & CatalogSelectionOptions = {},
): Promise<{ rootDir: string; changed: boolean; warnings: string[]; catalog: CatalogResolution }> {
  const force = options.force === true;
  const result = await resolveCurrentCatalog(options.env, {
    ...(options.catalogChannel === undefined ? {} : { channel: options.catalogChannel }),
    ...(options.catalogVersion === undefined ? {} : { catalogVersion: options.catalogVersion }),
    freshnessPolicy: force ? 'forceRemote' : 'requireRemote',
    forceRefresh: force,
  });
  const catalog = withSelectorOverrideSource(result, options.selectorOverrideSource);

  if (force && catalog.source === 'cache') {
    const detail = catalog.reason?.trim()
      ? `远程 current catalog 不可用：${catalog.reason}`
      : '远程 current catalog 不可用。';
    throw new Error(`\`aw init --force\` 需要重新拉取并重建 current catalog cache；${detail}`);
  }

  return {
    rootDir: catalog.rootDir,
    changed: force || catalog.source !== 'cache',
    warnings: [],
    catalog,
  };
}
