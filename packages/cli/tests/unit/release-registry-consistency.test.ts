import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCatalogRegistryAdapter,
  resolveRegistryUrl,
} from '../../../../scripts/release/common.mjs';

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
    const expectedRegistryUrl = 'https://registry.example.test/team/';
    const receivedEnvs: NodeJS.ProcessEnv[] = [];
    const commandRunner = vi.fn(async () => undefined);
    const marketplace = {
      resolveCatalogPackageByDistTag: vi.fn(async (
        _packageName: string,
        _channel: string,
        env: NodeJS.ProcessEnv,
      ) => {
        receivedEnvs.push(env);
        return {
          rawManifest: { catalogVersion: '2.0.0-beta.1' },
          dispose: vi.fn(async () => undefined),
        };
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
          packageRoot,
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
    await expect(adapter.readChannelManifest('beta')).resolves.toMatchObject({ status: 'ready' });
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
});
