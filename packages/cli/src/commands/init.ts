import { initializeLocalMarketplace } from '../utils/local-marketplace.js';

export async function initCommand(
  options: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ rootDir: string; changed: boolean; warnings: string[] }> {
  const result = await initializeLocalMarketplace({
    force: options.force === true,
    env: options.env,
  });

  return {
    ...result,
    warnings: result.warnings ?? [],
  };
}
