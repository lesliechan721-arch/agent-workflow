import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  acquireActiveMarketplaceLifecycleLease,
  acquireActiveMarketplaceRuntimeLease,
  resolveActiveMarketplaceRuntimeCoordinationRoot,
  setActiveMarketplaceLifecycleBeforeAcquireHookForTests,
} from '../../src/utils/active-marketplace-runtime-lock.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { catalogSourceCacheInternal } from '../../src/utils/catalog-source-cache.js';

describe('AW_HOME coordination aliases', () => {
  it('uses one physical coordination root and serializes aliases', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const physicalHome = path.join(isolation.env.AW_HOME!, 'physical');
    const aliasParent = isolation.layout.fixtureCwd;
    await fs.ensureDir(isolation.env.AW_HOME!);
    await fs.ensureDir(aliasParent);
    await fs.symlink(isolation.env.AW_HOME!, path.join(aliasParent, 'aw-home-alias'));
    const physicalEnv = { ...isolation.env, AW_HOME: physicalHome };
    const aliasEnv = {
      ...isolation.env,
      AW_HOME: path.join(aliasParent, 'aw-home-alias', 'physical'),
    };

    expect(resolveActiveMarketplaceRuntimeCoordinationRoot(aliasEnv))
      .toBe(resolveActiveMarketplaceRuntimeCoordinationRoot(physicalEnv));
    const cacheIdentity = `sha256:${'1'.repeat(64)}`;
    expect(catalogSourceCacheInternal.resolveCatalogSourceCacheLocation({
      sourceId: 'team',
      sourceIdentity: cacheIdentity,
      env: aliasEnv,
    }).rootDir).toBe(catalogSourceCacheInternal.resolveCatalogSourceCacheLocation({
      sourceId: 'team',
      sourceIdentity: cacheIdentity,
      env: physicalEnv,
    }).rootDir);

    const first = await acquireActiveMarketplaceLifecycleLease(physicalEnv);
    let attempted = false;
    setActiveMarketplaceLifecycleBeforeAcquireHookForTests(async () => {
      attempted = true;
    });
    const secondPromise = acquireActiveMarketplaceLifecycleLease(aliasEnv);
    await vi.waitFor(() => expect(attempted).toBe(true));
    let secondAcquired = false;
    void secondPromise.then(() => { secondAcquired = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondAcquired).toBe(false);
    await first.release();
    const second = await secondPromise;
    await second.release();
    setActiveMarketplaceLifecycleBeforeAcquireHookForTests(undefined);
  });

  it('keeps distinct homes isolated and creates an ordinary missing home', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstEnv = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'one') };
    const secondEnv = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'two') };

    expect(resolveActiveMarketplaceRuntimeCoordinationRoot(firstEnv))
      .not.toBe(resolveActiveMarketplaceRuntimeCoordinationRoot(secondEnv));
    const lease = await acquireActiveMarketplaceRuntimeLease(firstEnv);
    await lease.release();
  });

  it('rejects a symlinked coordination root without writing outside', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const env = { ...isolation.env, AW_HOME: path.join(isolation.env.AW_HOME!, 'unsafe') };
    const coordinationRoot = resolveActiveMarketplaceRuntimeCoordinationRoot(env);
    const outside = path.join(isolation.layout.fixtureCwd, 'outside');
    await fs.ensureDir(path.dirname(coordinationRoot));
    await fs.ensureDir(outside);
    await fs.symlink(outside, coordinationRoot);

    await expect(acquireActiveMarketplaceRuntimeLease(env)).rejects.toThrow('regular directory');
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
});
