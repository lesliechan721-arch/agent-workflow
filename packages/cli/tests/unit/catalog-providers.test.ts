import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import type { CatalogSourceProviderSet } from '../../src/utils/multi-source-catalog.js';
import {
  catalogSourceCacheInternal,
  cleanupLegacyCatalogSourceCache,
} from '../../src/utils/catalog-source-cache.js';
import { validateCatalogSnapshot } from '../../src/utils/catalog-snapshot.js';
import { calculateCatalogSourcesConfigDigest } from '../../src/utils/catalog-sources.js';
import {
  formatPluginId,
  parsePluginId,
  preflightDesiredArtifactCollisions,
  withResolvedMultiSourceCatalog,
} from '../../src/utils/multi-source-catalog.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const {
  publishCatalogSourceCacheEntry,
  readCatalogSourceCache,
  resolveCatalogSourceCacheLocation,
} = catalogSourceCacheInternal;
const identity = `sha256:${'1'.repeat(64)}`;

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
