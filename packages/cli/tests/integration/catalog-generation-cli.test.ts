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

describe('Catalog generation CLI', () => {
  it('refreshes and reports a Path Active generation through single-object JSON output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = path.join(isolation.layout.fixtureCwd, 'catalog-generation-cli');
    await createCatalogSnapshotFixture(root);
    await fs.writeJson(path.join(root, '.aw-generated.json'), {
      schemaVersion: 1,
      kind: 'catalog',
      workspaceIdentity: 'workspace:cli-generation',
      sourceIdentity: `sha256:${crypto.createHash('sha256').update('cli-generation').digest('hex')}`,
    }, { spaces: 2 });
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: root }],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });

    const refreshed = await runCliEntry([
      'catalog', 'source', 'refresh', 'local', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    });
    expect(refreshed.exitCode).toBe(0);
    expect(refreshed.stderr).toBe('');
    expect(refreshed.parseJsonStdout()).toMatchObject({
      catalogGenerationSchemaVersion: 1,
      command: 'catalog:source:refresh',
      ok: true,
      sourceId: 'local',
      logicalIdentity: 'workspace:cli-generation',
      outcome: 'activeReady',
      active: { catalogVersion: '1.0.0' },
    });

    const status = await runCliEntry([
      'catalog', 'source', 'generation-status', 'local', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    });
    expect(status.exitCode).toBe(0);
    expect(status.stderr).toBe('');
    expect(status.parseJsonStdout()).toMatchObject({
      catalogGenerationStatusSchemaVersion: 1,
      sources: [{
        sourceId: 'local',
        sourceType: 'path',
        refreshPolicy: 'manual',
        active: { catalogVersion: '1.0.0' },
      }],
    });

    const activation = await runCliEntry([
      'catalog', 'source', 'activate-candidate', 'local', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    });
    expect(activation.exitCode).toBe(1);
    expect(activation.parseJsonStdout()).toMatchObject({
      catalogGenerationSchemaVersion: 1,
      command: 'catalog:source:activate-candidate',
      ok: false,
      errors: [{ code: 'catalogGenerationCandidateUnavailable' }],
    });
    expect(activation.stderr).toContain('has no Candidate generation');
  });
});
