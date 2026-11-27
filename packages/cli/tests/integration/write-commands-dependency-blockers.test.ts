import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { runRecovery } from '../../src/recovery/coordinator.js';
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
import path from 'node:path';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import type { PluginMeta } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
} from '../../src/utils/catalog-digests.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import {
  reinstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  writeIntentRoundTripCodexPackage,
  runIntentRoundTripCliChild,
} from '../helpers/write-command-fixture.js';
import { nativeFixtureLayout, nativeRegistrationId } from '../helpers/write-command-dependency-placement-fixture.js';

describe('five namespaced write commands', () => {
  let defaultNativeRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  beforeEach(async () => {
    installNativeTestDiscovery();
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
      schemaVersion: 2, command: 'plugin.sync', status: 'success',
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
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'stateInventoryFailed',
        detail: expect.objectContaining({ reasonCode: 'ownerHeaderRead' }) })]),
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'componentOutputUnconfirmed' })]),
    });
    await fs.remove(leafAgent);
    const missing = await status();
    const missingLeaf = missing.observedTargets?.find((target) => target.pluginId === 'team/leaf');
    expect(missingLeaf).toMatchObject({ content: 'absent', observation: 'missing', blockers: [],
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'componentOutputMissing' })]),
    });
    expect(missingLeaf?.deploymentObservations?.flatMap((entry) => entry.after.components))
      .toContainEqual(expect.objectContaining({ id: 'agent:leaf-role', presence: 'absent', reasonCodes: ['componentOutputMissing'] }));
    const missingConsumer = missing.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
    expect(missingConsumer).toMatchObject({ pluginId: 'team/root', scope: 'project', content: 'absent', observation: 'missing' });
    expect(missingConsumer?.backend).toContainEqual(expect.objectContaining({ pluginId: 'team/leaf', scope: 'project', content: 'absent' }));
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
    expect(currentRoot).toMatchObject({ pluginId: 'team/root', content: 'satisfied', observation: 'verified', blockers: [] });
    expect(after.allSatisfied).toBe(true);
    expect(after.extraObserved).toContainEqual(expect.objectContaining({ pluginId: 'team/leaf', scope: 'project' }));
    expect(after.inSync).toBe(false);
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
