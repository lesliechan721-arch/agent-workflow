import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import type { CatalogManifestV3, PluginMeta } from '../../src/types.js';
import { calculateCatalogEntryContentDigest } from '../../src/utils/catalog-digests.js';
import {
  appendCatalogToPluginReleaseLedger,
  mergePluginReleaseLedgers,
  resolveBetaPluginVersionOverrides,
  type PluginReleaseLedger,
  validatePluginReleaseLedger,
  validatePluginReleaseLedgerAgainstManifest,
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
}): CatalogManifestV3 {
  const catalogVersion = options.catalogVersion ?? '2.0.0-beta.1';
  const channel = options.channel ?? 'beta';
  return {
    schemaVersion: 3,
    catalogVersion,
    channel,
    compatibility: { aw: { minVersion: '0.0.0' } },
    entries: [{
      name: 'ask-me',
      version: options.version,
      description: 'Ask Me fixture',
      source: './plugins/ask-me',
      category: 'workflow',
      strict: true,
      compatibility: { aw: { minVersion: '0.0.0' } },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NOT_REQUIRED',
        products: ['CODEX'],
      },
      artifactDigest: options.artifactDigest ?? DIGEST_B,
      manifestDigest: options.manifestDigest ?? DIGEST_C,
      contentDigest: DIGEST_A,
    }],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.remove(tempDir)
  ));
});

