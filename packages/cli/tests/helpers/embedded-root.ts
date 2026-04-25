import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { bundlePlugins } from '../../scripts/bundle-plugins.js';

export async function createSyntheticEmbeddedRoot(repoRoot: string): Promise<string> {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-embedded-root-'));
  await bundlePlugins({
    repoRoot,
    outputRoot,
  });

  return outputRoot;
}
