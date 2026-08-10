import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

function createManifest(catalogVersion: string, channel: 'beta' | 'latest') {
  return {
    schemaVersion: 2,
    catalogVersion,
    channel,
    compatibility: { aw: { minVersion: '0.0.0' } },
    packages: {
      sidecar: {
        name: '@yiliang/aw-plugins-manifest',
        version: catalogVersion,
        channel,
      },
      full: {
        name: '@yiliang/aw-plugins',
        version: catalogVersion,
        channel,
        manifestPath: './catalog-manifest.json',
      },
    },
    entries: [],
  };
}

function createCatalogModules(stageRoots: string[]) {
  return {
    pluginStaging: {
      async stageCatalogArtifacts(options: {
        outputRoot: string;
        catalogVersion: string;
        channel: 'beta' | 'latest';
      }) {
        stageRoots.push(options.outputRoot);
        const sidecarPackageRoot = path.join(options.outputRoot, '.catalog', 'sidecar');
        const fullPackageRoot = path.join(options.outputRoot, '.catalog', 'full');
        await Promise.all([
          fs.mkdir(sidecarPackageRoot, { recursive: true }),
          fs.mkdir(fullPackageRoot, { recursive: true }),
        ]);
        return {
          manifest: createManifest(options.catalogVersion, options.channel),
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
      compareStrictSemVer: (left: string, right: string) => left.localeCompare(
        right,
        undefined,
        { numeric: true },
      ),
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

    expect(stageRoots).toHaveLength(1);
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

  it('bootstraps a higher schema 2 candidate from a legacy schema 1 dist-tag without parsing its manifest', async () => {
    const sourceRoot = await createCatalogSource();
    const stageRoots: string[] = [];
    const legacyManifest = {
      schemaVersion: 1,
      history: { schemaVersion: 1, releases: [] },
    };

    await expect(preflightCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: '9.0.0-beta.2',
      channel: 'beta',
      catalogModules: createCatalogModules(stageRoots),
      registry: {
        readChannelPackageIdentity: async () => ({
          status: 'ready',
          version: '9.0.0-beta.1',
          identity: { version: '9.0.0-beta.1', legacyManifest },
        }),
        verifyExistingPackage: async () => ({ exists: false, verified: false }),
      },
    })).resolves.toMatchObject({ catalogVersion: '9.0.0-beta.2' });

    expect(stageRoots).toHaveLength(1);
  });

  it('rejects a candidate below the current dist-tag package version', async () => {
    const sourceRoot = await createCatalogSource();
    const stageRoots: string[] = [];

    await expect(preflightCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: '9.0.0-beta.1',
      channel: 'beta',
      catalogModules: createCatalogModules(stageRoots),
      registry: {
        readChannelPackageIdentity: async () => ({
          status: 'ready',
          version: '9.0.0-beta.2',
        }),
      },
    })).rejects.toThrow(
      'Catalog version 9.0.0-beta.1 must not be lower than current 9.0.0-beta.2 on beta.',
    );

    await expect(fs.stat(stageRoots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports current package identity failures without the removed history error contract', async () => {
    const sourceRoot = await createCatalogSource();

    await expect(preflightCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: '9.0.0-beta.2',
      channel: 'beta',
      catalogModules: createCatalogModules([]),
      registry: {
        readChannelPackageIdentity: async () => ({
          status: 'error',
          error: 'registry offline',
        }),
      },
    })).rejects.toThrow(
      'Unable to read current beta catalog package identity. registry offline',
    );
  });

  it('treats matching exact-version sidecar and full packages as idempotent', async () => {
    const sourceRoot = await createCatalogSource();
    const stageRoots: string[] = [];
    const verifyExistingPackage = vi.fn(async () => ({ exists: true, verified: true }));
    const publishPackage = vi.fn(async () => undefined);

    await expect(publishCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: '9.0.0-beta.2',
      channel: 'beta',
      catalogModules: createCatalogModules(stageRoots),
      registry: {
        readChannelPackageIdentity: async () => ({
          status: 'ready',
          version: '9.0.0-beta.2',
        }),
        verifyExistingPackage,
        publishPackage,
      },
    })).resolves.toMatchObject({ catalogVersion: '9.0.0-beta.2' });

    expect(verifyExistingPackage).toHaveBeenCalledTimes(4);
    expect(publishPackage).not.toHaveBeenCalled();
  });

  it.each(['sidecar', 'full'] as const)(
    'rejects different exact-version %s package bytes during preflight',
    async (differentKind) => {
      const sourceRoot = await createCatalogSource();
      const stageRoots: string[] = [];

      await expect(preflightCatalogRelease({
        snapshot: createSnapshot(sourceRoot),
        catalogVersion: '9.0.0-beta.2',
        channel: 'beta',
        catalogModules: createCatalogModules(stageRoots),
        registry: {
          readChannelPackageIdentity: async () => ({
            status: 'ready',
            version: '9.0.0-beta.2',
          }),
          verifyExistingPackage: async (kind: string) => kind === differentKind
            ? { exists: true, verified: false, reason: 'fixture bytes differ' }
            : { exists: true, verified: true },
        },
      })).rejects.toThrow(
        `Existing ${differentKind} catalog package does not match staged contents. fixture bytes differ`,
      );

      await expect(fs.stat(stageRoots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([
    { channel: 'latest' as const, version: '9.0.0-beta.1', kind: 'stable' },
    { channel: 'beta' as const, version: '9.0.0', kind: 'prerelease' },
  ])('keeps the $channel channel $kind version boundary', async ({ channel, version, kind }) => {
    const sourceRoot = await createCatalogSource();

    await expect(preflightCatalogRelease({
      snapshot: createSnapshot(sourceRoot),
      catalogVersion: version,
      channel,
      catalogModules: createCatalogModules([]),
      registry: {},
    })).rejects.toThrow(`Expected a ${kind} version`);
  });
});
