import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addCatalogSourceCommand,
  preflightCatalogSourceMutation,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import {
  catalogSourceStatusCommand,
  syncCatalogSourceCommand,
} from '../../src/commands/catalog-generation.js';
import { catalogStorePrune, catalogStoreStatus } from '../../src/commands/catalog-store.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { setAtomicConfigBeforeRenameHookForTests } from '../../src/utils/plugin-config.js';
import { createEmptyIntent, addIntentRoot } from '../../src/intent/intent-codec.js';
import { writeIntent } from '../../src/intent/intent-store.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

afterEach(() => {
  setAtomicConfigBeforeRenameHookForTests(undefined);
  vi.restoreAllMocks();
});

describe('catalog source mutation v6', () => {
  it('requires confirmation to remove a source with lifecycle intent references', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('referenced-source');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    await writeIntent({
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }, addIntentRoot(createEmptyIntent(), 'team/demo', 'team-test'));

    const preview = await preflightCatalogSourceMutation({
      request: { action: 'remove', sourceId: 'team' },
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(preview.references).toMatchObject({
      inventoryComplete: true,
      references: [{ category: 'lifecycle', sourceId: 'team', pluginId: 'team/demo' }],
    });
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      requireImpactConfirmation: true,
    })).rejects.toMatchObject({ code: 'catalogSourceImpactConfirmationRequired' });
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      requireImpactConfirmation: true,
      confirmImpact: true,
    })).resolves.toMatchObject({
      ok: true,
      references: [{ category: 'lifecycle', pluginId: 'team/demo' }],
    });
  });

  it('uses lock-time impact for CLI remove confirmation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('remove-impact-race');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });

    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      requireImpactConfirmation: true,
      runtime: {
        afterImpactInspected: async () => {
          await writeIntent({
            scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
          }, addIntentRoot(createEmptyIntent(), 'team/demo', 'team-test'));
        },
      },
    })).rejects.toMatchObject({ code: 'catalogSourceImpactConfirmationRequired' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .toContainEqual(expect.objectContaining({ id: 'team' }));
  });

  it('rejects reviewed remove and identity-change impact that drifts before the lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('reviewed-impact-first');
    const second = fixturePath('reviewed-impact-second');
    await Promise.all([
      createCatalogSnapshotFixture(first),
      createCatalogSnapshotFixture(second),
    ]);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: first, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const addReference = async () => {
      await writeIntent({
        scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }, addIntentRoot(createEmptyIntent(), 'team/demo', 'team-test'));
    };
    const removePreview = await preflightCatalogSourceMutation({
      request: { action: 'remove', sourceId: 'team' },
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    await expect(removeCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireImpactConfirmation: true, confirmImpact: true,
      expectedImpactDigest: removePreview.impactDigest,
      runtime: { afterImpactInspected: addReference },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'team')).toMatchObject({
        id: 'team', path: expect.stringContaining('reviewed-impact-first'),
      });

    await writeIntent({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, createEmptyIntent());
    const updatePreview = await preflightCatalogSourceMutation({
      request: { action: 'update', sourceId: 'team', update: { type: 'path', path: second } },
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update: { type: 'path', path: second },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireIdentityChangeConfirmation: true, confirmIdentityChange: true,
      expectedImpactDigest: updatePreview.impactDigest,
      runtime: { afterImpactInspected: addReference },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'team')).toMatchObject({
        id: 'team', path: expect.stringContaining('reviewed-impact-first'),
      });
  });

  it('protects Workspace-managed sources in public commands and preflight', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('managed-first');
    const second = fixturePath('managed-second');
    await createCatalogSnapshotFixture(first);
    await createCatalogSnapshotFixture(second);
    const source = {
      id: 'managed-dev',
      type: 'path' as const,
      path: first,
      primary: false,
      managedBy: { kind: 'catalog-workspace' as const, workspaceIdentity: 'workspace-1' },
    };
    await expect(addCatalogSourceCommand({
      source, cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toMatchObject({ code: 'managedSourceProtected' });
    await addCatalogSourceCommand({
      source, cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      managedByWorkspaceIdentity: 'workspace-1',
    });
    for (const request of [
      { action: 'update' as const, sourceId: source.id, update: { type: 'path' as const, path: second } },
      { action: 'remove' as const, sourceId: source.id },
    ]) {
      await expect(preflightCatalogSourceMutation({
        request, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).rejects.toMatchObject({ code: 'managedSourceProtected' });
    }
    await expect(updateCatalogSourceCommand({
      sourceId: source.id, update: { type: 'path', path: second },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toMatchObject({ code: 'managedSourceProtected' });
    await expect(removeCatalogSourceCommand({
      sourceId: source.id, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toMatchObject({ code: 'managedSourceProtected' });
  });

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
      references: { inventorySchemaVersion: 2, primaryChange: null, references: [], errors: [] },
    });
    expect(preview.proposedConfigDigest).not.toBe(before.digest);
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('commits add as config-only and does not create store or Active state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('refresh-failure-source');
    await createCatalogSnapshotFixture(root);
    const receipt = await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(receipt).toMatchObject({
      receiptSchemaVersion: 6,
      primaryChange: null,
      ok: true,
      changed: true,
      sourceId: 'team',
      references: [],
      errors: [],
    });
    const configured = (await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'team');
    expect(configured).toMatchObject({ id: 'team', type: 'path' });
    expect(configured && 'path' in configured ? path.basename(configured.path) : '').toBe('refresh-failure-source');
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-state.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-store'))).resolves.toBe(false);
  });

  it('requires confirmation for add-primary impact and returns the confirmed primary change', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('add-primary-impact');
    await createCatalogSnapshotFixture(root);
    await fs.outputJson(path.join(
      isolation.env.AW_HOME!, 'plugin-config', 'legacy-demo', 'config.json',
    ), { enabled: true });

    await expect(addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: true },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireImpactConfirmation: true,
    })).rejects.toMatchObject({
      code: 'catalogSourceImpactConfirmationRequired',
      impact: {
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        references: [expect.objectContaining({ category: 'config', pluginId: 'official/legacy-demo' })],
      },
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));

    await expect(addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: true },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireImpactConfirmation: true,
      confirmImpact: true,
    })).resolves.toMatchObject({
      receiptSchemaVersion: 6,
      primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
      primarySourceId: 'team',
      references: [expect.objectContaining({ category: 'config', pluginId: 'official/legacy-demo' })],
      errors: [],
    });
  });

  it('adds a primary source without confirmation when primary impact is empty', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('add-primary-empty-impact');
    await createCatalogSnapshotFixture(root);

    await expect(addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: true },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireImpactConfirmation: true,
    })).resolves.toMatchObject({
      changed: true,
      primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
      primarySourceId: 'team',
      references: [],
      errors: [],
    });
  });

  it('rejects add-primary when reviewed config or impact drifts before the lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('add-primary-reviewed');
    const racing = fixturePath('add-primary-racing');
    await Promise.all([
      createCatalogSnapshotFixture(first),
      createCatalogSnapshotFixture(racing),
    ]);
    const source = { id: 'team', type: 'path' as const, path: first, primary: true };
    const configPreview = await preflightCatalogSourceMutation({
      request: { action: 'add', source }, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await expect(addCatalogSourceCommand({
      source, cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      expectedConfigDigest: configPreview.configDigest,
      expectedImpactDigest: configPreview.impactDigest,
      requireImpactConfirmation: true,
      confirmImpact: true,
      runtime: {
        afterImpactInspected: async () => {
          await addCatalogSourceCommand({
            source: { id: 'racing', type: 'path', path: racing, primary: false },
            cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
          });
        },
      },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));

    const impactPreview = await preflightCatalogSourceMutation({
      request: { action: 'add', source }, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await expect(addCatalogSourceCommand({
      source, cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      expectedConfigDigest: impactPreview.configDigest,
      expectedImpactDigest: impactPreview.impactDigest,
      requireImpactConfirmation: true,
      confirmImpact: true,
      runtime: {
        afterImpactInspected: async () => {
          await fs.outputJson(path.join(
            isolation.env.AW_HOME!, 'plugin-config', 'legacy-demo', 'config.json',
          ), { enabled: true });
        },
      },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));
  });

  it('rejects add-primary when a reviewed Path symlink changes its real target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('add-primary-symlink-first');
    const second = fixturePath('add-primary-symlink-second');
    const sourceLink = fixturePath('add-primary-symlink');
    await Promise.all([
      createCatalogSnapshotFixture(first),
      createCatalogSnapshotFixture(second),
    ]);
    await fs.symlink(first, sourceLink, 'dir');
    const statePath = path.join(isolation.env.AW_HOME!, 'catalog-state.json');
    const state = {
      schemaVersion: 1,
      sources: {
        team: {
          lastSync: {
            syncedAt: '2026-01-01T00:00:00.000Z',
            mode: 'sync',
            state: 'failed',
            errorCode: 'retained-test-state',
          },
        },
      },
    };
    await fs.outputJson(statePath, state, { spaces: 2 });
    const beforeConfig = await readCatalogSourcesConfigSnapshot(isolation.env);

    await expect(addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: sourceLink, primary: true },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireImpactConfirmation: true,
      confirmImpact: true,
      runtime: {
        afterImpactInspected: async () => {
          await fs.unlink(sourceLink);
          await fs.symlink(second, sourceLink, 'dir');
        },
      },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(await readCatalogSourcesConfigSnapshot(isolation.env)).toEqual(beforeConfig);
    expect(await fs.readJson(statePath)).toEqual(state);
  });

  it('rejects reviewed non-primary add when a Path symlink changes its real target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('add-reviewed-symlink-first');
    const second = fixturePath('add-reviewed-symlink-second');
    const sourceLink = fixturePath('add-reviewed-symlink');
    await Promise.all([
      createCatalogSnapshotFixture(first),
      createCatalogSnapshotFixture(second),
    ]);
    await fs.symlink(first, sourceLink, 'dir');
    const source = { id: 'team', type: 'path' as const, path: sourceLink, primary: false };
    const preview = await preflightCatalogSourceMutation({
      request: { action: 'add', source }, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const statePath = path.join(isolation.env.AW_HOME!, 'catalog-state.json');
    const state = {
      schemaVersion: 1,
      sources: {
        team: {
          lastSync: {
            syncedAt: '2026-01-01T00:00:00.000Z',
            mode: 'sync',
            state: 'failed',
            errorCode: 'retained-test-state',
          },
        },
      },
    };
    await fs.outputJson(statePath, state, { spaces: 2 });
    const beforeConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    await fs.unlink(sourceLink);
    await fs.symlink(second, sourceLink, 'dir');

    await expect(addCatalogSourceCommand({
      source, cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      expectedConfigDigest: preview.configDigest,
      expectedProposedConfigDigest: preview.proposedConfigDigest,
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(await readCatalogSourcesConfigSnapshot(isolation.env)).toEqual(beforeConfig);
    expect(await fs.readJson(statePath)).toEqual(state);
  });

  it('rejects reviewed Path update when its symlink changes real target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const current = fixturePath('update-reviewed-current');
    const first = fixturePath('update-reviewed-symlink-first');
    const second = fixturePath('update-reviewed-symlink-second');
    const sourceLink = fixturePath('update-reviewed-symlink');
    await Promise.all([
      createCatalogSnapshotFixture(current),
      createCatalogSnapshotFixture(first),
      createCatalogSnapshotFixture(second),
    ]);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: current, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.symlink(first, sourceLink, 'dir');
    const update = { type: 'path' as const, path: sourceLink };
    const preview = await preflightCatalogSourceMutation({
      request: { action: 'update', sourceId: 'team', update },
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const statePath = path.join(isolation.env.AW_HOME!, 'catalog-state.json');
    const state = {
      schemaVersion: 1,
      sources: {
        team: {
          lastSync: {
            syncedAt: '2026-01-01T00:00:00.000Z',
            mode: 'sync',
            state: 'failed',
            errorCode: 'retained-test-state',
          },
        },
      },
    };
    await fs.outputJson(statePath, state, { spaces: 2 });
    const beforeConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    await fs.unlink(sourceLink);
    await fs.symlink(second, sourceLink, 'dir');

    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update,
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      expectedConfigDigest: preview.configDigest,
      expectedProposedConfigDigest: preview.proposedConfigDigest,
      expectedImpactDigest: preview.impactDigest,
      requireIdentityChangeConfirmation: true,
      confirmIdentityChange: true,
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(await readCatalogSourcesConfigSnapshot(isolation.env)).toEqual(beforeConfig);
    expect(await fs.readJson(statePath)).toEqual(state);
  });

  it('stops add before config commit when orphan state cleanup fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('orphan-add-cleanup');
    await createCatalogSnapshotFixture(root);
    await fs.mkdir(path.join(isolation.env.AW_HOME!, 'catalog-state.json'), { recursive: true });

    await expect(addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogGenerationStateInvalid' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));
  });

  it('commits update as config-only without reading or validating the new snapshot', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('update-first');
    const second = fixturePath('update-second');
    await createCatalogSnapshotFixture(first);
    await createCatalogSnapshotFixture(second);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: first, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.writeFile(path.join(second, '.aw-generated.json'), 'invalid snapshot metadata');
    const receipt = await updateCatalogSourceCommand({
      sourceId: 'team', update: { type: 'path', path: second },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(receipt).toMatchObject({ ok: true, changed: true, references: [], errors: [] });
    const configured = (await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'team');
    expect(configured).toMatchObject({ id: 'team', type: 'path' });
    expect(configured && 'path' in configured ? path.basename(configured.path) : '').toBe('update-second');
  });

  it('requires CLI confirmation only when URL, path, or subdirectory identity changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('confirmed-update-first');
    const second = fixturePath('confirmed-update-second');
    await createCatalogSnapshotFixture(first);
    await createCatalogSnapshotFixture(second);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: first, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });

    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update: { type: 'path', path: second },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireIdentityChangeConfirmation: true,
    })).rejects.toThrow('catalogSourceIdentityChangeConfirmationRequired');
    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update: { type: 'path', path: second },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireIdentityChangeConfirmation: true,
      confirmIdentityChange: true,
    })).resolves.toMatchObject({ changed: true });
  });

  it('keeps the old Active selection when update changes source identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('active-update-first');
    const second = fixturePath('active-update-second');
    await createCatalogSnapshotFixture(first);
    await createCatalogSnapshotFixture(second, 'demo', [], 'updated bundle\n');
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: first, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const synced = await syncCatalogSourceCommand({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    await updateCatalogSourceCommand({
      sourceId: 'team', update: { type: 'path', path: second },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });

    await expect(catalogSourceStatusCommand({ sourceId: 'team', env: isolation.env }))
      .resolves.toMatchObject({
        sources: [{
          active: { snapshotDigest: synced.active?.snapshotDigest },
          activeReady: false,
          configMatchesActive: false,
        }],
      });
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

  it('requires confirmation for primary legacy references and rejects reviewed impact drift', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('primary-impact');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const legacyConfig = path.join(
      isolation.env.AW_HOME!, 'plugin-config', 'legacy-demo', 'config.json',
    );
    await fs.outputJson(legacyConfig, { enabled: true });

    await expect(setPrimaryCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireImpactConfirmation: true,
    })).rejects.toMatchObject({
      code: 'catalogSourceImpactConfirmationRequired',
      impact: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        references: [expect.objectContaining({ category: 'config', pluginId: 'official/legacy-demo' })],
      },
    });
    await expect(setPrimaryCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      requireImpactConfirmation: true, confirmImpact: true,
    })).resolves.toMatchObject({
      receiptSchemaVersion: 6,
      primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
      primarySourceId: 'team',
    });

    await fs.remove(legacyConfig);
    const preview = await preflightCatalogSourceMutation({
      request: { action: 'setPrimary', sourceId: 'official' },
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    await expect(setPrimaryCatalogSourceCommand({
      sourceId: 'official', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      expectedConfigDigest: preview.configDigest,
      expectedImpactDigest: preview.impactDigest,
      requireImpactConfirmation: true,
      confirmImpact: true,
      runtime: {
        afterImpactInspected: async () => {
          await fs.outputJson(legacyConfig, { enabled: true });
        },
      },
    })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'team')).toMatchObject({ primary: true });
  });

  it('remove deletes only the configured source and its state while retaining the store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('remove-source-state');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await syncCatalogSourceCommand({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const storeRoot = path.join(isolation.env.AW_HOME!, 'catalog-store');
    await removeCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });

    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));
    expect((await readCatalogGenerationState(isolation.env)).sources.team).toBeUndefined();
    await expect(fs.pathExists(storeRoot)).resolves.toBe(true);
  });

  it('preserves Active when source config replacement fails during remove', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('remove-config-failure');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await syncCatalogSourceCommand({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const active = (await readCatalogGenerationState(isolation.env)).sources.team!.active;
    setAtomicConfigBeforeRenameHookForTests(async (filePath) => {
      if (path.basename(filePath) === 'catalog-sources.json') throw new Error('injected config failure');
    });

    await expect(removeCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toThrow('injected config failure');
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(active);
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .toContainEqual(expect.objectContaining({ id: 'team' }));
  });

  it('returns remove success and emits a warning when orphan state cleanup fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('remove-cleanup-warning');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await syncCatalogSourceCommand({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const statePath = path.join(isolation.env.AW_HOME!, 'catalog-state.json');
    await fs.remove(statePath);
    await fs.mkdir(statePath);
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(removeCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('orphan state cleanup failed'),
      { code: 'AW_CATALOG_SOURCE_STATE_CLEANUP_FAILED' },
    );
  });

  it('allows an old orphan store entry to be pruned after remove state cleanup fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('remove-orphan-prune');
    await createCatalogSnapshotFixture(root);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', path: root, primary: false },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await syncCatalogSourceCommand({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const active = (await readCatalogGenerationState(isolation.env)).sources.team!.active!;
    const location = resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity,
      snapshotDigest: active.snapshotDigest,
      env: isolation.env,
    });
    setAtomicConfigBeforeRenameHookForTests(async (filePath) => {
      if (path.basename(filePath) === 'catalog-state.json') throw new Error('injected state cleanup failure');
    });
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await removeCatalogSourceCommand({
      sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(active);

    const now = new Date();
    const young = await catalogStoreStatus({ env: isolation.env, now });
    expect(young.entries).toContainEqual(expect.objectContaining({
      storeKey: location.storeKey,
      status: 'retained',
      reason: 'inactiveWithin30Days',
    }));
    const afterRetention = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    const pruned = await catalogStorePrune({
      dryRun: false,
      env: isolation.env,
      now: afterRetention,
    });
    expect(pruned.deleted).toContainEqual(expect.objectContaining({ storeKey: location.storeKey }));
    await expect(fs.pathExists(location.entryDir)).resolves.toBe(false);
    expect((await readCatalogGenerationState(isolation.env)).sources.team!.active).toEqual(active);
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
