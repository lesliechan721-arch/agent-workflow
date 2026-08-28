import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';
import { validateCatalogManifestV5 } from '../../src/utils/catalog-manifest-v5.js';

const marketplace = {
  category: 'workflow',
  strict: true,
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
};

describe('plugin manifest dependencies contract', () => {
  it('accepts canonical dependency names and rejects invalid declarations', () => {
    const source = {
      schemaVersion: 2,
      name: 'parent',
      version: '1.0.0',
      description: 'parent',
      marketplace,
    };
    expect(validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['child', 'shared-child'],
    }).dependencies).toEqual(['child', 'shared-child']);
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: 'child',
    })).toThrow('/dependencies must be array');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['source/child'],
    })).toThrow('/dependencies/0 must match pattern');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['child', 'child'],
    })).toThrow('/dependencies must NOT have duplicate items');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['parent'],
    })).toThrow('cannot depend on itself');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: Array.from({ length: 65 }, (_, index) => `child-${index}`),
    })).toThrow('/dependencies must NOT have more than 64 items');
  });

  it('accepts dependencies without a dedicated AW feature floor', () => {
    const source = {
      schemaVersion: 2,
      name: 'parent',
      version: '1.0.0',
      description: 'parent',
      marketplace,
    };
    expect(validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['child'],
    }).dependencies).toEqual(['child']);
    expect(validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: [],
    }).dependencies).toBeUndefined();
  });

  it('accepts dependencies in catalog v5 entries', () => {
    expect(validateCatalogManifestV5({
      schemaVersion: 5,
      catalogVersion: '1.0.0',
      channel: 'latest',
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v5'] } },
      marketplace: {
        owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
        interface: { displayName: 'Fixture Marketplace' },
      },
      release: { state: 'development' },
      entries: [{
        name: 'parent',
        version: '1.0.0',
        description: 'parent',
        category: 'workflow',
        strict: true,
        policy: marketplace.policy,
        requires: { aw: { capabilities: ['aw.plugin-manifest.v2'] } },
        dependencies: ['child'],
        source: './plugins/parent',
        artifactDigest: `sha256:${'0'.repeat(64)}`,
        manifestDigest: `sha256:${'1'.repeat(64)}`,
        contentDigest: `sha256:${'2'.repeat(64)}`,
      }],
    }).entries[0]!.dependencies).toEqual(['child']);
  });
});
