import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activateCatalogDevSource,
  getCatalogDevSourceStatus,
} from '../../src/commands/catalog-dev-source.js';
import { runCli } from '../../src/index.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';

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
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Catalog Workspace development source', () => {
  it('activates idempotently, follows a moved Workspace, reports cache evidence, and deactivates without deleting the snapshot', async () => {
    const { root, workspaceRoot, env } = await fixture();
    const first = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.receipt).toMatchObject({
      receiptSchemaVersion: 1,
      command: 'catalog:dev:activate',
      ok: true,
      state: 'completed',
      snapshot: { action: 'built', digest: expect.stringMatching(/^sha256:/u) },
      source: { action: 'added', primary: false },
      recovery: [],
    });

    const repeated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.receipt).toMatchObject({
      snapshot: { action: 'reused', digest: first.receipt.snapshot.digest },
      source: { id: first.receipt.source.id, action: 'reused', primary: false },
    });
    const manifestPath = path.join(workspaceRoot, 'plugins', 'dev-demo', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    await fs.writeJson(manifestPath, { ...manifest, description: 'Updated development source fixture.' }, { spaces: 2 });
    const staleRebuilt = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(staleRebuilt.exitCode, staleRebuilt.stderr).toBe(0);
    expect(staleRebuilt.receipt).toMatchObject({
      snapshot: { action: 'built' },
      source: { action: 'reused' },
    });
    const context = await jsonCommand(['catalog', 'context', '--json'], workspaceRoot, env);
    expect(context.receipt.schemaVersion).toBe(3);
    expect(context.receipt.developmentSource).toMatchObject({
      existingSourceId: first.receipt.source.id,
      configured: true,
    });
    expect(Object.keys(context.receipt.developmentSource).sort()).toEqual([
      'configured', 'existingSourceId', 'snapshotPath', 'suggestedSourceId',
    ]);

    const movedRoot = path.join(root, 'moved-workspace');
    await fs.rename(workspaceRoot, movedRoot);
    const movedStatus = await jsonCommand(['catalog', 'dev', 'status', '--json'], movedRoot, env);
    expect(movedStatus.exitCode).toBe(0);
    expect(movedStatus.receipt).toMatchObject({
      receiptSchemaVersion: 2,
      ok: true,
      ready: false,
      source: { exists: true, pathMatches: false },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourcePathMismatch', blocking: true })]),
    });
    const moved = await jsonCommand(['catalog', 'dev', 'activate', '--json'], movedRoot, env);
    expect(moved.exitCode, moved.stderr).toBe(0);
    expect(moved.receipt).toMatchObject({
      workspaceIdentity: first.receipt.workspaceIdentity,
      source: { id: first.receipt.source.id, action: 'updated' },
    });
    const status = await jsonCommand(['catalog', 'dev', 'status', '--json'], movedRoot, env);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.receipt).toMatchObject({
      receiptSchemaVersion: 2,
      ok: true,
      ready: true,
      snapshot: { state: 'current', valid: true },
      source: { exists: true, pathMatches: true },
      cache: { state: 'current', snapshotDigest: moved.receipt.snapshot.digest },
    });
    const cacheRoot = path.join(env.AW_HOME!, 'catalog-cache', 'sources', first.receipt.source.id);
    await fs.remove(cacheRoot);
    const configBeforeStatus = await fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'));
    const cacheAbsent = await jsonCommand(['catalog', 'dev', 'status', '--json'], movedRoot, env);
    expect(cacheAbsent.exitCode, cacheAbsent.stderr).toBe(0);
    expect(cacheAbsent.receipt).toMatchObject({
      ok: true,
      ready: false,
      cache: { state: 'absent' },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'cacheAbsent', blocking: true })]),
    });
    await expect(fs.pathExists(cacheRoot)).resolves.toBe(false);
    await expect(fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'))).resolves.toEqual(configBeforeStatus);

    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], movedRoot, env);
    expect(deactivated.exitCode, deactivated.stderr).toBe(0);
    expect(deactivated.receipt).toMatchObject({
      ok: true,
      source: { id: first.receipt.source.id, action: 'removed', previousPrimary: false },
    });
    await expect(fs.pathExists(path.join(movedRoot, '.aw', 'catalog'))).resolves.toBe(true);
  });

  it('prefers the exact default official source when multiple replacements exist', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand([
      'catalog', 'dev', 'activate', '--primary', '--json',
    ], workspaceRoot, env);
    expect(activated.exitCode, activated.stderr).toBe(0);
    expect(activated.receipt.source.primary).toBe(true);
    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    expect((await jsonCommand([
      'catalog', 'source', 'add', 'backup', '--path', snapshotPath, '--json',
    ], workspaceRoot, env)).exitCode).toBe(0);

    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode, deactivated.stderr).toBe(0);
    expect(deactivated.receipt).toMatchObject({ replacementPrimarySourceId: 'official' });
    const config = await readCatalogSourcesConfigSnapshot(env);
    expect(config.config.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'official', primary: true }),
      expect.objectContaining({ id: 'backup', primary: false }),
    ]));
  });

  it('rejects public update and remove for a Workspace-managed source', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(activated.exitCode).toBe(0);
    const configPath = path.join(env.AW_HOME!, 'catalog-sources.json');
    const before = await fs.readFile(configPath);
    for (const args of [
      ['catalog', 'source', 'update', activated.receipt.source.id, '--path', activated.receipt.snapshot.path, '--json'],
      ['catalog', 'source', 'remove', activated.receipt.source.id, '--json'],
    ]) {
      const result = await jsonCommand(args, workspaceRoot, env);
      expect(result.exitCode).toBe(1);
      expect(result.receipt.errors).toEqual([
        expect.objectContaining({ code: 'managedSourceProtected' }),
      ]);
      await expect(fs.readFile(configPath)).resolves.toEqual(before);
    }
  });

  it('emits stable failures for invalid Workspaces and Commander errors', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-dev-failure-'));
    roots.push(root);
    const env = { ...process.env, AW_HOME: path.join(root, 'aw-home') };
    for (const command of ['activate', 'status', 'deactivate'] as const) {
      const invalidWorkspace = await jsonCommand(['catalog', 'dev', command, '--json'], root, env);
      expect(invalidWorkspace.exitCode).toBe(1);
      expect(invalidWorkspace.stderr).toBe('');
      expect(invalidWorkspace.receipt).toMatchObject({
        receiptSchemaVersion: command === 'status' ? 2 : 1,
        command: `catalog:dev:${command}`,
        ok: false,
        ...(command === 'status' ? {} : { state: 'failed' }),
      });
      if (command === 'status') expect(invalidWorkspace.receipt.ready).toBe(false);
      const failures = command === 'status'
        ? invalidWorkspace.receipt.issues
        : invalidWorkspace.receipt.errors;
      expect(failures).toEqual([
        expect.objectContaining({ code: 'workspaceInvalid' }),
      ]);

      const invalidArguments = await jsonCommand([
        'catalog', 'dev', command, '--unknown-option', '--json',
      ], root, env);
      expect(invalidArguments.exitCode).toBe(1);
      expect(invalidArguments.stderr).toBe('');
      expect(invalidArguments.receipt).toMatchObject({
        receiptSchemaVersion: command === 'status' ? 2 : 1,
        command: `catalog:dev:${command}`,
        ok: false,
        ...(command === 'status' ? {} : { state: 'failed' }),
      });
      if (command === 'status') expect(invalidArguments.receipt.ready).toBe(false);
      const argumentFailures = command === 'status'
        ? invalidArguments.receipt.issues
        : invalidArguments.receipt.errors;
      expect(argumentFailures).toEqual([
        expect.objectContaining({ code: 'invalidArguments' }),
      ]);
    }
  });

  it('reports invalid explicit development source IDs with a stable code', async () => {
    const { workspaceRoot, env } = await fixture();
    const result = await jsonCommand([
      'catalog', 'dev', 'activate', '--source-id', 'NOT_VALID', '--json',
    ], workspaceRoot, env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.receipt.errors).toEqual([
      expect.objectContaining({ code: 'invalidSourceId' }),
    ]);
  });

  it('keeps a built snapshot when an explicit source ID belongs to a foreign source', async () => {
    const { workspaceRoot, env } = await fixture();
    expect((await jsonCommand(['catalog', 'build', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    expect((await jsonCommand([
      'catalog', 'source', 'add', 'foreign', '--path', snapshotPath, '--json',
    ], workspaceRoot, env)).exitCode).toBe(0);

    const activated = await jsonCommand([
      'catalog', 'dev', 'activate', '--source-id', 'foreign', '--force-build', '--json',
    ], workspaceRoot, env);
    expect(activated.exitCode).toBe(1);
    expect(activated.receipt).toMatchObject({
      ok: false,
      state: 'partial',
      snapshot: { action: 'built', digest: expect.stringMatching(/^sha256:/u) },
      errors: [{ code: 'sourceIdConflict', message: expect.stringContaining('foreign') }],
    });
    await expect(fs.pathExists(snapshotPath)).resolves.toBe(true);
  });

  it('uses a deterministic identity suffix when the default source ID is foreign', async () => {
    const { workspaceRoot, env } = await fixture();
    expect((await jsonCommand(['catalog', 'build', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    expect((await jsonCommand([
      'catalog', 'source', 'add', 'workspace-dev', '--path', snapshotPath, '--json',
    ], workspaceRoot, env)).exitCode).toBe(0);

    const first = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.receipt.source.id).toMatch(/^workspace-dev-[0-9a-f]{6}$/u);
    const repeated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(repeated.receipt.source.id).toBe(first.receipt.source.id);
  });

  it('keeps a committed source after refresh failure and succeeds when activate is rerun', async () => {
    const { workspaceRoot, env } = await fixture();
    const first = await activateCatalogDevSource({
      cwd: workspaceRoot,
      cliVersion: '1.0.0',
      env,
      runtime: { sourceRuntime: { beforeRefresh: () => fs.remove(path.join(workspaceRoot, '.aw', 'catalog')) } },
    });
    expect(first).toMatchObject({
      ok: false, state: 'partial', source: { action: 'added' },
      errors: [{ code: 'sourceRefreshFailed' }],
    });
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources).toContainEqual(
      expect.objectContaining({
        id: first.source.id,
        managedBy: expect.objectContaining({ workspaceIdentity: first.workspaceIdentity }),
      }),
    );

    const partialStatus = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(partialStatus.exitCode, partialStatus.stderr).toBe(0);
    expect(partialStatus.receipt).toMatchObject({
      receiptSchemaVersion: 2,
      ok: true,
      ready: false,
      snapshot: { state: 'absent' },
      source: { exists: true, pathMatches: true },
      cache: { state: 'absent' },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'snapshotAbsent', blocking: true }),
        expect.objectContaining({ code: 'cacheAbsent', blocking: true }),
      ]),
    });
    const partialContext = await jsonCommand(['catalog', 'context', '--json'], workspaceRoot, env);
    expect(partialContext.receipt.developmentSource).toMatchObject({
      existingSourceId: first.source.id,
      configured: true,
    });
    expect(Object.keys(partialContext.receipt.developmentSource).sort()).toEqual([
      'configured', 'existingSourceId', 'snapshotPath', 'suggestedSourceId',
    ]);

    const repeated = await activateCatalogDevSource({ cwd: workspaceRoot, cliVersion: '1.0.0', env });
    expect(repeated).toMatchObject({ ok: true, state: 'completed', snapshot: { action: 'built' } });
    const recoveredStatus = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(recoveredStatus.receipt).toMatchObject({ ok: true, ready: true });
  });

  it('reports failed, partial, and completed activation states and promotes only after refresh', async () => {
    const failedFixture = await fixture();
    await fs.ensureDir(path.join(failedFixture.workspaceRoot, '.aw'));
    await fs.writeFile(path.join(failedFixture.workspaceRoot, '.aw', 'catalog'), 'foreign output');
    const failed = await jsonCommand(
      ['catalog', 'dev', 'activate', '--json'],
      failedFixture.workspaceRoot,
      failedFixture.env,
    );
    expect(failed.receipt).toMatchObject({ ok: false, state: 'failed', errors: [{ code: 'snapshotBuildFailed' }] });

    const { workspaceRoot, env } = await fixture();
    const completed = await activateCatalogDevSource({ cwd: workspaceRoot, cliVersion: '1.0.0', env });
    expect(completed).toMatchObject({ ok: true, state: 'completed', source: { primary: false } });
    const partial = await activateCatalogDevSource({
      cwd: workspaceRoot,
      cliVersion: '1.0.0',
      env,
      primary: true,
      runtime: { sourceRuntime: { beforeRefresh: () => fs.remove(path.join(workspaceRoot, '.aw', 'catalog')) } },
    });
    expect(partial).toMatchObject({ ok: false, state: 'partial', source: { primary: false } });
    const config = await readCatalogSourcesConfigSnapshot(env);
    expect(config.config.sources.find((source) => source.id === 'official')).toMatchObject({ primary: true });
    expect(config.config.sources.find((source) => source.id === completed.source.id)).toMatchObject({ primary: false });
  });

  it('keeps a first activated primary non-primary when its refresh fails', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await activateCatalogDevSource({
      cwd: workspaceRoot,
      cliVersion: '1.0.0',
      env,
      primary: true,
      runtime: { sourceRuntime: { beforeRefresh: () => fs.remove(path.join(workspaceRoot, '.aw', 'catalog')) } },
    });
    expect(activated).toMatchObject({
      ok: false,
      state: 'partial',
      source: { action: 'added', primary: false },
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    expect(config.config.sources.find((source) => source.id === 'official')).toMatchObject({ primary: true });
    expect(config.config.sources.find((source) => source.id === activated.source.id)).toMatchObject({ primary: false });
  });

  it('keeps config after generation selection deletion fails and completes when public deactivate is rerun', async () => {
    for (const recovery of [false, true]) {
      const { workspaceRoot, env } = await fixture();
      const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
      const sourceId = activated.receipt.source.id as string;
      const generationStatePath = path.join(env.AW_HOME!, 'catalog-generations.json');
      const generationState = await fs.readFile(generationStatePath);
      if (recovery) await fs.writeFile(path.join(workspaceRoot, '.aw-workspace.json'), '{invalid');
      await fs.remove(generationStatePath);
      await fs.ensureDir(generationStatePath);
      const args = recovery
        ? ['catalog', 'dev', 'deactivate', '--source-id', sourceId, '--yes', '--json']
        : ['catalog', 'dev', 'deactivate', '--workspace-root', workspaceRoot, '--json'];

      const failed = await jsonCommand(args, workspaceRoot, env);
      expect(failed).toMatchObject({
        exitCode: 1,
        receipt: {
          ok: false,
          state: 'failed',
          source: { id: sourceId, action: 'retained' },
        },
      });
      expect((await readCatalogSourcesConfigSnapshot(env)).config.sources.some(
        (source) => source.id === sourceId,
      )).toBe(true);

      await fs.remove(generationStatePath);
      await fs.writeFile(generationStatePath, generationState);
      const completed = await jsonCommand(args, workspaceRoot, env);
      expect(completed).toMatchObject({
        exitCode: 0,
        receipt: { ok: true, state: 'completed', source: { id: sourceId, action: 'removed' } },
      });
      expect((await readCatalogSourcesConfigSnapshot(env)).config.sources.some(
        (source) => source.id === sourceId,
      )).toBe(false);
      expect((await readCatalogGenerationState(env)).sources[sourceId]).toBeUndefined();
    }
  });

  it('reports readiness issues without failing completed diagnostics', async () => {
    const { workspaceRoot, env } = await fixture();
    const absent = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(absent.exitCode, absent.stderr).toBe(0);
    expect(absent.receipt).toMatchObject({
      receiptSchemaVersion: 2,
      ok: true,
      ready: false,
      snapshot: { state: 'absent' },
      source: { exists: false },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'snapshotAbsent', blocking: true }),
        expect.objectContaining({ code: 'sourceInactive', blocking: true }),
      ]),
    });

    expect((await jsonCommand(['catalog', 'build', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    const inactive = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(inactive.exitCode, inactive.stderr).toBe(0);
    expect(inactive.receipt).toMatchObject({
      ok: true,
      ready: false,
      snapshot: { state: 'current' },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceInactive', blocking: true })]),
    });

    expect((await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    await fs.appendFile(path.join(workspaceRoot, 'plugins', 'dev-demo', 'README.md'), 'stale\n');
    const stale = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(stale.exitCode, stale.stderr).toBe(0);
    expect(stale.receipt).toMatchObject({
      ok: true,
      ready: false,
      snapshot: { state: 'stale' },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'snapshotStale', blocking: true })]),
    });

    await fs.writeFile(path.join(workspaceRoot, '.aw', 'catalog', '.aw-generated.json'), '{invalid');
    const invalid = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(invalid.exitCode, invalid.stderr).toBe(0);
    expect(invalid.receipt).toMatchObject({
      ok: true,
      ready: false,
      snapshot: { state: 'invalid' },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'snapshotInvalid', blocking: true })]),
    });
  });

  it('reports last-good cache, digest mismatch, and multiple managed sources as not ready', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(activated.exitCode, activated.stderr).toBe(0);
    await fs.appendFile(path.join(workspaceRoot, 'plugins', 'dev-demo', 'README.md'), 'changed\n');
    expect((await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    const cacheRoot = path.join(env.AW_HOME!, 'catalog-cache', 'sources', activated.receipt.source.id);
    await fs.remove(path.join(cacheRoot, 'current'));
    const lastGood = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(lastGood.exitCode, lastGood.stderr).toBe(0);
    expect(lastGood.receipt).toMatchObject({
      ok: true,
      ready: false,
      cache: { state: 'last-good' },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'cacheLastGood', blocking: true }),
        expect.objectContaining({ code: 'cacheSnapshotDigestMismatch', blocking: true }),
      ]),
    });

    expect((await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    await fs.appendFile(path.join(workspaceRoot, 'plugins', 'dev-demo', 'README.md'), 'new digest\n');
    expect((await jsonCommand(['catalog', 'build', '--force', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    const mismatch = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(mismatch.exitCode, mismatch.stderr).toBe(0);
    expect(mismatch.receipt).toMatchObject({
      ok: true,
      ready: false,
      cache: { state: 'current' },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'cacheSnapshotDigestMismatch', blocking: true }),
      ]),
    });

    const current = await readCatalogSourcesConfigSnapshot(env);
    const owned = current.config.sources.find((source) => source.id === activated.receipt.source.id)!;
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          ...current.config.sources,
          { ...owned, id: 'duplicate-dev' },
        ],
      },
      expectedDigest: current.digest,
      env,
    });
    const multiple = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(multiple.exitCode, multiple.stderr).toBe(0);
    expect(multiple.receipt).toMatchObject({
      ok: true,
      ready: false,
      source: { exists: false },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'multipleManagedSources', blocking: true })]),
    });
  });

  it('separates invalid source config, cache exceptions, and absent cache diagnostics', async () => {
    const { workspaceRoot, env } = await fixture();
    expect((await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    const cacheFailure = await getCatalogDevSourceStatus({
      cwd: workspaceRoot,
      cliVersion: '1.0.0',
      env,
      runtime: { readCatalogSourceCache: async () => { throw new Error('injected cache read failure'); } },
    });
    expect(cacheFailure).toMatchObject({
      receiptSchemaVersion: 2,
      ok: false,
      ready: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'cacheInvalid', blocking: true })]),
    });
    expect(cacheFailure.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sourceConfigInvalid' }),
    ]));

    await fs.writeFile(path.join(env.AW_HOME!, 'catalog-sources.json'), '{invalid');
    const invalidConfig = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(invalidConfig.exitCode).toBe(1);
    expect(invalidConfig.receipt).toMatchObject({
      receiptSchemaVersion: 2,
      ok: false,
      ready: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceConfigInvalid', blocking: true })]),
    });
    expect(invalidConfig.receipt.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'cacheInvalid' }),
    ]));
  });

  it('preserves static Workspace diagnostic failures', async () => {
    const { workspaceRoot, env } = await fixture();
    const manifestPath = path.join(workspaceRoot, 'plugins', 'dev-demo', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    await fs.writeJson(manifestPath, { ...manifest, dependencies: ['missing-plugin'] }, { spaces: 2 });

    const status = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(status.exitCode).toBe(1);
    expect(status.receipt).toMatchObject({
      receiptSchemaVersion: 2,
      ok: false,
      ready: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'dependencyGraphInvalid', blocking: true }),
      ]),
    });
  });

  it('refuses to remove a primary managed source when no replacement exists and does not modify config', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await activateCatalogDevSource({
      cwd: workspaceRoot, cliVersion: '1.0.0', env, primary: true,
    });
    const current = await readCatalogSourcesConfigSnapshot(env);
    const managed = current.config.sources.find((source) => source.id === activated.source.id)!;
    const onlyManaged = await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [managed] },
      expectedDigest: current.digest,
      env,
    });
    const before = await fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'));

    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode).toBe(1);
    expect(deactivated.receipt.state).toBe('failed');
    expect(deactivated.receipt.errors).toEqual([
      expect.objectContaining({ code: 'replacementPrimaryUnavailable', message: expect.stringContaining('No replacement') }),
    ]);
    await expect(fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'))).resolves.toEqual(before);
    expect((await readCatalogSourcesConfigSnapshot(env)).digest).toBe(onlyManaged.digest);
  });

  it('selects the unique remaining source when official is absent', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await activateCatalogDevSource({
      cwd: workspaceRoot, cliVersion: '1.0.0', env, primary: true,
    });
    const current = await readCatalogSourcesConfigSnapshot(env);
    const managed = current.config.sources.find((source) => source.id === activated.source.id)!;
    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          managed,
          { id: 'backup', type: 'path', path: snapshotPath, primary: false },
        ],
      },
      expectedDigest: current.digest,
      env,
    });

    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode, deactivated.stderr).toBe(0);
    expect(deactivated.receipt).toMatchObject({ replacementPrimarySourceId: 'backup' });
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources).toEqual([
      expect.objectContaining({ id: 'backup', primary: true }),
    ]);
  });

  it('treats a rewritten official source as the unique ordinary replacement', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await activateCatalogDevSource({
      cwd: workspaceRoot, cliVersion: '1.0.0', env, primary: true,
    });
    const current = await readCatalogSourcesConfigSnapshot(env);
    const managed = current.config.sources.find((source) => source.id === activated.source.id)!;
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          managed,
          {
            id: 'official',
            type: 'git',
            primary: false,
            url: 'https://example.test/third-party.git',
            refPolicy: { type: 'cliChannel' },
          },
        ],
      },
      expectedDigest: current.digest,
      env,
    });

    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode, deactivated.stderr).toBe(0);
    expect(deactivated.receipt).toMatchObject({ replacementPrimarySourceId: 'official' });
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources).toEqual([
      expect.objectContaining({ id: 'official', primary: true }),
    ]);
  });

  it('does not prefer a rewritten official source over another replacement or modify config', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await activateCatalogDevSource({
      cwd: workspaceRoot, cliVersion: '1.0.0', env, primary: true,
    });
    const current = await readCatalogSourcesConfigSnapshot(env);
    const managed = current.config.sources.find((source) => source.id === activated.source.id)!;
    const configured = await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          managed,
          {
            id: 'official',
            type: 'git',
            primary: false,
            url: 'https://example.test/third-party.git',
            refPolicy: { type: 'cliChannel' },
          },
          {
            id: 'backup',
            type: 'path',
            path: path.join(workspaceRoot, '.aw', 'catalog'),
            primary: false,
          },
        ],
      },
      expectedDigest: current.digest,
      env,
    });
    const configPath = path.join(env.AW_HOME!, 'catalog-sources.json');
    const before = await fs.readFile(configPath);

    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode).toBe(1);
    expect(deactivated.receipt.state).toBe('failed');
    expect(deactivated.receipt.errors).toEqual([
      expect.objectContaining({
        code: 'replacementPrimaryAmbiguous',
        message: expect.stringContaining('backup, official'),
      }),
    ]);
    await expect(fs.readFile(configPath)).resolves.toEqual(before);
    expect((await readCatalogSourcesConfigSnapshot(env)).digest).toBe(configured.digest);
  });

  it('refuses an ambiguous primary replacement and lists the candidates without modifying config', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await activateCatalogDevSource({
      cwd: workspaceRoot, cliVersion: '1.0.0', env, primary: true,
    });
    const current = await readCatalogSourcesConfigSnapshot(env);
    const managed = current.config.sources.find((source) => source.id === activated.source.id)!;
    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          managed,
          { id: 'backup-a', type: 'path', path: snapshotPath, primary: false },
          { id: 'backup-b', type: 'path', path: snapshotPath, primary: false },
        ],
      },
      expectedDigest: current.digest,
      env,
    });
    const before = await fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'));

    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode).toBe(1);
    expect(deactivated.receipt.state).toBe('failed');
    expect(deactivated.receipt.errors[0]).toMatchObject({
      code: 'replacementPrimaryAmbiguous',
      message: expect.stringContaining('backup-a, backup-b'),
    });
    await expect(fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'))).resolves.toEqual(before);
  });

  it('reports multiple managed sources for one Workspace as an invalid ambiguous configuration', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await activateCatalogDevSource({ cwd: workspaceRoot, cliVersion: '1.0.0', env });
    const current = await readCatalogSourcesConfigSnapshot(env);
    const managed = current.config.sources.find((source) => source.id === activated.source.id)!;
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          ...current.config.sources,
          { ...managed, id: 'duplicate-dev' },
        ],
      },
      expectedDigest: current.digest,
      env,
    });

    const status = await jsonCommand(['catalog', 'dev', 'status', '--json'], workspaceRoot, env);
    expect(status.exitCode).toBe(0);
    expect(status.receipt).toMatchObject({ ok: true, ready: false });
    expect(status.receipt.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multipleManagedSources', blocking: true }),
    ]));
    const activate = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    expect(activate.exitCode).toBe(1);
    expect(activate.receipt.errors[0].code).toBe('multipleManagedSources');
    expect(activate.receipt.errors[0].message).toContain('multiple development sources');
  });

  it('requires confirmation and refuses recovery when one healthy Workspace uniquely owns the source', async () => {
    const { workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    const before = await fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'));

    const unconfirmed = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--source-id', activated.receipt.source.id, '--json',
    ], workspaceRoot, env);
    expect(unconfirmed).toMatchObject({
      exitCode: 1,
      receipt: {
        state: 'failed',
        workspaceIdentity: activated.receipt.workspaceIdentity,
        snapshotPath: activated.receipt.snapshot.path,
        errors: [{ code: 'confirmationRequired' }],
      },
    });
    const healthy = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--source-id', activated.receipt.source.id, '--yes', '--json',
    ], workspaceRoot, env);
    expect(healthy).toMatchObject({
      exitCode: 1,
      receipt: {
        state: 'failed',
        workspaceIdentity: activated.receipt.workspaceIdentity,
        snapshotPath: activated.receipt.snapshot.path,
        errors: [{ code: 'workspaceOwnerHealthy' }],
      },
    });
    await expect(fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'))).resolves.toEqual(before);
  });

  it('recovers managed sources by ID when the Workspace is removed, damaged, moved to another identity, or duplicated', async () => {
    for (const mode of ['removed', 'marker-invalid', 'metadata-invalid', 'identity-drift', 'duplicate'] as const) {
      const { root, workspaceRoot, env } = await fixture();
      const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
      const sourceId = activated.receipt.source.id as string;
      const originalIdentity = activated.receipt.workspaceIdentity as string;
      if (mode === 'removed') await fs.remove(workspaceRoot);
      if (mode === 'marker-invalid') await fs.writeFile(path.join(workspaceRoot, '.aw-workspace.json'), '{invalid');
      if (mode === 'metadata-invalid') await fs.writeFile(path.join(workspaceRoot, 'plugins', 'marketplace-source.json'), '{invalid');
      if (mode === 'identity-drift') {
        await fs.writeJson(path.join(workspaceRoot, '.aw-workspace.json'), {
          schemaVersion: 1,
          kind: 'aw-catalog-workspace',
          workspaceIdentity: 'different-workspace-identity',
        });
      }
      if (mode === 'duplicate') {
        const current = await readCatalogSourcesConfigSnapshot(env);
        const managed = current.config.sources.find((source) => source.id === sourceId)!;
        await replaceCatalogSourcesConfig({
          config: { schemaVersion: 2, sources: [...current.config.sources, { ...managed, id: 'duplicate-dev' }] },
          expectedDigest: current.digest,
          env,
        });
      }
      const snapshotExisted = await fs.pathExists(path.join(workspaceRoot, '.aw', 'catalog'));
      const recovered = await jsonCommand([
        'catalog', 'dev', 'deactivate', '--source-id', sourceId, '--yes', '--json',
      ], root, env);
      expect(recovered.exitCode, JSON.stringify(recovered.receipt)).toBe(0);
      expect(recovered.receipt).toMatchObject({
        ok: true,
        state: 'completed',
        workspaceIdentity: originalIdentity,
        snapshotPath: activated.receipt.snapshot.path,
        source: { id: sourceId, action: 'removed' },
      });
      expect((await readCatalogSourcesConfigSnapshot(env)).config.sources.some((source) => source.id === sourceId)).toBe(false);
      expect((await readCatalogGenerationState(env)).sources[sourceId]).toBeUndefined();
      if (snapshotExisted) await expect(fs.pathExists(path.join(workspaceRoot, '.aw', 'catalog'))).resolves.toBe(true);
    }
  });

  it('allows recovery when a managed source path no longer has the development snapshot shape', async () => {
    const { root, workspaceRoot, env } = await fixture();
    const activated = await jsonCommand(['catalog', 'dev', 'activate', '--json'], workspaceRoot, env);
    const current = await readCatalogSourcesConfigSnapshot(env);
    const nonStandardSnapshot = path.join(root, 'saved-snapshot');
    await fs.ensureDir(nonStandardSnapshot);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: current.config.sources.map((source) => source.id === activated.receipt.source.id
          ? { ...source, path: nonStandardSnapshot }
          : source),
      },
      expectedDigest: current.digest,
      env,
    });

    const recovered = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--source-id', activated.receipt.source.id, '--yes', '--json',
    ], workspaceRoot, env);
    expect(recovered).toMatchObject({ exitCode: 0, receipt: { snapshotPath: nonStandardSnapshot } });
    await expect(fs.pathExists(nonStandardSnapshot)).resolves.toBe(true);
  });

  it('rejects foreign, ordinary path, Git, missing, and mutually exclusive recovery targets without writing', async () => {
    const { workspaceRoot, env } = await fixture();
    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    expect((await jsonCommand(['catalog', 'build', '--json'], workspaceRoot, env)).exitCode).toBe(0);
    expect((await jsonCommand(['catalog', 'source', 'add', 'ordinary', '--path', snapshotPath, '--json'], workspaceRoot, env)).exitCode).toBe(0);
    const before = await fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'));
    for (const sourceId of ['ordinary', 'official', 'missing']) {
      const result = await jsonCommand([
        'catalog', 'dev', 'deactivate', '--source-id', sourceId, '--yes', '--json',
      ], workspaceRoot, env);
      expect(result).toMatchObject({ exitCode: 1, receipt: { state: 'failed', errors: [{ code: 'managedSourceNotFound' }] } });
      await expect(fs.readFile(path.join(env.AW_HOME!, 'catalog-sources.json'))).resolves.toEqual(before);
    }
    const exclusive = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--workspace-root', workspaceRoot,
      '--source-id', 'ordinary', '--yes', '--json',
    ], workspaceRoot, env);
    expect(exclusive).toMatchObject({ exitCode: 1, receipt: { errors: [{ code: 'invalidArguments' }] } });
  });

  it('uses an explicit replacement in recovery mode and rejects replacement for a non-primary target', async () => {
    const { workspaceRoot, env } = await fixture();
    const primary = await jsonCommand(['catalog', 'dev', 'activate', '--primary', '--json'], workspaceRoot, env);
    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    expect((await jsonCommand(['catalog', 'source', 'add', 'backup-a', '--path', snapshotPath, '--json'], workspaceRoot, env)).exitCode).toBe(0);
    expect((await jsonCommand(['catalog', 'source', 'add', 'backup-b', '--path', snapshotPath, '--json'], workspaceRoot, env)).exitCode).toBe(0);
    await fs.writeFile(path.join(workspaceRoot, '.aw-workspace.json'), '{invalid');
    const recovered = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--source-id', primary.receipt.source.id,
      '--replacement-primary', 'backup-b', '--yes', '--json',
    ], workspaceRoot, env);
    expect(recovered).toMatchObject({
      exitCode: 0,
      receipt: { replacementPrimarySourceId: 'backup-b', source: { action: 'removed', previousPrimary: true } },
    });
    expect((await readCatalogSourcesConfigSnapshot(env)).config.sources.find((source) => source.id === 'backup-b')).toMatchObject({ primary: true });

    const second = await fixture();
    const nonPrimary = await jsonCommand(['catalog', 'dev', 'activate', '--json'], second.workspaceRoot, second.env);
    const invalid = await jsonCommand([
      'catalog', 'dev', 'deactivate', '--workspace-root', second.workspaceRoot,
      '--replacement-primary', 'official', '--json',
    ], second.workspaceRoot, second.env);
    expect(invalid).toMatchObject({
      exitCode: 1,
      receipt: { state: 'failed', source: { id: nonPrimary.receipt.source.id, action: 'retained' }, errors: [{ code: 'replacementPrimaryInvalid' }] },
    });
  });
});
