import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activateCatalogDevSource,
  deactivateCatalogDevSource,
  getCatalogDevSourceStatus,
} from '../../src/commands/catalog-dev-source.js';
import { addCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import { runCli } from '../../src/index.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import {
  setAtomicConfigBeforeRenameHookForTests,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  createEmptyPluginIntentState,
  upsertPluginIntentRoot,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { rewriteActiveCatalogCapabilities } from '../helpers/catalog-source-fixture.js';

const roots: string[] = [];

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-dev-source-'));
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  await fs.ensureDir(workspaceRoot);
  const env = {
    ...process.env,
    AW_HOME: path.join(root, 'aw-home'),
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'claude-home'),
  };
  expect(await runCli(['catalog', 'init', '--workspace-root', workspaceRoot], {
    cwd: workspaceRoot, env, io: capture().io,
  })).toBe(0);
  expect(await runCli([
    'plugin', 'init', 'dev-demo', '--description', 'Development source fixture.', '--no-skills',
    '--workspace-root', workspaceRoot,
  ], { cwd: workspaceRoot, env, io: capture().io })).toBe(0);
  return { root, workspaceRoot, env };
}

async function jsonCommand(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const output = capture();
  const exitCode = await runCli(args, { cwd, env, io: output.io });
  return { exitCode, receipt: JSON.parse(output.stdout()), stderr: output.stderr() };
}

