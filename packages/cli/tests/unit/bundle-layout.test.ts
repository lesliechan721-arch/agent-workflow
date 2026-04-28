import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { validateBundleLayout } from '../../src/utils/bundle-layout.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-bundle-layout-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('bundle layout validation', () => {
  it('accepts bundle source manifests with skillTriggers without requiring a source skills directory', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(
      fs.pathExists(path.join(embeddedRoot, 'plugins', 'git-commit', 'skills')),
    ).resolves.toBe(false);
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });
});
