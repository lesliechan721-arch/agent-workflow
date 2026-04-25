import { initializeLocalMarketplace } from '../utils/local-marketplace.js';

export async function initCommand(
  options: { force?: boolean } = {},
): Promise<{ rootDir: string; changed: boolean }> {
  return initializeLocalMarketplace({
    force: options.force === true,
  });
}
