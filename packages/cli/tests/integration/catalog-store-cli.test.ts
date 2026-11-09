import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function setTreeTime(root: string, date: Date): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const child of await fs.readdir(root)) await setTreeTime(path.join(root, child), date);
  }
  await fs.utimes(root, date, date);
}

async function writeSnapshot(root: string, readme: string): Promise<void> {
  await fs.remove(root);
  await createCatalogSnapshotFixture(root, 'demo', [], readme);
  const markerPath = path.join(root, '.aw-generated.json');
  const marker = await fs.readJson(markerPath) as Record<string, unknown>;
  await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'catalog-store-cli-test' });
}

async function setupInactiveEntry(): Promise<{
  env: NodeJS.ProcessEnv;
  cwd: string;
  entryDir: string;
  storeKey: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const root = path.join(cwd, 'catalog-store-cli-source');
  await writeSnapshot(root, 'first\n');
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: root }] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  const first = await runCliEntry(['source', 'sync', 'local', '--json'], {
    cwd, env: isolation.env, interactive: false,
  });
  const firstActive = first.parseJsonStdout().data.active;
  const location = resolveCatalogStoreLocation({
    logicalIdentity: firstActive.logicalIdentity,
    snapshotDigest: firstActive.snapshotDigest,
    env: isolation.env,
  });
  await writeSnapshot(root, 'second\n');
  const second = await runCliEntry(['source', 'sync', 'local', '--json'], {
    cwd, env: isolation.env, interactive: false,
  });
  expect(second.exitCode, second.stderr).toBe(0);
  await setTreeTime(location.entryDir, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
  return { env: isolation.env, cwd, entryDir: location.entryDir, storeKey: location.storeKey };
}

