import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

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

    await execFileAsync(
      'pnpm',
      ['pack', '--pack-destination', sidecarPackDir],
      {
        cwd: path.join(outputRoot, '.catalog', 'sidecar'),
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    await execFileAsync(
      'pnpm',
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
});
