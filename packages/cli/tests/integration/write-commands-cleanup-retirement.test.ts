import { writeIntentFixture, readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { createNativeTestExecution } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { realpath } from 'node:fs/promises';
import { render } from 'ink-testing-library';
import { runRecovery } from '../../src/recovery/coordinator.js';
import * as pluginConfig from '../../src/utils/plugin-config.js';
import { prepareRetire, executeRetire, runRetire } from '../../src/recovery/retirement.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { observePreferences, resolvePreferencesPath, writePreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent, removeRoot } from '../../src/intent/intent-store.js';
import { portableJsonDigest } from '../../src/portable/historical-materialization.js';
import { runRebuildCommand } from '../../src/commands/rebuild-command.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation, registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { readPluginConfigStore, resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { type NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { PluginMeta } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import {
  parseOwnedTextHeader,
  SKILL_OWNER_MARKER,
  writeOwnedTextFile,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';
import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
  removeCodexMarketplace,
} from '../../src/utils/codex-config.js';

import {
  syncWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  addProjectFixtureRoots,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  configureCatalog,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
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
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['user'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'demo-role',
        }],
      };
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
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-demo-demo-role.toml');

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
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['user'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'demo-role',
      }] };
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
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-demo-demo-role.toml');
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
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'leaf-role',
        }],
      };
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
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-leaf-leaf-role.toml');
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    expect(await fs.readFile(configPath, 'utf8')).toContain('aw-owner-v3:');
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
    expect((await fs.readFile(configPath, 'utf8').catch(() => ''))).not.toContain('aw-owner-v3:');
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
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
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const agentsRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
      const realRole = path.join(agentsRoot, 'aw-demo-real-role.toml');
      const obsoleteRole = path.join(agentsRoot, 'aw-demo-obsolete-role.toml');
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
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'rendered-collision-counts');
    await fs.ensureDir(counterRoot);
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present', 'disabled'], refreshKeys: [],
          roleKey: 'shared-role',
        }],
      };
    };
    const plugins = [
      { name: 'first', configureManifest: configure },
      { name: 'second', configureManifest: configure },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await Promise.all(plugins.map((plugin) => writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', plugin.name),
      roleKey: 'shared-role',
      counterRoot,
    })));
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

    const result = await installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'artifactCollision' }),
    ]));
    await expect(fs.pathExists(path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents',
    ))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
    for (const plugin of plugins) {
      await expect(fs.readFile(path.join(counterRoot, `render-count-${plugin.name}.txt`), 'utf8'))
        .resolves.toBe('1');
    }
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
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey,
        }],
      };
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
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-root-root-role.toml')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-independent-independent-role.toml')))
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
      'agents', `aw-${pluginName}-reader.toml`);
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const rootAgent = path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        'aw-root-root-role.toml',
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
        'aw-leaf-leaf-role.toml',
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
    const marketplaceRoots = new Map<string, string>();
    const runtime = { env: isolation.env, nativeCliRunner: async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude' && invocation.args[0] === 'plugin') {
        const scopeIndex = invocation.args.indexOf('--scope');
        const scope = scopeIndex === -1 ? 'user' : invocation.args[scopeIndex + 1]!;
        const projectPath = await fs.realpath(invocation.cwd ?? projectA);
        const settingsPath = scope === 'project'
          ? path.join(projectPath, '.claude', 'settings.json')
          : path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'settings.json');
        const pluginsDir = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'plugins');
        const knownPath = path.join(pluginsDir, 'known_marketplaces.json');
        const installedPath = path.join(pluginsDir, 'installed_plugins.json');
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            extraKnownMarketplaces: {
              ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>),
              [config.marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } },
            },
          });
          const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(knownPath, {
            ...known,
            [config.marketplaceName]: {
              source: { source: 'directory', path: marketplaceRoot },
              installLocation: marketplaceRoot,
            },
          });
        }
        if (invocation.args[1] === 'install') {
          const pluginId = invocation.args[2]!;
          const separator = pluginId.lastIndexOf('@');
          const pluginName = pluginId.slice(0, separator);
          const marketplaceName = pluginId.slice(separator + 1);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            enabledPlugins: {
              ...((settings.enabledPlugins ?? {}) as Record<string, unknown>),
              [pluginId]: true,
            },
          });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = { ...(installed.plugins ?? {}) };
          delete plugins[pluginName];
          await fs.outputJson(installedPath, { plugins: {
            ...plugins,
            [pluginId]: [{
              name: pluginName, scope,
              ...(scope === 'project' ? { projectPath } : {}), version: '1.0.0',
            }],
          } });
          await fs.ensureDir(path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
        if (invocation.args[1] === 'uninstall') {
          const pluginId = invocation.args[2]!;
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const enabledPlugins = { ...((settings.enabledPlugins ?? {}) as Record<string, unknown>) };
          delete enabledPlugins[pluginId];
          await fs.outputJson(settingsPath, { ...settings, enabledPlugins });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = { ...(installed.plugins ?? {}) };
          delete plugins[pluginId];
          await fs.outputJson(installedPath, { plugins });
        }
      }
      return { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' };
    } };
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
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    }));
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
      declarationChanged: true, configChanged: false });
    const config = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins['demo@aw']?.enabled).toBe(false);
    expect((await readFixtureRequirements({ scope: 'user', cwd: options.cwd,
      env: isolation.env })).roots).toEqual([]);
    const after = await statusCommandV8({
      ...options, plugins: ['demo'], env: isolation.env,
    });
    expect(after.payload.errors).toEqual([]);
    expect(after.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'official/demo', state: 'blocked',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'removedPluginCleanupRequired' })]),
    })]);
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId))
      .toContain('official/demo');
    expect(controller.listPlugins({ mode: 'browse', installFilter: 'uninstalled' })
      .map((plugin) => plugin.pluginId)).not.toContain('official/demo');
    controller.dispose();
  });

  it('reviews both scopes and deletes only the removed plugin settings and Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-whole-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'official', env: isolation.env });
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity, logicalIdentity: active.logicalIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env, values: { common: true },
    });
    for (const platform of ['codex', 'claude'] as const) {
      await writePluginConfigStore({
        sourceId: 'official', sourceIdentity: active.sourceIdentity,
        logicalIdentity: active.logicalIdentity, pluginName: 'demo', scope: 'user', platform,
        cwd, env: isolation.env, values: { secret: platform },
      });
    }
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity,
      pluginName: 'other', scope: 'user', cwd, env: isolation.env,
      values: { retained: true },
    });
    for (const scope of ['user', 'project'] as const) {
      const location = { scope, cwd, env: isolation.env };
      await writeIntentFixture(location, {
        schemaVersion: 2, kind: 'aw-plugin-intents',
        roots: [
          { pluginId: 'official/demo', platforms: ['codex', 'claude'] },
          { pluginId: 'official/other', platforms: ['codex'] },
        ],
        dependencyScopeOverrides: [],
      });
    }
    const preferencesPath = await resolvePreferencesPath({ scope: 'user', cwd, env: isolation.env });
    const preferencesBefore = await fs.readFile(preferencesPath);
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'demo@aw': false },
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectOptions = { scope: 'project' as const, cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'] as const, deleteConfig: false };
    const preview = await prepareRetire(projectOptions, runtime);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.stringContaining('删除 project 声明 official/demo'),
    ]));
    const unauthorized = await executeRetire(preview);
    expect(unauthorized.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewRequired' }),
    ]));
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots)
      .toContainEqual({ pluginId: 'official/demo', platforms: ['claude', 'codex'] });
    const stalePreview = await prepareRetire(projectOptions, runtime);
    const preferenceLocation = { scope: 'project' as const, cwd, env: isolation.env };
    const originalPreferences = await observePreferences(preferenceLocation);
    if (originalPreferences.state !== 'valid') throw new Error('Expected valid project preferences.');
    await writePreferences(preferenceLocation, { ...originalPreferences.value, targets: ['codex'] });
    const stale = await executeRetire(stalePreview, { yes: true });
    expect(stale.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    await writePreferences(preferenceLocation, originalPreferences.value);
    const projectRetired = await runRetire({ ...projectOptions, yes: true }, runtime);
    expect(projectRetired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      scope: 'project', declarationChanged: true, preferencesChanged: false, configChanged: false });
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots)
      .toEqual([{ pluginId: 'official/other', platforms: ['codex'] }]);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toContainEqual({ pluginId: 'official/demo', platforms: ['claude', 'codex'] });
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    }))).toBe(true);
    const userRetired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], deleteConfig: true, yes: true }, runtime);
    expect(userRetired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      scope: 'user', declarationChanged: true, preferencesChanged: false, configChanged: true });
    for (const scope of ['user', 'project'] as const) {
      const state = await readFixtureRequirements({ scope, cwd, env: isolation.env });
      expect(state.roots).toEqual([{ pluginId: 'official/other', platforms: ['codex'] }]);
      expect(state.dependencyScopeOverrides).toEqual([]);
    }
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    }))).toBe(false);
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    }))).toBe(false);
    expect((await readPluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity, pluginName: 'other',
      scope: 'user', cwd, env: isolation.env,
    })).values).toEqual({ retained: true });
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    const repeated = await runRetire({ ...projectOptions, yes: true }, runtime);
    expect(repeated.declarationChanged).toBe(false);
  });

  // Test Value Gate: a receipt retry must retain config deletion and the original output target boundary.
  it('retries config deletion through the retirement receipt without expanding output targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'removed-config-receipt-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: initial.digest, env: isolation.env });
    const runtime = await createClaudeNativeTestRuntime(isolation);
    for (const platform of ['codex', 'claude'] as const) {
      await expect(installFixturePlugin(['team/demo'], { cwd, platform, scope: 'user' }, runtime.runtime))
        .resolves.toMatchObject({ overallState: 'succeeded' });
    }
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env, values: { retained: true } });
    const configPath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
      scope: 'user', cwd, env: isolation.env });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0',
      env: isolation.env, impactConfirmed: true });
    const claudeSettingsPath = path.join(runtime.claudeHome, 'settings.json');
    const claudeBefore = await fs.readFile(claudeSettingsPath);
    const reset = vi.spyOn(pluginConfig, 'deletePluginConfigStore').mockRejectedValueOnce(
      Object.assign(new Error('injected config deletion failure'), { code: 'configResetFailed' }));
    const failed = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'team/demo', targets: ['codex'], deleteConfig: true, yes: true }, runtime.runtime)
      .finally(() => reset.mockRestore());
    expect(failed).toMatchObject({ ok: false, declarationChanged: true,
      configChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'configResetFailed' })]) });
    expect(await fs.pathExists(configPath)).toBe(true);

    const retry = failed.recoveryActions.find((action) => action.startsWith('aw plugin intent retire '));
    expect(retry).toBeDefined();
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...retry!.split(' ').slice(1), '--yes', '--json'], {
      cwd, env: isolation.env, io: captured.io, interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
    });
    const recovered = JSON.parse(captured.readStdout());
    expect(exitCode, JSON.stringify(recovered)).not.toBe(2);
    expect(recovered).toMatchObject({ command: 'intent:retire', configChanged: true, declarationChanged: false });
    expect(recovered.requestedTargets.map((target: { agent: string }) => target.agent)).toEqual(['codex']);
    expect(recovered.recoveryActions.join('\n')).not.toContain('--delete-config');
    expect(await fs.pathExists(configPath)).toBe(false);
    expect(await fs.readFile(claudeSettingsPath)).toEqual(claudeBefore);
  });

  it('keeps shared Codex output when official observation fails, then retries retirement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-retry-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const selected = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], selected, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const workingRunner = runtime.nativeCliRunner.getMockImplementation()!;
    runtime.nativeCliRunner.mockImplementation(async (invocation) =>
      invocation.args.includes('list') && invocation.args.includes('--json')
        ? { exitCode: 1, stdout: '', stderr: 'simulated failure' }
        : workingRunner(invocation));
    const retireOptions = { scope: 'user' as const, cwd: selected.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const failed = await runRetire(retireOptions, runtime);
    expect(failed.ok).toBe(false);
    expect(failed.targetResults[0]?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sharedNativePreserved' }),
    ]));
    expect(runtime.installed.has('demo@aw')).toBe(true);
    expect(await fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo')))
      .toBe(true);
    runtime.nativeCliRunner.mockImplementation(workingRunner);
    const recovered = await runRetire(retireOptions, runtime);
    expect(recovered.command).toBe('intent:retire');
    expect(runtime.installed.has('demo@aw')).toBe(true);
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .snapshot.plugins['demo@aw']?.enabled).toBe(false);
    expect((await readFixtureRequirements({ scope: 'user', cwd: selected.cwd, env: isolation.env })).roots)
      .toEqual([]);
  });

  it('keeps declarations and the other scope unchanged during mixed ordinary cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-mixed-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    const user = { cwd, platform: 'codex' as const, scope: 'user' as const };
    for (const pluginId of ['official/demo', 'official/other']) {
      await expect(installFixturePlugin([pluginId], user, runtime))
        .resolves.toMatchObject({ overallState: 'succeeded' });
    }
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'demo@aw': false, 'other@aw': false },
    });
    await writeIntentFixture({ scope: 'project', cwd, env: isolation.env }, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'official/demo', platforms: ['codex'] },
        { pluginId: 'official/other', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const selectors = ['official/demo', 'other'];
    const projectIntentBefore = await observeIntent({
      scope: 'project', cwd, env: isolation.env,
    });
    const userIntentBefore = await observeIntent({
      scope: 'user', cwd, env: isolation.env,
    });
    const projectConfigBefore = await fs.readFile(projectConfigPath);
    const preview = await cleanupWriteCommand(selectors, user, {
      ...runtime, previewOperationPlan: true,
    });
    expect(preview.operationPlan?.actions.some((action) => action.scope === 'project'))
      .toBe(false);
    const cleaned = await cleanupWriteCommand(selectors, { ...user, yes: true }, {
      ...runtime, expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
    });
    expect(cleaned.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ pluginId: 'official/other', scope: 'user', platform: 'codex' }) }),
    ]));
    await expect(observeIntent({ scope: 'project', cwd, env: isolation.env }))
      .resolves.toEqual(projectIntentBefore);
    await expect(observeIntent({ scope: 'user', cwd, env: isolation.env }))
      .resolves.toEqual(userIntentBefore);
    await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectConfigBefore);
    expect(runtime.installed.has('demo@aw')).toBe(true);
  });

  it('preserves shared Codex projection when official retirement evidence becomes unknown', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-unknown-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const selected = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], selected, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const workingRunner = runtime.nativeCliRunner.getMockImplementation()!;
    let listCalls = 0;
    runtime.nativeCliRunner.mockImplementation(async (invocation) => {
      const args = invocation.args;
      if (args.includes('list') && args.includes('--json') && ++listCalls > 2) {
        return { exitCode: 1, stdout: '', stderr: 'simulated postcheck unavailable' };
      }
      return workingRunner(invocation);
    });
    const retireOptions = { scope: 'user' as const, cwd: selected.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const failed = await runRetire(retireOptions, runtime);
    expect(failed.ok).toBe(false);
    const projection = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo');
    expect(await fs.pathExists(projection)).toBe(true);
    expect(runtime.installed.has('demo@aw')).toBe(true);
    runtime.nativeCliRunner.mockImplementation(workingRunner);
    const recovered = await runRetire(retireOptions, runtime);
    expect(recovered.command).toBe('intent:retire');
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .snapshot.plugins['demo@aw']?.enabled).toBe(false);
    expect(await fs.pathExists(projection)).toBe(true);
  });

  it('retires removed Claude demand one scope at a time and preserves the shared package', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-claude-source');
    const definitions = ['demo', 'other'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['claude'];
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    const { runtime, nativeCliRunner, installedPath, claudeHome, projectRoot }
      = await createClaudeNativeTestRuntime(isolation);
    for (const [pluginId, scope] of [
      ['official/demo', 'user'], ['official/demo', 'project'], ['official/other', 'user'],
    ] as const) {
      const installed = await installFixturePlugin([pluginId], { cwd, platform: 'claude', scope }, runtime);
      expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');
    }
    const before = await fs.readJson(installedPath) as { plugins: Record<string, unknown[]> };
    expect(before.plugins['demo@aw']).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user' }),
      expect.objectContaining({ scope: 'project', projectPath: projectRoot }),
    ]));
    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectRetired = await runRetire({ scope: 'project', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(projectRetired.declarationChanged).toBe(true);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toContainEqual(expect.objectContaining({ pluginId: 'official/demo' }));
    const userRetired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(userRetired.declarationChanged).toBe(true);
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots).toEqual([]);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toEqual([expect.objectContaining({ pluginId: 'official/other' })]);
    const uninstallScopes = nativeCliRunner.mock.calls.filter(([invocation]) =>
      invocation.command === 'claude' && invocation.args[0] === 'plugin'
      && invocation.args[1] === 'uninstall' && invocation.args[2] === 'demo@aw')
      .map(([invocation]) => invocation.args[invocation.args.indexOf('--scope') + 1]);
    expect(uninstallScopes).toEqual([]);
    const after = await fs.readJson(installedPath) as { plugins: Record<string, unknown[]> };
    expect(after.plugins['demo@aw']).toEqual(before.plugins['demo@aw']);
    expect(after.plugins['other@aw']).toEqual([expect.objectContaining({ scope: 'user' })]);
    expect((await fs.readJson(path.join(claudeHome, 'settings.json'))).enabledPlugins)
      .toMatchObject({ 'other@aw': true });
    expect(await fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'other')))
      .toBe(true);
  });

  it.each([
    ['canonical with bare record', 'canonical'],
    ['foreign registration with bare record', 'foreign'],
    ['unreadable marketplace registration', 'unknown'],
  ] as const)('keeps Claude shared native ownership safe during retirement for %s', async (_label, mode) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `removed-claude-${mode}-source`);
    const definitions = ['demo', 'other'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['claude'];
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    const { runtime, nativeCliRunner, installedPath, claudeHome } = await createClaudeNativeTestRuntime(isolation);
    for (const pluginId of ['official/demo', 'official/other']) {
      const installed = await installFixturePlugin([pluginId], {
        cwd, platform: 'claude', scope: 'user',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');
    }
    if (mode !== 'unknown') {
      const installed = await fs.readJson(installedPath) as {
        plugins: Record<string, Array<Record<string, unknown>>>;
      };
      installed.plugins.demo = [{ name: 'demo', scope: 'user', version: '1.0.0' }];
      await fs.outputJson(installedPath, installed);
    }
    const settingsPath = path.join(claudeHome, 'settings.json');
    if (mode === 'foreign') {
      const settings = await fs.readJson(settingsPath) as Record<string, unknown>;
      const extraKnownMarketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
      extraKnownMarketplaces.aw = {
        source: { source: 'directory', path: path.join(cwd, 'foreign-marketplace') },
      };
      await fs.outputJson(settingsPath, settings);
    }
    if (mode === 'unknown') {
      await fs.outputFile(path.join(claudeHome, 'plugins', 'known_marketplaces.json'), '{bad json');
    }
    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    nativeCliRunner.mockClear();
    const retired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(retired.configChanged).toBe(false);
    const uninstalls = nativeCliRunner.mock.calls.filter(([invocation]) =>
      invocation.command === 'claude' && invocation.args[0] === 'plugin'
      && invocation.args[1] === 'uninstall' && invocation.args[2] === 'demo@aw');
    expect(uninstalls).toHaveLength(0);
    const records = (await fs.readJson(installedPath)).plugins as Record<string, unknown[]>;
    if (mode !== 'unknown') {
      expect(records.demo).toEqual([expect.objectContaining({ name: 'demo' })]);
    }
    expect(records['demo@aw']).toEqual([expect.objectContaining({ name: 'demo' })]);
    expect(records['other@aw']).toEqual([expect.objectContaining({ name: 'other' })]);
    const projection = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo');
    expect(await fs.pathExists(projection)).toBe(true);
    if (mode === 'foreign') {
      expect(JSON.stringify(retired.blockers)).toContain('removedPluginClaudeOwnershipConflict');
    }
    if (mode === 'unknown') {
      expect(JSON.stringify(retired.blockers)).toContain('removedPluginMarketplaceRegistrationUnknown');
    }
  });

  it('preserves project activation when the canonical native registration is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-unbound-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    runtime.installed.delete('demo@aw');
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    await fs.outputFile(userConfigPath,
      removeCodexMarketplace(await fs.readFile(userConfigPath, 'utf8'), 'aw'));
    await applyCodexConfigTransactionFile(userConfigPath, {
      removePluginActivations: ['demo@aw'],
    });
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'demo@aw': false },
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const result = await runRetire({ scope: 'project', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true }, runtime);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.blockers)).toContain('removedPluginNativeOwnershipUnavailable');
    expect((await readCodexConfigFile(projectConfigPath)).snapshot.plugins['demo@aw']?.enabled)
      .toBe(false);
    expect(await fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo')))
      .toBe(true);
  });

  it('does not delete shared marketplace projection when its remove operation would fail', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-projection-retry-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const projection = path.join(marketplaceRoot, 'plugins', 'demo');
    await fs.remove(path.join(projection, '.agents-plugin'));
    await fs.remove(path.join(projection, '.codex-plugin'));
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const options = { scope: 'user' as const, cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const removeOriginal = fs.remove.bind(fs);
    let projectionRemoveAttempted = false;
    const remove = vi.spyOn(fs, 'remove').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(projection)) {
        projectionRemoveAttempted = true;
        throw new Error('simulated projection delete failure');
      }
      return removeOriginal(candidate);
    });
    const first = await runRetire(options, runtime).finally(() => remove.mockRestore());
    expect(projectionRemoveAttempted).toBe(false);
    expect(first.declarationChanged).toBe(true);
    const manifestPath = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
    const manifestBefore = await fs.readFile(manifestPath);
    expect(await fs.pathExists(projection)).toBe(true);
    const second = await runRetire(options, runtime);
    expect(second.declarationChanged).toBe(false);
    await expect(fs.readFile(manifestPath)).resolves.toEqual(manifestBefore);
    expect(await fs.pathExists(projection)).toBe(true);
  });

  it('preserves a foreign tree behind a symlinked marketplace plugins ancestor', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-symlinked-projection-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const pluginsRoot = path.join(marketplaceRoot, 'plugins');
    const foreignRoot = path.join(cwd, 'foreign-marketplace-plugins');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    await fs.move(pluginsRoot, foreignRoot);
    await fs.symlink(foreignRoot, pluginsRoot, 'dir');
    const foreignFile = path.join(foreignRoot, 'demo', 'preserve.txt');
    await fs.outputFile(foreignFile, 'foreign content\n');
    const cleaned = await cleanupWriteCommand(['official/demo'], {
      cwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime);
    expect(cleaned.overallState).toBe('succeeded');
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('foreign content\n');
    const result = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true }, runtime);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.blockers)).toContain('removedPluginMarketplaceProjectionUnsafe');
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('foreign content\n');
    expect(runtime.installed.has('demo@aw')).toBe(true);
  });

  it.each([['absent', false], ['unknown', false], ['unknown', true]] as const)('retires User demand without reading caller Project Portable and legacy config state (%s, subdirectory=%s)', async (portableState, fromSubdirectory) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-config-only-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'team', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    if (fromSubdirectory) await git(cwd, ['init']);
    const invocationCwd = fromSubdirectory ? path.join(cwd, 'nested', 'child') : cwd;
    await fs.ensureDir(invocationCwd);
    const userPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    });
    await fs.outputFile(userPath, '{broken-json');
    expect(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    })).toBe(userPath);
    const projectPath = path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json');
    await fs.outputFile(projectPath, '{broken-project-json');
    await addProjectFixtureRoots({ cwd, env: isolation.env, selectors: ['team/demo'] });
    await writeIntentFixture({ cwd, env: isolation.env, scope: 'user' }, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });
    const providerRoot = path.join(cwd, '.agent-workflows', '.local', 'portable', portableJsonDigest('team/demo').slice(7));
    const portableSkill = path.join(cwd, '.agents', 'skills', 'unverified-demo', 'SKILL.md');
    if (portableState === 'unknown') {
      await fs.outputFile(path.join(providerRoot, 'evidence.txt'), 'unverified provider evidence');
      await fs.outputFile(portableSkill, 'portable bytes must remain');
    }
    const binRoot = path.join(isolation.layout.rootDir, 'unavailable-skills-bin');
    await fs.outputFile(path.join(binRoot, 'skills'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    const env = { ...isolation.env, PATH: `${binRoot}${path.delimiter}${isolation.env.PATH ?? ''}` };

    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectIntentBefore = await observeIntent({ cwd, env, scope: 'project' });
    const configBefore = await fs.readFile(userPath);
    const projectConfigBefore = await fs.readFile(projectPath);
    const retirement = { cwd: invocationCwd, env, scope: 'user' as const,
      selector: 'team/demo', targets: ['codex'], yes: true };
    const preview = await prepareRetire(retirement, { nativeCliRunner: async () => ({
      exitCode: 0, stdout: '{"installed":[],"available":[]}', stderr: '',
    }) });
    expect(preview.receipt.command).toBe('intent:retire');
    const receipt = await executeRetire(preview, { yes: true });
    expect(receipt).toMatchObject({ kind: 'aw-recovery', scope: 'user',
      declarationChanged: true, configChanged: false });
    if (portableState === 'unknown') {
      await expect(fs.readFile(portableSkill, 'utf8')).resolves.toBe('portable bytes must remain');
      await expect(fs.readFile(path.join(providerRoot, 'evidence.txt'), 'utf8')).resolves.toBe('unverified provider evidence');
    }
    await expect(fs.readFile(userPath)).resolves.toEqual(configBefore);
    await expect(fs.readFile(projectPath)).resolves.toEqual(projectConfigBefore);
    await expect(observeIntent({ cwd, env, scope: 'project' })).resolves.toEqual(projectIntentBefore);
    await expect(readIntentFixture({ cwd, env, scope: 'user' })).resolves.toMatchObject({ roots: [] });
  });

  it('blocks explicit retirement when Active is unavailable and preserves saved config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-config-only-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-config-only-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'team', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    const cwd = isolation.layout.fixtureCwd;
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
      values: { retained: true },
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'remaining', type: 'path', primary: true, path: remainingRoot,
      }] },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const result = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'team/demo', targets: ['claude'], yes: true });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'removedPluginActiveUnavailable' }),
    ]));
    expect(result.configChanged).toBe(false);
    expect((await readPluginConfigStore({
      sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    })).values).toEqual({ retained: true });
  });

  it.each(['directory', 'binding', 'binding-user-catalog', 'binding-project-source', 'symlink'] as const)(
    'keeps the exact config reset boundary for a deleted plugin (%s)',
    async (mode) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `removed-config-${mode}-source`);
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [{
          id: 'team', type: 'path', primary: true, path: sourceRoot,
        }] },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      const cwd = isolation.layout.fixtureCwd;
      const scope = mode === 'directory' || mode === 'binding-project-source' ? 'project' : 'user';
      if (scope === 'project') await fs.ensureDir(path.join(cwd, '.git'));
      const configPath = resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'demo', scope, cwd, env: isolation.env,
      });
      const external = path.join(cwd, 'config-link-target.json');
      if (mode === 'directory') {
        await fs.ensureDir(configPath);
      } else if (mode.startsWith('binding')) {
        await fs.outputJson(configPath, {
          schemaVersion: 5, sourceId: 'team', pluginName: 'demo',
          binding: mode === 'binding-user-catalog'
            ? { kind: 'catalog', logicalIdentity: active.logicalIdentity }
            : mode === 'binding-project-source'
              ? { kind: 'source', sourceIdentity: active.sourceIdentity }
              : { kind: 'source', sourceIdentity: `sha256:${'0'.repeat(64)}` },
          values: { retained: true },
        });
      } else {
        await fs.outputFile(external, 'retained\n');
        await fs.ensureDir(path.dirname(configPath));
        await fs.symlink(external, configPath, 'file');
      }
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
      await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const result = await runRetire({ scope, cwd, env: isolation.env,
        selector: 'team/demo', targets: ['claude'], deleteConfig: true, yes: true });
      if (mode === 'symlink') {
        expect(result.configChanged).toBe(true);
        expect(await fs.pathExists(configPath)).toBe(false);
        expect(await fs.readFile(external, 'utf8')).toBe('retained\n');
      } else {
        expect(result.ok).toBe(false);
        expect(await fs.pathExists(configPath)).toBe(true);
        expect(JSON.stringify(result.blockers)).toContain(mode === 'directory'
          ? 'removedPluginConfigTargetUnsupported'
          : 'removedPluginConfigIdentityConflict');
      }
    },
  );

  it.each([
    { mode: 'owned-normal', force: false, intentOnly: false },
    { mode: 'owned-force', force: true, intentOnly: false },
    { mode: 'intent-only-normal', force: false, intentOnly: true },
  ] as const)(
    'retires through scoped TUI Review after the Active Catalog drops the plugin ($mode)',
    async ({ force, intentOnly }) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `active-entry-removed-${force ? 'force' : 'normal'}-source`,
      );
      const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
      const configure = (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = undefined;
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'],
          refreshKeys: [], roleKey: 'demo-role',
        }] };
      };
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
      await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role' });
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const installed = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
      const projectIntentLocation = {
        scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      const userIntentLocation = {
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      await writeIntentFixture(userIntentLocation, {
        schemaVersion: 2,
        kind: 'aw-plugin-intents',
        roots: [{ pluginId: 'team/other', platforms: ['codex'] }],
        dependencyScopeOverrides: [],
      });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
      });
      const activeBeforeRemoval = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, logicalIdentity: activeBeforeRemoval.logicalIdentity,
        pluginName: 'demo', scope: 'user', platform: 'codex', cwd: isolation.layout.fixtureCwd,
        env: isolation.env, values: { selected: true },
      });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'other', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: 'other' },
      });
      const preferencesPath = await resolvePreferencesPath(userIntentLocation);
      const preferencesBefore = await fs.readFile(preferencesPath);
      const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(sharedConfig, {
        upsertMcpServers: { foreign: { command: 'foreign' } },
      });
      const foreignSkill = path.join(
        isolation.layout.fixtureCwd, '.agents', 'skills', 'foreign-skill', 'SKILL.md',
      );
      await fs.outputFile(foreignSkill, 'foreign\n');
      const ownedRole = path.join(
        isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-demo-role.toml',
      );
      await expect(fs.pathExists(ownedRole)).resolves.toBe(true);
      expect(parseOwnedTextHeader(await fs.readFile(ownedRole, 'utf8'))?.identity).toMatchObject({
        sourceId: 'team', pluginId: 'team/demo', plugin: 'demo',
        artifactKey: 'demo-role', platform: 'codex', scope: 'project',
      });
      if (intentOnly) {
        expect((await cleanupWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)).overallState).toBe('succeeded');
        await expect(fs.pathExists(ownedRole)).resolves.toBe(false);
      }

      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
      await fs.remove(pluginRoot);
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      expect(active.manifest.entries.map((entry) => entry.name)).toEqual(['other']);

      const status = await statusCommandV8({
        plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      });
      expect(status.payload.targets).toEqual([
        expect.objectContaining({
          pluginId: 'team/demo',
          reasons: expect.arrayContaining([expect.objectContaining({
            code: 'codexIntentSourceUnavailable',
          })]),
        }),
      ]);
      const dependencies = createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: runtime.nativeCliRunner,
        interactive: false,
      }));
      const review = await dependencies.prepareScopedTask({ kind: 'retire', scope: 'project',
        selector: 'team/demo', targets: ['codex'], deleteConfig: force },
      new AbortController().signal);
      expect(review.kind).toBe('retire');
      const execution = await dependencies.executeScopedTask(review);
      expect(execution).toMatchObject({ kind: 'recovery', receipt: {
        command: 'intent:retire', ok: true, declarationChanged: true, configChanged: force,
      } });

      await expect(readFixtureRequirements(projectIntentLocation)).resolves.toMatchObject({
        schemaVersion: 3,
        kind: 'aw-plugin-intents',
        roots: [],
        dependencyScopeOverrides: [],
      });
      await expect(readFixtureRequirements(userIntentLocation)).resolves.toMatchObject({
        roots: [{ pluginId: 'team/other', platforms: ['codex'] }],
      });
      const refreshed = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      expect(refreshed.intent.state).toBe('valid');
      expect(refreshed.inventory?.some((target) => target.pluginId === 'team/demo')).toBe(false);
      await expect(readPluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject(force ? { state: 'missing', exists: false, values: {} } : { values: { retained: true } });
      expect(await fs.pathExists(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))).toBe(!force);
      expect(await fs.pathExists(ownedRole), JSON.stringify(execution.receipt)).toBe(false);
      await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
      await expect(readPluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'other', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ values: { retained: 'other' } });
      await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
      await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
        snapshot: { mcpServers: { foreign: { value: { command: 'foreign' } } } },
      });
    },
    30_000,
  );

  it('rejects a stale scoped retire Review when owned output appears before the write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-source');
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0',
      env: isolation.env, impactConfirmed: true });
    const review = await prepareRetire({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env, selector: 'team/demo', targets: ['codex'], yes: true },
    { nativeCliRunner });
    const rulesRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'rules');
    const driftPath = path.join(rulesRoot, 'aw-demo-drift-owner.rules');
    await writeOwnedTextFile({
          path: driftPath,
          allowedRoot: rulesRoot,
          identity: {
            owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
            pluginId: 'team/demo', plugin: 'demo', artifactKey: 'drift-owner',
            platform: 'codex', scope: 'project',
          },
          content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });
    const execution = await executeRetire(review, { yes: true });
    expect(execution.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(execution.declarationChanged).toBe(false);
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toContain('aw-owner-v3:');
  }, 30_000);

  it('previews an exact offline cleanup plan and rejects direct execution after plan drift', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    const projectIntent = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(projectIntent, {
      ...await readFixtureRequirements(projectIntent),
      roots: [],
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(configPath, 'utf8');
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    const evidence = preview.offlineCleanupPlans?.[0];

    expect(evidence).toMatchObject({
      reason: 'sourceMissing',
      pluginId: 'team/demo',
      plan: {
        schemaVersion: 1,
        pluginId: 'team/demo',
        sourceIdentity: 'unavailable',
        platform: 'codex',
        scope: 'project',
        actions: expect.arrayContaining([
          expect.objectContaining({ action: 'removeOwnedOutput', kind: 'namespacedOwner' }),
        ]),
      },
      planDigest: expect.stringMatching(/^sha256:/u),
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
    const rulesRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'rules');
    const driftPath = path.join(rulesRoot, 'aw-demo-direct-drift.rules');
    await writeOwnedTextFile({
      path: driftPath,
      allowedRoot: rulesRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'direct-drift',
        platform: 'codex', scope: 'project',
      },
      content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });

    await expect(cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, expectedOfflineCleanupEvidence: evidence }))
      .resolves.toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({ errorCode: 'operationReviewStale' })],
      });
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
  }, 30_000);

  it.each(['user', 'project'] as const)(
    'retires only the selected Codex activation for %s scope and retains shared native state',
    async (scope) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `offline-native-${scope}-source`);
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const installed = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const intentLocation = { scope, cwd: isolation.layout.fixtureCwd, env: isolation.env };
      if (scope === 'user') {
        const projectIntentLocation = {
          scope: 'project' as const,
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
        };
        await writeIntentFixture(projectIntentLocation, {
          ...await readFixtureRequirements(projectIntentLocation),
          roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
          managed: { codexPluginIds: ['demo@aw'] },
        });
        await applyCodexConfigTransactionFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
          { upsertPluginActivations: { 'demo@aw': true } },
        );
      }
      const activationConfigPath = scope === 'user'
        ? path.join(isolation.env.CODEX_HOME!, 'config.toml')
        : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(activationConfigPath, {
        upsertPluginActivations: { 'foreign@outside': true, 'demo@outside': true },
      });
      const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      const payloadSkill = path.join(
        marketplaceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md',
      );
      const cacheSkill = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
        'skills', 'demo-skill', 'SKILL.md',
      );
      const [payloadBefore, cacheBefore] = await Promise.all([
        fs.readFile(payloadSkill),
        fs.readFile(cacheSkill),
      ]);
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
      await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const retired = await runRetire({
        scope, cwd: isolation.layout.fixtureCwd, env: isolation.env,
        selector: 'team/demo', targets: ['codex'], yes: true,
      }, runtime);

      expect(retired.command).toBe('intent:retire');
      expect(retired.declarationChanged).toBe(true);
      expect(retired.configChanged).toBe(false);
      const activationConfig = await readCodexConfigFile(activationConfigPath);
      expect(activationConfig.snapshot.plugins['demo@aw']?.enabled).toBe(false);
      expect(activationConfig.snapshot.plugins['foreign@outside']?.enabled).toBe(true);
      expect(activationConfig.snapshot.plugins['demo@outside']?.enabled).toBe(true);
      expect(await fs.pathExists(payloadSkill), JSON.stringify(retired)).toBe(true);
      await expect(fs.readFile(payloadSkill)).resolves.toEqual(payloadBefore);
      await expect(fs.readFile(cacheSkill)).resolves.toEqual(cacheBefore);
      await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
      expect(runtime.installed.has('demo@aw')).toBe(true);
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: [] });
      if (scope === 'user') {
        await expect(readCodexConfigFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
        )).resolves.toMatchObject({
          snapshot: { plugins: { 'demo@aw': { enabled: true } } },
        });
      }
    },
    30_000,
  );

  it.each([false, true])(
    'cleans an exact offline Codex extension without changing Intent when native identity is ambiguous (force=%s)',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-source`,
      );
      const remainingRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-remaining`,
      );
      await createNativeDependencyCatalog(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
          };
        },
      }]);
      await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const installed = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const extensionPath = path.join(
        isolation.env.CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml',
      );
      await expect(fs.pathExists(extensionPath)).resolves.toBe(true);
      const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
      const ambiguousConfig = [
        '[plugins."demo@outside"]',
        'enabled = true',
        '',
        '[plugins."foreign@outside"]',
        'enabled = true',
        '',
      ].join('\n');
      await fs.outputFile(configPath, ambiguousConfig);
      const cacheRoot = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo',
      );
      const cacheBefore = await snapshotRegularTree(cacheRoot);
      const intentLocation = {
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      await fs.remove(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team'));
      const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
        },
        expectedDigest: configured.digest,
        env: isolation.env,
      });
      runtime.nativeCliRunner.mockClear();

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force,
      }, runtime);
      const receipt = (await import('../../src/output/command-receipt.js'))
        .buildRebuildReceiptJson('cleanup', result);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('nativeMarketplaceIdentityUnresolved'),
      ]));
      expect(receipt.targetResults).toEqual([
        expect.objectContaining({
          state: 'completed',
          residual: expect.arrayContaining(['nativeMarketplaceIdentityUnresolved']),
        }),
      ]);
      await expect(fs.pathExists(extensionPath)).resolves.toBe(false);
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(ambiguousConfig);
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
        roots: [expect.objectContaining({ pluginId: 'team/demo' })],
      });
      await expect(snapshotRegularTree(cacheRoot)).resolves.toEqual(cacheBefore);
      expect(runtime.installed.has('demo@aw')).toBe(true);
      expect(runtime.nativeCliRunner).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('returns idempotent success for a source-deleted target with no live match', async () => {
      const isolation = await configureCatalog();

      const result = await cleanupWriteCommand(['removed/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { env: isolation.env });

      expect(result).toMatchObject({
        overallState: 'succeeded',
        targetResults: [],
        rebuildResults: [],
      });
  });

  it('returns idempotent force success with no Intent, live match, or local Active bundle', async () => {
    const isolation = await configureCatalog();
    const result = await cleanupWriteCommand(['removed/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      force: true,
    }, { env: isolation.env });

    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [],
      rebuildResults: [],
    });
  });

  it('cleans stale Codex config while preserving cache payload after official absence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-remaining');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceSkill = path.join(
      isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo',
      'skills', 'demo-skill', 'SKILL.md',
    );
    const cacheSkill = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
      'skills', 'demo-skill', 'SKILL.md',
    );
    const [marketplaceBefore, cacheBefore] = await Promise.all([
      fs.readFile(marketplaceSkill),
      fs.readFile(cacheSkill),
    ]);
    runtime.installed.delete('demo@aw');
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(readCodexConfigFile(path.join(
      isolation.env.CODEX_HOME!, 'config.toml',
    ))).resolves.toMatchObject({ snapshot: { plugins: {} } });
    await expect(fs.readFile(marketplaceSkill)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(cacheSkill)).resolves.toEqual(cacheBefore);
  }, 30_000);

  it('shows marker-only Project residue without authorizing ambiguous retirement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-identity-remaining');
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const identities = [
      { identity: `sha256:${'1'.repeat(64)}`, root: path.join(skillsRoot, 'identity-one') },
      { identity: `sha256:${'2'.repeat(64)}`, root: path.join(skillsRoot, 'identity-two') },
    ];
    for (const entry of identities) {
      await fs.ensureDir(entry.root);
      await writeSkillOwnerMarker({
        skillRoot: entry.root,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows', sourceId: 'removed', sourceIdentity: entry.identity,
          pluginId: 'removed/demo', plugin: 'demo', artifactKey: path.basename(entry.root),
          platform: 'codex', scope: 'project',
        },
      });
    }
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    })));
    try {
      await controller.load();
      expect(controller.listUserIssues()).toContainEqual(expect.objectContaining({
        category: 'sourceMissing', pluginId: 'removed/demo', scope: 'project',
      }));
      const plan = await prepareRetire({
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        selector: 'removed/demo', targets: ['codex'],
      }, { env: isolation.env, nativeCliRunner: async () => ({
        exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
      }) });
      try {
        expect(plan.receipt.blockers).toContainEqual(expect.objectContaining({
          code: 'removedPluginActiveUnavailable',
        }));
      } finally {
        await plan.context.dispose();
      }
      for (const entry of identities) {
        await expect(fs.pathExists(entry.root)).resolves.toBe(true);
      }
    } finally {
      controller.dispose();
    }
  });

  it('cleans a valid live owner when the configured path source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '',
    }));
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
    };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const configBefore = await fs.readFile(configPath);
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);
    await fs.move(sourceRoot, `${sourceRoot}-unavailable`);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await fs.remove(active.snapshotPath);

    nativeCliRunner.mockClear();
    const codexManagerPreviewer = vi.fn(async () => ({
      state: 'blocked' as const, code: 'codexCliNotFound' as const,
      diagnostic: 'Install or repair the local Codex CLI.',
    }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      ...runtime,
      previewOperationPlan: true,
      codexManagerPreviewer,
      codexManagerResolver,
      removeObsoleteInstallationContracts,
    });

    expect(preview.overallState).toBe('succeeded');
    await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      ...runtime,
      removeObsoleteInstallationContracts: async () => {
        throw new Error(`private cleanup failure at ${isolation.env.AW_HOME}`);
      },
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.warnings).toEqual([
      'obsoleteContractsCleanupFailed: Obsolete installation contracts could not be removed.',
    ]);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    expect(JSON.stringify(result)).not.toContain('private cleanup failure');
    expect(JSON.stringify(result.warnings)).not.toContain(isolation.env.AW_HOME);
  });

  it('preserves project requirements when unrelated shared Codex user config inventory is damaged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'damaged-user-inventory-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'cleanup-test', title: 'Cleanup test', content: 'owned content' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installFixturePlugin(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const projectConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await expect(fs.readFile(projectConfig, 'utf8')).resolves.toContain('aw-owner-v3:');
    const damagedUserConfig = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    await fs.outputFile(damagedUserConfig, 'invalid = [\n');
    await fs.remove(projectConfig);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/demo' })]) });
    await expect(fs.readFile(damagedUserConfig, 'utf8')).resolves.toBe('invalid = [\n');
    await expect(fs.pathExists(projectConfig)).resolves.toBe(false);
  });

  it.each([false, true])(
    'cleans the old live identity after a real source A to B update with force=%s',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceA = path.join(isolation.layout.fixtureCwd, `identity-a-${force}`);
      const sourceB = path.join(isolation.layout.fixtureCwd, `identity-b-${force}`);
      await Promise.all([
        createDependencyCatalogSnapshotFixture(sourceA, [{ name: 'demo' }]),
        createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'demo' }]),
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const installedConfig = await fs.readFile(configPath, 'utf8');
      expect(installedConfig).toContain('demo.');
      await expect(updateCatalogSourceCommand({
        sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ ok: true, changed: true });

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force,
      }, runtime);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      if (force) await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');
      else await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('demo.');
      await expect(readFixtureRequirements({
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/demo' })]) });
    },
  );

  it('cleans a source-changed dependency without consulting an old live consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceA = path.join(isolation.layout.fixtureCwd, 'dependent-identity-a');
    const sourceB = path.join(isolation.layout.fixtureCwd, 'dependent-identity-b');
    await Promise.all([
      createDependencyCatalogSnapshotFixture(sourceA, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]),
      createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'leaf' }]),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await updateCatalogSourceCommand({
      sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.copy(
      path.join(sourceA, 'plugins'),
      path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins'),
    );
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'root', '.agents-plugin', 'plugin.json',
    ))).resolves.toBe(true);

    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result).toMatchObject({ overallState: 'failed' });
    expect(JSON.stringify(result)).toMatch(/cleanup --force|reinstall|sync/u);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.not.toContain('leaf.');
  });

  it('cleans only the selected marker-owned Codex project Skill', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const identities = [
      { sourceId: 'first', artifactKey: 'first-demo', fill: '1' },
      { sourceId: 'second', artifactKey: 'second-demo', fill: '2' },
    ];
    for (const entry of identities) {
      const skillRoot = path.join(skillsRoot, entry.artifactKey);
      await fs.ensureDir(skillRoot);
      await writeSkillOwnerMarker({
        skillRoot,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId: entry.sourceId,
          sourceIdentity: `sha256:${entry.fill.repeat(64)}`,
          pluginId: `${entry.sourceId}/demo`,
          plugin: 'demo',
          artifactKey: entry.artifactKey,
          platform: 'codex',
          scope: 'project',
        },
      });
    }
    const result = await cleanupWriteCommand(['first/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env });
    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        state: 'completed',
        target: expect.objectContaining({ pluginId: 'first/demo' }),
      })],
    });
    await expect(fs.pathExists(path.join(skillsRoot, 'first-demo'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(skillsRoot, 'second-demo'))).resolves.toBe(true);
  });

  it('removes a shared Codex Skill when current platform config disables its dynamic target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-disabled-skill-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: {},
        platforms: { codex: { fields: { enabled: { type: 'boolean', default: true } } } } };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
        target: 'codex.skill',
        states: ['present', 'disabled'], refreshKeys: ['enabled'], skillKey: 'config-skill',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const enabled = context.config.values.enabled;',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "dynamic-skill", kind: "skill", platform: "codex", target: "codex.skill",',
      '  state: enabled ? "present" : "disabled", skillKey: "config-skill", refreshKeys: ["enabled"],',
      '  ...(enabled ? { content: { files: {',
      '    "SKILL.md": "---\\nname: config-skill\\ndescription: Config Skill.\\n---\\n",',
      '    "README.md": "Config Skill.\\n",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } } } : { disabledReason: "disabled by config" })',
      '}] }));',
    ].join('\n'));
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo',
      'codex', 'skills', 'config-skill');
    const projectSkillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'config-skill');
    await expect(fs.pathExists(path.join(skillRoot, 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(projectSkillRoot)).resolves.toBe(false);
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName: 'demo',
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { enabled: false },
    });

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(projectSkillRoot)).resolves.toBe(false);
    expect(runtime.installed.has('demo@aw')).toBe(true);
    await expect(readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toMatchObject({ snapshot: { plugins: { 'demo@aw': { enabled: true } } } });
  }, 30_000);

  it.each(['sync', 'uninstall'] as const)('removes a project Codex role removed by the active manifest through %s', async (command) => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'project-skill-v1-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'project-skill-v2-source');
    const configureV1 = (manifest: PluginMeta['manifest']) => {
      manifest.version = '1.0.0';
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'removed-in-v2',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(firstRoot, 'plugins', 'demo'), roleKey: 'removed-in-v2',
    });
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    await createDependencyCatalogSnapshotFixture(secondRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.version = '2.0.0';
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'current', title: 'Current', content: 'Current instruction.' }],
        };
      },
    }]);
    const firstSource = { id: 'team', type: 'path' as const, primary: true, path: firstRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [firstSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const initialInstall = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(initialInstall.overallState, JSON.stringify(initialInstall.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-removed-in-v2.toml');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    const changed = await updateCatalogSourceCommand({
      sourceId: 'team',
      update: { path: secondRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(changed).toMatchObject({ ok: true, changed: true });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const foreignSkillRoot = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'foreign-skill',
    );
    await fs.outputFile(path.join(foreignSkillRoot, 'SKILL.md'), 'foreign\n');
    await writeSkillOwnerMarker({
      skillRoot: foreignSkillRoot,
      allowedRoot: path.dirname(foreignSkillRoot),
      identity: {
        owner: 'agent-workflows',
        sourceId: 'other',
        pluginId: 'other/demo',
        plugin: 'demo',
        artifactKey: 'foreign-skill',
        platform: 'codex',
        scope: 'project',
      },
    });
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);

    const result = await (command === 'sync' ? syncWriteCommand : uninstallWriteCommand)(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.rebuildResults.some((entry) => entry.removed.some((removed) =>
      removed.includes('removed-in-v2')))).toBe(true);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.readFile(path.join(foreignSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toBe('foreign\n');
  }, 30_000);

  it('only removes direct project Codex Skills with an exact current owner identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-stale-safety-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const writeMarker = async (name: string, identity: Parameters<typeof writeSkillOwnerMarker>[0]['identity']) => {
      const skillRoot = path.join(skillsRoot, name);
      await fs.ensureDir(skillRoot);
      await writeSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, identity });
      return skillRoot;
    };
    const identity = (artifactKey: string) => ({
      owner: 'agent-workflows' as const,
      sourceId: 'team', pluginId: 'team/demo', plugin: 'demo', artifactKey,
      platform: 'codex' as const, scope: 'project' as const,
    });
    const removable = await writeMarker('stale-owned', identity('stale-owned'));
    const retained = [
      await writeMarker('foreign-source', {
        ...identity('foreign-source'), sourceId: 'foreign', pluginId: 'foreign/demo',
      }),
      await writeMarker('user-scope', { ...identity('user-scope'), scope: 'user' }),
      await writeMarker('claude-skill', { ...identity('claude-skill'), platform: 'claude' }),
    ];
    const malformed = path.join(skillsRoot, 'malformed');
    await fs.outputFile(path.join(malformed, SKILL_OWNER_MARKER), '{invalid\n');
    retained.push(malformed);
    const markerTarget = path.join(isolation.layout.rootDir, 'external-owner-marker.json');
    await fs.outputJson(markerTarget, identity('marker-symlink'));
    const markerSymlink = path.join(skillsRoot, 'marker-symlink');
    await fs.ensureDir(markerSymlink);
    await fs.symlink(markerTarget, path.join(markerSymlink, SKILL_OWNER_MARKER));
    retained.push(markerSymlink);
    const externalSkill = path.join(isolation.layout.rootDir, 'external-skill-directory');
    await fs.outputFile(path.join(externalSkill, 'SKILL.md'), 'foreign\n');
    const skillSymlink = path.join(skillsRoot, 'skill-symlink');
    await fs.symlink(externalSkill, skillSymlink, process.platform === 'win32' ? 'junction' : 'dir');
    retained.push(skillSymlink);
    const nested = path.join(skillsRoot, 'container', 'nested-owned');
    await fs.ensureDir(nested);
    await writeSkillOwnerMarker({
      skillRoot: nested,
      allowedRoot: path.join(skillsRoot, 'container'),
      identity: identity('nested-owned'),
    });
    retained.push(nested);

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(removable)).resolves.toBe(false);
    for (const skillRoot of retained) {
      await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    }
    await expect(fs.pathExists(markerTarget)).resolves.toBe(true);
    await expect(fs.pathExists(externalSkill)).resolves.toBe(true);
  }, 30_000);

  it('cleans an exact target in an internal multi-selector force request without guessing another path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-multi-selector-source');
    const removable = {
      name: 'removable',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true,
          states: ['present'], refreshKeys: [], roleKey: 'removable-role',
        }] };
      },
    };
    const sharedOnly = {
      name: 'shared-only',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'shared-only', title: 'Shared only', content: 'Shared only.' }],
        };
      },
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'removable'),
      roleKey: 'removable-role',
      fail: true,
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-removable-removable-role.toml');
    await fs.outputFile(rolePath, 'description = "Markerless but exact"\n');
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const registration = { description: 'Removable role', configFile: 'agents/aw-removable-removable-role.toml' };
    await applyCodexConfigTransactionFile(configPath, { upsertAgentRegistrations: { 'removable-role': registration } });
    const execution = await createNativeTestExecution({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      selectedTargets: [
        { pluginId: 'local/removable', platform: 'codex' },
        { pluginId: 'local/shared-only', platform: 'codex' },
      ],
    });
    let result: Awaited<ReturnType<typeof runRebuildCommand>>;
    try {
      result = await withAwHomeMutationLock({
        env: isolation.env,
        action: (token) => runRebuildCommand({
          command: 'cleanup',
          pluginNames: ['local/removable', 'local/shared-only'],
          commandOptions: {
            cwd: isolation.layout.fixtureCwd,
            platform: 'codex',
            scope: 'project',
            json: false,
            force: true,
          },
          runtime: { env: isolation.env, awHomeMutationToken: token,
            executionInput: execution.executionInput },
        }),
      });
    } finally {
      await execution.dispose();
    }
    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'local/removable' }),
        state: 'completed',
      })],
    });
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(configPath)).snapshot.agents['removable-role']).toBeUndefined();

    await applyCodexConfigTransactionFile(configPath, { upsertAgentRegistrations: { 'removable-role': registration } });
    const missingFile = await cleanupWriteCommand(['local/removable'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(missingFile.overallState, JSON.stringify(missingFile)).toBe('succeeded');
    expect((await readCodexConfigFile(configPath)).snapshot.agents['removable-role'])
      .toMatchObject(registration);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
  });

  it('force cleanup removes only the exact Active-planned damaged Codex project role', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-shallow-source');
    const configureForceManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        preApply: { path: './scripts/pre-apply.mjs' },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'damaged-demo',
      }] };
    };
    const forcePlugin = {
      name: 'demo',
      configureManifest: configureForceManifest,
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
      roleKey: 'damaged-demo',
      fail: true,
    });
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'pre-apply.mjs'),
      "throw new Error('force cleanup must not run preApply');\n",
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-damaged-demo.toml');
    const otherSkillsRoot = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills');
    const otherSkillRoot = path.join(otherSkillsRoot, 'damaged-demo');
    const invalidSkillRoot = path.join(skillsRoot, 'invalid-json');
    const linkedSkillRoot = path.join(skillsRoot, 'linked-marker');
    const externalMarker = path.join(isolation.layout.rootDir, 'foreign-owner-marker.json');
    const damagedOwner = {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'local',
      sourceIdentity: 'damaged',
      pluginId: 'local/demo',
      plugin: 'demo',
      artifactKey: 'damaged-demo',
      platform: 'codex',
      scope: 'project',
    };
    const damagedRole = `# agent-workflows-owner: ${JSON.stringify(damagedOwner)}\ndescription = "Damaged role"\n`;
    await fs.outputFile(rolePath, damagedRole);
    await fs.ensureDir(otherSkillRoot);
    await writeSkillOwnerMarker({
      skillRoot: otherSkillRoot,
      allowedRoot: otherSkillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'local',
        sourceIdentity: 'damaged',
        pluginId: 'local/demo',
        plugin: 'demo',
        artifactKey: 'damaged-demo',
        platform: 'claude',
        scope: 'user',
      },
    });
    await fs.outputFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), '{invalid\n');
    await fs.outputJson(externalMarker, {
      ...damagedOwner,
      artifactKey: 'linked-marker',
    });
    await fs.ensureDir(linkedSkillRoot);
    await fs.symlink(externalMarker, path.join(linkedSkillRoot, '.agent-workflows-owner.json'));
    const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const foreignRolePath = path.join(isolation.layout.rootDir, 'foreign-role.toml');
    await fs.outputFile(foreignRolePath, 'description = "Foreign role"\n');
    await applyCodexConfigTransactionFile(sharedConfig, {
      upsertPluginActivations: { 'demo@aw': true },
      upsertAgentRegistrations: { 'damaged-demo': {
        description: 'Foreign role', configFile: path.relative(path.dirname(sharedConfig), foreignRolePath),
      } },
    });

    const runtime = await createCodexNativeTestRuntime(isolation);
    const blockedReinstall = await reinstallWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blockedReinstall.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin cleanup local/demo --target codex --scope project --force',
          'then run aw plugin sync local/demo --target codex --context project --rebuild',
        ],
      }),
    ]);
    const blockedReceipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('reinstall', blockedReinstall);
    expect(blockedReceipt.recoveryActions).toEqual([
      'run aw plugin cleanup local/demo --target codex --scope project --force',
      'then run aw plugin sync local/demo --target codex --context project --rebuild',
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    const activeState = await fs.readJson(path.join(isolation.env.AW_HOME!, 'catalog-state.json')) as {
      sources: { local: { active: { logicalIdentity: string; snapshotDigest: string } } };
    };
    const activeStore = resolveCatalogStoreLocation({
      ...activeState.sources.local.active,
      env: isolation.env,
    });
    await fs.outputFile(
      path.join(activeStore.snapshotRoot, 'plugins', 'unrelated', '.agents-plugin', 'plugin.json'),
      '{damaged unrelated bundle\n',
    );
    const intentLocation = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const codexManagerPreviewer = vi.fn(async () => ({
      state: 'blocked' as const, code: 'codexCliNotFound' as const,
      diagnostic: 'Install or repair the local Codex CLI.',
    }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    let providerCalls = 0;
    const forceRuntime = {
      env: isolation.env,
      catalogGenerationRuntime: {
        providers: {
          path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
            providerCalls += 1;
            return catalogPathProviderInternal.resolve(...args);
          },
          git: async () => {
            providerCalls += 1;
            throw new Error('force cleanup must not invoke the Catalog provider');
          },
        },
      },
    };
    const preview = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, {
      ...forceRuntime,
      previewOperationPlan: true,
      removeObsoleteInstallationContracts,
      codexManagerPreviewer,
      codexManagerResolver,
    });

    expect(preview.overallState).toBe('succeeded');
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(providerCalls).toBe(0);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'render-count-demo.txt')))
      .resolves.toBe(false);
    expect(preview.operationPlan?.actions).toEqual([
      expect.objectContaining({
        kind: 'removeOwnedArtifact',
        path: rolePath,
      }),
    ]);
    await expect(fs.readFile(rolePath, 'utf8')).resolves.toBe(damagedRole);
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
      snapshot: { plugins: { 'demo@aw': { enabled: true } } },
    });

    const reviewedEvidence = preview.offlineCleanupPlans?.[0];
    expect(reviewedEvidence).toBeDefined();
    const foreignOwner = {
      schemaVersion: 3,
      owner: 'agent-workflows',
      sourceId: 'foreign',
      pluginId: 'foreign/demo',
      plugin: 'demo',
      artifactKey: 'damaged-demo',
      platform: 'codex',
      scope: 'project',
    };
    await fs.outputFile(rolePath, `# agent-workflows-owner: ${JSON.stringify(foreignOwner)}\ndescription = "Foreign role"\n`);
    const stale = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { ...forceRuntime, expectedOfflineCleanupEvidence: reviewedEvidence });
    expect(stale.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationReviewStale' }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    await fs.outputFile(rolePath, damagedRole);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, forceRuntime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({ snapshot: {
      plugins: { 'demo@aw': { enabled: true } },
      agents: { 'damaged-demo': { configFile: path.relative(path.dirname(sharedConfig), foreignRolePath) } },
    } });
    await expect(fs.readFile(foreignRolePath, 'utf8')).resolves.toBe('description = "Foreign role"\n');
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    expect(providerCalls).toBe(0);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'render-count-demo.txt')))
      .resolves.toBe(false);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/demo' })]) });
  });

  it('recovers a damaged owned-text header through reinstall, force cleanup, and reinstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-recovery-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'project-role',
      }] };
    };
    const definition = [{ name: 'demo', configureManifest: configure }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
      roleKey: 'project-role',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-project-role.toml');
    const agentPath = path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-reviewer.toml',
    );
    const originalAgent = await fs.readFile(agentPath, 'utf8');
    await fs.outputFile(
      agentPath,
      `# agent-workflows-owner: {invalid\n${originalAgent.split('\n').slice(1).join('\n')}`,
    );

    const blocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin cleanup team/demo --target codex --scope project --force',
          'then run aw plugin sync team/demo --target codex --context project --rebuild',
        ],
      }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    const intentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const validIntent = await fs.readFile(intentPath);
    const malformedIntent = Buffer.from('{malformed selected project Intent\n');
    await fs.outputFile(intentPath, malformedIntent);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('partial');
    expect(cleaned.rebuildResults).toEqual([expect.objectContaining({
      status: 'failed',
      removed: expect.arrayContaining(['aw-demo-project-role.toml', 'aw-demo-reviewer.toml']),
      residual: expect.arrayContaining(['plugin-intents.json']),
    })]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    await expect(fs.readFile(intentPath)).resolves.toEqual(malformedIntent);

    await fs.outputFile(intentPath, validIntent);
    const recovered = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(recovered.overallState, JSON.stringify(recovered)).toBe('succeeded');
    expect(recovered.rebuildResults).toEqual([
      expect.objectContaining({ status: 'succeeded', residual: [], failures: [] }),
    ]);
    expect(recovered.targetResults).toEqual([
      expect.objectContaining({
        state: 'completed',
        target: expect.objectContaining({ pluginId: 'team/demo' }),
      }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    const restored = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    expect(parseOwnedTextHeader(await fs.readFile(agentPath, 'utf8'))?.identity).toMatchObject({
      pluginId: 'team/demo', platform: 'codex', scope: 'project',
    });

    const unrelatedUserAgent = path.join(
      isolation.env.CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml',
    );
    await fs.outputFile(unrelatedUserAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const unrelatedBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.pathExists(unrelatedUserAgent)).resolves.toBe(true);
  }, 30_000);

  it('matches a damaged reinstall owned-text target by its full normalized path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-exact-path-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.extensions = {
        instructions: [{ name: 'reviewer', title: 'Reviewer', content: 'Review changes.' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => (
      { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' }
    ));
    const runtime = { env: isolation.env, nativeCliRunner };
    const rulePath = path.join(
      isolation.layout.fixtureCwd, '.claude', 'rules', 'aw-demo-reviewer.md',
    );
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    await writeOwnedTextFile({
      path: rulePath,
      allowedRoot: path.join(isolation.layout.fixtureCwd, '.claude'),
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'aw-demo-reviewer',
        platform: 'claude', scope: 'project',
      },
      content: '# Reviewer\n\nReview changes.\n',
    });
    const intentLocation = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      ...await readFixtureRequirements(intentLocation),
      roots: [{ pluginId: 'team/demo', platforms: ['claude'] }],
    });
    const settingsPath = path.join(isolation.layout.fixtureCwd, '.claude', 'settings.json');
    await fs.outputJson(settingsPath, { sentinel: true });
    const originalRule = await fs.readFile(rulePath);
    await fs.outputFile(rulePath, '# agent-workflows-owner: {invalid\nowned target\n');

    const exactBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'project',
    }, runtime);
    expect(exactBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);

    await fs.outputFile(rulePath, originalRule);
    const sameBasenameAgent = path.join(
      isolation.layout.fixtureCwd, '.claude', 'agents', path.basename(rulePath),
    );
    await fs.outputFile(sameBasenameAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const intentPath = path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json',
    );
    const before = {
      rule: await fs.readFile(rulePath),
      agent: await fs.readFile(sameBasenameAgent),
      intent: await fs.readFile(intentPath),
      settings: await fs.readFile(settingsPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };

    const wrongPathBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'project',
    }, runtime);

    expect(wrongPathBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(wrongPathBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(rulePath)).resolves.toEqual(before.rule);
    await expect(fs.readFile(sameBasenameAgent)).resolves.toEqual(before.agent);
    await expect(fs.readFile(intentPath)).resolves.toEqual(before.intent);
    await expect(fs.readFile(settingsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })).resolves.toEqual(before.settings);
    expect(nativeCliRunner.mock.calls).toHaveLength(before.nativeCalls);
  }, 30_000);

  it('invalid shared config does not authorize marker-only Codex project recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'owned-demo');
    await fs.ensureDir(skillRoot);
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: 'damaged',
      pluginId: 'team/demo', plugin: 'demo', artifactKey: 'owned-demo',
      platform: 'codex', scope: 'project',
    });
    const sharedPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const foreignShared = 'invalid = [\n# agent-workflows demo without owner token\n';
    await fs.outputFile(sharedPath, foreignShared);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });

    expect(result.overallState).toBe('failed');
    await expect(fs.readFile(sharedPath, 'utf8')).resolves.toBe(foreignShared);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('matches a damaged project role header through a symlink cwd by its exact canonical path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-exact-owner-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'shared-name',
      }] };
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'),
      roleKey: 'shared-name',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const { nativeCliRunner } = runtime;
    const exactInstalled = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(exactInstalled.overallState, JSON.stringify(exactInstalled)).toBe('succeeded');
    const linkedCwd = path.join(isolation.layout.rootDir, 'linked-project-cwd');
    await fs.symlink(
      isolation.layout.fixtureCwd,
      linkedCwd,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-leaf-shared-name.toml');
    const originalRole = await fs.readFile(rolePath, 'utf8');
    await fs.outputFile(rolePath, `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`);
    const distractors = [
      {
        root: path.join(isolation.env.CODEX_HOME!, 'skills', 'shared-name'),
        sourceId: 'other', platform: 'codex' as const, scope: 'user' as const,
      },
      {
        root: path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills', 'shared-name'),
        sourceId: 'team', platform: 'claude' as const, scope: 'user' as const,
      },
    ];
    for (const distractor of distractors) {
      await fs.ensureDir(distractor.root);
      await writeSkillOwnerMarker({
        skillRoot: distractor.root,
        allowedRoot: path.dirname(distractor.root),
        identity: {
          owner: 'agent-workflows',
          sourceId: distractor.sourceId,
          pluginId: `${distractor.sourceId}/leaf`,
          plugin: 'leaf',
          artifactKey: 'shared-name',
          platform: distractor.platform,
          scope: distractor.scope,
        },
      });
    }

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/leaf', platform: 'codex', scope: 'project',
        }),
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin cleanup team/leaf --target codex --scope project --force',
          'then run aw plugin sync team/leaf --target codex --context project --rebuild',
        ],
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        errorCode: 'dependencyInstallFailed',
      }),
    ]));
    expect(result.targetResults.filter((target) => target.recoveryActions)).toHaveLength(1);
    for (const distractor of distractors) {
      await expect(fs.pathExists(distractor.root)).resolves.toBe(true);
    }

    const cleaned = await cleanupWriteCommand(['team/leaf'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.agents['shared-name']).toBeUndefined();
    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const unrelatedMarker = path.join(
      distractors[0]!.root,
      '.agent-workflows-owner.json',
    );
    await fs.outputFile(unrelatedMarker, '{invalid unrelated marker\n');
    const selectedRolePath = rolePath;
    const projectIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const actualBefore = {
      selectedRole: await fs.readFile(selectedRolePath),
      unrelatedMarker: await fs.readFile(unrelatedMarker),
      projectIntent: await fs.readFile(projectIntentPath),
      projectConfig: await fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };

    const unrelatedBlocked = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(selectedRolePath)).resolves.toEqual(actualBefore.selectedRole);
    await expect(fs.readFile(unrelatedMarker)).resolves.toEqual(actualBefore.unrelatedMarker);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(actualBefore.projectIntent);
    await expect(fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })).resolves.toEqual(actualBefore.projectConfig);
    expect(nativeCliRunner.mock.calls).toHaveLength(actualBefore.nativeCalls);
  });

  it('blocks a project override on damaged user dependency ownership and permits exact user recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-user-owner-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['user'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'shared-name',
      }] };
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), roleKey: 'shared-name',
    });
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
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-leaf-shared-name.toml');
    const originalRole = await fs.readFile(rolePath, 'utf8');
    await fs.outputFile(rolePath, `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`);
    const damagedRole = await fs.readFile(rolePath);
    const projectIntentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const projectIntent = await fs.readFile(projectIntentPath);
    const foreignSkill = path.join(isolation.env.CODEX_HOME!, 'skills', 'foreign-skill', 'SKILL.md');
    await fs.outputFile(foreignSkill, 'foreign\n');

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/root', platform: 'codex', scope: 'project',
        }),
        errorCode: 'stateInventoryFailed',
        message: expect.stringContaining(
          `ownerHeaderParse@${path.join('[catalog-source]', 'agents', 'aw-leaf-shared-name.toml')}`,
        ),
      }),
    ]);
    await expect(fs.readFile(rolePath)).resolves.toEqual(damagedRole);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const cleaned = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');

    const restored = await reinstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    expect(parseOwnedTextHeader(await fs.readFile(rolePath, 'utf8'))?.identity)
      .toMatchObject({ pluginId: 'team/leaf', artifactKey: 'shared-name', platform: 'codex', scope: 'user' });
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
  });

  it('does not touch obsolete contract state during markerless force recovery', async () => {
    const isolation = await configureCatalog();
    const baseRuntime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, baseRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const obsolete = path.join(isolation.env.AW_HOME!, 'installation-contracts');
    await fs.outputFile(path.join(obsolete, 'old.json'), '{}');

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, {
      ...baseRuntime,
      removeObsoleteInstallationContracts: async () => {
        throw new Error('injected obsolete cleanup failure');
      },
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.warnings).toEqual([]);
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [{ pluginId: 'local/demo', platforms: ['codex'] }] });
    await expect(fs.pathExists(obsolete)).resolves.toBe(true);
  });
});
