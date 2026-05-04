import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteCodexNativeRecoveryBreadcrumb,
  getCodexNativeRecoveryBreadcrumbPath,
  listCodexNativeRecoveryBreadcrumbs,
  readCodexNativeRecoveryBreadcrumb,
  updateCodexNativeRecoveryBreadcrumb,
  writeCodexNativeRecoveryBreadcrumb,
} from '../../src/utils/codex-native-recovery.js';

const tempDirs: string[] = [];

async function makeEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-recovery-'));
  tempDirs.push(root);
  return {
    ...process.env,
    AW_HOME: path.join(root, 'aw-home'),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('codex native recovery breadcrumbs', () => {
  it('reads breadcrumbs independently from installed.json state', async () => {
    const env = await makeEnv();
    await fs.ensureDir(env.AW_HOME!);
    await fs.writeFile(path.join(env.AW_HOME!, 'installed.json'), '{"version":', 'utf8');

    const written = await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      reason: 'native install completed',
      nativeWrittenAt: '2026-05-04T09:00:00.000Z',
      marketplacePath: '/tmp/marketplace.json',
      pluginVersion: '0.1.0',
      bundleFingerprint: 'sha256:bundle-a',
      env,
    });
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'broken',
      reason: 'should be ignored',
      env,
    });
    await fs.writeFile(
      getCodexNativeRecoveryBreadcrumbPath('broken', env),
      '{"version":',
      'utf8',
    );

    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toEqual(written);
    await expect(listCodexNativeRecoveryBreadcrumbs(env)).resolves.toEqual([written]);
  });

  it('updates breadcrumbs atomically when overwrite move fails', async () => {
    const env = await makeEnv();
    const original = await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      reason: 'native install completed',
      nativeWrittenAt: '2026-05-04T09:00:00.000Z',
      pluginVersion: '0.1.0',
      bundleFingerprint: 'sha256:bundle-a',
      env,
    });

    const moveImpl = fs.move.bind(fs);
    vi.spyOn(fs, 'move').mockImplementation(async (source, destination, options) => {
      if (
        typeof destination === 'string' &&
        destination === getCodexNativeRecoveryBreadcrumbPath('git-commit', env)
      ) {
        throw new Error('move boom');
      }
      return moveImpl(source, destination, options);
    });

    await expect(updateCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      state: 'post_check_failed',
      reason: 'post check failed',
      lastError: 'cache missing',
      env,
    })).rejects.toThrow('move boom');

    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toEqual(original);
  });

  it('keeps the breadcrumb when deletion fails before removal', async () => {
    const env = await makeEnv();
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      reason: 'native install completed',
      env,
    });

    vi.spyOn(fs, 'remove').mockImplementation(async (target) => {
      if (
        typeof target === 'string' &&
        target === getCodexNativeRecoveryBreadcrumbPath('git-commit', env)
      ) {
        throw new Error('remove boom');
      }
      return undefined;
    });

    await expect(deleteCodexNativeRecoveryBreadcrumb('git-commit', env)).rejects.toThrow('remove boom');
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toMatchObject({
      pluginId: 'git-commit@aw',
      state: 'pending_after_native_write',
    });
  });

  it('writes, updates, clears diagnostics, and deletes breadcrumbs', async () => {
    const env = await makeEnv();

    const written = await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      reason: 'native install completed',
      nativeWrittenAt: '2026-05-04T09:00:00.000Z',
      marketplacePath: '/tmp/marketplace.json',
      pluginVersion: '0.1.0',
      bundleFingerprint: 'sha256:bundle-a',
      activeCachePath: '/tmp/cache/git-commit/0.1.0',
      env,
    });

    expect(written).toMatchObject({
      pluginId: 'git-commit@aw',
      state: 'pending_after_native_write',
      reason: 'native install completed',
    });

    const updated = await updateCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      state: 'cleanup_failed',
      reason: 'cleanup failed',
      lastError: 'permission denied',
      activeCachePath: null,
      env,
    });

    expect(updated).toMatchObject({
      pluginId: 'git-commit@aw',
      state: 'cleanup_failed',
      reason: 'cleanup failed',
      lastError: 'permission denied',
      nativeWrittenAt: '2026-05-04T09:00:00.000Z',
    });
    expect(updated.activeCachePath).toBeUndefined();

    await expect(deleteCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toBe(true);
    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', env)).resolves.toBeNull();
    await expect(listCodexNativeRecoveryBreadcrumbs(env)).resolves.toEqual([]);
  });
});
