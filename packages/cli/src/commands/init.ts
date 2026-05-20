import {
  resolveCurrentCatalog,
} from '../utils/plugin-catalog.js';
import type { CatalogResolution, CatalogSelectionOptions, CatalogSelector } from '../types.js';

export async function initCommand(
  options: {
    force?: boolean;
    env?: NodeJS.ProcessEnv;
    selectorOverrideSource?: CatalogSelector['overrideSource'];
  } & CatalogSelectionOptions = {},
): Promise<{ rootDir: string; changed: boolean; warnings: string[]; catalog: CatalogResolution }> {
  const result = await resolveCurrentCatalog(options.env, {
    ...(options.catalogChannel === undefined ? {} : { channel: options.catalogChannel }),
    ...(options.catalogVersion === undefined ? {} : { catalogVersion: options.catalogVersion }),
    forceRefresh: options.force === true,
  });
  if (options.selectorOverrideSource && result.selector) {
    result.selector.overrideSource = options.selectorOverrideSource;
  }

  if (options.force === true && result.source === 'cache') {
    const detail = result.reason?.trim()
      ? `远程 current catalog 不可用：${result.reason}`
      : '远程 current catalog 不可用。';
    throw new Error(`\`aw init --force\` 需要重新拉取并重建 current catalog cache；${detail}`);
  }

  return {
    rootDir: result.rootDir,
    changed: options.force === true || result.source !== 'cache',
    warnings: [],
    catalog: result,
  };
}
