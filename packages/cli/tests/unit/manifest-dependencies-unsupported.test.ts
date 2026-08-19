import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '../../src/utils/manifest.js';
import { validateCatalogManifestV3 } from '../../src/utils/catalog-manifest-v3.js';

const marketplace = {
  category: 'workflow',
  strict: true,
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
};

describe('removed plugin dependencies capability', () => {
  it('rejects dependencies in source manifests explicitly', () => {
    expect(() => validatePluginManifest('/tmp/plugin', {
      name: 'parent',
      version: '1.0.0',
      description: 'parent',
      marketplace,
      dependencies: { plugins: [{ name: 'child' }] },
    })).toThrow('top-level "dependencies" is unsupported');
  });

  it('rejects dependencies in current catalog entries explicitly', () => {
    expect(() => validateCatalogManifestV3({
      schemaVersion: 3,
      catalogVersion: '1.0.0',
      channel: 'latest',
      compatibility: { aw: { minVersion: '1.0.0' } },
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
