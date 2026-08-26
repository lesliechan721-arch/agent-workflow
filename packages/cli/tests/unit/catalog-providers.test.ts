import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import type { CatalogSourceProviderSet } from '../../src/utils/multi-source-catalog.js';
import {
  catalogSourceCacheInternal,
  cleanupLegacyCatalogSourceCache,
} from '../../src/utils/catalog-source-cache.js';
import { validateCatalogSnapshot } from '../../src/utils/catalog-snapshot.js';
import { createCatalogManifestV4Entry } from '../../src/utils/catalog-manifest-v4.js';
import { calculateCatalogSourcesConfigDigest } from '../../src/utils/catalog-sources.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import {
  formatPluginId,
  parsePluginId,
  preflightDesiredArtifactCollisions,
  withResolvedMultiSourceCatalog,
} from '../../src/utils/multi-source-catalog.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

const {
  publishCatalogSourceCacheEntry,
  readCatalogSourceCache,
  resolveCatalogSourceCacheLocation,
} = catalogSourceCacheInternal;
const identity = `sha256:${'1'.repeat(64)}`;
const execFileAsync = promisify(execFile);

describe('catalog Git authentication environment', () => {
  it('uses local Git credentials and SSH config without allowing interactive or proxy commands', () => {
    const env = catalogGitProviderInternal.gitEnvironment({
      HOME: '/isolated-home',
      SSH_AUTH_SOCK: '/auth/socket',
      GIT_DIR: '/foreign/repository',
      GIT_SSH_COMMAND: 'ssh -F /foreign/config',
    });

    expect(env).toMatchObject({
      HOME: '/isolated-home',
      SSH_AUTH_SOCK: '/auth/socket',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toContain('-oBatchMode=yes');
    expect(env.GIT_SSH_COMMAND).toContain('-oPermitLocalCommand=no');
    expect(env.GIT_SSH_COMMAND).toContain('-oProxyCommand=none');
    expect(env.GIT_SSH_COMMAND).not.toMatch(/(?:^|\s)-F(?:\s|$)/u);
  });
});

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

async function publishFixtureManifest(root: string): Promise<void> {
  const manifestPath = path.join(root, 'catalog-manifest.json');
  const manifest = await fs.readJson(manifestPath);
  const contentDigest = sha256({
    schemaIdentity: { schemaVersion: manifest.schemaVersion },
    marketplaceMetadata: { name: 'aw', ...manifest.marketplace },
    compatibility: manifest.compatibility,
    plugins: manifest.entries.map((entry: Record<string, string>) => ({
      name: entry.name,
      targetVersion: entry.version,
      contentDigest: entry.contentDigest,
    })),
  });
  manifest.release = {
    state: 'published',
    targetVersion: manifest.catalogVersion,
    planId: contentDigest,
    sourceHead: '1'.repeat(40),
    contentDigest,
  };
  await Promise.all([
    fs.writeJson(manifestPath, manifest),
    fs.writeJson(path.join(root, 'plugin-release-ledger.json'), {
      schemaVersion: 2,
      records: manifest.entries.map((entry: Record<string, string>) => ({
        plugin: entry.name,
        version: entry.version,
        contentDigest: entry.contentDigest,
        artifactDigest: entry.artifactDigest,
        manifestDigest: entry.manifestDigest,
        channel: manifest.channel,
        catalogVersion: manifest.catalogVersion,
      })),
    }),
  ]);
}

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

async function publish(root: string, resolvedCommit: string): Promise<ReturnType<typeof resolveCatalogSourceCacheLocation>> {
  const isolation = getCurrentSourceTestIsolation();
  const validation = await validateCatalogSnapshot(root);
  const location = resolveCatalogSourceCacheLocation({ sourceId: 'team', sourceIdentity: identity, env: isolation.env });
  await publishCatalogSourceCacheEntry({
    location,
    sourceId: 'team',
    sourceIdentity: identity,
    requestedRef: 'refs/heads/catalog/latest',
    cliVersion: '1.0.0',
    resolvedCommit,
    snapshotRoot: root,
    validation,
  });
  return location;
}

describe('catalog source current and last-good cache', () => {
  it('rejects a cached published snapshot after its required ledger is removed', async () => {
    const root = fixturePath('cache-published-ledger');
    await createCatalogSnapshotFixture(root);
    await publishFixtureManifest(root);
    const location = await publish(root, '1'.repeat(40));
    await fs.remove(path.join(location.currentDir, 'snapshot', 'plugin-release-ledger.json'));
    await expect(readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', cliVersion: '1.0.0',
    })).resolves.toBeNull();
  });
  it('publishes complete validated snapshots and rotates current to last-good', async () => {
    const first = fixturePath('cache-first');
    const second = fixturePath('cache-second');
    await createCatalogSnapshotFixture(first, 'demo', '0.9.0', 'first\n');
    await createCatalogSnapshotFixture(second, 'demo', '0.1.0', 'second\n');
    const location = await publish(first, '1'.repeat(40));
    const firstDigest = (await readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', cliVersion: '1.0.0',
    }))!.validation.snapshotDigest;
    await publish(second, '2'.repeat(40));
    expect(await fs.pathExists(path.join(location.currentDir, 'metadata.json'))).toBe(true);
    expect(await fs.pathExists(path.join(location.lastGoodDir, 'metadata.json'))).toBe(true);
    expect((await readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', cliVersion: '1.0.0',
    }))!.validation.snapshotDigest).not.toBe(firstDigest);
  });

  it('falls back to matching last-good when current is corrupt', async () => {
    const first = fixturePath('fallback-first');
    const second = fixturePath('fallback-second');
    await createCatalogSnapshotFixture(first, 'demo', '0.1.0', 'first\n');
    await createCatalogSnapshotFixture(second, 'demo', '0.1.0', 'second\n');
    const location = await publish(first, '1'.repeat(40));
    const expected = (await validateCatalogSnapshot(first)).snapshotDigest;
    await publish(second, '2'.repeat(40));
    await fs.writeFile(path.join(location.currentDir, 'snapshot', 'catalog-manifest.json'), '{}\n');
    const fallback = await readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', cliVersion: '1.0.0',
    });
    expect(fallback?.entryDir).toBe(location.lastGoodDir);
    expect(fallback?.validation.snapshotDigest).toBe(expected);
  });

  it.each([
    ['identity', `sha256:${'2'.repeat(64)}`, 'refs/heads/catalog/latest', '1.0.0'],
    ['ref', identity, 'refs/heads/catalog/beta', '1.0.0'],
    ['compatibility', identity, 'refs/heads/catalog/latest', '0.1.0-beta.2'],
  ])('rejects last-good when %s does not match', async (_label, sourceIdentity, requestedRef, cliVersion) => {
    const first = fixturePath(`mismatch-first-${_label}`);
    const second = fixturePath(`mismatch-second-${_label}`);
    await createCatalogSnapshotFixture(first, 'demo', '0.1.0', 'first\n');
    await createCatalogSnapshotFixture(second, 'demo', '0.1.0', 'second\n');
    const location = await publish(first, '1'.repeat(40));
    await publish(second, '2'.repeat(40));
    await fs.writeFile(path.join(location.currentDir, 'snapshot', 'catalog-manifest.json'), '{}\n');
    await expect(readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity, requestedRef, cliVersion,
    })).resolves.toBeNull();
  });

  it('keeps current unchanged when candidate validation fails', async () => {
    const first = fixturePath('stable-current');
    const broken = fixturePath('broken-candidate');
    await createCatalogSnapshotFixture(first);
    await createCatalogSnapshotFixture(broken);
    const location = await publish(first, '1'.repeat(40));
    const before = (await readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', cliVersion: '1.0.0',
    }))!.metadata.entryKey;
    const validation = await validateCatalogSnapshot(broken);
    await fs.writeFile(path.join(broken, 'catalog-manifest.json'), '{}\n');
    await expect(publishCatalogSourceCacheEntry({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', resolvedCommit: '2'.repeat(40),
      cliVersion: '1.0.0',
      snapshotRoot: broken, validation,
    })).rejects.toThrow();
    expect((await readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', cliVersion: '1.0.0',
    }))!.metadata.entryKey).toBe(before);
  });

  it('keeps callback evidence and content on one generation while cache identity and ref advance', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('callback-generation-first');
    const second = fixturePath('callback-generation-second');
    await createCatalogSnapshotFixture(first, 'demo', '0.1.0', 'first generation\n');
    await createCatalogSnapshotFixture(second, 'demo', '0.1.0', 'second generation\n');
    const location = await publish(first, '1'.repeat(40));
    const cached = (await readCatalogSourceCache({
      location, sourceId: 'team', sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest', cliVersion: '1.0.0',
    }))!;
    let callbackEntered!: () => void;
    const entered = new Promise<void>((resolve) => { callbackEntered = resolve; });
    let releaseCallback!: () => void;
    const released = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const config = {
      schemaVersion: 1 as const,
      sources: [{ id: 'team', type: 'path' as const, path: first, primary: true }],
    };
    const providers: CatalogSourceProviderSet = {
      git: async () => { throw new Error('unused'); },
      path: async () => ({
        sourceId: 'team', sourceIdentity: identity,
        requestedRef: 'refs/heads/catalog/latest', resolvedCommit: cached.metadata.resolvedCommit,
        rootDir: cached.snapshotRoot, manifest: cached.validation.manifest,
        manifestDigest: cached.validation.manifestDigest, snapshotDigest: cached.validation.snapshotDigest,
        cacheEntryKey: cached.metadata.entryKey, source: 'cache', cacheFallback: false,
      }),
    };
    const consuming = withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0', freshnessPolicy: 'cacheFirst', providers,
      configSnapshot: { config, digest: calculateCatalogSourcesConfigDigest(config), materialized: true },
      consume: async (catalog) => {
        const source = catalog.sources[0]!.resolution!;
        const before = await fs.readFile(path.join(source.rootDir, 'plugins', 'demo', 'README.md'), 'utf8');
        callbackEntered();
        await released;
        const after = await fs.readFile(path.join(source.rootDir, 'plugins', 'demo', 'README.md'), 'utf8');
        return {
          sourceIdentity: source.sourceIdentity,
          requestedRef: source.requestedRef,
          snapshotDigest: source.snapshotDigest,
          manifestDigest: source.manifestDigest,
          contentDigest: source.manifest.entries[0]!.contentDigest,
          before,
          after,
        };
      },
    });
    await entered;
    const advancedIdentity = `sha256:${'2'.repeat(64)}`;
    const advancedValidation = await validateCatalogSnapshot(second);
    const advancedLocation = resolveCatalogSourceCacheLocation({
      sourceId: 'team', sourceIdentity: advancedIdentity, env: isolation.env,
    });
    await publishCatalogSourceCacheEntry({
      location: advancedLocation, sourceId: 'team', sourceIdentity: advancedIdentity,
      requestedRef: 'refs/heads/catalog/beta', cliVersion: '1.0.0', resolvedCommit: '2'.repeat(40),
      snapshotRoot: second, validation: advancedValidation,
    });
    releaseCallback();
    await expect(consuming).resolves.toEqual({
      sourceIdentity: identity,
      requestedRef: 'refs/heads/catalog/latest',
      snapshotDigest: cached.validation.snapshotDigest,
      manifestDigest: cached.validation.manifestDigest,
      contentDigest: cached.validation.manifest.entries[0]!.contentDigest,
      before: 'first generation\n',
      after: 'first generation\n',
    });
  });

  it('does not follow a catalog-cache symlink during legacy cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const victim = fixturePath('legacy-cleanup-victim');
    const cacheRoot = path.join(isolation.env.AW_HOME!, 'catalog-cache');
    await Promise.all([fs.ensureDir(victim), fs.ensureDir(isolation.env.AW_HOME!)]);
    await fs.outputFile(path.join(victim, 'selectors', 'keep.json'), '{}\n');
    await fs.symlink(victim, cacheRoot, 'dir');

    await expect(cleanupLegacyCatalogSourceCache(isolation.env)).resolves.toContain(
      '旧 Catalog cache 根不是普通目录，已跳过清理。',
    );
    await expect(fs.readFile(path.join(victim, 'selectors', 'keep.json'), 'utf8')).resolves.toBe('{}\n');
  });
});

