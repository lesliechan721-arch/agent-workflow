import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';
import { validateCatalogManifestV4 } from '../../src/utils/catalog-manifest-v4.js';

const marketplace = {
  category: 'workflow',
  strict: true,
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
};

const compatibility = { aw: { minVersion: '0.1.0' } };

describe('plugin manifest dependencies contract', () => {
  it('accepts canonical dependency names and rejects invalid declarations', () => {
    const source = {
      name: 'parent',
      version: '1.0.0',
      description: 'parent',
      compatibility,
      marketplace,
    };
    expect(validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['child', 'shared-child'],
    }).dependencies).toEqual(['child', 'shared-child']);
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: 'child',
    })).toThrow('expected an array');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['source/child'],
    })).toThrow('lowercase hyphen-case');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['child', 'child'],
    })).toThrow('duplicate plugin "child"');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['parent'],
    })).toThrow('cannot depend on itself');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: Array.from({ length: 65 }, (_, index) => `child-${index}`),
    })).toThrow('at most 64');
  });

  it('requires AW 0.1.0 only for non-empty dependencies', () => {
    const source = {
      name: 'parent',
      version: '1.0.0',
      description: 'parent',
      marketplace,
    };
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      compatibility: { aw: { minVersion: '0.1.0-beta.3' } },
      dependencies: ['child'],
    })).toThrow('dependencies requires AW 0.1.0 or newer');
    expect(() => validatePluginManifest('/tmp/plugin', {
      ...source,
      dependencies: ['child'],
    })).toThrow('dependencies requires AW 0.1.0 or newer');
    expect(validatePluginManifest('/tmp/plugin', {
      ...source,
      compatibility,
      dependencies: [],
    }).dependencies).toBeUndefined();
  });

  it('rejects dependencies in current catalog entries explicitly', () => {
    expect(() => validateCatalogManifestV4({
      schemaVersion: 4,
      catalogVersion: '1.0.0',
      channel: 'latest',
      compatibility: { aw: { minVersion: '1.0.0' } },
      release: { state: 'development' },
      entries: [{
        name: 'parent',
        version: '1.0.0',
        description: 'parent',
        category: 'workflow',
        strict: true,
        policy: marketplace.policy,
        compatibility: { aw: { minVersion: '1.0.0' } },
        dependencies: { plugins: [] },
        source: 'plugins/parent',
        artifactDigest: `sha256:${'0'.repeat(64)}`,
        manifestDigest: `sha256:${'1'.repeat(64)}`,
        contentDigest: `sha256:${'2'.repeat(64)}`,
      }],
    })).toThrow('"dependencies" is unsupported');
  });
});
