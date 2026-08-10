import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  patchPluginConfigStore,
  readPluginConfigStore,
  resolveConfigFileLockPath,
  resolvePluginConfigStorePath,
  setAtomicConfigAfterRenameHookForTests,
  setAtomicConfigBeforeRenameHookForTests,
  setConfigFileLockBeforeReleaseHookForTests,
  withConfigFileLock,
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
  setConfigFileLockBeforeReleaseHookForTests(undefined);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('plugin config atomic writes', () => {
  it('keeps the old store and removes its temp and lock when atomic commit fails', async () => {
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
    expect(await fs.pathExists(resolveConfigFileLockPath(filePath))).toBe(false);
    expect((await fs.readdir(path.dirname(filePath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
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
    expect(await fs.pathExists(resolveConfigFileLockPath(filePath))).toBe(false);
    expect((await fs.readdir(path.dirname(filePath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it('retries a post-commit lock release failure without rejecting the committed write', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'release-retry-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    const attempts: number[] = [];
    setConfigFileLockBeforeReleaseHookForTests(async (_lockPath, attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {
        throw Object.assign(new Error('injected release failure'), { code: 'EACCES' });
      }
    });

    await expect(writePluginConfigStore({ ...options, values: { committed: true } }))
      .resolves.toMatchObject({ pluginName: options.pluginName });
    expect(attempts).toEqual([1, 2]);
    const filePath = resolvePluginConfigStorePath(options);
    await expect(fs.readJson(filePath)).resolves.toEqual({ committed: true });
    expect(await fs.pathExists(resolveConfigFileLockPath(filePath))).toBe(false);

    setConfigFileLockBeforeReleaseHookForTests(undefined);
    await expect(writePluginConfigStore({ ...options, values: { next: true } }))
      .resolves.toMatchObject({ pluginName: options.pluginName });
    await expect(fs.readJson(filePath)).resolves.toEqual({ next: true });
    expect(await fs.pathExists(resolveConfigFileLockPath(filePath))).toBe(false);
  });

  it('keeps an action failure primary when lock release also fails', async () => {
    const fixture = await makeFixture();
    const filePath = path.join(fixture.root, 'failed-action.json');
    const primary = new Error('primary action failure');
    setConfigFileLockBeforeReleaseHookForTests(async () => {
      throw Object.assign(new Error('secondary release failure'), { code: 'EACCES' });
    });

    const error = await withConfigFileLock({
      filePath,
      allowedRoot: fixture.root,
      action: async () => { throw primary; },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(primary);
    expect(String((error as AggregateError).errors[1])).toContain('secondary release failure');
    expect(String(error)).toContain('Config action failed');
    expect(await fs.pathExists(filePath)).toBe(false);
    setConfigFileLockBeforeReleaseHookForTests(undefined);
    await fs.remove(resolveConfigFileLockPath(filePath));
  });

  it('serializes concurrent patches so distinct keys are not lost', async () => {
    const fixture = await makeFixture();
    const options = {
      pluginName: 'concurrent-test',
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };

    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      patchPluginConfigStore({
        ...options,
        updates: { [`key${index}`]: index },
      })));

    const store = await readPluginConfigStore(options);
    expect(store.values).toEqual(Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`key${index}`, index]),
    ));
    expect(await fs.pathExists(resolveConfigFileLockPath(store.path))).toBe(false);
    expect((await fs.readdir(path.dirname(store.path))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
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
    expect(await fs.pathExists(resolveConfigFileLockPath(filePath))).toBe(false);
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
    expect(await fs.pathExists(resolveConfigFileLockPath(filePath))).toBe(false);
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
    const originalLstat = fs.lstat.bind(fs);
    let reportSymlinkParent = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      const stats = await originalLstat(candidate);
      if (reportSymlinkParent && path.resolve(String(candidate)) === path.resolve(parentPath)) {
        const changed = Object.create(stats) as typeof stats;
        Object.defineProperty(changed, 'isSymbolicLink', { value: () => true });
        return changed;
      }
      return stats;
    });
    setAtomicConfigBeforeRenameHookForTests(async () => {
      reportSymlinkParent = true;
    });

    await expect(writePluginConfigStore({ ...options, values: { changed: true } }))
      .rejects.toThrow('symbolic link');
    await expect(fs.readJson(filePath)).resolves.toEqual({ old: true });
    expect((await fs.readdir(parentPath)).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    expect(await fs.pathExists(resolveConfigFileLockPath(filePath))).toBe(false);
  });
});
