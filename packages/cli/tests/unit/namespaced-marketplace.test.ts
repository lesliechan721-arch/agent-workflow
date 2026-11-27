import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  projectMarketplaceManifestForPlatform,
  readStrictNamespacedMarketplaceRoot,
} from '../../src/utils/local-marketplace.js';
import type { MarketplaceManifest } from '../../src/types.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  cleanupOrphanNamespacedMarketplaceRoot,
  commitMarketplaceGenerationBackup,
} from '../../src/utils/orphan-marketplace-cleanup.js';
import { inventoryCatalogSourceReferences, resolveCleanupMarketplaceIdentity } from '../../src/utils/catalog-source-references.js';
import { offlineCleanupEvidenceFromInventory } from '../../src/commands/offline-cleanup-evidence.js';
import { getNativeTestLayout } from '../helpers/native-execution-fixture.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { writeOwnedTextFile, writeSkillOwnerMarker } from '../../src/utils/ownership.js';

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
  it('retains Codex source and plugin references for the native directory spelling', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    await createMarketplaceRoot(root);
    await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
      '[marketplaces.aw]', `source = ${JSON.stringify(path.toNamespacedPath(root))}`, 'source_type = "local"',
      '[plugins."retained@aw"]', 'enabled = true', '',
    ].join('\n'));
    await fs.outputJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json'), {
      extraKnownMarketplaces: {
        'ordinary-claude': { source: { source: 'directory', path: root } },
        'namespace-claude': { source: { source: 'directory', path: path.toNamespacedPath(root) } },
      },
    });
    const inventory = await inventoryCatalogSourceReferences({ cwd: isolation.layout.fixtureCwd, env: isolation.env });
    expect(inventory.errors).toEqual([]);
    expect(inventory.references).toContainEqual(expect.objectContaining({ kind: 'namespacedMarketplace',
      sourceId: 'official', marketplaceName: 'aw' }));
    expect(inventory.references).toContainEqual(expect.objectContaining({ kind: 'namespacedMarketplace',
      sourceId: 'official', marketplaceName: 'aw', pluginName: 'retained', platform: 'codex', scope: 'user' }));
    expect(inventory.references).toContainEqual(expect.objectContaining({ kind: 'namespacedMarketplace',
      sourceId: 'official', marketplaceName: 'ordinary-claude' }));
    if (process.platform === 'win32') expect(inventory.references).not.toContainEqual(expect.objectContaining({
      kind: 'namespacedMarketplace', sourceId: 'official', marketplaceName: 'namespace-claude' }));
    await expect(cleanupOrphanNamespacedMarketplaceRoot({ sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd, env: isolation.env })).resolves.toBe(false);
    await expect(fs.pathExists(root)).resolves.toBe(true);
  });

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
    await expect(readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: path.join(fixture, 'marketplaces'),
      rootDir: path.join(fixture, 'marketplaces', 'missing'),
      sourceId: 'official', sourceIdentity, marketplaceName: 'aw', platform: 'codex',
    })).resolves.toBeNull();
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

  it('includes platform-enumerable historical project records only when requested', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const installedPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'installed_plugins.json',
    );
    const historicalProject = path.join(isolation.layout.rootDir, 'historical-project');
    await Promise.all([
      createMarketplaceRoot(root),
      fs.ensureDir(historicalProject),
      fs.outputJson(installedPath, {
        plugins: {
          'current@aw': [{
            marketplace: 'aw', name: 'current', scope: 'project',
            projectPath: isolation.layout.fixtureCwd,
          }],
          'historical@aw': [{
            marketplace: 'aw', name: 'historical', scope: 'project',
            projectPath: historicalProject,
          }],
        },
      }),
    ]);

    const currentOnly = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(currentOnly.references).toContainEqual(expect.objectContaining({
      sourceId: 'official', pluginName: 'current', scope: 'project',
    }));
    expect(currentOnly.references).not.toContainEqual(expect.objectContaining({
      sourceId: 'official', pluginName: 'historical', scope: 'project',
    }));

    const withHistory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      includePlatformHistoricalProjects: true,
    });
    expect(withHistory.references).toContainEqual(expect.objectContaining({
      sourceId: 'official', pluginName: 'current', scope: 'project',
    }));
    expect(withHistory.references).toContainEqual(expect.objectContaining({
      sourceId: 'official', pluginName: 'historical', scope: 'project',
    }));
  });

  it.each(['EACCES', 'EPERM'])('does not inspect Codex private residue when cache access gets %s', async (code) => {
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
    });
    expect(inventory.errors).toEqual([]);

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(true);
    await expect(fs.pathExists(root)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      'marketplace-quarantine',
    ))).resolves.toBe(true);
  });

  it.each(['file', 'symlink'] as const)(
    'ignores a Codex cache residue %s root while deleting only the AW marketplace',
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

      await expect(cleanupOrphanNamespacedMarketplaceRoot({
        sourceId: 'official',
        sourceIdentity,
        marketplaceName: 'aw',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      })).resolves.toBe(true);
      await expect(fs.pathExists(root)).resolves.toBe(false);
      await expect(fs.pathExists(cacheRoot)).resolves.toBe(true);
      await expect(fs.pathExists(path.join(
        isolation.env.AW_HOME!,
        'marketplace-quarantine',
      ))).resolves.toBe(true);
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
  ] as const)('leaves Codex %s residue untouched while deleting only the AW marketplace', async (_label, createResidue) => {
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

    await expect(cleanupOrphanNamespacedMarketplaceRoot({
      sourceId: 'official',
      sourceIdentity,
      marketplaceName: 'aw',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toBe(true);
    await expect(fs.pathExists(root)).resolves.toBe(false);
    await expect(fs.pathExists(path.dirname(manifestPath))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      'marketplace-quarantine',
    ))).resolves.toBe(true);
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
  ] as const)('does not claim %s while deleting the AW marketplace', async (_label, createResidue) => {
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
    })).resolves.toBe(true);
    await expect(fs.pathExists(root)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!,
      'marketplace-quarantine',
    ))).resolves.toBe(true);
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
});

