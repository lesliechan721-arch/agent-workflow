import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { render } from 'ink-testing-library';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { execFileNativeCliRunner } from '../../src/utils/native-cli.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { type RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import {
  setStatusDependencyInspectionHookForTests,
  statusCommandV8,
} from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import type { PluginMeta } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { readSkillOwnerMarker, writeOwnedTextFile } from '../../src/utils/ownership.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
} from '../../src/utils/catalog-digests.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
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
  writeIntentRoundTripCodexPackage,
  runIntentRoundTripCliChild,
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';

async function nativeFixtureLayout(pluginName: string, sourceId = 'team', scope: 'user' | 'project' = 'project', platform: 'codex' | 'claude' = 'codex', sourceIdentity?: string) {
  const { env, layout } = getCurrentSourceTestIsolation();
  return getNativeTestLayout({ platform, sourceId, pluginId: `${sourceId}/${pluginName}`, scope,
    cwd: layout.fixtureCwd, env, sourceIdentity });
}
async function nativeRegistrationId(pluginName: string, sourceId = 'team', platform: 'codex' | 'claude' = 'codex') {
  return (await nativeFixtureLayout(pluginName, sourceId, 'user', platform)).nativeIdentity.registrationId!;
}
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

async function createIntentRoundTripFixture(nativeProviders = false) {
  const isolation = getCurrentSourceTestIsolation();
  await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
    { ...createEmptyPreferences(), targets: ['codex'] });
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-round-trip-source');
  const dynamicRole = (roleKey: string) => (manifest: PluginMeta['manifest']) => {
    manifest.platforms = ['codex'];
    manifest.extensions = nativeProviders ? { instructions: [{
      name: `${roleKey}-context`, title: 'Provider context', content: `Use provider ${roleKey}.`, coverage: ['main'],
    }] } : undefined;
    manifest.scripts = {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    };
    manifest.artifacts = { configKeys: [], scopes: ['project', 'user'] };
  };
  const definitions = [
    { name: 'c', configureManifest: dynamicRole('c-role') },
    { name: 'b', dependencies: ['c'], configureManifest: dynamicRole('b-role') },
    {
      name: 'a',
      dependencies: ['b'],
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
      },
    },
  ];
  await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
  await Promise.all([
    writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'b'),
      roleKey: 'b-role',
    }),
    writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'c'),
      roleKey: 'c-role',
    }),
  ]);
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
  const fakeCodexBin = await writeIntentRoundTripCodexPackage(path.join(
    isolation.layout.rootDir,
    'intent-round-trip-codex',
  ));
  const childEnv = {
    ...isolation.env,
    PATH: fakeCodexBin,
    npm_config_offline: 'true',
    NPM_CONFIG_OFFLINE: 'true',
  };
  return { isolation, childEnv };
}

