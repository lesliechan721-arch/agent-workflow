import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readMarketplaceSourceMeta,
  readPluginManifest,
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
  it('reads marketplace source metadata and plugin source manifest', async () => {
    const repoRoot = await makeTempRepo();
    const [marketplace, plugin] = await Promise.all([
      readMarketplaceSourceMeta(repoRoot),
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ]);

    expect(marketplace).toEqual({
      owner: {
        name: 'Leslie Chan',
        url: 'https://github.com/LeslieChan/agent-workflows',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
    });

    expect(plugin.manifest.marketplace).toMatchObject({
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    });
    expect(plugin.manifest.extensions?.hooks?.[0]).toMatchObject({
      event: 'command',
      matcher: 'git *',
    });
  });

  it('rejects deprecated top-level claude block', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.claude = {
      hooks: './hooks/hooks.json',
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('unknown field "claude"');
  });

  it('rejects unknown root marketplace metadata fields', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePath = path.join(repoRoot, 'plugins', 'marketplace-source.json');
    const source = await fs.readJson(sourcePath);
    source.metadata = {
      internal: true,
    };
    await fs.writeJson(sourcePath, source, { spaces: 2 });

    await expect(readMarketplaceSourceMeta(repoRoot)).rejects.toThrow(
      'unknown field "metadata"',
    );
  });
});
