import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverPlugins,
  generatePlatformManifest,
  readPluginManifest,
  syncGeneratedPluginManifests,
} from '../../src/utils/manifest.js';

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('manifest utils', () => {
  it('reads source manifest and keeps plugin paths relative', async () => {
    const repoRoot = await makeTempRepo();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));

    expect(plugin.manifest.skills).toBe('./skills');
    expect(plugin.manifest.claude?.hooks).toBe('./hooks/hooks.json');
  });

  it('rejects paths that escape the plugin root', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.skills = '../outside';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('path must start with "./"');
  });

  it('omits default Claude hooks path from generated manifest', async () => {
    const repoRoot = await makeTempRepo();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));

    const claudeManifest = generatePlatformManifest(plugin.manifest, 'claude');
    const codexManifest = generatePlatformManifest(plugin.manifest, 'codex');

    expect(claudeManifest.hooks).toBeUndefined();
    expect(claudeManifest.agents).toEqual(['./agents/commit-reviewer.md']);
    expect(codexManifest).not.toHaveProperty('agents');
  });

  it('syncs generated platform manifests for every discovered plugin', async () => {
    const repoRoot = await makeTempRepo();
    const plugins = await discoverPlugins(repoRoot);
    const written = await syncGeneratedPluginManifests(plugins);

    expect(written['git-commit']).toHaveLength(2);
    await expect(
      fs.readJson(path.join(repoRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      name: 'git-commit',
      skills: './skills',
    });
  });
});
