import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCatalogPackageIdentityByDistTag,
  resolveCatalogPackageIdentityByVersion,
  setCatalogPackageSourceForTests,
} from '../../src/utils/marketplace.js';

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function stubRegistryMetadata(metadata: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(metadata), {
    headers: {
      'content-type': 'application/json',
    },
    status: 200,
  })));
}

const registryEnv = {
  AW_NPM_REGISTRY_URL: 'https://registry.example.test/',
};

async function writeUserNpmrc(contents: string): Promise<string> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-npmrc-home-'));
  tempDirs.push(homeDir);
  await fs.writeFile(path.join(homeDir, '.npmrc'), contents, 'utf8');
  return homeDir;
}

async function writeProjectNpmrc(contents: string): Promise<{
  projectDir: string;
  childDir: string;
}> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-npmrc-project-'));
  tempDirs.push(projectDir);
  await fs.writeFile(path.join(projectDir, 'package.json'), '{}', 'utf8');
  await fs.writeFile(path.join(projectDir, '.npmrc'), contents, 'utf8');
  const childDir = path.join(projectDir, 'nested', 'child');
  await fs.ensureDir(childDir);
  return {
    projectDir,
    childDir,
  };
}

function getFetchAuthorizationHeader(callIndex = 0): string | null {
  const fetchMock = vi.mocked(globalThis.fetch);
  const requestInit = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return new Headers(requestInit?.headers).get('authorization');
}

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllGlobals();
  setCatalogPackageSourceForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('registry catalog package identity errors', () => {
  it('reads the user npmrc auth token for registry metadata requests', async () => {
    const homeDir = await writeUserNpmrc('//registry.example.test/:_authToken=${NPM_TOKEN}\n');
    stubRegistryMetadata({
      versions: {
        '2.0.0': {
          dist: {
            integrity: 'sha512-catalog',
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      {
        ...registryEnv,
        HOME: homeDir,
        NPM_TOKEN: 'user-home-token',
      },
    )).resolves.toMatchObject({
      version: '2.0.0',
    });

    expect(getFetchAuthorizationHeader()).toBe('Bearer user-home-token');
  });

  it('reads the project npmrc auth token from the npm local prefix when running in a child directory', async () => {
    const homeDir = await writeUserNpmrc('');
    const { childDir } = await writeProjectNpmrc('//registry.example.test/:_authToken=project-prefix-token\n');
    process.chdir(childDir);
    stubRegistryMetadata({
      versions: {
        '2.0.0': {
          dist: {
            integrity: 'sha512-catalog',
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      {
        ...registryEnv,
        HOME: homeDir,
      },
    )).resolves.toMatchObject({
      version: '2.0.0',
    });

    expect(getFetchAuthorizationHeader()).toBe('Bearer project-prefix-token');
  });

  it('allows the project npmrc to clear a user npmrc auth token with an empty value', async () => {
    const homeDir = await writeUserNpmrc('//registry.example.test/:_authToken=user-home-token\n');
    const { projectDir } = await writeProjectNpmrc('//registry.example.test/:_authToken=\n');
    process.chdir(projectDir);
    stubRegistryMetadata({
      versions: {
        '2.0.0': {
          dist: {
            integrity: 'sha512-catalog',
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      {
        ...registryEnv,
        HOME: homeDir,
      },
    )).resolves.toMatchObject({
      version: '2.0.0',
    });

    expect(getFetchAuthorizationHeader()).toBeNull();
  });

  it('prefers the most specific path-scoped npmrc auth token', async () => {
    const homeDir = await writeUserNpmrc([
      '//registry.example.test/:_authToken=host-token',
      '//registry.example.test/team/:_authToken=path-token',
    ].join('\n'));
    stubRegistryMetadata({
      versions: {
        '2.0.0': {
          dist: {
            integrity: 'sha512-catalog',
            tarball: 'https://registry.example.test/team/catalog.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      {
        AW_NPM_REGISTRY_URL: 'https://registry.example.test/team/',
        HOME: homeDir,
      },
    )).resolves.toMatchObject({
      version: '2.0.0',
    });

    expect(getFetchAuthorizationHeader()).toBe('Bearer path-token');
  });

  it('distinguishes a missing exact package version from malformed version metadata', async () => {
    stubRegistryMetadata({
      versions: {
        '1.0.0': {
          dist: {
            integrity: 'sha512-old',
            tarball: 'https://registry.example.test/old.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).rejects.toThrow('Registry version 2.0.0 is missing for @yiliang/aw-plugins.');
  });

  it('keeps malformed exact package version metadata as a registry integrity error', async () => {
    stubRegistryMetadata({
      versions: {
        '2.0.0': {
          dist: {
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).rejects.toThrow('Registry metadata for @yiliang/aw-plugins@2.0.0 is missing dist.integrity or dist.tarball.');
  });

  it('treats a dist-tag pointing at missing version metadata as malformed history', async () => {
    stubRegistryMetadata({
      'dist-tags': {
        latest: '2.0.0',
      },
      versions: {},
    });

    await expect(resolveCatalogPackageIdentityByDistTag(
      '@yiliang/aw-plugins-manifest',
      'latest',
      registryEnv,
    )).rejects.toThrow('Registry version 2.0.0 is missing for @yiliang/aw-plugins-manifest.');
  });
});
