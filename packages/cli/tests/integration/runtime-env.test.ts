import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { applyCodexInstallLedger } from '../../src/adapters/codex.js';
import { statusCommand } from '../../src/commands/status.js';
import {
  createAvailableLedger,
  initializeLocalMarketplace,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
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

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  codexHome: string;
  embeddedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-env-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    codexHome: path.join(root, 'codex-home'),
    embeddedRoot,
  };
}

async function removePluginFromLocalMarketplace(
  awHome: string,
  pluginName: string,
): Promise<void> {
  await fs.remove(path.join(awHome, 'plugins', pluginName));
  for (const manifestPath of [
    path.join(awHome, '.claude-plugin', 'marketplace.json'),
    path.join(awHome, '.agents', 'plugins', 'marketplace.json'),
  ]) {
    const manifest = await fs.readJson(manifestPath);
    manifest.plugins = (manifest.plugins ?? []).filter(
      (entry: { name?: string }) => entry.name !== pluginName,
    );
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  }
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('runtime env integration', () => {
  it('honors runtime.env for platform detection, default adapters, and current catalog reads', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const env = {
      ...process.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: codexHome,
      AW_FORCE_CODEX_AVAILABLE: '1',
    };

    await initializeLocalMarketplace({ force: true, env });
    await removePluginFromLocalMarketplace(awHome, 'git-commit');

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const ledger = await applyCodexInstallLedger(
      createAvailableLedger(),
      plugin,
      'user',
      repoRoot,
    );
    await writeInstalledLedger(ledger, env);

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
      },
    );

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      platform: 'codex',
    });
    expect(result.reports[0]?.plugins[0]).toMatchObject({
      pluginName: 'git-commit',
      scopeManagedEvidence: {
        ledger: true,
      },
    });
    expect(result.reports[0]?.plugins[0]?.catalogCompatibility).toBeUndefined();
    expect(result.reports[0]?.plugins[0]?.currentCatalog).toBeUndefined();
  });
});
