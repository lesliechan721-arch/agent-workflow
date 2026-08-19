import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  addCatalogSourceCommand,
  listCatalogSources,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { installWriteCommand, upgradeWriteCommand } from '../../src/commands/write-commands.js';
import { runCli } from '../../src/index.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import {
  createSharedOwnerToken,
  OWNED_TEXT_HEADER_PREFIX,
} from '../../src/utils/ownership.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  prepareLifecycleActiveSnapshot,
  promoteLifecycleActiveSnapshot,
} from '../../src/utils/lifecycle-active-store.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import {
  getCurrentSourceTestIsolation,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

describe('catalog source command v4', () => {
  it('validates a path source before one CAS commit and exposes no protected path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('catalog');
    await createCatalogSnapshotFixture(sourceRoot);

    const receipt = await addCatalogSourceCommand({
      source: { id: 'local', type: 'path', primary: false, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });

    expect(receipt).toMatchObject({
      receiptSchemaVersion: 4,
      command: 'catalog:source:add',
      ok: true,
      changed: true,
      sourceId: 'local',
      primarySourceId: 'official',
      source: { sourceId: 'local', freshness: 'path' },
      references: [],
      errors: [],
    });
    expect(JSON.stringify(receipt)).not.toContain('rootDir');
    expect(JSON.stringify(receipt)).not.toContain('manifestPath');
    await expect(listCatalogSources({ env: isolation.env })).resolves.toMatchObject({
      catalogSourcesSchemaVersion: 1,
      sources: expect.arrayContaining([expect.objectContaining({ id: 'local', sourceIdentity: expect.any(String) })]),
    });
  });

  it('does not write when candidate validation fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('invalid-catalog');
    await fs.ensureDir(sourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);

    await expect(addCatalogSourceCommand({
      source: { id: 'broken', type: 'path', primary: false, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toThrow();

    await expect(readCatalogSourcesConfigSnapshot(isolation.env)).resolves.toMatchObject({
      digest: before.digest,
      materialized: false,
    });
  });

  it('allows a non-primary add only when lost namespaced references match the candidate identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('lost-source-candidate');
    await createCatalogSnapshotFixture(sourceRoot);
    const source = {
      id: 'team', type: 'path', primary: false, path: await fs.realpath(sourceRoot),
    } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = fixturePath('lost-owner');
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);

    await expect(addCatalogSourceCommand({
      source,
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        inventoryReferences: async () => ({
          inventorySchemaVersion: 1,
          references: [{
            kind: 'namespacedOwner',
            location,
            sourceId: 'team',
            sourceIdentity: `sha256:${'2'.repeat(64)}`,
            pluginName: 'demo',
            platform: 'codex',
            scope: 'project',
          }],
          errors: [],
        }),
      },
    })).rejects.toThrow('sourceChanged');
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);

    await expect(addCatalogSourceCommand({
      source,
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        inventoryReferences: async () => ({
          inventorySchemaVersion: 1,
          references: [{
            kind: 'namespacedOwner',
            location,
            sourceId: 'team',
            sourceIdentity,
            pluginName: 'demo',
            platform: 'codex',
            scope: 'project',
          }],
          errors: [],
        }),
      },
    })).resolves.toMatchObject({
      ok: true,
      source: { sourceIdentity },
      references: [expect.objectContaining({ location, sourceIdentity })],
    });
  });

  it('fails a non-primary add closed when source inventory has errors', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('add-inventory-error');
    await createCatalogSnapshotFixture(sourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);

    await expect(addCatalogSourceCommand({
      source: { id: 'team', type: 'path', primary: false, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        inventoryReferences: async () => ({
          inventorySchemaVersion: 1,
          references: [],
          errors: [{
            code: 'stateInventoryFailed',
            kind: 'configFileRead',
            location: '<AW_HOME>/plugin-config',
            message: 'permission denied',
          }],
        }),
      },
    })).rejects.toMatchObject({ code: 'stateInventoryFailed' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('keeps the catalog digest unchanged when reference inventory is unreadable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const current = fixturePath('inventory-current');
    const replacement = fixturePath('inventory-replacement');
    await Promise.all([
      createCatalogSnapshotFixture(current),
      createCatalogSnapshotFixture(replacement),
    ]);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', primary: false, path: current },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const configPath = path.join(isolation.env.AW_HOME!, 'plugin-config', 'team', 'demo', 'config.json');
    await fs.outputFile(configPath, '{invalid');
    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { type: 'path', path: replacement },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'stateInventoryFailed' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);

    await fs.outputJson(configPath, {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginName: 'demo',
      values: {},
    });
    const realReadJson = fs.readJson.bind(fs);
    const readJson = vi.spyOn(fs, 'readJson').mockImplementation((async (location, options) => {
      if (path.resolve(String(location)) === path.resolve(configPath)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realReadJson(location, options as never);
    }) as typeof fs.readJson);
    try {
      await expect(updateCatalogSourceCommand({
        sourceId: 'team',
        update: { type: 'path', path: replacement },
        cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      })).rejects.toMatchObject({ code: 'stateInventoryFailed' });
    } finally {
      readJson.mockRestore();
    }
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('reports invalid namespaced config envelopes and continues inventorying valid stores', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('config-envelope-source');
    const replacement = fixturePath('config-envelope-replacement');
    await Promise.all([
      createCatalogSnapshotFixture(sourceRoot),
      createCatalogSnapshotFixture(replacement),
    ]);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', primary: false, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const sourceIdentity = (await listCatalogSources({ env: isolation.env })).sources
      .find((source) => source.id === 'team')!.sourceIdentity;
    const configRoot = path.join(isolation.env.AW_HOME!, 'plugin-config');
    const validPath = path.join(configRoot, 'team', 'valid', 'config.json');
    const invalidStores = [
      ['bad-schema', {
        schemaVersion: 2, sourceId: 'team', sourceIdentity, pluginName: 'bad-schema', values: [],
      }],
      ['bad-source', {
        schemaVersion: 2, sourceId: 'other', sourceIdentity, pluginName: 'bad-source', values: {},
      }],
      ['bad-plugin', {
        schemaVersion: 2, sourceId: 'team', sourceIdentity, pluginName: 'other', values: {},
      }],
      ['bad-identity', {
        schemaVersion: 2, sourceId: 'team', sourceIdentity: 'invalid', pluginName: 'bad-identity', values: {},
      }],
    ] as const;
    await Promise.all([
      fs.outputJson(validPath, {
        schemaVersion: 2, sourceId: 'team', sourceIdentity, pluginName: 'valid', values: {},
      }),
      ...invalidStores.map(([pluginName, value]) =>
        fs.outputJson(path.join(configRoot, 'team', pluginName, 'config.json'), value)),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedConfig', location: validPath, sourceIdentity, pluginName: 'valid',
    }));
    expect(inventory.errors).toEqual(expect.arrayContaining(invalidStores.map(([pluginName]) =>
      expect.objectContaining({
        code: 'stateInventoryFailed',
        kind: 'configFileValidation',
        location: expect.stringContaining(pluginName),
      }))));
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { type: 'path', path: replacement },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'stateInventoryFailed' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('fails a source identity mutation closed on a corrupt canonical owner marker', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const current = fixturePath('owner-inventory-current');
    const replacement = fixturePath('owner-inventory-replacement');
    await Promise.all([
      createCatalogSnapshotFixture(current),
      createCatalogSnapshotFixture(replacement),
    ]);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', primary: false, path: current },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    await fs.outputFile(path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'corrupt-owner',
      '.agent-workflows-owner.json',
    ), '{invalid');
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);

    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { type: 'path', path: replacement },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'stateInventoryFailed' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('rejects a CAS race after validation without overwriting the winning config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('first');
    const second = fixturePath('second');
    await Promise.all([createCatalogSnapshotFixture(first), createCatalogSnapshotFixture(second)]);

    await expect(addCatalogSourceCommand({
      source: { id: 'first', type: 'path', primary: false, path: first },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        afterValidation: async () => {
          await addCatalogSourceCommand({
            source: { id: 'second', type: 'path', primary: false, path: second },
            cliVersion: '1.0.0',
            cwd: isolation.layout.fixtureCwd,
            env: isolation.env,
          });
        },
      },
    })).rejects.toThrow('changed after it was read');

    expect((await listCatalogSources({ env: isolation.env })).sources.map((source) => source.id))
      .toEqual(['official', 'second']);
  });

  it('blocks primary changes for legacy references but permits a ref-only update', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('catalog');
    await createCatalogSnapshotFixture(sourceRoot);
    await addCatalogSourceCommand({
      source: { id: 'local', type: 'path', primary: false, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const legacyInventory = async () => ({
      inventorySchemaVersion: 1 as const,
      references: [{ kind: 'legacyConfig' as const, location: fixturePath('legacy') }],
    });

    await expect(setPrimaryCatalogSourceCommand({
      sourceId: 'local',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: { inventoryReferences: legacyInventory },
    })).rejects.toMatchObject({ code: 'legacyStateUnsupported' });
    expect((await listCatalogSources({ env: isolation.env })).primarySourceId).toBe('official');

    const repository = fixturePath('git-catalog');
    await createCatalogSnapshotFixture(repository);
    await git(repository, ['init', '--initial-branch=main']);
    await git(repository, ['config', 'user.email', 'test@example.test']);
    await git(repository, ['config', 'user.name', 'AW Test']);
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-m', 'catalog']);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const withGit = await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{
          id: 'official',
          type: 'git',
          primary: true,
          url: repository,
          refPolicy: { type: 'explicit', ref: 'HEAD' },
        }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await expect(updateCatalogSourceCommand({
      sourceId: 'official',
      update: { type: 'git', refPolicy: { type: 'explicit', ref: 'refs/heads/main' } },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: { inventoryReferences: legacyInventory },
    })).resolves.toMatchObject({ ok: true, sourceId: 'official' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).not.toBe(withGit.digest);
  });

  it('checks every existing source reference before add --primary changes primary', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('new-primary');
    await createCatalogSnapshotFixture(sourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const location = fixturePath('old-primary-owner');
    await expect(addCatalogSourceCommand({
      source: { id: 'new-primary', type: 'path', primary: true, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        inventoryReferences: async () => ({
          inventorySchemaVersion: 1,
          references: [{
            kind: 'namespacedOwner',
            location,
            sourceId: 'official',
            sourceIdentity: `sha256:${'1'.repeat(64)}`,
            pluginName: 'demo',
            platform: 'codex',
            scope: 'user',
          }],
        }),
      },
    })).rejects.toMatchObject({
      code: 'catalogSourceInUse',
      inventory: { references: [expect.objectContaining({ location, sourceId: 'official' })] },
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('prints one JSON object for a successful public add', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('catalog');
    await createCatalogSnapshotFixture(sourceRoot);
    const captured = createCapturedCliIo();

    const exitCode = await runCli([
      'catalog', 'source', 'add', 'local', '--path', sourceRoot, '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      ok: true,
      sourceId: 'local',
    });
    expect(captured.readStdout().trim().startsWith('{')).toBe(true);
    expect(captured.readStdout().trim().endsWith('}')).toBe(true);
    expect(captured.readStderr()).toBe('');
  });

  it('prints one JSON failure receipt and keeps config unchanged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const invalidRoot = fixturePath('invalid');
    await fs.ensureDir(invalidRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const captured = createCapturedCliIo();

    const exitCode = await runCli([
      'catalog', 'source', 'add', 'broken', '--path', invalidRoot, '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      command: 'catalog:source:add',
      ok: false,
      changed: false,
      sourceId: 'broken',
      errors: [expect.objectContaining({ message: expect.any(String) })],
    });
    expect(captured.readStderr()).not.toBe('');
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('returns sourceChanged from public non-primary add when lost state has another identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('public-lost-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const configPath = path.join(isolation.env.AW_HOME!, 'plugin-config', 'team', 'demo', 'config.json');
    await fs.outputJson(configPath, {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity: `sha256:${'4'.repeat(64)}`,
      pluginName: 'demo',
      values: {},
    });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const captured = createCapturedCliIo();

    expect(await runCli([
      'catalog', 'source', 'add', 'team', '--path', sourceRoot, '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      command: 'catalog:source:add',
      ok: false,
      changed: false,
      sourceId: 'team',
      errors: [expect.objectContaining({ code: 'sourceChanged' })],
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('redacts invalid Git snapshot paths from add and update JSON failures', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const invalidRepository = fixturePath('invalid-git-catalog');
    await Promise.all([
      fs.ensureDir(path.join(invalidRepository, '.agents')),
      fs.ensureDir(path.join(invalidRepository, '.claude-plugin')),
      fs.ensureDir(path.join(invalidRepository, 'plugins')),
    ]);
    await fs.outputFile(path.join(invalidRepository, 'catalog-manifest.json'), '{invalid');
    await git(invalidRepository, ['init', '--initial-branch=main']);
    await git(invalidRepository, ['config', 'user.email', 'test@example.test']);
    await git(invalidRepository, ['config', 'user.name', 'AW Test']);
    await git(invalidRepository, ['add', '.']);
    await git(invalidRepository, ['commit', '-m', 'invalid catalog']);

    const add = createCapturedCliIo();
    expect(await runCli([
      'catalog', 'source', 'add', 'broken', '--git', invalidRepository, '--ref', 'refs/heads/main', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: add.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(add.readStdout())).toMatchObject({
      sourceId: 'broken',
      errors: [expect.objectContaining({ code: expect.any(String) })],
    });

    const validRepository = fixturePath('valid-git-catalog');
    await createCatalogSnapshotFixture(validRepository);
    await git(validRepository, ['init', '--initial-branch=main']);
    await git(validRepository, ['config', 'user.email', 'test@example.test']);
    await git(validRepository, ['config', 'user.name', 'AW Test']);
    await git(validRepository, ['add', '.']);
    await git(validRepository, ['commit', '-m', 'valid catalog']);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{
          id: 'official',
          type: 'git',
          primary: true,
          url: validRepository,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const update = createCapturedCliIo();
    expect(await runCli([
      'catalog', 'source', 'update', 'official', '--git', invalidRepository, '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: update.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(update.readStdout())).toMatchObject({
      sourceId: 'official',
      errors: [expect.objectContaining({ code: expect.any(String) })],
    });
    for (const output of [add, update]) {
      const text = `${output.readStdout()}${output.readStderr()}`;
      for (const secret of [
        isolation.env.AW_HOME!,
        invalidRepository,
        'catalog-cache',
        '.materialize-',
      ]) expect(text).not.toContain(secret);
    }
  });

  it('redacts an invalid path source outside managed and temporary roots from add/update receipts', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const outsideSource = await fs.mkdtemp(path.join(isolation.repositoryCwd, '.aw-review5-path-'));
    registerCurrentTestWritableStateRoot(outsideSource, 'review5 external path source');
    try {
      await Promise.all([
        fs.ensureDir(path.join(outsideSource, '.agents')),
        fs.ensureDir(path.join(outsideSource, '.claude-plugin')),
        fs.ensureDir(path.join(outsideSource, 'plugins')),
      ]);
      await fs.outputFile(path.join(outsideSource, 'catalog-manifest.json'), '{invalid');

      const add = createCapturedCliIo();
      expect(await runCli([
        'catalog', 'source', 'add', 'private-path', '--path', outsideSource, '--json',
      ], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: add.io,
        interactive: false,
      })).toBe(1);
      expect(JSON.parse(add.readStdout())).toMatchObject({
        sourceId: 'private-path',
        errors: [expect.objectContaining({ code: expect.any(String) })],
      });

      const valid = fixturePath('valid-path-catalog');
      await createCatalogSnapshotFixture(valid);
      const before = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 1,
          sources: [{ id: 'official', type: 'path', primary: true, path: valid }],
        },
        expectedDigest: before.digest,
        env: isolation.env,
      });
      const update = createCapturedCliIo();
      expect(await runCli([
        'catalog', 'source', 'update', 'official', '--path', outsideSource, '--json',
      ], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: update.io,
        interactive: false,
      })).toBe(1);
      expect(JSON.parse(update.readStdout())).toMatchObject({
        sourceId: 'official',
        errors: [expect.objectContaining({ code: expect.any(String) })],
      });
      for (const output of [add, update]) {
        expect(`${output.readStdout()}${output.readStderr()}`).not.toContain(outsideSource);
      }
    } finally {
      await fs.remove(outsideSource);
    }
  });

  it('recognizes no-subdir and rejects conflicting subdir options', async () => {
    const captured = createCapturedCliIo();
    expect(await runCli([
      'catalog', 'source', 'update', 'missing', '--no-subdir', '--json',
    ], { interactive: false, io: captured.io })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      sourceId: 'missing',
      errors: [expect.objectContaining({ message: expect.stringContaining('does not exist') })],
    });

    const conflict = createCapturedCliIo();
    expect(await runCli([
      'catalog', 'source', 'update', 'missing', '--subdir', 'catalog', '--no-subdir', '--json',
    ], { interactive: false, io: conflict.io })).toBe(1);
    expect(JSON.parse(conflict.readStdout())).toMatchObject({
      ok: false,
      changed: false,
      errors: [{ code: 'catalogSourceOptionConflict' }],
    });
    expect(conflict.readStderr()).toContain('cannot be used with option');
  });

  it('returns legacyStateUnsupported without changing primary for a real legacy store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('catalog');
    await createCatalogSnapshotFixture(sourceRoot);
    await addCatalogSourceCommand({
      source: { id: 'local', type: 'path', primary: false, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    await fs.outputJson(
      path.join(isolation.env.AW_HOME!, 'plugin-config', 'demo', 'config.json'),
      { version: 1, values: {} },
    );
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const captured = createCapturedCliIo();

    expect(await runCli([
      'catalog', 'source', 'set-primary', 'local', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      ok: false,
      changed: false,
      references: [expect.objectContaining({ kind: 'legacyConfig' })],
      errors: [expect.objectContaining({ code: 'legacyStateUnsupported' })],
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('scans project owners from repoRoot when invoked in a nested directory', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const repoRoot = fixturePath('repo');
    const nested = path.join(repoRoot, 'packages', 'nested');
    const marker = path.join(repoRoot, '.agents', 'skills', 'demo', '.agent-workflows-owner.json');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(nested);
    await fs.outputJson(marker, {
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'demo',
      artifactKey: 'demo',
      platform: 'codex',
      scope: 'project',
    });

    await expect(inventoryCatalogSourceReferences({ cwd: nested, env: isolation.env }))
      .resolves.toMatchObject({
        references: expect.arrayContaining([
          expect.objectContaining({ kind: 'legacyOwner', location: marker }),
        ]),
      });
  });

  it('uses structured Codex and Claude marketplace parsing for long documents', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const codexConfig = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const claudeSettings = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
    const claudeKnown = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'known_marketplaces.json',
    );
    await fs.outputFile(codexConfig, `${'# filler\n'.repeat(300)}[marketplaces.aw]\nsource = "/catalog"\n`);
    await fs.outputJson(claudeSettings, {
      padding: 'x'.repeat(1000),
      extraKnownMarketplaces: { aw: '/catalog' },
    });
    await fs.outputJson(claudeKnown, {
      padding: 'x'.repeat(1000),
      consumers: [{ marketplace: 'aw', plugin: 'demo' }],
    });

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual(expect.arrayContaining([
      { kind: 'legacyMarketplace', location: codexConfig },
      { kind: 'legacyMarketplace', location: claudeSettings },
      { kind: 'legacyMarketplace', location: claudeKnown },
    ]));
  });

  it('classifies aw consumers by their exact registered root and reports old/new coexistence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'primary');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'primary',
        sourceIdentity: `sha256:${'1'.repeat(64)}`,
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), { name: 'aw' }),
    ]);
    const codexConfig = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await fs.outputFile(codexConfig, [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.env.AW_HOME)}`,
      'source_type = "local"',
      '[plugins."demo@aw"]',
      'enabled = true',
    ].join('\n'));
    await expect(inventoryCatalogSourceReferences({ cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({
        references: expect.arrayContaining([
          expect.objectContaining({ kind: 'legacyMarketplace', location: codexConfig }),
        ]),
      });

    await fs.outputFile(codexConfig, [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      'source_type = "local"',
      '[plugins."demo@aw"]',
      'enabled = true',
    ].join('\n'));
    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      kind: 'legacyMarketplace',
      location: codexConfig,
    }));
    expect(inventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedMarketplace',
      sourceId: 'primary',
      pluginName: 'demo',
      marketplaceName: 'aw',
    }));
  });

  it('reports malformed marketplace roots while retaining native consumer evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const teamSourceRoot = fixturePath('strict-root-team-source');
    await createCatalogSnapshotFixture(teamSourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          ...before.config.sources.map((source) => ({ ...source, primary: source.id === 'official' })),
          { id: 'team', type: 'path' as const, primary: false, path: teamSourceRoot },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const primaryRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const secondaryRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const teamIdentity = `sha256:${'7'.repeat(64)}`;
    await Promise.all([
      fs.outputJson(path.join(primaryRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'official',
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(primaryRoot, '.agents', 'plugins', 'marketplace.json'), { name: 'aw' }),
      fs.outputJson(path.join(secondaryRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: teamIdentity,
        marketplaceName: 'aw-team',
      }),
      fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(primaryRoot)}`,
        'source_type = "local"',
        '[plugins."primary-demo@aw"]',
        'enabled = true',
        '[marketplaces.aw-team]',
        `source = ${JSON.stringify(secondaryRoot)}`,
        'source_type = "local"',
        '[plugins."secondary-demo@aw-team"]',
        'enabled = true',
      ].join('\n')),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'namespacedMarketplace', sourceId: 'official', pluginName: 'primary-demo', marketplaceName: 'aw',
      }),
      expect.objectContaining({
        kind: 'namespacedMarketplace', sourceId: 'team', sourceIdentity: teamIdentity,
        pluginName: 'secondary-demo', marketplaceName: 'aw-team',
      }),
    ]));
    expect(inventory.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stateInventoryFailed', kind: 'marketplaceRootValidation' }),
      expect.objectContaining({ code: 'stateInventoryFailed', kind: 'marketplaceRootValidation' }),
    ]));
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'stateInventoryFailed' });
  });

  it('fails closed for primary and secondary non-directory marketplace namespace roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primarySource = fixturePath('invalid-root-primary-source');
    const teamSource = fixturePath('invalid-root-team-source');
    const replacementSource = fixturePath('invalid-root-replacement-source');
    const addedSource = fixturePath('invalid-root-added-source');
    await Promise.all([
      createCatalogSnapshotFixture(primarySource, 'primary-demo'),
      createCatalogSnapshotFixture(teamSource, 'team-demo'),
      createCatalogSnapshotFixture(replacementSource, 'replacement-demo'),
      createCatalogSnapshotFixture(addedSource, 'added-demo'),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'primary', type: 'path', primary: true, path: primarySource },
          { id: 'team', type: 'path', primary: false, path: teamSource },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const marketplacesRoot = path.join(isolation.env.AW_HOME!, 'marketplaces');
    const primaryRoot = path.join(marketplacesRoot, 'primary');
    const teamRoot = path.join(marketplacesRoot, 'team');
    const symlinkTarget = fixturePath('private-marketplace-target');
    await Promise.all([
      fs.outputJson(path.join(symlinkTarget, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'primary',
        sourceIdentity: `sha256:${'9'.repeat(64)}`,
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(symlinkTarget, '.agents', 'plugins', 'marketplace.json'), { name: 'aw' }),
      fs.ensureDir(marketplacesRoot),
    ]);
    await fs.ensureSymlink(symlinkTarget, primaryRoot, 'dir');
    await fs.outputFile(teamRoot, 'not a directory');
    await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(primaryRoot)}`,
      'source_type = "local"',
      '[plugins."primary-demo@aw"]',
      'enabled = true',
      '[marketplaces.aw-team]',
      `source = ${JSON.stringify(teamRoot)}`,
      'source_type = "local"',
      '[plugins."team-demo@aw-team"]',
      'enabled = true',
    ].join('\n'));

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'namespacedMarketplace', sourceId: 'primary', marketplaceName: 'aw',
        pluginName: 'primary-demo', platform: 'codex', scope: 'user',
      }),
      expect.objectContaining({
        kind: 'namespacedMarketplace', sourceId: 'team', marketplaceName: 'aw-team',
        pluginName: 'team-demo', platform: 'codex', scope: 'user',
      }),
    ]));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      kind: 'namespacedMarketplace', sourceIdentity: `sha256:${'9'.repeat(64)}`,
    }));
    expect(inventory.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stateInventoryFailed', kind: 'marketplaceRootValidation',
        location: '[aw-state]/marketplaces/primary',
      }),
      expect.objectContaining({
        code: 'stateInventoryFailed', kind: 'marketplaceRootValidation',
        location: '[aw-state]/marketplaces/team',
      }),
    ]));
    expect(JSON.stringify(inventory.errors)).not.toContain(isolation.env.AW_HOME!);
    expect(JSON.stringify(inventory.errors)).not.toContain(symlinkTarget);

    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const captured = createCapturedCliIo();
    expect(await runCli([
      'catalog', 'source', 'remove', 'team', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(1);
    const publicReceipt = JSON.parse(captured.readStdout());
    expect(publicReceipt).toMatchObject({
      ok: false,
      changed: false,
      errors: [expect.objectContaining({ code: 'stateInventoryFailed' })],
    });
    expect(JSON.stringify(publicReceipt.errors)).not.toContain(isolation.env.AW_HOME!);
    expect(JSON.stringify(publicReceipt.errors)).not.toContain(symlinkTarget);
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
    const mutations = [
      () => removeCatalogSourceCommand({
        sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }),
      () => updateCatalogSourceCommand({
        sourceId: 'team', update: { type: 'path', path: replacementSource }, cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }),
      () => setPrimaryCatalogSourceCommand({
        sourceId: 'team', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }),
      () => addCatalogSourceCommand({
        source: { id: 'added', type: 'path', primary: false, path: addedSource }, cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }),
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({ code: 'stateInventoryFailed' });
      expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
    }
  });

  it('does not follow symlinked config or lifecycle namespace roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const currentSource = fixturePath('namespace-symlink-current-source');
    const replacementSource = fixturePath('namespace-symlink-replacement-source');
    await Promise.all([
      createCatalogSnapshotFixture(currentSource),
      createCatalogSnapshotFixture(replacementSource),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          ...initial.config.sources,
          { id: 'team', type: 'path', primary: false, path: currentSource },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const sourceIdentity = `sha256:${'8'.repeat(64)}`;
    const configTarget = fixturePath('private-config-namespace');
    const lifecycleTarget = fixturePath('private-lifecycle-namespace');
    await Promise.all([
      fs.outputJson(path.join(configTarget, 'demo', 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity,
        pluginName: 'demo',
        values: {},
      }),
      fs.ensureDir(lifecycleTarget),
      fs.ensureDir(path.join(isolation.env.AW_HOME!, 'plugin-config')),
      fs.ensureDir(path.join(isolation.env.AW_HOME!, 'lifecycle-active')),
    ]);
    await Promise.all([
      fs.ensureSymlink(
        configTarget,
        path.join(isolation.env.AW_HOME!, 'plugin-config', 'team'),
        'dir',
      ),
      fs.ensureSymlink(
        lifecycleTarget,
        path.join(isolation.env.AW_HOME!, 'lifecycle-active', 'team'),
        'dir',
      ),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      kind: 'namespacedConfig', sourceId: 'team', sourceIdentity,
    }));
    expect(inventory.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stateInventoryFailed', kind: 'configNamespaceValidation',
        location: '[aw-state]/plugin-config/team',
      }),
      expect.objectContaining({
        code: 'stateInventoryFailed', kind: 'lifecycleNamespaceValidation',
        location: '[aw-state]/lifecycle-active/team',
      }),
    ]));
    expect(JSON.stringify(inventory.errors)).not.toContain(isolation.env.AW_HOME!);
    expect(JSON.stringify(inventory.errors)).not.toContain(configTarget);
    expect(JSON.stringify(inventory.errors)).not.toContain(lifecycleTarget);

    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { type: 'path', path: replacementSource },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'stateInventoryFailed' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });

  it('reports marketplace namespace lstat errors and continues other namespaces', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const officialRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const teamRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(officialRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'official',
        sourceIdentity: `sha256:${'1'.repeat(64)}`,
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(officialRoot, '.agents', 'plugins', 'marketplace.json'), { name: 'aw' }),
      fs.outputJson(path.join(teamRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: `sha256:${'2'.repeat(64)}`,
        marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(teamRoot, '.agents', 'plugins', 'marketplace.json'), { name: 'aw-team' }),
      fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(officialRoot)}`,
        'source_type = "local"',
        '[plugins."official-demo@aw"]',
        'enabled = true',
      ].join('\n')),
    ]);
    const realLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation((async (location) => {
      if (path.resolve(String(location)) === path.resolve(officialRoot)) {
        throw Object.assign(new Error(`permission denied: ${officialRoot}`), { code: 'EACCES' });
      }
      return realLstat(location);
    }) as typeof fs.lstat);
    let inventory;
    try {
      inventory = await inventoryCatalogSourceReferences({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      });
    } finally {
      lstat.mockRestore();
    }

    expect(inventory.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stateInventoryFailed',
        kind: 'marketplaceRootValidation',
        location: '[aw-state]/marketplaces/official',
        message: 'permission denied: [aw-state]/marketplaces/official',
      }),
    ]));
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'namespacedMarketplace', sourceId: 'official', pluginName: 'official-demo',
      }),
      expect.objectContaining({
        kind: 'namespacedMarketplace', sourceId: 'team', sourceIdentity: `sha256:${'2'.repeat(64)}`,
      }),
    ]));
    expect(JSON.stringify(inventory.errors)).not.toContain(isolation.env.AW_HOME!);
  });

  it('blocks source mutations for a canonical marketplace root without consumers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = fixturePath('marketplace-root-primary');
    const teamRoot = fixturePath('marketplace-root-team');
    await Promise.all([
      createCatalogSnapshotFixture(primaryRoot, 'primary-demo'),
      createCatalogSnapshotFixture(teamRoot, 'team-demo'),
    ]);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'primary', type: 'path', primary: true, path: primaryRoot },
          { id: 'team', type: 'path', primary: false, path: teamRoot },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const configPath = path.join(marketplaceRoot, 'config.json');
    await Promise.all([
      fs.outputJson(configPath, {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: `sha256:${'1'.repeat(64)}`,
        marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw-team',
      }),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toContainEqual({
      kind: 'namespacedMarketplace',
      location: configPath,
      sourceId: 'team',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      marketplaceName: 'aw-team',
    });
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({
      code: 'catalogSourceInUse',
      inventory: { references: [expect.objectContaining({ location: configPath, sourceId: 'team' })] },
    });
    await expect(setPrimaryCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({
      code: 'catalogSourceInUse',
      inventory: { references: expect.arrayContaining([expect.objectContaining({ location: configPath })]) },
    });
  });

  it('fails closed for structured schema 1 shared owners', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('legacy-shared-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'official', type: 'path', primary: true, path: sourceRoot },
          { id: 'team', type: 'path', primary: false, path: sourceRoot },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const projectCodexConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const instructionBlock = [
      '[[aw-managed:start plugin="legacy-instructions" kind="developer_instructions"]]',
      'Legacy managed instructions.',
      '[[aw-managed:end plugin="legacy-instructions"]]',
    ].join('\n');
    await fs.outputFile(projectCodexConfig, [
      `developer_instructions = ${JSON.stringify(instructionBlock)}`,
      '[mcp_servers.legacy-mcp]',
      'command = "node"',
      '[mcp_servers.legacy-mcp.env]',
      'AW_AGENT_WORKFLOWS_OWNER = "legacy-mcp"',
      '',
    ].join('\n'));
    const legacyHookOwner = {
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'legacy-hook',
      artifactKey: 'legacy-hook',
      platform: 'codex',
      scope: 'project',
    };
    await fs.outputJson(path.join(isolation.layout.fixtureCwd, '.codex', 'hooks.json'), {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: `${OWNED_TEXT_HEADER_PREFIX}${JSON.stringify(legacyHookOwner)}\nnode legacy-hook.js`,
          }],
        }],
      },
    });
    await fs.outputJson(path.join(isolation.layout.fixtureCwd, '.claude', 'settings.json'), {
      awGenerated: {
        permissions: {
          'legacy-permissions': { allow: ['Bash(git:*)'], ask: [], deny: [] },
        },
      },
    });

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'legacyOwner', pluginName: 'legacy-instructions', platform: 'codex', scope: 'project',
      }),
      expect.objectContaining({
        kind: 'legacyOwner', pluginName: 'legacy-mcp', platform: 'codex', scope: 'project',
      }),
      expect.objectContaining({
        kind: 'legacyOwner', pluginName: 'legacy-hook', platform: 'codex', scope: 'project',
      }),
      expect.objectContaining({
        kind: 'legacyOwner', pluginName: 'legacy-permissions', platform: 'claude', scope: 'project',
      }),
    ]));

    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'legacyStateUnsupported' });
    await expect(installWriteCommand(['official/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env })).resolves.toMatchObject({
      overallState: 'failed',
      targetResults: expect.arrayContaining([
        expect.objectContaining({ errorCode: 'legacyStateUnsupported' }),
      ]),
    });
    await expect(upgradeWriteCommand([], {
      all: true,
      cwd: isolation.layout.fixtureCwd,
      platform: 'claude',
      scope: 'project',
    }, { env: isolation.env })).resolves.toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        errorCode: 'legacyStateUnsupported',
        target: expect.objectContaining({
          pluginName: 'legacy-permissions', platform: 'claude', scope: 'project',
        }),
      })],
    });
    const status = createCapturedCliIo();
    expect(await runCli([
      'status', 'legacy-instructions', '--platform', 'codex', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: status.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(status.readStdout())).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'legacyStateUnsupported' }),
      ]),
    });
  });

  it('keeps valid shared owner references after malformed tokens and hook headers in the same containers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceIdentity = `sha256:${'3'.repeat(64)}`;
    const token = (plugin: string, artifactKey: string, platform: 'codex' | 'claude') =>
      createSharedOwnerToken({
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: `team/${plugin}`,
        plugin,
        artifactKey,
        platform,
        scope: 'project',
      });
    const codexConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await fs.outputFile(codexConfigPath, [
      '[mcp_servers.bad]',
      'command = "node"',
      '[mcp_servers.bad.env]',
      'AW_AGENT_WORKFLOWS_OWNER = "aw-owner-v2:invalid"',
      '[mcp_servers.good]',
      'command = "node"',
      '[mcp_servers.good.env]',
      `AW_AGENT_WORKFLOWS_OWNER = ${JSON.stringify(token('good-mcp', 'mcp-good', 'codex'))}`,
      '',
    ].join('\n'));
    const claudeSettingsPath = path.join(isolation.layout.fixtureCwd, '.claude', 'settings.json');
    await fs.outputJson(claudeSettingsPath, {
      awGenerated: {
        permissions: {
          'aw-owner-v2:invalid': { allow: [], ask: [], deny: [] },
          [token('good-permission', 'permissions', 'claude')]: { allow: [], ask: [], deny: [] },
        },
      },
    });
    const goodHookOwner = {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'team',
      sourceIdentity,
      pluginId: 'team/good-hook',
      plugin: 'good-hook',
      artifactKey: 'hook-good',
      platform: 'codex',
      scope: 'project',
    };
    const hooksPath = path.join(isolation.layout.fixtureCwd, '.codex', 'hooks.json');
    await fs.outputJson(hooksPath, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `${OWNED_TEXT_HEADER_PREFIX}{invalid\nnode bad.js` }] },
          { hooks: [{
            type: 'command',
            command: `${OWNED_TEXT_HEADER_PREFIX}${JSON.stringify(goodHookOwner)}\nnode good.js`,
          }] },
        ],
      },
    });

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });

    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'namespacedOwner', pluginName: 'good-mcp', sourceId: 'team' }),
      expect.objectContaining({ kind: 'namespacedOwner', pluginName: 'good-permission', sourceId: 'team' }),
      expect.objectContaining({ kind: 'namespacedOwner', pluginName: 'good-hook', sourceId: 'team' }),
    ]));
    expect(inventory.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'sharedOwnerTokenParse', location: expect.stringContaining('config.toml') }),
      expect.objectContaining({ kind: 'sharedOwnerTokenParse', location: expect.stringContaining('settings.json') }),
      expect.objectContaining({ kind: 'ownerHeaderParse', location: expect.stringContaining('hooks.json') }),
    ]));
  });

  it('includes centralized Claude and lifecycle project records only for source mutation preflight', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('centralized-source');
    await createCatalogSnapshotFixture(sourceRoot);
    await addCatalogSourceCommand({
      source: { id: 'team', type: 'path', primary: false, path: sourceRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const sourceIdentity = (await listCatalogSources({ env: isolation.env })).sources
      .find((source) => source.id === 'team')!.sourceIdentity!;
    const historicalProject = path.join(isolation.layout.fixtureCwd, '..', 'historical-project');
    await fs.ensureDir(path.join(historicalProject, '.git'));
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.scripts = {
      timeoutMs: 10_000,
      lifecycle: {
        uninstall: { default: { runner: 'node', path: './scripts/uninstall.mjs' } },
      },
    };
    await fs.outputJson(manifestPath, manifest);
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'uninstall.mjs'), 'export default true;\n');
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    plugin.sourceId = 'team';
    plugin.sourceIdentity = sourceIdentity;
    plugin.pluginId = 'team/demo';
    const prepared = await prepareLifecycleActiveSnapshot({
      sourceId: 'team',
      sourceIdentity,
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: historicalProject,
      env: isolation.env,
      loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
    });
    expect(prepared.status).toBe('staged');
    await promoteLifecycleActiveSnapshot(prepared);
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: `sha256:${'1'.repeat(64)}`,
        marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw-team',
      }),
      fs.outputJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json'), {
        plugins: {
          'demo@aw-team': [{
            name: 'demo',
            marketplace: 'aw-team',
            scope: 'project',
            projectPath: historicalProject,
          }],
        },
      }),
    ]);

    const currentOnly = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(currentOnly.references).not.toContainEqual(expect.objectContaining({
      kind: 'namespacedMarketplace',
      sourceId: 'team',
      pluginName: 'demo',
      scope: 'project',
    }));
    const centralized = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      includeHistoricalProjects: true,
    });
    expect(centralized.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'namespacedMarketplace',
        sourceId: 'team',
        pluginName: 'demo',
        scope: 'project',
      }),
      expect.objectContaining({ kind: 'namespacedLifecycle', sourceId: 'team' }),
    ]));
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogSourceInUse' });
  });

  it.each([
    {
      name: 'frontmatter owner',
      arrange: async (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) => {
        await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
        const location = path.join(isolation.layout.fixtureCwd, '.agents', 'rules', 'demo.md');
        await fs.outputFile(location, [
          '---',
          'description: demo',
          '---',
          '# agent-workflows-owner: {"schemaVersion":1,"owner":"agent-workflows","plugin":"demo","artifactKey":"demo","platform":"codex","scope":"project"}',
          'content',
          '',
        ].join('\n'));
        return location;
      },
      kind: 'legacyOwner',
    },
    {
      name: 'Claude installed plugin consumer',
      arrange: async (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) => {
        const location = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json');
        await fs.outputJson(location, { plugins: { 'demo@aw': [{ version: '1.0.0', scope: 'user' }] } });
        return location;
      },
      kind: 'legacyMarketplace',
    },
    {
      name: 'Claude enabled plugin consumer',
      arrange: async (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) => {
        const location = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
        await fs.outputJson(location, { enabledPlugins: { 'demo@aw': true } });
        return location;
      },
      kind: 'legacyMarketplace',
    },
    {
      name: 'Codex plugin snapshot consumer',
      arrange: async (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) => {
        const location = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
        await fs.outputFile(location, '[plugins."demo@aw"]\nenabled = true\n');
        return location;
      },
      kind: 'legacyMarketplace',
    },
    {
      name: 'legacy Codex user overlay owner',
      arrange: async (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) => {
        const location = path.join(
          isolation.env.AW_HOME!,
          'plugins',
          'demo',
          'skills',
          'demo',
          '.agent-workflows-owner.json',
        );
        await fs.outputJson(location, {
          schemaVersion: 1,
          owner: 'agent-workflows',
          plugin: 'demo',
          artifactKey: 'demo',
          platform: 'codex',
          scope: 'user',
        });
        return location;
      },
      kind: 'legacyOwner',
    },
  ])('blocks source identity mutations for a real $name store', async ({ arrange, kind }) => {
    const isolation = getCurrentSourceTestIsolation();
    const local = fixturePath('local');
    const replacement = fixturePath('replacement');
    await Promise.all([
      createCatalogSnapshotFixture(local),
      createCatalogSnapshotFixture(replacement),
    ]);
    await addCatalogSourceCommand({
      source: { id: 'local', type: 'path', primary: false, path: local },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const location = await arrange(isolation);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind, location }),
    ]));
    await expect(setPrimaryCatalogSourceCommand({
      sourceId: 'local', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toMatchObject({ code: 'legacyStateUnsupported' });
    await expect(updateCatalogSourceCommand({
      sourceId: 'local',
      update: { type: 'path', path: replacement },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).rejects.toMatchObject({ code: 'legacyStateUnsupported' });
    await expect(removeCatalogSourceCommand({
      sourceId: 'local', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toMatchObject({ code: 'legacyStateUnsupported' });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).toBe(before.digest);
  });
});
