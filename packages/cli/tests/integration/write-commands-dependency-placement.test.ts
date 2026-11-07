import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { realpath } from 'node:fs/promises';
import { render } from 'ink-testing-library';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { type RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import {
  setStatusDependencyInspectionHookForTests,
  statusCommandV8,
  statusTargetExtensions,
  statusTargetIntent,
} from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { buildTuiViewModel } from '../../src/tui/model.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { setNativeCliRunnerOverrideForTests } from '../../src/utils/native-cli.js';
import type { PluginMeta } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writeOwnedTextFile } from '../../src/utils/ownership.js';
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
  writeStatusSystemCodexPackage,
  writeIntentRoundTripCodexPackage,
  runIntentRoundTripCliChild,
  parseIntentRoundTripReceipt,
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('installs and saves ordinary config without parsing an unrelated future bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-future-install-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'root', configureManifest(manifest) {
        manifest.config = { schemaVersion: 4, fields: { mode: { type: 'string', default: 'safe' } } };
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.resolvedPluginIds).toEqual(['team/root']);
    // Test Value Gate: future bundles in a shared Catalog must not block an
    // unrelated supported plugin's ordinary config Review or save.
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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

    await expect(statusCommandV8({
      plugins: ['team/root'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
      json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({
        pluginId: 'team/root',
        placements: [expect.objectContaining({
          scope: 'project',
          components: expect.arrayContaining([expect.objectContaining({
            kind: 'dependency',
            key: 'team/leaf',
            state: 'error',
            metadata: expect.objectContaining({
              rootIssueId: 'awCapabilityUnsupported:team/leaf',
              rootIssueCode: 'awCapabilityUnsupported',
            }),
          })]),
        })],
        reasons: [expect.objectContaining({
          code: 'awCapabilityUnsupported',
          dependencyPluginId: 'team/leaf',
          rootIssueId: 'awCapabilityUnsupported:team/leaf',
          rootIssueCode: 'awCapabilityUnsupported',
        })],
      })] },
    });
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
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
    const preApplyScript = [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const context = JSON.parse(await new Promise((resolve) => { let data = ""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => resolve(data)); }));',
      'const counter = `${process.env.AW_HOME}/pre-apply-count-${context.plugin.name}.txt`;',
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const leafInstall = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime);
    expect(leafInstall.overallState, JSON.stringify(leafInstall.rebuildResults)).toBe('succeeded');
    const leafStatus = await statusCommandV8({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    const leafUserTarget = leafStatus.payload.targets[0];
    expect(leafUserTarget?.state, JSON.stringify(leafUserTarget)).toBe('ready');

    await writePreferences({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],

    });
    const installedReceipt = await runRecovery('install', ['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(installedReceipt.ok, JSON.stringify(installedReceipt)).toBe(true);
    expect(installedReceipt.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/middle', scope: 'project', providerScope: 'project', observation: 'verified',
    }));
    const leafBackend = installedReceipt.targetResults.find((target) => target.pluginId === 'team/root'
      && target.scope === 'project' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;
    expect(leafBackend.targetResults, JSON.stringify(installedReceipt)).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), action: 'keep', state: 'completed',
    }));
    const installedStatus = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    const leafTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/leaf');
    const rootTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/root');
    const middleTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/middle');
    const leafUserPlacement = leafTarget?.placements.find((placement) => placement.scope === 'user');
    expect(leafUserPlacement).toMatchObject({ scope: 'user', state: 'ready' });
    expect(statusTargetIntent(leafUserPlacement!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'root',
    });
    expect(leafUserPlacement?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'codexActivationDrift' }),
    ]));
    expect(rootTarget?.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'project' }),
    ]));
    expect(middleTarget?.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'project', state: 'ready' }),
    ]));
    expect(installedStatus.payload.targets.flatMap((target) => target.reasons)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'dependencyMissing' })]),
    );
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
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
    expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'pre-apply-count-leaf.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'pre-apply-count-middle.txt'), 'utf8'))
      .resolves.toBe('2');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'pre-apply-count-root.txt'), 'utf8'))
      .resolves.toBe('2');

    // Project recovery must not execute the healthy User dependency again.
    const repeatedLeaf = repeated.targetResults.find((entry) => entry.pluginId === 'team/root' && entry.scope === 'project')
      ?.backend as Awaited<ReturnType<typeof installWriteCommand>>;
    expect(repeatedLeaf.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), action: 'keep', state: 'completed',
    }));
  });

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
    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'user-extension-status-prefix'), runtime.codexVersion,
    );
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      const status = await statusCommandV8({
        cwd: isolation.layout.fixtureCwd, env: { ...isolation.env, PATH: binRoot },
        plugins: ['team/demo'], cliVersion: '1.0.0', platform: 'codex', json: true,
      });
      expect(status.payload.targets).toEqual([expect.objectContaining({
        state: 'ready', reasons: [], recoveryActions: [],
        placements: expect.arrayContaining([
          expect.objectContaining({ scope: 'user', state: 'ready', reasons: [] }),
          expect.objectContaining({ scope: 'project', state: 'absent', reasons: [], recoveryActions: [] }),
        ]),
      })]);
      const view = buildTuiViewModel({ status: status.payload, pluginSummaries: [] });
      expect(view.plugins).toEqual([expect.objectContaining({
        aggregateStatus: 'installed',
        installedPlacements: [expect.objectContaining({
          scope: 'user', health: 'ready', actualScopes: ['user'], desiredScopes: ['user'],
        })],
      })]);
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
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
      'aw', 'agent-content-toolkit', '1.0.0');
    const providerPackageBefore = await snapshotRegularTree(providerPackageRoot);
    const nativeCallsBefore = runtime.nativeCliRunner.mock.calls.length;
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'agent-content-toolkit@aw': false },
    });

    const installedReceipt = await runRecovery('install', ['official/aw-catalog-development'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(installedReceipt.ok, JSON.stringify(installedReceipt)).toBe(true);
    expect((await readCodexConfigFile(projectConfigPath))
      .snapshot.plugins['agent-content-toolkit@aw']?.enabled).toBe(true);
    await expect(observeIntent(userIntentLocation)).resolves.toEqual(userIntentBefore);
    await expect(snapshotRegularTree(providerPackageRoot)).resolves.toEqual(providerPackageBefore);
    expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBefore).filter(([invocation]) => {
      const index = invocation.args.indexOf('plugin');
      return index >= 0
        && ['add', 'remove', 'enable', 'disable'].includes(invocation.args[index + 1] ?? '')
        && invocation.args[index + 2] === 'agent-content-toolkit@aw';
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

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'native-cross-scope-status-prefix'),
      runtime.codexVersion,
    );
    const statusEnv = { ...isolation.env, PATH: binRoot };
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    let status;
    let issues: ReturnType<TuiController['listUserIssues']>;
    let controller: TuiController | undefined;
    try {
      status = await statusCommandV8({
        cwd: isolation.layout.fixtureCwd, env: statusEnv,
        cliVersion: '1.0.0', platform: 'codex', json: true,
      });
      controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: statusEnv,
        nativeCliRunner: runtime.nativeCliRunner,
        interactive: false,
      })));
      await controller.load();
      issues = controller.listUserIssues();
    } finally {
      controller?.dispose();
      setNativeCliRunnerOverrideForTests(null);
    }
    const toolkit = status.payload.targets.find((target) =>
      target.pluginId === 'official/agent-content-toolkit');
    const toolkitUserPlacement = toolkit?.placements.find((placement) => placement.scope === 'user');
    expect(toolkitUserPlacement, JSON.stringify(toolkit)).toMatchObject({ scope: 'user', state: 'ready' });
    expect(statusTargetIntent(toolkitUserPlacement!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'dependency',
    });
    expect(status.payload.targets.flatMap((target) => target.reasons)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'dependencyMissing' }),
        expect.objectContaining({ code: 'codexActivationDrift' }),
      ]),
    );

    expect(issues.flatMap((issue) => issue.actions)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/),
        pluginId: 'official/agent-content-toolkit', scope: 'project',
      })]),
    );
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
      upsertPluginActivations: { 'leaf@aw': projectEnabled },
    });

    const result = await (projectEnabled ? reinstallWriteCommand : syncWriteCommand)(['official/leaf'], {
      ...options, scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const project = await readCodexConfigFile(projectConfigPath);
    expect(project.snapshot.plugins['leaf@aw']?.enabled).toBe(projectEnabled);
    expect(project.snapshot.plugins['root@aw']?.enabled).toBe(true);
    const user = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
    expect(user.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
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
    const agentPath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-leaf-leaf-role.toml');
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
        action: 'reinstall', state: 'completed',
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/project-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await expect(fs.readFile(projectConfigPath, 'utf8')).resolves.toContain('leaf.');

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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      'aw-leaf-leaf-role.toml',
    );
    await writeOwnedTextFile({
      path: userAgentPath,
      allowedRoot: isolation.env.CODEX_HOME!,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/leaf',
        plugin: 'leaf',
        artifactKey: 'aw-leaf-leaf-role',
        platform: 'codex',
        scope: 'user',
      },
      content: 'name = "partial leaf role"\n',
    });
    const projectAgentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-leaf-role.toml',
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
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toContain('leaf.');
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
    expect(Object.values((await readCodexConfigFile(userConfig)).snapshot.developerInstructions.managedBlocks))
      .toContainEqual(expect.objectContaining({ value: expect.stringContaining('leaf.') }));
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
    const failingManagerResolver: NonNullable<
      RebuildCommandRuntime['codexManagerResolver']
    > = async (options) => {
      const listed = await options.runner({
        command: 'codex',
        args: ['plugin', 'list', '--marketplace', 'aw', '--json'],
        agentKind: 'codex',
        cwd: options.cwd,
        env: options.env,
      });
      expect(listed.exitCode).toBe(0);
      throw new Error('injected manager resolver failure');
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
      codexManagerResolver: failingManagerResolver,
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
        message: expect.stringContaining('injected manager resolver failure'),
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
      PATH: `${fakeCodexBin}${path.delimiter}${isolation.env.PATH ?? ''}`,
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    }, 1);
    const syncReceipt = parseIntentRoundTripReceipt(syncOutput);
    expect(syncReceipt.targetResults.find((target) =>
      target.target.pluginId === 'team/b')).toMatchObject({
      target: { pluginId: 'team/b', scope: 'user' },
    });
    expect(syncReceipt.targetResults.find((target) =>
      target.target.pluginId === 'team/independent')).toMatchObject({
      target: { pluginId: 'team/independent', scope: 'project' },
      state: 'completed',
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
      { ...runtime, codexManagerResolver: failingManagerResolver },
    );
    expect(overlapping.overallState).toBe('partial');
    expect(overlapping.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b', scope: 'user' }),
        errorCode: 'writeFailed', state: 'failed',
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
  }, 60_000);

  it('derives user dependency placement through independent CLI processes without saved overrides', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-round-trip-source');
    const dynamicRole = (roleKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = undefined;
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.agentRole',
        requiresCodexProjectConfig: true,
        states: ['present'],
        refreshKeys: [],
        roleKey,
      }] };
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
      PATH: `${fakeCodexBin}${path.delimiter}${isolation.env.PATH ?? ''}`,
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    };
    await runIntentRoundTripCliChild([
      'plugin', 'install', 'team/b', '--scope', 'user', '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    await runIntentRoundTripCliChild([
      'plugin', 'install',
      'team/a',
      '--scope',
      'project',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
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
    const roleNames = ['aw-b-b-role.toml', 'aw-c-c-role.toml'];
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
    await runIntentRoundTripCliChild([
      'plugin', 'sync',
      'team/a',
      '--context',
      'project',
      '--target',
      'codex',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
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

    await runIntentRoundTripCliChild([
      'plugin', 'remove',
      'team/a',
      '--scope',
      'project',
      '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [], dependencyScopeOverrides: [],
    });
    await expect(observeIntent(userLocation)).resolves.toEqual(userBefore);
    for (const name of roleNames) await expect(fs.pathExists(path.join(userRoleRoot, name))).resolves.toBe(true);
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
          instructions: [{ name: 'guide', title: 'Guide', content: 'Guide.' }],
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const agentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-demo-worker.toml',
    );
    await fs.remove(agentPath);

    const synced = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.codexReconcilePlans?.[0]?.extensionWrites).toEqual([
      expect.objectContaining({
        componentKey: 'extensions.agents:worker', scope: 'project', action: 'write',
      }),
    ]);
    expect(synced.codexReconcilePlans?.[0]?.extensionWrites).not.toContainEqual(
      expect.objectContaining({ componentKey: 'extensions.instructions:guide' }),
    );
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
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
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
      const result = await (command === 'uninstall' ? uninstallWriteCommand : cleanupWriteCommand)(
        ['team/leaf'], { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user' }, runtime);
      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.targetResults).toContainEqual(expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
        state: 'completed',
      }));
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const status = () => statusCommandV8({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    const leafAgent = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    const canonicalLeafAgent = await fs.realpath(leafAgent);
    const readFile = fs.readFile;
    const unreadableAgent = vi.spyOn(fs, 'readFile').mockImplementation((...args) => {
      if ([leafAgent, canonicalLeafAgent].includes(String(args[0]))) {
        return Promise.reject(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
      }
      return Reflect.apply(readFile, fs, args);
    });
    const driftedLeaf = await statusCommandV8({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    }).finally(() => unreadableAgent.mockRestore());
    expect(driftedLeaf.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      placements: [expect.objectContaining({
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'componentInspectionFailed', severity: 'blocking' }),
          expect.objectContaining({ code: 'codexExtensionDrift' }),
        ]),
        components: expect.arrayContaining([expect.objectContaining({
          key: 'aw-leaf-leaf-role',
          metadata: { errorCode: 'componentInspectionFailed' },
        })]),
      })],
    })]);
    expect(statusTargetExtensions(driftedLeaf.payload.targets[0]!.placements[0]!))
      .toMatchObject({ state: 'drifted' });
    await fs.remove(leafAgent);
    const missingLeaf = await statusCommandV8({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(missingLeaf.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
    })]);
    expect(statusTargetExtensions(missingLeaf.payload.targets[0]!.placements[0]!))
      .toMatchObject({ state: 'missing' });
    await expect(status()).resolves.toMatchObject({
      hasErrors: false,
      payload: { targets: [expect.objectContaining({
        state: 'needsSync',
        placements: [expect.objectContaining({
          scope: 'project',
          state: 'needsSync',
          components: expect.arrayContaining([expect.objectContaining({
            kind: 'dependency',
            key: 'team/leaf',
            state: 'absent',
            metadata: expect.objectContaining({
              rootIssueCode: 'dependencyMissing',
              rootIssueId: 'dependencyMissing:team/leaf:codex:project',
            }),
          })]),
        })],
        reasons: expect.arrayContaining([
          expect.objectContaining({
            code: 'dependencyMissing',
            dependencyPluginId: 'team/leaf',
            rootIssueCode: 'dependencyMissing',
            rootIssueId: 'dependencyMissing:team/leaf:codex:project',
          }),
        ]),
      })] },
    });
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
    expect(collisionStatus).toMatchObject({
      hasErrors: false,
      payload: { targets: [expect.objectContaining({
        placements: [expect.objectContaining({
          scope: 'project',
          components: expect.arrayContaining([expect.objectContaining({
            kind: 'dependency',
            key: 'team/leaf',
            state: 'blockedByCollision',
            metadata: expect.objectContaining({
              rootIssueCode: 'artifactCollision',
              rootIssueId: expect.stringContaining('artifactCollision:team/leaf:codex:project:'),
            }),
          })]),
        })],
        reasons: expect.arrayContaining([expect.objectContaining({
          code: 'dependencyNotReady',
          dependencyPluginId: 'team/leaf',
          rootIssueCode: 'artifactCollision',
        })]),
      })] },
    });
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const status = () => statusCommandV8({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready', reasons: [] })], errors: [] },
    });

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: [] },
    ]);
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready', reasons: [] })] },
    });
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
    const foreignRole = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-second-second-role.toml');
    await fs.outputFile(foreignRole, 'foreign');

    const result = await installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
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
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      })).resolves.toMatchObject({
        overallState: 'succeeded',
      });
    }
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');
  });
});
