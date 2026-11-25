import path from 'node:path';

import fs from 'fs-extra';

/** Prepare a copied plugin for native ownership/projection tests, without staging dependencies. */
export async function prepareSubagentForNativeFixture(pluginRoot: string): Promise<void> {
  // The renderer and managed command stay live. This fixture does not query a real Codex profile.
  const profilePath = path.join(pluginRoot, 'commands/scripts/adapters/codex-profile.mjs');
  const profile = await fs.readFile(profilePath, 'utf8');
  await fs.writeFile(profilePath, profile.replace("import { parse, stringify } from '../../../scripts/toml.mjs';",
    "function parse() { throw new Error('TOML parsing is outside the native ownership fixture.'); }\nconst stringify = parse;"));
  await fs.copy(
    path.join(pluginRoot, 'shared/task-instructions.md'),
    path.join(pluginRoot, 'commands/assets/task-instructions.md'),
  );
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest: { scripts?: { node?: unknown }; buildConfig?: { cacheable?: boolean } } =
    await fs.readJson(manifestPath);
  if (manifest.scripts) delete manifest.scripts.node;
  if (manifest.buildConfig) delete manifest.buildConfig.cacheable;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(pluginRoot, 'scripts/build-runtime.mjs'));
}
