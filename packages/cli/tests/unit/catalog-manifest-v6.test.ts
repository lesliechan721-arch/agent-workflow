import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginMeta } from '../../src/types.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
} from '../../src/utils/catalog-digests.js';
import {
  createCatalogManifestV6,
  createCatalogManifestV6Entry,
  validateCatalogManifestV6,
} from '../../src/utils/catalog-manifest-v6.js';

const tempDirs: string[] = [];

function sha256(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function createManifestFixture() {
  return {
    schemaVersion: 6,
    catalogVersion: '1.2.3',
    channel: 'latest',
    requires: { aw: { capabilities: ['aw.catalog-snapshot.v6'] } },
    marketplace: {
      owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
      interface: { displayName: 'Fixture Marketplace' },
    },
    release: { state: 'development' as const },
    entries: [{
      name: 'demo',
      version: '1.2.0',
      description: 'demo plugin',
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      dependencies: [],
      requires: { aw: { capabilities: ['aw.plugin-manifest.v2'] } },
      source: './plugins/demo',
      artifactDigest: sha256('a'),
      manifestDigest: sha256('b'),
      contentDigest: sha256('c'),
    }],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('catalog manifest schema 6', () => {
  it('validates a package-independent manifest with entry content digests', () => {
    const manifest = validateCatalogManifestV6(createManifestFixture());

    expect(manifest.schemaVersion).toBe(6);
    expect(manifest.entries[0]).toMatchObject({
      artifactDigest: sha256('a'),
      manifestDigest: sha256('b'),
      contentDigest: sha256('c'),
    });
    expect(manifest).not.toHaveProperty('packages');
  });

  it('requires one explicit canonical marketplace root identity', () => {
    const missing = createManifestFixture();
    delete (missing as Partial<typeof missing>).marketplace;
    expect(() => validateCatalogManifestV6(missing)).toThrow(/marketplace/u);
    const ambiguous = createManifestFixture() as ReturnType<typeof createManifestFixture> & {
      marketplace: ReturnType<typeof createManifestFixture>['marketplace'] & { catalog: object };
    };
    ambiguous.marketplace.catalog = { version: '1.2.3' };
    expect(() => validateCatalogManifestV6(ambiguous)).toThrow(/unknown field/u);
  });

  it('rejects schema 5 and limits published release metadata to sourceHead', () => {
    const schemaFive = createManifestFixture();
    schemaFive.schemaVersion = 5;
    expect(() => validateCatalogManifestV6(schemaFive)).toThrow('schemaVersion: expected 6');

    const published = createManifestFixture() as Record<string, unknown>;
    published.release = { state: 'published' };
    expect(() => validateCatalogManifestV6(published)).toThrow('sourceHead');

    published.release = {
      state: 'published',
      sourceHead: 'e'.repeat(40),
    };
    expect(validateCatalogManifestV6(published).release).toEqual(published.release);

    const withLedgerIdentity = structuredClone(published);
    (withLedgerIdentity.release as Record<string, unknown>).contentDigest = sha256('f');
    expect(() => validateCatalogManifestV6(withLedgerIdentity)).toThrow('unknown field');
  });

  it('rejects npm package identity and missing or invalid content digests', () => {
    expect(() => validateCatalogManifestV6({
      ...createManifestFixture(),
      packages: {},
    })).toThrow('unknown field "packages"');

    const missing = createManifestFixture();
    delete (missing.entries[0] as Partial<typeof missing.entries[0]>).contentDigest;
    expect(() => validateCatalogManifestV6(missing)).toThrow('contentDigest');

    const invalid = createManifestFixture();
    invalid.entries[0]!.contentDigest = 'sha256:not-hex';
    expect(() => validateCatalogManifestV6(invalid)).toThrow('contentDigest');
  });

  it('applies package-independent catalog and entry invariants while accepting future capabilities', () => {
    const duplicate = createManifestFixture();
    duplicate.entries.push(structuredClone(duplicate.entries[0]!));
    expect(() => validateCatalogManifestV6(duplicate)).toThrow('duplicate plugin "demo"');

    const future = createManifestFixture();
    future.entries[0]!.requires.aw.capabilities.push('aw.future-feature.v3');
    expect(validateCatalogManifestV6(future).entries[0]!.requires.aw.capabilities)
      .toContain('aw.future-feature.v3');
  });

  it('creates and validates a schema 6 manifest through its explicit generator API', () => {
    const fixture = createManifestFixture();
    const generated = createCatalogManifestV6({
      catalogVersion: fixture.catalogVersion,
      channel: fixture.channel as 'latest',
      requires: fixture.requires,
      marketplace: fixture.marketplace,
      release: fixture.release,
      entries: fixture.entries,
    });

    expect(generated).toEqual(fixture);
  });

  it('generates entry artifact, manifest, and content digests from a real plugin tree', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-manifest-v6-'));
    tempDirs.push(pluginRoot);
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest: PluginMeta['manifest'] = {
      schemaVersion: 2,
      name: 'demo',
      version: '1.2.0',
      description: 'demo plugin',
      dependencies: ['shared-runtime'],
      requires: { aw: { capabilities: ['aw.plugin-manifest.v2'] } },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
    };
    await fs.outputJson(manifestPath, manifest, { spaces: 2 });
    await fs.outputFile(path.join(pluginRoot, 'README.md'), 'demo\n');
    const plugin: PluginMeta = { rootDir: pluginRoot, manifestPath, manifest };

    const entry = await createCatalogManifestV6Entry(plugin, pluginRoot);

    expect(entry.contentDigest).toBe(await calculateCatalogEntryContentDigest(pluginRoot));
    expect(entry.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.dependencies).toEqual(['shared-runtime']);
    expect(entry.requires.aw.capabilities).toEqual(['aw.plugin-manifest.v2']);
  });

  it('binds artifact and content digests to the canonical Git executable mode', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-digest-mode-'));
    tempDirs.push(pluginRoot);
    const runtimePath = path.join(pluginRoot, 'runtime.sh');
    await fs.outputFile(runtimePath, '#!/bin/sh\n');
    await fs.chmod(runtimePath, 0o644);
    const regular = {
      artifact: await calculateCatalogEntryArtifactDigest(pluginRoot),
      content: await calculateCatalogEntryContentDigest(pluginRoot),
    };

    await fs.chmod(runtimePath, 0o655);
    await expect(calculateCatalogEntryArtifactDigest(pluginRoot)).resolves.toBe(regular.artifact);
    await expect(calculateCatalogEntryContentDigest(pluginRoot)).resolves.toBe(regular.content);

    await fs.chmod(runtimePath, 0o755);

    await expect(calculateCatalogEntryArtifactDigest(pluginRoot)).resolves.not.toBe(regular.artifact);
    await expect(calculateCatalogEntryContentDigest(pluginRoot)).resolves.not.toBe(regular.content);
  });

  it('binds artifact and content digests to file versus symlink node kind', async () => {
    const fileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-digest-file-'));
    const symlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-digest-link-'));
    tempDirs.push(fileRoot, symlinkRoot);
    await fs.outputFile(path.join(fileRoot, 'runtime'), 'symlink:target');
    await fs.symlink('target', path.join(symlinkRoot, 'runtime'));

    await expect(calculateCatalogEntryArtifactDigest(symlinkRoot)).resolves.not.toBe(
      await calculateCatalogEntryArtifactDigest(fileRoot),
    );
    await expect(calculateCatalogEntryContentDigest(symlinkRoot)).resolves.not.toBe(
      await calculateCatalogEntryContentDigest(fileRoot),
    );
  });
});