describe('plugin release workflow', () => {
  it('stages a stable skip beside a beta publish only with matching stable history', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-mixed-plan-'));
    tempDirs.push(repoRoot);
    await fs.copy(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'repo-template',
    ), repoRoot);
    const sourceRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const secondRoot = path.join(repoRoot, 'plugins', 'git-commit-extra');
    await fs.copy(sourceRoot, secondRoot);
    const secondManifestPath = path.join(secondRoot, '.agents-plugin', 'plugin.json');
    const secondManifest = await fs.readJson(secondManifestPath);
    await fs.writeJson(secondManifestPath, {
      ...secondManifest,
      name: 'git-commit-extra',
      description: 'Extra fixture',
    }, { spaces: 2 });
    const outputRoot = path.join(repoRoot, 'output');
    await bundlePlugins({ repoRoot, outputRoot, buildMode: 'staging' });
    const stable = await pluginStaging.stageCatalogArtifacts({
      repoRoot, outputRoot, phase: 'release', catalogVersion: '1.0.0', channel: 'latest',
    });
    const stableHistory = {
      schemaVersion: 2 as const,
      records: stable.releaseLedger.records.filter((record) => record.plugin === 'git-commit'),
    };
    await bundlePlugins({ repoRoot, outputRoot, buildMode: 'staging' });
    const content = Object.fromEntries(await Promise.all(['git-commit', 'git-commit-extra'].map(async (name) => [
      name, await calculateCatalogEntryContentDigest(path.join(outputRoot, 'plugins', name)),
    ])));
    const staged = await pluginStaging.stageCatalogArtifacts({
      repoRoot,
      outputRoot,
      phase: 'release',
      catalogVersion: '1.1.0-beta.1',
      channel: 'beta',
      previousReleaseLedger: stableHistory,
      pluginVersionOverrides: {
        'git-commit': '0.1.0',
        'git-commit-extra': '0.1.0-beta.1',
      },
      pluginCandidates: [
        {
          name: 'git-commit', targetVersion: '0.1.0', candidateVersion: '0.1.0',
          contentDigest: content['git-commit'], action: 'skip',
        },
        {
          name: 'git-commit-extra', targetVersion: '0.1.0', candidateVersion: '0.1.0-beta.1',
          contentDigest: content['git-commit-extra'], action: 'publish',
        },
      ],
    });
    expect(staged.manifest.entries.map((entry) => [entry.name, entry.version])).toEqual([
      ['git-commit', '0.1.0'],
      ['git-commit-extra', '0.1.0-beta.1'],
    ]);
  });

  it('rejects the unpublished schema 1 ledger instead of mixing digest formats', () => {
    expect(() => validatePluginReleaseLedger({ schemaVersion: 1, records: [] }))
      .toThrow('expected schemaVersion 2');
  });

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
    const cliPackage = await fs.readJson(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    ));
    const developmentManifest = await fs.readJson(path.join(outputRoot, 'catalog-manifest.json'));
    expect(developmentManifest).toMatchObject({
      schemaVersion: 4,
      catalogVersion: cliPackage.version,
      channel: String(cliPackage.version).includes('-') ? 'beta' : 'latest',
      compatibility: { aw: { minVersion: '0.1.0' } },
      release: { state: 'development' },
    });
    expect(developmentManifest).not.toHaveProperty('packages');
    await expect(fs.pathExists(path.join(outputRoot, 'plugin-release-ledger.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(outputRoot, '.catalog'))).resolves.toBe(false);

    const staged = await pluginStaging.stageCatalogArtifacts({
      outputRoot,
      catalogVersion: '9.0.0-beta.1',
      channel: 'beta',
      repoRoot,
      phase: 'release',
    });
    expect(staged.manifest).toMatchObject({
      schemaVersion: 4,
      catalogVersion: '9.0.0-beta.1',
      channel: 'beta',
      compatibility: { aw: { minVersion: '0.1.0' } },
      release: { state: 'development' },
    });
    expect(staged.manifest).not.toHaveProperty('packages');
    expect(staged.manifest.entries).toEqual([
      expect.objectContaining({
        name: 'git-commit',
        version: '0.2.0-beta.1',
        contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    ]);
    await expect(fs.readJson(path.join(outputRoot, 'plugin-release-ledger.json')))
      .resolves.toEqual(staged.releaseLedger);
    await expect(fs.readJson(sourceManifestPath)).resolves.toMatchObject({ version: '0.2.0' });

    await bundlePlugins({ repoRoot, outputRoot, buildMode: 'staging' });
    const stable = await pluginStaging.stageCatalogArtifacts({
      outputRoot,
      catalogVersion: '9.0.0',
      channel: 'latest',
      repoRoot,
      phase: 'release',
    });
    expect(stable.manifest.entries).toEqual([
      expect.objectContaining({ name: 'git-commit', version: '0.2.0' }),
    ]);
  });

  it('reuses a beta version for identical content and increments it for changed content', () => {
    const ledger: PluginReleaseLedger = {
      schemaVersion: 2,
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

  it('allocates the next beta when content returns to an older beta identity', () => {
    const ledger: PluginReleaseLedger = {
      schemaVersion: 2,
      records: [
        {
          plugin: 'ask-me',
          version: '1.1.0-beta.1',
          contentDigest: DIGEST_A,
          artifactDigest: DIGEST_B,
          manifestDigest: DIGEST_C,
          channel: 'beta',
          catalogVersion: '2.0.0-beta.1',
        },
        {
          plugin: 'ask-me',
          version: '1.1.0-beta.2',
          contentDigest: DIGEST_B,
          artifactDigest: DIGEST_C,
          manifestDigest: DIGEST_A,
          channel: 'beta',
          catalogVersion: '2.0.0-beta.2',
        },
      ],
    };

    const overrides = resolveBetaPluginVersionOverrides({
      plugins: [createPlugin('ask-me', '1.1.0')],
      contentDigests: new Map([['ask-me', DIGEST_A]]),
      ledger,
    });
    expect(overrides).toEqual({
      'ask-me': '1.1.0-beta.3',
    });
    const appended = appendCatalogToPluginReleaseLedger({
      previous: ledger,
      manifest: createManifest({
        version: overrides['ask-me']!,
        catalogVersion: '2.0.0-beta.3',
      }),
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    });
    expect(appended.records.map((record) => record.version)).toEqual([
      '1.1.0-beta.1',
      '1.1.0-beta.2',
      '1.1.0-beta.3',
    ]);
  });

  it('keeps a stable version after latest publication and rejects changed content', () => {
    const ledger: PluginReleaseLedger = {
      schemaVersion: 2,
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

  it('keeps both beta and latest publication history when stable content is reused', () => {
    const previous: PluginReleaseLedger = {
      schemaVersion: 2,
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
      previous.records[0],
      expect.objectContaining({
        plugin: 'ask-me',
        version: '1.1.0',
        channel: 'latest',
        catalogVersion: '2.0.0',
      }),
    ]);
    const stableEntry = createManifest({
      version: '1.1.0',
      artifactDigest: DIGEST_B,
      manifestDigest: DIGEST_C,
      catalogVersion: '2.0.0',
      channel: 'latest',
    }).entries[0]!;
    expect(validatePluginReleaseLedgerAgainstManifest(promoted, {
      schemaVersion: 3,
      catalogVersion: '2.0.0',
      channel: 'latest',
      compatibility: { aw: { minVersion: '0.0.0' } },
      entries: [{ ...stableEntry, contentDigest: DIGEST_A }],
    })).toEqual(promoted);
  });

  it('merges identical plugin content across channel and catalog history without folding records', () => {
    const latest: PluginReleaseLedger = {
      schemaVersion: 2,
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
    const beta: PluginReleaseLedger = {
      schemaVersion: 2,
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
      beta.records[0],
      latest.records[0],
    ]);
  });

  it('keeps consecutive beta catalog history when identical content reuses one plugin version', () => {
    const first = appendCatalogToPluginReleaseLedger({
      previous: { schemaVersion: 2, records: [] },
      manifest: createManifest({
        version: '1.1.0-beta.1',
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        catalogVersion: '2.0.0-beta.1',
      }),
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    });
    const second = appendCatalogToPluginReleaseLedger({
      previous: first,
      manifest: createManifest({
        version: '1.1.0-beta.1',
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        catalogVersion: '2.0.0-beta.2',
      }),
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    });

    expect(second.records).toEqual([
      expect.objectContaining({ catalogVersion: '2.0.0-beta.1' }),
      expect.objectContaining({ catalogVersion: '2.0.0-beta.2' }),
    ]);
  });

  it('rejects digest drift for one plugin version across catalogs', () => {
    const previous: PluginReleaseLedger = {
      schemaVersion: 2,
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

    expect(() => appendCatalogToPluginReleaseLedger({
      previous,
      manifest: createManifest({
        version: '1.1.0',
        artifactDigest: DIGEST_A,
        manifestDigest: DIGEST_C,
        catalogVersion: '2.0.0',
        channel: 'latest',
      }),
      contentDigests: new Map([['ask-me', DIGEST_A]]),
    })).toThrow('ask-me@1.1.0 maps to different digests');
  });

  it('rejects inconsistent duplicate records for one complete publication key', () => {
    const record: PluginReleaseLedger['records'][number] = {
      plugin: 'ask-me',
      version: '1.1.0',
      contentDigest: DIGEST_A,
      artifactDigest: DIGEST_B,
      manifestDigest: DIGEST_C,
      channel: 'latest',
      catalogVersion: '2.0.0',
    };

    expect(() => mergePluginReleaseLedgers(
      { schemaVersion: 2, records: [record] },
      {
        schemaVersion: 2,
        records: [{ ...record, contentDigest: DIGEST_B }],
      },
    )).toThrow('publication record');
  });

  it('deduplicates byte-identical records for one complete publication key', () => {
    const record: PluginReleaseLedger['records'][number] = {
      plugin: 'ask-me',
      version: '1.1.0',
      contentDigest: DIGEST_A,
      artifactDigest: DIGEST_B,
      manifestDigest: DIGEST_C,
      channel: 'latest',
      catalogVersion: '2.0.0',
    };

    expect(mergePluginReleaseLedgers(
      { schemaVersion: 2, records: [record] },
      { schemaVersion: 2, records: [{ ...record }] },
    ).records).toEqual([record]);
  });

  it('rejects prerelease or build metadata in the source plugin version', () => {
    const ledger: PluginReleaseLedger = { schemaVersion: 2, records: [] };
    for (const version of ['1.1.0-beta.1', '1.1.0+build.1']) {
      expect(() => resolveBetaPluginVersionOverrides({
        plugins: [createPlugin('ask-me', version)],
        contentDigests: new Map([['ask-me', DIGEST_A]]),
        ledger,
      })).toThrow('expected a stable SemVer');
    }
  });

  it('rejects a release ledger that does not match the schema 4 snapshot entry', () => {
    expect(() => validatePluginReleaseLedgerAgainstManifest(
      {
        schemaVersion: 2,
        records: [{
          plugin: 'ask-me',
          version: '1.1.0',
          contentDigest: DIGEST_A,
          artifactDigest: DIGEST_B,
          manifestDigest: DIGEST_C,
          channel: 'latest',
          catalogVersion: '2.0.0',
        }],
      },
      {
        schemaVersion: 3,
        catalogVersion: '2.0.0',
        channel: 'latest',
        compatibility: { aw: { minVersion: '0.0.0' } },
        entries: [{
          ...createManifest({ version: '1.1.0', catalogVersion: '2.0.0', channel: 'latest' }).entries[0]!,
          contentDigest: DIGEST_C,
        }],
      },
    )).toThrow('does not match catalog entry ask-me@1.1.0');
  });

  it('rejects an extra publication record that claims the current catalog identity', () => {
    const manifest = {
      schemaVersion: 3 as const,
      catalogVersion: '2.0.0',
      channel: 'latest' as const,
      compatibility: { aw: { minVersion: '0.0.0' } },
      entries: [{
        ...createManifest({ version: '1.1.0', catalogVersion: '2.0.0', channel: 'latest' }).entries[0]!,
        contentDigest: DIGEST_A,
      }],
    };
    const matchingRecord: PluginReleaseLedger['records'][number] = {
      plugin: 'ask-me',
      version: '1.1.0',
      contentDigest: DIGEST_A,
      artifactDigest: DIGEST_B,
      manifestDigest: DIGEST_C,
      channel: 'latest',
      catalogVersion: '2.0.0',
    };

    expect(() => validatePluginReleaseLedgerAgainstManifest(
      {
        schemaVersion: 2,
        records: [
          matchingRecord,
          {
            ...matchingRecord,
            plugin: 'other-plugin',
            version: '3.0.0',
          },
        ],
      },
      manifest,
    )).toThrow('unexpected records for the current catalog');
  });

  it('rejects reuse of an older published plugin identity', () => {
    const previous: PluginReleaseLedger = {
      schemaVersion: 2,
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

  it('binds contentDigest only to normalized runtime tree paths and bytes', async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-content-first-'));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-content-second-'));
    tempDirs.push(firstRoot, secondRoot);
    for (const root of [firstRoot, secondRoot]) {
      await fs.outputJson(path.join(root, '.agents-plugin', 'plugin.json'), {
        name: 'ask-me',
        version: '1.0.0',
      });
      await fs.outputFile(path.join(root, 'nested', 'runtime.txt'), 'same runtime\n');
    }

    const first = await calculateCatalogEntryContentDigest(firstRoot);
    await expect(calculateCatalogEntryContentDigest(secondRoot)).resolves.toBe(first);
    await fs.outputFile(path.join(secondRoot, 'nested', 'runtime.txt'), 'changed runtime\n');
    await expect(calculateCatalogEntryContentDigest(secondRoot)).resolves.not.toBe(first);
  });

  it('allocates a new beta plugin version when only canonical Git mode changes', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-mode-beta-'));
    tempDirs.push(pluginRoot);
    const runtimePath = path.join(pluginRoot, 'runtime.sh');
    await fs.outputFile(runtimePath, '#!/bin/sh\n');
    await fs.chmod(runtimePath, 0o644);
    const firstContentDigest = await calculateCatalogEntryContentDigest(pluginRoot);
    const ledger: PluginReleaseLedger = {
      schemaVersion: 2,
      records: [{
        plugin: 'ask-me',
        version: '1.1.0-beta.1',
        contentDigest: firstContentDigest,
        artifactDigest: DIGEST_B,
        manifestDigest: DIGEST_C,
        channel: 'beta',
        catalogVersion: '2.0.0-beta.1',
      }],
    };

    await fs.chmod(runtimePath, 0o755);
    const executableContentDigest = await calculateCatalogEntryContentDigest(pluginRoot);
    expect(executableContentDigest).not.toBe(firstContentDigest);
    expect(resolveBetaPluginVersionOverrides({
      plugins: [createPlugin('ask-me', '1.1.0')],
      contentDigests: new Map([['ask-me', executableContentDigest]]),
      ledger,
    })).toEqual({ 'ask-me': '1.1.0-beta.2' });
  });
});
