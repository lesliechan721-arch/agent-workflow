import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';

const defaultPackageRoot = fileURLToPath(new URL('../..', import.meta.url));

export async function writeFixtureConfig(
  root: string,
  fixture: string,
  options: { sourceIsolation?: boolean; basePackageRoot?: string } = {},
): Promise<string> {
  const packageRoot = options.basePackageRoot ?? defaultPackageRoot;
  const config = path.join(root, 'vitest.config.mjs');
  await fs.writeFile(config, [
    `import base from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'vitest.config.ts')).href)};`,
    // Keep the native ESM boundary while replacing the multi-project selection.
    `export default { ...base, root: ${JSON.stringify(root)}, test: { ...base.test, projects: undefined, environment: 'node', include: [${JSON.stringify(fixture)}], hookTimeout: 10000, maxWorkers: 1, minWorkers: 1,`,
    `setupFiles: ${JSON.stringify(options.sourceIsolation ? [path.join(packageRoot, 'tests/setup/test-isolation.ts')] : [])} } };`,
  ].join('\n'));
  return config;
}
