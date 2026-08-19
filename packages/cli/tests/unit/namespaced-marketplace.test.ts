import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  readStrictNamespacedMarketplaceRoot,
  replayNamespacedCodexSkillOverlays,
} from '../../src/utils/local-marketplace.js';
import {
  readSkillOwnerMarker,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const sourceIdentity = `sha256:${'a'.repeat(64)}`;

async function createMarketplaceRoot(rootDir: string): Promise<void> {
  await Promise.all([
    fs.outputJson(path.join(rootDir, 'config.json'), {
      schemaVersion: 2,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    }),
    fs.outputJson(path.join(rootDir, '.agents', 'plugins', 'marketplace.json'), {
      name: 'aw', owner: {}, interface: {}, plugins: [],
    }),
    fs.outputJson(path.join(rootDir, '.claude-plugin', 'marketplace.json'), {
      name: 'aw', owner: {}, interface: {}, plugins: [],
    }),
  ]);
}

describe('namespaced marketplace root', () => {
  it('treats an absent namespaced marketplace root as empty', async () => {
    const fixture = getCurrentSourceTestIsolation().layout.rootDir;
    await expect(replayNamespacedCodexSkillOverlays({
      sourceRoot: path.join(fixture, 'marketplaces', 'missing'),
      stagingRoot: path.join(fixture, 'staging'),
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).resolves.toBeUndefined();
  });

  it('reads only a canonical source-bound schema 2 root', async () => {
    const root = path.join(getCurrentSourceTestIsolation().layout.rootDir, 'marketplaces', 'official');
    await createMarketplaceRoot(root);
    await expect(readStrictNamespacedMarketplaceRoot({
      rootDir: root,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).resolves.toMatchObject({
      config: { sourceId: 'official', sourceIdentity, marketplaceName: 'aw' },
    });
    await expect(readStrictNamespacedMarketplaceRoot({
      rootDir: root,
      sourceId: 'official',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      marketplaceName: 'aw',
    })).rejects.toThrow('sourceChanged');
  });

  it('replays validated Codex user Skill owner overlays for multiple plugins', async () => {
    const fixture = getCurrentSourceTestIsolation().layout.rootDir;
    const sourceRoot = path.join(fixture, 'marketplaces', 'official');
    const stagingRoot = path.join(fixture, 'staging');
    await createMarketplaceRoot(sourceRoot);
    for (const pluginName of ['demo', 'second']) {
      for (const root of [sourceRoot, stagingRoot]) {
        await fs.outputJson(path.join(root, 'plugins', pluginName, '.codex-plugin', 'plugin.json'), {
          name: pluginName, version: '1.0.0', skills: './codex/skills',
        });
        await fs.outputJson(path.join(root, 'plugins', pluginName, '.agents-plugin', 'plugin.json'), {
          name: pluginName, version: '1.0.0', description: pluginName, compatibility: { aw: { minVersion: '0.0.0' } },
          marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        });
        await fs.outputFile(
          path.join(root, 'plugins', pluginName, 'codex', 'skills', pluginName, 'SKILL.md'),
          `${pluginName}\n`,
        );
      }
      const sourceSkillRoot = path.join(
        sourceRoot,
        'plugins',
        pluginName,
        'codex',
        'skills',
        pluginName,
      );
      await writeSkillOwnerMarker({
        skillRoot: sourceSkillRoot,
        allowedRoot: path.dirname(sourceSkillRoot),
        identity: {
          owner: 'agent-workflows',
          sourceId: 'official',
          sourceIdentity,
          pluginId: `official/${pluginName}`,
          plugin: pluginName,
          artifactKey: pluginName,
          platform: 'codex',
          scope: 'user',
        },
      });
    }

    await replayNamespacedCodexSkillOverlays({
      sourceRoot,
      stagingRoot,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    });

    for (const pluginName of ['demo', 'second']) {
      await expect(readSkillOwnerMarker({
        skillRoot: path.join(stagingRoot, 'plugins', pluginName, 'codex', 'skills', pluginName),
        allowedRoot: path.join(stagingRoot, 'plugins', pluginName, 'codex', 'skills'),
      })).resolves.toMatchObject({
        sourceId: 'official', sourceIdentity, pluginId: `official/${pluginName}`,
      });
    }
  });
});
