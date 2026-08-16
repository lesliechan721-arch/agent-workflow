import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  addCatalogSourceCommand,
  listCatalogSources,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { runCli } from '../../src/index.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
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