// Test Value Gate: verify offline evidence, fail-closed identity, and observable
// residue from real isolated platform paths rather than scanner internals.
describe('current platform marketplace identity', () => {
  const sourceId = 'official';
  const pluginId = 'official/demo';
  const marketplaceName = 'aw-official';
  const manifestPaths = { codex: '.agents/plugins/marketplace.json', claude: '.claude-plugin/marketplace.json',
    copilot: '.github/plugin/marketplace.json' } as const;
  type Platform = keyof typeof manifestPaths;
  const fixture = async (platform: Platform) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    const native = await getNativeTestLayout({ cwd, env, platform, pluginId, sourceIdentity, scope: 'user' });
    return { env, cwd, native, root: native.marketplaceRoot!, host: resolvePlatformConfigRoot(platform, { cwd, env }) };
  };
  const writeRoot = async (root: string, platform: Platform, plugins: unknown[] = []) => {
    await fs.outputJson(path.join(root, 'config.json'), { schemaVersion: 2, sourceId, sourceIdentity, marketplaceName });
    await fs.outputJson(path.join(root, manifestPaths[platform]), { name: marketplaceName, plugins });
  };
  const evidence = (inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>, platform: Platform, scope: 'user' | 'project') =>
    offlineCleanupEvidenceFromInventory({ inventory, reason: 'sourceMissing', sourceId, sourceIdentity, pluginId, pluginName: 'demo', platform, scope });
  const identity = (inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>, platform: Platform, scope: 'user' | 'project') =>
    resolveCleanupMarketplaceIdentity({ references: inventory.references, sourceId, sourceIdentity, pluginName: 'demo', platform, scope });

  it.each(['codex', 'claude', 'copilot'] as const)('binds %s current root and both scopes despite the old marketplace name', async (platform) => {
    const { env, cwd, root, host } = await fixture(platform);
    await writeRoot(root, platform);
    await createMarketplaceRoot(path.join(env.AW_HOME!, 'marketplaces', sourceId));
    if (platform === 'codex') {
      await fs.outputFile(path.join(host, 'config.toml'), `[marketplaces.${marketplaceName}]\nsource = ${JSON.stringify(root)}\nsource_type = "local"\n[plugins."demo@${marketplaceName}"]\nenabled = true\n`);
      await fs.outputFile(path.join(cwd, '.codex/config.toml'), `[plugins."demo@${marketplaceName}"]\nenabled = false\n`);
    } else if (platform === 'claude') {
      await fs.outputJson(path.join(host, 'plugins/known_marketplaces.json'), { [marketplaceName]: {
        source: { source: 'directory', path: root }, installLocation: root,
      } });
      await fs.outputJson(path.join(host, 'settings.json'), { enabledPlugins: { [`demo@${marketplaceName}`]: true } });
      await fs.outputJson(path.join(cwd, '.claude/settings.local.json'), { enabledPlugins: { [`demo@${marketplaceName}`]: false } });
      await fs.outputJson(path.join(host, 'plugins/installed_plugins.json'), { plugins: {
        [`demo@${marketplaceName}`]: [{ scope: 'managed' }, { scope: 'local', projectPath: cwd }],
      } });
    } else {
      await fs.outputJson(path.join(host, 'settings.json'), { enabledPlugins: { [`demo@${marketplaceName}`]: true } });
      await fs.outputJson(path.join(cwd, '.github/copilot/settings.local.json'), { enabledPlugins: { [`demo@${marketplaceName}`]: false } });
    }
    const inventory = await inventoryCatalogSourceReferences({ cwd, env });
    expect(inventory.errors).toEqual([]);
    expect(inventory.references).toContainEqual(expect.objectContaining({ sourceId, sourceIdentity, platform,
      marketplaceName, marketplaceRoot: root, location: path.join(root, 'config.json') }));
    for (const scope of ['user', 'project'] as const) {
      expect(inventory.references).toContainEqual(expect.objectContaining({ sourceId, sourceIdentity, pluginName: 'demo', platform, scope, marketplaceName }));
      expect(identity(inventory, platform, scope)).toEqual({ marketplaceName, nativeRegistration: true });
      const plan = evidence(inventory, platform, scope)!.plan;
      expect(plan.actions.every((action) => action.recoveryCandidate === undefined)).toBe(true);
      if (platform === 'codex') expect(plan.actions).toContainEqual(expect.objectContaining({
        action: 'removeNativeRegistration', activationScope: scope, target: `demo@${marketplaceName}`, marketplaceName,
      }));
    }
  });

  it('uses a verified candidate without a market config only until a same-name foreign registration is observed', async () => {
    const { env, cwd, root, host, native } = await fixture('codex');
    const component = deploymentPackageComponent(native.binding, native);
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    await fs.ensureDir(component.path);
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    const configPath = path.join(host, 'config.toml');
    await fs.outputFile(configPath, `[plugins."demo@${marketplaceName}"]\nenabled = true\n`);
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.references).toContainEqual(expect.objectContaining({ marketplaceRoot: root, recoveryCandidate: expect.objectContaining({ evidence: 'verified' }) }));
    expect(identity(inventory, 'codex', 'user')).toEqual({ marketplaceName, nativeRegistration: true });
    expect(evidence(inventory, 'codex', 'user')!.plan.actions).toContainEqual(expect.objectContaining({ recoveryCandidate: expect.objectContaining({ evidence: 'verified' }) }));
    await fs.appendFile(configPath, `[marketplaces.${marketplaceName}]\nsource = ${JSON.stringify(path.join(cwd, 'foreign'))}\nsource_type = "local"\n`);
    const foreign = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(identity(foreign, 'codex', 'user')).toEqual({ marketplaceIdentityUnresolved: true });
    expect(evidence(foreign, 'codex', 'user')!.plan.actions).toEqual([]);
    await expect(fs.pathExists(component.path)).resolves.toBe(true);
  });

  it('rejects another namespace and symlinked current roots', async () => {
    const { env, cwd, root, host } = await fixture('codex');
    const wrong = path.join(path.dirname(path.dirname(path.dirname(root))), 'different', 'marketplaces', sourceId);
    await writeRoot(wrong, 'codex');
    const writeRegistration = (location: string) => fs.outputFile(path.join(host, 'config.toml'),
      `[marketplaces.${marketplaceName}]\nsource = ${JSON.stringify(location)}\nsource_type = "local"\n[plugins."demo@${marketplaceName}"]\nenabled = true\n`);
    await writeRegistration(wrong);
    let inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ sourceId, sourceIdentity, marketplaceName }));
    expect(identity(inventory, 'codex', 'user')).toEqual({ marketplaceIdentityUnresolved: true });
    await fs.ensureDir(path.dirname(root));
    await fs.symlink(wrong, root, process.platform === 'win32' ? 'junction' : 'dir');
    await writeRegistration(root);
    inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.errors).toContainEqual(expect.objectContaining({ kind: 'marketplaceRootValidation', relevance: {
      global: false, platform: 'codex', sourceId,
    } }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ sourceId, sourceIdentity, marketplaceName }));
    expect(identity(inventory, 'codex', 'user')).toEqual({ marketplaceIdentityUnresolved: true });
  });

  it('keeps the activation unresolved when two distinct canonical names have the same scoped plugin', async () => {
    const { env, cwd, root, host } = await fixture('codex');
    await writeRoot(root, 'codex');
    const legacyRoot = path.join(env.AW_HOME!, 'marketplaces', sourceId);
    await createMarketplaceRoot(legacyRoot);
    await fs.outputFile(path.join(host, 'config.toml'), [
      `[marketplaces.${marketplaceName}]`, `source = ${JSON.stringify(root)}`, 'source_type = "local"',
      '[marketplaces.aw]', `source = ${JSON.stringify(legacyRoot)}`, 'source_type = "local"',
      `[plugins."demo@${marketplaceName}"]`, 'enabled = true', '[plugins."demo@aw"]', 'enabled = true', '',
    ].join('\n'));
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(identity(inventory, 'codex', 'user')).toEqual({ marketplaceIdentityUnresolved: true });
    expect(evidence(inventory, 'codex', 'user')!.plan.actions).toEqual([]);
  });

  it('does not assign a canonically bound same-name registration to another source', async () => {
    const { env, cwd, root, host } = await fixture('codex');
    await writeRoot(root, 'codex', [{ name: 'demo', source: './plugins/demo' }]);
    const config = path.join(host, 'config.toml');
    const otherIdentity = `sha256:${'b'.repeat(64)}`;
    const otherSource = (inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>) =>
      resolveCleanupMarketplaceIdentity({ references: inventory.references, sourceId: 'other', sourceIdentity: otherIdentity,
        pluginName: 'demo', platform: 'codex', scope: 'user' });
    // A manifest entry without a native consumer is also not an ambiguous activation.
    expect(otherSource(await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' }))).toEqual({});
    const canonical = `[marketplaces.${marketplaceName}]\nsource = ${JSON.stringify(root)}\nsource_type = "local"\n[plugins."demo@${marketplaceName}"]\nenabled = true\n`;
    await fs.outputFile(config, canonical);
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(identity(inventory, 'codex', 'user')).toEqual({ marketplaceName, nativeRegistration: true });
    expect(otherSource(inventory)).toEqual({});
    // A conflicting identity of the requested source is not an unrelated binding.
    expect(resolveCleanupMarketplaceIdentity({ references: inventory.references, sourceId, sourceIdentity: otherIdentity,
      pluginName: 'demo', platform: 'codex', scope: 'user' })).toEqual({ marketplaceIdentityUnresolved: true });
    await fs.outputFile(config, canonical.replace(JSON.stringify(root), JSON.stringify(path.join(cwd, 'foreign'))));
    expect(otherSource(await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' })))
      .toEqual({ marketplaceIdentityUnresolved: true });
    await fs.outputFile(config, canonical + '[plugins."demo@outside"]\nenabled = true\n');
    expect(otherSource(await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' })))
      .toEqual({ marketplaceIdentityUnresolved: true });
  });

  it('ignores a lone Claude false preference but not an actual unbound registration', async () => {
    const { env, cwd, host } = await fixture('claude');
    const id = `demo@${marketplaceName}`;
    await fs.outputJson(path.join(host, 'settings.json'), { enabledPlugins: { [id]: false } });
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.errors).toEqual([]);
    expect(identity(inventory, 'claude', 'user')).toEqual({});
    await fs.outputJson(path.join(host, 'plugins', 'installed_plugins.json'), { plugins: { [id]: [{ scope: 'user' }] } });
    expect(identity(await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' }), 'claude', 'user'))
      .toEqual({ marketplaceIdentityUnresolved: true });
  });

  it('accepts equivalent configured AW_HOME and physical paths in a Claude marketplace declaration', async () => {
    const { env, cwd, root, host } = await fixture('claude');
    await writeRoot(root, 'claude');
    const awHome = await fs.realpath(env.AW_HOME!);
    const alias = path.join(cwd, 'aw-home-alias');
    await fs.symlink(awHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasedEnv = { ...env, AW_HOME: alias };
    const knownPath = path.join(host, 'plugins', 'known_marketplaces.json');
    const writeDeclaration = (sourcePath: string) => fs.outputJson(knownPath, { [marketplaceName]: {
      source: { source: 'directory', path: sourcePath }, installLocation: root,
    } });
    await fs.outputJson(path.join(host, 'settings.json'), { enabledPlugins: { [`demo@${marketplaceName}`]: true } });
    await writeDeclaration(path.join(alias, path.relative(awHome, root)));
    expect(identity(await inventoryCatalogSourceReferences({ cwd, env: aliasedEnv, scope: 'user' }), 'claude', 'user'))
      .toEqual({ marketplaceName, nativeRegistration: true });
    // Agreement after normalization must never launder an invalid declaration.
    await writeDeclaration(`${root}${path.sep}..${path.sep}${sourceId}`);
    expect(identity(await inventoryCatalogSourceReferences({ cwd, env: aliasedEnv, scope: 'user' }), 'claude', 'user'))
      .toEqual({ marketplaceIdentityUnresolved: true });
  });

  // Test Value Gate: retaining an empty canonical marketplace must not disguise an
  // unbound external activation; exact scoped supplements remain independently cleanable.
  it('reports an unbound outside activation despite an empty canonical root and preserves exclusive cleanup', async () => {
    const { env, cwd, root } = await fixture('codex');
    await writeRoot(root, 'codex');
    const config = path.join(cwd, '.codex/config.toml');
    const foreign = '[plugins."demo@outside"]\nenabled = true\n';
    await fs.outputFile(config, foreign);
    const agents = path.join(cwd, '.codex/agents');
    const supplement = path.join(agents, `aw-${sourceId}-demo-role.toml`);
    await writeOwnedTextFile({ path: supplement, allowedRoot: agents, content: 'description = "Fixture role"\n',
      identity: { owner: 'agent-workflows', sourceId, sourceIdentity, pluginId, plugin: 'demo', platform: 'codex', scope: 'project',
        physicalKey: `sha256:${'b'.repeat(64)}`, artifactKey: path.basename(supplement) } });
    const inventory = await inventoryCatalogSourceReferences({ cwd, env });
    expect(inventory.errors).toEqual([]);
    expect(identity(inventory, 'codex', 'project')).toEqual({ marketplaceIdentityUnresolved: true });
    expect(evidence(inventory, 'codex', 'project')!.plan.actions).toEqual([expect.objectContaining({
      action: 'removeOwnedOutput', target: supplement,
    })]);
    await expect(fs.readFile(config, 'utf8')).resolves.toBe(foreign);
  });

  it('retains an otherwise unreferenced Claude managed registration as a policy clue, never an AW user action', async () => {
    const { env, cwd, root, host } = await fixture('claude');
    await writeRoot(root, 'claude');
    await fs.outputJson(path.join(host, 'plugins/known_marketplaces.json'), { [marketplaceName]: {
      source: { source: 'directory', path: root }, installLocation: root,
    } });
    await fs.outputJson(path.join(host, 'plugins/installed_plugins.json'), { plugins: { [`demo@${marketplaceName}`]: [{ scope: 'managed' }] } });
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.errors).toEqual([]);
    expect(inventory.references).toContainEqual(expect.objectContaining({ sourceId, pluginName: 'demo', platform: 'claude', managedNativeRegistration: true }));
    expect(identity(inventory, 'claude', 'user')).toEqual({ marketplaceName });
    expect(evidence(inventory, 'claude', 'user')!.plan.actions).toEqual([]);
  });

  it('does not authorize Codex activation cleanup through a symlinked plugins container', async () => {
    const { env, cwd, root, host } = await fixture('codex');
    await writeRoot(root, 'codex');
    const foreign = path.join(cwd, 'foreign-plugins');
    await fs.ensureDir(foreign);
    await fs.symlink(foreign, path.join(root, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.outputFile(path.join(host, 'config.toml'), `[marketplaces.${marketplaceName}]\nsource = ${JSON.stringify(root)}\nsource_type = "local"\n[plugins."demo@${marketplaceName}"]\nenabled = true\n`);
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.errors).toContainEqual(expect.objectContaining({ kind: 'nativeNamespaceUnsafe' }));
    expect(identity(inventory, 'codex', 'user')).toEqual({ marketplaceIdentityUnresolved: true });
    expect(evidence(inventory, 'codex', 'user')?.plan.actions ?? []).toEqual([]);
  });

  it('reports malformed Copilot settings and represents exact local manifest residue without granting cleanup authority', async () => {
    const { env, cwd, root, host } = await fixture('copilot');
    await writeRoot(root, 'copilot', [{ name: 'demo', source: './plugins/demo' }, { name: 'outside', source: '../outside' }]);
    await fs.outputJson(path.join(host, 'settings.json'), { enabledPlugins: { [`demo@${marketplaceName}`]: 'true' } });
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.errors).toContainEqual(expect.objectContaining({ kind: 'nativeStateRead', relevance: { global: false, platform: 'copilot', scope: 'user' } }));
    expect(inventory.references).toContainEqual(expect.objectContaining({ sourceId, sourceIdentity, pluginName: 'demo', platform: 'copilot', marketplaceManifestEntry: true }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ sourceId, pluginName: 'outside' }));
    expect(evidence(inventory, 'copilot', 'user')!.plan.actions).toEqual([]);
  });
});
