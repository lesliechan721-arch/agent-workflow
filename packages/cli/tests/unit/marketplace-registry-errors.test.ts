import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  downloadCatalogPackageArchive,
  resolveCatalogPackageIdentityByDistTag,
  resolveCatalogPackageIdentityByVersion,
  setCatalogPackageSourceForTests,
} from '../../src/utils/marketplace.js';
import { setNativeCliRunnerOverrideForTests } from '../../src/utils/native-cli.js';

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
  packageRelativePath = path.join('packages', 'example'),
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

  const packageDir = path.join(projectDir, packageRelativePath);
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
  setNativeCliRunnerOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('registry catalog package identity errors', () => {
  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
  ])('does not retry an HTTP %i registry response', async (status, statusText) => {
    const fetchMock = vi.fn(async () => new Response('', {
      status,
      statusText,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).rejects.toThrow(`HTTP ${status} ${statusText}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [408, 'Request Timeout'],
    [429, 'Too Many Requests'],
    [503, 'Service Unavailable'],
  ])('retries one HTTP %i registry response at most once', async (status, statusText) => {
    const metadata = {
      versions: {
        '2.0.0': {
          dist: {
            integrity: 'sha512-catalog',
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status,
        statusText,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).resolves.toMatchObject({ version: '2.0.0' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries one rejected registry fetch at most once', async () => {
    const metadata = {
      versions: {
        '2.0.0': {
          dist: {
            integrity: 'sha512-catalog',
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).resolves.toMatchObject({ version: '2.0.0' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries one rejected JSON response body at most once', async () => {
    const metadata = {
      versions: {
        '2.0.0': {
          dist: {
            integrity: 'sha512-catalog',
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    };
    const failedBodyResponse = {
      ok: true,
      json: vi.fn().mockRejectedValue(new TypeError('terminated while reading body')),
      status: 200,
      statusText: 'OK',
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failedBodyResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).resolves.toMatchObject({ version: '2.0.0' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry malformed JSON response bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the request signal is aborted', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

  it('does not depend on path.posix.matchesGlob when resolving workspace extglob npmrc roots', async () => {
    const homeDir = await writeUserNpmrc('');
    const { childDir } = await writeWorkspaceProjectNpmrc(
      '//registry.example.test/:_authToken=workspace-root-token\n',
      ['packages/@(core|cli)'],
      path.join('packages', 'cli'),
    );
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

  it('preserves brace and extglob workspace patterns when resolving the workspace root npmrc', async () => {
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

    const workspaceCases = [
      {
        workspaces: ['{packages,plugins}/*'],
        packageRelativePath: path.join('plugins', 'example'),
      },
      {
        workspaces: ['packages/@(core|cli)'],
        packageRelativePath: path.join('packages', 'cli'),
      },
    ];

    for (const [index, workspaceCase] of workspaceCases.entries()) {
      const token = `workspace-root-token-${index}`;
      const { childDir } = await writeWorkspaceProjectNpmrc(
        `//registry.example.test/:_authToken=${token}\n`,
        workspaceCase.workspaces,
        workspaceCase.packageRelativePath,
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
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
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

describe('registry catalog package archive retries and cancellation', () => {
  const archiveBytes = Buffer.from('synthetic npm archive');
  const archiveIdentity = {
    packageName: '@yiliang/aw-plugins',
    version: '2.0.0',
    integrity: `sha512-${crypto.createHash('sha512').update(archiveBytes).digest('base64')}`,
    tarballUrl: 'https://registry.example.test/catalog.tgz',
  } as const;

  it('retries one rejected archive response body at most once', async () => {
    const failedBodyResponse = {
      arrayBuffer: vi.fn().mockRejectedValue(new TypeError('terminated while reading body')),
      ok: true,
      status: 200,
      statusText: 'OK',
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failedBodyResponse)
      .mockResolvedValueOnce(new Response(archiveBytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setNativeCliRunnerOverrideForTests(async (invocation) => {
      const extractRoot = invocation.args[3];
      if (!extractRoot) {
        throw new Error('Missing tar extraction root.');
      }
      await fs.outputJson(path.join(extractRoot, 'package', 'catalog-manifest.json'), {});
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const archive = await downloadCatalogPackageArchive(
      archiveIdentity,
      {
        ...process.env,
        AW_NPM_REGISTRY_URL: 'https://registry.example.test/',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await archive.dispose();
  });

  it('passes the shared signal to tar and removes the temporary root after abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(archiveBytes, { status: 200 })));
    const controller = new AbortController();
    let markTarStarted: ((tempRoot: string) => void) | undefined;
    const tarStarted = new Promise<string>((resolve) => {
      markTarStarted = resolve;
    });
    setNativeCliRunnerOverrideForTests((invocation) => {
      expect(invocation.signal).toBe(controller.signal);
      const tarballPath = invocation.args[1];
      if (!tarballPath) {
        throw new Error('Missing tarball path.');
      }
      markTarStarted?.(path.dirname(tarballPath));
      return new Promise((_resolve, reject) => {
        invocation.signal?.addEventListener('abort', () => reject(invocation.signal?.reason), {
          once: true,
        });
      });
    });

    const archivePromise = downloadCatalogPackageArchive(
      archiveIdentity,
      {
        ...process.env,
        AW_NPM_REGISTRY_URL: 'https://registry.example.test/',
      },
      controller.signal,
    );
    const rejection = expect(archivePromise).rejects.toMatchObject({ name: 'AbortError' });
    const tempRoot = await tarStarted;

    controller.abort();

    await rejection;
    await expect(fs.pathExists(tempRoot)).resolves.toBe(false);
  });
});
