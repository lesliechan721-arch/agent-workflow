import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginMeta } from '../../src/types.js';
import { calculateCatalogEntryContentDigest } from '../../src/utils/catalog-digests.js';
import {
  createCatalogManifestV3,
  createCatalogManifestV3Entry,
  validateCatalogManifestV3,
} from '../../src/utils/catalog-manifest-v3.js';

const tempDirs: string[] = [];

function sha256(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function createManifestFixture() {
  return {
    schemaVersion: 3,
    catalogVersion: '1.2.3',
    channel: 'latest',
    compatibility: { aw: { minVersion: '0.0.0' } },
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
      compatibility: { aw: { minVersion: '0.0.0' } },
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

describe('catalog manifest schema 3', () => {
  it('validates a package-independent manifest with entry content digests', () => {
    const manifest = validateCatalogManifestV3(createManifestFixture());

    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.entries[0]).toMatchObject({
      artifactDigest: sha256('a'),
      manifestDigest: sha256('b'),
      contentDigest: sha256('c'),
    });
    expect(manifest).not.toHaveProperty('packages');
  });

  it('rejects npm package identity and missing or invalid content digests', () => {
    expect(() => validateCatalogManifestV3({
      ...createManifestFixture(),
      packages: {},
    })).toThrow('unknown field "packages"');

    const missing = createManifestFixture();
    delete (missing.entries[0] as Partial<typeof missing.entries[0]>).contentDigest;
    expect(() => validateCatalogManifestV3(missing)).toThrow('contentDigest');

    const invalid = createManifestFixture();
    invalid.entries[0]!.contentDigest = 'sha256:not-hex';
    expect(() => validateCatalogManifestV3(invalid)).toThrow('contentDigest');
  });

  it('applies package-independent catalog and entry invariants', () => {
    const duplicate = createManifestFixture();
    duplicate.entries.push(structuredClone(duplicate.entries[0]!));
    expect(() => validateCatalogManifestV3(duplicate)).toThrow('duplicate plugin "demo"');

    const incompatible = createManifestFixture();
    incompatible.entries[0]!.compatibility.aw.minVersion = '2.0.0';
    expect(() => validateCatalogManifestV3(incompatible)).toThrow('higher than catalog minimum');
  });

  it('creates and validates a schema 3 manifest through its explicit generator API', () => {
    const fixture = createManifestFixture();
    const generated = createCatalogManifestV3({
      catalogVersion: fixture.catalogVersion,
      channel: fixture.channel as 'latest',
      compatibility: fixture.compatibility,
      entries: fixture.entries,
    });

    expect(generated).toEqual(fixture);
  });

  it('generates entry artifact, manifest, and content digests from a real plugin tree', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-manifest-v3-'));
    tempDirs.push(pluginRoot);
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest: PluginMeta['manifest'] = {
      name: 'demo',
      version: '1.2.0',
      description: 'demo plugin',
      compatibility: { aw: { minVersion: '0.0.0' } },
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

    const entry = await createCatalogManifestV3Entry(plugin, pluginRoot);

    expect(entry.contentDigest).toBe(await calculateCatalogEntryContentDigest(pluginRoot));
    expect(entry.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
