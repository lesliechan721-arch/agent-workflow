import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { preparePluginNativeTools } from '@lesliechan721/aw-plugin-core/manifest';

import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import { discoverPlugins } from '../../src/utils/manifest.js';
import { getCurrentSourceTestRootRegistry } from '../setup/test-isolation.js';
import { assertSafeTestCwd } from './test-isolation.js';

export async function createSyntheticEmbeddedRoot(repoRoot: string): Promise<string> {
  // Build-free fixtures still need Core's generated reader in their temporary
  // authoring copy. Never generate this runtime file in repository source.
  assertSafeTestCwd(repoRoot, getCurrentSourceTestRootRegistry(), 'createSyntheticEmbeddedRoot().repoRoot');
  for (const plugin of await discoverPlugins(repoRoot)) {
    await preparePluginNativeTools(plugin.rootDir, plugin.manifest);
  }
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-embedded-root-'));
  await bundlePlugins({
    repoRoot,
    outputRoot,
  });

  return outputRoot;
}
