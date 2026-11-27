import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import type { PluginMeta } from '../../src/types.js';
import { readSkillOwnerMarker, writeOwnedTextFile } from '../../src/utils/ownership.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import {
  installWriteCommand,
  syncWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  syncFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
} from '../helpers/write-command-fixture.js';
import { nativeFixtureLayout, nativeRegistrationId } from '../helpers/write-command-dependency-placement-fixture.js';

async function nativeInstructionContext(pluginName: string, sourceId = 'team') {
  const { env, layout } = getCurrentSourceTestIsolation();
  const sourceIdentity = (await readCatalogGenerationState(env)).sources[sourceId]?.active?.sourceIdentity;
  const native = await nativeFixtureLayout(pluginName, sourceId, 'user', 'codex', sourceIdentity);
  const owner = await readSkillOwnerMarker({ skillRoot: native.packageRoot, allowedRoot: path.dirname(native.packageRoot) });
  expect(owner).toMatchObject({ pluginId: `${sourceId}/${pluginName}`, sourceIdentity,
    physicalKey: native.binding.physicalKey, platform: 'codex', scope: 'user' });
  const hooks = await fs.readJson(path.join(native.packageRoot, 'hooks', 'hooks.json'));
  expect(hooks.hooks.SessionStart).toEqual(expect.arrayContaining([expect.objectContaining({ hooks: expect.any(Array) })]));
  const executed = await promisify(execFile)(process.execPath,
    [path.join(native.packageRoot, 'scripts', 'aw-instructions.mjs'), 'SessionStart'], {
      cwd: layout.fixtureCwd, env, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
  return JSON.parse(executed.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
}

describe('five namespaced write commands', () => {
  let defaultNativeRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  beforeEach(async () => {
    installNativeTestDiscovery();
    defaultNativeRuntime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('rebuilds and cleans a project root with current and offline Catalog evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'inventory-reuse-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'inventory-reuse-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
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

    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installed.dependencyPlan?.resolvedPluginIds).toEqual(['team/leaf', 'team/root']);

    const cleaned = await cleanupWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');

    const installedAgain = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installedAgain.overallState, JSON.stringify(installedAgain.rebuildResults)).toBe('succeeded');
    const upgraded = await syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, runtime);
    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');

    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const offline = await cleanupWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(offline.overallState, JSON.stringify(offline.rebuildResults)).toBe('succeeded');
  });

  it('keeps a present user transitive dependency when installing its project consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const startedAt = Date.now();
    const checkpoint = (phase: string) => {
      if (process.platform === 'win32') console.info('AW_DEPENDENCY_PLACEMENT_TIMING', { phase, elapsedMs: Date.now() - startedAt });
    };
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-dependency-keep-source');
    const configurePreApply = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        preApply: { path: './scripts/preApply.mjs' },
      };
    };
    const plugins = [
      { name: 'leaf', configureManifest: configurePreApply },
      { name: 'middle', dependencies: ['leaf'], configureManifest: configurePreApply },
      { name: 'root', dependencies: ['middle'], configureManifest: (manifest: PluginMeta['manifest']) => {
        configurePreApply(manifest);
      } },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'user-provider-pre-apply-counts');
    await fs.ensureDir(counterRoot);
    const preApplyScript = [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const context = JSON.parse(await new Promise((resolve) => { let data = ""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => resolve(data)); }));',
      `const counterRoot = ${JSON.stringify(counterRoot)};`,
      'const counter = `${counterRoot}/pre-apply-count-${context.plugin.name}-${context.target.scope}.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'leaf', 'scripts', 'preApply.mjs'), preApplyScript);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'middle', 'scripts', 'preApply.mjs'), preApplyScript);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'root', 'scripts', 'preApply.mjs'), preApplyScript);
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    const leafInstall = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime);
    checkpoint('user-provider-installed');
    expect(leafInstall.overallState, JSON.stringify(leafInstall.rebuildResults)).toBe('succeeded');
    const leafStatus = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', context: 'user', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    checkpoint('user-provider-observed');
    expect(leafStatus.observedTargets, JSON.stringify(leafStatus)).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', scope: 'user', observation: 'verified', content: 'satisfied', blockers: [],
    }));

    const leafId = await nativeRegistrationId('leaf');
    const userIntentLocation = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const userIntentBefore = await observeIntent(userIntentLocation);
    const userLayout = await nativeFixtureLayout('leaf', 'team', 'user');
    const packageBefore = await snapshotRegularTree(userLayout.packageRoot);
    const nativeCallsBefore = defaultNativeRuntime.nativeCliRunner.mock.calls.length;
    await writePreferences({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],

    });
    const installedReceipt = await runRecovery('install', ['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    checkpoint('project-consumer-installed');
    expect(installedReceipt.ok, JSON.stringify(installedReceipt)).toBe(true);
    expect(installedReceipt.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/middle', scope: 'project', providerScope: 'project', observation: 'verified',
    }));
    const projectConfig = await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'));
    expect(projectConfig.snapshot.plugins[leafId]).toBeUndefined();
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).snapshot.plugins[leafId]?.enabled).toBe(true);
    await expect(observeIntent(userIntentLocation)).resolves.toEqual(userIntentBefore);
    await expect(snapshotRegularTree(userLayout.packageRoot)).resolves.toEqual(packageBefore);
    expect(defaultNativeRuntime.nativeCliRunner.mock.calls.slice(nativeCallsBefore).filter(([invocation]) => {
      const index = invocation.args.indexOf('plugin');
      return index >= 0 && ['add', 'remove', 'enable', 'disable'].includes(invocation.args[index + 1] ?? '')
        && invocation.args[index + 2] === leafId;
    })).toEqual([]);
    const installedStatus = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    checkpoint('project-consumer-observed');
    expect(installedStatus.allSatisfied, JSON.stringify(installedStatus)).toBe(true);
    expect(installedStatus.observedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', scope: 'user', relation: 'root',
        providerScope: 'user', observation: 'verified', blockers: [] }),
      expect.objectContaining({ pluginId: 'team/middle', scope: 'project', observation: 'verified', blockers: [] }),
      expect.objectContaining({ pluginId: 'team/root', scope: 'project', observation: 'verified', blockers: [] }),
    ]));
    expect(installedStatus.observedTargets?.flatMap((target) => target.blockers))
      .not.toContainEqual(expect.objectContaining({ code: 'dependencyMissing' }));
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    checkpoint('tui-loaded');
    const issues = controller.listUserIssues();
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'dependencyMissing',
        rootEntity: expect.objectContaining({ pluginId: 'team/leaf', scope: 'project' }),
      }),
    ]));
    expect(issues.flatMap((issue) => issue.actions)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/),
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }),
    ]));
    const repeated = await runRecovery('install', ['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    checkpoint('repeated-install-completed');
    expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
    await expect(fs.readFile(path.join(counterRoot, 'pre-apply-count-leaf-user.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.readFile(path.join(counterRoot, 'pre-apply-count-middle-project.txt'), 'utf8'))
      .resolves.toBe('2');
    await expect(fs.readFile(path.join(counterRoot, 'pre-apply-count-root-project.txt'), 'utf8'))
      .resolves.toBe('2');

    // A healthy shared User package must remain unchanged when only Project activation is needed.
    await expect(snapshotRegularTree(userLayout.packageRoot)).resolves.toEqual(packageBefore);
    await expect(observeIntent(userIntentLocation)).resolves.toEqual(userIntentBefore);
    await expect(fs.pathExists(path.join(counterRoot, 'pre-apply-count-leaf-project.txt'))).resolves.toBe(false);
    expect(defaultNativeRuntime.nativeCliRunner.mock.calls.slice(nativeCallsBefore).filter(([invocation]) => {
      const index = invocation.args.indexOf('plugin');
      return index >= 0 && ['add', 'remove', 'enable', 'disable'].includes(invocation.args[index + 1] ?? '')
        && invocation.args[index + 2] === leafId;
    })).toEqual([]);
    // This fixture includes five preApply processes, repeated status reads and TUI loading.
    // Windows reached the former 15s test limit; product operation deadlines stay unchanged.
  }, process.platform === 'win32' ? 30_000 : 15_000);

  it('keeps an absent project placement out of extension repair for a healthy user install', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-extension-status-source');
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          agents: [{ name: 'worker', description: 'Worker role.', prompt: 'Work.' }],
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [
        { id: 'team', type: 'path', primary: true, path: sourceRoot },
      ] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    expect(status.observedTargets, JSON.stringify(status)).toEqual([expect.objectContaining({
      pluginId: 'team/demo', scope: 'user', observation: 'verified', content: 'satisfied', blockers: [],
    })]);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-demo-worker.toml')))
      .resolves.toBe(false);
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, nativeCliRunner: runtime.nativeCliRunner, interactive: false,
    })));
    try {
      await controller.load();
      expect(controller.snapshot.scopedInventories.user?.declaredRoots).toEqual([expect.objectContaining({
        pluginId: 'team/demo', state: 'ready', targets: expect.arrayContaining([
          expect.objectContaining({ scope: 'user', state: 'ready' }),
        ]),
      })]);
      expect(controller.snapshot.scopedInventories.project?.declaredRoots).toEqual([]);
      expect(controller.listUserIssues().flatMap((issue) => issue.actions)).not.toContainEqual(expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/), pluginId: 'team/demo', scope: 'project',
      }));
    } finally { controller.dispose(); }
  });

  it('reuses a user native dependency through a project transitive consumer in status and TUI', async () => {
    // Test Value Gate: distinct roots reuse one indirect User provider; Project false needs activation only.
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-cross-scope-status-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'agent-content-toolkit' },
      { name: 'user-content-tools', dependencies: ['agent-content-toolkit'] },
      { name: 'aw-plugin-development', dependencies: ['agent-content-toolkit'] },
      { name: 'aw-catalog-development', dependencies: ['aw-plugin-development'] },
    ]);
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
    await expect(installFixturePlugin(['official/user-content-tools'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userIntentLocation = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const userIntentBefore = await observeIntent(userIntentLocation);
    const providerPackageRoot = path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache',
      (await nativeFixtureLayout("agent-content-toolkit", "official")).marketplaceName!, 'agent-content-toolkit', '1.0.0');
    const providerPackageBefore = await snapshotRegularTree(providerPackageRoot);
    const nativeCallsBefore = runtime.nativeCliRunner.mock.calls.length;
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { [await nativeRegistrationId("agent-content-toolkit", "official")]: false },
    });

    const installedReceipt = await runRecovery('install', ['official/aw-catalog-development'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(installedReceipt.ok, JSON.stringify(installedReceipt)).toBe(true);
    expect((await readCodexConfigFile(projectConfigPath))
      .snapshot.plugins[await nativeRegistrationId("agent-content-toolkit", "official")]?.enabled).toBe(true);
    await expect(observeIntent(userIntentLocation)).resolves.toEqual(userIntentBefore);
    await expect(snapshotRegularTree(providerPackageRoot)).resolves.toEqual(providerPackageBefore);
    const providerId = await nativeRegistrationId('agent-content-toolkit', 'official');
    expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBefore).filter(([invocation]) => {
      const index = invocation.args.indexOf('plugin');
      return index >= 0
        && ['add', 'remove', 'enable', 'disable'].includes(invocation.args[index + 1] ?? '')
        && invocation.args[index + 2] === providerId;
    })).toEqual([]);
    const installed = installedReceipt.targetResults.find((target) => target.pluginId === 'official/aw-catalog-development'
      && target.scope === 'project' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installedReceipt.targetResults, JSON.stringify(installedReceipt)).toContainEqual(expect.objectContaining({
      pluginId: 'official/agent-content-toolkit', scope: 'project', providerScope: 'user',
      content: 'satisfied', blockers: [],
      deploymentReceipts: expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({
        scopeActivation: 'unknown', consumers: expect.arrayContaining([expect.objectContaining({ activation: 'enabled' })]),
      }) })]),
    }));
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'official/user-content-tools', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'official/aw-catalog-development', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    expect(status.allSatisfied, JSON.stringify(status)).toBe(true);
    expect(status.observedTargets).toContainEqual(expect.objectContaining({
      pluginId: 'official/agent-content-toolkit', scope: 'user', relation: 'dependency',
      providerScope: 'user', content: 'satisfied', observation: 'verified', blockers: [],
    }));
    expect(status.observedTargets?.flatMap((target) => target.blockers)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dependencyMissing' }), expect.objectContaining({ code: 'codexActivationDrift' }),
    ]));
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, nativeCliRunner: runtime.nativeCliRunner, interactive: false,
    })));
    try {
      await controller.load();
      expect(controller.listUserIssues().flatMap((issue) => issue.actions)).not.toContainEqual(expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/),
        pluginId: 'official/agent-content-toolkit', scope: 'project',
      }));
    } finally { controller.dispose(); }
  });

  it.each([true, false])('preserves project activation %s when restoring a user dependency of a project root', async (projectEnabled) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'stale-project-activation-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
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
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, yes: true };
    await expect(installFixturePlugin(['official/leaf'], {
      ...options, scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['official/root'], {
      ...options, scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { [await nativeRegistrationId("leaf", "official")]: projectEnabled },
    });

    const result = await (projectEnabled ? reinstallWriteCommand : syncWriteCommand)(['official/leaf'], {
      ...options, scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const project = await readCodexConfigFile(projectConfigPath);
    expect(project.snapshot.plugins[await nativeRegistrationId("leaf", "official")]?.enabled).toBe(projectEnabled);
    expect(project.snapshot.plugins[await nativeRegistrationId("root", "official")]?.enabled).toBe(true);
    const user = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
    expect(user.snapshot.plugins[await nativeRegistrationId("leaf", "official")]?.enabled).toBe(true);
  });

  it('repairs a missing user extension in an installed native dependency during project sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-dependency-extension-repair-source');
    await createNativeDependencyCatalog(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'leaf-role', description: 'Leaf role.', prompt: 'Use leaf.' }],
          };
        },
      },
      { name: 'root', dependencies: ['leaf'] },
    ]);
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
    await expect(installFixturePlugin(['official/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const initialReceipt = await runRecovery('install', ['official/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(initialReceipt.ok, JSON.stringify(initialReceipt)).toBe(true);
    const initialProject = initialReceipt.targetResults.find((target) => target.pluginId === 'official/root'
      && target.scope === 'project' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;
    expect(initialProject.overallState, JSON.stringify({
      targetResults: initialProject.targetResults,
      rebuildResults: initialProject.rebuildResults,
      dependencyPlan: initialProject.dependencyPlan,
    })).toBe('succeeded');
    const agentPath = path.join(isolation.env.CODEX_HOME!, 'agents', "aw-official-leaf-leaf-role.toml");
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    await fs.remove(agentPath);

    const repairedReceipt = await runRecovery('sync', ['official/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', context: 'project', yes: true,
    }, runtime);
    expect(repairedReceipt.ok, JSON.stringify(repairedReceipt)).toBe(true);
    const repaired = repairedReceipt.targetResults.find((target) => target.pluginId === 'official/leaf'
      && target.scope === 'user' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(repaired.overallState, JSON.stringify(repaired.rebuildResults)).toBe('succeeded');
    expect(repairedReceipt.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'official/leaf', scope: 'user', providerScope: 'user', observation: 'verified',
    }));
    expect(repaired.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'official/leaf', scope: 'user' }),
        action: 'sync', state: 'completed',
      }),
    ]));
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
  }, 30_000);

  it('keeps project output unchanged when a separate User consumer installs the same dependency', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-user-promotion-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
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
    await expect(installFixturePlugin(['team/project-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    expect((await nativeInstructionContext('leaf')).hookSpecificOutput).toMatchObject({
      hookEventName: 'SessionStart', additionalContext: expect.stringContaining('leaf.'),
    });

    const projectBefore = await fs.readFile(projectConfigPath);
    const promoted = await installFixturePlugin(['team/user-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(promoted.overallState, JSON.stringify(promoted)).toBe('succeeded');
    expect(promoted.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), state: 'completed',
    }));
    expect(promoted.rebuildResults).not.toContainEqual(expect.objectContaining({ command: 'cleanup' }));
    await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectBefore);
  });

  it('repairs partial User output without changing the separate Project output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(
      isolation.layout.fixtureCwd,
      'partial-dependency-user-promotion-source',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            ...manifest.extensions,
            agents: [{
              name: 'leaf-role',
              description: 'Leaf role.',
              prompt: 'Use the leaf role.',
            }],
          };
        },
      },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
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
    const projectInstall = await installFixturePlugin(['team/project-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(projectInstall.overallState, JSON.stringify(projectInstall.rebuildResults))
      .toBe('succeeded');
    const sourceIdentity = projectInstall.rebuildResults.find((result) =>
      result.target.pluginId === 'team/leaf')!.target.sourceIdentity!;
    const userAgentPath = path.join(
      isolation.env.CODEX_HOME!,
      'agents',
      "aw-team-leaf-leaf-role.toml",
    );
    const userLayout = await nativeFixtureLayout('leaf', 'team', 'user', 'codex', sourceIdentity);
    const physicalKey = userLayout.renderUnits.find((unit) => unit.output === 'supplement')!.physicalKey;
    await writeOwnedTextFile({
      path: userAgentPath,
      allowedRoot: isolation.env.CODEX_HOME!,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity, physicalKey,
        pluginId: 'team/leaf',
        plugin: 'leaf',
        artifactKey: path.basename(userAgentPath),
        platform: 'codex',
        scope: 'user',
      },
      content: 'name = "partial leaf role"\n',
    });
    const projectAgentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      "aw-team-leaf-leaf-role.toml",
    );
    await expect(fs.pathExists(projectAgentPath)).resolves.toBe(true);
    const projectBefore = await fs.readFile(projectAgentPath);
    const promoted = await installFixturePlugin(['team/user-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(promoted.overallState, JSON.stringify(promoted)).toBe('succeeded');
    expect(promoted.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), state: 'completed',
    }));
    await expect(fs.readFile(userAgentPath, 'utf8')).resolves.not.toContain('partial leaf role');
    await expect(fs.pathExists(projectAgentPath)).resolves.toBe(true);
    await expect(fs.readFile(projectAgentPath)).resolves.toEqual(projectBefore);
    expect((await nativeInstructionContext('leaf')).hookSpecificOutput.additionalContext).toContain('leaf.');
  });

  it('repairs a partial user provider before its project consumer and preserves both declarations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'cross-scope-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const env = isolation.env;
    await writeIntentFixture({ scope: 'user', cwd, env },
      { roots: [{ pluginId: 'team/leaf', platforms: ['codex'] }] });
    await writeIntentFixture({ scope: 'project', cwd, env },
      { roots: [{ pluginId: 'team/root', platforms: ['codex'] }] });
    const userBefore = await observeIntent({ scope: 'user', cwd, env });
    const projectBefore = await observeIntent({ scope: 'project', cwd, env });
    const first = await runRecovery('sync', [], { cwd, env, cliVersion: '1.0.0', yes: true }, runtime);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const userConfig = path.join(env.CODEX_HOME!, 'config.toml');
    await fs.remove(userConfig);
    const repaired = await runRecovery('sync', ['team/root'], { cwd, env, cliVersion: '1.0.0', yes: true }, runtime);
    expect(repaired.ok, JSON.stringify(repaired)).toBe(true);
    expect(repaired.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', scope: 'user', execution: 'applied', observation: 'verified', providerScope: 'user',
    }));
    const restoredLayout = await nativeFixtureLayout('leaf', 'team', 'user');
    const restoredConfig = (await readCodexConfigFile(userConfig)).snapshot;
    expect(restoredConfig.plugins[restoredLayout.nativeIdentity.registrationId!]?.enabled).toBe(true);
    expect(restoredConfig.marketplaces[restoredLayout.marketplaceName!]).toBeUndefined();
    expect((await nativeInstructionContext('leaf')).hookSpecificOutput).toMatchObject({
      hookEventName: 'SessionStart', additionalContext: expect.stringContaining('leaf.'),
    });
    await expect(observeIntent({ scope: 'user', cwd, env })).resolves.toEqual(userBefore);
    await expect(observeIntent({ scope: 'project', cwd, env })).resolves.toEqual(projectBefore);
  });

  it('derives user dependency placement again for sync and rebuild without saved overrides', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'persistent-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env,
    });
    await writeIntentFixture({ scope: 'user', cwd, env },
      { roots: [{ pluginId: 'team/leaf', platforms: ['codex'] }] });
    await writeIntentFixture({ scope: 'project', cwd, env },
      { roots: [{ pluginId: 'team/root', platforms: ['codex'] }] });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const userBefore = await observeIntent({ scope: 'user', cwd, env });
    const projectBefore = await observeIntent({ scope: 'project', cwd, env });
    const preferencesPath = await resolvePreferencesPath({ scope: 'user', cwd, env });
    const preferencesBefore = await fs.readFile(preferencesPath);
    for (const command of ['sync', 'reinstall'] as const) {
      await fs.remove(path.join(env.CODEX_HOME!, 'config.toml'));
      const result = await runRecovery(command, ['team/root'], { cwd, env, cliVersion: '1.0.0', yes: true }, runtime);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.targetResults).toContainEqual(expect.objectContaining({
        pluginId: 'team/leaf', scope: 'user', providerScope: 'user', observation: 'verified',
      }));
      await expect(observeIntent({ scope: 'user', cwd, env })).resolves.toEqual(userBefore);
      await expect(observeIntent({ scope: 'project', cwd, env })).resolves.toEqual(projectBefore);
      await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    }
  });

  it('preserves project roots and local overrides during local uninstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-prune-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first-leaf' },
      { name: 'second-leaf' },
      { name: 'shared-leaf' },
      { name: 'first-root', dependencies: ['first-leaf', 'shared-leaf'] },
      { name: 'second-root', dependencies: ['second-leaf', 'shared-leaf'] },
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
    await expect(installFixturePlugin(['team/first-root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [
        { pluginId: 'team/first-leaf', platform: 'codex', scope: 'user' },
        { pluginId: 'team/shared-leaf', platform: 'codex', scope: 'user' },
      ],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['team/second-root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [
        { pluginId: 'team/second-leaf', platform: 'codex', scope: 'user' },
        { pluginId: 'team/shared-leaf', platform: 'codex', scope: 'user' },
      ],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const requirementsBefore = await readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    await expect(uninstallWriteCommand(['team/first-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toEqual(requirementsBefore);
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });

    await expect(uninstallWriteCommand(['team/second-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toEqual(requirementsBefore);
  });

  it('reconciles Codex AW extensions from component-specific live evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'component-evidence-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'guide', title: 'Guide', content: 'Guide.', coverage: ['main'] }],
          agents: [{ name: 'worker', description: 'Worker.', prompt: 'Work.' }],
        };
      },
    }]);
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
    const agentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      "aw-team-demo-worker.toml",
    );
    const originalAgent = await fs.readFile(agentPath);
    const instructionPath = path.join((await nativeFixtureLayout('demo')).packageRoot, 'scripts', 'aw-instructions.mjs');
    const originalInstructions = await fs.readFile(instructionPath);
    await fs.remove(agentPath);

    const synced = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    const writes = synced.operationPlan?.deploymentPlans?.flatMap((plan) => plan.effects)
      .filter((effect) => effect.kind === 'write-supplement');
    expect(writes, JSON.stringify(synced)).toEqual([expect.objectContaining({
      kind: 'write-supplement', destination: agentPath, componentIds: ['agent:worker'],
    })]);
    await expect(fs.readFile(agentPath)).resolves.toEqual(originalAgent);
    await expect(fs.readFile(instructionPath)).resolves.toEqual(originalInstructions);
    expect(synced.operationPlan?.deploymentPlans?.flatMap((plan) => plan.effects)).not.toContainEqual(expect.objectContaining({
      kind: 'write-supplement', componentIds: expect.arrayContaining(['instructions:guide']),
    }));
  });

  it.each(['uninstall', 'cleanup'] as const)(
    'keeps a Project consumer unchanged during a User %s',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `cross-scope-batch-${command}-source`);
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
      await expect(installFixturePlugin(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      await expect(installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const projectIntentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
      const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const [projectIntentBefore, projectConfigBefore] = await Promise.all([
        fs.readFile(projectIntentPath), fs.readFile(projectConfigPath),
      ]);
      const projectConsumerRoot = (await nativeFixtureLayout('root')).packageRoot;
      const projectConsumerBefore = await snapshotRegularTree(projectConsumerRoot);
      if (command === 'uninstall') {
        const result = await runRecovery('uninstall', ['team/leaf'], {
          cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'user', context: 'user',
          cliVersion: '1.0.0', force: true, yes: true,
        }, runtime);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.targetResults).toContainEqual(expect.objectContaining({
          pluginId: 'team/leaf', agent: 'codex', scope: 'user', execution: 'applied',
        }));
        await expect(observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
          .resolves.toMatchObject({ state: 'valid', value: { roots: [] } });
      } else {
        const result = await cleanupWriteCommand(['team/leaf'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
        }, runtime);
        expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
        expect(result.targetResults).toContainEqual(expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), state: 'completed',
        }));
      }
      await expect(snapshotRegularTree(projectConsumerRoot)).resolves.toEqual(projectConsumerBefore);
      await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntentBefore);
      await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectConfigBefore);
    },
  );
});