describe('Catalog cache CLI', () => {
  it('publishes stable human/JSON status and defaults prune to a read-only dry run', async () => {
    const fixture = await setupInactiveEntry();
    const status = await runCliEntry(['cache', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode, status.stderr).toBe(0);
    const statusPayload = status.parseJsonStdout();
    expect(statusPayload).toMatchObject({
      schemaVersion: 1,
      status: 'success',
      command: 'cache.status',
      data: {
        totals: { reclaimableEntries: 1 }
      }
    });
    expect(statusPayload.data.entries).toContainEqual(expect.objectContaining({
      storeKey: fixture.storeKey, category: 'entry', status: 'reclaimable',
    }));
    expect(status.stdout).not.toContain(fixture.env.AW_HOME!);

    const human = await runCliEntry(['cache', 'status'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(fixture.storeKey);
    expect(human.stdout).toContain('reclaimable');
    expect(human.stdout).not.toContain(fixture.env.AW_HOME!);

    const dryRun = await runCliEntry(['cache', 'prune', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    const dryRunPayload = dryRun.parseJsonStdout();
    expect(dryRunPayload).toMatchObject({
      schemaVersion: 1,
      status: 'success',
      command: 'cache.prune',
      data: {
        dryRun: true,
        deleted: []
      }
    });
    expect(dryRunPayload.data.retained).toContainEqual({
      storeKey: fixture.storeKey, reason: 'inactiveOlderThan30Days',
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);

    const invalid = await runCliEntry(['cache', 'prune', '--dry-run', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: 'cache.prune',
      diagnostics: [{ code: 'invalidArguments' }],
      data: {}
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);

    const deleted = await runCliEntry(['cache', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(deleted.exitCode, deleted.stderr).toBe(0);
    expect(deleted.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      data: {
        dryRun: false,
        deleted: [{ storeKey: fixture.storeKey }]
      }
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(false);
  });

  it.each([
    ['catalog-state.json', 'catalogGenerationStateInvalid'],
    ['catalog-sources.json', 'catalogSourcesConfigInvalid'],
  ])('returns typed failed receipts and deletes nothing when %s is damaged', async (fileName, code) => {
    const fixture = await setupInactiveEntry();
    await fs.writeFile(path.join(fixture.env.AW_HOME!, fileName), '{ invalid\n');
    const status = await runCliEntry(['cache', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode).toBe(1);
    expect(status.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: 'cache.status',
      diagnostics: [{ code }],
      data: {
        entries: []
      }
    });
    const failed = await runCliEntry(['cache', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: 'cache.prune',
      diagnostics: [{ code }],
      data: {
        deleted: []
      }
    });
    expect(failed.stdout).not.toContain(fixture.env.AW_HOME!);
    expect(failed.stderr).not.toContain(fixture.env.AW_HOME!);
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);
  });

  it('uses the same stable code for status and prune store-root read failures', async () => {
    const fixture = await setupInactiveEntry();
    const storeRoot = path.join(fixture.env.AW_HOME!, 'catalog-store');
    const realReaddir = fs.readdir.bind(fs);
    const readdir = vi.spyOn(fs, 'readdir').mockImplementation((async (location, options) => {
      if (path.resolve(String(location)) === path.resolve(storeRoot)) {
        throw Object.assign(new Error(`EACCES: cannot read ${fixture.env.AW_HOME}`), {
          code: 'EACCES',
        });
      }
      return realReaddir(location, options as never);
    }) as typeof fs.readdir);
    try {
      const status = await runCliEntry(['cache', 'status', '--json'], {
        cwd: fixture.cwd, env: fixture.env, interactive: false,
      });
      const prune = await runCliEntry(['cache', 'prune', '--yes', '--json'], {
        cwd: fixture.cwd, env: fixture.env, interactive: false,
      });
      expect(status.exitCode).toBe(1);
      expect(prune.exitCode).toBe(1);
      expect(status.parseJsonStdout()).toMatchObject({
        schemaVersion: 1,
        command: 'cache.status',
        diagnostics: [{ code: 'catalogStoreInspectionFailed' }],
        data: {}
      });
      expect(prune.parseJsonStdout()).toMatchObject({
        schemaVersion: 1,
        command: 'cache.prune',
        diagnostics: [{ code: 'catalogStoreInspectionFailed' }],
        data: {
          deleted: []
        }
      });
      expect(status.stdout).not.toContain(fixture.env.AW_HOME!);
      expect(prune.stdout).not.toContain(fixture.env.AW_HOME!);
      await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);
    } finally {
      readdir.mockRestore();
    }
  });

  it('returns exit 4 and partial results while retaining an unsafe item and pruning a safe item', async () => {
    const fixture = await setupInactiveEntry();
    const unsafePath = path.join(path.dirname(fixture.entryDir), 'unsafe-link');
    await fs.symlink(fixture.cwd, unsafePath);

    const status = await runCliEntry(['cache', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode).toBe(4);
    expect(status.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'partial',
      command: 'cache.status',
      diagnostics: [{ code: 'catalogStoreInspectionFailed' }],
      data: {
        totals: { reclaimableEntries: 1, reclaimableBytes: null }
      }
    });
    expect(status.parseJsonStdout().data.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ storeKey: fixture.storeKey, status: 'reclaimable', generationReference: 'none' }),
      expect.objectContaining({ status: 'error', generationReference: 'none', reason: 'unsafeSymlink' }),
    ]));
    expect(status.stdout).not.toContain(fixture.env.AW_HOME!);

    const human = await runCliEntry(['cache', 'status'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(human.exitCode).toBe(4);
    expect(human.stderr).toContain('catalogStoreInspectionFailed');

    const dryRun = await runCliEntry(['cache', 'prune', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(dryRun.exitCode).toBe(4);
    expect(dryRun.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'partial',
      diagnostics: [{ code: 'catalogStoreInspectionFailed' }],
      data: {
        dryRun: true,
        deleted: [],
        reclaimableBytes: null
      }
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);

    const pruned = await runCliEntry(['cache', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(pruned.exitCode).toBe(4);
    expect(pruned.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'partial',
      diagnostics: [{ code: 'catalogStoreInspectionFailed' }],
      data: {
        dryRun: false,
        deleted: [{ storeKey: fixture.storeKey }],
        reclaimableBytes: null
      }
    });
    expect(pruned.stdout).not.toContain(fixture.env.AW_HOME!);
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(false);
    await expect(fs.pathExists(unsafePath)).resolves.toBe(true);
  });

  it('reports and removes an old safe delete claim left by an earlier partial prune', async () => {
    const fixture = await setupInactiveEntry();
    const claimName = '.delete-11111111-1111-4111-8111-111111111111.tmp';
    const claimPath = path.join(path.dirname(fixture.entryDir), claimName);
    await fs.rename(fixture.entryDir, claimPath);

    const status = await runCliEntry(['cache', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.parseJsonStdout().data.entries).toContainEqual(expect.objectContaining({
      storeKey: `${fixture.storeKey.split('/')[0]}/${claimName}`,
      category: 'deleteClaim',
      status: 'reclaimable',
      reason: 'deleteClaimOlderThan24Hours',
    }));

    const pruned = await runCliEntry(['cache', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(pruned.exitCode, pruned.stderr).toBe(0);
    expect(pruned.parseJsonStdout().data.deleted).toContainEqual(expect.objectContaining({
      storeKey: `${fixture.storeKey.split('/')[0]}/${claimName}`,
    }));
    expect(pruned.stdout).not.toContain(fixture.env.AW_HOME!);
    await expect(fs.pathExists(claimPath)).resolves.toBe(false);
  });
});
