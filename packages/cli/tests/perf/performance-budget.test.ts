import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginMeta } from '../../src/types.js';
import { writePreferences } from '../../src/intent/deployment-preferences.js';
import { createEmptyIntent } from '../../src/intent/intent-codec.js';
import { writeIntent } from '../../src/intent/intent-store.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { loadConsoleItemsResult, statusCommandV8 } from '../../src/commands/status-v6.js';
import { installWriteCommand } from '../../src/commands/write-commands.js';
import type { CommandEvent } from '../../src/output/model.js';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import {
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
} from '../../src/utils/multi-source-catalog.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import {
  syncCatalogSourceGeneration,
} from '../../src/utils/catalog-generation-service.js';
import {
  NativeCliError,
  setNativeCliRunnerOverrideForTests,
  type NativeCliRunner,
} from '../../src/utils/native-cli.js';
import {
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import {
  createNativeTestExecution,
  getNativeTestLayout,
  installNativeTestQualification,
} from '../helpers/native-execution-fixture.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';
import { createPerfSummary, printPerfSummary } from './perf-metrics.js';

const SAMPLES = 20;
const BUDGET_MS = 500;
const DIAGNOSTIC_COMMAND_BUDGET_MS = 5_000;
const execFileAsync = promisify(execFile);
const syntheticProcessPath = fileURLToPath(
  new URL('../../../../scripts/test/synthetic-process.mjs', import.meta.url),
);

async function sample(operation: () => Promise<void>, samples = SAMPLES): Promise<number[]> {
  await operation();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

describe('multi-source performance budgets', () => {
  let root: string;
  let sourceRoot: string;
  let env: NodeJS.ProcessEnv;
  let fanoutEnv: NodeJS.ProcessEnv;
  let nativeCliRunner: NativeCliRunner;
  let fanoutNativeCliRunner: NativeCliRunner;
  let fanoutProviderInvocations = 0;
  let providerObservers: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-multi-source-perf-')));
    await fs.ensureDir(path.join(root, '.git'));
    sourceRoot = path.join(root, 'catalog');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => { manifest.platforms = ['codex']; },
    }]);
    env = (await createIsolatedTestEnv({ rootDir: path.join(root, 'local-isolation') })).env;
    ({ nativeCliRunner } = await createCodexNativeTestRuntime({ env, layout: { fixtureCwd: root } }));
    await fs.outputJson(path.join(env.AW_HOME!, 'catalog-sources.json'), {
      schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
    });
    await syncCatalogSourceGeneration({
      sourceId: 'local',
      cliVersion: '1.0.0',
      env,
      impactConfirmed: true,
    });

    const gitWork = path.join(root, 'git-work');
    const gitRemote = path.join(root, 'catalog.git');
    const firstPath = path.join(root, 'catalog-path-a');
    const secondPath = path.join(root, 'catalog-path-b');
    const agentPlugin = (name: string) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          agents: [{ name: `${name}-role`, description: `${name} role.`, prompt: `${name}.` }],
        };
      },
    });
    await createDependencyCatalogSnapshotFixture(gitWork, [
      agentPlugin('leaf'),
      { ...agentPlugin('root'), dependencies: ['leaf'] },
      { name: 'write-leaf' },
      { name: 'write-root', dependencies: ['write-leaf'] },
      {
        name: 'config-target',
        configureManifest: (manifest) => {
          manifest.platforms = ['codex'];
          manifest.extensions = {
            instructions: [{ name: 'config-target', title: 'Config target', content: 'Config target.', coverage: ['main'] }],
          };
          manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
        },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `bulk-${String(index).padStart(2, '0')}`,
      })),
    ]);
    await Promise.all([
      fs.copy(gitWork, firstPath),
      fs.copy(gitWork, secondPath),
    ]);
    await execFileAsync('git', ['init', '--initial-branch=main', '--quiet'], { cwd: gitWork });
    await execFileAsync('git', ['config', 'user.email', 'perf@example.test'], { cwd: gitWork });
    await execFileAsync('git', ['config', 'user.name', 'AW Perf'], { cwd: gitWork });
    await execFileAsync('git', ['add', '.'], { cwd: gitWork });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'catalog'], { cwd: gitWork });
    await execFileAsync('git', ['clone', '--bare', '--quiet', gitWork, gitRemote]);
    fanoutEnv = (await createIsolatedTestEnv({ rootDir: path.join(root, 'fanout-isolation') })).env;
    ({ nativeCliRunner: fanoutNativeCliRunner } = await createCodexNativeTestRuntime({
      env: fanoutEnv, layout: { fixtureCwd: root },
    }));
    // Active-only budgets exclude the TUI's separate background freshness probes.
    await fs.outputJson(path.join(fanoutEnv.AW_HOME!, 'catalog-sources.json'), {
      schemaVersion: 2,
      sources: [
        {
          id: 'git-a',
          type: 'git',
          primary: true,
          autoCheck: false,
          url: gitRemote,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        },
        {
          id: 'git-b',
          type: 'git',
          primary: false,
          autoCheck: false,
          url: gitRemote,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        },
        { id: 'path-a', type: 'path', primary: false, autoCheck: false, path: firstPath },
        { id: 'path-b', type: 'path', primary: false, autoCheck: false, path: secondPath },
      ],
    });
    for (const sourceId of ['git-a', 'git-b', 'path-a', 'path-b']) {
      await syncCatalogSourceGeneration({
        sourceId,
        cliVersion: '1.0.0',
        env: fanoutEnv,
        impactConfirmed: true,
      });
    }
    for (const fixtureEnv of [env, fanoutEnv]) {
      await writePreferences({ scope: 'user', cwd: root, env: fixtureEnv }, {
        schemaVersion: 2, kind: 'aw-deployment-preferences', targets: ['codex'], exclusions: [],
      });
    }
  });

  beforeEach(() => {
    installNativeTestQualification({ discovery: true });
    const gitResolve = catalogGitProviderInternal.resolve;
    const pathResolve = catalogPathProviderInternal.resolve;
    fanoutProviderInvocations = 0;
    providerObservers = [
      vi.spyOn(catalogGitProviderInternal, 'resolve').mockImplementation((...args) => {
        fanoutProviderInvocations += 1;
        return gitResolve(...args);
      }),
      vi.spyOn(catalogPathProviderInternal, 'resolve').mockImplementation((...args) => {
        fanoutProviderInvocations += 1;
        return pathResolve(...args);
      }),
    ];
  });

  afterEach(() => {
    for (const observer of providerObservers) observer.mockRestore();
    setNativeCliRunnerOverrideForTests(null);
  });

  afterAll(async () => {
    setNativeCliRunnerOverrideForTests(null);
    await fs.remove(root);
  });

  it('keeps warm path source resolution within budget', async () => {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    const durations = await sample(async () => {
      await withResolvedMultiSourceCatalog({
        cliVersion: '1.0.0', configSnapshot, env,
        consume: (catalog) => { expect(catalog.sources[0]?.resolution).toBeDefined(); },
      });
    });
    const summary = createPerfSummary('path-source-resolution-warm', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps repeated Active path validation within budget', async () => {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    const durations = await sample(async () => {
      await withResolvedMultiSourceCatalog({
        cliVersion: '1.0.0', configSnapshot, env,
        consume: () => undefined,
      });
    });
    const summary = createPerfSummary('path-source-force-validation', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps the first source read after a namespaced marketplace rebuild within budget', async () => {
    const installed = await runRecovery('install', ['local/demo'], {
      cwd: root, env, targets: ['codex'], scope: 'user', context: 'user', cliVersion: '1.0.0', yes: true,
    }, { env, nativeCliRunner });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const layout = await getNativeTestLayout({
      platform: 'codex', sourceId: 'local', pluginId: 'local/demo', scope: 'user', cwd: root, env,
    });
    await expect(fs.pathExists(path.join(layout.marketplaceRoot!, 'config.json'))).resolves.toBe(true);

    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    const startedAt = performance.now();
    await withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0', configSnapshot, env,
      consume: () => undefined,
    });
    const summary = createPerfSummary(
      'path-source-after-marketplace-rebuild',
      [performance.now() - startedAt],
      BUDGET_MS,
    );
    printPerfSummary(summary);
    expect(summary.maxMs).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps warm multi-source status and console loading within budget', async () => {
    setNativeCliRunnerOverrideForTests(nativeCliRunner);
    const durations = await sample(async () => {
      const result = await statusCommandV8({
        cwd: root, env, cliVersion: '1.0.0', json: true, nativeCliRunner,
      });
      const consoleResult = await loadConsoleItemsResult({ cwd: root }, { env });
      expect(result.payload.catalog.sources[0]?.id).toBe('local');
      expect(consoleResult.items[0]?.pluginName).toBe('local/demo');
    });
    const summary = createPerfSummary(
      'multi-source-status-console-warm',
      durations,
      DIAGNOSTIC_COMMAND_BUDGET_MS,
    );
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(DIAGNOSTIC_COMMAND_BUDGET_MS);
  });

  it('keeps source config reads within budget', async () => {
    const durations = await sample(async () => {
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      expect(snapshot.config.sources[0]?.id).toBe('local');
    });
    const summary = createPerfSummary('catalog-source-config-warm', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps a qualified selector on a warm current Git snapshot within budget', async () => {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(fanoutEnv);
    const durations = await sample(async () => {
      const selected = await withResolvedCatalogPlugin({
        cliVersion: '1.0.0',
        configSnapshot,
        env: fanoutEnv,
        selector: 'git-a/root',
        consume: ({ pluginId }) => pluginId,
      });
      expect(selected).toBe('git-a/root');
    });
    const summary = createPerfSummary('git-source-current-snapshot-warm', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('reads four Active sources without invoking a provider', async () => {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(fanoutEnv);
    fanoutProviderInvocations = 0;
    const durations = await sample(async () => {
      await withResolvedMultiSourceCatalog({
        cliVersion: '1.0.0',
        configSnapshot,
        env: fanoutEnv,
        consume: (catalog) => {
          expect(catalog.sources).toHaveLength(4);
        },
      });
    });
    expect(fanoutProviderInvocations).toBe(0);
    const summary = createPerfSummary(
      'active-four-source-read-warm',
      durations,
      DIAGNOSTIC_COMMAND_BUDGET_MS,
    );
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(DIAGNOSTIC_COMMAND_BUDGET_MS);
  });

  it('keeps a large Active-only TUI load plus Review within the local budget', async () => {
    const installed = await runRecovery('install', [
      'path-a/root', 'path-a/write-root', 'path-a/config-target',
    ], { cwd: root, env: fanoutEnv, targets: ['codex'], scope: 'project', context: 'project',
      cliVersion: '1.0.0', yes: true }, {
      env: fanoutEnv, nativeCliRunner: fanoutNativeCliRunner,
    });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const leafLayout = await getNativeTestLayout({
      platform: 'codex', sourceId: 'path-a', pluginId: 'path-a/leaf', cwd: root, env: fanoutEnv,
    });
    const leafAgent = path.join(leafLayout.supplementRoot!, 'aw-path-a-leaf-leaf-role.toml');
    await expect(fs.pathExists(leafAgent)).resolves.toBe(true);
    await fs.remove(leafAgent);
    await fs.ensureDir(leafAgent);
    fanoutProviderInvocations = 0;
    const catalogStageDurations: number[] = [];
    const durations = await sample(async () => {
      const events: CommandEvent[] = [];
      const context = createCliExecutionContext({
        cwd: root,
        env: fanoutEnv,
        interactive: false,
        nativeCliRunner: fanoutNativeCliRunner,
        debugLogger: { log: (event) => { events.push(event); } },
      });
      const controller = new TuiController(createTuiControllerDependencies(context));
      try {
        await controller.load();
        expect(controller.snapshot.phase).toBe('ready');
        await controller.buildOperationReview({
          kind: 'configSave',
          apply: false,
          pluginId: 'path-a/config-target',
          scope: 'user',
          context: 'project',
          updates: { mode: 'strict' },
        });
      } finally {
        controller.dispose();
      }
      const contextStages = events.filter((event) =>
        event.type === 'performance:stage' && event.data?.name === 'catalog.load');
      const validationStages = events.filter((event) =>
        event.type === 'performance:stage' && event.data?.name === 'catalog.validation');
      expect(contextStages).toHaveLength(1);
      expect(contextStages[0]?.data).toMatchObject({ sourceCount: 4 });
      expect(validationStages).toHaveLength(1);
      expect(validationStages[0]?.data).toMatchObject({
        pointerCount: 4,
        fullValidationCount: 0,
        reusedValidationCount: 4,
      });
      catalogStageDurations.push([...contextStages, ...validationStages].reduce(
        (total, event) => total
          + (typeof event.data?.durationMs === 'number' ? event.data.durationMs : 0),
        0,
      ));
      expect(events.some((event) => event.type === 'review.prepare.config')).toBe(true);
      expect(events.some((event) => event.type === 'review.prepare.evidence')).toBe(true);
    }, 8);
    expect(fanoutProviderInvocations).toBe(0);
    const summary = createPerfSummary(
      'tui-review-preparation-warm-large',
      durations,
      DIAGNOSTIC_COMMAND_BUDGET_MS,
    );
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(DIAGNOSTIC_COMMAND_BUDGET_MS);
    const catalogSummary = createPerfSummary(
      'tui-catalog-local-stages-warm',
      catalogStageDurations.slice(1),
      BUDGET_MS,
    );
    printPerfSummary(catalogSummary);
    expect(catalogSummary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps a real warm install path observable with local stage budgets', async () => {
    const installed = await runRecovery('install', ['path-a/write-root'], {
      cwd: root, env: fanoutEnv, targets: ['codex'], scope: 'project', context: 'project',
      cliVersion: '1.0.0', yes: true,
    }, { env: fanoutEnv, nativeCliRunner: fanoutNativeCliRunner });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    fanoutProviderInvocations = 0;
    const native = await createNativeTestExecution({ scope: 'project', cwd: root, env: fanoutEnv,
      selectedTargets: [{ pluginId: 'path-a/write-root', platform: 'codex' }],
      includeSelectedInDemand: true });
    const commandDurations: number[] = [];
    const localStageDurations: number[] = [];
    const runInstall = async (record: boolean): Promise<void> => {
      const events: CommandEvent[] = [];
      const startedAt = performance.now();
      const result = await installWriteCommand(['path-a/write-root'], {
        cwd: root,
        platform: 'codex',
        scope: 'project',
      }, {
        env: fanoutEnv,
        executionInput: native.executionInput,
        nativeCliRunner: fanoutNativeCliRunner,
        debugLogger: { log: (event) => { events.push(event); } },
      });
      const durationMs = performance.now() - startedAt;
      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      const stageEvents = events.filter((event) => event.type === 'performance:stage');
      expect(new Set(stageEvents.map((event) => event.data?.name))).toEqual(new Set([
        'catalog.load',
        'catalog.validation',
        'inventory',
        'dependency.plan',
        'target.build',
      ]));
      const actionNames = new Set(events.flatMap((event) =>
        event.type === 'rebuild:action'
        && event.data?.phase === 'success'
        && typeof event.data.name === 'string'
          ? [event.data.name]
          : []));
      expect(actionNames.has('preflight.inspect')).toBe(true);
      const rebuilt = result.rebuildResults.filter((entry) => entry.target.pluginId === 'path-a/write-root'
        && entry.target.platform === 'codex' && entry.target.scope === 'project');
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]!.deploymentReceipts).toHaveLength(1);
      expect(rebuilt[0]!.deploymentReceipts![0]).toMatchObject({
        unmet: [],
        after: {
          package: 'present', registration: 'present', ownership: 'aw',
          nativeIdentity: { route: 'codex-marketplace', packageId: 'write-root' },
          consumers: [expect.objectContaining({ activation: 'enabled' })],
        },
      });
      if (record) {
        commandDurations.push(durationMs);
        localStageDurations.push(stageEvents.reduce((total, event) =>
          total + (typeof event.data?.durationMs === 'number' ? event.data.durationMs : 0), 0));
      }
    };
    try {
      await runInstall(false);
      for (let index = 0; index < 8; index += 1) await runInstall(true);
    } finally {
      await native.dispose();
    }
    expect(fanoutProviderInvocations).toBe(0);
    const commandSummary = createPerfSummary(
      'install-write-command-warm',
      commandDurations,
      DIAGNOSTIC_COMMAND_BUDGET_MS,
    );
    printPerfSummary(commandSummary);
    const localSummary = createPerfSummary(
      'install-local-stages-warm',
      localStageDurations,
      BUDGET_MS,
    );
    printPerfSummary(localSummary);
    expect(localSummary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('bounds Active Catalog tree reads in warm generic TUI install preparation', async () => {
    // Selecting more same-source roots must not multiply full Catalog reads, and
    // confirming the Review must still read the current Active tree under the lock.
    const catalog = path.join(root, 'tui-generic-catalog');
    const sourceId = 'local';
    const shared = 'shared-skill';
    const savedRoot = 'saved-root';
    const roots = ['first-root', 'second-root', 'third-root'];
    const plugins = [shared, savedRoot, ...roots];
    const skillText = (name: string) => `---\nname: ${name}\ndescription: Use ${name}.\n---\nFixture for ${name}.\n`;
    await Promise.all(plugins.flatMap((name) => {
      const skill = path.join(catalog, 'plugins', name, 'skills', name);
      return [fs.outputFile(path.join(skill, 'SKILL.md'), skillText(name)),
        fs.outputFile(path.join(skill, 'README.md'), `Use ${name}.\n`)];
    }));
    await createDependencyCatalogSnapshotFixture(catalog, plugins.map((name) => ({
      name,
      dependencies: name === shared ? [] : [shared],
      configureManifest: (manifest) => {
        manifest.platforms = ['generic'];
        manifest.skills = './skills';
        delete manifest.extensions;
      },
    })));

    const cases = [];
    for (const selected of [roots.slice(0, 1), roots]) {
      const { env, layout } = await createIsolatedTestEnv({
        rootDir: path.join(root, `tui-generic-${selected.length}`),
      });
      const cwd = layout.fixtureCwd;
      await fs.ensureDir(path.join(cwd, '.git'));
      await fs.outputJson(path.join(layout.awHomeDir, 'catalog-sources.json'), {
        schemaVersion: 2,
        sources: [{ id: sourceId, type: 'path', primary: true, autoCheck: false, path: catalog }],
      });
      const { active } = await syncCatalogSourceGeneration({
        sourceId, cliVersion: '1.0.0', cwd, env, impactConfirmed: true,
      });
      if (!active) throw new Error('Expected an Active Catalog snapshot');
      await writePreferences({ scope: 'user', cwd, env }, {
        schemaVersion: 2, kind: 'aw-deployment-preferences', targets: ['generic'], exclusions: [],
      });
      await writeIntent({ scope: 'user', cwd, env }, {
        ...createEmptyIntent(),
        sources: { [sourceId]: { logicalIdentity: active.logicalIdentity } },
        roots: [{ pluginId: `${sourceId}/${savedRoot}` }],
      });

      const { snapshotRoot } = resolveCatalogStoreLocation({
        logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
      });
      // The tree digest reads this snapshot-wide file's bytes. Marketplace JSON
      // parsing uses readJson, and individual plugin reads never touch this path.
      const treeDigestProbe = path.join(snapshotRoot, '.agents', 'plugins', 'marketplace.json');
      const readFile = vi.spyOn(fs, 'readFile');
      const treeReads = () => readFile.mock.calls.filter(([file]) => file === treeDigestProbe).length;
      let lockedStart: number | undefined;
      let lockedPreparation: number | undefined;
      let statusStart: number | undefined;
      let finalStatus: number | undefined;
      const nativeCliRunner = vi.fn<NativeCliRunner>(async () => { throw new Error('Unexpected native CLI call'); });
      const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
        cwd, env, interactive: false, nativeCliRunner,
        debugLogger: { log: (event) => {
          if (event.type !== 'performance:stage') return;
          const { name, phase } = event.data ?? {};
          if (name === 'recovery.locked.demand' && phase === 'start') lockedStart = treeReads();
          if (name === 'recovery.locked.recheck' && phase === 'success' && lockedStart !== undefined) {
            lockedPreparation = treeReads() - lockedStart;
          }
          if (name === 'recovery.status' && phase === 'start') statusStart = treeReads();
          if (name === 'recovery.status' && phase === 'success' && statusStart !== undefined) {
            finalStatus = treeReads() - statusStart;
          }
        } },
      })));
      try {
        fanoutProviderInvocations = 0;
        const selectors = selected.map((name) => `${sourceId}/${name}`);
        const request = { kind: 'recovery', command: 'install', scope: 'project', selectors } as const;
        // Prime only temporary materializations. Staging each new generation
        // has its own validation before commit, so report this Review separately.
        await controller.discardScopedPlan(await controller.prepareScopedTask(request));
        const materializingReview = treeReads();
        await expect(fs.pathExists(path.join(cwd, '.agents', 'skills'))).resolves.toBe(false);
        await expect(fs.pathExists(path.join(layout.homeDir, '.agents', 'skills'))).resolves.toBe(false);
        const review = await controller.prepareScopedTask(request);
        const afterReview = treeReads();
        const result = await controller.executeScopedTask(review);
        cases.push({
          roots: selected.length,
          materializingReview,
          review: afterReview - materializingReview,
          lockedPreparation,
          finalStatus,
          execution: treeReads() - afterReview,
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          kind: 'recovery', receipt: { ok: true, declarationChanged: true, intent: { roots: selectors },
            allSatisfied: false, inSync: false, coverage: { scopes: ['user', 'project'] }, remainingTargets: [] },
        });
        expect(fanoutProviderInvocations).toBe(0);
        expect(nativeCliRunner).not.toHaveBeenCalled();
        const outputs = [[layout.homeDir, shared] as const, ...selected.map((name) => [cwd, name] as const)];
        for (const [directory, name] of outputs) {
          await expect(fs.readFile(path.join(directory, '.agents', 'skills', name, 'SKILL.md'), 'utf8'))
            .resolves.toContain(`Fixture for ${name}.`);
        }
      } finally {
        readFile.mockRestore();
        controller.dispose();
      }
    }

    const budget = { review: 1, lockedPreparation: 1, finalStatus: 1 };
    const summary = { name: 'tui-install-active-tree-reads-warm', budget, cases };
    printPerfSummary(summary);
    for (const result of cases) expect(result).toMatchObject(budget);
  });

  it('fans out remote work only through explicit sync', async () => {
    let active = 0;
    let maximumActive = 0;
    const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        return await operation();
      } finally {
        active -= 1;
      }
    };
    const providers = {
      git: (source: Parameters<typeof catalogGitProviderInternal.resolve>[0], options: Parameters<typeof catalogGitProviderInternal.resolve>[1]) =>
        observe(() => catalogGitProviderInternal.resolve(source, options)),
      path: (source: Parameters<typeof catalogPathProviderInternal.resolve>[0], options: Parameters<typeof catalogPathProviderInternal.resolve>[1]) =>
        observe(() => catalogPathProviderInternal.resolve(source, options)),
    };

    await Promise.all(['git-a', 'git-b', 'path-a', 'path-b'].map((sourceId) =>
      syncCatalogSourceGeneration({
        sourceId,
        cliVersion: '1.0.0',
        env: fanoutEnv,
        impactConfirmed: true,
        runtime: { providers },
      })));

    expect(maximumActive).toBe(4);
  });

  it('fails a local remote deadline within budget and confirms process cleanup', async () => {
    let pid = 0;
    setNativeCliRunnerOverrideForTests((invocation) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [syntheticProcessPath], {
        env: invocation.env,
        stdio: 'ignore',
      });
      pid = child.pid ?? 0;
      const abort = () => child.kill('SIGKILL');
      invocation.signal?.addEventListener('abort', abort, { once: true });
      child.once('exit', (code) => {
        invocation.signal?.removeEventListener('abort', abort);
        if (invocation.signal?.aborted) {
          reject(new NativeCliError({
            invocation,
            exitCode: 1,
            stdout: '',
            stderr: '',
            cause: invocation.signal.reason,
            reason: 'aborted',
          }));
          return;
        }
        resolve({ exitCode: code ?? 1, stdout: '', stderr: '' });
      });
    }));
    const deadlineEnv = {
      ...fanoutEnv,
      AW_HOME: path.join(root, 'deadline-aw-home'),
      AW_CATALOG_REMOTE_TIMEOUT_MS: '100',
    };
    const startedAt = performance.now();
    let failure: Error;
    try {
      failure = await catalogGitProviderInternal.resolve({
        id: 'deadline',
        type: 'git',
        primary: true,
        url: path.join(root, 'deadline-remote.git'),
        refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
      }, {
        cliVersion: '1.0.0',
        env: deadlineEnv,
      }).then(
        () => new Error('Expected the remote deadline to fail.'),
        (error: unknown) => error as Error,
      );
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
    const elapsedMs = performance.now() - startedAt;
    expect(failure.message).toContain('AW_CATALOG_REMOTE_TIMEOUT_MS=100');
    expect(pid).toBeGreaterThan(0);
    const deadline = performance.now() + BUDGET_MS;
    let alive = true;
    while (alive && performance.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    const summary = createPerfSummary('git-source-remote-deadline-cleanup', [elapsedMs], BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.maxMs).toBeLessThanOrEqual(BUDGET_MS);
  });
});
