import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  addCatalogSourceCommand,
  preflightCatalogSourceMutation,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

describe('catalog source mutation v4', () => {
  it('preflights only config evidence and does not scan live or historical references', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('preflight-source');
    await createCatalogSnapshotFixture(root);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const preview = await preflightCatalogSourceMutation({
      request: { action: 'add', source: { id: 'team', type: 'path', path: root, primary: false } },
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(preview).toMatchObject({
      sourceId: 'team',
      configDigest: before.digest,
      references: { inventorySchemaVersion: 1, references: [], errors: [] },
    });
    expect(preview.candidateDigest).not.toBe(before.digest);
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('commits add before refresh and reports refresh failure as a successful receipt warning', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('refresh-failure-source');
    await createCatalogSnapshotFixture(root);
    const receipt = await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: { beforeRefresh: () => fs.remove(root) },
    });
    expect(receipt).toMatchObject({
      receiptSchemaVersion: 4,
      ok: true,
      changed: true,
      sourceId: 'team',
      references: [],
      errors: [{ code: expect.any(String), message: expect.any(String) }],
    });
    expect(receipt.source).toBeUndefined();
    const configured = (await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'team');
    expect(configured).toMatchObject({ id: 'team', type: 'path' });
    expect(configured && 'path' in configured ? path.basename(configured.path) : '').toBe('refresh-failure-source');
  });

  it('commits update with live references and keeps the new config when refresh fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('update-first');
    const second = fixturePath('update-second');
    await createCatalogSnapshotFixture(first);
    await createCatalogSnapshotFixture(second);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: first, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const receipt = await updateCatalogSourceCommand({
      sourceId: 'team', update: { type: 'path', path: second },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      runtime: { beforeRefresh: () => fs.remove(second) },
    });
    expect(receipt).toMatchObject({ ok: true, changed: true, references: [], errors: [expect.any(Object)] });
    const configured = (await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'team');
    expect(configured).toMatchObject({ id: 'team', type: 'path' });
    expect(configured && 'path' in configured ? path.basename(configured.path) : '').toBe('update-second');
  });

  it('set-primary and remove commit directly even when live reference inventory is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('direct-mutations');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await expect(setPrimaryCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true, primarySourceId: 'team', references: [] });
    await expect(removeCatalogSourceCommand({
      sourceId: 'official', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true, primarySourceId: 'team', references: [] });
  });

  it('rejects an expected config digest conflict before writing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('digest-conflict');
    await createCatalogSnapshotFixture(root);
    await expect(addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      expectedConfigDigest: `sha256:${'0'.repeat(64)}`,
    })).rejects.toMatchObject({ name: 'CatalogSourcesConfigConflictError' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));
  });
});
