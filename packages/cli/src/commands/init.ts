import {
  initializeLocalMarketplace,
  type LocalMarketplaceGateOptions,
} from '../utils/local-marketplace.js';

export async function initCommand(
  options: { force?: boolean; env?: NodeJS.ProcessEnv; gate?: LocalMarketplaceGateOptions } = {},
): Promise<{ rootDir: string; changed: boolean; warnings: string[] }> {
  const result = await initializeLocalMarketplace({
    force: options.force === true,
    env: options.env,
    gate: options.gate,
  });

  return {
    ...result,
    warnings: result.warnings ?? [],
  };
}
