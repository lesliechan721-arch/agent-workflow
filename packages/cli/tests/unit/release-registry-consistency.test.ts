import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCatalogRegistryAdapter,
  resolveRegistryUrl,
} from '../../../../scripts/release/common.mjs';
import { execPnpmForTest } from '../helpers/pnpm.js';

const execFileAsync = promisify(execFile);

const registryEnvKeys = [
  'AW_NPM_REGISTRY_URL',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
] as const;
const originalRegistryEnv = Object.fromEntries(
  registryEnvKeys.map((key) => [key, process.env[key]]),
);
const tempRoots: string[] = [];

function setRegistryEnv(values: Partial<Record<(typeof registryEnvKeys)[number], string>>) {
  for (const key of registryEnvKeys) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function createPackageJson(registry: string | null = 'https://package.example.test/registry') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-registry-'));
  tempRoots.push(root);
  const packageJsonPath = path.join(root, 'package.json');
  await fs.writeFile(packageJsonPath, `${JSON.stringify({
    name: '@fixture/package',
    version: '1.0.0',
    ...(registry === null ? {} : { publishConfig: { registry } }),
  })}\n`);
  return { root, packageJsonPath };
}

async function createCatalogPackageFixture(
  kind: 'sidecar' | 'full',
  manifestMarker = 'candidate',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aw-release-${kind}-package-`));
  tempRoots.push(root);
  const packageJsonPath = path.join(root, 'package.json');
  await fs.writeFile(packageJsonPath, `${JSON.stringify({
    name: kind === 'sidecar' ? '@lesliechan721/aw-plugins-manifest' : '@lesliechan721/aw-plugins',
    version: '2.0.0-beta.1',
    files: ['catalog-manifest.json'],
  }, null, 2)}\n`);
  await fs.writeFile(
    path.join(root, 'catalog-manifest.json'),
    `${JSON.stringify({ schemaVersion: 2, marker: manifestMarker }, null, 2)}\n`,
  );
  return { root, packageJsonPath };
}

async function packAndUnpackPackage(packageRoot: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-packed-package-'));
  tempRoots.push(root);
  const packRoot = path.join(root, 'pack');
  const unpackRoot = path.join(root, 'unpack');
  await Promise.all([
    fs.mkdir(packRoot, { recursive: true }),
    fs.mkdir(unpackRoot, { recursive: true }),
  ]);
  await execPnpmForTest(
    ['--config.ignore-scripts=true', 'pack', '--pack-destination', packRoot],
    { cwd: packageRoot, env: process.env },
  );
  const tarballs = (await fs.readdir(packRoot)).filter((entry) => entry.endsWith('.tgz'));
  expect(tarballs).toHaveLength(1);
  const tarballPath = path.join(packRoot, tarballs[0]!);
  await execFileAsync('tar', [
    '-xzf',
    tarballPath,
    '-C',
    unpackRoot,
  ]);
  const integrity = `sha512-${crypto
    .createHash('sha512')
    .update(await fs.readFile(tarballPath))
    .digest('base64')}`;
  return {
    integrity,
    packageRoot: path.join(unpackRoot, 'package'),
    tarballPath,
  };
}

async function createPackageWithChangedTarMode(tarballPath: string) {
  const archive = gunzipSync(await fs.readFile(tarballPath));
  const targetPath = 'package/catalog-manifest.json';
  let changed = false;
  for (let offset = 0; offset + 512 <= archive.length; offset += 512) {
    const entryName = archive
      .subarray(offset, offset + 100)
      .toString('utf8')
      .replace(/\0.*$/, '');
    if (entryName !== targetPath) {
      continue;
    }
    const mode = archive
      .subarray(offset + 100, offset + 108)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim();
    expect(Number.parseInt(mode, 8)).toBe(0o644);
    archive.write('0000755\0', offset + 100, 8, 'ascii');
    archive.fill(0x20, offset + 148, offset + 156);
    let checksum = 0;
    for (let index = offset; index < offset + 512; index += 1) {
      checksum += archive[index]!;
    }
    archive.write(`${checksum.toString(8).padStart(6, '0')}\0 `, offset + 148, 8, 'ascii');
    changed = true;
    break;
  }
  expect(changed).toBe(true);
  const changedArchive = gzipSync(archive);
  const changedTarballPath = path.join(path.dirname(tarballPath), 'changed-mode.tgz');
  const changedUnpackRoot = path.join(path.dirname(tarballPath), 'changed-mode-unpack');
  await fs.writeFile(changedTarballPath, changedArchive);
  await fs.mkdir(changedUnpackRoot);
  await execFileAsync('tar', ['-xzf', changedTarballPath, '-C', changedUnpackRoot]);
  const changedStats = await fs.stat(
    path.join(changedUnpackRoot, 'package', 'catalog-manifest.json'),
  );
  expect(changedStats.mode & 0o777).toBe(0o755);
  const integrity = `sha512-${crypto
    .createHash('sha512')
    .update(changedArchive)
    .digest('base64')}`;
  return {
    integrity,
    packageRoot: path.join(changedUnpackRoot, 'package'),
  };
}

async function createPackageWithChangedTarEntryType(tarballPath: string) {
  let archive = gunzipSync(await fs.readFile(tarballPath));
  const targetPath = 'package/catalog-manifest.json';
  let changed = false;
  for (let offset = 0; offset + 512 <= archive.length; offset += 512) {
    const entryName = archive
      .subarray(offset, offset + 100)
      .toString('utf8')
      .replace(/\0.*$/, '');
    if (entryName !== targetPath) {
      continue;
    }
    expect(archive[offset + 156]).toBe(0x30);
    const size = Number.parseInt(
      archive
        .subarray(offset + 124, offset + 136)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim(),
      8,
    );
    archive.write('00000000000\0', offset + 124, 12, 'ascii');
    archive[offset + 156] = 0x32;
    archive.fill(0, offset + 157, offset + 257);
    archive.write('manifest-target.json', offset + 157, 'utf8');
    archive.fill(0x20, offset + 148, offset + 156);
    let checksum = 0;
    for (let index = offset; index < offset + 512; index += 1) {
      checksum += archive[index]!;
    }
    archive.write(`${checksum.toString(8).padStart(6, '0')}\0 `, offset + 148, 8, 'ascii');
    const nextHeaderOffset = offset + 512 + Math.ceil(size / 512) * 512;
    archive = Buffer.concat([
      archive.subarray(0, offset + 512),
      archive.subarray(nextHeaderOffset),
    ]);
    changed = true;
    break;
  }
  expect(changed).toBe(true);
  const changedArchive = gzipSync(archive);
  const changedTarballPath = path.join(path.dirname(tarballPath), 'changed-type.tgz');
  const changedUnpackRoot = path.join(path.dirname(tarballPath), 'changed-type-unpack');
  await fs.writeFile(changedTarballPath, changedArchive);
  await fs.mkdir(changedUnpackRoot);
  await execFileAsync('tar', ['-xzf', changedTarballPath, '-C', changedUnpackRoot]);
  const packageRoot = path.join(changedUnpackRoot, 'package');
  expect((await fs.lstat(
    path.join(packageRoot, 'catalog-manifest.json'),
  )).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(
    path.join(packageRoot, 'catalog-manifest.json'),
  )).toEqual(await fs.readFile(path.join(packageRoot, 'manifest-target.json')));
  const integrity = `sha512-${crypto
    .createHash('sha512')
    .update(changedArchive)
    .digest('base64')}`;
  return { integrity, packageRoot };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of registryEnvKeys) {
    const value = originalRegistryEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('release registry consistency', () => {
  it.each([
    {
      name: 'prefers AW_NPM_REGISTRY_URL over both npm registry keys',
      env: {
        AW_NPM_REGISTRY_URL: ' https://aw.example.test/team ',
        npm_config_registry: 'https://lower.example.test/',
        NPM_CONFIG_REGISTRY: 'https://upper.example.test/',
      },
      expected: 'https://aw.example.test/team/',
    },
    {
      name: 'uses AW_NPM_REGISTRY_URL when it is the only registry environment variable',
      env: {
        AW_NPM_REGISTRY_URL: 'https://aw-only.example.test',
      },
      expected: 'https://aw-only.example.test/',
    },
    {
      name: 'prefers npm_config_registry over NPM_CONFIG_REGISTRY',
      env: {
        npm_config_registry: 'https://lower.example.test/team',
        NPM_CONFIG_REGISTRY: 'https://upper.example.test/',
      },
      expected: 'https://lower.example.test/team/',
    },
    {
      name: 'uses NPM_CONFIG_REGISTRY when it is the only registry environment variable',
      env: {
        NPM_CONFIG_REGISTRY: 'https://upper-only.example.test/team',
      },
      expected: 'https://upper-only.example.test/team/',
    },
  ])('$name', async ({ env, expected }) => {
    setRegistryEnv(env);
    const { packageJsonPath } = await createPackageJson();

    await expect(resolveRegistryUrl(packageJsonPath)).resolves.toBe(expected);
  });

  it('uses the normalized snapshot publishConfig and then the npmjs default', async () => {
    setRegistryEnv({});
    const configured = await createPackageJson(' https://package.example.test/team ');
    const unconfigured = await createPackageJson(null);

    await expect(resolveRegistryUrl(configured.packageJsonPath)).resolves.toBe(
      'https://package.example.test/team/',
    );
    await expect(resolveRegistryUrl(unconfigured.packageJsonPath)).resolves.toBe(
      'https://registry.npmjs.org/',
    );
  });

  it('uses one normalized registry for verification, publish, and dist-tag updates', async () => {
    setRegistryEnv({
      AW_NPM_REGISTRY_URL: ' https://registry.example.test/team ',
      npm_config_registry: 'https://ignored-lower.example.test/',
      NPM_CONFIG_REGISTRY: 'https://ignored-upper.example.test/',
    });
    const { root: packageRoot, packageJsonPath } = await createPackageJson();
    const publishedPackage = await packAndUnpackPackage(packageRoot);
    const expectedRegistryUrl = 'https://registry.example.test/team/';
    const receivedEnvs: NodeJS.ProcessEnv[] = [];
    const commandRunner = vi.fn(async () => undefined);
    const marketplace = {
      resolveCatalogPackageIdentityByDistTag: vi.fn(async (
        _packageName: string,
        _channel: string,
        env: NodeJS.ProcessEnv,
      ) => {
        receivedEnvs.push(env);
        return { packageName: '@lesliechan721/aw-plugins-manifest', version: '2.0.0-beta.1' };
      }),
      resolveCatalogPackageIdentityByVersion: vi.fn(async (
        _packageName: string,
        _version: string,
        env: NodeJS.ProcessEnv,
      ) => {
        receivedEnvs.push(env);
        return {
          packageName: '@lesliechan721/aw-plugins',
          version: '2.0.0-beta.1',
          integrity: publishedPackage.integrity,
        };
      }),
      downloadCatalogPackageArchive: vi.fn(async (
        _identity: unknown,
        env: NodeJS.ProcessEnv,
      ) => {
        receivedEnvs.push(env);
        return {
          packageRoot: publishedPackage.packageRoot,
          dispose: vi.fn(async () => undefined),
        };
      }),
    };
    const adapter = await createCatalogRegistryAdapter({
      cliPackageJsonPath: packageJsonPath,
      marketplace,
      runCommand: commandRunner,
    });
    const context = {
      packageRoot,
      channel: 'beta',
      version: '2.0.0-beta.1',
      manifest: {},
    };

    const cliRegistryUrl = await resolveRegistryUrl(packageJsonPath);
    expect(cliRegistryUrl).toBe(expectedRegistryUrl);
    expect(adapter.registryUrl).toBe(cliRegistryUrl);
    await expect(adapter.readChannelPackageIdentity('beta')).resolves.toMatchObject({
      status: 'ready',
      version: '2.0.0-beta.1',
    });
    await expect(adapter.verifyExistingPackage('full', context)).resolves.toEqual({
      exists: true,
      verified: true,
    });
    await adapter.publishPackage('full', context);
    await adapter.ensureDistTag('full', context);

    expect(receivedEnvs).toHaveLength(3);
    for (const env of receivedEnvs) {
      expect(env).toMatchObject({
        AW_NPM_REGISTRY_URL: expectedRegistryUrl,
        npm_config_registry: expectedRegistryUrl,
        NPM_CONFIG_REGISTRY: expectedRegistryUrl,
      });
    }
    expect(receivedEnvs[1]).toBe(receivedEnvs[0]);
    expect(receivedEnvs[2]).toBe(receivedEnvs[0]);
    expect(commandRunner).toHaveBeenNthCalledWith(1, 'pnpm', [
      'publish',
      '--tag',
      'beta',
      '--registry',
      expectedRegistryUrl,
    ], {
      cwd: packageRoot,
      env: receivedEnvs[0],
    });
    expect(commandRunner).toHaveBeenNthCalledWith(2, 'npm', [
      'dist-tag',
      'add',
      '@lesliechan721/aw-plugins@2.0.0-beta.1',
      'beta',
      '--registry',
      expectedRegistryUrl,
    ], {
      env: receivedEnvs[0],
    });
  });

  it('compares the packed candidate so npm package.json normalization remains idempotent', async () => {
    const candidate = await createCatalogPackageFixture('sidecar');
    const publishedPackage = await packAndUnpackPackage(candidate.root);
    const [candidatePackageJson, publishedPackageJson] = await Promise.all([
      fs.readFile(candidate.packageJsonPath),
      fs.readFile(path.join(publishedPackage.packageRoot, 'package.json')),
    ]);
    expect(candidatePackageJson.equals(publishedPackageJson)).toBe(false);
    expect(candidatePackageJson.at(-1)).toBe(0x0a);
    expect(publishedPackageJson.at(-1)).not.toBe(0x0a);

    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
          packageName: '@lesliechan721/aw-plugins-manifest',
          version: '2.0.0-beta.1',
          integrity: publishedPackage.integrity,
        })),
        downloadCatalogPackageArchive: vi.fn(async () => ({
          packageRoot: publishedPackage.packageRoot,
          dispose: vi.fn(async () => undefined),
        })),
      },
    });

    await expect(adapter.verifyExistingPackage('sidecar', {
      packageRoot: candidate.root,
      channel: 'beta',
      version: '2.0.0-beta.1',
      manifest: {},
    })).resolves.toEqual({ exists: true, verified: true });
  });

  it('ignores lifecycle scripts while packing the candidate identity', async () => {
    const candidate = await createCatalogPackageFixture('full');
    const packageJson = JSON.parse(await fs.readFile(candidate.packageJsonPath, 'utf8'));
    packageJson.scripts = {
      prepack: 'node -e "process.exit(19)"',
    };
    await fs.writeFile(candidate.packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const publishedPackage = await packAndUnpackPackage(candidate.root);
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
          packageName: '@lesliechan721/aw-plugins',
          version: '2.0.0-beta.1',
          integrity: publishedPackage.integrity,
        })),
        downloadCatalogPackageArchive: vi.fn(async () => ({
          packageRoot: publishedPackage.packageRoot,
          dispose: vi.fn(async () => undefined),
        })),
      },
    });

    await expect(adapter.verifyExistingPackage('full', {
      packageRoot: candidate.root,
      channel: 'beta',
      version: '2.0.0-beta.1',
      manifest: {},
    })).resolves.toEqual({ exists: true, verified: true });
  });

  it.each(['sidecar', 'full'] as const)(
    'rejects a real packed %s package with different content',
    async (kind) => {
      const candidate = await createCatalogPackageFixture(kind, 'candidate');
      const published = await createCatalogPackageFixture(kind, 'published-different');
      const publishedPackage = await packAndUnpackPackage(published.root);
      const adapter = await createCatalogRegistryAdapter({
        registryUrl: 'https://registry.example.test/',
        marketplace: {
          resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
            packageName: kind === 'sidecar'
              ? '@lesliechan721/aw-plugins-manifest'
              : '@lesliechan721/aw-plugins',
            version: '2.0.0-beta.1',
            integrity: publishedPackage.integrity,
          })),
          downloadCatalogPackageArchive: vi.fn(async () => ({
            packageRoot: publishedPackage.packageRoot,
            dispose: vi.fn(async () => undefined),
          })),
        },
      });

      await expect(adapter.verifyExistingPackage(kind, {
        packageRoot: candidate.root,
        channel: 'beta',
        version: '2.0.0-beta.1',
        manifest: {},
      })).resolves.toEqual({
        exists: true,
        verified: false,
        reason: 'Packed package integrity does not match the exact registry identity.',
      });
    },
  );

  it('rejects a real packed package when only the file mode differs', async () => {
    const candidate = await createCatalogPackageFixture('sidecar');
    const publishedPackage = await packAndUnpackPackage(candidate.root);
    const publishedArchive = await createPackageWithChangedTarMode(
      publishedPackage.tarballPath,
    );
    const downloadCatalogPackageArchive = vi.fn(async () => ({
      packageRoot: publishedArchive.packageRoot,
      dispose: vi.fn(async () => undefined),
    }));
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
          packageName: '@lesliechan721/aw-plugins-manifest',
          version: '2.0.0-beta.1',
          integrity: publishedArchive.integrity,
        })),
        downloadCatalogPackageArchive,
      },
    });

    await expect(adapter.verifyExistingPackage('sidecar', {
      packageRoot: candidate.root,
      channel: 'beta',
      version: '2.0.0-beta.1',
      manifest: {},
    })).resolves.toEqual({
      exists: true,
      verified: false,
      reason: 'Packed package integrity does not match the exact registry identity.',
    });
    expect(downloadCatalogPackageArchive).toHaveBeenCalledOnce();
  });

  it('rejects a real packed package when a regular file becomes a symlink', async () => {
    const candidate = await createCatalogPackageFixture('full');
    const packageJson = JSON.parse(await fs.readFile(candidate.packageJsonPath, 'utf8'));
    packageJson.files.push('manifest-target.json');
    await fs.writeFile(candidate.packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await fs.copyFile(
      path.join(candidate.root, 'catalog-manifest.json'),
      path.join(candidate.root, 'manifest-target.json'),
    );
    const publishedPackage = await packAndUnpackPackage(candidate.root);
    const publishedArchive = await createPackageWithChangedTarEntryType(
      publishedPackage.tarballPath,
    );
    const downloadCatalogPackageArchive = vi.fn(async () => ({
      packageRoot: publishedArchive.packageRoot,
      dispose: vi.fn(async () => undefined),
    }));
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
          packageName: '@lesliechan721/aw-plugins',
          version: '2.0.0-beta.1',
          integrity: publishedArchive.integrity,
        })),
        downloadCatalogPackageArchive,
      },
    });

    await expect(adapter.verifyExistingPackage('full', {
      packageRoot: candidate.root,
      channel: 'beta',
      version: '2.0.0-beta.1',
      manifest: {},
    })).resolves.toEqual({
      exists: true,
      verified: false,
      reason: 'Packed package integrity does not match the exact registry identity.',
    });
    expect(downloadCatalogPackageArchive).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    '',
    'sha512-not-base64',
    `sha256-${Buffer.alloc(32).toString('base64')}`,
    `sha512-${Buffer.alloc(63).toString('base64')}`,
  ])('fails closed for missing or invalid registry integrity: %s', async (integrity) => {
    const candidate = await createCatalogPackageFixture('full');
    const downloadCatalogPackageArchive = vi.fn();
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
          packageName: '@lesliechan721/aw-plugins',
          version: '2.0.0-beta.1',
          integrity,
        })),
        downloadCatalogPackageArchive,
      },
    });

    await expect(adapter.verifyExistingPackage('full', {
      packageRoot: candidate.root,
      channel: 'beta',
      version: '2.0.0-beta.1',
      manifest: {},
    })).rejects.toThrow('has invalid or untrusted dist.integrity');
    expect(downloadCatalogPackageArchive).not.toHaveBeenCalled();
  });
});
