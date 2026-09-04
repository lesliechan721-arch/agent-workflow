import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { removeCatalogSourceCommand, updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import { setRebuildCommandTestHooksForTests } from '../../src/commands/rebuild-command.js';
import { inspectNativeMarketplaceRegistrations } from '../../src/commands/rebuild-integration.js';
import {
  cleanupWriteCommand,
  installWriteCommand,
  uninstallWriteCommand,
} from '../../src/commands/write-commands.js';
import {
  createSkillOwnerMarkerContent,
  createSharedOwnerToken,
  readSkillOwnerMarker,
  renderOwnedTextFile,
  writeSkillOwnerMarker,
  type OwnerIdentity,
} from '../../src/utils/ownership.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  listNamespacedPluginConfigStores,
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import {
  resetPluginConfigWithHelper,
} from '../../src/utils/plugin-config-write.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

const SOURCE_IDENTITY = `sha256:${'1'.repeat(64)}`;

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const replaced = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources.filter((entry) => entry.type === 'path')) {
    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: options.env,
    }).catch(() => undefined);
  }
  return replaced;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe('phase 3B namespaced runtime stores', () => {
  it('roundtrips owner schema 3 with stable plugin identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.env.AW_HOME!, 'owner-schema2');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.ensureDir(skillRoot);
    const identity: OwnerIdentity = {
      owner: 'agent-workflows',
      sourceId: 'team',
      pluginId: 'team/demo',
      plugin: 'demo',
      artifactKey: 'review',
      platform: 'codex',
      scope: 'user',
    };

    expect(JSON.parse(createSkillOwnerMarkerContent(identity))).toMatchObject({
      schemaVersion: 3,
      sourceId: 'team',
      pluginId: 'team/demo',
    });
    await writeSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, identity });
    await expect(readSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, expectedIdentity: identity }))
      .resolves.toMatchObject(identity);

    const backupPath = path.join(isolation.layout.fixtureCwd, '.codex', 'backup.txt');
    await fs.outputFile(backupPath, createSharedOwnerToken(identity));
    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: backupPath }));
  });

  it('inventories canonical project owner artifacts but ignores ordinary project and marketplace Skill markers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const identity: OwnerIdentity = {
      owner: 'agent-workflows',
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY,
      pluginId: 'team/demo',
      plugin: 'demo',
      artifactKey: 'role',
      platform: 'codex',
      scope: 'project',
    };
    const backup = path.join(isolation.layout.fixtureCwd, '.codex', 'backup.toml');
    const exampleMarker = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'examples',
      'copied-skill',
      '.agent-workflows-owner.json',
    );
    const role = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-role.toml');
    const projectSkillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'review');
    const nestedSkillMarker = path.join(
      projectSkillRoot,
      'examples',
      'copied',
      '.agent-workflows-owner.json',
    );
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const bundleSkillRoot = path.join(
      marketplaceRoot,
      'plugins',
      'demo',
      'codex',
      'skills',
      'bundle-review',
    );
    await Promise.all([
      fs.outputFile(backup, renderOwnedTextFile('backup\n', identity)),
      fs.outputJson(exampleMarker, {
        schemaVersion: 2,
        ...identity,
        artifactKey: 'copied-skill',
      }),
      fs.outputFile(role, renderOwnedTextFile('role\n', identity)),
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        marketplaceName: 'aw-team',
      }),
      fs.ensureDir(projectSkillRoot),
      fs.ensureDir(bundleSkillRoot),
      fs.outputJson(nestedSkillMarker, {
        schemaVersion: 2,
        ...identity,
        artifactKey: 'copied',
      }),
    ]);
    await Promise.all([
      writeSkillOwnerMarker({
        skillRoot: projectSkillRoot,
        allowedRoot: path.dirname(projectSkillRoot),
        identity: { ...identity, artifactKey: 'review' },
      }),
      writeSkillOwnerMarker({
        skillRoot: bundleSkillRoot,
        allowedRoot: path.dirname(bundleSkillRoot),
        identity: {
          ...identity,
          artifactKey: 'bundle-review',
          scope: 'user',
        },
      }),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'namespacedOwner', location: role, sourceId: 'team' }),
    ]));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: backup }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: exampleMarker }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      location: path.join(projectSkillRoot, '.agent-workflows-owner.json'),
    }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: nestedSkillMarker }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      kind: 'namespacedOwner',
      location: path.join(bundleSkillRoot, '.agent-workflows-owner.json'),
      sourceId: 'team',
    }));
  });

  it('does not turn Codex cache residue into ordinary or orphan cleanup consumers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplacesRoot = path.join(isolation.env.AW_HOME!, 'marketplaces');
    const roots = {
      team: path.join(marketplacesRoot, 'team'),
      unrelated: path.join(marketplacesRoot, 'unrelated'),
    };
    await Promise.all(Object.entries(roots).flatMap(([sourceId, root]) => {
      const marketplaceName = `aw-${sourceId}`;
      return [
        fs.outputJson(path.join(root, 'config.json'), {
          schemaVersion: 2,
          sourceId,
          sourceIdentity: SOURCE_IDENTITY,
          marketplaceName,
        }),
        fs.outputJson(path.join(root, '.agents', 'plugins', 'marketplace.json'), {
          name: marketplaceName,
          plugins: [],
        }),
        fs.outputJson(path.join(root, '.claude-plugin', 'marketplace.json'), {
          name: marketplaceName,
          plugins: [],
        }),
      ];
    }));
    await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
      '[marketplaces.aw-team]',
      `source = ${JSON.stringify(roots.team)}`,
      'source_type = "local"',
      '[marketplaces.aw-unrelated]',
      `source = ${JSON.stringify(roots.unrelated)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    await fs.outputJson(path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins',
      'cache',
      'aw-team',
      'demo',
      '1.0.0',
      'plugin.json',
    ), { name: 'demo', version: '1.0.0' });
    const outside = path.join(isolation.layout.rootDir, 'unrelated-cache-outside');
    await fs.ensureDir(outside);
    await fs.ensureDir(path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache'));
    await fs.symlink(
      outside,
      path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw-unrelated'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const ordinary = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(ordinary.errors).toEqual([]);
    expect(ordinary.references).not.toContainEqual(expect.objectContaining({
      pluginName: 'demo', platform: 'codex',
    }));

    const orphanCleanup = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(orphanCleanup.errors).toEqual([]);
    expect(orphanCleanup.references).not.toContainEqual(expect.objectContaining({
      pluginName: 'demo', platform: 'codex',
    }));
  });

  it('stores config below separate source/plugin segments with stable plugin identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const options = {
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY,
      pluginName: 'demo',
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writePluginConfigStore({ ...options, values: { mode: 'fast' } });

    const storePath = resolvePluginConfigStorePath(options);
    expect(storePath).toBe(path.join(isolation.env.AW_HOME!, 'plugin-config', 'team', 'demo', 'config.json'));
    expect(await fs.readJson(storePath)).toMatchObject({
      schemaVersion: 3,
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY,
      pluginName: 'demo',
      values: { mode: 'fast' },
    });
    await expect(readPluginConfigStore(options)).resolves.toMatchObject({ values: { mode: 'fast' } });
    await expect(listNamespacedPluginConfigStores({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      scope: 'user',
    })).resolves.toContainEqual(expect.objectContaining({
      pluginId: 'team/demo',
      pluginName: 'demo',
      sourceId: 'team',
    }));
    await expect(readPluginConfigStore({
      ...options,
      sourceIdentity: `sha256:${'2'.repeat(64)}`,
    })).resolves.toMatchObject({
      state: 'invalid',
      invalidCode: 'identityMismatch',
      values: {},
    });
    await fs.outputJson(path.join(isolation.env.AW_HOME!, 'plugin-config', 'demo', 'config.json'), {
      mode: 'legacy',
    });
    await expect(readPluginConfigStore(options)).rejects.toThrow('legacyStateUnsupported');
    expect(() => resolvePluginConfigStorePath({ ...options, sourceId: 'team/demo' }))
      .toThrow('Invalid plugin config segment');
  });

  it('resets source-missing config by namespaced selector, rejects a bare ambiguity, and preserves another source', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = path.join(isolation.layout.fixtureCwd, 'primary-config-source');
    const teamRoot = path.join(isolation.layout.fixtureCwd, 'team-config-source');
    await Promise.all([
      createCatalogSnapshotFixture(primaryRoot, 'primary-demo'),
      createCatalogSnapshotFixture(teamRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
      }),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [
        { id: 'primary', type: 'path', primary: true, path: primaryRoot },
        { id: 'team', type: 'path', primary: false, path: teamRoot },
      ] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const setOutput = createCapturedCliIo();
    expect(await runCli(['config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: setOutput.io, interactive: false,
    })).toBe(0);
    await writePluginConfigStore({
      sourceId: 'other', sourceIdentity: `sha256:${'c'.repeat(64)}`, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
    });
    const ambiguous = createCapturedCliIo();
    expect(await runCli(['config', 'reset', 'demo', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: ambiguous.io, interactive: false,
    })).toBe(1);
    expect(JSON.parse(ambiguous.readStdout())).toMatchObject({
      errors: [expect.objectContaining({ code: 'configTargetAmbiguous' })],
    });

    await fs.outputFile(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }), '{invalid');
    await expect(removeCatalogSourceCommand({
      sourceId: 'team', cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true });

    const reset = createCapturedCliIo();
    expect(await runCli(['config', 'reset', 'team/demo', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: reset.io, interactive: false,
    })).toBe(0);
    expect(JSON.parse(reset.readStdout())).toMatchObject({
      ok: true,
      pluginId: 'team/demo',
      deleted: true,
      removedKeys: [],
      resetDisposition: 'deletedFile',
    });
    await expect(readPluginConfigStore({
      sourceId: 'other', sourceIdentity: `sha256:${'c'.repeat(64)}`, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ values: { retained: true } });
  });

  it.each(['source', 'plugin', 'config'] as const)(
    'rejects a namespaced config inventory symlink in the %s path segment',
    async (segment) => {
      const isolation = getCurrentSourceTestIsolation();
      const storeRoot = path.join(isolation.env.AW_HOME!, 'plugin-config');
      const sourceRoot = path.join(storeRoot, 'team');
      const pluginRoot = path.join(sourceRoot, 'demo');
      const externalRoot = path.join(isolation.layout.rootDir, `external-config-${segment}`);
      const externalFile = path.join(externalRoot, 'config.json');
      await fs.outputJson(externalFile, {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        pluginName: 'demo',
        values: { secret: 'outside-store' },
      });
      if (segment === 'source') {
        await fs.ensureDir(storeRoot);
        await fs.symlink(externalRoot, sourceRoot);
      } else if (segment === 'plugin') {
        await fs.ensureDir(sourceRoot);
        await fs.symlink(externalRoot, pluginRoot);
      } else {
        await fs.ensureDir(pluginRoot);
        await fs.symlink(externalFile, path.join(pluginRoot, 'config.json'));
      }

      const inventory = listNamespacedPluginConfigStores({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        scope: 'user',
      });
      await expect(inventory).rejects.toThrow('Config path cannot contain a symbolic link');
      if (segment !== 'config') {
        await expect(listNamespacedPluginConfigStores({
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          scope: 'user',
        })).rejects.toMatchObject({ code: 'invalidPluginConfigStore' });
      }
    },
  );

  it.each(['user store root', 'project parent'] as const)(
    'rejects a namespaced config inventory symlink at the %s boundary',
    async (boundary) => {
      const isolation = getCurrentSourceTestIsolation();
      const externalRoot = path.join(isolation.layout.rootDir, `external-boundary-${boundary.replace(' ', '-')}`);
      const externalStore = boundary === 'project parent'
        ? path.join(externalRoot, 'plugin-config')
        : externalRoot;
      await fs.outputJson(path.join(externalStore, 'team', 'demo', 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        pluginName: 'demo',
        values: { secret: 'outside-boundary' },
      });
      if (boundary === 'project parent') {
        await fs.symlink(externalRoot, path.join(isolation.layout.fixtureCwd, '.agent-workflows'));
      } else {
        await fs.ensureDir(isolation.env.AW_HOME!);
        await fs.symlink(externalRoot, path.join(isolation.env.AW_HOME!, 'plugin-config'));
      }
      const scope = boundary === 'project parent' ? 'project' as const : 'user' as const;

      await expect(listNamespacedPluginConfigStores({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        scope,
      })).rejects.toMatchObject({ code: 'invalidPluginConfigStore' });

      const inventory = await inventoryCatalogSourceReferences({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      });
      expect(inventory.references).not.toContainEqual(expect.objectContaining({
        kind: 'namespacedConfig',
        sourceId: 'team',
        pluginName: 'demo',
      }));
      expect(inventory.errors).toContainEqual(expect.objectContaining({
        kind: expect.stringContaining('config'),
        relevance: expect.objectContaining({ global: false, scope }),
      }));
    },
  );

  it('emits config receipt 6 and keeps a namespaced store after its source is removed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = path.join(isolation.layout.fixtureCwd, 'primary-source');
    const teamRoot = path.join(isolation.layout.fixtureCwd, 'team-source');
    await Promise.all([
      createCatalogSnapshotFixture(primaryRoot, 'primary-demo'),
      createCatalogSnapshotFixture(teamRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.config = {
          fields: {
            mode: {
              type: 'string',
              title: 'Mode',
              choices: {
                allowCustom: false,
                presets: [{ id: 'fast', title: 'Fast', value: 'fast' }],
              },
            },
            enabled: {
              type: 'boolean',
              choices: {
                allowCustom: false,
                presets: [{ id: 'off', title: 'Off', value: false }],
              },
            },
          },
        };
      }),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'primary', type: 'path', primary: true, path: primaryRoot },
          { id: 'team', type: 'path', primary: false, path: teamRoot },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    for (const args of [
      ['--scope', 'user'],
      ['--scope', 'user', '--value-json', '"fast"', '--preset', 'fast'],
    ]) {
      const invalidOutput = createCapturedCliIo();
      expect(await runCli(['config', 'set', 'team/demo', 'mode', ...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: invalidOutput.io,
        interactive: false,
      })).toBe(1);
      expect(JSON.parse(invalidOutput.readStdout())).toMatchObject({
        command: 'config:set', ok: false, overallState: 'failed',
      });
    }
    const setOutput = createCapturedCliIo();
    expect(await runCli([
      'config', 'set', 'team/demo', 'mode', '--preset', 'fast', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: setOutput.io,
      interactive: false,
    })).toBe(0);
    const setReceipt = JSON.parse(setOutput.readStdout()) as { sourceIdentity: string };
    expect(setReceipt).toMatchObject({
      receiptSchemaVersion: 6,
      command: 'config:set',
      pluginName: 'demo',
      pluginId: 'team/demo',
      sourceId: 'team',
      sourceIdentity: expect.stringMatching(/^sha256:/),
    });
    const stored = await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: setReceipt.sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(stored.values).toEqual({ mode: 'fast' });
    expect(JSON.stringify(stored.values)).not.toContain('preset');
    const booleanPresetOutput = createCapturedCliIo();
    expect(await runCli([
      'config', 'set', 'team/demo', 'enabled', '--preset', 'off', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: booleanPresetOutput.io,
      interactive: false,
    })).toBe(0);
    expect(await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: setReceipt.sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).toMatchObject({ values: { mode: 'fast', enabled: false } });
    const getOutput = createCapturedCliIo();
    expect(await runCli(['config', 'get', 'team/demo', 'mode', '--scope', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: getOutput.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(getOutput.readStdout())).toMatchObject({
      fields: [{
        key: 'mode', value: 'fast', source: 'user', matchedPreset: 'fast', valid: true, issues: [],
      }],
    });
    await fs.outputFile(stored.path, '{ invalid json');
    const unconfirmedReset = createCapturedCliIo();
    expect(await runCli(['config', 'reset', 'team/demo', '--scope', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: unconfirmedReset.io,
      interactive: false,
    })).toBe(1);
    await expect(fs.pathExists(stored.path)).resolves.toBe(true);
    const confirmedReset = createCapturedCliIo();
    expect(await runCli(['config', 'reset', 'team/demo', '--scope', 'user', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: confirmedReset.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(confirmedReset.readStdout())).toMatchObject({
      receiptSchemaVersion: 6,
      command: 'config:reset',
      configWrite: 'succeeded',
      deleted: true,
    });
    await expect(fs.pathExists(stored.path)).resolves.toBe(false);
    const remainingNames = await fs.readdir(path.dirname(stored.path)).catch(() => []);
    expect(remainingNames.some((name) => /backup|journal/iu.test(name))).toBe(false);
    const restoreOutput = createCapturedCliIo();
    expect(await runCli([
      'config', 'set', 'team/demo', 'mode', '--preset', 'fast', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: restoreOutput.io,
      interactive: false,
    })).toBe(0);
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      references: [{
        category: 'config',
        pluginId: 'team/demo',
        scope: 'user',
        sourceId: 'team',
      }],
    });
    const skillsRoot = path.join(
      isolation.env.AW_HOME!,
      'marketplaces',
      'team',
      'plugins',
      'demo',
      'codex',
      'skills',
    );
    const skillRoot = path.join(skillsRoot, 'review');
    await Promise.all([
      fs.ensureDir(skillRoot),
      fs.outputJson(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: setReceipt.sourceIdentity,
        marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(
        isolation.env.AW_HOME!, 'marketplaces', 'team', '.agents', 'plugins', 'marketplace.json',
      ), { name: 'aw-team' }),
    ]);
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: setReceipt.sourceIdentity,
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'review',
        platform: 'codex',
        scope: 'user',
      },
    });
    const offlineResetOutput = createCapturedCliIo();
    expect(await runCli(['config', 'reset', 'team/demo', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: offlineResetOutput.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(offlineResetOutput.readStdout())).toMatchObject({
      command: 'config:reset',
      deleted: true,
    });
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'team',
      sourceIdentity: setReceipt.sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }))).toBe(false);
  });

  it('preserves a lost-source shared native consumer for explicit reconciliation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw',
        plugins: [],
      }),
      fs.outputJson(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), {
        name: 'aw',
        plugins: [],
      }),
    ]);
    const codexConfig = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await fs.outputFile(codexConfig, [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    const cacheRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0');
    const installedRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'demo@aw');
    await Promise.all([
      fs.outputJson(path.join(cacheRoot, 'plugin.json'), { name: 'demo', version: '1.0.0' }),
      fs.outputJson(path.join(installedRoot, 'manifest.json'), { id: 'demo@aw', version: '1.0.0' }),
    ]);
    const statusOutput = createCapturedCliIo();
    expect(await runCli(['status', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: statusOutput.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(statusOutput.readStdout())).toMatchObject({
      targets: [],
    });
    const calls: string[] = [];
    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, {
      env: isolation.env,
      nativeCliRunner: async (invocation) => {
        const command = invocation.agentKind
          ?? path.basename(invocation.command).replace(/\.(?:cmd|exe)$/iu, '');
        calls.push([command, ...invocation.args].join(' '));
        if (invocation.args[1] === 'remove') {
          await Promise.all([fs.remove(cacheRoot), fs.remove(installedRoot)]);
          await fs.outputFile(codexConfig, [
            '[marketplaces.aw]',
            `source = ${JSON.stringify(marketplaceRoot)}`,
            'source_type = "local"',
            '',
          ].join('\n'));
        }
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
          await fs.outputFile(codexConfig, '');
        }
        return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
      },
    });
    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [],
    });
    expect(calls).not.toContain('codex plugin remove demo@aw');
    await expect(fs.pathExists(cacheRoot)).resolves.toBe(true);
    await expect(fs.pathExists(installedRoot)).resolves.toBe(true);
  });

  it('keeps an existing marketplace root when its strict identity is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = path.join(isolation.layout.fixtureCwd, 'rollback-primary');
    const teamRoot = path.join(isolation.layout.fixtureCwd, 'rollback-team');
    await Promise.all([
      createCatalogSnapshotFixture(primaryRoot, 'primary-demo'),
      createCatalogSnapshotFixture(teamRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.marketplace.policy.products = ['CLAUDE'];
      }),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'primary', type: 'path', primary: true, path: primaryRoot },
          { id: 'team', type: 'path', primary: false, path: teamRoot },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await fs.outputFile(path.join(marketplaceRoot, 'sentinel'), 'previous generation\n');
    const result = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'claude',
      scope: 'user',
    }, {
      env: isolation.env,
      nativeCliRunner: async (invocation) => {
        if (invocation.args[0] === '--version') {
          return { exitCode: 0, stdout: 'claude 2.1.32', stderr: '' };
        }
        throw new Error('native install failed');
      },
    });
    expect(result.overallState).toBe('failed');
    expect(result.rebuildResults).toEqual([expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('stateInventoryFailed') }),
    })]);
    expect(await fs.readFile(path.join(marketplaceRoot, 'sentinel'), 'utf8'))
      .toBe('previous generation\n');
    expect(await fs.pathExists(path.join(marketplaceRoot, 'config.json'))).toBe(false);
    expect((await fs.readdir(path.dirname(marketplaceRoot))).filter((entry) =>
      entry.startsWith('team.backup-'))).toEqual([]);
  });

  it('ignores all ordinary project Skill markers while reporting canonical owner errors', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const validRoot = path.join(skillsRoot, 'valid');
    await fs.ensureDir(validRoot);
    await writeSkillOwnerMarker({
      skillRoot: validRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'valid',
        platform: 'codex',
        scope: 'project',
      },
    });
    await Promise.all([
      fs.outputFile(
        path.join(isolation.layout.fixtureCwd, '.agents', 'rules', 'bad-header.md'),
        '# agent-workflows-owner: {invalid}\ncontent\n',
      ),
      fs.outputFile(path.join(skillsRoot, 'bad-json', '.agent-workflows-owner.json'), '{invalid'),
      fs.outputJson(path.join(skillsRoot, 'bad-schema', '.agent-workflows-owner.json'), {
        schemaVersion: 3,
        owner: 'agent-workflows',
      }),
      fs.outputJson(path.join(skillsRoot, 'wrong-key', '.agent-workflows-owner.json'), {
        schemaVersion: 2,
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'different-parent',
        platform: 'codex',
        scope: 'project',
      }),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual([]);
    expect(inventory.errors).toEqual([]);
    expect(JSON.stringify(inventory.errors)).not.toContain(isolation.layout.fixtureCwd);
  });

  it('ignores marker-free system Skill directories but validates owner markers in them', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills');
    const systemRoot = path.join(skillsRoot, '.system');
    const validRoot = path.join(skillsRoot, 'valid');
    await Promise.all([fs.ensureDir(systemRoot), fs.ensureDir(validRoot)]);
    await writeSkillOwnerMarker({
      skillRoot: validRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'valid',
        platform: 'codex',
        scope: 'user',
      },
    });

    const foreignInventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(foreignInventory.errors).toEqual([]);
    expect(foreignInventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedOwner',
      sourceId: 'team',
      pluginName: 'demo',
      location: path.join(validRoot, '.agent-workflows-owner.json'),
    }));

    await fs.outputJson(path.join(systemRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY,
      pluginId: 'team/demo',
      plugin: 'demo',
      artifactKey: 'system',
      platform: 'codex',
      scope: 'user',
    });
    const ownedInventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(ownedInventory.errors).toContainEqual(expect.objectContaining({
      code: 'stateInventoryFailed',
      kind: 'ownerMarkerValidation',
    }));
    expect(ownedInventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedOwner',
      sourceId: 'team',
      pluginName: 'demo',
      location: path.join(validRoot, '.agent-workflows-owner.json'),
    }));
  });

  it('keeps unrelated legacy state while planning and installing a namespaced plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'legacy-install-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Use policy.' }],
      };
      manifest.marketplace.policy.products = ['CODEX'];
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const legacyRoot = path.join(skillsRoot, 'legacy-owner');
    const legacyMarker = path.join(legacyRoot, '.agent-workflows-owner.json');
    const legacyContent = Buffer.from('legacy bytes\n\u0000kept\n');
    const legacyMarkerBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'legacy-owner',
      artifactKey: 'legacy-owner',
      platform: 'codex',
      scope: 'project',
    }));
    await Promise.all([
      fs.outputFile(path.join(legacyRoot, 'legacy.bin'), legacyContent),
      fs.outputFile(legacyMarker, legacyMarkerBytes),
    ]);
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };

    const previewStages: string[] = [];
    const preview = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      ...runtime,
      previewOperationPlan: true,
      onPreviewStage(stage) { previewStages.push(stage); },
    });
    expect(preview.overallState).toBe('succeeded');
    expect(previewStages).toEqual(['catalog', 'inventory', 'dependencyPlan']);
    expect(preview.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/demo',
      action: 'install',
    }));

    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(path.join(legacyRoot, 'legacy.bin'))).resolves.toEqual(legacyContent);
    await expect(fs.readFile(legacyMarker)).resolves.toEqual(legacyMarkerBytes);

    const samePluginRoot = path.join(skillsRoot, 'same-plugin-owner');
    const samePluginMarker = path.join(samePluginRoot, '.agent-workflows-owner.json');
    const samePluginMarkerBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'demo',
      artifactKey: 'same-plugin-owner',
      platform: 'codex',
      scope: 'project',
    }));
    await fs.outputFile(samePluginMarker, samePluginMarkerBytes);
    const ignoredSamePluginMarker = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    expect(ignoredSamePluginMarker).toMatchObject({
      overallState: 'succeeded',
      targetResults: [],
    });
    await expect(fs.readFile(samePluginMarker)).resolves.toEqual(samePluginMarkerBytes);
    await expect(fs.readFile(legacyMarker)).resolves.toEqual(legacyMarkerBytes);
  });

  it.each([
    ['codex', 'foreign-registration'],
    ['claude', 'foreign-registration'],
    ['codex', 'orphan-consumer'],
    ['claude', 'orphan-consumer'],
  ] as const)(
    'installs a primary user plugin through a source-bound %s marketplace when aw has a retained %s',
    async (platform, collision) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `primary-${platform}-collision-source`);
      await fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo.\n---\n',
      );
      await fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      );
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.marketplace.policy.products = [platform === 'codex' ? 'CODEX' : 'CLAUDE'];
        manifest.skills = './skills';
        manifest.extensions = {
          instructions: [{ name: 'policy', title: 'Policy', content: 'Use policy.' }],
        };
      });
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const foreignRoot = path.join(isolation.layout.rootDir, `foreign-aw-${platform}`);
      const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      if (platform === 'codex') {
        await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
          ...(collision === 'foreign-registration' ? [
            '[marketplaces.aw]',
            `source = ${JSON.stringify(foreignRoot)}`,
            'source_type = "local"',
          ] : []),
          '[plugins."legacy-owner@aw"]',
          'enabled = true',
          '',
        ].join('\n'));
      } else {
        await Promise.all([
          fs.outputJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json'), {
            ...(collision === 'foreign-registration' ? {
              extraKnownMarketplaces: { aw: { source: { source: 'directory', path: foreignRoot } } },
            } : {}),
            enabledPlugins: collision === 'foreign-registration' ? { 'legacy-owner@aw': true } : {},
          }),
          fs.outputJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'known_marketplaces.json'), {
            ...(collision === 'foreign-registration' ? {
              aw: {
                source: { source: 'directory', path: foreignRoot },
                installLocation: foreignRoot,
              },
            } : {}),
          }),
          fs.outputJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json'), {
            plugins: {
              'legacy-owner@aw': [{
                name: 'legacy-owner', marketplace: 'aw', scope: 'user', version: '9.9.9',
              }],
            },
          }),
        ]);
      }

      const nativeCliRunner = async (invocation: {
        agentKind?: 'codex' | 'claude';
        command: string;
        args: string[];
      }) => {
        const command = invocation.agentKind
          ?? path.basename(invocation.command).replace(/\.(?:cmd|exe)$/iu, '');
        if (command === 'codex'
          && invocation.args[0] === 'plugin'
          && invocation.args[1] === 'marketplace'
          && invocation.args[2] === 'add') {
          await fs.appendFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
            '[marketplaces.aw-team]',
            `source = ${JSON.stringify(marketplaceRoot)}`,
            'source_type = "local"',
            '',
          ].join('\n'));
        }
        if (command === 'codex'
          && invocation.args[0] === 'plugin'
          && invocation.args[1] === 'add') {
          await fs.appendFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
            '[plugins."demo@aw-team"]',
            'enabled = true',
            '',
          ].join('\n'));
          await fs.copy(
            path.join(marketplaceRoot, 'plugins', 'demo'),
            path.join(
              isolation.env.AW_CODEX_HOME!,
              'plugins', 'cache', 'aw-team', 'demo', '1.0.0',
            ),
          );
        }
        if (command === 'claude'
          && invocation.args[0] === 'plugin'
          && invocation.args[1] === 'marketplace'
          && invocation.args[2] === 'add') {
          const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
          const knownPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'known_marketplaces.json');
          const settings = await fs.readJson(settingsPath) as Record<string, unknown>;
          const known = await fs.readJson(knownPath) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            extraKnownMarketplaces: {
              ...(settings.extraKnownMarketplaces as Record<string, unknown>),
              'aw-team': { source: { source: 'directory', path: marketplaceRoot } },
            },
          });
          await fs.outputJson(knownPath, {
            ...known,
            'aw-team': {
              source: { source: 'directory', path: marketplaceRoot },
              installLocation: marketplaceRoot,
            },
          });
        }
        if (command === 'claude'
          && invocation.args[0] === 'plugin'
          && invocation.args[1] === 'install') {
          const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
          const installedPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json');
          const settings = await fs.readJson(settingsPath) as Record<string, unknown>;
          const installed = await fs.readJson(installedPath) as { plugins: Record<string, unknown> };
          const plugins = { ...installed.plugins };
          delete plugins.demo;
          await fs.outputJson(settingsPath, {
            ...settings,
            enabledPlugins: {
              ...(settings.enabledPlugins as Record<string, unknown>),
              'demo@aw-team': true,
            },
          });
          await fs.outputJson(installedPath, { plugins: {
            ...plugins,
            'demo@aw-team': [{ name: 'demo', scope: 'user', version: '1.0.0' }],
          } });
        }
        if (command === 'codex'
          && invocation.args[0] === 'plugin'
          && invocation.args[1] === 'list'
          && invocation.args[2] === '--json') {
          const config = await readCodexConfigFile(
            path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: Object.entries(config.snapshot.plugins).map(([pluginId, plugin]) => ({
                pluginId,
                installed: true,
                enabled: plugin.enabled === true,
                version: '1.0.0',
              })),
              available: [],
            }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: `${platform}-cli 99.0.0`, stderr: '' };
      };

      const result = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform,
        scope: 'user',
      }, { env: isolation.env, nativeCliRunner });
      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.rebuildResults[0]?.target.marketplaceName).toBe('aw-team');
      if (platform === 'codex') {
        const config = await fs.readFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), 'utf8');
        if (collision === 'foreign-registration') {
          expect(config).toContain(`[marketplaces.aw]\nsource = ${JSON.stringify(foreignRoot)}`);
        } else {
          expect(config).not.toContain('[marketplaces.aw]');
        }
        expect(config).toContain('[plugins."legacy-owner@aw"]');
        expect(config).toContain(`[marketplaces.aw-team]\nsource = ${JSON.stringify(marketplaceRoot)}`);
      } else {
        const settings = await fs.readJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json'));
        const installed = await fs.readJson(path.join(
          isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json',
        ));
        if (collision === 'foreign-registration') {
          expect(settings.extraKnownMarketplaces.aw.source.path).toBe(foreignRoot);
        } else {
          expect(settings.extraKnownMarketplaces.aw).toBeUndefined();
        }
        if (collision === 'foreign-registration') {
          expect(settings.enabledPlugins['legacy-owner@aw']).toBe(true);
        } else {
          expect(settings.enabledPlugins['legacy-owner@aw']).toBeUndefined();
        }
        expect(installed.plugins['legacy-owner@aw'][0]).toMatchObject({ version: '9.9.9' });
        expect(settings.extraKnownMarketplaces['aw-team'].source.path).toBe(marketplaceRoot);
      }
      await expect(fs.readJson(path.join(marketplaceRoot, 'config.json'))).resolves.toMatchObject({
        sourceId: 'team',
        marketplaceName: 'aw-team',
      });
      if (platform === 'claude') {
        const reused = await installWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd,
          platform,
          scope: 'user',
        }, { env: isolation.env, nativeCliRunner });
        expect(reused.overallState, JSON.stringify(reused.rebuildResults)).toBe('succeeded');
        expect(reused.rebuildResults[0]?.target.marketplaceName).toBe('aw-team');
      } else {
        await expect(inspectNativeMarketplaceRegistrations({
          marketplaceName: 'aw-team',
          marketplaceRoot,
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
        })).resolves.toMatchObject({ codex: 'canonical' });
      }
      if (platform === 'codex') {
        await fs.appendFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
          '[plugins."demo@aw"]',
          'enabled = true',
          '',
        ].join('\n'));
      } else {
        const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
        const settings = await fs.readJson(settingsPath) as Record<string, unknown>;
        await fs.outputJson(settingsPath, {
          ...settings,
          enabledPlugins: {
            ...(settings.enabledPlugins as Record<string, unknown>),
            'demo@aw': true,
          },
        });
      }
      const samePluginBlocked = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform,
        scope: 'user',
      }, { env: isolation.env, nativeCliRunner });
      expect(samePluginBlocked).toMatchObject({
        overallState: 'failed',
        targetResults: expect.arrayContaining([expect.objectContaining({
          errorCode: 'legacyStateUnsupported',
          target: expect.objectContaining({ pluginId: 'team/demo', platform, scope: 'user' }),
        })]),
      });
      await expect(fs.readJson(path.join(marketplaceRoot, 'config.json'))).resolves.toMatchObject({
        marketplaceName: 'aw-team',
      });
    },
  );

  it.each(['foreign-registration', 'orphan-consumer', 'claude-orphan-consumer'] as const)(
    'rejects a source-bound marketplace with a retained %s when primary aw is also foreign',
    async (namespacedCollision) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'double-marketplace-collision-source');
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
      });
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
      const original = [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-aw'))}`,
        'source_type = "local"',
        ...(namespacedCollision === 'foreign-registration' ? [
          '[marketplaces.aw-team]',
          `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-aw-team'))}`,
          'source_type = "local"',
        ] : namespacedCollision === 'orphan-consumer' ? [
          '[plugins."foreign-owner@aw-team"]',
          'enabled = true',
        ] : []),
        '',
      ].join('\n');
      await fs.outputFile(configPath, original);
      if (namespacedCollision === 'claude-orphan-consumer') {
        await fs.outputJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json'), {
          enabledPlugins: { 'foreign-owner@aw-team': true },
        });
      }
      const nativeCliRunner = vi.fn(async () => ({
        exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
      }));

      const result = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { env: isolation.env, nativeCliRunner });
      expect(result).toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({ errorCode: 'externalOwnershipPresent' })],
      });
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(original);
      if (namespacedCollision === 'claude-orphan-consumer') {
        await expect(fs.readJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json')))
          .resolves.toMatchObject({ enabledPlugins: { 'foreign-owner@aw-team': true } });
      }
      await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team')))
        .resolves.toBe(false);
      expect(nativeCliRunner).not.toHaveBeenCalled();
    },
  );

  it('fails closed on invalid shared Codex inventory for a native project target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-codex-inventory-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'skills', 'managed', 'SKILL.md'),
      '---\nname: managed\ndescription: managed\n---\n',
    );
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'skills', 'managed', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'managed');
    await fs.ensureDir(skillRoot);
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'managed',
        platform: 'codex',
        scope: 'project',
      },
    });
    const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const invalid = '[[invalid codex toml\n';
    await fs.outputFile(configPath, invalid);

    const output = createCapturedCliIo();
    expect(await runCli([
      'status', 'team/demo', '--platform', 'codex', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: output.io,
      interactive: false,
    })).toBe(1);
    const stdout = output.readStdout();
    const payload = JSON.parse(stdout) as {
      targets: Array<{ pluginId: string; state: string; reasons: Array<{ code: string }> }>;
      errors: Array<{ code: string; message: string }>;
    };
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(payload.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/demo',
      state: 'blocked',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexSharedNativeCorrupt' }),
        expect.objectContaining({ code: 'codexActivationDrift' }),
      ]),
    }));
    expect(payload.errors).not.toContainEqual(expect.objectContaining({ code: 'pluginNotFound' }));
    expect(payload.errors.map((error) => error.message).join('\n')).not.toContain(isolation.layout.rootDir);
    expect(output.readStderr()).toBe('');
    expect(await fs.readFile(configPath, 'utf8')).toBe(invalid);
  });

  it.each([
    ['settings.json', (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) =>
      path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json')],
    ['installed_plugins.json', (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) =>
      path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json')],
  ] as const)('reports unreadable Claude native state from %s without writing state', async (_label, filePath) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `invalid-claude-${_label}`);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CLAUDE'];
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const invalidPath = filePath(isolation);
    const invalid = '{ invalid json\n';
    await fs.outputFile(invalidPath, invalid);
    const beforeMarketplaceEntries = await fs.readdir(
      path.join(isolation.env.AW_HOME!, 'marketplaces'),
    ).catch(() => []);

    const output = createCapturedCliIo();
    expect(await runCli([
      'status', 'team/demo', '--platform', 'claude', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: output.io,
      interactive: false,
    })).toBe(1);
    const stdout = output.readStdout();
    const payload = JSON.parse(stdout) as {
      targets: Array<{ pluginId: string }>;
      errors: Array<{ code: string; message: string }>;
    };
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(payload.targets).toContainEqual(expect.objectContaining({ pluginId: 'team/demo' }));
    expect(payload.errors).toContainEqual(expect.objectContaining({ code: 'nativeStateUnreadable' }));
    expect(payload.errors).not.toContainEqual(expect.objectContaining({ code: 'pluginNotFound' }));
    expect(payload.errors.map((error) => error.message).join('\n')).not.toContain(isolation.layout.rootDir);
    expect(output.readStderr()).toBe('');
    expect(await fs.readFile(invalidPath, 'utf8')).toBe(invalid);
    expect(await fs.readdir(path.join(isolation.env.AW_HOME!, 'marketplaces')).catch(() => []))
      .toEqual(beforeMarketplaceEntries);
  });

  it.each(['cleanup', 'uninstall'] as const)(
    '%s keeps a live platform after the current bundle revokes support',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `revoked-${command}-source`);
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'policy', title: 'Policy', content: 'Keep this policy.' }],
        };
      });
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      };
      const installed = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.marketplace.policy.products = ['CLAUDE'];
      });

      const result = command === 'cleanup'
        ? await cleanupWriteCommand(['team/demo'], {
            cwd: isolation.layout.fixtureCwd,
            platform: 'both',
            scope: 'project',
          }, runtime)
        : await uninstallWriteCommand(['team/demo'], {
            cwd: isolation.layout.fixtureCwd,
            platform: 'both',
            scope: 'project',
          }, runtime);
      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.receiptTargets).toContainEqual(expect.objectContaining({
        pluginId: 'team/demo',
        platform: 'codex',
        scope: 'project',
      }));
    },
  );

  it('serializes source identity mutation with first owner publication', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'race-source');
    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'race-replacement');
    await Promise.all([
      createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'policy', title: 'Policy', content: 'Policy.' }],
        };
        manifest.marketplace.policy.products = ['CODEX'];
      }),
      createCatalogSnapshotFixture(replacementRoot, 'demo'),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const configured = await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const originalSourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    const installBuilt = deferred();
    const resumeInstall = deferred();
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async () => {
        installBuilt.resolve();
        await resumeInstall.promise;
      },
    });
    let installing: ReturnType<typeof installWriteCommand> | undefined;
    let mutation: ReturnType<typeof updateCatalogSourceCommand> | undefined;
    try {
      installing = installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
      }, {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      });
      await installBuilt.promise;
      let mutationCompleted = false;
      mutation = updateCatalogSourceCommand({
        sourceId: 'team',
        update: { type: 'path', path: replacementRoot },
        cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      });
      void mutation.then(
        () => { mutationCompleted = true; },
        () => { mutationCompleted = true; },
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(mutationCompleted).toBe(false);

      resumeInstall.resolve();
      await expect(installing).resolves.toMatchObject({ overallState: 'succeeded' });
      await expect(mutation).resolves.toMatchObject({
        ok: true,
        changed: true,
        references: expect.arrayContaining([
          expect.objectContaining({
            category: 'installation', pluginId: 'team/demo', scope: 'project',
          }),
          expect.objectContaining({
            category: 'lifecycle', pluginId: 'team/demo', scope: 'project',
          }),
        ]),
      });
      expect(mutationCompleted).toBe(true);
      expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).not.toBe(configured.digest);
    } finally {
      resumeInstall.resolve();
      await Promise.allSettled([installing, mutation].filter((value) => value !== undefined));
      setRebuildCommandTestHooksForTests(undefined);
    }
  });
});
