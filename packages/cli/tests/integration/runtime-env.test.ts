import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { applyCodexInstallLedger } from '../../src/adapters/codex.js';
import { statusCommand } from '../../src/commands/status.js';
import {
  createAvailableLedger,
  initializeLocalMarketplace,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { getCatalogFullPackageRoot } from '../../src/utils/bundle-layout.js';
import { createSafeCommandExecutionContext } from '../helpers/cli-runtime.js';
import { activateCliEmbeddedRoot, createCliTestWorkspace } from '../helpers/workspace.js';

function normalizeMacTmpPath(value: string): string {
  return value.replace(/^\/private(?=\/var\/folders\/)/, '');
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

describe('runtime env integration', () => {
  it('honors runtime.env for platform detection, default adapters, and current catalog reads', async () => {
    const workspace = await createCliTestWorkspace();
    const { repoRoot, awHome, env } = workspace;
    const embeddedRoot = workspace.embeddedRoot!;
    activateCliEmbeddedRoot(embeddedRoot, 'runtime env integration embedded root');

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
      createSafeCommandExecutionContext({ env }),
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
    expect(result.reports[0]?.plugins[0]?.currentCatalog).toMatchObject({
      available: true,
      source: 'local',
      sidecarManifestPackage: {
        source: 'localFixture',
      },
      fullCatalog: {
        source: 'local',
        freshness: 'localFixture',
      },
    });
    expect(
      normalizeMacTmpPath(String(result.reports[0]?.plugins[0]?.currentCatalog?.rootDir)),
    ).toBe(normalizeMacTmpPath(getCatalogFullPackageRoot(embeddedRoot)));
  });
});
