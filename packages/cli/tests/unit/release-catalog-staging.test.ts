import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  catalogReleaseStagingRoot,
  combineReleaseErrors,
  createCatalogReleaseStaging,
  preflightCatalogRelease,
  publishCatalogRelease,
} from '../../../../scripts/release/common.mjs';

const tempDirs: string[] = [];
const stagingCleanups: Array<() => Promise<void>> = [];

async function createCatalogSource(): Promise<string> {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-catalog-source-'));
  tempDirs.push(sourceRoot);
  await fs.mkdir(path.join(sourceRoot, 'plugins'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'canonical-marker.txt'), 'canonical\n');
  return sourceRoot;
}

function createSnapshot(catalogOutputRoot: string) {
  return {
    root: catalogOutputRoot,
    generationId: 'generation-fixture',
    outputDigest: 'digest-fixture',
    cliPackageRoot: path.join(catalogOutputRoot, 'cli'),
    cliDistRoot: path.join(catalogOutputRoot, 'cli', 'dist'),
    catalogOutputRoot,
    cleanup: async () => undefined,
  };
}

function createManifest(catalogVersion: string, channel: 'beta' | 'latest', history?: unknown) {
  return {
    schemaVersion: 1,
    catalogVersion,
    channel,
    compatibility: { aw: { minVersion: '0.0.0' } },
    packages: {},
    entries: [],
    history: history ?? {
      schemaVersion: 1,
      channel,
      releases: [{ catalogVersion, minAwVersion: '0.0.0', plugins: [] }],
    },
  };
}

function createCatalogModules(stageRoots: string[]) {
  return {
    pluginStaging: {
      async stageCatalogArtifacts(options: {
        outputRoot: string;
        catalogVersion: string;
        channel: 'beta' | 'latest';
        history?: unknown;
      }) {
        stageRoots.push(options.outputRoot);
        const sidecarPackageRoot = path.join(options.outputRoot, '.catalog', 'sidecar');
        const fullPackageRoot = path.join(options.outputRoot, '.catalog', 'full');
        await Promise.all([
          fs.mkdir(sidecarPackageRoot, { recursive: true }),
          fs.mkdir(fullPackageRoot, { recursive: true }),
        ]);
        return {
          manifest: createManifest(options.catalogVersion, options.channel, options.history),
          canonicalManifestPath: path.join(options.outputRoot, '.catalog', 'catalog-manifest.json'),
          sidecarPackageRoot,
          fullPackageRoot,
        };
      },
    },
    bundleLayout: {
      validateBundleLayout: async () => undefined,
    },
    manifest: {
      validateCatalogManifest: (manifest: unknown) => manifest,
      compareStrictSemVer: (left: string, right: string) => left.localeCompare(right),
    },
  };
}

afterEach(async () => {
  await Promise.all(stagingCleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.rm(tempDir, { recursive: true, force: true })
  ));
});

