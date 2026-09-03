import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import {
  NativeCliError,
  setNativeCliRunnerOverrideForTests,
} from '../../src/utils/native-cli.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

describe('Catalog providers', () => {
  it('applies the full-fetch timeout range and the capped ref-probe timeout', () => {
    expect(catalogGitProviderInternal.remoteTimeout({})).toBe(180_000);
    expect(catalogGitProviderInternal.remoteTimeout({ AW_CATALOG_REMOTE_TIMEOUT_MS: '180000' }))
      .toBe(180_000);
    expect(catalogGitProviderInternal.remoteTimeout({ AW_CATALOG_REMOTE_TIMEOUT_MS: '300000' }))
      .toBe(300_000);
    expect(() => catalogGitProviderInternal.remoteTimeout({
      AW_CATALOG_REMOTE_TIMEOUT_MS: '300001',
    })).toThrow(/100\.\.300000/u);
    expect(catalogGitProviderInternal.refProbeTimeout({})).toBe(30_000);
    expect(catalogGitProviderInternal.refProbeTimeout({ AW_CATALOG_REMOTE_TIMEOUT_MS: '2500' }))
      .toBe(2_500);
    expect(catalogGitProviderInternal.refProbeTimeout({ AW_CATALOG_REMOTE_TIMEOUT_MS: '0' }))
      .toBe(0);
    expect(catalogGitProviderInternal.remoteTimeout({ AW_CATALOG_REMOTE_TIMEOUT_MS: '0' }))
      .toBe(0);
  });

  it('removes foreign repository namespaces and keeps user connection settings without prompts', () => {
    const env = catalogGitProviderInternal.gitEnvironment({
      HOME: '/isolated-home',
      SSH_AUTH_SOCK: '/auth/socket',
      GIT_DIR: '/foreign/repository',
      GIT_WORK_TREE: '/foreign/worktree',
      GIT_INDEX_FILE: '/foreign/index',
      GIT_OBJECT_DIRECTORY: '/foreign/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/foreign/alternates',
      GIT_COMMON_DIR: '/foreign/common',
      gIt_NaMeSpAcE: 'foreign',
      gIt_TeRmInAl_PrOmPt: '1',
      GiT_AsKpAsS: '/user/git-askpass-secret',
      GIT_SSH_COMMAND: 'ssh -F /user/ssh-config',
      GIT_SSH_VARIANT: 'plink',
      GIT_CONFIG_GLOBAL: '/user/gitconfig',
      gCm_InTeRaCtIvE: 'Always',
      SsH_AsKpAsS: '/user/ssh-askpass-secret',
      SsH_AsKpAsS_ReQuIrE: 'prefer',
      HTTPS_PROXY: 'http://proxy.example.invalid',
    });

    expect(env).toMatchObject({
      HOME: '/isolated-home',
      SSH_AUTH_SOCK: '/auth/socket',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -F /user/ssh-config',
      GIT_SSH_VARIANT: 'plink',
      GIT_CONFIG_GLOBAL: '/user/gitconfig',
      GCM_INTERACTIVE: 'Never',
      HTTPS_PROXY: 'http://proxy.example.invalid',
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.gIt_NaMeSpAcE).toBeUndefined();
    expect(env.GiT_AsKpAsS).toBeUndefined();
    expect(env.SsH_AsKpAsS).toBeUndefined();
    expect(env.SsH_AsKpAsS_ReQuIrE).toBeUndefined();
    expect(Object.values(env)).not.toContain('/user/git-askpass-secret');
    expect(Object.values(env)).not.toContain('/user/ssh-askpass-secret');
    expect(catalogGitProviderInternal.gitEnvironment({})).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    });
  });

  it('returns a transport-validated Path staging snapshot and removes it on cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('path-staging');
    await createCatalogSnapshotFixture(sourceRoot);

    const resolution = await catalogPathProviderInternal.resolve({
      id: 'local', type: 'path', primary: true, path: sourceRoot,
    }, { cliVersion: '1.0.0', env: isolation.env });

    expect(resolution).toMatchObject({ sourceId: 'local', transport: 'path' });
    expect(resolution.rootDir).not.toBe(sourceRoot);
    await expect(fs.pathExists(resolution.rootDir)).resolves.toBe(true);
    await resolution.cleanup();
    await expect(fs.pathExists(resolution.rootDir)).resolves.toBe(false);
  });

  it('rejects a Path snapshot that changes between the copy digests', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('path-race');
    await createCatalogSnapshotFixture(sourceRoot);
    const originalCopy = fs.copy.bind(fs);
    const copy = vi.spyOn(fs, 'copy').mockImplementation(async (...args) => {
      await originalCopy(...args);
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'changed during copy\n');
    });

    try {
      await expect(catalogPathProviderInternal.resolve({
        id: 'local', type: 'path', primary: true, path: sourceRoot,
      }, { cliVersion: '1.0.0', env: isolation.env }))
        .rejects.toThrow(/changed during snapshot copy/u);
    } finally {
      copy.mockRestore();
    }
  });

  it('materializes and validates a local Git ref without persisting a provider snapshot', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('git-source');
    const remoteRoot = fixturePath('git-remote.git');
    await createCatalogSnapshotFixture(sourceRoot);
    await execFileAsync('git', ['init'], { cwd: sourceRoot });
    await execFileAsync('git', ['add', '.'], { cwd: sourceRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'snapshot',
    ], { cwd: sourceRoot });
    await execFileAsync('git', ['init', '--bare', remoteRoot]);
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: sourceRoot });
    await execFileAsync('git', ['push', 'origin', 'HEAD:refs/heads/catalog/latest'], { cwd: sourceRoot });

    const resolution = await catalogGitProviderInternal.resolve({
      id: 'remote', type: 'git', primary: true, url: remoteRoot,
      refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
    }, { cliVersion: '1.0.0', env: isolation.env });

    expect(resolution).toMatchObject({
      sourceId: 'remote',
      requestedRef: 'refs/heads/catalog/latest',
      transport: 'git',
    });
    expect(resolution.resolvedCommit).toMatch(/^[0-9a-f]{40}$/u);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-cache'))).resolves.toBe(false);
    const stagingRoot = path.dirname(resolution.rootDir);
    await resolution.cleanup();
    await expect(fs.pathExists(stagingRoot)).resolves.toBe(false);
  });

  it('resolves a local Git ref outside a foreign parent namespace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('git-namespace-source');
    const remoteRoot = fixturePath('git-namespace-remote.git');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'default namespace\n');
    await execFileAsync('git', ['init'], { cwd: sourceRoot });
    await execFileAsync('git', ['add', '.'], { cwd: sourceRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'default namespace snapshot',
    ], { cwd: sourceRoot });
    const defaultCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRoot,
    })).stdout.trim();
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'foreign namespace\n');
    await execFileAsync('git', ['add', '.'], { cwd: sourceRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'foreign namespace snapshot',
    ], { cwd: sourceRoot });
    const foreignCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRoot,
    })).stdout.trim();
    await execFileAsync('git', ['init', '--bare', remoteRoot]);
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: sourceRoot });
    await execFileAsync('git', [
      'push', 'origin',
      `${defaultCommit}:refs/heads/catalog/latest`,
      `${foreignCommit}:refs/namespaces/foreign/refs/heads/catalog/latest`,
    ], { cwd: sourceRoot });

    const resolution = await catalogGitProviderInternal.resolve({
      id: 'remote', type: 'git', primary: true, url: remoteRoot,
      refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
    }, {
      cliVersion: '1.0.0',
      env: { ...isolation.env, GIT_NAMESPACE: 'foreign' },
    });

    expect(resolution.resolvedCommit).toBe(defaultCommit);
    expect(resolution.resolvedCommit).not.toBe(foreignCommit);
    await resolution.cleanup();
  });

  it('redacts the configured Git transport from validation diagnostics', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const remoteRoot = fixturePath('missing-secret-remote.git');

    let failure: unknown;
    try {
      await catalogGitProviderInternal.resolve({
        id: 'remote', type: 'git', primary: true, url: remoteRoot,
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }, { cliVersion: '1.0.0', env: isolation.env });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const messages: string[] = [];
    let current = failure;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join('\n')).toContain('<catalog-git-source>');
    expect(messages.join('\n')).not.toContain(remoteRoot);
  });

  it('uses insteadOf for transport while keeping identity bound to the configured URL', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('git-instead-of-source');
    const remoteRoot = fixturePath('git-instead-of-remote.git');
    const gitConfig = fixturePath('git-instead-of-config');
    const configuredUrl = 'https://catalog.example.invalid/team/catalog.git';
    await createCatalogSnapshotFixture(sourceRoot);
    await execFileAsync('git', ['init'], { cwd: sourceRoot });
    await execFileAsync('git', ['add', '.'], { cwd: sourceRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'snapshot',
    ], { cwd: sourceRoot });
    await execFileAsync('git', ['init', '--bare', remoteRoot]);
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: sourceRoot });
    await execFileAsync('git', ['push', 'origin', 'HEAD:refs/heads/catalog/latest'], { cwd: sourceRoot });
    await execFileAsync('git', [
      'config', '--file', gitConfig, `url.${remoteRoot}.insteadOf`, configuredUrl,
    ]);
    const source = {
      id: 'mirror', type: 'git', primary: true, url: configuredUrl,
      refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
    } as const;

    const resolution = await catalogGitProviderInternal.resolve(source, {
      cliVersion: '1.0.0',
      env: {
        ...isolation.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });

    expect(resolution.sourceIdentity).toBe(await calculateCatalogSourceIdentity(source));
    expect(resolution.resolvedCommit).toMatch(/^[0-9a-f]{40}$/u);
    await resolution.cleanup();
  });

  it('redacts an effective URL selected by insteadOf', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const gitConfig = fixturePath('git-secret-rewrite-config');
    const configuredUrl = 'https://catalog.example.invalid/team/catalog.git';
    const effectiveUrl = 'https://user:effective-secret@example.invalid/mirror.git';
    await execFileAsync('git', [
      'config', '--file', gitConfig, `url.${effectiveUrl}.insteadOf`, configuredUrl,
    ]);

    let failure: unknown;
    try {
      await catalogGitProviderInternal.resolve({
        id: 'remote', type: 'git', primary: true, url: configuredUrl,
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }, {
        cliVersion: '1.0.0',
        env: {
          ...isolation.env,
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const messages: string[] = [];
    let current = failure;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    const rendered = messages.join('\n');
    expect(rendered).not.toContain(effectiveUrl);
    expect(rendered).not.toContain('effective-secret');
  });

  it('rejects embedded Git credentials before transport access', async () => {
    await expect(catalogGitProviderInternal.resolve({
      id: 'remote', type: 'git', primary: true,
      url: 'https://user:secret@example.invalid/catalog.git',
      refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
    }, { cliVersion: '1.0.0', env: getCurrentSourceTestIsolation().env }))
      .rejects.toThrow(/embedded credentials are not allowed/u);
  });

  it('reports unconfirmed process cleanup as the current failure and removes provider temp', async () => {
    const isolation = getCurrentSourceTestIsolation();
    let failure: unknown;
    setNativeCliRunnerOverrideForTests(async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: '',
        stderr: 'transport failed',
        cleanupError: new Error('cleanup unconfirmed'),
      });
    });
    try {
      await catalogGitProviderInternal.resolve({
        id: 'cleanup', type: 'git', primary: true,
        url: 'https://catalog.example.invalid/team/catalog.git',
        refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
      }, { cliVersion: '1.0.0', env: isolation.env });
    } catch (error) {
      failure = error;
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('Error');
    expect((failure as Error).message).toContain('Cannot resolve catalog Git source');
    const temporaryRoot = path.join(isolation.env.AW_HOME!, 'tmp');
    const entries = await fs.readdir(temporaryRoot);
    expect(entries.filter((entry) => entry.startsWith('catalog-git-'))).toEqual([]);
  });
});
