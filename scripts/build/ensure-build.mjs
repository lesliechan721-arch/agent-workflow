import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWithCache } from './build-cache.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const result = await buildWithCache(repoRoot);
  if (result.reused) {
    console.log(`Build reused: ${result.reason}.`);
  } else {
    console.log(`Build cache miss (${result.reason}); completed full build.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
