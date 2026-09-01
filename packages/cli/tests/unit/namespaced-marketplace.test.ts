import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  projectMarketplaceManifestForPlatform,
  readStrictNamespacedMarketplaceRoot,
  replayNamespacedCodexSkillOverlays,
} from '../../src/utils/local-marketplace.js';
import type { MarketplaceManifest } from '../../src/types.js';
import {
  readSkillOwnerMarker,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  cleanupOrphanNamespacedMarketplaceRoot,
  commitMarketplaceGenerationBackup,
} from '../../src/utils/orphan-marketplace-cleanup.js';
import { discoverCodexNativeResidueNames } from '../../src/commands/rebuild-integration.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';

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
  it('projects marketplace entries and product enums to one native platform', () => {
    const manifest: MarketplaceManifest = {
      name: 'aw',
      owner: { name: 'AW', url: 'https://example.com' },
      interface: { displayName: 'AW' },
      plugins: [
        {
          name: 'both', source: './plugins/both', description: 'Both.', category: 'test', strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX', 'CLAUDE'] },
        },
        {
          name: 'implicit-both', source: './plugins/implicit-both', description: 'Both.', category: 'test', strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        {
          name: 'codex-only', source: './plugins/codex-only', description: 'Codex.', category: 'test', strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
        },
        {
          name: 'claude-only', source: './plugins/claude-only', description: 'Claude.', category: 'test', strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CLAUDE'] },
        },
      ],
    };

    const codex = projectMarketplaceManifestForPlatform(manifest, 'codex');
    expect(codex.plugins.map((plugin) => plugin.name)).toEqual([
      'both', 'implicit-both', 'codex-only',
    ]);
    expect(codex.plugins.map((plugin) => plugin.policy.products)).toEqual([
      ['CODEX'], ['CODEX'], ['CODEX'],
    ]);

    const claude = projectMarketplaceManifestForPlatform(manifest, 'claude');
    expect(claude.plugins.map((plugin) => plugin.name)).toEqual([
      'both', 'implicit-both', 'claude-only',
    ]);
    expect(claude.plugins.map((plugin) => plugin.policy.products)).toEqual([
      ['CLAUDE'], ['CLAUDE'], ['CLAUDE'],
    ]);
  });

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
      trustedMarketplaceRoot: path.dirname(root),
      rootDir: root,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).resolves.toMatchObject({
      config: { sourceId: 'official', sourceIdentity, marketplaceName: 'aw' },
    });
    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: path.dirname(root),
      rootDir: root,
      sourceId: 'official',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      marketplaceName: 'aw',
    })).rejects.toThrow('sourceChanged');
  });

  it.each([
    ['config.json', { schemaVersion: 2, sourceId: 'official', sourceIdentity, marketplaceName: 'aw' }],
    ['.agents/plugins/marketplace.json', { name: 'aw', owner: {}, interface: {}, plugins: [] }],
  ] as const)('does not let external matching %s authorize orphan deletion', async (relativePath, value) => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const target = path.join(root, ...relativePath.split('/'));
    const outside = path.join(isolation.layout.rootDir, 'outside-marketplace-json', ...relativePath.split('/'));
    await createMarketplaceRoot(root);
    await fs.outputJson(outside, value);
    await fs.remove(target);
    await fs.symlink(outside, target);

    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: path.dirname(root),
      rootDir: root,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).rejects.toMatchObject({
      code: 'marketplaceRootInvalid',
      location: target,
    });
    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
  });

  it.each([
    'config.json',
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
  ])('rejects a directory at marketplace JSON path %s', async (relativePath) => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const target = path.join(root, ...relativePath.split('/'));
    await createMarketplaceRoot(root);
    await fs.remove(target);
    await fs.ensureDir(target);

    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: path.dirname(root),
      rootDir: root,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).rejects.toMatchObject({
      code: 'marketplaceRootInvalid',
      location: target,
    });
  });

  it('rejects a matching manifest behind a symlink in its path chain', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplacesRoot = path.join(isolation.env.AW_HOME!, 'marketplaces');
    const root = path.join(marketplacesRoot, 'official');
    const agentsRoot = path.join(root, '.agents');
    const outsideAgentsRoot = path.join(isolation.layout.rootDir, 'outside-agents');
    await createMarketplaceRoot(root);
    await fs.outputJson(path.join(outsideAgentsRoot, 'plugins', 'marketplace.json'), {
      name: 'aw', owner: {}, interface: {}, plugins: [],
    });
    await fs.remove(agentsRoot);
    await fs.symlink(outsideAgentsRoot, agentsRoot);

    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: marketplacesRoot,
      rootDir: root,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).rejects.toMatchObject({
      code: 'marketplaceRootInvalid',
      location: agentsRoot,
    });
    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
  });

  it('rejects a symlinked trusted marketplace root before reading JSON', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplacesRoot = path.join(isolation.env.AW_HOME!, 'marketplaces');
    const outsideMarketplacesRoot = path.join(isolation.layout.rootDir, 'outside-marketplaces');
    const root = path.join(marketplacesRoot, 'official');
    await createMarketplaceRoot(path.join(outsideMarketplacesRoot, 'official'));
    await fs.ensureDir(path.dirname(marketplacesRoot));
    await fs.symlink(outsideMarketplacesRoot, marketplacesRoot);

    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: marketplacesRoot,
      rootDir: root,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).rejects.toMatchObject({
      code: 'marketplaceRootInvalid',
      location: marketplacesRoot,
    });
  });

  it('keeps the canonical root intact when the quarantine rename is denied', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    await createMarketplaceRoot(root);
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(denied);

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'EACCES' });

    rename.mockRestore();
    await expect(fs.pathExists(root)).resolves.toBe(true);
    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: path.dirname(root),
      rootDir: root,
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).resolves.not.toBeNull();
  });

  it('keeps a validated quarantine after EBUSY and safely removes it on retry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const quarantineRoot = path.join(isolation.env.AW_HOME!, 'marketplace-quarantine');
    await createMarketplaceRoot(root);
    const actualRemove = fs.remove.bind(fs);
    const remove = vi.spyOn(fs, 'remove').mockImplementation(async (candidate) => {
      if (path.basename(candidate) === 'official'
        && candidate.startsWith(`${quarantineRoot}${path.sep}`)) {
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return actualRemove(candidate);
    });

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toThrow('orphanMarketplaceQuarantined: EBUSY');

    remove.mockRestore();
    await expect(fs.pathExists(root)).resolves.toBe(false);
    const quarantines = (await fs.readdir(quarantineRoot)).filter((entry) => entry !== '.aw-owner.json');
    expect(quarantines).toHaveLength(1);
    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: quarantineRoot,
      rootDir: path.join(quarantineRoot, quarantines[0]!, 'official'),
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
    })).resolves.not.toBeNull();

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.readdir(quarantineRoot)).resolves.toEqual(['.aw-owner.json']);
  });

  it.each(['EBUSY', 'EPERM'])(
    'keeps the new generation after its backup is durably quarantined and cleanup gets %s',
    async (code) => {
      const isolation = getCurrentSourceTestIsolation();
      const marketplacesRoot = path.join(isolation.env.AW_HOME!, 'marketplaces');
      const activeRoot = path.join(marketplacesRoot, 'team');
      const backupRoot = path.join(marketplacesRoot, 'team.backup-test');
      const quarantineRoot = path.join(isolation.env.AW_HOME!, 'marketplace-quarantine');
      const teamIdentity = `sha256:${'b'.repeat(64)}`;
      await Promise.all([
        fs.outputFile(path.join(activeRoot, 'generation.txt'), 'new\n'),
        fs.outputJson(path.join(backupRoot, 'config.json'), {
          schemaVersion: 2,
          sourceId: 'team',
          sourceIdentity: teamIdentity,
          marketplaceName: 'aw-team',
        }),
        fs.outputJson(path.join(backupRoot, '.agents', 'plugins', 'marketplace.json'), {
          name: 'aw-team', owner: {}, interface: {}, plugins: [],
        }),
        fs.outputFile(path.join(backupRoot, 'generation.txt'), 'old\n'),
      ]);
      const actualRemove = fs.remove.bind(fs);
      const remove = vi.spyOn(fs, 'remove').mockImplementation(async (candidate) => {
        if (path.basename(String(candidate)) === 'team'
          && String(candidate).startsWith(`${quarantineRoot}${path.sep}`)) {
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
        return actualRemove(candidate);
      });

      await expect(commitMarketplaceGenerationBackup({
        backupRoot,
        sourceId: 'team',
        sourceIdentity: teamIdentity,
        marketplaceName: 'aw-team',
        env: isolation.env,
      })).rejects.toMatchObject({ durableMaterializeCommit: true });

      remove.mockRestore();
      await expect(fs.readFile(path.join(activeRoot, 'generation.txt'), 'utf8')).resolves.toBe('new\n');
      await expect(fs.pathExists(backupRoot)).resolves.toBe(false);
      const quarantines = (await fs.readdir(quarantineRoot)).filter((entry) => entry !== '.aw-owner.json');
      expect(quarantines).toHaveLength(1);
      await expect(fs.readFile(path.join(
        quarantineRoot,
        quarantines[0]!,
        'team',
        'generation.txt',
      ), 'utf8')).resolves.toBe('old\n');
    },
  );

  it('does not quarantine a marketplace root with a foreign source identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    await createMarketplaceRoot(root);

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
  });

  it('keeps the root when global Claude consumer identity records are invalid', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    await createMarketplaceRoot(root);
    await fs.outputJson(
      path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json'),
      { plugins: { 'broken@aw': ['invalid-record'] } },
    );

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
  });

  it('does not let a swallowed Claude permission error authorize marketplace deletion', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const installedPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'installed_plugins.json',
    );
    await createMarketplaceRoot(root);
    await fs.outputJson(installedPath, {
      plugins: { 'retained@aw': [{ marketplace: 'aw', name: 'retained', scope: 'user' }] },
    });
    const originalPathExists = fs.pathExists.bind(fs);
    vi.spyOn(fs, 'pathExists').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(installedPath)) return false;
      return originalPathExists(candidate);
    });

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      'marketplace-quarantine',
    ))).resolves.toBe(false);
  });

  it.each(['EACCES', 'EPERM'])('types Claude inventory %s and performs zero marketplace deletion', async (code) => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const installedPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'installed_plugins.json',
    );
    await createMarketplaceRoot(root);
    const originalReadJson = fs.readJson.bind(fs);
    vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
      if (path.resolve(String(args[0])) === path.resolve(installedPath)) {
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return originalReadJson(...args);
    });

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      includeHistoricalProjects: true,
    });
    expect(inventory.errors).toContainEqual(expect.objectContaining({
      code: 'stateInventoryFailed',
      kind: 'nativeStateRead',
      relevance: { global: false, platform: 'claude' },
    }));
    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
  });

  it('ignores an unbound Claude record and recognizes an explicit marketplace key', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const installedPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'installed_plugins.json',
    );
    const defaultRecord = {
      name: 'default-plugin',
      scope: 'user',
      version: '1.0.0',
      installPath: path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'cache', 'default-plugin'),
    };
    const keyedRecord = {
      name: 'keyed-plugin',
      scope: 'user',
      version: '1.0.0',
    };
    await Promise.all([
      createMarketplaceRoot(root),
      fs.outputJson(installedPath, {
        plugins: {
          'default-plugin': [defaultRecord],
          'keyed-plugin@aw': [keyedRecord],
        },
      }),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      includeHistoricalProjects: true,
    });

    expect(inventory.errors).toEqual([]);
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      sourceId: 'official',
      pluginName: 'default-plugin',
    }));
    expect(inventory.references).toContainEqual(expect.objectContaining({
      sourceId: 'official',
      pluginName: 'keyed-plugin',
      platform: 'claude',
      scope: 'user',
    }));
    await expect(fs.readJson(installedPath)).resolves.toEqual({
      plugins: {
        'default-plugin': [defaultRecord],
        'keyed-plugin@aw': [keyedRecord],
      },
    });
  });

  it.each(['EACCES', 'EPERM'])('keeps the root when Codex inventory gets %s', async (code) => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const pluginsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins');
    await createMarketplaceRoot(root);
    await fs.ensureDir(pluginsRoot);
    await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(root)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    const originalReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (path.resolve(String(args[0])) === path.resolve(pluginsRoot)) {
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return originalReaddir(...args);
    });

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      includeHistoricalProjects: true,
      includeOrphanedCodexNativeResidue: true,
    });
    expect(inventory.errors).toContainEqual(expect.objectContaining({
      code: 'stateInventoryFailed',
      kind: 'nativeStateRead',
      relevance: expect.objectContaining({ global: false, sourceId: 'official' }),
    }));

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      'marketplace-quarantine',
    ))).resolves.toBe(false);
  });

  it.each(['file', 'symlink'] as const)(
    'types a Codex cache residue %s root and performs zero marketplace deletion',
    async (nodeKind) => {
      const isolation = getCurrentSourceTestIsolation();
      const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
      const cacheRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw');
      const outside = path.join(isolation.layout.rootDir, `outside-cache-${nodeKind}`);
      await createMarketplaceRoot(root);
      await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(root)}`,
        'source_type = "local"',
        '',
      ].join('\n'));
      if (nodeKind === 'file') {
        await fs.outputFile(cacheRoot, 'not a directory\n');
      } else {
        await fs.outputJson(path.join(outside, 'retained', '1.0.0', 'plugin.json'), {
          id: 'retained', version: '1.0.0',
        });
        await fs.ensureDir(path.dirname(cacheRoot));
        await fs.symlink(outside, cacheRoot);
      }

      await expect(discoverCodexNativeResidueNames({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        marketplaceName: 'aw',
        marketplaceRoot: root,
      })).rejects.toMatchObject({
        code: 'codexNativeResidueProbeFailed',
        location: cacheRoot,
      });
      await expect(cleanupOrphanNamespacedMarketplaceRoot({
        sourceId: 'official',
        sourceIdentity,
        marketplaceName: 'aw',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      })).resolves.toBe(false);
      await expect(fs.pathExists(root)).resolves.toBe(true);
      await expect(fs.pathExists(path.join(
        isolation.env.AW_HOME!,
        'marketplace-quarantine',
      ))).resolves.toBe(false);
    },
  );

  it('ignores regular files in the Codex cache root inventory', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const cacheRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw');
    await Promise.all([
      createMarketplaceRoot(root),
      fs.outputFile(path.join(cacheRoot, '.DS_Store'), 'finder metadata\n'),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      includeHistoricalProjects: true,
    });

    expect(inventory.errors).toEqual([]);
  });

  it.each([
    ['missing manifest', async (manifestPath: string) => fs.ensureDir(path.dirname(manifestPath))],
    ['malformed manifest', async (manifestPath: string) => fs.outputFile(manifestPath, '{')],
    ['nonregular manifest', async (manifestPath: string) => fs.ensureDir(manifestPath)],
    ['foreign manifest', async (manifestPath: string) => fs.outputJson(manifestPath, {
      id: 'someone-else@aw',
      version: '1.0.0',
    })],
  ] as const)('fails closed on Codex %s and performs zero marketplace deletion', async (_label, createResidue) => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    await createMarketplaceRoot(root);
    await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(root)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    const manifestPath = path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins',
      'uncertain@aw',
      'manifest.json',
    );
    await createResidue(manifestPath);

    await expect(discoverCodexNativeResidueNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      marketplaceName: 'aw',
      marketplaceRoot: root,
    })).rejects.toMatchObject({ code: 'codexNativeResidueProbeFailed' });
    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      'marketplace-quarantine',
    ))).resolves.toBe(false);
  });

  it.each([
    ['missing registration with installed residue', async (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) => {
      await fs.outputJson(path.join(
        isolation.env.AW_CODEX_HOME!,
        'plugins',
        'retained@aw',
        'manifest.json',
      ), { id: 'retained@aw', version: '1.0.0' });
    }],
    ['foreign registration with cache residue', async (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) => {
      await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-marketplace'))}`,
        'source_type = "local"',
        '',
      ].join('\n'));
      await fs.outputJson(path.join(
        isolation.env.AW_CODEX_HOME!,
        'plugins',
        'cache',
        'aw',
        'retained',
        '1.0.0',
        'plugin.json',
      ), { id: 'retained', version: '1.0.0' });
    }],
  ] as const)('keeps the root for %s', async (_label, createResidue) => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    await createMarketplaceRoot(root);
    await createResidue(isolation);

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      'marketplace-quarantine',
    ))).resolves.toBe(false);
  });

  it('keeps the root when a configured Codex plugin has an empty cache directory', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    await createMarketplaceRoot(root);
    await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(root)}`,
      'source_type = "local"',
      '',
      '[plugins."retained@aw"]',
      'enabled = true',
      '',
    ].join('\n'));
    const cacheRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw');
    await Promise.all([
      fs.ensureDir(path.join(cacheRoot, 'retained')),
      fs.ensureDir(path.join(cacheRoot, 'unrelated')),
    ]);

    await expect(discoverCodexNativeResidueNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      marketplaceName: 'aw',
      marketplaceRoot: root,
    })).rejects.toMatchObject({
      code: 'codexNativeResidueProbeFailed',
      pluginName: 'retained',
      location: path.join(cacheRoot, 'retained'),
    });
    await fs.remove(path.join(cacheRoot, 'retained'));
    await expect(discoverCodexNativeResidueNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      marketplaceName: 'aw',
      marketplaceRoot: root,
    })).resolves.toEqual(['retained']);
    await fs.ensureDir(path.join(cacheRoot, 'retained'));
    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
  });

  it.each(['missing', 'foreign'] as const)(
    'keeps a non-primary root for config-only residue with %s registration',
    async (registration) => {
      const isolation = getCurrentSourceTestIsolation();
      const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      const teamIdentity = `sha256:${'b'.repeat(64)}`;
      await Promise.all([
        fs.outputJson(path.join(root, 'config.json'), {
          schemaVersion: 2,
          sourceId: 'team',
          sourceIdentity: teamIdentity,
          marketplaceName: 'aw-team',
        }),
        fs.outputJson(path.join(root, '.agents', 'plugins', 'marketplace.json'), {
          name: 'aw-team', owner: {}, interface: {}, plugins: [],
        }),
      ]);
      await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        ...(registration === 'foreign' ? [
          '[marketplaces.aw-team]',
          `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-marketplace'))}`,
          'source_type = "local"',
          '',
        ] : []),
        '[plugins."retained@aw-team"]',
        'enabled = true',
        '',
      ].join('\n'));

      const inventory = await inventoryCatalogSourceReferences({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        includeHistoricalProjects: true,
      });
      expect(inventory.references).toContainEqual(expect.objectContaining({
        kind: 'namespacedMarketplace',
        sourceId: 'team',
        marketplaceName: 'aw-team',
        pluginName: 'retained',
        platform: 'codex',
        scope: 'user',
      }));
      await expect(cleanupOrphanNamespacedMarketplaceRoot({
        sourceId: 'team',
        sourceIdentity: teamIdentity,
        marketplaceName: 'aw-team',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      })).resolves.toBe(false);
      await expect(fs.pathExists(root)).resolves.toBe(true);
    },
  );

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
          name: pluginName, version: '1.0.0', description: pluginName, schemaVersion: 3,
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
