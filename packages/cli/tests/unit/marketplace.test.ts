import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { validateBundleLayout } from '../../src/utils/bundle-layout.js';
import { readJsonFile } from '../../src/utils/json.js';
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-marketplace-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('marketplace bundle', () => {
  it('keeps marketplace mirrors in sync and fixes source paths to ./plugins/<plugin>', async () => {
    const repoRoot = await makeTempRepo();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    const [claudeMarketplace, codexMarketplace] = await Promise.all([
      readJsonFile(path.join(embeddedRoot, '.claude-plugin', 'marketplace.json')),
      readJsonFile(path.join(embeddedRoot, '.agents', 'plugins', 'marketplace.json')),
    ]);

    expect(codexMarketplace).toEqual(claudeMarketplace);
    expect(claudeMarketplace).toMatchObject({
      name: 'aw',
      owner: {
        name: 'Leslie Chan',
      },
      plugins: [
        {
          name: 'git-commit',
          source: './plugins/git-commit',
          category: 'workflow',
          strict: true,
        },
      ],
    });
  });

  it('validates the generated embedded root layout', async () => {
    const repoRoot = await makeTempRepo();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('rejects rendered native assets and hooks with invalid bundle semantics', async () => {
    const repoRoot = await makeTempRepo();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const claudeManifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const codexManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');

    const codexManifest = await fs.readJson(codexManifestPath);
    codexManifest.apps = './codex/.app.json';
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, 'codex', '.app.json'), {
      apps: {
        dashboard: {},
      },
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'codex.apps.apps.dashboard.id',
    );

    delete codexManifest.apps;
    codexManifest.mcpServers = './codex/.mcp.json';
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, 'codex', '.mcp.json'), {
      mcpServers: [],
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'expected top-level "mcpServers" object',
    );

    delete codexManifest.mcpServers;
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });
    const claudeManifest = await fs.readJson(claudeManifestPath);
    claudeManifest.hooks = './claude/hooks/hooks.json';
    await fs.writeJson(claudeManifestPath, claudeManifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, 'claude', 'hooks', 'hooks.json'), {
      hooks: [],
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'expected top-level "hooks" object',
    );

    await fs.writeJson(path.join(pluginRoot, 'claude', 'hooks', 'hooks.json'), {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                command: 'echo missing type',
              },
            ],
          },
        ],
      },
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'claude.hooks.PreToolUse[0].hooks[0].type',
    );
  });
});