describe('five namespaced write commands', () => {
  let defaultNativeRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  beforeEach(async () => {
    installNativeTestQualification({ discovery: true, trust: true });
    defaultNativeRuntime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('installs and saves ordinary config without parsing an unrelated future bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-future-install-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'root', configureManifest(manifest) {
        manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'safe' } } };
      } },
      { name: 'future', requiredCapabilities: ['aw.future-feature.v3'] },
    ]);
    const futureRoot = path.join(sourceRoot, 'plugins', 'future');
    const futureManifestPath = path.join(futureRoot, '.agents-plugin', 'plugin.json');
    const futureManifest = await fs.readJson(futureManifestPath);
    futureManifest.schemaVersion = 99;
    await fs.writeJson(futureManifestPath, futureManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const futureEntry = catalogManifest.entries.find((entry: { name: string }) =>
      entry.name === 'future');
    futureEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(futureRoot);
    futureEntry.manifestDigest = calculateCatalogEntryManifestDigest(futureManifest);
    futureEntry.contentDigest = await calculateCatalogEntryContentDigest(futureRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.resolvedPluginIds).toEqual(['team/root']);
    // Test Value Gate: future bundles in a shared Catalog must not block an
    // unrelated supported plugin's ordinary config Review or save.
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    })));
    try {
      await controller.load();
      const review = await controller.buildOperationReview({
        kind: 'configSave', pluginId: 'team/root', scope: 'user', apply: false,
        updates: { mode: 'strict' },
      });
      expect(await controller.executeOperation(review.reviewToken)).toMatchObject({ state: 'succeeded' });
      const stored = await fs.readJson(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'root', scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }));
      expect(stored.common).toEqual({ mode: 'strict' });
    } finally {
      await controller.cancelAndWaitForReads();
      controller.dispose();
    }
  });

  it('lists supported and future entries in status and TUI without parsing the future bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-future-status-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf', 'future'] },
      { name: 'future', requiredCapabilities: ['aw.future-feature.v3'] },
    ]);
    const futureRoot = path.join(sourceRoot, 'plugins', 'future');
    const futureManifestPath = path.join(futureRoot, '.agents-plugin', 'plugin.json');
    const futureManifest = await fs.readJson(futureManifestPath);
    futureManifest.schemaVersion = 99;
    await fs.writeJson(futureManifestPath, futureManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const futureEntry = catalogManifest.entries.find((entry: { name: string }) =>
      entry.name === 'future');
    futureEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(futureRoot);
    futureEntry.manifestDigest = calculateCatalogEntryManifestDigest(futureManifest);
    futureEntry.contentDigest = await calculateCatalogEntryContentDigest(futureRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    const status = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      json: true,
    });
    expect(status.payload.catalog.sources).toEqual([
      expect.not.objectContaining({ error: expect.anything() }),
    ]);
    expect(status.pluginSummaries.map((entry) => entry.pluginId).sort()).toEqual([
      'team/future',
      'team/leaf',
      'team/root',
    ]);
    expect(status.pluginSummaries.find((entry) => entry.pluginId === 'team/future'))
      .toMatchObject({ missingCapabilities: ['aw.future-feature.v3'] });
    expect(status.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/future',
        state: 'blocked',
        reasons: [expect.objectContaining({ code: 'awCapabilityUnsupported' })],
      }),
    ]));

    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    expect(controller.snapshot.phase).toBe('ready');
    expect(controller.snapshot.viewModel?.plugins.map((entry) => entry.pluginId).sort()).toEqual([
      'team/future',
      'team/leaf',
      'team/root',
    ]);
    expect(controller.snapshot.viewModel?.plugins.find((entry) => entry.pluginId === 'team/future'))
      .toMatchObject({ aggregateStatus: 'unavailable', missingCapabilities: ['aw.future-feature.v3'] });
    expect(controller.snapshot.viewModel?.plugins.find((entry) => entry.pluginId === 'team/root'))
      .toMatchObject({ dependencySummary: { directCount: 2, totalCount: 2 } });
    expect(controller.snapshot.viewModel?.dependencyOverviews.find((entry) =>
      entry.pluginId === 'team/root')?.dependencies.find((entry) =>
        entry.pluginId === 'team/future')).toMatchObject({ aggregateStatus: 'unavailable' });
    for (let attempt = 0; attempt < 100
      && ['notChecked', 'checking'].includes(controller.getCatalogFreshness('team')?.state ?? 'notChecked');
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(controller.getCatalogFreshness('team')?.state).toBe('current');
    controller.dispose();
  });

  it('reports an unsupported direct dependency as a stable dependency root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'future-live-dependency-source');
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
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const leafRoot = path.join(sourceRoot, 'plugins', 'leaf');
    const leafManifestPath = path.join(leafRoot, '.agents-plugin', 'plugin.json');
    const leafManifest = await fs.readJson(leafManifestPath);
    leafManifest.requires.aw.capabilities.push('aw.future-feature.v3');
    await fs.writeJson(leafManifestPath, leafManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const leafEntry = catalogManifest.entries.find((entry: { name: string }) => entry.name === 'leaf');
    leafEntry.requires = leafManifest.requires;
    leafEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(leafRoot);
    leafEntry.manifestDigest = calculateCatalogEntryManifestDigest(leafManifest);
    leafEntry.contentDigest = await calculateCatalogEntryContentDigest(leafRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });

    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    const target = status.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
    expect(status.allSatisfied, JSON.stringify(status)).toBe(false);
    expect(target).toMatchObject({ pluginId: 'team/root', agent: 'codex', scope: 'project',
      blockers: expect.arrayContaining([expect.objectContaining({
        code: 'awCapabilityUnsupported', pluginId: 'team/leaf',
      })]),
    });
    const repeated = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    expect(repeated.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0]?.blockers)
      .toEqual(target?.blockers);
  });

  it('fails a selected dependency closure with the exact unsupported plugin and capabilities', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unsupported-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', requiredCapabilities: ['aw.future-feature.v3'] },
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

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    });

    expect(result.overallState).toBe('failed');
    expect(JSON.stringify(result)).toContain('team/leaf');
    expect(JSON.stringify(result)).toContain('aw.future-feature.v3');
    expect(JSON.stringify(result)).toContain('awCapabilityUnsupported');
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
    expect(projectConfig.snapshot.plugins[leafId]?.enabled).toBe(true);
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
    expect(restoredConfig.marketplaces[restoredLayout.marketplaceName!]).toMatchObject({
      sourceType: 'local', source: restoredLayout.marketplaceRoot,
    });
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

  it('keeps a failed explicit user Native provider for a prepared AW extension root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(
      isolation.layout.fixtureCwd,
      'failed-native-manager-intent-source',
    );
    const definitions = [
      {
        name: 'b',
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
          manifest.skills = './skills';
          manifest.extensions = undefined;
        },
      },
      {
        name: 'a',
        dependencies: ['b'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
      {
        name: 'independent',
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const nativeSkillRoot = path.join(sourceRoot, 'plugins', 'b', 'skills', 'b-skill');
    await Promise.all([
      fs.outputFile(
        path.join(nativeSkillRoot, 'SKILL.md'),
        '---\nname: b-skill\ndescription: B skill.\n---\n',
      ),
      fs.outputFile(
        path.join(nativeSkillRoot, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
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
    await writeIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { roots: [{ pluginId: 'team/b', platforms: ['codex'] }] });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const listCallsBefore = runtime.nativeCliRunner.mock.calls.length;
    const failedProviderId = await nativeRegistrationId('b');
    const nativeRunner = runtime.nativeCliRunner;
    const failingNativeRunner: RebuildCommandRuntime['nativeCliRunner'] = async (invocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex < 0 ? invocation.args : invocation.args.slice(pluginIndex);
      if (args[1] === 'add' && args[2] === failedProviderId) {
        return { exitCode: 23, stdout: '', stderr: 'injected provider install failure' };
      }
      return nativeRunner(invocation);
    };

    const first = await installFixturePlugin(['team/a', 'team/independent'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/b', platform: 'codex', scope: 'user',
      }],
    }, {
      ...runtime,
      nativeCliRunner: failingNativeRunner,
    });

    expect(runtime.nativeCliRunner.mock.calls.slice(listCallsBefore).some(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'list' && args.includes('--json');
    }), JSON.stringify(first, null, 2)).toBe(true);
    expect(first.overallState).toBe('partial');
    expect(first.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b', scope: 'user' }),
        state: 'failed',
        errorCode: 'platformMutationFailed',
        message: expect.stringContaining('platformMutationFailed'),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a', scope: 'project' }),
        action: 'skipped', state: 'failed', errorCode: 'dependencyInstallFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent', scope: 'project' }),
        state: 'completed',
      }),
    ]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', first);
    expect(receipt).toMatchObject({
      overallState: 'partial',
      requestedPluginIds: ['team/a', 'team/independent'],
      resolvedPluginIds: ['team/a', 'team/b', 'team/independent'],
      dependencyEdges: [{ from: 'team/a', to: 'team/b', platform: 'codex' }],
    });
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        action: 'skipped', errorCode: 'dependencyInstallFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent' }),
        state: 'completed',
      }),
    ]));
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'team/a', platforms: ['codex'] },
        { pluginId: 'team/independent', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    await writePreferences(intentLocation, {
      ...createEmptyPreferences(),
      targets: ['codex'],

    });

    const fakeCodexBin = await writeIntentRoundTripCodexPackage(path.join(
      isolation.layout.rootDir,
      'failed-native-manager-intent-codex',
    ));
    const syncOutput = await runIntentRoundTripCliChild([
      'plugin', 'sync',
      '--context',
      'project',
      '--target',
      'codex',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, {
      ...isolation.env,
      PATH: fakeCodexBin,
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    });
    const syncResults = syncOutput.split(/\r?\n/u).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    expect(syncResults).toHaveLength(1);
    const syncReceipt = syncResults[0];
    expect(syncReceipt).toMatchObject({
      schemaVersion: 1, command: 'plugin.sync', status: 'success',
      data: {
        targetResults: expect.arrayContaining([
          expect.objectContaining({ pluginId: 'team/b', target: 'codex', scope: 'user', execution: 'applied', content: 'satisfied', blockerCodes: [] }),
          expect.objectContaining({ pluginId: 'team/a', target: 'codex', scope: 'project', execution: 'applied', content: 'satisfied', blockerCodes: [] }),
          expect.objectContaining({ pluginId: 'team/independent', target: 'codex', scope: 'project', execution: 'applied', content: 'satisfied' }),
        ]), remainingTargets: [], allSatisfied: true
      },
    });
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'team/a', platforms: ['codex'] },
        { pluginId: 'team/independent', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });

    await expect(readFixtureRequirements({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ roots: [{ pluginId: 'team/b', platforms: ['codex'] }], dependencyScopeOverrides: [] });
    const projectBeforeOverlap = await readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const overlapping = await installFixturePlugin(
      ['team/a', 'team/b', 'team/independent'],
      { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user' },
      { ...runtime, nativeCliRunner: failingNativeRunner },
    );
    expect(overlapping.overallState).toBe('partial');
    expect(overlapping.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b', scope: 'user' }),
        errorCode: 'platformMutationFailed', state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a', scope: 'user' }),
        errorCode: 'dependencyInstallFailed', state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent', scope: 'user' }),
        state: 'completed',
      }),
    ]));
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toEqual(projectBeforeOverlap);
    // A related Windows hosted child CLI scenario passes in nearly 60s.
    // Keep a bounded orchestration deadline; product timeouts and perf budgets stay separate.
  }, process.platform === 'win32' ? 120_000 : 60_000);

  it('derives user dependency placement through independent CLI processes without saved overrides', async (test) => {
    const timing = createCommandTestTiming(test);
    const { isolation, childEnv } = await timing.measure('fixture', 'prepare independent CLI', () =>
      createIntentRoundTripFixture());
    const installedUser = await timing.measure('command', 'install user provider', () => runRecovery('install', ['team/b'], {
      cwd: isolation.layout.fixtureCwd, env: childEnv, scope: 'user', context: 'user',
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, { nativeCliRunner: execFileNativeCliRunner }));
    expect(installedUser.ok, JSON.stringify(installedUser)).toBe(true);
    await timing.measure('command', 'child install project consumer', () => runIntentRoundTripCliChild([
      'plugin', 'install',
      'team/a',
      '--scope',
      'project',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv));
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    const userRoleRoot = path.join(isolation.env.CODEX_HOME!, 'agents');
    const projectRoleRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
    const roleNames = ["aw-team-b-b-role.toml", "aw-team-c-c-role.toml"];
    const preferencesPath = await resolvePreferencesPath(intentLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const projectBefore = await observeIntent(intentLocation);
    const userLocation = { ...intentLocation, scope: 'user' as const };
    const userBefore = await observeIntent(userLocation);
    for (const name of roleNames) {
      const rolePath = path.join(userRoleRoot, name);
      const delivered = await fs.readFile(rolePath, 'utf8');
      expect(delivered).toContain('Use this role.');
      await fs.writeFile(rolePath, delivered.replace('Use this role.', 'Stale provider output.'));
    }
    await timing.measure('command', 'child sync project consumer', () => runIntentRoundTripCliChild([
      'plugin', 'sync',
      'team/a',
      '--context',
      'project',
      '--target',
      'codex',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv));
    for (const name of roleNames) {
      await expect(fs.readFile(path.join(userRoleRoot, name), 'utf8')).resolves.toContain('Use this role.');
      await expect(fs.pathExists(path.join(projectRoleRoot, name))).resolves.toBe(false);
    }
    await expect(observeIntent(intentLocation)).resolves.toEqual(projectBefore);
    await expect(observeIntent(userLocation)).resolves.toEqual(userBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });

    // Hosted macOS and Windows need room for the install and two independent CLI processes.
    // Keep a bounded orchestration deadline; product timeouts and perf budgets stay separate.
  }, process.platform === 'win32' || process.platform === 'darwin' ? 120_000 : 60_000);

  // Test Value Gate: an independent remove process must retain the User providers' real owned outputs.
  it('preserves User providers when an independent CLI process removes its Project consumer', async () => {
    const { isolation, childEnv } = await createIntentRoundTripFixture(true);
    await runIntentRoundTripCliChild([
      'plugin', 'install', 'team/b', '--scope', 'user', '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    const installedProject = await runRecovery('install', ['team/a'], {
      cwd: isolation.layout.fixtureCwd, env: childEnv, scope: 'project', context: 'project',
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, { nativeCliRunner: execFileNativeCliRunner });
    expect(installedProject.ok, JSON.stringify(installedProject)).toBe(true);
    const projectLocation = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: childEnv };
    const userLocation = { ...projectLocation, scope: 'user' as const };
    await expect(readFixtureRequirements(projectLocation)).resolves.toMatchObject({
      schemaVersion: 3, kind: 'aw-plugin-intents', roots: [{ pluginId: 'team/a', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    const userBefore = await observeIntent(userLocation);
    expect(userBefore).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/b' }] } });
    const preferencesPath = await resolvePreferencesPath(userLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const sourceIdentity = (await readCatalogGenerationState(childEnv)).sources.team?.active?.sourceIdentity;
    expect(sourceIdentity).toMatch(/^sha256:/u);
    const providers = await Promise.all(['b', 'c'].map(async (name) => {
      const native = await nativeFixtureLayout(name, 'team', 'user', 'codex', sourceIdentity);
      const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', `aw-team-${name}-${name}-role.toml`);
      const role = await fs.readFile(rolePath);
      expect(role.toString('utf8')).toContain('Use this role.');
      await expect(fs.pathExists(path.join(native.packageRoot, '.codex-plugin', 'plugin.json'))).resolves.toBe(true);
      expect(await readSkillOwnerMarker({ skillRoot: native.packageRoot, allowedRoot: path.dirname(native.packageRoot) }))
        .toMatchObject({ pluginId: `team/${name}`, sourceIdentity, physicalKey: native.binding.physicalKey });
      return { native, rolePath, role, packageBefore: await snapshotRegularTree(native.packageRoot) };
    }));
    await runIntentRoundTripCliChild([
      'plugin', 'remove', 'team/a', '--scope', 'project', '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    await expect(readFixtureRequirements(projectLocation)).resolves.toMatchObject({
      schemaVersion: 3, kind: 'aw-plugin-intents', roots: [], dependencyScopeOverrides: [],
    });
    await expect(observeIntent(userLocation)).resolves.toEqual(userBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    const userConfig = (await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).snapshot;
    for (const provider of providers) {
      await expect(fs.readFile(provider.rolePath)).resolves.toEqual(provider.role);
      await expect(snapshotRegularTree(provider.native.packageRoot)).resolves.toEqual(provider.packageBefore);
      expect(userConfig.plugins[provider.native.nativeIdentity.registrationId!]?.enabled).toBe(true);
    }
  }, 60_000);

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

  it('keeps a healthy consumer from becoming ready when its live dependency is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-status-source');
    const agentPlugin = (name: string) => ({
      name,
      configureManifest: (manifest: Awaited<ReturnType<typeof readPluginManifest>>['manifest']) => {
        manifest.extensions = {
          agents: [{ name: `${name}-role`, description: `${name} role.`, prompt: `${name}.` }],
        };
      },
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      agentPlugin('leaf'),
      { ...agentPlugin('root'), dependencies: ['leaf'] },
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
    const status = () => readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    const leafAgent = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      "aw-team-leaf-leaf-role.toml",
    );
    const canonicalLeafAgent = await fs.realpath(leafAgent);
    const readFile = fs.readFile;
    const unreadableAgent = vi.spyOn(fs, 'readFile').mockImplementation((...args) => {
      if ([leafAgent, canonicalLeafAgent].includes(String(args[0]))) {
        return Promise.reject(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
      }
      return Reflect.apply(readFile, fs, args);
    });
    const unreadable = await status().finally(() => unreadableAgent.mockRestore());
    const unreadableLeaf = unreadable.observedTargets?.find((target) => target.pluginId === 'team/leaf');
    expect(unreadable.allSatisfied, JSON.stringify(unreadable)).not.toBe(true);
    expect(unreadableLeaf).toMatchObject({ pluginId: 'team/leaf', agent: 'codex', scope: 'project',
      observation: 'unknown', content: 'unknown',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'componentOutputUnconfirmed' })]),
    });
    await fs.remove(leafAgent);
    const missing = await status();
    const missingLeaf = missing.observedTargets?.find((target) => target.pluginId === 'team/leaf');
    expect(missingLeaf).toMatchObject({ content: 'drifted', observation: 'unknown',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'platformContentDrift' })]),
    });
    expect(missingLeaf?.deploymentObservations?.flatMap((entry) => entry.after.components))
      .toContainEqual(expect.objectContaining({ id: 'agent:leaf-role', presence: 'absent', reasonCodes: ['componentOutputMissing'] }));
    const missingConsumer = missing.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
    expect(missingConsumer).toMatchObject({ pluginId: 'team/root', scope: 'project', content: 'drifted', observation: 'unknown' });
    expect(missingConsumer?.backend).toContainEqual(expect.objectContaining({ pluginId: 'team/leaf', scope: 'project', content: 'drifted' }));
    const createController = () => new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    const missingController = createController();
    await missingController.load();
    const missingIssue = missingController.listUserIssues().find((issue) =>
      issue.issueId === 'dependencyMissing:team/leaf:codex:project');
    expect(missingIssue).toMatchObject({
      relationship: 'consumer',
      rootEntity: { pluginId: 'team/leaf', platform: 'codex', scope: 'project' },
      affectedTargets: [expect.objectContaining({
        pluginId: 'team/root', relationship: 'consumer',
      })],
    });
    expect(missingIssue?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sync', pluginId: 'team/root', platform: 'codex',
        scope: 'project', writeAction: 'sync',
      }),
      expect.objectContaining({ id: 'viewDependencyIssue', pluginId: 'team/leaf' }),
    ]));
    missingController.dispose();

    await expect(reinstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await fs.remove(leafAgent);
    await fs.ensureDir(leafAgent);
    const notReadyController = createController();
    await notReadyController.load();
    const collisionIssue = notReadyController.listUserIssues().find((issue) =>
      issue.category === 'artifactCollision'
      && issue.pluginId === 'team/leaf'
      && issue.platform === 'codex'
      && issue.scope === 'project');
    expect(collisionIssue).toMatchObject({
      group: 'artifactCollision',
      relationship: 'direct',
      rootEntity: { pluginId: 'team/leaf', platform: 'codex', scope: 'project' },
      affectedTargets: expect.arrayContaining([expect.objectContaining({
        pluginId: 'team/root',
        platform: 'codex',
        scope: 'project',
        relationship: 'consumer',
      })]),
      technicalDetails: expect.arrayContaining([expect.objectContaining({ code: 'dependencyNotReady' })]),
    });
    const collisionStatus = await status();
    const collisionLeaf = collisionStatus.observedTargets?.find((target) => target.pluginId === 'team/leaf');
    expect(collisionStatus.allSatisfied, JSON.stringify(collisionStatus)).toBe(false);
    expect(collisionLeaf).toMatchObject({ content: 'conflict', observation: 'unknown', blockers: expect.arrayContaining([
      expect.objectContaining({ code: 'supplementOwnershipConflict' }),
    ]) });
    const collisionConsumer = collisionStatus.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
    expect(collisionConsumer).toMatchObject({ pluginId: 'team/root', content: 'conflict', observation: 'unknown' });
    expect(collisionConsumer?.backend).toContainEqual(expect.objectContaining({ pluginId: 'team/leaf', scope: 'project', content: 'conflict' }));
    notReadyController.dispose();
  });

  it('projects a dependency target blocker through a real controller load', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const targetRoot = path.join(isolation.layout.fixtureCwd, 'dependency-target-issue-source');
    await createDependencyCatalogSnapshotFixture(targetRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.platforms = ['codex'];
        },
      },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'target', type: 'path', primary: true, path: targetRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    })));
    await controller.load();

    expect(controller.listUserIssues()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'dependencyTargetUnsupported',
        group: 'dependency',
        pluginId: 'target/root',
      }),
    ]));
    expect(controller.getPluginOverview('target/root')?.primaryAttention?.code)
      .toBe('dependencyTargetUnsupported');
    controller.dispose();
  });

  it('deduplicates status inspection for one dependency placement shared by consumers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-dedup-source');
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
    const installed = await installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    let dependencyInspections = 0;
    setStatusDependencyInspectionHookForTests(() => { dependencyInspections += 1; });
    try {
      await statusCommandV8({
        plugins: ['team/first', 'team/second'], cwd: isolation.layout.fixtureCwd,
        env: isolation.env, cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setStatusDependencyInspectionHookForTests(undefined);
    }
    expect(dependencyInspections).toBe(1);
  });

  it('uses current manifest edges for status dependency checks', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-contract-drift-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
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
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const status = () => readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    const before = await status();
    expect(before.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults)
      .toContainEqual(expect.objectContaining({ content: 'satisfied', observation: 'verified', blockers: [] }));
    expect(before.observedTargets?.find((target) => target.pluginId === 'team/leaf')?.contributions)
      .toContainEqual({ root: 'team/root', scope: 'project', path: ['team/root', 'team/leaf'] });

    const nativeRoot = (await nativeFixtureLayout('root')).packageRoot;
    const nativeBefore = await snapshotRegularTree(nativeRoot);
    const location = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const scopes = ['user', 'project'] as const;
    const intentsBefore = await Promise.all(scopes.map((scope) => observeIntent({ ...location, scope })));
    const preferencesPath = await resolvePreferencesPath({ ...location, scope: 'user' });
    const preferencesBefore = await fs.readFile(preferencesPath);
    const nativeConfigPaths = [path.join(isolation.env.CODEX_HOME!, 'config.toml'),
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')];
    const nativeConfigsBefore = await Promise.all(nativeConfigPaths.map((file) => fs.readFile(file)));
    const nativeCallsBefore = defaultNativeRuntime.nativeCliRunner.mock.calls.length;

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: [] },
    ]);
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true });
    const after = await status();
    expect(after.observedTargets?.find((target) => target.pluginId === 'team/leaf')).toBeUndefined();
    const currentRoot = after.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
    expect(currentRoot).toMatchObject({ pluginId: 'team/root', content: 'drifted', observation: 'unknown',
      blockers: [expect.objectContaining({ code: 'platformInputDrift' })] });
    expect(after.allSatisfied).toBe(false);
    expect(currentRoot?.backend).not.toContainEqual(expect.objectContaining({ pluginId: 'team/leaf' }));
    expect(currentRoot?.blockers).not.toContainEqual(expect.objectContaining({ code: 'dependencyMissing' }));
    await expect(snapshotRegularTree(nativeRoot)).resolves.toEqual(nativeBefore);
    await expect(Promise.all(scopes.map((scope) => observeIntent({ ...location, scope })))).resolves.toEqual(intentsBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    await expect(Promise.all(nativeConfigPaths.map((file) => fs.readFile(file)))).resolves.toEqual(nativeConfigsBefore);
    const readOnlyCalls = defaultNativeRuntime.nativeCliRunner.mock.calls.slice(nativeCallsBefore).map(([invocation]) => invocation);
    expect(readOnlyCalls.every(({ args }) => {
      const pluginIndex = args.indexOf('plugin');
      return pluginIndex >= 0 ? args[pluginIndex + 1] === 'list' : args.at(-1) === '--version';
    }), JSON.stringify(readOnlyCalls)).toBe(true);

    const repaired = await runRecovery('sync', ['team/root'], { ...location,
      scope: 'project', context: 'project', cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, runtime);
    expect(repaired.ok, JSON.stringify(repaired)).toBe(true);
    const refreshed = await status();
    expect(refreshed.observedTargets?.find((target) => target.pluginId === 'team/leaf')).toBeUndefined();
    const readyRoot = refreshed.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
    expect(readyRoot).toMatchObject({ pluginId: 'team/root', content: 'satisfied', observation: 'verified', blockers: [] });
    expect(readyRoot?.backend).not.toContainEqual(expect.objectContaining({ pluginId: 'team/leaf' }));
    await expect(Promise.all(scopes.map((scope) => observeIntent({ ...location, scope })))).resolves.toEqual(intentsBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
  });

  it('checks every requested target for foreign ownership before the first root writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'batch-foreign-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first' },
      {
        name: 'second',
        configureManifest: (manifest) => {
          manifest.extensions!.agents = [{
            name: 'second-role', description: 'Second role.', prompt: 'Second.',
          }];
        },
      },
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
    const foreignRole = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-second-second-role.toml");
    await fs.outputFile(foreignRole, 'foreign');

    const result = await installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    });

    expect(result.overallState).toBe('partial');
    expect(result.targetResults.length).toBeGreaterThan(0);
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'artifactCollision' }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(true);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');

    for (const pluginId of ['team/first', 'team/second']) {
      await expect(cleanupWriteCommand([pluginId], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, {
        env: isolation.env,
        nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
      })).resolves.toMatchObject({
        overallState: 'succeeded',
      });
    }
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');
  });
});
