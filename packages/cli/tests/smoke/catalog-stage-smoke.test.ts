import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeBuildOutputDigest,
  inspectBuildCache,
} from '../../../../scripts/build/build-cache.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { execPnpmForTest } from '../helpers/pnpm.js';

const tempDirs: string[] = [];
const EXPECTED_PLUGINS = [
  'agent-content-toolkit',
  'agent-skill-toolkit',
  'ask-me',
  'aw-plugin-development',
  'codex-enhance',
  'dev-workflow',
  'git',
];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function createSmokeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return registerCurrentTestWritableStateRoot(root, 'catalog stage smoke temporary root');
}

async function snapshotTree(root: string): Promise<Array<{
  path: string;
  type: 'directory' | 'file' | 'missing' | 'symlink' | 'special';
  value?: string;
}>> {
  const result: Array<{
    path: string;
    type: 'directory' | 'file' | 'missing' | 'symlink' | 'special';
    value?: string;
  }> = [];
  async function visit(candidatePath: string, relativePath: string): Promise<void> {
    let stats;
    try {
      stats = await fs.lstat(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.push({ path: relativePath, type: 'missing' });
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      result.push({
        path: relativePath,
        type: 'symlink',
        value: await fs.readlink(candidatePath),
      });
      return;
    }
    if (stats.isFile()) {
      result.push({
        path: relativePath,
        type: 'file',
        value: (await fs.readFile(candidatePath)).toString('base64'),
      });
      return;
    }
    if (!stats.isDirectory()) {
      result.push({ path: relativePath, type: 'special' });
      return;
    }
    result.push({ path: relativePath, type: 'directory' });
    for (const entry of (await fs.readdir(candidatePath)).sort()) {
      await visit(path.join(candidatePath, entry), path.join(relativePath, entry));
    }
  }
  await visit(root, '.');
  return result;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('catalog stage smoke', () => {
  it('stages an explicit-version snapshot and consumes it through the local path provider', async () => {
    const root = repoRoot();
    const buildCatalogRoot = path.join(root, 'packages', 'cli', 'plugins-dist');
    const formalStageRoot = path.join(root, '.release', 'catalog-staging', 'catalog');
    const formalStageBefore = await snapshotTree(formalStageRoot);
    const isolatedStageRepo = await createSmokeTempRoot('aw-stage-output-');
    const stageRoot = path.join(
      isolatedStageRepo,
      '.release',
      'catalog-staging',
      'catalog',
    );
    const catalogVersion = '99.0.0-beta.7';

    await execPnpmForTest(['build:ensure'], {
      cwd: root,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const [buildDigestBefore, buildManifestBefore] = await Promise.all([
      computeBuildOutputDigest(root),
      fs.readFile(path.join(buildCatalogRoot, 'catalog-manifest.json')),
    ]);

    await stageCatalogRelease(
      ['--catalog-version', catalogVersion],
      { internalOutputRoot: stageRoot },
    );
    await expect(snapshotTree(formalStageRoot)).resolves.toEqual(formalStageBefore);

    const [manifest, ledger] = await Promise.all([
      fs.readJson(path.join(stageRoot, 'catalog-manifest.json')),
      fs.readJson(path.join(stageRoot, 'plugin-release-ledger.json')),
    ]);
    expect((await fs.readdir(stageRoot)).sort()).toEqual([
      '.agents',
      '.claude-plugin',
      'catalog-manifest.json',
      'plugin-release-ledger.json',
      'plugins',
    ]);
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      catalogVersion,
      channel: 'beta',
      compatibility: { aw: { minVersion: '0.1.0-beta.2' } },
    });
    expect(manifest).not.toHaveProperty('packages');
    expect(manifest.entries.map((entry: { name: string }) => entry.name).sort())
      .toEqual(EXPECTED_PLUGINS);
    expect(manifest.entries.every((entry: { contentDigest: string }) =>
      /^sha256:[0-9a-f]{64}$/u.test(entry.contentDigest))).toBe(true);
    const currentRecords = new Map(ledger.records
      .filter((record: { catalogVersion: string }) => record.catalogVersion === catalogVersion)
      .map((record: { plugin: string }) => [record.plugin, record]));
    for (const entry of manifest.entries) {
      expect(currentRecords.get(entry.name)).toMatchObject({
        plugin: entry.name,
        version: entry.version,
        artifactDigest: entry.artifactDigest,
        manifestDigest: entry.manifestDigest,
        contentDigest: entry.contentDigest,
        channel: manifest.channel,
        catalogVersion,
      });
    }
    await expect(fs.pathExists(path.join(stageRoot, '.catalog'))).resolves.toBe(false);
    expect((await fs.readdir(path.dirname(stageRoot)))
      .filter((entry) => entry.startsWith('.catalog-stage-'))).toEqual([]);

    await expect(computeBuildOutputDigest(root)).resolves.toBe(buildDigestBefore);
    await expect(fs.readFile(path.join(buildCatalogRoot, 'catalog-manifest.json')))
      .resolves.toEqual(buildManifestBefore);
    await expect(inspectBuildCache(root)).resolves.toMatchObject({ reusable: true });

    const cacheRoot = await createSmokeTempRoot('aw-stage-path-cache-');
    const providerModulePath = path.join(
      root,
      'packages',
      'cli',
      'dist',
      'src',
      'utils',
      'path-catalog-provider.js',
    );
    const { catalogPathProviderInternal } = await import(
      `${pathToFileURL(providerModulePath).href}?smoke=${Date.now()}`
    ) as {
      catalogPathProviderInternal: {
        resolve(source: Record<string, unknown>, options: Record<string, unknown>): Promise<{
          rootDir: string;
          source: string;
          manifest: { catalogVersion: string; entries: Array<{ name: string }> };
        }>;
      };
    };
    const resolved = await catalogPathProviderInternal.resolve(
      { id: 'staged', type: 'path', primary: true, path: stageRoot },
      {
        cliVersion: '99.0.0',
        freshnessPolicy: 'forceRemote',
        env: { ...process.env, AW_HOME: cacheRoot },
      },
    );
    expect(resolved).toMatchObject({
      source: 'path',
      manifest: { catalogVersion },
    });
    expect(resolved.rootDir).not.toBe(stageRoot);
    expect(resolved.manifest.entries.map((entry) => entry.name).sort()).toEqual(EXPECTED_PLUGINS);
    await expect(snapshotTree(formalStageRoot)).resolves.toEqual(formalStageBefore);
  });
});
