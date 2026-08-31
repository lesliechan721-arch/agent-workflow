import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

describe('Catalog providers', () => {
  it('keeps Git non-interactive and removes repository environment variables', () => {
    const env = catalogGitProviderInternal.gitEnvironment({
      HOME: '/isolated-home',
      SSH_AUTH_SOCK: '/auth/socket',
      GIT_DIR: '/foreign/repository',
      GIT_WORK_TREE: '/foreign/worktree',
      GIT_INDEX_FILE: '/foreign/index',
    });

    expect(env).toMatchObject({
      HOME: '/isolated-home',
      SSH_AUTH_SOCK: '/auth/socket',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toContain('-oBatchMode=yes');
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

  it('rejects embedded Git credentials before transport access', async () => {
    await expect(catalogGitProviderInternal.resolve({
      id: 'remote', type: 'git', primary: true,
      url: 'https://user:secret@example.invalid/catalog.git',
      refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
    }, { cliVersion: '1.0.0', env: getCurrentSourceTestIsolation().env }))
      .rejects.toThrow(/embedded credentials are not allowed/u);
  });
});
