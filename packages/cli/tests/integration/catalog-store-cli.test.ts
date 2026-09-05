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
  const first = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
    cwd, env: isolation.env, interactive: false,
  });
  const firstActive = first.parseJsonStdout().active;
  const location = resolveCatalogStoreLocation({
    logicalIdentity: firstActive.logicalIdentity,
    snapshotDigest: firstActive.snapshotDigest,
    env: isolation.env,
  });
  await writeSnapshot(root, 'second\n');
  const second = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
    cwd, env: isolation.env, interactive: false,
  });
  expect(second.exitCode, second.stderr).toBe(0);
  await setTreeTime(location.entryDir, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
  return { env: isolation.env, cwd, entryDir: location.entryDir, storeKey: location.storeKey };
}

describe('Catalog store CLI', () => {
  it('publishes stable human/JSON status and defaults prune to a read-only dry run', async () => {
    const fixture = await setupInactiveEntry();
    const status = await runCliEntry(['catalog', 'store', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode, status.stderr).toBe(0);
    const statusPayload = status.parseJsonStdout();
    expect(statusPayload).toMatchObject({
      catalogStoreSchemaVersion: 2,
      command: 'catalog:store:status',
      ok: true,
      totals: { reclaimableEntries: 1 },
    });
    expect(statusPayload.entries).toContainEqual(expect.objectContaining({
      storeKey: fixture.storeKey, category: 'entry', status: 'reclaimable',
    }));
    expect(status.stdout).not.toContain(fixture.env.AW_HOME!);

    const human = await runCliEntry(['catalog', 'store', 'status'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`${fixture.storeKey}: entry, reclaimable`);
    expect(human.stdout).not.toContain(fixture.env.AW_HOME!);

    const dryRun = await runCliEntry(['catalog', 'store', 'prune', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    const dryRunPayload = dryRun.parseJsonStdout();
    expect(dryRunPayload).toMatchObject({
      catalogStoreSchemaVersion: 2,
      command: 'catalog:store:prune',
      ok: true,
      overallState: 'succeeded',
      dryRun: true,
      deleted: [],
    });
    expect(dryRunPayload.retained).toContainEqual({
      storeKey: fixture.storeKey, reason: 'inactiveOlderThan30Days',
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);

    const invalid = await runCliEntry(['catalog', 'store', 'prune', '--dry-run', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.parseJsonStdout()).toMatchObject({
      command: 'catalog:store:prune',
      ok: false,
      overallState: 'failed',
      errors: [{ code: 'invalidArguments' }],
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);

    const deleted = await runCliEntry(['catalog', 'store', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(deleted.exitCode, deleted.stderr).toBe(0);
    expect(deleted.parseJsonStdout()).toMatchObject({
      dryRun: false,
      deleted: [{ storeKey: fixture.storeKey }],
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(false);
  });

  it.each([
    ['catalog-state.json', 'catalogGenerationStateInvalid'],
    ['catalog-sources.json', 'catalogSourcesConfigInvalid'],
  ])('returns typed failed receipts and deletes nothing when %s is damaged', async (fileName, code) => {
    const fixture = await setupInactiveEntry();
    await fs.writeFile(path.join(fixture.env.AW_HOME!, fileName), '{ invalid\n');
    const status = await runCliEntry(['catalog', 'store', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode).toBe(1);
    expect(status.parseJsonStdout()).toMatchObject({
      catalogStoreSchemaVersion: 2,
      command: 'catalog:store:status',
      ok: false,
      entries: [],
      errors: [{ code }],
    });
    const failed = await runCliEntry(['catalog', 'store', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.parseJsonStdout()).toMatchObject({
      catalogStoreSchemaVersion: 2,
      command: 'catalog:store:prune',
      ok: false,
      overallState: 'failed',
      deleted: [],
      errors: [{ code }],
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
      const status = await runCliEntry(['catalog', 'store', 'status', '--json'], {
        cwd: fixture.cwd, env: fixture.env, interactive: false,
      });
      const prune = await runCliEntry(['catalog', 'store', 'prune', '--yes', '--json'], {
        cwd: fixture.cwd, env: fixture.env, interactive: false,
      });
      expect(status.exitCode).toBe(1);
      expect(prune.exitCode).toBe(1);
      expect(status.parseJsonStdout()).toMatchObject({
        catalogStoreSchemaVersion: 2,
        command: 'catalog:store:status',
        errors: [{ code: 'catalogStoreInspectionFailed' }],
      });
      expect(prune.parseJsonStdout()).toMatchObject({
        catalogStoreSchemaVersion: 2,
        command: 'catalog:store:prune',
        overallState: 'failed',
        deleted: [],
        errors: [{ code: 'catalogStoreInspectionFailed' }],
      });
      expect(status.stdout).not.toContain(fixture.env.AW_HOME!);
      expect(prune.stdout).not.toContain(fixture.env.AW_HOME!);
      await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);
    } finally {
      readdir.mockRestore();
    }
  });

  it('returns exit 1 and partial receipts while retaining an unsafe item and pruning a safe item', async () => {
    const fixture = await setupInactiveEntry();
    const unsafePath = path.join(path.dirname(fixture.entryDir), 'unsafe-link');
    await fs.symlink(fixture.cwd, unsafePath);

    const status = await runCliEntry(['catalog', 'store', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode).toBe(1);
    expect(status.parseJsonStdout()).toMatchObject({
      catalogStoreSchemaVersion: 2,
      command: 'catalog:store:status',
      ok: false,
      totals: { reclaimableEntries: 1, reclaimableBytes: null },
      errors: [{ code: 'catalogStoreInspectionFailed' }],
    });
    expect(status.parseJsonStdout().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ storeKey: fixture.storeKey, status: 'reclaimable', generationReference: 'none' }),
      expect.objectContaining({ status: 'error', generationReference: 'none', reason: 'unsafeSymlink' }),
    ]));
    expect(status.stdout).not.toContain(fixture.env.AW_HOME!);

    const human = await runCliEntry(['catalog', 'store', 'status'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain('could not be fully inspected');

    const dryRun = await runCliEntry(['catalog', 'store', 'prune', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(dryRun.exitCode).toBe(1);
    expect(dryRun.parseJsonStdout()).toMatchObject({
      catalogStoreSchemaVersion: 2,
      ok: false,
      overallState: 'partial',
      dryRun: true,
      deleted: [],
      reclaimableBytes: null,
      errors: [{ code: 'catalogStoreInspectionFailed' }],
    });
    await expect(fs.pathExists(fixture.entryDir)).resolves.toBe(true);

    const pruned = await runCliEntry(['catalog', 'store', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(pruned.exitCode).toBe(1);
    expect(pruned.parseJsonStdout()).toMatchObject({
      catalogStoreSchemaVersion: 2,
      ok: false,
      overallState: 'partial',
      dryRun: false,
      deleted: [{ storeKey: fixture.storeKey }],
      reclaimableBytes: null,
      errors: [{ code: 'catalogStoreInspectionFailed' }],
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

    const status = await runCliEntry(['catalog', 'store', 'status', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.parseJsonStdout().entries).toContainEqual(expect.objectContaining({
      storeKey: `${fixture.storeKey.split('/')[0]}/${claimName}`,
      category: 'deleteClaim',
      status: 'reclaimable',
      reason: 'deleteClaimOlderThan24Hours',
    }));

    const pruned = await runCliEntry(['catalog', 'store', 'prune', '--yes', '--json'], {
      cwd: fixture.cwd, env: fixture.env, interactive: false,
    });
    expect(pruned.exitCode, pruned.stderr).toBe(0);
    expect(pruned.parseJsonStdout().deleted).toContainEqual(expect.objectContaining({
      storeKey: `${fixture.storeKey.split('/')[0]}/${claimName}`,
    }));
    expect(pruned.stdout).not.toContain(fixture.env.AW_HOME!);
    await expect(fs.pathExists(claimPath)).resolves.toBe(false);
  });
});
