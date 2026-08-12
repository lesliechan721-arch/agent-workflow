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
  createPluginDevelopmentReceipt,
  resolveBetaPluginVersionOverrides,
  type PluginDevelopmentReceipt,
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
}): CatalogManifest {
  return {
    schemaVersion: 2,
    catalogVersion: '2.0.0-beta.1',
    channel: 'beta',
    compatibility: { aw: { minVersion: '0.0.0' } },
    packages: {
      sidecar: {
        name: '@lesliechan721/aw-plugins-manifest',
        version: '2.0.0-beta.1',
        channel: 'beta',
      },
      full: {
        name: '@lesliechan721/aw-plugins',
        version: '2.0.0-beta.1',
        channel: 'beta',
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
  it('materializes beta versions only in release staging and blocks unapplied stable releases', async () => {
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
    await fs.outputJson(path.join(repoRoot, '.changes', 'plugins', 'git-change.json'), {
      schemaVersion: 1,
      plugin: 'git-commit',
      bump: 'minor',
      summary: 'Add beta behavior.',
    });
    const outputRoot = path.join(repoRoot, 'output');
    await bundlePlugins({ repoRoot, outputRoot, buildMode: 'staging' });
    const catalogModules = { pluginStaging, bundleLayout, manifest };

    await expect(prepareCatalogRelease({
      outputRoot,
      catalogVersion: '9.0.0',
      channel: 'latest',
      sourceRepoRoot: repoRoot,
      catalogModules,
    })).rejects.toThrow('unapplied plugin release intents: git-commit');

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
    await expect(fs.readJson(path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    ))).resolves.toMatchObject({ version: '0.1.0' });
  });

  it('turns release intents into one development target without changing the base version', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-release-'));
    tempDirs.push(repoRoot);
    await fs.outputJson(path.join(repoRoot, '.changes', 'plugins', 'ask-fix.json'), {
      schemaVersion: 1,
      plugin: 'ask-me',
      bump: 'patch',
      summary: 'Fix ask behavior.',
    });
    await fs.outputJson(path.join(repoRoot, '.changes', 'plugins', 'ask-feature.json'), {
      schemaVersion: 1,
      plugin: 'ask-me',
      bump: 'minor',
      summary: 'Add ask behavior.',
    });

    const receipt = await createPluginDevelopmentReceipt({
      repoRoot,
      catalogVersion: '2.0.0-beta.1',
      plugins: [createPlugin('ask-me')],
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    });

    expect(receipt.entries[0]).toMatchObject({
      name: 'ask-me',
      baseVersion: '1.0.0',
      plannedBump: 'minor',
      targetVersion: '1.1.0',
      intentFiles: ['ask-feature.json', 'ask-fix.json'],
    });
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
    const receipt: PluginDevelopmentReceipt = {
      schemaVersion: 1,
      phase: 'development',
      publishable: false,
      catalogVersion: '2.0.0-beta.2',
      gitCommit: null,
      dirty: null,
      entries: [{
        name: 'ask-me',
        baseVersion: '1.0.0',
        contentDigest: DIGEST_A,
        plannedBump: 'minor',
        targetVersion: '1.1.0',
        intentFiles: ['ask-change.json'],
      }],
    };

    expect(resolveBetaPluginVersionOverrides(receipt, ledger)).toEqual({
      'ask-me': '1.1.0-beta.1',
    });
    receipt.entries[0]!.contentDigest = DIGEST_C;
    expect(resolveBetaPluginVersionOverrides(receipt, ledger)).toEqual({
      'ask-me': '1.1.0-beta.2',
    });
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
