import { writeIntentFixture, readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { render } from 'ink-testing-library';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { renderOwnedTextFile } from '../../src/utils/ownership.js';
import { runRetire } from '../../src/recovery/retirement.js';
import { removeRoot } from '../../src/intent/intent-store.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation, registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { readPluginConfigStore, resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import type { PluginMeta } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import {
  reinstallWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  configureCatalog,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';
import { nativeFixtureLayout, nativeRegistrationId } from '../helpers/write-command-cleanup-fixture.js';

describe('five namespaced write commands', () => {
  let defaultNativeRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  beforeEach(async () => {
    installNativeTestDiscovery();
    defaultNativeRuntime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('preserves all four legacy Codex files and exposes manual recovery in normal and force cleanup', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const root = env.AW_CODEX_HOME!;
    const entries = [
      ['rules', 'agent-subagent', 'subagent-commands', '.rules'],
      ['agents', 'agent-subagent', 'subagent', '.toml'],
      ['agents', 'retired-investigation', 'retired-advisor', '.toml'],
      ['agents', 'retired-investigation', 'retired-explore', '.toml'],
    ] as const;
    const files = entries.map(([directory, plugin, key, extension]) => path.join(root, directory, `aw-${plugin}-${key}${extension}`));
    for (const [index, [, plugin, key]] of entries.entries()) await fs.outputFile(files[index]!, renderOwnedTextFile('legacy fixture\n', {
      owner: 'agent-workflows', sourceId: 'official', pluginId: `official/${plugin}`, plugin,
      artifactKey: key, platform: 'codex', scope: 'user',
    }));
    await fs.outputFile(path.join(root, 'config.toml'), entries.flatMap(([directory, , key], index) => directory === 'agents'
      ? [`[agents.${JSON.stringify(key)}]`, `config_file = ${JSON.stringify(files[index])}`] : []).join('\n'));
    const inventory = await inventoryCatalogSourceReferences({ cwd: layout.fixtureCwd, env, scope: 'user',
      knownPluginNames: ['agent-subagent', 'retired-investigation'] });
    expect(inventory.errors.filter((error) => error.kind === 'ownerHeaderPathValidation')).toHaveLength(4);
    expect(inventory.references.some((reference) => files.includes(reference.location))).toBe(false);
    expect(inventory.errors.map((error) => error.configKey).filter(Boolean)).toEqual(expect.arrayContaining([
      'agents.subagent.config_file', 'agents.retired-advisor.config_file', 'agents.retired-explore.config_file',
    ]));
    for (const force of [false, true]) {
      const result = await runPublicLifecycle('remove', ['official/agent-subagent', 'official/retired-investigation'], {
        cwd: layout.fixtureCwd, env, cliVersion: '1.0.0', scope: 'user', context: 'user', target: ['codex'], only: 'outputs', yes: true, force,
      }, { env, nativeCliRunner: defaultNativeRuntime.nativeCliRunner });
      expect(result.status).not.toBe('success');
      const manual = result.nextActions.filter((action) => action.kind === 'manual').map((action) => action.message).join('\n');
      for (const file of files) {
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ path: file }) }));
        expect(manual).toContain(JSON.stringify(file));
        expect(await fs.pathExists(file)).toBe(true);
      }
      expect(manual).toContain('Back up');
      expect(manual).toContain('outside the host scan directories');
    }
    for (const [index, file] of files.entries()) await fs.move(file, path.join(layout.fixtureCwd, 'manual-backup', String(index)));
    const recovered = await inventoryCatalogSourceReferences({ cwd: layout.fixtureCwd, env, scope: 'user' });
    expect(recovered.errors.filter((error) => error.kind === 'ownerHeaderPathValidation')).toEqual([]);
  });

  it('previews and cleans selected live ownership without running the current Active renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-offline-renderer-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-offline-renderer-counts');
    await fs.ensureDir(counterRoot);
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['user'] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role', counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role', fail: true, counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const rendererCount = path.join(counterRoot, 'render-count-demo.txt');
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', "aw-team-demo-demo-role.toml");

    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, { ...runtime, previewOperationPlan: true });

    expect(preview.overallState).toBe('succeeded');
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);

    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      ...await readFixtureRequirements(intentLocation),
      roots: [],
    });
    const alreadyClean = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('cleanup', alreadyClean);

    expect(alreadyClean.overallState, JSON.stringify(alreadyClean.rebuildResults)).toBe('succeeded');
    expect(receipt).toMatchObject({ command: 'cleanup', overallState: 'succeeded' });
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
  }, 30_000);

  it('cleans a user target without reading or changing a damaged project Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-damaged-intent-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['user'] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role' });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', "aw-team-demo-demo-role.toml");
    const projectIntentPath = path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json',
    );
    await fs.outputFile(projectIntentPath, '{invalid project Intent\n');
    const projectIntentBefore = await fs.readFile(projectIntentPath);
    await fs.remove(sourceRoot);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] });
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntentBefore);
  });

  it('cleans a selected dependency without reading installed edges, providers, or renderers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-installed-edge-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-installed-edge-counts');
    await fs.ensureDir(counterRoot);
    const leafRoot = path.join(sourceRoot, 'plugins', 'leaf');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
    };
    const configureRoot = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: ['leaf'], configureManifest: configureRoot },
    ]);
    await writeDynamicRoleRenderer({ pluginRoot: leafRoot, roleKey: 'leaf-role', counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: ['leaf'], configureManifest: configureRoot },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const { nativeCliRunner } = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-leaf-leaf-role.toml");
    expect(await fs.pathExists(rolePath)).toBe(true);

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: [], configureManifest: configureRoot },
    ]);
    await writeDynamicRoleRenderer({
      pluginRoot: leafRoot,
      roleKey: 'leaf-role',
      fail: true,
      counterRoot,
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: [], configureManifest: configureRoot },
    ]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      ...await readFixtureRequirements(intentLocation),
      roots: [],
    });
    let providerCalls = 0;
    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner,
      catalogGenerationRuntime: {
        providers: {
          path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
            providerCalls += 1;
            return catalogPathProviderInternal.resolve(...args);
          },
          git: async () => {
            providerCalls += 1;
            throw new Error('cleanup must not invoke the Catalog provider');
          },
        },
      },
    });

    expect(result).toMatchObject({ overallState: 'succeeded' });
    expect(providerCalls).toBe(0);
    await expect(fs.readFile(
      path.join(counterRoot, 'render-count-leaf.txt'),
      'utf8',
    )).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
  }, 30_000);

  it('cleans selected Codex output without running preApply or changing Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-desired-pre-apply-source');
    const definitions: Array<{
      name: string;
      configureManifest?: (manifest: PluginMeta['manifest']) => void;
    }> = [{ name: 'demo' }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const nativeId = await nativeRegistrationId('demo');
    expect((await readCodexConfigFile(configPath)).snapshot.plugins[nativeId]?.enabled).toBe(true);
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);

    definitions[0]!.configureManifest = (manifest) => {
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
      'await import("node:fs/promises").then((fs) => fs.writeFile(`${process.env.AW_HOME}/cleanup-pre-apply-ran.txt`, "ran"));\n',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect((await readCodexConfigFile(configPath)).snapshot.plugins[nativeId]?.enabled).not.toBe(true);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'cleanup-pre-apply-ran.txt'),
    )).resolves.toBe(false);
  }, 30_000);

  it('preserves incomplete, all-zero, and path-mismatched owner markers during force cleanup', async () => {
    const isolation = await configureCatalog();
    const skillsRoot = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills');
    const marker = {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'local',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginId: 'local/demo',
      plugin: 'demo',
      artifactKey: 'owned-skill',
      platform: 'claude',
      scope: 'user',
    };
    const fixtures = [
      ['incomplete', { ...marker, sourceIdentity: undefined, artifactKey: 'incomplete' }],
      ['all-zero', { ...marker, sourceIdentity: `sha256:${'0'.repeat(64)}`, artifactKey: 'all-zero' }],
      ['path-mismatch', { ...marker, artifactKey: 'different-directory' }],
    ] as const;
    for (const [directory, value] of fixtures) {
      await fs.outputJson(path.join(skillsRoot, directory, '.agent-workflows-owner.json'), value);
    }

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'user', force: true,
    }, { env: isolation.env });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' }),
    ]);
    for (const [directory] of fixtures) {
      await expect(fs.pathExists(path.join(skillsRoot, directory))).resolves.toBe(true);
    }
  });

  it('cleans selected ownership without checking historical dependents after source deletion', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectA = isolation.layout.fixtureCwd;
    const projectB = path.join(isolation.layout.rootDir, 'historical-cleanup-project-b');
    const sourceRoot = path.join(projectA, 'historical-cleanup-source');
    const otherRoot = path.join(projectA, 'historical-cleanup-other-source');
    await fs.ensureDir(projectB);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await createDependencyCatalogSnapshotFixture(otherRoot, [{ name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/leaf'], {
      cwd: projectA, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['team/root'], {
      cwd: projectA, platform: 'codex', scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userIntent = { scope: 'user' as const, cwd: projectA, env: isolation.env };
    await writeIntentFixture(userIntent, {
      ...await readFixtureRequirements(userIntent),
      roots: [],
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'other', type: 'path', primary: true, path: otherRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });

    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'codex', scope: 'user',
    }, runtime);

    expect(result).toMatchObject({ overallState: 'succeeded' });
  }, 30_000);

  it.each([false, true])(
    'ignores obsolete store artifact paths during cleanup (force=%s)',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `obsolete-store-artifact-${force ? 'force' : 'normal'}`,
      );
      const configureV1 = (manifest: PluginMeta['manifest']) => {
        manifest.extensions = {
          agents: [
            { name: 'real-role', description: 'Real role.', prompt: 'Real.' },
            { name: 'obsolete-role', description: 'Obsolete role.', prompt: 'Obsolete.' },
          ],
        };
      };
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configureV1 }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
      };
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const agentsRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
      const realRole = path.join(agentsRoot, "aw-team-demo-real-role.toml");
      const obsoleteRole = path.join(agentsRoot, "aw-team-demo-obsolete-role.toml");
      await fs.outputFile(obsoleteRole, 'foreign = true\n');
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'real-role', description: 'Real role.', prompt: 'Real.' }],
          };
        },
      }]);
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
      const intent = {
        scope: 'project' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      await writeIntentFixture(intent, {
        ...await readFixtureRequirements(intent),
        roots: [],
      });

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
        ...(force ? { force: true } : {}),
      }, runtime);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(realRole)).resolves.toBe(false);
      await expect(fs.readFile(obsoleteRole, 'utf8')).resolves.toBe('foreign = true\n');
    },
  );

  it('detects collisions from real renderer output before the first platform write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'rendered-collision-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'collision');
    const counter = path.join(isolation.layout.fixtureCwd, 'rendered-collision-count');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = undefined;
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
    };
    const definitions = [{ name: 'collision', configureManifest: configure }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      "const plan = {version:3,components:[],omitted:[],unmet:[]};",
      "if (context.allowedOutputKinds.includes('agent')) {",
      `fs.appendFileSync(${JSON.stringify(counter)}, 'rendered\\n');`,
      "plan.components = ['first','second'].map(id => ({id,kind:'agent',name:'shared-role',content:{description:'Collision fixture.',prompt:'Review changes.'}}));",
      '}',
      'console.log(JSON.stringify(plan));',
    ].join('\n'));
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env });
    const result = await installFixturePlugin(['team/collision'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(result.overallState, JSON.stringify(result)).toBe('failed');
    expect(JSON.stringify(result)).toContain('Invalid component plan: duplicate component name shared-role.');
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(false);
    await expect(fs.readFile(counter, 'utf8')).resolves.toBe('rendered\n');
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin')
      && ['add', 'remove', 'enable', 'disable'].some((command) => invocation.args.includes(command)))).toEqual([]);
  });

  it('fails a dependency renderer and skips its consumer without platform writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'renderer-failure-source');
    const configure = (roleKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
    };
    const plugins = [
      { name: 'leaf', configureManifest: configure('leaf-role') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-role') },
      { name: 'independent', configureManifest: configure('independent-role') },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await Promise.all([
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), roleKey: 'leaf-role', fail: true,
      }),
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'root'), roleKey: 'root-role',
      }),
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'independent'), roleKey: 'independent-role',
      }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root', 'team/independent'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'skipped',
        errorCode: 'dependencyInstallFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent' }),
        state: 'completed',
      }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-root-root-role.toml")))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-independent-independent-role.toml")))
      .resolves.toBe(true);
  });

  it('preserves malformed selected config while cleanup and uninstall remove owned artifacts', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-removal-config-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: {},
        platforms: { codex: { fields: { mode: { type: 'string', required: true } } } } };
      manifest.extensions!.agents = [{ name: 'reader', description: 'Reader.', prompt: 'Read changes.' }];
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'cleanup-target', configureManifest: configure },
      { name: 'uninstall-target', configureManifest: configure },
      { name: 'guard-target', configureManifest: configure },
      { name: 'unrelated', configureManifest: configure },
      { name: 'config-only', configureManifest: configure },
      { name: 'no-live-other', configureManifest: configure },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    for (const pluginName of ['cleanup-target', 'uninstall-target', 'guard-target']) {
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, logicalIdentity, pluginName, platform: 'codex', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'valid' },
      });
    }
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin([
      'team/cleanup-target', 'team/uninstall-target', 'team/guard-target',
    ], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const rolePath = (pluginName: string) => path.join(isolation.layout.fixtureCwd, '.codex',
      'agents', `aw-team-${pluginName}-reader.toml`);
    for (const pluginName of ['cleanup-target', 'uninstall-target']) {
      await expect(fs.pathExists(rolePath(pluginName))).resolves.toBe(true);
      await fs.outputFile(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName, scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }), '{malformed');
    }

    const cleaned = await cleanupWriteCommand(['team/cleanup-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    const cleanupConfigPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'cleanup-target', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(cleaned.warnings.some((warning) => warning.includes('pluginConfigPreserved')),
      JSON.stringify(cleaned.warnings)).toBe(true);
    expect(cleaned.rebuildResults.some((result) => result.removed.length > 0)).toBe(true);
    await expect(fs.pathExists(rolePath('cleanup-target'))).resolves.toBe(false);
    await expect(fs.readFile(cleanupConfigPath, 'utf8')).resolves.toBe('{malformed');
    await fs.unlink(cleanupConfigPath);

    const uninstalled = await uninstallWriteCommand(['team/uninstall-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    expect(uninstalled.warnings.some((warning) => warning.includes('pluginConfigPreserved')),
      JSON.stringify(uninstalled.warnings)).toBe(true);
    expect(uninstalled.rebuildResults.some((result) => result.removed.length > 0)).toBe(true);
    await expect(fs.pathExists(rolePath('uninstall-target'))).resolves.toBe(false);
    const uninstallConfigPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'uninstall-target', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await expect(fs.readFile(uninstallConfigPath, 'utf8')).resolves.toBe('{malformed');
    await fs.unlink(uninstallConfigPath);

    const configOnlyPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'config-only', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.outputFile(configOnlyPath, '{config-only-malformed');
    const configOnlyPlatformBefore = await snapshotRegularTree(path.join(isolation.layout.fixtureCwd, '.codex'));
    const configOnlyNativeCallsBefore = runtime.nativeCliRunner.mock.calls.length;
    const configOnlyCleanup = await cleanupWriteCommand(['team/config-only'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(configOnlyCleanup.overallState).toBe('succeeded');
    expect(configOnlyCleanup.rebuildResults).toEqual([]);
    expect(configOnlyCleanup.targetResults).toEqual([]);
    await expect(fs.readFile(configOnlyPath, 'utf8')).resolves.toBe('{config-only-malformed');
    await expect(snapshotRegularTree(path.join(isolation.layout.fixtureCwd, '.codex')))
      .resolves.toEqual(configOnlyPlatformBefore);
    expect(runtime.nativeCliRunner.mock.calls.slice(configOnlyNativeCallsBefore)
      .every(([invocation]) => invocation.args.includes('--version')
        || invocation.args[invocation.args.indexOf('plugin') + 1] === 'list'
          && invocation.args.includes('--marketplace') && invocation.args.includes('--json'))).toBe(true);

    const unrelatedNoLive = await cleanupWriteCommand(['team/no-live-other'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unrelatedNoLive.overallState).toBe('succeeded');
    expect(unrelatedNoLive.targetResults).toEqual([]);
    await expect(fs.readFile(configOnlyPath, 'utf8')).resolves.toBe('{config-only-malformed');

    await fs.outputFile(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'unrelated', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }), '{unrelated-malformed');
    const guarded = await uninstallWriteCommand(['team/guard-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(guarded.overallState).toBe('failed');
    expect(guarded.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/guard-target' }),
      state: 'failed',
      errorCode: 'stateInventoryFailed',
    }));
    await expect(fs.pathExists(rolePath('guard-target'))).resolves.toBe(true);
  });

  it('blocks removal of a dependency after its known live consumer demand is removed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await removeRoot({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }, 'team/root');
    await expect(readIntentFixture({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ roots: [] });
    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(blocked).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'dependencyStillRequired' })],
    });

    const removedRoot = await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(removedRoot.overallState, JSON.stringify(removedRoot.rebuildResults)).toBe('succeeded');
  });

  it('force cleanup preserves a shared-only dependency placement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, runtime);
    expect(removed).toMatchObject({
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'completed',
      })],
    });

    const partial = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(partial.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      components: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'dependency', key: 'team/leaf', state: 'absent' }),
      ]),
    });

    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    const healthy = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(healthy.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      components: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'dependency', state: 'absent' }),
      ]),
    });
  });

  it('executes a complete batch uninstall in consumer-first reverse topology', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'batch-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await uninstallWriteCommand(['team/leaf', 'team/root', 'team/middle'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
    expect(removed.rebuildResults.map((entry) => entry.target.pluginName)).toEqual([
      'root', 'middle', 'leaf',
    ]);
  });

  it('allows removal when a catalog consumer is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'absent-consumer-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'ghost', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'absent-consumer-replacement');
    await createDependencyCatalogSnapshotFixture(replacementRoot, [
      { name: 'leaf' },
      { name: 'ghost', dependencies: ['leaf'] },
    ]);
    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update: { path: replacementRoot }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true });
  });

  it.each(['partial', 'error'] as const)(
    'cleans the selected dependency without inspecting a %s consumer',
    async (consumerState) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `consumer-${consumerState}-source`);
      const agent = (name: string) => ({
        name,
        configureManifest: (manifest: Awaited<ReturnType<typeof readPluginManifest>>['manifest']) => {
          manifest.extensions = {
            agents: [
              { name: `${name}-role`, description: `${name} role.`, prompt: `${name}.` },
              ...(name === 'root' ? [{
                name: `${name}-extra`, description: `${name} extra.`, prompt: `${name} extra.`,
              }] : []),
            ],
          };
        },
      });
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        agent('leaf'),
        { ...agent('root'), dependencies: ['leaf'] },
      ]);
      const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
      };
      await expect(installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const rootAgent = path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        "aw-team-root-root-role.toml",
      );
      await fs.remove(rootAgent);
      if (consumerState === 'error') await fs.ensureDir(rootAgent);

      const blocked = await cleanupWriteCommand(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);

      expect(blocked.overallState, JSON.stringify(blocked.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        "aw-team-leaf-leaf-role.toml",
      ))).resolves.toBe(false);
      await expect(fs.pathExists(rootAgent)).resolves.toBe(consumerState === 'error');
    },
  );

  it('keeps a dependency while multiple live consumers reference it', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'multiple-consumer-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'first', dependencies: ['leaf'] },
      { name: 'second', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);
  });

  it('uses current manifest edges for live consumer removal protection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'missing-consumer-contract-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);

    const batch = await uninstallWriteCommand(['team/leaf', 'team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(batch.overallState, JSON.stringify(batch.rebuildResults)).toBe('succeeded');
    expect(batch.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['root', 'leaf']);
  });

  it.each(['uninstall', 'cleanup-all'] as const)(
    'applies the command-specific cleanup boundary when the Active graph disagrees with a bundle (%s)',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `untrusted-removal-graph-${command}-source`,
      );
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
      };
      await expect(installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      await expect(installFixturePlugin(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

      const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
      const catalogManifest = await fs.readJson(catalogManifestPath);
      const rootEntry = catalogManifest.entries.find((entry: { name: string }) => entry.name === 'root');
      rootEntry.dependencies = [];
      await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      await expect(validateCatalogSnapshotTransport(active.snapshotPath)).resolves.toMatchObject({
        snapshotDigest: active.snapshotDigest,
      });

      const intentPath = path.join(
        isolation.layout.fixtureCwd,
        '.agent-workflows',
        'plugin-intents.json',
      );
      const intentBefore = await fs.readFile(intentPath, 'utf8');
      const platformRoot = path.join(isolation.layout.fixtureCwd, '.codex');
      const platformBefore = await snapshotRegularTree(platformRoot);

      if (command === 'uninstall') {
        await expect(uninstallWriteCommand(['team/leaf'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)).resolves.toMatchObject({ overallState: 'failed' });
        await expect(fs.readFile(intentPath, 'utf8')).resolves.toBe(intentBefore);
        await expect(snapshotRegularTree(platformRoot)).resolves.toEqual(platformBefore);
      } else {
        const cleaned = await runRecovery('cleanup', [], {
          scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
          cliVersion: '1.0.0', all: true, targets: ['codex'], yes: true,
        }, runtime);
        expect(cleaned.ok, JSON.stringify(cleaned.targetResults)).toBe(true);
        expect(cleaned.targetResults.map((target) => target.pluginId).sort())
          .toEqual(['team/leaf', 'team/root']);
        await expect(readFixtureRequirements({
          scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/root' }), expect.objectContaining({ pluginId: 'team/leaf' })]) });
        await expect(snapshotRegularTree(platformRoot)).resolves.not.toEqual(platformBefore);
      }
    },
  );

  it('does not use another project consumer to block an ordinary uninstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectA = isolation.layout.fixtureCwd;
    const projectB = path.join(isolation.layout.rootDir, 'dependency-project-b');
    registerCurrentTestWritableStateRoot(projectB, 'secondary current project');
    const sourceRoot = path.join(projectA, 'historical-consumer-source');
    await fs.ensureDir(projectB);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const { runtime } = await createClaudeNativeTestRuntime(isolation);
    const userLeaf = await installFixturePlugin(['team/leaf'], {
      cwd: projectA, platform: 'claude', scope: 'user',
    }, runtime);
    expect(userLeaf.overallState, JSON.stringify(userLeaf.rebuildResults)).toBe('succeeded');
    const projectRoot = await installFixturePlugin(['team/root'], {
      cwd: projectA, platform: 'claude', scope: 'project',
    }, runtime);
    expect(projectRoot.overallState, JSON.stringify(projectRoot.rebuildResults)).toBe('succeeded');

    const removed = await uninstallWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'claude', scope: 'user',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
  });

  // Test Value Gate: an ordinary public remove of the last Claude consumer
  // must unregister and remove the proven owned root and orphan dependency packages, not merely disable them.
  it.each(['user', 'project'] as const)('removes the last active Claude package from the %s scope', async (scope) => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const sourceRoot = path.join(cwd, 'ordinary-claude-remove');
    const configureManifest = (manifest: PluginMeta['manifest']) => { manifest.platforms = ['claude']; };
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'demo', dependencies: ['leaf'], configureManifest }, { name: 'leaf', configureManifest },
    ]);
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: config.digest, env });
    const claude = await createClaudeNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/demo'], { cwd, platform: 'claude', scope }, claude.runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const deployments = await Promise.all(['demo', 'leaf'].map((name) => nativeFixtureLayout(name, 'team', scope, 'claude')));
    for (const deployment of deployments) {
      expect(await fs.pathExists(deployment.packageRoot)).toBe(true);
      expect((await fs.readJson(claude.installedPath)).plugins[deployment.nativeIdentity.registrationId!]).toHaveLength(1);
    }

    const result = await runPublicLifecycle('remove', ['team/demo'], { cwd, env, cliVersion: '1.0.0',
      scope, context: scope, yes: true }, claude.runtime);
    expect(result.status, JSON.stringify(result)).toBe('success');
    for (const deployment of deployments) {
      expect(await fs.pathExists(deployment.packageRoot), JSON.stringify(result)).toBe(false);
      expect((await fs.readJson(claude.installedPath)).plugins[deployment.nativeIdentity.registrationId!]).toBeUndefined();
    }
  });

  // Test Value Gate: the selected active removal still must preserve another
  // scope's registration; an outputs-only request cannot gain its deletion authority.
  it.each(['shared', 'outputs-only'] as const)('keeps the proven Claude package during %s removal', async (mode) => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const sourceRoot = path.join(cwd, 'preserved-claude-remove');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo', configureManifest: manifest => { manifest.platforms = ['claude']; } }]);
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: config.digest, env });
    const claude = await createClaudeNativeTestRuntime(isolation);
    const scope = 'project' as const;
    const location = { cwd, env, cliVersion: '1.0.0', scope, context: scope, yes: true as const };
    if (mode === 'shared') {
      const installed = await installFixturePlugin(['team/demo'], { cwd, platform: 'claude', scope: 'user' }, claude.runtime);
      expect(installed.overallState).toBe('succeeded');
    }
    const installed = await installFixturePlugin(['team/demo'], { cwd, platform: 'claude', scope }, claude.runtime);
    expect(installed.overallState).toBe('succeeded');
    const deployment = await nativeFixtureLayout('demo', 'team', scope, 'claude');
    const registration = deployment.nativeIdentity.registrationId!;
    if (mode === 'outputs-only') {
      const cleared = await runPublicLifecycle('remove', ['team/demo'], { ...location, only: 'requirements' }, claude.runtime);
      expect(cleared.status).toBe('success');
    }
    const result = await runPublicLifecycle('remove', ['team/demo'], { ...location,
      ...(mode === 'outputs-only' ? { only: 'outputs' as const, targets: ['claude'] } : {}) }, claude.runtime);
    expect(result.status, JSON.stringify(result)).toBe('success');
    expect(await fs.pathExists(deployment.packageRoot)).toBe(true);
    const records = (await fs.readJson(claude.installedPath)).plugins[registration];
    expect(records).toContainEqual(expect.objectContaining({ scope: mode === 'shared' ? 'user' : 'local' }));
  });

  it('cleans live ownership after source config deletion while uninstall remains catalog dependent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-removal-source');
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'remaining-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const nativeCliRunner = vi.fn(defaultNativeRuntime.nativeCliRunner);
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(configPath, 'utf8');
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    nativeCliRunner.mockClear();

    const missing = await statusCommandV8({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(missing.payload.targets).toEqual([
      expect.objectContaining({
        state: 'blocked',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'sourceMissing' }),
          expect.objectContaining({ code: 'codexIntentSourceUnavailable' }),
        ]),
      }),
    ]);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    }));
    const review = await dependencies.prepareScopedTask({
      kind: 'recovery', scope: 'project', command: 'cleanup',
      selectors: ['team/demo'], targets: ['codex'],
    }, new AbortController().signal);
    const execution = await dependencies.executeScopedTask(review);
    expect(execution).toMatchObject({ kind: 'recovery', receipt: {
      command: 'cleanup', ok: true,
    } });
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toBe(before);
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('aw-owner-v3:');
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ values: { retained: true } });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/demo' })]) });

    const uninstall = await uninstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(uninstall.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'catalogSourceUnavailable' }),
    ]);
  }, 30_000);

  it('removes a deleted native plugin and its shared user activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const before = await statusCommandV8({
      ...options, plugins: ['demo'], env: isolation.env,
    });
    expect(before.payload.errors).toEqual([]);
    expect(before.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked', reasons: expect.arrayContaining([expect.objectContaining({ code: 'bundleUnavailable' })]),
    })]);
    const retired = await runRetire({
      scope: 'user', cwd: options.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true,
    }, runtime);
    expect(retired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      ok: true, declarationChanged: true, configChanged: false });
    const config = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins[await nativeRegistrationId("demo", "official")]).toBeUndefined();
    expect((await readFixtureRequirements({ scope: 'user', cwd: options.cwd,
      env: isolation.env })).roots).toEqual([]);
    const after = await statusCommandV8({
      ...options, plugins: ['demo'], env: isolation.env,
    });
    expect(after.payload.errors).toContainEqual(expect.objectContaining({ code: 'pluginNotFound' }));
    expect(after.payload.targets).toEqual([]);
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId),
      JSON.stringify({ retired, scopedInventories: controller.snapshot.scopedInventories }))
      .not.toContain('official/demo');
    expect(controller.listPlugins({ mode: 'browse', installFilter: 'uninstalled' })
      .map((plugin) => plugin.pluginId)).not.toContain('official/demo');
    controller.dispose();
  });
});
