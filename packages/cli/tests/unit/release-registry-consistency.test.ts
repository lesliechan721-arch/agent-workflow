import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
    name: kind === 'sidecar' ? '@yiliang/aw-plugins-manifest' : '@yiliang/aw-plugins',
    version: '2.0.0-beta.1',
    files: ['catalog-manifest.json'],
  }, null, 2)}\n`);
  await fs.writeFile(
    path.join(root, 'catalog-manifest.json'),
    `${JSON.stringify({ schemaVersion: 2, marker: manifestMarker }, null, 2)}\n`,
  );
  return { root, packageJsonPath };
}

async function packAndUnpackPackage(packageRoot: string): Promise<string> {
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
  await execFileAsync('tar', [
    '-xzf',
    path.join(packRoot, tarballs[0]!),
    '-C',
    unpackRoot,
  ]);
  return path.join(unpackRoot, 'package');
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
    const publishedPackageRoot = await packAndUnpackPackage(packageRoot);
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
        return { packageName: '@yiliang/aw-plugins-manifest', version: '2.0.0-beta.1' };
      }),
      resolveCatalogPackageIdentityByVersion: vi.fn(async (
        _packageName: string,
        _version: string,
        env: NodeJS.ProcessEnv,
      ) => {
        receivedEnvs.push(env);
        return { packageName: '@yiliang/aw-plugins', version: '2.0.0-beta.1' };
      }),
      downloadCatalogPackageArchive: vi.fn(async (
        _identity: unknown,
        env: NodeJS.ProcessEnv,
      ) => {
        receivedEnvs.push(env);
        return {
          packageRoot: publishedPackageRoot,
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
      '@yiliang/aw-plugins@2.0.0-beta.1',
      'beta',
      '--registry',
      expectedRegistryUrl,
    ], {
      env: receivedEnvs[0],
    });
  });

  it('compares the packed candidate so npm package.json normalization remains idempotent', async () => {
    const candidate = await createCatalogPackageFixture('sidecar');
    const publishedPackageRoot = await packAndUnpackPackage(candidate.root);
    const [candidatePackageJson, publishedPackageJson] = await Promise.all([
      fs.readFile(candidate.packageJsonPath),
      fs.readFile(path.join(publishedPackageRoot, 'package.json')),
    ]);
    expect(candidatePackageJson.equals(publishedPackageJson)).toBe(false);
    expect(candidatePackageJson.at(-1)).toBe(0x0a);
    expect(publishedPackageJson.at(-1)).not.toBe(0x0a);

    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
          packageName: '@yiliang/aw-plugins-manifest',
          version: '2.0.0-beta.1',
        })),
        downloadCatalogPackageArchive: vi.fn(async () => ({
          packageRoot: publishedPackageRoot,
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

  it.each(['sidecar', 'full'] as const)(
    'rejects a real packed %s package with different content',
    async (kind) => {
      const candidate = await createCatalogPackageFixture(kind, 'candidate');
      const published = await createCatalogPackageFixture(kind, 'published-different');
      const publishedPackageRoot = await packAndUnpackPackage(published.root);
      const adapter = await createCatalogRegistryAdapter({
        registryUrl: 'https://registry.example.test/',
        marketplace: {
          resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
            packageName: kind === 'sidecar'
              ? '@yiliang/aw-plugins-manifest'
              : '@yiliang/aw-plugins',
            version: '2.0.0-beta.1',
          })),
          downloadCatalogPackageArchive: vi.fn(async () => ({
            packageRoot: publishedPackageRoot,
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
        reason: 'File content mismatch at catalog-manifest.json.',
      });
    },
  );
});
