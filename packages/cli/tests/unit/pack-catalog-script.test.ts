import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

async function removeTarballs(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
    .map((entry) => fs.rm(path.join(directoryPath, entry.name), { force: true })));
}

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.rm(tempDir, { recursive: true, force: true })
  ));
});

describe('pack-catalog script', () => {
  it('waits for both pack children before removing failed-run tarballs and staging', async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-pack-catalog-failure-'));
    tempDirs.push(fixtureRoot);
    const stagingRoot = path.join(fixtureRoot, 'catalog-staging');
    const tarballRoot = path.join(fixtureRoot, 'tarballs');
    const packError = new Error('sidecar pack failed');
    let delayedReadCompleted = false;
    let cleanupObservedDelayedRead = false;

    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.writeFile(path.join(stagingRoot, 'read-me.txt'), 'staged\n');

    vi.doMock('../../../../scripts/release/common.mjs', () => ({
      cleanTarballs: vi.fn(removeTarballs),
      combineReleaseErrors: (
        primary: unknown,
        additional: unknown,
        context: string,
      ) => new AggregateError([primary, additional], context, { cause: primary }),
      createCatalogReleaseStaging: vi.fn(async () => ({
        outputRoot: stagingRoot,
        cleanup: async () => {
          cleanupObservedDelayedRead = delayedReadCompleted;
          await fs.rm(stagingRoot, { recursive: true, force: true });
        },
      })),
      loadCatalogModules: vi.fn(async () => ({ kind: 'catalog-modules' })),
      packCatalogPackage: vi.fn(async (options: {
        kind: 'sidecar' | 'full';
        destination: string;
        outputRoot: string;
      }) => {
        if (options.kind === 'sidecar') {
          throw packError;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        await fs.readFile(path.join(options.outputRoot, 'read-me.txt'), 'utf8');
        delayedReadCompleted = true;
        await fs.mkdir(options.destination, { recursive: true });
        const tarballPath = path.join(options.destination, 'late-full.tgz');
        await fs.writeFile(tarballPath, 'late tarball\n');
        return tarballPath;
      }),
      prepareCatalogRelease: vi.fn(async () => ({
        manifest: { catalogVersion: '9.0.0-beta.5', channel: 'beta' },
      })),
      relativeToRepo: (targetPath: string) => targetPath,
      tarballDir: tarballRoot,
      withReleaseBuildSnapshot: vi.fn(),
    }));

    const { packCatalogRelease } = await import(
      new URL(`../../../../scripts/release/pack-catalog.mjs?test=${Math.random()}`, import.meta.url).href
    );

    let receivedError: unknown;
    try {
      await packCatalogRelease(
        ['--catalog-version', '9.0.0-beta.5'],
        {
          snapshot: {
            root: fixtureRoot,
            generationId: 'generation-fixture',
            outputDigest: 'digest-fixture',
            cliPackageRoot: path.join(fixtureRoot, 'cli'),
            cliDistRoot: path.join(fixtureRoot, 'cli', 'dist'),
            catalogOutputRoot: fixtureRoot,
          },
        },
      );
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBe(packError);
    expect(delayedReadCompleted).toBe(true);
    expect(cleanupObservedDelayedRead).toBe(true);
    await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readdir(path.join(tarballRoot, 'catalog', 'sidecar'))).resolves.toEqual([]);
    await expect(fs.readdir(path.join(tarballRoot, 'catalog', 'full'))).resolves.toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(fs.readdir(path.join(tarballRoot, 'catalog', 'full'))).resolves.toEqual([]);
  });
});
