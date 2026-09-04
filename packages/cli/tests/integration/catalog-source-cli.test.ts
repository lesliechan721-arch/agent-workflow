import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
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
      receiptSchemaVersion: 6,
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
      receiptSchemaVersion: 6,
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
      receiptSchemaVersion: 6,
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

  it('requires --yes only when set-primary has affected or unknown references', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'primary-clean');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'primary-affected');
    await Promise.all([fs.ensureDir(firstRoot), fs.ensureDir(secondRoot)]);
    expect((await runJson([
      'catalog', 'source', 'add', 'clean', '--path', firstRoot, '--json',
    ])).exitCode).toBe(0);
    expect((await runJson([
      'catalog', 'source', 'add', 'affected', '--path', secondRoot, '--json',
    ])).exitCode).toBe(0);

    const clean = await runJson(['catalog', 'source', 'set-primary', 'clean', '--json']);
    expect(clean.exitCode, clean.stderr).toBe(0);
    expect(clean.json).toMatchObject({
      receiptSchemaVersion: 6,
      primaryChange: { fromSourceId: 'official', toSourceId: 'clean' },
      primarySourceId: 'clean',
    });

    await fs.outputJson(path.join(
      isolation.env.AW_HOME!, 'plugin-config', 'legacy-demo', 'config.json',
    ), { enabled: true });
    await fs.outputJson(path.join(
      isolation.env.AW_CODEX_HOME!, 'skills', 'legacy-owned', SKILL_OWNER_MARKER,
    ), {
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'legacy-owned',
      artifactKey: 'legacy-owned',
      platform: 'codex',
      scope: 'user',
    });
    const blocked = await runJson(['catalog', 'source', 'set-primary', 'affected', '--json']);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.json).toMatchObject({
      receiptSchemaVersion: 6,
      primaryChange: { fromSourceId: 'clean', toSourceId: 'affected' },
      references: expect.arrayContaining([
        expect.objectContaining({ category: 'config', pluginId: 'clean/legacy-demo' }),
      ]),
      errors: [{ code: 'catalogSourceImpactConfirmationRequired' }],
    });
    expect(blocked.json.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'installation', pluginId: 'clean/legacy-owned' }),
    ]));
    const confirmed = await runJson([
      'catalog', 'source', 'set-primary', 'affected', '--yes', '--json',
    ]);
    expect(confirmed.exitCode, confirmed.stderr).toBe(0);
    expect(confirmed.json).toMatchObject({
      primaryChange: { fromSourceId: 'clean', toSourceId: 'affected' },
      primarySourceId: 'affected',
    });
  });

  it('applies add --primary confirmation and exposes its primary impact', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'add-primary-affected');
    await fs.ensureDir(sourceRoot);
    await fs.outputJson(path.join(
      isolation.env.AW_HOME!, 'plugin-config', 'legacy-demo', 'config.json',
    ), { enabled: true });

    const blocked = await runJson([
      'catalog', 'source', 'add', 'team', '--path', sourceRoot, '--primary', '--json',
    ]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.json).toMatchObject({
      receiptSchemaVersion: 6,
      command: 'catalog:source:add',
      ok: false,
      changed: false,
      primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
      references: [expect.objectContaining({ category: 'config', pluginId: 'official/legacy-demo' })],
      errors: [{ code: 'catalogSourceImpactConfirmationRequired' }],
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources)
      .not.toContainEqual(expect.objectContaining({ id: 'team' }));

    const confirmed = await runJson([
      'catalog', 'source', 'add', 'team', '--path', sourceRoot, '--primary', '--yes', '--json',
    ]);
    expect(confirmed.exitCode, confirmed.stderr).toBe(0);
    expect(confirmed.json).toMatchObject({
      receiptSchemaVersion: 6,
      command: 'catalog:source:add',
      ok: true,
      changed: true,
      primarySourceId: 'team',
      primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
      references: [expect.objectContaining({ category: 'config', pluginId: 'official/legacy-demo' })],
      errors: [],
    });
  });
});
