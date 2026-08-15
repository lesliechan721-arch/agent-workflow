import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareCatalogRelease } from '../../../../scripts/release/common.mjs';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import type { CatalogManifest, PluginMeta } from '../../src/types.js';
import * as bundleLayout from '../../src/utils/bundle-layout.js';
import { calculateCatalogEntryContentDigest } from '../../src/utils/catalog-digests.js';
import * as manifest from '../../src/utils/manifest.js';
import {
  appendCatalogToPluginReleaseLedger,
  mergePluginReleaseLedgers,
  resolveBetaPluginVersionOverrides,
  type PluginReleaseLedger,
} from '../../src/utils/plugin-release.js';

const tempDirs: string[] = [];
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;

function createPlugin(name: string, version = '1.0.0'): PluginMeta {
  return {
    rootDir: `/plugins/${name}`,
    manifestPath: `/plugins/${name}/.agents-plugin/plugin.json`,
    manifest: {
      name,
      version,
      description: `${name} fixture`,
      compatibility: { aw: { minVersion: '0.0.0' } },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NOT_REQUIRED',
          products: ['CODEX'],
        },
      },
    },
  };
}

function createManifest(options: {
  version: string;
  artifactDigest?: string;
  manifestDigest?: string;
  catalogVersion?: string;
  channel?: 'latest' | 'beta';
}): CatalogManifest {
  const catalogVersion = options.catalogVersion ?? '2.0.0-beta.1';
  const channel = options.channel ?? 'beta';
  return {
    schemaVersion: 2,
    catalogVersion,
    channel,
    compatibility: { aw: { minVersion: '0.0.0' } },
    packages: {
      sidecar: {
        name: '@lesliechan721/aw-plugins-manifest',
        version: catalogVersion,
        channel,
      },
      full: {
        name: '@lesliechan721/aw-plugins',
        version: catalogVersion,
        channel,
        manifestPath: './catalog-manifest.json',
      },
    },
    entries: [{
      name: 'ask-me',
      version: options.version,
      description: 'Ask Me fixture',
      source: './plugins/ask-me',
      category: 'workflow',
      strict: true,
      compatibility: { aw: { minVersion: '0.0.0' } },
      marketplace: {
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NOT_REQUIRED',
          products: ['CODEX'],
        },
      },
      artifactDigest: options.artifactDigest ?? DIGEST_B,
      manifestDigest: options.manifestDigest ?? DIGEST_C,
    }],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.remove(tempDir)
  ));
});

