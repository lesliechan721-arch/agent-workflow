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

async function writeWorkspaceProjectNpmrc(
  contents: string,
  workspaces: unknown = ['packages/*'],
): Promise<{
  childDir: string;
}> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-npmrc-workspace-'));
  tempDirs.push(projectDir);
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'workspace-root',
    workspaces,
  }), 'utf8');
  await fs.writeFile(path.join(projectDir, '.npmrc'), contents, 'utf8');

  const packageDir = path.join(projectDir, 'packages', 'example');
  await fs.ensureDir(packageDir);
  await fs.writeFile(path.join(packageDir, 'package.json'), '{"name":"example"}', 'utf8');

  const childDir = path.join(packageDir, 'src');
  await fs.ensureDir(childDir);

  return {
    childDir,
  };
}

async function writeNestedWorkspaceProjectNpmrc(): Promise<{
  innerRoot: string;
  childDir: string;
}> {
  const outerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-npmrc-nested-workspace-'));
  tempDirs.push(outerRoot);
  await fs.writeFile(path.join(outerRoot, 'package.json'), JSON.stringify({
    name: 'outer-workspace-root',
    workspaces: ['projects/*'],
  }), 'utf8');
  await fs.writeFile(path.join(outerRoot, '.npmrc'), '//registry.example.test/:_authToken=outer-workspace-token\n', 'utf8');

  const innerRoot = path.join(outerRoot, 'projects', 'inner-workspace');
  await fs.ensureDir(innerRoot);
  await fs.writeFile(path.join(innerRoot, 'package.json'), JSON.stringify({
    name: 'inner-workspace-root',
    workspaces: ['packages/*'],
  }), 'utf8');
  await fs.writeFile(path.join(innerRoot, '.npmrc'), '//registry.example.test/:_authToken=inner-workspace-token\n', 'utf8');

  const packageDir = path.join(innerRoot, 'packages', 'example');
  await fs.ensureDir(packageDir);
  await fs.writeFile(path.join(packageDir, 'package.json'), '{"name":"example"}', 'utf8');

  const childDir = path.join(packageDir, 'src');
  await fs.ensureDir(childDir);

  return {
    innerRoot,
    childDir,
  };
}

async function writeProjectNpmrcWithLockfileChild(contents: string): Promise<{
  childDir: string;
}> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-npmrc-lockfile-'));
  tempDirs.push(projectDir);
  await fs.writeFile(path.join(projectDir, 'package.json'), '{}', 'utf8');
  await fs.writeFile(path.join(projectDir, '.npmrc'), contents, 'utf8');

  const childDir = path.join(projectDir, 'nested', 'child');
  await fs.ensureDir(childDir);
  await fs.writeFile(path.join(childDir, 'package-lock.json'), '{}', 'utf8');

  return {
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

  it('reads the workspace root npmrc auth token when running inside an npm workspace package', async () => {
    const homeDir = await writeUserNpmrc('');
    const { childDir } = await writeWorkspaceProjectNpmrc('//registry.example.test/:_authToken=workspace-root-token\n');
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

    expect(getFetchAuthorizationHeader()).toBe('Bearer workspace-root-token');
  });

  it('does not depend on path.posix.matchesGlob when resolving the workspace root npmrc', async () => {
    const homeDir = await writeUserNpmrc('');
    const { childDir } = await writeWorkspaceProjectNpmrc('//registry.example.test/:_authToken=workspace-root-token\n');
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

    const posixPath = path.posix as typeof path.posix & {
      matchesGlob?: typeof path.posix.matchesGlob;
    };
    const originalMatchesGlob = posixPath.matchesGlob;
    posixPath.matchesGlob = undefined;

    try {
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
    } finally {
      posixPath.matchesGlob = originalMatchesGlob;
    }

    expect(getFetchAuthorizationHeader()).toBe('Bearer workspace-root-token');
  });

  it('normalizes npm workspace patterns before resolving the workspace root npmrc', async () => {
    const homeDir = await writeUserNpmrc('');
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

    const workspaceCases: unknown[] = [
      ['./packages/*'],
      ['/packages/*'],
      ['packages/*/'],
      { packages: ['./packages/*'] },
    ];

    for (const [index, workspaces] of workspaceCases.entries()) {
      const token = `workspace-root-token-${index}`;
      const { childDir } = await writeWorkspaceProjectNpmrc(
        `//registry.example.test/:_authToken=${token}\n`,
        workspaces,
      );
      process.chdir(childDir);

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

      expect(getFetchAuthorizationHeader(index)).toBe(`Bearer ${token}`);
    }
  });

  it('stops at the first matching workspace root when resolving the project npmrc', async () => {
    const homeDir = await writeUserNpmrc('');
    const { childDir } = await writeNestedWorkspaceProjectNpmrc();
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

    expect(getFetchAuthorizationHeader()).toBe('Bearer inner-workspace-token');
  });

  it('prefers the nested workspace root npmrc when running at that root', async () => {
    const homeDir = await writeUserNpmrc('');
    const { innerRoot } = await writeNestedWorkspaceProjectNpmrc();
    process.chdir(innerRoot);
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

    expect(getFetchAuthorizationHeader()).toBe('Bearer inner-workspace-token');
  });

  it('ignores package-lock.json when resolving the project npmrc local prefix', async () => {
    const homeDir = await writeUserNpmrc('');
    const { childDir } = await writeProjectNpmrcWithLockfileChild('//registry.example.test/:_authToken=project-prefix-token\n');
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
