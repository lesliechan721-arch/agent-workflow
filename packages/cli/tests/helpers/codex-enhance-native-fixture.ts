import path from 'node:path';

import fs from 'fs-extra';

/** Prepare a copied plugin for native ownership/projection tests, without staging dependencies. */
export async function stubCodexFileSelectionForNativeFixture(pluginRoot: string): Promise<void> {
  // Keep the real renderer and roles. The external parser and its build closure belong
  // to smoke tests; fail immediately if an ownership test starts to use parser behavior.
  await fs.writeFile(path.join(pluginRoot,
    'skills/codex-subagent-guide/scripts/file-selection/selection.mjs'), [
    "export { LIMITS } from './contracts.mjs';",
    "function fail() { throw new Error('File selection is outside the native ownership fixture.'); }",
    'export const resolveFiles = fail;',
    'export const assertNativeSelectionReadable = fail;',
    '',
  ].join('\n'));
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest: { scripts?: { node?: unknown }; buildConfig?: { cacheable?: boolean } } =
    await fs.readJson(manifestPath);
  if (manifest.scripts) delete manifest.scripts.node;
  if (manifest.buildConfig) delete manifest.buildConfig.cacheable;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(pluginRoot, 'scripts/build-runtime.mjs'));
}
