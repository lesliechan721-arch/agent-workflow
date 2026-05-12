import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogResolution } from '../../src/types.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const { resolveCurrentCatalogMock } = vi.hoisted(() => ({
  resolveCurrentCatalogMock: vi.fn<() => Promise<CatalogResolution>>(),
}));

vi.mock('../../src/utils/plugin-catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-catalog.js')>(
    '../../src/utils/plugin-catalog.js',
  );
  return {
    ...actual,
    resolveCurrentCatalog: resolveCurrentCatalogMock,
  };
});

const { loadPluginTargetsForRemovalCommand } = await import('../../src/commands/common.js');

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  embeddedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-removal-targets-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  resolveCurrentCatalogMock.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('removal target resolution', () => {
  it('falls back to the embedded bundle instead of historical when only the local bundle manifest is unreadable', async () => {
    const workspace = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: workspace.awHome,
    };

    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    resolveCurrentCatalogMock.mockResolvedValue({
      rootDir: workspace.awHome,
      source: 'local',
    });

    const localBundleRoot = path.join(workspace.awHome, 'plugins', 'git-commit');
    await fs.copy(
      path.join(workspace.embeddedRoot, 'plugins', 'git-commit'),
      localBundleRoot,
    );
    await fs.writeFile(
      path.join(localBundleRoot, '.agents-plugin', 'plugin.json'),
      '{"name":',
      'utf8',
    );

    const [target] = await loadPluginTargetsForRemovalCommand(
      workspace.repoRoot,
      'user',
      ['git-commit'],
      {
        allowHistoricalFallback: true,
        env,
      },
    );

    expect(target.source).toBe('currentCatalog');
    expect(target.currentPlugin?.rootDir).toBe(
      path.join(workspace.embeddedRoot, 'plugins', 'git-commit'),
    );
    expect(target.embeddedPlugin?.rootDir).toBe(
      path.join(workspace.embeddedRoot, 'plugins', 'git-commit'),
    );
  });
});