afterEach(async () => {
  setAtomicConfigBeforeRenameHookForTests(undefined);
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Catalog Workspace development source', () => {
  it.each([
    ['activate', 2],
    ['status', 4],
    ['deactivate', 4],
  ] as const)('reports the current receipt schema in %s help', async (command, schemaVersion) => {
    const output = capture();
    const exitCode = await runCli(['catalog', 'dev', command, '--help'], { io: output.io });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain(`emit one schema ${schemaVersion} JSON receipt`);
    expect(output.stderr()).toBe('');
  });

  it('builds, registers, syncs, reports Active readiness, and deactivates without deleting snapshot or store', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(activated.exitCode, activated.stderr).toBe(0);
    expect(activated.receipt).toMatchObject({
      receiptSchemaVersion: 2,
      command: 'catalog:dev:activate',
      ok: true,
      state: 'completed',
      snapshot: { action: 'built', digest: expect.stringMatching(/^sha256:/u) },
      source: { action: 'added', primary: false },
      active: { ready: true, snapshotDigest: expect.stringMatching(/^sha256:/u) },
      recovery: [],
    });
    expect(JSON.stringify(activated.receipt)).not.toContain(workspaceRoot);

    const status = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.receipt).toMatchObject({
      receiptSchemaVersion: 4,
      ok: true,
      ready: true,
      snapshot: { state: 'current', valid: true, digest: activated.receipt.snapshot.digest },
      source: { exists: true, pathMatches: true },
      active: {
        ready: true,
        digestMatchesSnapshot: true,
        snapshotDigest: activated.receipt.snapshot.digest,
        compatibility: { state: 'supported' },
      },
    });
    expect(status.receipt.cache).toBeUndefined();
    expect(JSON.stringify(status.receipt)).not.toContain(workspaceRoot);

    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    const storeRoot = path.join(env.AW_HOME!, 'catalog-store');
    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode, deactivated.stderr).toBe(0);
    expect(deactivated.receipt).toMatchObject({
      receiptSchemaVersion: 4, ok: true,
      source: { id: activated.receipt.source.id, action: 'removed' },
      impact: { inventorySchemaVersion: 2, primaryChange: null, inventoryComplete: true, references: [], errors: [] },
    });
    await expect(fs.pathExists(snapshotPath)).resolves.toBe(true);
    await expect(fs.pathExists(storeRoot)).resolves.toBe(true);
  });

  it('reports a healthy incompatible Active separately from damaged state', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(activated.exitCode, activated.stderr).toBe(0);
    await rewriteActiveCatalogCapabilities({
      sourceId: activated.receipt.source.id,
      requiredCapabilities: ['aw.catalog-snapshot.v7', 'aw.future-feature.v99'],
      env,
      workspaceSnapshotRoot: path.join(workspaceRoot, '.aw', 'catalog'),
    });

    const status = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.receipt).toMatchObject({
      receiptSchemaVersion: 4,
      ok: true,
      ready: false,
      active: {
        exists: true,
        ready: false,
        compatibility: {
          state: 'unsupported',
          requiredCapabilities: ['aw.catalog-snapshot.v7', 'aw.future-feature.v99'],
          missingCapabilities: ['aw.future-feature.v99'],
        },
      },
      issues: [{ code: 'awCapabilityUnsupported', blocking: true }],
    });
    expect(status.receipt.active.compatibility).not.toHaveProperty('availableCapabilities');
  });

  it('returns null impact when the source is absent or source config prevents preflight', async () => {
    const { workspaceRoot, env } = await fixture();
    const absent = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(absent.exitCode, absent.stderr).toBe(0);
    expect(absent.receipt).toMatchObject({
      receiptSchemaVersion: 4,
      ok: true,
      source: { action: 'absent' },
      impact: null,
    });

    await fs.outputFile(path.join(env.AW_HOME!, 'catalog-sources.json'), '{ invalid');
    const invalid = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.receipt).toMatchObject({
      receiptSchemaVersion: 4,
      ok: false,
      impact: null,
      errors: [{ code: 'sourceConfigInvalid' }],
    });
    expect(JSON.stringify(invalid.receipt)).not.toContain(workspaceRoot);
  });

  it('keeps a committed managed source after sync failure and succeeds when rerun', async () => {
    const { workspaceRoot, env } = await fixture();
    const first = await activateCatalogDevSource({
      cwd: workspaceRoot,
      cliVersion: '1.0.0',
      env,
      runtime: { beforeSync: () => fs.remove(path.join(workspaceRoot, '.aw', 'catalog')) },
    });
    expect(first).toMatchObject({
      ok: false, state: 'partial', source: { action: 'added' }, active: { ready: false },
      errors: [{ code: 'sourceSyncFailed' }],
    });
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources).toContainEqual(
      expect.objectContaining({
        id: first.source.id,
        managedBy: expect.objectContaining({ workspaceIdentity: first.workspaceIdentity }),
      }),
    );

    const partial = await getCatalogDevSourceStatus({ cwd: workspaceRoot, cliVersion: '1.0.0', env });
    expect(partial).toMatchObject({
      ok: true, ready: false,
      snapshot: { state: 'absent' },
      source: { exists: true, pathMatches: true },
      active: { exists: false, ready: false },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'snapshotAbsent' }),
        expect.objectContaining({ code: 'activeAbsent' }),
      ]),
    });

    const repeated = await activateCatalogDevSource({ cwd: workspaceRoot, cliVersion: '1.0.0', env });
    expect(repeated).toMatchObject({ ok: true, state: 'completed', snapshot: { action: 'built' } });
  });

  it('returns partial when final status no longer proves the synced snapshot ready', async () => {
    const { workspaceRoot, env } = await fixture();
    const result = await activateCatalogDevSource({
      cwd: workspaceRoot,
      cliVersion: '1.0.0',
      env,
      runtime: {
        afterSync: () => fs.remove(path.join(workspaceRoot, '.aw', 'catalog', '.aw-generated.json')),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      state: 'partial',
      active: { ready: false },
      errors: [{ code: 'activeNotReady' }],
    });
  });

  it('does not bypass generation impact confirmation when activating a changed development snapshot', async () => {
    const { workspaceRoot, env } = await fixture();
    expect(await runCli([
      'plugin', 'init', 'dev-dependency', '--description', 'Dependency fixture.', '--no-skills',
      '--workspace-root', workspaceRoot,
    ], { cwd: workspaceRoot, env, io: capture().io })).toBe(0);
    const initial = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(initial.exitCode, initial.stderr).toBe(0);
    const sourceId = initial.receipt.source.id as string;
    await writePluginIntentState({ scope: 'user', cwd: workspaceRoot, env }, upsertPluginIntentRoot(
      createEmptyPluginIntentState(),
      { pluginId: `${sourceId}/dev-demo`, platforms: ['codex'] },
    ));
    const manifestPath = path.join(
      workspaceRoot, 'plugins', 'dev-demo', '.agents-plugin', 'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    await fs.writeJson(manifestPath, { ...manifest, dependencies: ['dev-dependency'] }, { spaces: 2 });

    const blocked = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.receipt).toMatchObject({
      ok: false,
      errors: [{ code: 'catalogImpactConfirmationRequired' }],
    });
    const confirmed = await jsonCommand([
      'catalog', 'dev', 'activate', '--yes', '--json',
    ], workspaceRoot, env);
    expect(confirmed.exitCode, confirmed.stderr).toBe(0);
    expect(confirmed.receipt).toMatchObject({ ok: true, active: { ready: true } });
  });

  it.each([
    ['lifecycle intent', 'lifecycle'],
    ['plugin config', 'config'],
    ['installed target', 'installation'],
    ['incomplete inventory', null],
  ] as const)('requires --yes to deactivate a source with %s impact', async (fixtureKind, category) => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(activated.exitCode, activated.stderr).toBe(0);
    const sourceId = activated.receipt.source.id as string;
    if (fixtureKind === 'lifecycle intent') {
      await writePluginIntentState({ scope: 'user', cwd: workspaceRoot, env }, upsertPluginIntentRoot(
        createEmptyPluginIntentState(),
        { pluginId: `${sourceId}/dev-demo`, platforms: ['codex'] },
      ));
    } else if (fixtureKind === 'plugin config') {
      const source = (await readCatalogSourcesConfigSnapshot(env)).config.sources
        .find((entry) => entry.id === sourceId);
      if (!source) throw new Error(`Missing development source ${sourceId}.`);
      await writePluginConfigStore({
        sourceId,
        sourceIdentity: await calculateCatalogSourceIdentity(source),
        pluginName: 'dev-demo',
        scope: 'user',
        cwd: workspaceRoot,
        env,
        values: { enabled: true },
      });
    } else if (fixtureKind === 'installed target') {
      const skillsRoot = path.join(env.AW_CODEX_HOME!, 'skills');
      const skillRoot = path.join(skillsRoot, 'dev-demo');
      await fs.ensureDir(skillRoot);
      await writeSkillOwnerMarker({
        skillRoot,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId,
          pluginId: `${sourceId}/dev-demo`,
          plugin: 'dev-demo',
          artifactKey: 'dev-demo',
          platform: 'codex',
          scope: 'user',
        },
      });
    } else {
      await fs.outputFile(path.join(env.AW_CODEX_HOME!, 'config.toml'), 'invalid = [\n');
    }

    const blocked = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.receipt).toMatchObject({
      receiptSchemaVersion: 4,
      ok: false,
      state: 'failed',
      source: { id: sourceId, action: 'retained' },
      impact: category === null
        ? { inventoryComplete: false, errors: [expect.objectContaining({ code: 'stateInventoryFailed' })] }
        : {
            inventoryComplete: true,
            references: [expect.objectContaining({ category, pluginId: `${sourceId}/dev-demo` })],
          },
      errors: [{ code: 'catalogSourceImpactConfirmationRequired' }],
    });
    expect(JSON.stringify(blocked.receipt)).not.toContain(workspaceRoot);
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources)
      .toContainEqual(expect.objectContaining({ id: sourceId }));

    const confirmed = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--yes', '--json',
    ], workspaceRoot, env);
    expect(confirmed.exitCode, confirmed.stderr).toBe(0);
    expect(confirmed.receipt).toMatchObject({ ok: true, impact: blocked.receipt.impact });
  });

  it('keeps a primary development source unchanged until impact is confirmed, then removes it atomically', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand([
      'catalog', 'dev', 'activate', '--primary', '--json',
    ], workspaceRoot, env);
    expect(activated.exitCode, activated.stderr).toBe(0);
    const sourceId = activated.receipt.source.id as string;
    await writePluginIntentState({ scope: 'user', cwd: workspaceRoot, env }, upsertPluginIntentRoot(
      createEmptyPluginIntentState(),
      { pluginId: `${sourceId}/dev-demo`, platforms: ['codex'] },
    ));
    const before = await readCatalogSourcesConfigSnapshot(env);

    const blocked = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(blocked.exitCode).toBe(1);
    expect((await readCatalogSourcesConfigSnapshot(env))).toEqual(before);
    expect(blocked.receipt).toMatchObject({
      source: { id: sourceId, action: 'retained', previousPrimary: true },
      replacementPrimarySourceId: 'official',
      impact: {
        primaryChange: { fromSourceId: sourceId, toSourceId: 'official' },
        references: [expect.objectContaining({ category: 'lifecycle' })],
      },
    });

    let sourceConfigCommits = 0;
    setAtomicConfigBeforeRenameHookForTests(async (filePath) => {
      if (path.basename(filePath) === 'catalog-sources.json') sourceConfigCommits += 1;
    });
    const confirmed = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--yes', '--json',
    ], workspaceRoot, env);
    expect(confirmed.exitCode, confirmed.stderr).toBe(0);
    expect(confirmed.receipt).toMatchObject({
      receiptSchemaVersion: 4,
      ok: true,
      source: { id: sourceId, action: 'removed', previousPrimary: true },
      replacementPrimarySourceId: 'official',
      impact: { primaryChange: { fromSourceId: sourceId, toSourceId: 'official' } },
    });
    expect(sourceConfigCommits).toBe(1);
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources).toEqual([
      expect.objectContaining({ id: 'official', primary: true }),
    ]);
  });

  it('keeps both primary selection and source when the atomic config replacement fails', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand([
      'catalog', 'dev', 'activate', '--primary', '--json',
    ], workspaceRoot, env);
    expect(activated.exitCode, activated.stderr).toBe(0);
    const before = await readCatalogSourcesConfigSnapshot(env);
    setAtomicConfigBeforeRenameHookForTests(async (filePath) => {
      if (path.basename(filePath) === 'catalog-sources.json') throw new Error('injected config failure');
    });

    const result = await deactivateCatalogDevSource({ cwd: workspaceRoot, env });

    expect(result).toMatchObject({
      receiptSchemaVersion: 4,
      ok: false,
      state: 'failed',
      source: { id: activated.receipt.source.id, action: 'retained', previousPrimary: true },
      replacementPrimarySourceId: 'official',
      impact: { inventoryComplete: true },
    });
    expect(await readCatalogSourcesConfigSnapshot(env)).toEqual(before);
  });

  it('returns stale before config mutation when impact changes after preflight', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    const sourceId = activated.receipt.source.id as string;
    const before = await readCatalogSourcesConfigSnapshot(env);

    const result = await deactivateCatalogDevSource({
      cwd: workspaceRoot,
      env,
      runtime: {
        sourceRuntime: {
          afterImpactInspected: async () => {
            await writePluginIntentState({ scope: 'user', cwd: workspaceRoot, env }, upsertPluginIntentRoot(
              createEmptyPluginIntentState(),
              { pluginId: `${sourceId}/dev-demo`, platforms: ['codex'] },
            ));
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      state: 'failed',
      source: { id: sourceId, action: 'retained' },
      impact: { references: [expect.objectContaining({ category: 'lifecycle' })] },
      errors: [{ code: 'operationReviewStale' }],
    });
    expect(await readCatalogSourcesConfigSnapshot(env)).toEqual(before);
  });

  it('returns stale without switching primary or removing the source when config changes after preflight', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand([
      'catalog', 'dev', 'activate', '--primary', '--json',
    ], workspaceRoot, env);
    const sourceId = activated.receipt.source.id as string;
    let racedDigest: string | null = null;

    const result = await deactivateCatalogDevSource({
      cwd: workspaceRoot,
      env,
      runtime: {
        sourceRuntime: {
          afterImpactInspected: async () => {
            await addCatalogSourceCommand({
              source: {
                id: 'racing-source',
                type: 'path',
                path: path.join(workspaceRoot, '.aw', 'catalog'),
                primary: false,
              },
              cliVersion: '1.0.0',
              cwd: workspaceRoot,
              env,
            });
            racedDigest = (await readCatalogSourcesConfigSnapshot(env)).digest;
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      state: 'failed',
      source: { id: sourceId, action: 'retained', previousPrimary: true },
      errors: [{ code: 'operationReviewStale' }],
    });
    const after = await readCatalogSourcesConfigSnapshot(env);
    expect(after.digest).toBe(racedDigest);
    expect(after.config.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceId, primary: true }),
      expect.objectContaining({ id: 'official', primary: false }),
      expect.objectContaining({ id: 'racing-source', primary: false }),
    ]));
  });

  it('still requires --yes for source-ID recovery and returns completed preflight impact', async () => {
    const { root, workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    const sourceId = activated.receipt.source.id as string;

    const blocked = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--source-id', sourceId, '--json',
    ], root, env);

    expect(blocked.exitCode).toBe(1);
    expect(blocked.receipt).toMatchObject({
      receiptSchemaVersion: 4,
      source: { id: sourceId, action: 'retained' },
      impact: { inventorySchemaVersion: 2, inventoryComplete: true },
      errors: [{ code: 'confirmationRequired' }],
    });
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources)
      .toContainEqual(expect.objectContaining({ id: sourceId }));
  });

  it('protects the managed source from public update and remove commands', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(activated.exitCode).toBe(0);
    for (const args of [
      ['catalog', 'source', 'update', activated.receipt.source.id, '--path', path.join(workspaceRoot, '.aw', 'catalog'), '--json'],
      ['catalog', 'source', 'remove', activated.receipt.source.id, '--json'],
    ]) {
      const result = await jsonCommand(args, workspaceRoot, env);
      expect(result.exitCode).toBe(1);
      expect(result.receipt.errors).toEqual([expect.objectContaining({ code: 'managedSourceProtected' })]);
    }
  });
});
