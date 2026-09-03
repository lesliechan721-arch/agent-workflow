import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import {
  createEmptyPluginIntentState,
  upsertPluginIntentRoot,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

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

async function runJson(args: string[]) {
  const isolation = getCurrentSourceTestIsolation();
  const output = capture();
  const exitCode = await runCli(args, {
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
    io: output.io,
  });
  return {
    exitCode,
    stdout: output.stdout(),
    stderr: output.stderr(),
    json: output.stdout() === '' ? undefined : JSON.parse(output.stdout()),
  };
}

describe('catalog source auto-check CLI', () => {
  it('adds a disabled path source and lists an explicit effective boolean for every source', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'auto-check-path');
    const enabledSourceRoot = path.join(isolation.layout.fixtureCwd, 'auto-check-default-path');
    await fs.ensureDir(sourceRoot);
    await fs.ensureDir(enabledSourceRoot);

    const added = await runJson([
      'catalog', 'source', 'add', 'local', '--path', sourceRoot, '--no-auto-check', '--json',
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.json).toMatchObject({
      receiptSchemaVersion: 5,
      command: 'catalog:source:add',
      ok: true,
      changed: true,
      sourceId: 'local',
    });
    expect((await runJson([
      'catalog', 'source', 'add', 'enabled-local', '--path', enabledSourceRoot, '--json',
    ])).exitCode).toBe(0);

    const listed = await runJson(['catalog', 'source', 'list', '--json']);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.json.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'official', autoCheck: true }),
      expect.objectContaining({ id: 'local', autoCheck: false }),
      expect.objectContaining({ id: 'enabled-local', autoCheck: true }),
    ]));

    const enabled = await runJson([
      'catalog', 'source', 'update', 'local', '--auto-check', '--json',
    ]);
    expect(enabled.exitCode, enabled.stderr).toBe(0);
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'local')).not.toHaveProperty('autoCheck');
  });

  it('accepts autoCheck-only updates in both directions without provider or Active state', async () => {
    const isolation = getCurrentSourceTestIsolation();

    const disabled = await runJson([
      'catalog', 'source', 'update', 'official', '--no-auto-check', '--json',
    ]);
    expect(disabled.exitCode, disabled.stderr).toBe(0);
    expect(disabled.json).toMatchObject({ ok: true, changed: true, sourceId: 'official' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources[0])
      .toHaveProperty('autoCheck', false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-state.json')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-store')))
      .resolves.toBe(false);

    const enabled = await runJson([
      'catalog', 'source', 'update', 'official', '--auto-check', '--json',
    ]);
    expect(enabled.exitCode, enabled.stderr).toBe(0);
    expect(enabled.json).toMatchObject({ ok: true, changed: true, sourceId: 'official' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources[0])
      .not.toHaveProperty('autoCheck');
  });

  it('rejects conflicting update switches with one JSON failure receipt', async () => {
    const result = await runJson([
      'catalog', 'source', 'update', 'official', '--auto-check', '--no-auto-check', '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      receiptSchemaVersion: 5,
      command: 'catalog:source:update',
      ok: false,
      changed: false,
      sourceId: 'official',
      errors: [{ code: 'catalogSourceOptionConflict' }],
    });
    expect(JSON.parse(result.stdout)).toEqual(result.json);
  });

  it('returns one JSON failure receipt for conflicting switches with -j', async () => {
    const result = await runJson([
      'catalog', 'source', 'update', 'official', '--auto-check', '--no-auto-check', '-j',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      receiptSchemaVersion: 5,
      command: 'catalog:source:update',
      ok: false,
      changed: false,
      sourceId: 'official',
      errors: [{ code: 'catalogSourceOptionConflict' }],
    });
    expect(JSON.parse(result.stdout)).toEqual(result.json);
    expect(result.stderr).toBe('error: option --auto-check cannot be used with option --no-auto-check\n');
  });

  it('requires --yes to remove a source with lifecycle references and returns public impact evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'remove-referenced-source');
    await fs.ensureDir(sourceRoot);
    expect((await runJson([
      'catalog', 'source', 'add', 'team', '--path', sourceRoot, '--json',
    ])).exitCode).toBe(0);
    await writePluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'team/demo', platforms: ['codex'],
    }));

    const blocked = await runJson(['catalog', 'source', 'remove', 'team', '--json']);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.json).toMatchObject({
      ok: false,
      changed: false,
      references: [{ category: 'lifecycle', sourceId: 'team', pluginId: 'team/demo' }],
      errors: [{ code: 'catalogSourceImpactConfirmationRequired' }],
    });
    expect(JSON.stringify(blocked.json)).not.toContain(isolation.layout.fixtureCwd);

    const removed = await runJson([
      'catalog', 'source', 'remove', 'team', '--yes', '--json',
    ]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.json).toMatchObject({
      ok: true,
      changed: true,
      references: [{ category: 'lifecycle', sourceId: 'team', pluginId: 'team/demo' }],
    });
  });
});
