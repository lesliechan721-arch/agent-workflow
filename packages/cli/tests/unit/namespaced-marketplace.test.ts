import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  projectMarketplaceManifestForPlatform,
  readStrictNamespacedMarketplaceRoot,
  replayNamespacedMarketplacePluginProjections,
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
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import {
  createCodexNativeRenderReceipt,
  serializeCodexNativeRenderReceipt,
} from '../../src/utils/codex-native-render-receipt.js';
import { calculateCodexNativeRenderPayloadDigest } from '../../src/utils/catalog-digests.js';
import { createCodexSkillStagingTreeContentDigest } from '../../src/utils/codex-skill-staging.js';

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

const nativeDigest = (character: string): string => `sha256:${character.repeat(64)}`;

async function createNativeProjectionFixture(options: {
  sourceRoot: string;
  stagingRoot: string;
  pluginName?: string;
  empty?: boolean;
  configDigest?: string;
  scopes?: Array<'user' | 'project'>;
}): Promise<{ receiptContent: string; skillKey: string }> {
  const pluginName = options.pluginName ?? 'native-projection';
  const skillKey = `${pluginName}-skill`;
  const target = {
    id: `${pluginName}-target`, platform: 'codex', target: 'codex.skill',
    scopes: options.scopes ?? ['user'], states: ['present'], refreshKeys: [], skillKey,
    delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
  };
  const pluginManifest = {
    name: pluginName, version: '1.0.0', description: pluginName, schemaVersion: 3,
    marketplace: {
      category: 'workflow', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    artifacts: { targets: [target] },
  };
  for (const root of [options.sourceRoot, options.stagingRoot]) {
    await fs.outputJson(path.join(root, 'plugins', pluginName, '.agents-plugin', 'plugin.json'), pluginManifest);
    await fs.outputJson(path.join(root, 'plugins', pluginName, '.codex-plugin', 'plugin.json'), {
      name: pluginName,
      version: '1.0.0',
      ...(!options.empty || root === options.stagingRoot ? { skills: './codex/skills' } : {}),
    });
  }
  const files = options.empty ? {} : {
    'SKILL.md': Buffer.from(`# ${pluginName}\n`, 'utf8'),
    'agents/openai.yaml': Buffer.from([
      'interface:',
      '  display_name: "Native projection"',
      '  short_description: "Native projection fixture"',
      '  default_prompt: "Use the native projection fixture."',
      'policy:',
      '  allow_implicit_invocation: true',
      '',
    ].join('\n'), 'utf8'),
  };
  if (!options.empty) {
    for (const [relativePath, content] of Object.entries(files)) {
      await fs.outputFile(path.join(
        options.sourceRoot, 'plugins', pluginName, 'codex', 'skills', skillKey, relativePath,
      ), content);
    }
  }
  const sourcePluginRoot = path.join(options.sourceRoot, 'plugins', pluginName);
  const receipt = createCodexNativeRenderReceipt({
    logicalPluginId: `official/${pluginName}`,
    sourceIdentity,
    pluginVersion: '1.0.0',
    rendererDigest: nativeDigest('b'),
    targets: [{
      id: target.id,
      skillKey,
      configDigest: options.configDigest ?? nativeDigest('c'),
      artifactDigest: createCodexSkillStagingTreeContentDigest({ skillKey, files }),
    }],
    payloadDigest: await calculateCodexNativeRenderPayloadDigest(sourcePluginRoot),
  });
  const receiptContent = serializeCodexNativeRenderReceipt(receipt);
  await fs.outputFile(path.join(sourcePluginRoot, '.agents-plugin', 'aw-codex-native-render.json'), receiptContent);
  return { receiptContent, skillKey };
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

  it('replays validated Codex user Skill owner overlays for multiple plugins', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const fixture = isolation.layout.rootDir;
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
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
          ...(root === stagingRoot ? {
            artifacts: { targets: [{
              id: `${pluginName}-skill`, platform: 'codex', target: 'codex.skill',
              scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: pluginName,
              delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
            }] },
          } : {}),
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
        schemaVersion: 3,
        owner: 'agent-workflows',
        sourceId: 'official',
        pluginId: `official/${pluginName}`,
        plugin: pluginName,
        artifactKey: pluginName,
        platform: 'codex',
        scope: 'user',
      });
    }

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references.filter((reference) =>
      reference.kind === 'namespacedOwner'
      && reference.location.startsWith(sourceRoot))).toEqual([]);
  });

  it('preserves unselected static copies and their platform entries while replacing selected copies', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, 'static-projection-staging');
    for (const [root, names, version] of [
      [sourceRoot, ['selected', 'unselected', 'removed'], '1.0.0'],
      [stagingRoot, ['selected', 'unselected', 'added'], '2.0.0'],
    ] as const) {
      await createMarketplaceRoot(root);
      for (const name of names) {
        for (const platform of ['agents', 'codex', 'claude']) {
          await fs.outputJson(path.join(root, 'plugins', name, `.${platform}-plugin`, 'plugin.json'), {
            name, version,
          });
        }
        await fs.outputFile(path.join(root, 'plugins', name, `${version}.txt`), `${name} ${version}\n`);
      }
      for (const [platform, relativePath] of [
        ['CODEX', '.agents/plugins/marketplace.json'],
        ['CLAUDE', '.claude-plugin/marketplace.json'],
      ] as const) {
        const manifestPath = path.join(root, relativePath);
        const manifest = await fs.readJson(manifestPath);
        await fs.writeJson(manifestPath, {
          ...manifest,
          plugins: names.filter((name) => name !== 'unselected'
            || platform === (root === sourceRoot ? 'CLAUDE' : 'CODEX')).map((name) => ({
            name, source: `./plugins/${name}`, description: `${name} ${version}`,
            category: 'workflow', strict: true,
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: [platform] },
          })),
        });
      }
    }

    await replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      rematerializedPluginIds: new Set(['official/selected']),
    });

    await expect(fs.readJson(path.join(stagingRoot, 'plugins', 'selected', '.codex-plugin', 'plugin.json')))
      .resolves.toMatchObject({ version: '2.0.0' });
    await expect(fs.readJson(path.join(stagingRoot, 'plugins', 'unselected', '.claude-plugin', 'plugin.json')))
      .resolves.toMatchObject({ version: '1.0.0' });
    await expect(fs.readFile(path.join(stagingRoot, 'plugins', 'unselected', '1.0.0.txt'), 'utf8'))
      .resolves.toBe('unselected 1.0.0\n');
    await expect(fs.pathExists(path.join(stagingRoot, 'plugins', 'unselected', '2.0.0.txt'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(stagingRoot, 'plugins', 'removed'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(stagingRoot, 'plugins', 'added', '2.0.0.txt'))).resolves.toBe(true);
    for (const [relativePath, expectedNames] of [
      ['.agents/plugins/marketplace.json', ['added', 'selected']],
      ['.claude-plugin/marketplace.json', ['added', 'selected', 'unselected']],
    ] as const) {
      const manifest = await fs.readJson(path.join(stagingRoot, relativePath)) as MarketplaceManifest;
      expect(manifest.plugins.map((entry) => entry.name).sort()).toEqual(expectedNames);
      const retained = manifest.plugins.find((entry) => entry.name === 'unselected');
      if (retained) expect(retained.description).toBe('unselected 1.0.0');
    }
  });

  it('preserves a complete native dynamic projection and its original drift receipt', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, 'native-projection-staging');
    await createMarketplaceRoot(sourceRoot);
    const fixture = await createNativeProjectionFixture({
      sourceRoot,
      stagingRoot,
      configDigest: nativeDigest('d'),
    });

    await replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
    });

    await expect(fs.readFile(path.join(
      stagingRoot, 'plugins', 'native-projection', 'codex', 'skills', fixture.skillKey, 'SKILL.md',
    ), 'utf8')).resolves.toBe('# native-projection\n');
    await expect(fs.readFile(path.join(
      stagingRoot, 'plugins', 'native-projection', '.agents-plugin', 'aw-codex-native-render.json',
    ), 'utf8')).resolves.toBe(fixture.receiptContent);
  });

  it('preserves an empty native target and the absent Codex skills field', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, 'empty-native-projection-staging');
    await createMarketplaceRoot(sourceRoot);
    const fixture = await createNativeProjectionFixture({ sourceRoot, stagingRoot, empty: true });

    await replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
    });

    const manifest = await fs.readJson(path.join(
      stagingRoot, 'plugins', 'native-projection', '.codex-plugin', 'plugin.json',
    ));
    expect(manifest).not.toHaveProperty('skills');
    await expect(fs.pathExists(path.join(
      stagingRoot, 'plugins', 'native-projection', 'codex', 'skills', fixture.skillKey,
    ))).resolves.toBe(false);
  });

  it('preserves a project-only native target in the shared user projection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, 'project-only-native-projection');
    await createMarketplaceRoot(sourceRoot);
    const fixture = await createNativeProjectionFixture({
      sourceRoot,
      stagingRoot,
      scopes: ['project'],
    });

    await replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
    });

    await expect(fs.readFile(path.join(
      stagingRoot, 'plugins', 'native-projection', 'codex', 'skills', fixture.skillKey, 'SKILL.md',
    ), 'utf8')).resolves.toBe('# native-projection\n');
  });

  it.each([
    ['version changed', async (root: string) => {
      const manifestPath = path.join(root, 'plugins', 'native-projection', '.agents-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      await fs.writeJson(manifestPath, { ...manifest, version: '2.0.0' });
    }],
    ['target changed', async (root: string) => {
      const manifestPath = path.join(root, 'plugins', 'native-projection', '.agents-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      manifest.artifacts.targets[0].id = 'changed-target';
      await fs.writeJson(manifestPath, manifest);
    }],
    ['render input changed', async (root: string) => {
      await fs.outputFile(path.join(root, 'plugins', 'native-projection', 'changed-input.txt'), 'changed\n');
    }],
  ] as const)('keeps the complete old projection when the Catalog %s', async (_label, changeStaging) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, `changed-native-projection-${_label.replaceAll(' ', '-')}`);
    await createMarketplaceRoot(sourceRoot);
    const fixture = await createNativeProjectionFixture({ sourceRoot, stagingRoot });
    await changeStaging(stagingRoot);

    await replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
    });

    await expect(fs.pathExists(path.join(
      stagingRoot, 'plugins', 'native-projection', 'codex', 'skills', fixture.skillKey,
    ))).resolves.toBe(true);
    await expect(fs.readFile(path.join(
      stagingRoot, 'plugins', 'native-projection', '.agents-plugin', 'aw-codex-native-render.json',
    ), 'utf8')).resolves.toBe(fixture.receiptContent);
    const sourcePluginRoot = path.join(sourceRoot, 'plugins', 'native-projection');
    const stagingPluginRoot = path.join(stagingRoot, 'plugins', 'native-projection');
    await expect(calculateCodexNativeRenderPayloadDigest(stagingPluginRoot))
      .resolves.toBe(await calculateCodexNativeRenderPayloadDigest(sourcePluginRoot));
    await expect(fs.readJson(path.join(stagingPluginRoot, '.agents-plugin', 'plugin.json')))
      .resolves.toEqual(await fs.readJson(path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json')));
  });

  it('leaves the new Catalog payload for a plugin selected for rematerialization', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, 'selected-native-projection');
    await createMarketplaceRoot(sourceRoot);
    const fixture = await createNativeProjectionFixture({ sourceRoot, stagingRoot });
    const stagingPluginRoot = path.join(stagingRoot, 'plugins', 'native-projection');
    const manifestPath = path.join(stagingPluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    await fs.writeJson(manifestPath, { ...manifest, version: '2.0.0' });

    await replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      rematerializedPluginIds: new Set(['official/native-projection']),
    });

    await expect(fs.readJson(manifestPath)).resolves.toMatchObject({ version: '2.0.0' });
    await expect(fs.pathExists(path.join(stagingPluginRoot, 'codex', 'skills', fixture.skillKey)))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(stagingPluginRoot, '.agents-plugin', 'aw-codex-native-render.json')))
      .resolves.toBe(false);
  });

  it.each(['receipt', 'payload'] as const)(
    'skips a damaged native projection %s while leaving the new generation usable',
    async (damage) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
      const stagingRoot = path.join(isolation.layout.rootDir, `damaged-native-projection-${damage}`);
      await createMarketplaceRoot(sourceRoot);
      const fixture = await createNativeProjectionFixture({ sourceRoot, stagingRoot });
      if (damage === 'receipt') {
        await fs.outputFile(path.join(
          sourceRoot, 'plugins', 'native-projection', '.agents-plugin', 'aw-codex-native-render.json',
        ), '{invalid');
      } else {
        await fs.outputFile(path.join(
          sourceRoot, 'plugins', 'native-projection', 'codex', 'skills', fixture.skillKey, 'SKILL.md',
        ), '# damaged\n');
      }

      await replayNamespacedMarketplacePluginProjections({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      });

      await expect(fs.readFile(path.join(
        stagingRoot, 'plugins', 'native-projection', '.agents-plugin', 'plugin.json',
      ), 'utf8')).resolves.toContain('native-projection');
      await expect(fs.pathExists(path.join(
        stagingRoot, 'plugins', 'native-projection', 'codex', 'skills', fixture.skillKey,
      ))).resolves.toBe(false);
    },
  );

  it('blocks a native projection receipt with a conflicting source identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, 'mismatched-native-projection');
    await createMarketplaceRoot(sourceRoot);
    await createNativeProjectionFixture({ sourceRoot, stagingRoot });
    const receiptPath = path.join(
      sourceRoot, 'plugins', 'native-projection', '.agents-plugin', 'aw-codex-native-render.json',
    );
    const original = await fs.readJson(receiptPath);
    const conflicting = createCodexNativeRenderReceipt({
      logicalPluginId: original.logicalPluginId,
      sourceIdentity: nativeDigest('e'),
      pluginVersion: original.pluginVersion,
      rendererDigest: original.rendererDigest,
      targets: original.targets,
      payloadDigest: original.payloadDigest,
    });
    await fs.writeFile(receiptPath, serializeCodexNativeRenderReceipt(conflicting));

    await expect(replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
    })).rejects.toThrow('codexNativeProjectionIdentityMismatch');
  });

  it.each([
    ['missing receipt and plugin identity conflict', 'missing', 'identity', 'codexNativeProjectionIdentityMismatch'],
    ['invalid receipt and plugin identity conflict', 'invalid', 'identity', 'codexNativeProjectionIdentityMismatch'],
    ['invalid receipt and absolute Skills root', 'invalid', 'absolute', 'codexNativeProjectionUnsafe'],
  ] as const)('blocks %s before treating receipt damage as recoverable', async (
    _label,
    receiptState,
    violation,
    expectedError,
  ) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, `receipt-order-${receiptState}-${violation}`);
    await createMarketplaceRoot(sourceRoot);
    await createNativeProjectionFixture({ sourceRoot, stagingRoot });
    const sourcePluginRoot = path.join(sourceRoot, 'plugins', 'native-projection');
    const receiptPath = path.join(sourcePluginRoot, '.agents-plugin', 'aw-codex-native-render.json');
    if (receiptState === 'missing') await fs.remove(receiptPath);
    else await fs.outputFile(receiptPath, '{invalid');
    if (violation === 'identity') {
      const manifestPath = path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      await fs.writeJson(manifestPath, { ...manifest, name: 'conflicting-plugin' });
    } else {
      const manifestPath = path.join(sourcePluginRoot, '.codex-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      await fs.writeJson(manifestPath, { ...manifest, skills: '/unsafe/skills' });
    }

    await expect(replayNamespacedMarketplacePluginProjections({
      sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
    })).rejects.toThrow(expectedError);
  });

  it.skipIf(process.platform === 'win32')(
    'blocks an old projection symlink before treating a missing receipt as recoverable',
    async () => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
      const stagingRoot = path.join(isolation.layout.rootDir, 'missing-receipt-unsafe-tree');
      await createMarketplaceRoot(sourceRoot);
      await createNativeProjectionFixture({ sourceRoot, stagingRoot });
      const sourcePluginRoot = path.join(sourceRoot, 'plugins', 'native-projection');
      await fs.remove(path.join(sourcePluginRoot, '.agents-plugin', 'aw-codex-native-render.json'));
      const outside = path.join(isolation.layout.rootDir, 'outside-missing-receipt');
      await fs.outputFile(outside, 'outside\n');
      await fs.symlink(outside, path.join(sourcePluginRoot, 'unsafe-link'));

      await expect(replayNamespacedMarketplacePluginProjections({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      })).rejects.toThrow('codexNativeProjectionUnsafe');
    },
  );

  it('blocks projection I/O errors and skips excluded current targets before reading them', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const stagingRoot = path.join(isolation.layout.rootDir, 'native-projection-io');
    await createMarketplaceRoot(sourceRoot);
    await createNativeProjectionFixture({ sourceRoot, stagingRoot });
    const receiptPath = path.join(
      sourceRoot, 'plugins', 'native-projection', '.agents-plugin', 'aw-codex-native-render.json',
    );
    const realReadFile = fs.readFile.bind(fs);
    const readFile = vi.spyOn(fs, 'readFile').mockImplementation((async (filePath, ...args) => {
      if (path.resolve(String(filePath)) === path.resolve(receiptPath)) {
        throw Object.assign(new Error('EIO projection read'), { code: 'EIO' });
      }
      return realReadFile(filePath, ...args as never[]);
    }) as typeof fs.readFile);
    try {
      await expect(replayNamespacedMarketplacePluginProjections({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      })).rejects.toThrow('EIO projection read');
      await expect(replayNamespacedMarketplacePluginProjections({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
        rematerializedPluginIds: new Set(['official/native-projection']),
      })).resolves.toBeUndefined();
    } finally {
      readFile.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'blocks a symlink in a native projection but lets the current target replace it',
    async () => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
      const stagingRoot = path.join(isolation.layout.rootDir, 'unsafe-native-projection');
      await createMarketplaceRoot(sourceRoot);
      const fixture = await createNativeProjectionFixture({ sourceRoot, stagingRoot });
      const skillRoot = path.join(
        sourceRoot, 'plugins', 'native-projection', 'codex', 'skills', fixture.skillKey,
      );
      await fs.outputFile(path.join(isolation.layout.rootDir, 'outside-native-file'), 'outside\n');
      await fs.symlink(
        path.join(isolation.layout.rootDir, 'outside-native-file'),
        path.join(skillRoot, 'unsafe-link'),
      );

      await expect(replayNamespacedMarketplacePluginProjections({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      })).rejects.toThrow('codexNativeProjectionUnsafe');
      await expect(replayNamespacedMarketplacePluginProjections({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
        rematerializedPluginIds: new Set(['official/native-projection']),
      })).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a source plugins ancestor symlink without changing staging',
    async () => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
      const stagingRoot = path.join(isolation.layout.rootDir, 'staging');
      const outsidePlugins = path.join(isolation.layout.rootDir, 'outside-source-plugins');
      await createMarketplaceRoot(sourceRoot);
      await fs.outputJson(path.join(outsidePlugins, 'demo', '.codex-plugin', 'plugin.json'), {
        name: 'demo', version: '1.0.0', skills: './codex/skills',
      });
      const outsideSkillRoot = path.join(outsidePlugins, 'demo', 'codex', 'skills', 'demo');
      await fs.outputFile(path.join(outsideSkillRoot, 'SKILL.md'), 'outside legacy overlay\n');
      await writeSkillOwnerMarker({
        skillRoot: outsideSkillRoot,
        allowedRoot: path.dirname(outsideSkillRoot),
        identity: {
          owner: 'agent-workflows', sourceId: 'official', pluginId: 'official/demo',
          plugin: 'demo', artifactKey: 'demo', platform: 'codex', scope: 'user',
        },
      });
      await fs.symlink(outsidePlugins, path.join(sourceRoot, 'plugins'), 'dir');
      await fs.outputJson(path.join(stagingRoot, 'plugins', 'demo', '.codex-plugin', 'plugin.json'), {
        name: 'demo', version: '1.0.0', skills: './codex/skills',
      });
      await fs.outputJson(path.join(stagingRoot, 'plugins', 'demo', '.agents-plugin', 'plugin.json'), {
        name: 'demo', version: '1.0.0', description: 'demo', schemaVersion: 3,
        marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        artifacts: { targets: [{
          id: 'demo-skill', platform: 'codex', target: 'codex.skill', scopes: ['user'],
          states: ['present'], refreshKeys: [], skillKey: 'demo',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        }] },
      });
      const stagingSentinel = path.join(stagingRoot, 'sentinel.txt');
      await fs.outputFile(stagingSentinel, 'unchanged\n');

      await expect(replayNamespacedCodexSkillOverlays({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      })).rejects.toThrow('marketplaceOverlayReadFailed');

      await expect(fs.readFile(stagingSentinel, 'utf8')).resolves.toBe('unchanged\n');
      await expect(fs.pathExists(path.join(
        stagingRoot, 'plugins', 'demo', 'codex', 'skills', 'demo',
      ))).resolves.toBe(false);
      await expect(fs.readFile(path.join(outsideSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toBe('outside legacy overlay\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a staging skills ancestor symlink without writing outside staging',
    async () => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
      const stagingRoot = path.join(isolation.layout.rootDir, 'staging');
      await createMarketplaceRoot(sourceRoot);
      await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.codex-plugin', 'plugin.json'), {
        name: 'demo', version: '1.0.0', skills: './codex/skills',
      });
      const sourceSkillRoot = path.join(sourceRoot, 'plugins', 'demo', 'codex', 'skills', 'demo');
      await fs.outputFile(path.join(sourceSkillRoot, 'SKILL.md'), 'legacy overlay\n');
      await writeSkillOwnerMarker({
        skillRoot: sourceSkillRoot,
        allowedRoot: path.dirname(sourceSkillRoot),
        identity: {
          owner: 'agent-workflows', sourceId: 'official', pluginId: 'official/demo',
          plugin: 'demo', artifactKey: 'demo', platform: 'codex', scope: 'user',
        },
      });
      const stagingPluginRoot = path.join(stagingRoot, 'plugins', 'demo');
      await fs.outputJson(path.join(stagingPluginRoot, '.codex-plugin', 'plugin.json'), {
        name: 'demo', version: '1.0.0', skills: './codex/skills',
      });
      await fs.outputJson(path.join(stagingPluginRoot, '.agents-plugin', 'plugin.json'), {
        name: 'demo', version: '1.0.0', description: 'demo', schemaVersion: 3,
        marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        artifacts: { targets: [{
          id: 'demo-skill', platform: 'codex', target: 'codex.skill', scopes: ['user'],
          states: ['present'], refreshKeys: [], skillKey: 'demo',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        }] },
      });
      const outsideSkills = path.join(isolation.layout.rootDir, 'outside-staging-skills');
      await fs.outputFile(path.join(outsideSkills, 'sentinel.txt'), 'unchanged\n');
      await fs.ensureDir(path.join(stagingPluginRoot, 'codex'));
      await fs.symlink(outsideSkills, path.join(stagingPluginRoot, 'codex', 'skills'), 'dir');

      await expect(replayNamespacedCodexSkillOverlays({
        sourceRoot, stagingRoot, sourceId: 'official', sourceIdentity, marketplaceName: 'aw',
      })).rejects.toThrow('marketplaceOverlayReadFailed');

      await expect(fs.readFile(path.join(outsideSkills, 'sentinel.txt'), 'utf8'))
        .resolves.toBe('unchanged\n');
      await expect(fs.pathExists(path.join(outsideSkills, 'demo'))).resolves.toBe(false);
    },
  );
});