describe('multi-source resolver public behavior', () => {
  it('rejects published CLI and path source validation without the release ledger', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('published-without-ledger');
    await createCatalogSnapshotFixture(root);
    await publishFixtureManifest(root);
    await fs.remove(path.join(root, 'plugin-release-ledger.json'));

    await expect(validateCatalogSnapshot(root)).rejects.toThrow(/must include plugin-release-ledger/u);
    await expect(catalogPathProviderInternal.resolve({
      id: 'missing-ledger', type: 'path', primary: true, path: root,
    }, {
      cliVersion: '1.0.0', freshnessPolicy: 'forceRemote', env: isolation.env,
    })).rejects.toThrow(/must include plugin-release-ledger/u);
  });

  it('rejects joint marketplace root metadata changes against the canonical manifest identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('joint-marketplace-metadata');
    await createCatalogSnapshotFixture(root);
    for (const marketplacePath of [
      path.join(root, '.agents', 'plugins', 'marketplace.json'),
      path.join(root, '.claude-plugin', 'marketplace.json'),
    ]) {
      const marketplace = await fs.readJson(marketplacePath);
      marketplace.owner = { name: 'Tampered Owner', url: 'https://example.invalid/tampered' };
      marketplace.interface = { displayName: 'Tampered Marketplace' };
      await fs.writeJson(marketplacePath, marketplace);
    }

    await expect(catalogPathProviderInternal.resolve({
      id: 'joint-metadata', type: 'path', primary: true, path: root,
    }, {
      cliVersion: '1.0.0', freshnessPolicy: 'forceRemote', env: isolation.env,
    })).rejects.toThrow(/marketplace metadata or plugin inventory/u);
  });
  it('rejects a path source with a tampered Codex marketplace projection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('tampered-path-marketplace');
    await createCatalogSnapshotFixture(root);
    const marketplacePath = path.join(root, '.agents', 'plugins', 'marketplace.json');
    const marketplace = await fs.readJson(marketplacePath);
    marketplace.plugins[0].description = 'tampered';
    await fs.writeJson(marketplacePath, marketplace);

    await expect(catalogPathProviderInternal.resolve({
      id: 'tampered-path', type: 'path', primary: true, path: root,
    }, {
      cliVersion: '1.0.0', freshnessPolicy: 'forceRemote', env: isolation.env,
    })).rejects.toThrow(/Codex marketplace metadata or plugin inventory/u);
  });

  it('rejects a path source with a tampered platform manifest after digest recomputation', async () => {
    const root = fixturePath('tampered-path-platform-manifest');
    await createCatalogSnapshotFixture(root);
    const pluginRoot = path.join(root, 'plugins', 'demo');
    const platformManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const platformManifest = await fs.readJson(platformManifestPath);
    platformManifest.version = '9.9.9';
    await fs.writeJson(platformManifestPath, platformManifest);
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const catalogManifestPath = path.join(root, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    catalogManifest.entries = [await createCatalogManifestV4Entry(plugin, pluginRoot)];
    await fs.writeJson(catalogManifestPath, catalogManifest);

    await expect(catalogPathProviderInternal.resolve({
      id: 'tampered-platform', type: 'path', primary: true, path: root,
    }, {
      cliVersion: '99.0.0',
      freshnessPolicy: 'forceRemote',
      env: getCurrentSourceTestIsolation().env,
    })).rejects.toThrow(/codex platform manifest projection/u);
  });

  it('rejects a Git source with a tampered Claude marketplace projection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('tampered-git-source');
    const remoteRoot = fixturePath('tampered-git-remote.git');
    await createCatalogSnapshotFixture(sourceRoot);
    for (const marketplacePath of [
      path.join(sourceRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(sourceRoot, '.claude-plugin', 'marketplace.json'),
    ]) {
      const marketplace = await fs.readJson(marketplacePath);
      marketplace.owner = { name: 'Tampered Owner', url: 'https://example.invalid/tampered' };
      marketplace.interface = { displayName: 'Tampered Marketplace' };
      await fs.writeJson(marketplacePath, marketplace);
    }
    await execFileAsync('git', ['init'], { cwd: sourceRoot });
    await execFileAsync('git', ['add', '.'], { cwd: sourceRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'tampered snapshot',
    ], { cwd: sourceRoot });
    await execFileAsync('git', ['init', '--bare', remoteRoot]);
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: sourceRoot });
    await execFileAsync('git', ['push', 'origin', 'HEAD:refs/heads/catalog/latest'], { cwd: sourceRoot });

    await expect(catalogGitProviderInternal.resolve({
      id: 'tampered-git', type: 'git', primary: true, url: remoteRoot,
      refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
    }, {
      cliVersion: '1.0.0', freshnessPolicy: 'forceRemote', env: isolation.env,
    })).rejects.toThrow(/marketplace metadata or plugin inventory/u);
  });

  it('isolates one source failure and preserves the other source result', async () => {
    const root = fixturePath('resolver-good');
    await createCatalogSnapshotFixture(root);
    const validation = await validateCatalogSnapshot(root);
    const config = {
      schemaVersion: 1 as const,
      sources: [
        { id: 'bad', type: 'path' as const, path: fixturePath('missing'), primary: false },
        { id: 'good', type: 'path' as const, path: root, primary: true },
      ],
    };
    const providers: CatalogSourceProviderSet = {
      git: async () => { throw new Error('unused'); },
      path: async (source) => {
        if (source.id === 'bad') throw new Error('source unavailable');
        return {
          sourceId: source.id,
          sourceIdentity: identity,
          requestedRef: 'path',
          resolvedCommit: `path:${validation.snapshotDigest}`,
          rootDir: root,
          manifest: validation.manifest,
          manifestDigest: validation.manifestDigest,
          snapshotDigest: validation.snapshotDigest,
          cacheEntryKey: 'good',
          source: 'path',
          cacheFallback: false,
        };
      },
    };
    const result = await withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0', freshnessPolicy: 'cacheFirst', providers,
      configSnapshot: { config, digest: calculateCatalogSourcesConfigDigest(config), materialized: true },
      consume: (catalog) => catalog.sources.map((item) => ({ id: item.sourceId, error: Boolean(item.error) })),
    });
    expect(result).toEqual([{ id: 'bad', error: true }, { id: 'good', error: false }]);
  });

  it('keeps qualified IDs, bare selector parsing, and artifact collision preflight', () => {
    expect(parsePluginId('team/demo')).toEqual({ sourceId: 'team', pluginName: 'demo' });
    expect(parsePluginId('demo')).toEqual({ pluginName: 'demo' });
    expect(formatPluginId({ sourceId: 'team', pluginName: 'demo' })).toBe('team/demo');
    expect(preflightDesiredArtifactCollisions([
      { pluginId: 'one/a', targetKey: 'codex:user', artifactKeys: ['same'] },
      { pluginId: 'two/b', targetKey: 'codex:user', artifactKeys: ['same'] },
    ])).toEqual([expect.objectContaining({ artifactKey: 'same', pluginIds: ['one/a', 'two/b'] })]);
  });
});
