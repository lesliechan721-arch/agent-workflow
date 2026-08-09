import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { execPnpmForTest } from '../helpers/pnpm.js';
import {
  computeBuildOutputDigest,
  inspectBuildCache,
} from '../../../../scripts/build/build-cache.mjs';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(entryPath);
      files.push(...nested.map((file) => path.join(entry.name, file).split(path.sep).join('/')));
      continue;
    }
    files.push(entry.name);
  }
  return files.sort();
}

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

async function createSmokeTempRoot(prefix: string, source: string): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootPath);
  return registerSmokeWritableRoot(rootPath, source);
}

async function unpackSingleTarball(packDir: string, unpackDir: string): Promise<string> {
  const tarballs = (await fs.readdir(packDir)).filter((entry) => entry.endsWith('.tgz'));
  expect(tarballs).toHaveLength(1);
  await execFileAsync(
    'tar',
    ['-xzf', path.join(packDir, tarballs[0]), '-C', unpackDir],
    {
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return path.join(unpackDir, 'package');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('catalog pack smoke', () => {
  it('packs sidecar and full catalog tarballs directly from staging output', async () => {
    const root = repoRoot();
    const tempRoot = await createSmokeTempRoot(
      'aw-catalog-pack-smoke-',
      'catalog pack smoke temp root',
    );
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    const sidecarPackDir = path.join(tempRoot, 'sidecar-pack');
    const sidecarUnpackDir = path.join(tempRoot, 'sidecar-unpack');
    const fullPackDir = path.join(tempRoot, 'full-pack');
    const fullUnpackDir = path.join(tempRoot, 'full-unpack');
    registerSmokeWritableRoot(outputRoot, 'catalog pack smoke output root');
    registerSmokeWritableRoot(sidecarPackDir, 'catalog pack smoke sidecar pack root');
    registerSmokeWritableRoot(sidecarUnpackDir, 'catalog pack smoke sidecar unpack root');
    registerSmokeWritableRoot(fullPackDir, 'catalog pack smoke full pack root');
    registerSmokeWritableRoot(fullUnpackDir, 'catalog pack smoke full unpack root');

    const { bundlePlugins } = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'scripts', 'bundle-plugins.ts')).href,
    ) as {
      bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown>;
    };
    await bundlePlugins({
      repoRoot: root,
      outputRoot,
    });
    await Promise.all([
      fs.ensureDir(sidecarPackDir),
      fs.ensureDir(sidecarUnpackDir),
      fs.ensureDir(fullPackDir),
      fs.ensureDir(fullUnpackDir),
    ]);

    await execPnpmForTest(
      ['pack', '--pack-destination', sidecarPackDir],
      {
        cwd: path.join(outputRoot, '.catalog', 'sidecar'),
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    await execPnpmForTest(
      ['pack', '--pack-destination', fullPackDir],
      {
        cwd: path.join(outputRoot, '.catalog', 'full'),
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const [unpackedSidecarRoot, unpackedFullRoot] = await Promise.all([
      unpackSingleTarball(sidecarPackDir, sidecarUnpackDir),
      unpackSingleTarball(fullPackDir, fullUnpackDir),
    ]);
    const [canonicalManifestText, sidecarManifestText, fullManifestText, sidecarFiles, fullFiles] = await Promise.all([
      fs.readFile(path.join(outputRoot, '.catalog', 'catalog-manifest.json'), 'utf8'),
      fs.readFile(path.join(unpackedSidecarRoot, 'catalog-manifest.json'), 'utf8'),
      fs.readFile(path.join(unpackedFullRoot, 'catalog-manifest.json'), 'utf8'),
      listFilesRecursively(unpackedSidecarRoot),
      listFilesRecursively(unpackedFullRoot),
    ]);

    const sidecarManifest = await fs.readJson(path.join(unpackedSidecarRoot, 'catalog-manifest.json'));
    const sidecarPackageJson = await fs.readJson(path.join(unpackedSidecarRoot, 'package.json'));
    const fullPackageJson = await fs.readJson(path.join(unpackedFullRoot, 'package.json'));

    expect(sidecarFiles).toEqual(['catalog-manifest.json', 'package.json']);
    expect(sidecarManifestText).toBe(canonicalManifestText);
    expect(fullManifestText).toBe(canonicalManifestText);
    expect(sidecarManifest).toMatchObject({
      schemaVersion: 1,
      history: {
        schemaVersion: 1,
        releases: expect.arrayContaining([
          expect.objectContaining({
            catalogVersion: sidecarManifest.catalogVersion,
            minAwVersion: sidecarManifest.compatibility.aw.minVersion,
            plugins: expect.arrayContaining([
              expect.objectContaining({
                artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
              }),
            ]),
          }),
        ]),
      },
      packages: {
        sidecar: {
          name: '@yiliang/aw-plugins-manifest',
          version: sidecarManifest.catalogVersion,
        },
        full: {
          name: '@yiliang/aw-plugins',
          version: sidecarManifest.catalogVersion,
          manifestPath: './catalog-manifest.json',
        },
      },
    });
    expect(JSON.stringify(sidecarManifest)).not.toContain('dist.integrity');
    expect(JSON.stringify(sidecarManifest)).not.toContain('"catalogManifestDigest"');
    expect(fullFiles).toContain('.claude-plugin/marketplace.json');
    expect(fullFiles).toContain('.agents/plugins/marketplace.json');
    expect(fullFiles).toContain('plugins/git-commit/.agents-plugin/plugin.json');
    expect(sidecarPackageJson).toMatchObject({
      name: '@yiliang/aw-plugins-manifest',
      version: sidecarManifest.catalogVersion,
      awCatalog: {
        kind: 'sidecar',
        channel: sidecarManifest.channel,
      },
    });
    expect(fullPackageJson).toMatchObject({
      name: '@yiliang/aw-plugins',
      version: sidecarManifest.catalogVersion,
      awCatalog: {
        kind: 'full',
        channel: sidecarManifest.channel,
      },
    });
  });

  it('keeps canonical build output and its warm stamp reusable across catalog and combined release packs', async () => {
    const root = repoRoot();
    const canonicalRoot = path.join(root, 'packages', 'cli', 'plugins-dist');
    const canonicalManifestPath = path.join(canonicalRoot, '.catalog', 'catalog-manifest.json');
    const stampPath = path.join(root, '.release', 'cache', 'build-stamp.json');
    const releaseStagingRoot = path.join(root, '.release', 'catalog-staging');
    const catalogVersion = '99.0.0-beta.1';

    await execPnpmForTest(['build:ensure'], {
      cwd: root,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    await expect(inspectBuildCache(root)).resolves.toMatchObject({
      reusable: true,
      reason: 'stamp and output tree match',
    });
    const [digestBefore, manifestBefore, stampBefore] = await Promise.all([
      computeBuildOutputDigest(root),
      fs.readFile(canonicalManifestPath),
      fs.readFile(stampPath, 'utf8'),
    ]);

    const catalogPack = await execPnpmForTest([
      'run',
      'release:pack:catalog',
      '--',
      '--catalog-version',
      catalogVersion,
    ], {
      cwd: root,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });

    expect(catalogPack.stdout).not.toContain('Build cache miss');
    await expect(computeBuildOutputDigest(root)).resolves.toBe(digestBefore);
    await expect(fs.readFile(canonicalManifestPath)).resolves.toEqual(manifestBefore);
    await expect(fs.readFile(stampPath, 'utf8')).resolves.toBe(stampBefore);
    await expect(inspectBuildCache(root)).resolves.toMatchObject({ reusable: true });

    const combinedPack = await execPnpmForTest([
      'run',
      'release:pack',
      '--',
      '--catalog-version',
      catalogVersion,
    ], {
      cwd: root,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });

    expect(combinedPack.stdout).not.toContain('Build cache miss');
    await expect(computeBuildOutputDigest(root)).resolves.toBe(digestBefore);
    await expect(fs.readFile(canonicalManifestPath)).resolves.toEqual(manifestBefore);
    await expect(fs.readFile(stampPath, 'utf8')).resolves.toBe(stampBefore);
    await expect(inspectBuildCache(root)).resolves.toMatchObject({ reusable: true });

    const remainingReleaseStages = (await fs.readdir(releaseStagingRoot).catch(() => []))
      .filter((entry) => entry.startsWith('catalog-'));
    expect(remainingReleaseStages).toEqual([]);

    const [sidecarTarballs, fullTarballs] = await Promise.all([
      fs.readdir(path.join(root, '.release', 'tarballs', 'catalog', 'sidecar')),
      fs.readdir(path.join(root, '.release', 'tarballs', 'catalog', 'full')),
    ]);
    expect(sidecarTarballs.filter((entry) => entry.endsWith('.tgz'))).toHaveLength(1);
    expect(fullTarballs.filter((entry) => entry.endsWith('.tgz'))).toHaveLength(1);

    const unpackRoot = await createSmokeTempRoot(
      'aw-release-catalog-pack-smoke-',
      'release catalog pack unpack root',
    );
    const sidecarUnpackRoot = path.join(unpackRoot, 'sidecar');
    const fullUnpackRoot = path.join(unpackRoot, 'full');
    await Promise.all([
      fs.ensureDir(sidecarUnpackRoot),
      fs.ensureDir(fullUnpackRoot),
    ]);
    const [sidecarPackageRoot, fullPackageRoot] = await Promise.all([
      unpackSingleTarball(
        path.join(root, '.release', 'tarballs', 'catalog', 'sidecar'),
        sidecarUnpackRoot,
      ),
      unpackSingleTarball(
        path.join(root, '.release', 'tarballs', 'catalog', 'full'),
        fullUnpackRoot,
      ),
    ]);
    const [sidecarManifest, fullManifest, sidecarPackageJson, fullPackageJson] = await Promise.all([
      fs.readJson(path.join(sidecarPackageRoot, 'catalog-manifest.json')),
      fs.readJson(path.join(fullPackageRoot, 'catalog-manifest.json')),
      fs.readJson(path.join(sidecarPackageRoot, 'package.json')),
      fs.readJson(path.join(fullPackageRoot, 'package.json')),
    ]);
    expect(sidecarManifest).toEqual(fullManifest);
    expect(sidecarManifest).toMatchObject({
      catalogVersion,
      channel: 'beta',
    });
    expect(sidecarPackageJson).toMatchObject({
      name: '@yiliang/aw-plugins-manifest',
      version: catalogVersion,
    });
    expect(fullPackageJson).toMatchObject({
      name: '@yiliang/aw-plugins',
      version: catalogVersion,
    });
  });

  it('packs CLI and catalog from one snapshot generation during a concurrent force build', async () => {
    const root = repoRoot();
    const catalogVersion = '99.0.0-beta.2';
    const fixturePath = path.join(
      root,
      'packages',
      'cli',
      'tests',
      'fixtures',
      'release-snapshot-force.mjs',
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [fixturePath, root, catalogVersion],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 40 * 1024 * 1024,
        timeout: 90_000,
      },
    );
    const resultLine = stdout
      .split('\n')
      .find((line) => line.startsWith('SNAPSHOT_FORCE_RESULT '));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!.slice('SNAPSHOT_FORCE_RESULT '.length));
    expect(result).toMatchObject({
      catalogVersion,
      channel: 'beta',
      generationMatches: true,
      outputDigestMatches: true,
      cliBytesMatch: true,
      catalogBytesMatch: true,
      snapshotRemoved: true,
      remainingCatalogStages: 0,
      remainingForceIntents: 0,
      buildLockExists: false,
    });
  });
});
