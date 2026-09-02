import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  listNamespacedPluginConfigStores,
  listPluginConfigStorePluginNames,
  patchPluginConfigStore,
  readNamespacedPluginConfigStoreIdentity,
  readPluginConfigStore,
  resetPluginConfigStore,
  resetPluginConfigStores,
  resolvePluginConfigStorePath,
  setAtomicConfigAfterRenameHookForTests,
  setAtomicConfigBeforeRenameHookForTests,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];

async function makeFixture(): Promise<{
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-config-atomic-'));
  tempDirs.push(root);
  return {
    root,
    cwd: root,
    env: { ...process.env, AW_HOME: path.join(root, 'aw-home') },
  };
}

afterEach(async () => {
  setAtomicConfigAfterRenameHookForTests(undefined);
  setAtomicConfigBeforeRenameHookForTests(undefined);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('plugin config atomic writes', () => {
  it('writes the exact schema 3 namespaced envelope without source identity', async () => {
    const fixture = await makeFixture();
    const options = {
      sourceId: 'official',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginName: 'demo',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({ ...options, values: { enabled: true } });
    await expect(fs.readJson(resolvePluginConfigStorePath(options))).resolves.toEqual({
      schemaVersion: 3,
      pluginId: 'official/demo',
      values: { enabled: true },
    });
  });

  it('reads and lists user config without creating config state', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'read-only-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await expect(readPluginConfigStore(options)).resolves.toMatchObject({
      exists: false,
      values: {},
    });
    await expect(listPluginConfigStorePluginNames({
      cwd: fixture.cwd,
      env: fixture.env,
    })).resolves.toEqual([]);
    await expect(fs.pathExists(path.join(fixture.env.AW_HOME!, 'plugin-config'))).resolves.toBe(false);
  });

  it.each([
    { mode: 'namespaced-source', segments: ['team'] },
    { mode: 'namespaced-plugin', segments: ['team', 'demo'] },
    { mode: 'legacy-plugin', segments: ['demo'] },
  ] as const)('rejects a non-directory $mode inventory node with a typed error', async ({
    mode,
    segments,
  }) => {
    const fixture = await makeFixture();
    const storeRoot = path.join(fixture.env.AW_HOME!, 'plugin-config');
    await fs.outputFile(path.join(storeRoot, ...segments), 'not a directory\n');

    const inventory = mode === 'legacy-plugin'
      ? listPluginConfigStorePluginNames({
          cwd: fixture.cwd,
          env: fixture.env,
          scope: 'user',
        })
      : listNamespacedPluginConfigStores({
          cwd: fixture.cwd,
          env: fixture.env,
          scope: 'user',
        });

    await expect(inventory).rejects.toMatchObject({ code: 'invalidPluginConfigStore' });
  });

  it('ignores valid empty config directories and plugin directories without config.json', async () => {
    const fixture = await makeFixture();
    const storeRoot = path.join(fixture.env.AW_HOME!, 'plugin-config');
    await Promise.all([
      fs.ensureDir(path.join(storeRoot, 'empty-source')),
      fs.ensureDir(path.join(storeRoot, 'team', 'demo')),
    ]);

    await expect(listNamespacedPluginConfigStores({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: 'user',
    })).resolves.toEqual([]);
    await expect(listPluginConfigStorePluginNames({
      cwd: fixture.cwd,
      env: fixture.env,
      scope: 'user',
    })).resolves.toEqual([]);
  });

  it('rejects parent and final config symlinks without reading outside the store', async () => {
    const fixture = await makeFixture();
    const options = {
      sourceId: 'official',
      sourceIdentity: `sha256:${'d'.repeat(64)}`,
      pluginName: 'symlink-read-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    const filePath = resolvePluginConfigStorePath(options);
    const outside = path.join(fixture.root, 'outside-config');
    await fs.outputJson(path.join(outside, options.pluginName, 'config.json'), {
      schemaVersion: 2,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName: options.pluginName,
      values: { secret: 'outside' },
    });
    await fs.ensureDir(path.dirname(path.dirname(filePath)));
    await fs.symlink(path.join(outside, options.pluginName), path.dirname(filePath), 'dir');

    await expect(readPluginConfigStore(options)).rejects.toThrow('symbolic link');
    await expect(readNamespacedPluginConfigStoreIdentity(options)).rejects.toThrow('symbolic link');

    await fs.remove(path.dirname(filePath));
    await fs.ensureDir(path.dirname(filePath));
    await fs.symlink(path.join(outside, options.pluginName, 'config.json'), filePath);
    await expect(readPluginConfigStore(options)).rejects.toThrow('symbolic link');
    await expect(readNamespacedPluginConfigStoreIdentity(options)).rejects.toThrow('symbolic link');
  });

  it('requires the final config read target to be a regular file', async () => {
    const fixture = await makeFixture();
    const options = {
      sourceId: 'official',
      sourceIdentity: `sha256:${'e'.repeat(64)}`,
      pluginName: 'directory-read-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    const filePath = resolvePluginConfigStorePath(options);
    await fs.ensureDir(filePath);

    await expect(readPluginConfigStore(options)).rejects.toThrow('regular file');
    await expect(readNamespacedPluginConfigStoreIdentity(options)).rejects.toThrow('regular file');
  });

  it('keeps the old store and removes its temp when atomic commit fails', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'atomic-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({ ...options, values: { old: true } });
    const filePath = resolvePluginConfigStorePath(options);
    setAtomicConfigBeforeRenameHookForTests(async () => {
      throw new Error('injected rename failure');
    });

    await expect(writePluginConfigStore({ ...options, values: { next: true } }))
      .rejects.toThrow('injected rename failure');

    await expect(fs.readJson(filePath)).resolves.toEqual({ old: true });
    expect((await fs.readdir(path.dirname(filePath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it('does not overwrite existing keys when an existence probe hides an operational error', async () => {
    const fixture = await makeFixture();
    const options = {
      sourceId: 'official',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginName: 'authoritative-read-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({
      ...options,
      values: { keep: true, change: 'before' },
    });
    const filePath = resolvePluginConfigStorePath(options);
    const originalPathExists = fs.pathExists.bind(fs);
    vi.spyOn(fs, 'pathExists').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(filePath)) return false;
      return originalPathExists(candidate);
    });

    await patchPluginConfigStore({
      ...options,
      updates: { change: 'after' },
    });

    await expect(readPluginConfigStore(options)).resolves.toMatchObject({
      exists: true,
      values: { keep: true, change: 'after' },
    });
  });

  it.each(['EPERM', 'EBUSY'])('propagates config store %s without changing existing values', async (code) => {
    const fixture = await makeFixture();
    const options = {
      sourceId: 'official',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      pluginName: 'operational-read-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({ ...options, values: { keep: true } });
    const filePath = resolvePluginConfigStorePath(options);
    const failure = Object.assign(new Error(`injected ${code}`), { code });
    const originalLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(filePath)) throw failure;
      return originalLstat(candidate);
    });

    await expect(patchPluginConfigStore({
      ...options,
      updates: { change: true },
    })).rejects.toBe(failure);
    lstat.mockRestore();
    await expect(readPluginConfigStore(options)).resolves.toMatchObject({
      values: { keep: true },
    });
  });

  it('does not reject after rename commits even when post-commit I/O fails', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'post-commit-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({ ...options, values: { old: true } });
    const filePath = resolvePluginConfigStorePath(options);
    const originalLstat = fs.lstat.bind(fs);
    const originalReadFile = fs.readFile.bind(fs);
    let rejectPostCommitIo = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      if (rejectPostCommitIo && path.resolve(String(candidate)) === path.resolve(filePath)) {
        throw Object.assign(new Error('injected post-commit lstat failure'), { code: 'EIO' });
      }
      return originalLstat(candidate);
    });
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (rejectPostCommitIo && path.resolve(String(args[0])) === path.resolve(filePath)) {
        throw Object.assign(new Error('injected post-commit read failure'), { code: 'EIO' });
      }
      return originalReadFile(...args);
    });
    setAtomicConfigAfterRenameHookForTests(async () => {
      rejectPostCommitIo = true;
      throw new Error('injected post-commit hook failure');
    });

    await expect(writePluginConfigStore({ ...options, values: { committed: true } }))
      .resolves.toMatchObject({ path: filePath });
    rejectPostCommitIo = false;
    await expect(fs.readJson(filePath)).resolves.toEqual({ committed: true });
    expect((await fs.readdir(path.dirname(filePath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it('resets through the atomic file boundary and rejects directory, symlink, and foreign stores', async () => {
    const fixture = await makeFixture();
    const base = {
      sourceId: 'official',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };

    const directoryOptions = { ...base, pluginName: 'directory-store' };
    const directoryPath = resolvePluginConfigStorePath(directoryOptions);
    await fs.ensureDir(directoryPath);
    await expect(resetPluginConfigStore(directoryOptions)).rejects.toThrow('regular file');
    await expect(fs.lstat(directoryPath)).resolves.toMatchObject({});

    const symlinkOptions = { ...base, pluginName: 'symlink-store' };
    const symlinkPath = resolvePluginConfigStorePath(symlinkOptions);
    const foreignTarget = path.join(fixture.root, 'foreign-target.json');
    await fs.outputJson(foreignTarget, { foreign: true });
    await fs.ensureDir(path.dirname(symlinkPath));
    await fs.symlink(foreignTarget, symlinkPath);
    await expect(resetPluginConfigStore(symlinkOptions)).rejects.toThrow('symbolic link');
    await expect(fs.readJson(foreignTarget)).resolves.toEqual({ foreign: true });

    const foreignOptions = { ...base, pluginName: 'foreign-store' };
    const foreignPath = resolvePluginConfigStorePath(foreignOptions);
    await fs.outputJson(foreignPath, {
      schemaVersion: 2,
      sourceId: 'someone-else',
      sourceIdentity: base.sourceIdentity,
      pluginName: foreignOptions.pluginName,
      values: { retained: true },
    });
    await expect(resetPluginConfigStore(foreignOptions)).rejects.toThrow('legacyStateUnsupported');
    await expect(fs.pathExists(foreignPath)).resolves.toBe(true);
  });

  it('validates every project store before reset and performs zero deletion on foreign state', async () => {
    const fixture = await makeFixture();
    const base = {
      sourceId: 'official',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      pluginName: 'multi-reset',
      scope: 'project' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    const sharedPath = resolvePluginConfigStorePath({ ...base, projectLayer: 'shared', access: 'write' });
    const localPath = resolvePluginConfigStorePath({ ...base, projectLayer: 'local', access: 'write' });
    await fs.outputJson(sharedPath, {
      schemaVersion: 2,
      sourceId: base.sourceId,
      sourceIdentity: base.sourceIdentity,
      pluginName: base.pluginName,
      values: { shared: true },
    });
    await fs.outputJson(localPath, {
      schemaVersion: 2,
      sourceId: base.sourceId,
      sourceIdentity: `sha256:${'c'.repeat(64)}`,
      pluginName: base.pluginName,
      values: { local: true },
    });

    await expect(resetPluginConfigStores(base)).rejects.toThrow('legacyStateUnsupported');
    await expect(fs.pathExists(sharedPath)).resolves.toBe(true);
    await expect(fs.pathExists(localPath)).resolves.toBe(true);
  });

  it('rejects target and parent symlinks without changing external files', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'symlink-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    const filePath = resolvePluginConfigStorePath(options);
    const externalTarget = path.join(fixture.root, 'external.json');
    await fs.outputFile(externalTarget, '{"external":true}\n');
    await fs.ensureDir(path.dirname(filePath));
    await fs.symlink(externalTarget, filePath);

    await expect(writePluginConfigStore({ ...options, values: { changed: true } }))
      .rejects.toThrow('symbolic link');
    await expect(fs.readFile(externalTarget, 'utf8')).resolves.toBe('{"external":true}\n');

    await fs.unlink(filePath);
    await fs.remove(path.dirname(filePath));
    const externalParent = path.join(fixture.root, 'external-parent');
    await fs.ensureDir(externalParent);
    await fs.outputFile(path.join(externalParent, 'config.json'), '{"parent":true}\n');
    await fs.symlink(externalParent, path.dirname(filePath));

    await expect(writePluginConfigStore({ ...options, values: { changed: true } }))
      .rejects.toThrow('symbolic link');
    await expect(fs.readFile(path.join(externalParent, 'config.json'), 'utf8'))
      .resolves.toBe('{"parent":true}\n');
  });

  it('revalidates a target symlink replacement immediately before rename', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'target-swap-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({ ...options, values: { old: true } });
    const filePath = resolvePluginConfigStorePath(options);
    const externalTarget = path.join(fixture.root, 'external-swap.json');
    await fs.outputFile(externalTarget, '{"external":true}\n');
    setAtomicConfigBeforeRenameHookForTests(async () => {
      await fs.unlink(filePath);
      await fs.symlink(externalTarget, filePath);
    });

    await expect(writePluginConfigStore({ ...options, values: { changed: true } }))
      .rejects.toThrow('symbolic link');
    await expect(fs.readFile(externalTarget, 'utf8')).resolves.toBe('{"external":true}\n');
    expect((await fs.readdir(path.dirname(filePath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it('revalidates parent identity immediately before rename', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'parent-swap-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({ ...options, values: { old: true } });
    const filePath = resolvePluginConfigStorePath(options);
    const parentPath = path.dirname(filePath);
    const movedParent = `${parentPath}-moved`;
    const externalParent = path.join(fixture.root, 'external-parent-swap');
    await fs.ensureDir(externalParent);
    let movedTemporaryPath = '';
    let externalSameNamePath = '';
    setAtomicConfigBeforeRenameHookForTests(async (_targetPath, temporaryPath) => {
      await fs.rename(parentPath, movedParent);
      await fs.symlink(externalParent, parentPath);
      movedTemporaryPath = path.join(movedParent, path.basename(temporaryPath));
      externalSameNamePath = path.join(externalParent, path.basename(temporaryPath));
      await fs.outputFile(externalSameNamePath, '{"external":true}\n');
    });

    await expect(writePluginConfigStore({ ...options, values: { changed: true } }))
      .rejects.toThrow('real directory');
    await expect(fs.readFile(externalSameNamePath, 'utf8')).resolves.toBe('{"external":true}\n');
    await expect(fs.pathExists(movedTemporaryPath)).resolves.toBe(true);
    await expect(fs.readJson(path.join(movedParent, 'config.json'))).resolves.toEqual({ old: true });
  });
});
