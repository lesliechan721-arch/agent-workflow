import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureCatalogStagePublicationBoundary } from '../../../../scripts/release/common.mjs';
import { calculateCatalogContentDigest } from '../../../../scripts/release/release-model.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import * as catalogSnapshot from '../../src/utils/catalog-snapshot.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';

const tempDirs: string[] = [];

async function createFixtureRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createSnapshot(root: string) {
  return {
    root,
    generationId: 'generation-fixture',
    outputDigest: 'output-digest-fixture',
    cliPackageRoot: path.join(root, 'packages', 'cli'),
    cliDistRoot: path.join(root, 'packages', 'cli', 'dist'),
    catalogOutputRoot: path.join(root, 'build-catalog'),
  };
}

function createInternalOutputRoot(root: string): string {
  return path.join(root, '.release', 'catalog-staging', 'catalog');
}

async function catalogRelease(snapshot: ReturnType<typeof createSnapshot>, targetVersion = '9.0.0') {
  const validation = await catalogSnapshot.validateCatalogSnapshot(snapshot.catalogOutputRoot);
  const marketplace = await fs.readJson(path.join(
    snapshot.catalogOutputRoot, '.agents', 'plugins', 'marketplace.json',
  ));
  return {
    state: 'published' as const,
    targetVersion,
    planId: `sha256:${'1'.repeat(64)}`,
    sourceHead: '2'.repeat(40),
    contentDigest: calculateCatalogContentDigest({
      schemaIdentity: { schemaVersion: 4 },
      marketplaceMetadata: {
        name: marketplace.name,
        owner: marketplace.owner,
        interface: marketplace.interface,
      },
      compatibility: validation.manifest.compatibility,
      plugins: validation.manifest.entries.map((entry) => ({
        name: entry.name,
        targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
        contentDigest: entry.contentDigest,
      })),
    }),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('stage-catalog script', () => {
  it('publishes one validated schema 4 snapshot with the explicit release version and ledger', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-');
    const snapshot = createSnapshot(root);
    const outputRoot = createInternalOutputRoot(root);
    await createCatalogSnapshotFixture(snapshot.catalogOutputRoot);
    await fs.symlink(
      '../.claude-plugin',
      path.join(snapshot.catalogOutputRoot, '.agents', 'shared-marketplace'),
    );

    const staged = await stageCatalogRelease(
      ['--catalog-version', '9.0.0-beta.4'],
      {
        snapshot,
        internalOutputRoot: outputRoot,
        catalogRelease: await catalogRelease(snapshot),
        catalogModules: { pluginStaging, catalogSnapshot },
      },
    );

    expect((await fs.readdir(outputRoot)).sort()).toEqual([
      '.agents',
      '.claude-plugin',
      'catalog-manifest.json',
      'plugin-release-ledger.json',
      'plugins',
    ]);
    expect(staged.manifest).toMatchObject({
      schemaVersion: 4,
      catalogVersion: '9.0.0-beta.4',
      channel: 'beta',
      release: { state: 'published', targetVersion: '9.0.0' },
      entries: [expect.objectContaining({
        name: 'demo',
        version: '1.0.0-beta.1',
        contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      })],
    });
    expect(staged.manifest).not.toHaveProperty('packages');
    expect(staged.releaseLedger.schemaVersion).toBe(2);
    expect(staged.releaseLedger.records).toEqual([
      expect.objectContaining({
        plugin: 'demo',
        version: '1.0.0-beta.1',
        channel: 'beta',
        catalogVersion: '9.0.0-beta.4',
        contentDigest: staged.manifest.entries[0]!.contentDigest,
      }),
    ]);
    await expect(catalogSnapshot.validateCatalogSnapshot(outputRoot)).resolves.toMatchObject({
      manifest: { catalogVersion: '9.0.0-beta.4' },
    });
    await expect(fs.readlink(path.join(outputRoot, '.agents', 'shared-marketplace')))
      .resolves.toBe('../.claude-plugin');
    await expect(fs.pathExists(path.join(outputRoot, '.catalog'))).resolves.toBe(false);
  });

  it('keeps the previous successful output and removes temporary output when staging fails', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-failure-');
    const snapshot = createSnapshot(root);
    const outputRoot = createInternalOutputRoot(root);
    await createCatalogSnapshotFixture(snapshot.catalogOutputRoot);
    await fs.outputFile(path.join(outputRoot, 'previous-marker.txt'), 'previous\n');

    await expect(stageCatalogRelease(
      ['--catalog-version', '9.0.0'],
      {
        snapshot,
        internalOutputRoot: outputRoot,
        catalogRelease: await catalogRelease(snapshot),
        catalogModules: {
          pluginStaging: {
            async stageCatalogArtifacts(options: { outputRoot: string }) {
              await fs.outputFile(path.join(options.outputRoot, 'partial.txt'), 'partial\n');
              throw new Error('fixture stage failure');
            },
          },
          catalogSnapshot,
        },
      },
    )).rejects.toThrow('fixture stage failure');

    await expect(fs.readFile(path.join(outputRoot, 'previous-marker.txt'), 'utf8'))
      .resolves.toBe('previous\n');
    expect((await fs.readdir(path.dirname(outputRoot)))
      .filter((entry) => entry.startsWith('.catalog-stage-'))).toEqual([]);
  });

  it('rejects invalid SemVer before changing the published output', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-version-');
    const snapshot = createSnapshot(root);
    const outputRoot = createInternalOutputRoot(root);
    await fs.outputFile(path.join(outputRoot, 'previous-marker.txt'), 'previous\n');

    await expect(stageCatalogRelease(
      ['--catalog-version', 'not-semver'],
      {
        snapshot,
        internalOutputRoot: outputRoot,
        catalogModules: { pluginStaging, catalogSnapshot },
      },
    )).rejects.toThrow('Expected a semver value');
    await expect(fs.readFile(path.join(outputRoot, 'previous-marker.txt'), 'utf8'))
      .resolves.toBe('previous\n');
  });

  it('rejects a regular file at the fixed publication target without changing it', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-file-');
    const snapshot = createSnapshot(root);
    const outputRoot = createInternalOutputRoot(root);
    await createCatalogSnapshotFixture(snapshot.catalogOutputRoot);
    await fs.outputFile(outputRoot, 'user material\n');

    await expect(stageCatalogRelease(
      ['--catalog-version', '9.0.0'],
      {
        snapshot,
        internalOutputRoot: outputRoot,
        catalogRelease: await catalogRelease(snapshot),
        catalogModules: { pluginStaging, catalogSnapshot },
      },
    )).rejects.toThrow('publication target must be a regular directory');
    await expect(fs.readFile(outputRoot, 'utf8')).resolves.toBe('user material\n');
  });

  it('rejects a symlinked publication parent before writing outside the boundary', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-parent-link-');
    const outsideRoot = await createFixtureRoot('aw-stage-catalog-outside-');
    const snapshot = createSnapshot(root);
    const outputRoot = createInternalOutputRoot(root);
    await createCatalogSnapshotFixture(snapshot.catalogOutputRoot);
    await fs.ensureDir(path.join(root, '.release'));
    await fs.symlink(outsideRoot, path.join(root, '.release', 'catalog-staging'), 'dir');

    await expect(stageCatalogRelease(
      ['--catalog-version', '9.0.0'],
      {
        snapshot,
        internalOutputRoot: outputRoot,
        catalogRelease: await catalogRelease(snapshot),
        catalogModules: { pluginStaging, catalogSnapshot },
      },
    )).rejects.toThrow('publication path must be a regular directory');
    await expect(fs.readdir(outsideRoot)).resolves.toEqual([]);
  });

  it('propagates publication path I/O errors instead of treating them as absence', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-io-');
    const outputRoot = createInternalOutputRoot(root);
    await fs.ensureDir(path.dirname(outputRoot));
    const ioError = Object.assign(new Error('injected catalog publication I/O failure'), {
      code: 'EIO',
    });
    const internalFileSystem = {
      ...fs,
      async lstat(candidatePath: string) {
        if (candidatePath === outputRoot) throw ioError;
        return fs.lstat(candidatePath);
      },
    };

    await expect(ensureCatalogStagePublicationBoundary(root, internalFileSystem))
      .rejects.toBe(ioError);
  });

  it('replaces an existing regular directory after the new snapshot validates', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-replace-');
    const snapshot = createSnapshot(root);
    const outputRoot = createInternalOutputRoot(root);
    await createCatalogSnapshotFixture(snapshot.catalogOutputRoot);
    await fs.outputFile(path.join(outputRoot, 'previous-marker.txt'), 'previous\n');

    await stageCatalogRelease(
      ['--catalog-version', '9.0.0'],
      {
        snapshot,
        internalOutputRoot: outputRoot,
        catalogRelease: await catalogRelease(snapshot),
        catalogModules: { pluginStaging, catalogSnapshot },
      },
    );

    await expect(fs.pathExists(path.join(outputRoot, 'previous-marker.txt'))).resolves.toBe(false);
    await expect(fs.readJson(path.join(outputRoot, 'catalog-manifest.json')))
      .resolves.toMatchObject({ catalogVersion: '9.0.0', channel: 'latest' });
  });

  it('rejects release staging without an explicit plan identity before writing output', async () => {
    const root = await createFixtureRoot('aw-stage-catalog-identity-');
    const snapshot = createSnapshot(root);
    const outputRoot = createInternalOutputRoot(root);
    await createCatalogSnapshotFixture(snapshot.catalogOutputRoot);

    await expect(stageCatalogRelease(['--catalog-version', '9.0.0'], {
      snapshot,
      internalOutputRoot: outputRoot,
      catalogModules: { pluginStaging, catalogSnapshot },
    })).rejects.toThrow('explicit catalogRelease identity');
    await expect(fs.pathExists(outputRoot)).resolves.toBe(false);
  });
});
