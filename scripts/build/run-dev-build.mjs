import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDevWithCache } from './dev-build-cache.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const result = await buildDevWithCache(repoRoot);
  for (const target of result.targets) {
    console.log(`${target.target}: ${target.reused ? 'reused' : `rebuilt (${target.reason})`}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
