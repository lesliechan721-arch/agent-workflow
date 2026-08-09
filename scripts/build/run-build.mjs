import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWithCache } from './build-cache.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const result = await buildWithCache(repoRoot, { force: true });
  console.log(`Build cache updated (${result.reason}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