describe('catalog release staging', () => {
  it('keeps the primary release error when cleanup also fails', () => {
    const primaryError = new Error('pack failed');
    const cleanupError = new Error('cleanup busy');
    const combined = combineReleaseErrors(
      primaryError,
      cleanupError,
      'Catalog staging cleanup also failed',
    );

    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined.errors).toEqual([primaryError, cleanupError]);
    expect(combined.cause).toBe(primaryError);
    expect(combined.message).toContain('pack failed');
    expect(combined.message).toContain('cleanup busy');
  });

  it('copies canonical catalog output into one owned release directory and cleans only that copy', async () => {
    const sourceRoot = await createCatalogSource();
    const staging = await createCatalogReleaseStaging({ sourceRoot });
    stagingCleanups.push(staging.cleanup);

    expect(path.dirname(staging.outputRoot)).toBe(catalogReleaseStagingRoot);
    expect(path.basename(staging.outputRoot)).toMatch(/^catalog-/);
    await expect(fs.readFile(path.join(staging.outputRoot, 'canonical-marker.txt'), 'utf8'))
      .resolves.toBe('canonical\n');

    await fs.writeFile(path.join(staging.outputRoot, 'canonical-marker.txt'), 'release-only\n');
    await staging.cleanup();

    await expect(fs.stat(staging.outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(sourceRoot, 'canonical-marker.txt'), 'utf8'))
      .resolves.toBe('canonical\n');
  });

  it('cleans validation-only preflight staging before it returns', async () => {
    const sourceRoot = await createCatalogSource();
    const stageRoots: string[] = [];

    const preflight = await preflightCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: '9.0.0-beta.1',
      generationId: 'generation-fixture',
      outputDigest: 'digest-fixture',
      channel: 'beta',
      targetHistoryManifest: null,
      officialHistoryManifests: { latest: null, beta: null },
      catalogModules: createCatalogModules(stageRoots),
      registry: {},
    });

    expect(preflight).toMatchObject({
      channel: 'beta',
      catalogVersion: '9.0.0-beta.1',
      packages: {
        sidecar: { name: '@yiliang/aw-plugins-manifest', version: '9.0.0-beta.1' },
        full: { name: '@yiliang/aw-plugins', version: '9.0.0-beta.1' },
      },
      staged: {
        manifest: { catalogVersion: '9.0.0-beta.1' },
      },
    });
    expect(preflight.staged).not.toHaveProperty('sidecarPackageRoot');
    expect(preflight.staged).not.toHaveProperty('fullPackageRoot');

    expect(stageRoots).toHaveLength(2);
    expect(new Set(stageRoots).size).toBe(1);
    expect(stageRoots[0]).not.toBe(sourceRoot);
    await expect(fs.stat(stageRoots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(sourceRoot, 'canonical-marker.txt'), 'utf8'))
      .resolves.toBe('canonical\n');
  });

  it('publishes both packages from release staging and cleans it after success', async () => {
    const sourceRoot = await createCatalogSource();
    const stageRoots: string[] = [];
    const publishedRoots: string[] = [];

    const published = await publishCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: '9.0.0-beta.2',
      channel: 'beta',
      targetHistoryManifest: null,
      officialHistoryManifests: { latest: null, beta: null },
      catalogModules: createCatalogModules(stageRoots),
      registry: {
        verifyExistingPackage: async () => ({ exists: false, verified: false }),
        publishPackage: async (_kind: string, context: { packageRoot: string }) => {
          publishedRoots.push(context.packageRoot);
        },
      },
    });

    expect(publishedRoots).toEqual([
      path.join(stageRoots[0]!, '.catalog', 'full'),
      path.join(stageRoots[0]!, '.catalog', 'sidecar'),
    ]);
    expect(published).toMatchObject({
      channel: 'beta',
      catalogVersion: '9.0.0-beta.2',
      generationId: 'generation-fixture',
      packages: {
        sidecar: { name: '@yiliang/aw-plugins-manifest', version: '9.0.0-beta.2' },
        full: { name: '@yiliang/aw-plugins', version: '9.0.0-beta.2' },
      },
    });
    expect(published).not.toHaveProperty('sidecarPackageRoot');
    expect(published).not.toHaveProperty('fullPackageRoot');
    expect(published.staged).not.toHaveProperty('sidecarPackageRoot');
    expect(published.staged).not.toHaveProperty('fullPackageRoot');
    expect(stageRoots[0]).not.toBe(sourceRoot);
    expect(publishedRoots.every((packageRoot) => packageRoot.startsWith(`${stageRoots[0]}${path.sep}`)))
      .toBe(true);
    await expect(fs.stat(stageRoots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(sourceRoot, 'canonical-marker.txt'), 'utf8'))
      .resolves.toBe('canonical\n');
  });

  it('cleans release staging when publish fails', async () => {
    const sourceRoot = await createCatalogSource();
    const stageRoots: string[] = [];
    let failedPackageRoot: string | undefined;
    const publishAttempts: string[] = [];

    await expect(publishCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: '9.0.0-beta.3',
      channel: 'beta',
      targetHistoryManifest: null,
      officialHistoryManifests: { latest: null, beta: null },
      catalogModules: createCatalogModules(stageRoots),
      registry: {
        verifyExistingPackage: async () => ({ exists: false, verified: false }),
        publishPackage: async (kind: string, context: { packageRoot: string }) => {
          publishAttempts.push(kind);
          failedPackageRoot = context.packageRoot;
          throw new Error('publish fixture failure');
        },
      },
    })).rejects.toThrow('Catalog full package phase failed: publish fixture failure');

    expect(failedPackageRoot).toBe(path.join(stageRoots[0]!, '.catalog', 'full'));
    expect(publishAttempts).toEqual(['full']);
    expect(stageRoots[0]).not.toBe(sourceRoot);
    await expect(fs.stat(stageRoots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(sourceRoot, 'canonical-marker.txt'), 'utf8'))
      .resolves.toBe('canonical\n');
  });
});
