import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activateCatalogDevSource,
  getCatalogDevSourceStatus,
} from '../../src/commands/catalog-dev-source.js';
import { runCli } from '../../src/index.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';

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
  it.each([
    ['activate', 2],
    ['status', 3],
    ['deactivate', 2],
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
      receiptSchemaVersion: 3,
      ok: true,
      ready: true,
      snapshot: { state: 'current', valid: true, digest: activated.receipt.snapshot.digest },
      source: { exists: true, pathMatches: true },
      active: { ready: true, digestMatchesSnapshot: true, snapshotDigest: activated.receipt.snapshot.digest },
    });
    expect(status.receipt.cache).toBeUndefined();
    expect(JSON.stringify(status.receipt)).not.toContain(workspaceRoot);

    const snapshotPath = path.join(workspaceRoot, '.aw', 'catalog');
    const storeRoot = path.join(env.AW_HOME!, 'catalog-store');
    const deactivated = await jsonCommand(['catalog', 'dev', 'deactivate', '--json'], workspaceRoot, env);
    expect(deactivated.exitCode, deactivated.stderr).toBe(0);
    expect(deactivated.receipt).toMatchObject({
      receiptSchemaVersion: 2, ok: true,
      source: { id: activated.receipt.source.id, action: 'removed' },
    });
    await expect(fs.pathExists(snapshotPath)).resolves.toBe(true);
    await expect(fs.pathExists(storeRoot)).resolves.toBe(true);
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
