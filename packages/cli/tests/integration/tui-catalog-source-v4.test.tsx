import path from 'node:path';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { ConsoleAppV4, type ConsoleV4ScreenId } from '../../src/tui/console-app-v4.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  createTuiControllerDependencies,
  setTuiControllerRuntimeTestHooksForTests,
} from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

afterEach(() => {
  setTuiControllerRuntimeTestHooksForTests(undefined);
  cleanup();
});

async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(check: () => boolean, label: string, diagnostic?: () => unknown): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(diagnostic?.())}`);
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
  }
}

async function confirmReview(
  instance: ReturnType<typeof render>,
  controller: TuiController,
): Promise<void> {
  await input(instance, '\r');
  await waitFor(
    () => controller.snapshot.result !== undefined,
    'operation result',
    () => controller.snapshot,
  );
  await nextTurn(3);
}

async function configuredController(): Promise<{
  controller: TuiController;
  firstRoot: string;
  secondRoot: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const firstRoot = path.join(isolation.layout.fixtureCwd, 'tui-source-one');
  const secondRoot = path.join(isolation.layout.fixtureCwd, 'tui-source-two');
  await Promise.all([
    createCatalogSnapshotFixture(firstRoot, 'one'),
    createCatalogSnapshotFixture(secondRoot, 'two'),
  ]);
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: firstRoot }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env });
  const context = createCliExecutionContext({
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
    interactive: false,
    nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    debugLogger: { log: async () => undefined },
  });
  const progress = createRebuildProgressFeed();
  return {
    controller: new TuiController(createTuiControllerDependencies(context, progress), progress),
    firstRoot,
    secondRoot,
  };
}

describe('TUI v4 real catalog source boundary', () => {
  it('loads a real Active local Git source without background network access', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const work = path.join(isolation.layout.fixtureCwd, 'tui-git-work');
    const remote = path.join(isolation.layout.fixtureCwd, 'tui-git-remote.git');
    await fs.ensureDir(work);
    await git(work, ['init', '--initial-branch=main']);
    await git(work, ['config', 'user.email', 'test@example.test']);
    await git(work, ['config', 'user.name', 'AW Test']);
    await createCatalogSnapshotFixture(path.join(work, 'catalog'));
    await git(work, ['add', '.']);
    await git(work, ['commit', '-m', 'catalog']);
    await git(path.dirname(work), ['clone', '--bare', work, remote]);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{
          id: 'git-local',
          type: 'git',
          primary: true,
          url: remote,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
          subdir: 'catalog',
        }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({ sourceId: 'git-local', cliVersion: '1.0.0', env: isolation.env });
    await fs.remove(remote);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      debugLogger: { log: async () => undefined },
    }));
    await dependencies.loadStatus(new AbortController().signal);
    const controller = new TuiController(dependencies);
    const observedHealth: string[] = [];
    controller.subscribe((snapshot) => {
      const state = snapshot.sourceHealth.find((health) => health.sourceId === 'git-local')?.state;
      if (state && observedHealth.at(-1) !== state) observedHealth.push(state);
    });

    await controller.load();
    expect(controller.getCatalogGeneration('git-local')?.active?.catalogVersion).toBe('1.0.0');
    expect(observedHealth).toEqual(['ready']);
    expect(controller.getPluginOverview('git-local/demo')).toMatchObject({ version: '1.0.0' });
    controller.dispose();
  });

  it('rejects a stale current-primary action before creating a Review or writing config', async () => {
    const { controller } = await configuredController();
    await controller.load();
    const before = await readCatalogSourcesConfigSnapshot(getCurrentSourceTestIsolation().env);

    await expect(controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'setPrimary',
      sourceId: 'local',
    })).rejects.toMatchObject({ code: 'sourceNoChanges' });

    expect(controller.snapshot.activeReview).toBeUndefined();
    expect((await readCatalogSourcesConfigSnapshot(getCurrentSourceTestIsolation().env)).digest)
      .toBe(before.digest);
    controller.dispose();
  });

  it('keeps a real path source available from Active after its workspace directory is removed', async () => {
    const { controller, firstRoot } = await configuredController();
    await controller.load();
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'local', state: 'ready' });

    await fs.remove(firstRoot);
    await controller.reloadCatalog({ sourceId: 'local' });

    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'local', state: 'ready' });
    const issue = controller.listUserIssues().find((entry) => entry.sourceId === 'local');
    expect(issue).toBeUndefined();
    controller.dispose();
  });

  it('completes real path add, update, primary changes, and safe remove through Ink keys', async () => {
    const { controller, secondRoot } = await configuredController();
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={controller}
      size={{ columns: 60, rows: 18 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'initial TUI status', () => controller.snapshot);

    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\r', '\u001B[B', '\r');
    await input(instance, 'team', '\r', secondRoot, '\r');
    await waitFor(() => controller.snapshot.activeReview !== undefined, 'add Review');
    await nextTurn(2);
    expect(controller.snapshot.activeReview).toMatchObject({
      operationKind: 'sourceMutation',
      sourceAction: 'add',
    });
    expect(instance.lastFrame()).toContain('保存来源');
    expect(JSON.stringify(controller.snapshot)).not.toContain(secondRoot);
    await confirmReview(instance, controller);
    expect(screens, JSON.stringify(controller.snapshot)).toContain('S12');
    expect((await readCatalogSourcesConfigSnapshot(getCurrentSourceTestIsolation().env)).config.sources)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'team', type: 'path' })]));

    await input(instance, '\r', '\u001B[B', '\r', '\u001B[B', '\r', '\r');
    await input(instance, getCurrentSourceTestIsolation().layout.fixtureCwd + '/tui-source-one', '\r');
    await waitFor(() => controller.snapshot.activeReview?.sourceAction === 'update', 'update Review', () => controller.snapshot);
    await nextTurn(2);
    expect(screens).toContain('S15');
    expect(instance.lastFrame()).toContain('保存来源');
    await confirmReview(instance, controller);

    await input(instance, '\r', '\u001B[B', '\r', '\u001B[B', '\u001B[B', '\r');
    await waitFor(() => controller.snapshot.activeReview?.sourceAction === 'setPrimary', 'team primary Review', () => controller.snapshot);
    await nextTurn(2);
    expect(screens).toContain('S16');
    expect(instance.lastFrame()).toContain('设为主来源');
    await confirmReview(instance, controller);
    expect((await readCatalogSourcesConfigSnapshot(getCurrentSourceTestIsolation().env)).config.sources
      .find((source) => source.id === 'team')?.primary).toBe(true);

    await input(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\r');
    await waitFor(() => controller.snapshot.activeReview?.sourceAction === 'setPrimary', 'local primary Review', () => controller.snapshot);
    await confirmReview(instance, controller);
    expect((await readCatalogSourcesConfigSnapshot(getCurrentSourceTestIsolation().env)).config.sources
      .find((source) => source.id === 'local')?.primary).toBe(true);

    await input(instance, '\r', '\u001B[B', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await waitFor(() => controller.snapshot.activeReview?.sourceAction === 'remove', 'remove Review', () => controller.snapshot);
    await nextTurn(2);
    expect(screens).toContain('S18');
    expect(instance.lastFrame()).toContain('移除来源');
    await confirmReview(instance, controller);
    const final = await readCatalogSourcesConfigSnapshot(getCurrentSourceTestIsolation().env);
    expect(final.config.sources.map((source) => source.id)).toEqual(['local']);
    expect(controller.listSources().map((source) => source.id)).toEqual(['local']);
    expect(controller.snapshot.sourceHealth.map((health) => health.sourceId)).toEqual(['local']);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    controller.dispose();
  });

  it('removes a source through the real TUI despite live references and inventory errors', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, firstRoot, secondRoot } = await configuredController();
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'local', type: 'path', primary: true, path: firstRoot },
          { id: 'team', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await fs.outputJson(path.join(isolation.env.AW_HOME!, 'plugin-config', 'team', 'two', 'config.json'), {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity: `sha256:${'3'.repeat(64)}`,
      pluginName: 'two',
      values: {},
    });
    await fs.outputFile(
      path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json'),
      '{ invalid json\n',
    );
    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      includeHistoricalProjects: true,
    });
    expect(inventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedConfig', sourceId: 'team', pluginName: 'two',
    }));
    expect(inventory.errors.length).toBeGreaterThan(0);

    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={controller}
      size={{ columns: 60, rows: 18 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'initial TUI status', () => controller.snapshot);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await waitFor(() => controller.snapshot.activeReview?.sourceAction === 'remove', 'remove Review', () => controller.snapshot);
    await nextTurn(2);
    expect(screens).toContain('S18');
    expect(controller.snapshot.router.current.route.name).not.toBe('sourceRemoveBlocked');
    await confirmReview(instance, controller);
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources.map((source) => source.id))
      .toEqual(['local']);
    controller.dispose();
  });

  it('projects real add and update boundaries while mounted on S11', async () => {
    const { controller, firstRoot, secondRoot } = await configuredController();
    const phases: string[] = [];
    let pending: {
      key: string;
      release: () => void;
    } | undefined;
    setTuiControllerRuntimeTestHooksForTests({
      onCatalogSourceProgress: async (event) => {
        const key = `${event.action}:${event.stage}`;
        await new Promise<void>((resolve) => {
          pending = { key, release: resolve };
        });
        pending = undefined;
      },
    });
    controller.subscribe((snapshot) => {
      const phase = snapshot.progress.current?.phase;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
    });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'initial TUI status', () => controller.snapshot);

    const runWithBarriers = async (
      action: 'add' | 'update',
      reviewToken: string,
    ): Promise<void> => {
      const execution = controller.executeOperation(reviewToken);
      const expectedStages = ['savingConfig'] as const;
      for (const stage of expectedStages) {
        const key = `${action}:${stage}`;
        await waitFor(() => pending?.key === key, key, () => ({ pending: pending?.key, snapshot: controller.snapshot }));
        expect(controller.snapshot.router.current.route.name).toBe('progress');
        expect(instance.lastFrame()).toContain('保存来源配置');
        pending!.release();
      }
      await execution;
      expect(controller.snapshot.result?.state).toBe('succeeded');
    };

    const addReview = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'team',
      source: { id: 'team', type: 'path', primary: false, path: secondRoot },
    });
    await runWithBarriers('add', addReview.reviewToken);
    const updateReview = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'update',
      sourceId: 'team',
      update: { type: 'path', path: firstRoot },
    });
    await runWithBarriers('update', updateReview.reviewToken);

    expect(phases).toContain('读取最终状态');
    expect(JSON.stringify(controller.snapshot)).not.toContain(firstRoot);
    expect(JSON.stringify(controller.snapshot)).not.toContain(secondRoot);
    controller.dispose();
  });

  it('shows a committed source config without attempting a sync on S12', async () => {
    const { controller } = await configuredController();
    const isolation = getCurrentSourceTestIsolation();
    const invalidRoot = path.join(isolation.layout.fixtureCwd, 'not-a-catalog');
    await fs.ensureDir(invalidRoot);
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={controller}
      size={{ columns: 60, rows: 18 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'initial TUI status', () => controller.snapshot);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\r', '\u001B[B', '\r');
    await input(instance, 'broken', '\r', invalidRoot, '\r');
    await waitFor(() => controller.snapshot.activeReview !== undefined, 'invalid source Review');
    await confirmReview(instance, controller);

    expect(screens).toContain('S12');
    expect(controller.snapshot.result).toMatchObject({
      state: 'succeeded',
      operationKind: 'sourceMutation',
      sourceAction: 'add',
      summary: { messages: expect.arrayContaining([expect.stringContaining('保存来源配置')]) },
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain(invalidRoot);
    expect(instance.lastFrame()).toContain('来源配置写入已完成');
    expect(instance.lastFrame()).not.toContain('刷新 Catalog 缓存');
    controller.dispose();
  });

  it('rebuilds the typed Review with zero requested writes after a real config race', async () => {
    const { controller, secondRoot } = await configuredController();
    const isolation = getCurrentSourceTestIsolation();
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'initial TUI status', () => controller.snapshot);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\r', '\u001B[B', '\r');
    await input(instance, 'requested', '\r', secondRoot, '\r');
    await waitFor(() => controller.snapshot.activeReview?.sourceAction === 'add', 'add Review');
    const concurrent = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        ...concurrent.config,
        sources: [...concurrent.config.sources, {
          id: 'concurrent',
          type: 'path',
          primary: false,
          path: secondRoot,
        }],
      },
      expectedDigest: concurrent.digest,
      env: isolation.env,
    });

    await confirmReview(instance, controller);

    expect(controller.snapshot.result).toMatchObject({
      state: 'stale',
      operationKind: 'sourceMutation',
      sourceAction: 'add',
      review: {
        operationKind: 'sourceMutation',
        sourceAction: 'add',
      },
    });
    const after = await readCatalogSourcesConfigSnapshot(isolation.env);
    expect(after.config.sources.map((source) => source.id).sort()).toEqual(['concurrent', 'local']);
    controller.dispose();
  });
});
