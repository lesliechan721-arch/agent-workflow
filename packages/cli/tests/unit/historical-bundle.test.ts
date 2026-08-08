import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { loadVerifiedHistoricalBundlePlugin } from '../../src/install-state/historical-bundle.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';

const tempDirs: string[] = [];

async function createHistoricalBundle(): Promise<{
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
}> {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-historical-bundle-'));
  tempDirs.push(runtimeRoot);
  const bundleRoot = path.join(runtimeRoot, 'snapshots', 'historical-test');
  const manifestPath = path.join(bundleRoot, '.agents-plugin', 'plugin.json');
  await fs.outputJson(manifestPath, {
    name: 'historical-test',
    version: '1.0.0',
    description: 'Historical bundle fixture.',
    compatibility: {
      aw: { minVersion: '0.0.0' },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
        products: ['CODEX'],
      },
    },
  }, { spaces: 2 });
  return { runtimeRoot, bundleRoot, manifestPath };
}

async function loadFixture(options: {
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
  sourceManifestDigest?: string;
}) {
  return loadVerifiedHistoricalBundlePlugin({
    pluginName: 'historical-test',
    pluginVersion: '1.0.0',
    runtimeRoot: options.runtimeRoot,
    bundleRoot: options.bundleRoot,
    manifestPath: options.manifestPath,
    sourceManifestDigest: options.sourceManifestDigest
      ?? await calculateFileDigest(options.manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(options.bundleRoot),
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('historical bundle verification', () => {
  it('loads a historical bundle only when its current contract and recorded identity match', async () => {
    const fixture = await createHistoricalBundle();

    await expect(loadFixture(fixture)).resolves.toMatchObject({
      status: 'ok',
      plugin: {
        manifest: {
          name: 'historical-test',
          version: '1.0.0',
        },
      },
    });
  });

  it('rejects historical manifests with fields outside the current contract', async () => {
    const fixture = await createHistoricalBundle();
    const manifest = await fs.readJson(fixture.manifestPath);
    manifest.unsupportedField = true;
    await fs.writeJson(fixture.manifestPath, manifest, { spaces: 2 });

    await expect(loadFixture(fixture)).resolves.toMatchObject({
      status: 'invalid',
      reason: expect.stringContaining(
        'Invalid plugin manifest: unknown field "unsupportedField"',
      ),
    });
  });

  it('rejects historical bundles whose manifest digest differs from the record', async () => {
    const fixture = await createHistoricalBundle();

    await expect(loadFixture({
      ...fixture,
      sourceManifestDigest: `sha256:${'0'.repeat(64)}`,
    })).resolves.toEqual({
      status: 'invalid',
      reason: 'historical manifest digest 与记录不一致',
    });
  });
});