describe('plugin release workflow', () => {
  it('materializes beta versions only in release staging and keeps the source stable', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-release-stage-'));
    tempDirs.push(repoRoot);
    await fs.copy(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'fixtures',
        'repo-template',
      ),
      repoRoot,
    );
    const sourceManifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const sourceManifest = await fs.readJson(sourceManifestPath);
    await fs.writeJson(sourceManifestPath, { ...sourceManifest, version: '0.2.0' }, { spaces: 2 });
    const outputRoot = path.join(repoRoot, 'output');
    await bundlePlugins({ repoRoot, outputRoot, buildMode: 'staging' });
    const catalogModules = { pluginStaging, bundleLayout, manifest };

    const staged = await prepareCatalogRelease({
      outputRoot,
      catalogVersion: '9.0.0-beta.1',
      channel: 'beta',
      sourceRepoRoot: repoRoot,
      catalogModules,
    });
    expect(staged.manifest.entries).toEqual([
      expect.objectContaining({ name: 'git-commit', version: '0.2.0-beta.1' }),
    ]);
    await expect(fs.readJson(sourceManifestPath)).resolves.toMatchObject({ version: '0.2.0' });

    await bundlePlugins({ repoRoot, outputRoot, buildMode: 'staging' });
    const stable = await prepareCatalogRelease({
      outputRoot,
      catalogVersion: '9.0.0',
      channel: 'latest',
      sourceRepoRoot: repoRoot,
      catalogModules,
    });
    expect(stable.manifest.entries).toEqual([
      expect.objectContaining({ name: 'git-commit', version: '0.2.0' }),
    ]);
  });

  it('reuses a beta version for identical content and increments it for changed content', () => {
    const ledger: PluginReleaseLedger = {
      schemaVersion: 1,
      records: [{
        plugin: 'ask-me',
        version: '1.1.0-beta.1',
        contentDigest: DIGEST_A,
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        channel: 'beta',
        catalogVersion: '2.0.0-beta.1',
      }],
    };
    const plugins = [createPlugin('ask-me', '1.1.0')];
    expect(resolveBetaPluginVersionOverrides({
      plugins,
      contentDigests: new Map([['ask-me', DIGEST_A]]),
      ledger,
    })).toEqual({
      'ask-me': '1.1.0-beta.1',
    });
    expect(resolveBetaPluginVersionOverrides({
      plugins,
      contentDigests: new Map([['ask-me', DIGEST_C]]),
      ledger,
    })).toEqual({
      'ask-me': '1.1.0-beta.2',
    });
  });

  it('keeps a stable version after latest publication and rejects changed content', () => {
    const ledger: PluginReleaseLedger = {
      schemaVersion: 1,
      records: [{
        plugin: 'ask-me',
        version: '1.1.0',
        contentDigest: DIGEST_A,
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        channel: 'latest',
        catalogVersion: '2.0.0',
      }],
    };
    const plugins = [createPlugin('ask-me', '1.1.0')];

    expect(resolveBetaPluginVersionOverrides({
      plugins,
      contentDigests: new Map([['ask-me', DIGEST_A]]),
      ledger,
    })).toEqual({});
    expect(() => resolveBetaPluginVersionOverrides({
      plugins,
      contentDigests: new Map([['ask-me', DIGEST_C]]),
      ledger,
    })).toThrow('Increase the source plugin version');
  });

  it('keeps a stable identity first published on beta and promotes its ledger channel on latest', () => {
    const previous: PluginReleaseLedger = {
      schemaVersion: 1,
      records: [{
        plugin: 'ask-me',
        version: '1.1.0',
        contentDigest: DIGEST_A,
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        channel: 'beta',
        catalogVersion: '2.0.0-beta.1',
      }],
    };
    expect(resolveBetaPluginVersionOverrides({
      plugins: [createPlugin('ask-me', '1.1.0')],
      contentDigests: new Map([['ask-me', DIGEST_A]]),
      ledger: previous,
    })).toEqual({});

    const promoted = appendCatalogToPluginReleaseLedger({
      previous,
      manifest: createManifest({
        version: '1.1.0',
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        catalogVersion: '2.0.0',
        channel: 'latest',
      }),
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    });
    expect(promoted.records).toEqual([
      expect.objectContaining({
        plugin: 'ask-me',
        version: '1.1.0',
        channel: 'latest',
        catalogVersion: '2.0.0',
      }),
    ]);
  });

  it('keeps latest metadata when a beta ledger enriches the same legacy identity', () => {
    const latest: PluginReleaseLedger = {
      schemaVersion: 1,
      records: [{
        plugin: 'ask-me',
        version: '1.1.0',
        contentDigest: null,
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        channel: 'latest',
        catalogVersion: '2.0.0',
      }],
    };
    const beta: PluginReleaseLedger = {
      schemaVersion: 1,
      records: [{
        plugin: 'ask-me',
        version: '1.1.0',
        contentDigest: DIGEST_A,
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        channel: 'beta',
        catalogVersion: '2.1.0-beta.1',
      }],
    };

    expect(mergePluginReleaseLedgers(latest, beta).records).toEqual([
      {
        ...latest.records[0],
        contentDigest: DIGEST_A,
      },
    ]);
  });

  it('rejects prerelease or build metadata in the source plugin version', () => {
    const ledger: PluginReleaseLedger = { schemaVersion: 1, records: [] };
    for (const version of ['1.1.0-beta.1', '1.1.0+build.1']) {
      expect(() => resolveBetaPluginVersionOverrides({
        plugins: [createPlugin('ask-me', version)],
        contentDigests: new Map([['ask-me', DIGEST_A]]),
        ledger,
      })).toThrow('expected a stable SemVer');
    }
  });

  it('rejects one plugin version that maps to different published digests', () => {
    const previous: PluginReleaseLedger = {
      schemaVersion: 1,
      records: [{
        plugin: 'ask-me',
        version: '1.1.0-beta.1',
        contentDigest: DIGEST_A,
        artifactDigest: DIGEST_A,
        manifestDigest: DIGEST_B,
        channel: 'beta',
        catalogVersion: '2.0.0-beta.1',
      }],
    };

    expect(() => appendCatalogToPluginReleaseLedger({
      previous,
      manifest: createManifest({
        version: '1.1.0-beta.1',
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
      }),
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    })).toThrow('ask-me@1.1.0-beta.1 maps to different digests');
  });

  it('rejects reuse of an older published plugin identity', () => {
    const previous: PluginReleaseLedger = {
      schemaVersion: 1,
      records: [
        {
          plugin: 'ask-me',
          version: '1.1.0',
          contentDigest: DIGEST_A,
          artifactDigest: DIGEST_B,
          manifestDigest: DIGEST_C,
          channel: 'latest',
          catalogVersion: '2.0.0',
        },
        {
          plugin: 'ask-me',
          version: '1.2.0',
          contentDigest: DIGEST_B,
          artifactDigest: DIGEST_C,
          manifestDigest: DIGEST_A,
          channel: 'latest',
          catalogVersion: '3.0.0',
        },
      ],
    };

    expect(() => appendCatalogToPluginReleaseLedger({
      previous,
      manifest: createManifest({
        version: '1.1.0',
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
      }),
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    })).toThrow('must not be lower than published 1.2.0');
  });

  it('keeps contentDigest stable when only generated manifest versions change', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-content-digest-'));
    tempDirs.push(pluginRoot);
    for (const relativePath of [
      '.agents-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ]) {
      await fs.outputJson(path.join(pluginRoot, relativePath), {
        name: 'ask-me',
        version: '1.0.0',
      });
    }
    await fs.outputFile(path.join(pluginRoot, 'README.md'), '# Ask Me\n');
    const before = await calculateCatalogEntryContentDigest(pluginRoot);

    for (const relativePath of [
      '.agents-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ]) {
      await fs.outputJson(path.join(pluginRoot, relativePath), {
        name: 'ask-me',
        version: '1.1.0-beta.1',
      });
    }

    await expect(calculateCatalogEntryContentDigest(pluginRoot)).resolves.toBe(before);
  });
});
