import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePathSource(root: string): Promise<NodeJS.ProcessEnv> {
  const isolation = getCurrentSourceTestIsolation();
  await createCatalogSnapshotFixture(root);
  await fs.writeJson(path.join(root, '.aw-generated.json'), {
    schemaVersion: 1,
    kind: 'catalog',
    workspaceIdentity: 'workspace:cli-source-sync',
    sourceIdentity: `sha256:${crypto.createHash('sha256').update('cli-source-sync').digest('hex')}`,
  }, { spaces: 2 });
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: root }] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  return isolation.env;
}

describe('Catalog source sync CLI', () => {
  it('checks without creating Active, then syncs and reports ready offline status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-sync-cli');
    const env = await configurePathSource(root);

    const checked = await runCliEntry(['catalog', 'source', 'sync', 'local', '--check', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(checked.exitCode, checked.stderr).toBe(0);
    expect(checked.parseJsonStdout()).toMatchObject({
      command: 'catalog:source:sync', ok: true, sourceId: 'local', mode: 'check', outcome: 'checked',
      activeChanged: false,
    });
    await expect(fs.pathExists(path.join(env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);

    const beforeStatus = await runCliEntry(['catalog', 'source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(beforeStatus.exitCode).toBe(0);
    expect(beforeStatus.parseJsonStdout()).toMatchObject({
      sources: [{ sourceId: 'local', activeReady: false }],
    });

    const synced = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(synced.exitCode, synced.stderr).toBe(0);
    const syncReceipt = synced.parseJsonStdout();
    expect(syncReceipt).toMatchObject({
      command: 'catalog:source:sync', ok: true, sourceId: 'local', mode: 'sync', outcome: 'activated',
      activeChanged: true,
      active: { snapshotDigest: expect.stringMatching(/^sha256:/u) },
    });

    const status = await runCliEntry(['catalog', 'source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.parseJsonStdout()).toMatchObject({
      sources: [{
        sourceId: 'local', activeReady: true,
        active: { snapshotDigest: syncReceipt.active.snapshotDigest },
        lastSync: { mode: 'sync' },
      }],
    });
  });

  it('does not expose removed rollout commands and keeps the old Active after sync fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-source-sync-failure');
    const env = await configurePathSource(root);
    const first = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(first.exitCode).toBe(0);
    const activeDigest = first.parseJsonStdout().active.snapshotDigest;
    await fs.remove(root);

    const failed = await runCliEntry(['catalog', 'source', 'sync', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(failed.exitCode).toBe(1);
    const status = await runCliEntry(['catalog', 'source', 'status', 'local', '--json'], {
      cwd: isolation.layout.fixtureCwd, env, interactive: false,
    });
    expect(status.parseJsonStdout()).toMatchObject({
      sources: [{ activeReady: true, active: { snapshotDigest: activeDigest } }],
    });

    for (const command of ['refresh', 'activate-candidate', 'generation-status', 'refresh-policy']) {
      const removed = await runCliEntry(['catalog', 'source', command, 'local'], {
        cwd: isolation.layout.fixtureCwd, env, interactive: false,
      });
      expect(removed.exitCode).toBe(1);
    }
  });
});
