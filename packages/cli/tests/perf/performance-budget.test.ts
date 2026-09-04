import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PluginMeta } from '../../src/types.js';
import { createRebuildIntegration } from '../../src/commands/rebuild-integration.js';
import {
  createCliExecutionContext,
  createCommandExecutionContext,
} from '../../src/commands/runtime.js';
import { loadConsoleItemsResult, statusCommandV7 } from '../../src/commands/status-v6.js';
import { installWriteCommand } from '../../src/commands/write-commands.js';
import type { CommandEvent } from '../../src/output/model.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
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
  SYSTEM_CODEX_MANAGER,
  setNativeCliRunnerOverrideForTests,
  type NativeCliInvocation,
} from '../../src/utils/native-cli.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import { createPerfSummary, printPerfSummary } from './perf-metrics.js';

const SAMPLES = 20;
const BUDGET_MS = 500;
const DIAGNOSTIC_COMMAND_BUDGET_MS = 5_000;
const execFileAsync = promisify(execFile);

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
  let fanoutProviderInvocations = 0;

  const fakeNativeRunner = async () => ({
    exitCode: 0,
    stdout: 'codex-cli 99.0.0',
    stderr: '',
  });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-multi-source-perf-'));
    sourceRoot = path.join(root, 'catalog');
    await createCatalogSnapshotFixture(sourceRoot);
    env = {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    };
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
        manifest.marketplace.policy.products = ['CODEX'];
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
          manifest.marketplace.policy.products = ['CODEX'];
          manifest.extensions = {
            instructions: [{ name: 'config-target', title: 'Config target', content: 'Config target.' }],
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
    fanoutEnv = {
      ...process.env,
      AW_HOME: path.join(root, 'fanout-aw-home'),
      AW_CODEX_HOME: path.join(root, 'fanout-codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'fanout-claude-home'),
    };
    await fs.outputJson(path.join(fanoutEnv.AW_HOME!, 'catalog-sources.json'), {
      schemaVersion: 2,
      sources: [
        {
          id: 'git-a',
          type: 'git',
          primary: true,
          url: gitRemote,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        },
        {
          id: 'git-b',
          type: 'git',
          primary: false,
          url: gitRemote,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        },
        { id: 'path-a', type: 'path', primary: false, path: firstPath },
        { id: 'path-b', type: 'path', primary: false, path: secondPath },
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
    const writeRuntime = {
      env: fanoutEnv,
      nativeCliRunner: fakeNativeRunner,
    };
    await installWriteCommand(['path-a/root'], {
      cwd: root, platform: 'codex', scope: 'project',
    }, writeRuntime);
    await installWriteCommand(['path-a/write-root'], {
      cwd: root, platform: 'codex', scope: 'project',
    }, writeRuntime);
    await installWriteCommand(['path-a/config-target'], {
      cwd: root, platform: 'codex', scope: 'project',
    }, writeRuntime);
    const leafAgent = path.join(root, '.codex', 'agents', 'aw-leaf-leaf-role.toml');
    await fs.remove(leafAgent);
    await fs.ensureDir(leafAgent);
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
    const plugin = await readPluginManifest(path.join(sourceRoot, 'plugins', 'demo'), {
      mode: 'bundle',
    });
    plugin.manifest.apps = './.app.json';
    await fs.outputJson(path.join(plugin.rootDir, '.app.json'), { apps: {} });
    const marketplaceRoot = path.join(env.AW_HOME!, 'marketplaces', 'local');
    const marketplaceName = 'aw-local';
    const configPath = path.join(env.AW_CODEX_HOME!, 'config.toml');
    const cacheRoot = path.join(
      env.AW_CODEX_HOME!,
      'plugins',
      'cache',
      marketplaceName,
      plugin.manifest.name,
      plugin.manifest.version,
    );
    let marketplaceAdded = false;
    let pluginAdded = false;
    const writeCodexConfig = async () => fs.outputFile(configPath, [
      ...(marketplaceAdded ? [
        `[marketplaces.${JSON.stringify(marketplaceName)}]`,
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ] : []),
      ...(pluginAdded ? [
        `[plugins.${JSON.stringify(`${plugin.manifest.name}@${marketplaceName}`)}]`,
        'enabled = true',
        '',
      ] : []),
    ].join('\n'));
    const nativeCliRunner = async (invocation: NativeCliInvocation) => {
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: pluginAdded ? [{
              pluginId: `${plugin.manifest.name}@${marketplaceName}`,
              installed: true,
              enabled: true,
              version: plugin.manifest.version,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
        marketplaceAdded = true;
        await writeCodexConfig();
      } else if (invocation.args[1] === 'add') {
        pluginAdded = true;
        await fs.copy(path.join(marketplaceRoot, 'plugins', plugin.manifest.name), cacheRoot);
        await fs.outputJson(path.join(cacheRoot, 'plugin.json'), {
          id: plugin.manifest.name,
          version: plugin.manifest.version,
        });
        await writeCodexConfig();
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const observationSession = await createCodexNativeObservationSession({
      exactCwd: root,
      env,
      runner: nativeCliRunner,
    });
    const context = {
      ...createCommandExecutionContext({ env, nativeCliRunner }),
      codexManager: SYSTEM_CODEX_MANAGER,
      codexObservationSession: observationSession,
    };
    const integration = createRebuildIntegration({ context });
    const target = await integration.buildTarget({
      sourceId: 'local',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginId: 'local/demo',
      marketplaceName,
      marketplaceRoot,
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: root,
      command: 'install',
      catalog: { rootDir: sourceRoot, source: 'local' },
    });
    try {
      await integration.prepareNativeMarketplaceGroup(target);
      await integration.driver.writeNative(target);
    } finally {
      await observationSession.dispose();
    }
    await expect(fs.pathExists(path.join(marketplaceRoot, 'config.json'))).resolves.toBe(true);

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
    const durations = await sample(async () => {
      const result = await statusCommandV7({
        cwd: root, env, cliVersion: '1.0.0', json: true,
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
    let providerInvocations = 0;
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
    expect(providerInvocations).toBe(0);
    const summary = createPerfSummary(
      'active-four-source-read-warm',
      durations,
      DIAGNOSTIC_COMMAND_BUDGET_MS,
    );
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(DIAGNOSTIC_COMMAND_BUDGET_MS);
  });

  it('keeps a large Active-only TUI load plus Review within the local budget', async () => {
    fanoutProviderInvocations = 0;
    const catalogStageDurations: number[] = [];
    const durations = await sample(async () => {
      const events: CommandEvent[] = [];
      const context = createCliExecutionContext({
        cwd: root,
        env: fanoutEnv,
        interactive: false,
        nativeCliRunner: fakeNativeRunner,
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
          scope: 'project',
          projectLayer: 'shared',
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
    fanoutProviderInvocations = 0;
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
        nativeCliRunner: fakeNativeRunner,
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
      expect(actionNames.has('artifacts.write')).toBe(true);
      expect(actionNames.has('postcheck.inspect')).toBe(true);
      if (record) {
        commandDurations.push(durationMs);
        localStageDurations.push(stageEvents.reduce((total, event) =>
          total + (typeof event.data?.durationMs === 'number' ? event.data.durationMs : 0), 0));
      }
    };
    await runInstall(false);
    for (let index = 0; index < 8; index += 1) await runInstall(true);
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
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
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
