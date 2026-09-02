import crypto from 'node:crypto';
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
import {
  probeCatalogSourceGeneration,
  syncCatalogSourceGeneration,
} from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import {
  createCatalogStoreKey,
  resolveCatalogStoreLocation,
} from '../../src/utils/catalog-generation-store.js';
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

async function configuredController(logicalIdentity?: string): Promise<{
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
  if (logicalIdentity) {
    const markerPath = path.join(firstRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as Record<string, unknown>;
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: logicalIdentity }, { spaces: 2 });
  }
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

async function rewriteCatalogSnapshot(root: string, catalogVersion: string, content: string): Promise<void> {
  await createCatalogSnapshotFixture(root, 'one', [], content);
  const manifestPath = path.join(root, 'catalog-manifest.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  await fs.writeJson(manifestPath, { ...manifest, catalogVersion }, { spaces: 2 });
}

async function configuredGitController(): Promise<{
  controller: TuiController;
  work: string;
  remote: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const work = path.join(isolation.layout.fixtureCwd, 'tui-git-review-work');
  const remote = path.join(isolation.layout.fixtureCwd, 'tui-git-review-remote.git');
  await fs.ensureDir(work);
  await git(work, ['init', '--initial-branch=main']);
  await git(work, ['config', 'user.email', 'test@example.test']);
  await git(work, ['config', 'user.name', 'AW Test']);
  await createCatalogSnapshotFixture(path.join(work, 'catalog'), 'one');
  await git(work, ['add', '.']);
  await git(work, ['commit', '-m', 'initial catalog']);
  await git(path.dirname(work), ['clone', '--bare', work, remote]);
  await git(work, ['remote', 'add', 'origin', remote]);
  const before = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{
        id: 'git-local', type: 'git', primary: true, url: remote,
        refPolicy: { type: 'explicit', ref: 'refs/heads/main' }, subdir: 'catalog',
      }],
    },
    expectedDigest: before.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'git-local', cliVersion: '1.0.0', env: isolation.env });
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
    interactive: false,
    nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    debugLogger: { log: async () => undefined },
  }));
  return { controller: new TuiController(dependencies), work, remote };
}

async function pushGitCatalogVersion(
  work: string,
  catalogVersion: string,
  content: string,
  branch = 'main',
): Promise<void> {
  await rewriteCatalogSnapshot(path.join(work, 'catalog'), catalogVersion, content);
  await git(work, ['add', '.']);
  await git(work, ['commit', '-m', `catalog ${catalogVersion} ${content.trim()}`]);
  await git(work, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
}

describe('TUI v4 real catalog source boundary', () => {
  it('keeps a real Active Git source usable when its background ref check fails', async () => {
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
    await waitFor(
      () => controller.getCatalogFreshness('git-local')?.state === 'checkFailed',
      'failed background ref check',
      () => controller.getCatalogFreshness('git-local'),
    );
    expect(controller.getCatalogGeneration('git-local')?.active?.catalogVersion).toBe('1.0.0');
    expect(observedHealth).toEqual(['ready']);
    expect(controller.getPluginOverview('git-local/demo')).toMatchObject({ version: '1.0.0' });
    controller.dispose();
  });

  it.each([
    ['1.0.0', 'same-version candidate'],
    ['0.9.0', 'rollback candidate'],
  ] as const)('does not let a no-op source edit bypass the %s candidate gate', async (version, content) => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, work, remote } = await configuredGitController();
    const active = (await readCatalogGenerationState(isolation.env)).sources['git-local']!.active!;
    await pushGitCatalogVersion(work, version, content);
    await controller.load();

    await expect(controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'git-local',
      sourceMutation: {
        action: 'update',
        update: {
          type: 'git', url: remote,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' }, subdir: 'catalog',
        },
      },
    })).rejects.toMatchObject({ code: 'sourceNoChanges' });

    expect((await readCatalogGenerationState(isolation.env)).sources['git-local']!.active).toEqual(active);
    await waitFor(
      () => !['notChecked', 'checking'].includes(
        controller.getCatalogFreshness('git-local')?.state ?? 'notChecked',
      ),
      'terminal Git freshness',
    );
    controller.dispose();
  });

  it('blocks a version conflict that appears after an update overlay', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, work } = await configuredGitController();
    const active = (await readCatalogGenerationState(isolation.env)).sources['git-local']!.active!;
    await pushGitCatalogVersion(work, '2.0.0', 'newer candidate');
    await controller.load();
    await waitFor(
      () => controller.getCatalogFreshness('git-local')?.state === 'updateAvailable',
      'Git update overlay',
      () => controller.getCatalogFreshness('git-local'),
    );
    await pushGitCatalogVersion(work, '1.0.0', 'conflicting candidate');

    await expect(controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'git-local',
    })).rejects.toMatchObject({ code: 'catalogVersionConflict' });

    expect((await readCatalogGenerationState(isolation.env)).sources['git-local']!.active).toEqual(active);
    controller.dispose();
  });

  it('blocks a rollback that appears after Review and keeps Active unchanged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, work } = await configuredGitController();
    const active = (await readCatalogGenerationState(isolation.env)).sources['git-local']!.active!;
    await pushGitCatalogVersion(work, '2.0.0', 'review candidate');
    await controller.load();
    await waitFor(
      () => controller.getCatalogFreshness('git-local')?.state === 'updateAvailable',
      'Git update overlay',
      () => controller.getCatalogFreshness('git-local'),
    );
    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'git-local',
    });
    expect(review.changes).toContainEqual(expect.objectContaining({ title: '当前 Active Catalog 1.0.0' }));
    await pushGitCatalogVersion(work, '0.9.0', 'rollback after Review');

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'catalogRollbackDetected', operationKind: 'catalogGeneration',
    });
    expect((await readCatalogGenerationState(isolation.env)).sources['git-local']!.active).toEqual(active);
    controller.dispose();
  });

  it('allows a real ref change to explicitly switch to a reviewed lower version', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, work } = await configuredGitController();
    await git(work, ['checkout', '-b', 'rollback']);
    await pushGitCatalogVersion(work, '0.9.0', 'explicit rollback', 'rollback');
    await git(work, ['checkout', 'main']);
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'git-local',
      sourceMutation: {
        action: 'update',
        update: { type: 'git', refPolicy: { type: 'explicit', ref: 'refs/heads/rollback' } },
      },
    });

    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '当前 Active Catalog 1.0.0' }),
      expect.objectContaining({ title: '显式来源切换将降低 Catalog 版本' }),
    ]));
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded', operationKind: 'catalogGeneration',
    });
    expect(controller.getCatalogGeneration('git-local')?.active?.catalogVersion).toBe('0.9.0');
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources[0]).toMatchObject({
      refPolicy: { type: 'explicit', ref: 'refs/heads/rollback' },
    });
    controller.dispose();
  });

  it('shows a local candidate and switches Active only after real Ink confirmation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, firstRoot } = await configuredController();
    const before = (await readCatalogGenerationState(isolation.env)).sources.local!.active!;
    await rewriteCatalogSnapshot(firstRoot, '2.0.0', 'updated\n');
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(
      () => controller.getCatalogFreshness('local')?.state === 'localChangesAvailable',
      'local Catalog candidate',
      () => controller.getCatalogFreshness('local'),
    );
    controller.push({ name: 'sourceDetail', sourceId: 'local' });
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('候选 Catalog 2.0.0');
    expect(instance.lastFrame()).toContain('应用本地内容变化');
    expect((await readCatalogGenerationState(isolation.env)).sources.local!.active).toEqual(before);

    await input(instance, '\r');
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'catalogGeneration', 'update Review');
    expect((await readCatalogGenerationState(isolation.env)).sources.local!.active).toEqual(before);
    await confirmReview(instance, controller);

    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded', operationKind: 'catalogGeneration' });
    expect(controller.getCatalogGeneration('local')?.active?.catalogVersion).toBe('2.0.0');
    expect((await readCatalogGenerationState(isolation.env)).sources.local!.active?.snapshotDigest)
      .not.toBe(before.snapshotDigest);
    await waitFor(
      () => controller.getCatalogFreshness('local')?.state === 'current',
      'freshness after Active switch',
      () => controller.getCatalogFreshness('local'),
    );
    controller.dispose();
  });

  it('returns stale when the complete candidate changes after Review', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, firstRoot } = await configuredController();
    await controller.load();
    const before = (await readCatalogGenerationState(isolation.env)).sources.local!.active!;
    await rewriteCatalogSnapshot(firstRoot, '2.0.0', 'candidate two\n');
    await controller.recheckCatalogSource('local');
    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'local',
    });
    await rewriteCatalogSnapshot(firstRoot, '3.0.0', 'candidate three\n');

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({ state: 'stale', operationKind: 'catalogGeneration' });
    expect((await readCatalogGenerationState(isolation.env)).sources.local!.active).toEqual(before);
    controller.dispose();
  });

  it('keeps a concurrent Active when it changes after the reviewed candidate resolves', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, firstRoot } = await configuredController();
    await controller.load();
    await rewriteCatalogSnapshot(firstRoot, '2.0.0', 'reviewed candidate\n');
    await controller.recheckCatalogSource('local');
    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'local',
    });
    let concurrent: Awaited<ReturnType<typeof syncCatalogSourceGeneration>> | undefined;
    setTuiControllerRuntimeTestHooksForTests({
      afterCatalogGenerationCandidateResolved: async () => {
        await rewriteCatalogSnapshot(firstRoot, '3.0.0', 'concurrent candidate\n');
        concurrent = await syncCatalogSourceGeneration({
          sourceId: 'local', cliVersion: '1.0.0', env: isolation.env,
        });
      },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({ state: 'stale', operationKind: 'catalogGeneration' });
    expect(concurrent?.active).toBeDefined();
    expect(await readCatalogGenerationState(isolation.env)).toEqual({
      schemaVersion: 1,
      sources: { local: { active: concurrent!.active, lastSync: concurrent!.lastSync } },
    });
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

  it('saves only autoCheck through source Review without resolving or switching Catalog data', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, firstRoot } = await configuredController();
    await controller.load();
    await waitFor(
      () => controller.getCatalogFreshness('local')?.state !== 'checking',
      'initial automatic path check',
      () => controller.getCatalogFreshness('local'),
    );
    const beforeConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    const beforeState = await readCatalogGenerationState(isolation.env);
    const active = beforeState.sources.local!.active!;
    const store = resolveCatalogStoreLocation({
      logicalIdentity: active.logicalIdentity,
      snapshotDigest: active.snapshotDigest,
      env: isolation.env,
    });
    const beforeStoreInventory = await fs.readdir(store.entryDir, { recursive: true });
    await fs.remove(firstRoot);

    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'update',
      sourceId: 'local',
      update: { autoCheck: false },
      changes: [{ title: '自动检查更新', before: '开启', after: '关闭' }],
    });
    expect(review).toMatchObject({
      operationKind: 'sourceMutation',
      sourceAction: 'update',
      changes: expect.arrayContaining([expect.objectContaining({ title: '自动检查更新' })]),
    });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded', operationKind: 'sourceMutation', sourceAction: 'update',
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources[0])
      .toMatchObject({ id: 'local', autoCheck: false });
    expect(await readCatalogGenerationState(isolation.env)).toEqual(beforeState);
    expect(await fs.readdir(store.entryDir, { recursive: true })).toEqual(beforeStoreInventory);
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).not.toBe(beforeConfig.digest);
    controller.dispose();
  });

  it('gets and activates a configured source without Active through real Ink interaction', async () => {
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
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'initial TUI status');
    expect(controller.getCatalogGeneration('team')).toMatchObject({ state: 'activationRequired' });
    controller.push({ name: 'sourceDetail', sourceId: 'team' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('获取并启用');

    await input(instance, '\r');
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'catalogGeneration', 'generation Review');
    expect(instance.lastFrame()).toContain('不会升级已安装 Plugin');
    await confirmReview(instance, controller);

    expect(controller.snapshot.result).toMatchObject({
      state: 'succeeded',
      operationKind: 'catalogGeneration',
    });
    expect((await readCatalogGenerationState(isolation.env)).sources.team?.active).toBeDefined();
    expect(controller.getPluginOverview('team/two')).toMatchObject({ version: '1.0.0' });
    controller.dispose();
  });

  it('keeps a committed source and offers an in-TUI retry when activation fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'partial-source-one');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'partial-source-two');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'one'),
      createCatalogSnapshotFixture(secondRoot, 'two'),
    ]);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: firstRoot }] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      debugLogger: { log: async () => undefined },
    }));
    setTuiControllerRuntimeTestHooksForTests({
      afterCatalogSourceConfigCommit: () => fs.remove(secondRoot),
    });
    const controller = new TuiController(dependencies);
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration',
      action: 'activate',
      sourceId: 'team',
      sourceMutation: {
        action: 'add',
        source: { id: 'team', type: 'path', primary: false, path: secondRoot },
      },
    });
    await controller.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(controller.snapshot.result).toMatchObject({
      state: 'partial',
      operationKind: 'catalogGeneration',
      summary: { message: expect.stringContaining('来源配置已保存') },
    });
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .some((source) => source.id === 'team')).toBe(true);
    expect((await readCatalogGenerationState(isolation.env)).sources.team?.active).toBeUndefined();
    expect(instance.lastFrame()).toContain('现在启用 / 重试');
    controller.dispose();
  });

  it('validates and switches a config-mismatched source through real Ink interaction', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, secondRoot } = await configuredController();
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: secondRoot }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'mismatched TUI status');
    expect(controller.getCatalogGeneration('local')).toMatchObject({ state: 'configMismatch' });
    controller.push({ name: 'sourceDetail', sourceId: 'local' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('验证并切换');

    await input(instance, '\r');
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'catalogGeneration', 'switch Review');
    await confirmReview(instance, controller);

    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' });
    expect(controller.getCatalogGeneration('local')).toMatchObject({
      state: 'ready',
      active: { catalogVersion: '1.0.0' },
    });
    expect(controller.getPluginOverview('local/two')).toBeDefined();
    controller.dispose();
  });

  it('does not create an ordinary update Review after logical identity changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, firstRoot } = await configuredController();
    await controller.load();
    const active = (await readCatalogGenerationState(isolation.env)).sources.local!.active;
    const markerPath = path.join(firstRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as Record<string, unknown>;
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'replacement-logical-identity' });

    await expect(controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'local',
    })).rejects.toMatchObject({ code: 'catalogLogicalIdentityChanged' });

    expect((await readCatalogGenerationState(isolation.env)).sources.local!.active).toEqual(active);
    expect(controller.snapshot.activeReview).toBeUndefined();
    controller.dispose();
  });

  it('blocks setting an unavailable source as primary before any config write', async () => {
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
    await controller.load();

    await expect(controller.buildOperationReview({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team',
    })).rejects.toMatchObject({ code: 'catalogGenerationUnavailable' });

    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'local')?.primary).toBe(true);
    controller.dispose();
  });

  it('shows the in-TUI exact repair action for a damaged Active entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller } = await configuredController('..');
    const active = (await readCatalogGenerationState(isolation.env)).sources.local!.active!;
    const storeKey = createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest);
    expect(storeKey.startsWith(`${crypto.createHash('sha256').update('..', 'utf8').digest('hex')}/`))
      .toBe(true);
    const recoveryEntryPath = `catalog-store/${storeKey}`;
    await fs.writeFile(
      path.join(isolation.env.AW_HOME!, recoveryEntryPath, 'metadata.json'),
      '{ damaged metadata\n',
    );
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 120, rows: 30 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'damaged Active status', () => controller.snapshot);
    controller.push({ name: 'sourceDetail', sourceId: 'local' });
    await nextTurn(2);

    expect(controller.getCatalogGeneration('local')).toMatchObject({
      errorCode: 'catalogGenerationMetadataInvalid',
      recoveryEntryPath,
    });
    const frame = instance.lastFrame() ?? '';
    const compactFrame = frame.replace(/\s+/gu, '');
    expect(frame).toContain('重新下载并修复');
    expect(frame).toContain('编辑来源…');
    expect(compactFrame).not.toContain('awcatalogsourcesynclocal');
    expect(frame).not.toContain(isolation.env.AW_HOME!);
    controller.push({ name: 'sourceTechnical', sourceId: 'local' });
    await nextTurn(2);
    const technicalFrame = (instance.lastFrame() ?? '').replace(/\s+/gu, '');
    expect(technicalFrame).toContain('catalogGenerationMetadataInvalid');
    expect(technicalFrame).toContain(`catalog-store/${storeKey.split('/')[0]}`);
    expect(technicalFrame).toContain('只删除该精确条目');
    expect(technicalFrame).not.toContain('检查GitURL');
    expect(technicalFrame).not.toContain(isolation.env.AW_HOME!);
    controller.dispose();
  });

  it('repairs only the damaged Active entry through real Ink interaction', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller } = await configuredController();
    const active = (await readCatalogGenerationState(isolation.env)).sources.local!.active!;
    const storeKey = createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest);
    const entryDir = path.join(isolation.env.AW_HOME!, 'catalog-store', storeKey);
    const sibling = path.join(path.dirname(entryDir), 'unrelated-digest');
    await fs.outputFile(sibling, 'keep');
    await fs.writeFile(path.join(entryDir, 'metadata.json'), 'damaged');
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'damaged TUI status');
    controller.push({ name: 'sourceDetail', sourceId: 'local' });
    await nextTurn(2);

    await input(instance, '\r');
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'catalogGeneration', 'repair Review');
    expect(controller.snapshot.activeReview?.primaryLabel).toBe('重新下载并修复');
    await confirmReview(instance, controller);

    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' });
    expect(controller.getCatalogGeneration('local')).toMatchObject({ state: 'ready' });
    await expect(fs.readFile(sibling, 'utf8')).resolves.toBe('keep');
    controller.dispose();
  });

  it('recovers invalid generation state and activates only the reviewed source through Ink', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller } = await configuredController();
    await fs.writeFile(path.join(isolation.env.AW_HOME!, 'catalog-state.json'), '{ invalid state\n');
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'invalid state TUI status');
    expect(controller.getCatalogGeneration('local')).toMatchObject({ state: 'stateInvalid' });
    controller.push({ name: 'sourceDetail', sourceId: 'local' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('恢复状态并启用');

    await input(instance, '\r');
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'catalogGeneration', 'state recovery Review');
    expect(controller.snapshot.activeReview?.primaryLabel).toBe('恢复状态并启用');
    expect(instance.lastFrame()).toContain('不会修改其他来源配置或 store');
    await confirmReview(instance, controller);

    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' });
    expect((await readCatalogGenerationState(isolation.env)).sources.local?.active).toBeDefined();
    expect(controller.getCatalogGeneration('local')).toMatchObject({ state: 'ready' });
    expect(controller.getPluginOverview('local/one')).toBeDefined();
    controller.dispose();
  });

  it('prioritizes exact repair over config mismatch and preserves a sibling store entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, firstRoot } = await configuredController();
    const mirrorRoot = path.join(isolation.layout.fixtureCwd, 'same-catalog-new-path');
    await fs.copy(firstRoot, mirrorRoot);
    const active = (await readCatalogGenerationState(isolation.env)).sources.local!.active!;
    const entryDir = path.join(
      isolation.env.AW_HOME!,
      'catalog-store',
      createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
    );
    const sibling = path.join(path.dirname(entryDir), 'unrelated-digest');
    await fs.outputFile(sibling, 'keep');
    await fs.writeFile(path.join(entryDir, 'metadata.json'), 'damaged');
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: mirrorRoot }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'combined repair TUI status');
    expect(controller.getCatalogGeneration('local')).toMatchObject({
      state: 'repairRequired',
      errorCode: 'catalogGenerationMetadataInvalid',
    });
    controller.push({ name: 'sourceDetail', sourceId: 'local' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('验证候选并恢复');

    await input(instance, '\r');
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'catalogGeneration', 'combined repair Review');
    expect(controller.snapshot.activeReview?.primaryLabel).toBe('验证并精确修复');
    expect(instance.lastFrame()).toContain('精确替换损坏的 Active 条目');
    await confirmReview(instance, controller);

    const repaired = (await readCatalogGenerationState(isolation.env)).sources.local!.active!;
    expect(repaired.snapshotDigest).toBe(active.snapshotDigest);
    expect(repaired.sourceConfigFingerprint).not.toBe(active.sourceConfigFingerprint);
    expect(controller.getCatalogGeneration('local')).toMatchObject({ state: 'ready' });
    await expect(fs.readFile(sibling, 'utf8')).resolves.toBe('keep');
    controller.dispose();
  });

  it.each([
    ['1.0.0', 'same-version drift', ['metadata.json']],
    ['0.9.0', 'lower-version candidate', ['snapshot', 'catalog-manifest.json']],
  ] as const)('does not infer the old version from an incomplete Active entry for %s', async (
    version,
    content,
    damageRelative,
  ) => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, work } = await configuredGitController();
    await git(work, ['checkout', '-b', 'mismatch']);
    await pushGitCatalogVersion(work, version, content, 'mismatch');
    await git(work, ['checkout', 'main']);
    const active = (await readCatalogGenerationState(isolation.env)).sources['git-local']!.active!;
    const activeEntry = path.join(
      isolation.env.AW_HOME!,
      'catalog-store',
      createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
    );
    await fs.writeFile(path.join(activeEntry, ...damageRelative), 'damaged\n');
    const beforeConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{
          id: 'git-local', type: 'git', primary: true,
          url: beforeConfig.config.sources[0]!.type === 'git'
            ? beforeConfig.config.sources[0]!.url : '',
          refPolicy: { type: 'explicit', ref: 'refs/heads/mismatch' },
          subdir: 'catalog',
        }],
      },
      expectedDigest: beforeConfig.digest,
      env: isolation.env,
    });
    const candidate = await probeCatalogSourceGeneration({
      sourceId: 'git-local', cliVersion: '1.0.0', env: isolation.env,
    });
    const candidateEntry = path.join(
      isolation.env.AW_HOME!,
      'catalog-store',
      createCatalogStoreKey(candidate.candidate.logicalIdentity, candidate.candidate.snapshotDigest),
    );
    const stateBeforeReview = await readCatalogGenerationState(isolation.env);
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 100, rows: 28 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'damaged mismatched Git source');
    expect(controller.getCatalogGeneration('git-local')).toMatchObject({
      state: 'repairRequired',
      configMismatch: true,
    });
    controller.push({ name: 'sourceDetail', sourceId: 'git-local' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('验证候选并恢复');
    expect(instance.lastFrame()).toContain('编辑来源');
    expect(instance.lastFrame()).toContain('移除来源');

    await input(instance, '\r');
    await waitFor(
      () => controller.snapshot.reviewPreparation?.state === 'failed',
      'safe comparison block',
    );
    expect(instance.lastFrame()).toContain('损坏的当前 Active 无法提供可信版本');
    expect(controller.snapshot.activeReview).toBeUndefined();
    expect(await readCatalogGenerationState(isolation.env)).toEqual(stateBeforeReview);
    await expect(fs.pathExists(candidateEntry)).resolves.toBe(false);
    expect((await readCatalogGenerationState(isolation.env)).sources['git-local']!.active).toEqual(active);
    controller.dispose();
  });

  it('blocks a different identity, digest, and lower version when all weak Active evidence is damaged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, secondRoot } = await configuredController();
    await createCatalogSnapshotFixture(secondRoot, 'two', [], 'lower replacement\n');
    const candidateManifestPath = path.join(secondRoot, 'catalog-manifest.json');
    const candidateManifest = await fs.readJson(candidateManifestPath) as Record<string, unknown>;
    await fs.writeJson(candidateManifestPath, { ...candidateManifest, catalogVersion: '0.9.0' }, { spaces: 2 });
    const active = (await readCatalogGenerationState(isolation.env)).sources.local!.active!;
    const activeEntry = path.join(
      isolation.env.AW_HOME!,
      'catalog-store',
      createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
    );
    await Promise.all([
      fs.writeFile(path.join(activeEntry, 'metadata.json'), 'damaged metadata\n'),
      fs.writeFile(path.join(activeEntry, 'snapshot', 'catalog-manifest.json'), 'damaged snapshot\n'),
    ]);
    const beforeConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: secondRoot }],
      },
      expectedDigest: beforeConfig.digest,
      env: isolation.env,
    });
    const candidate = await probeCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env,
    });
    expect(candidate.candidate.logicalIdentity).not.toBe(active.logicalIdentity);
    expect(candidate.candidate.snapshotDigest).not.toBe(active.snapshotDigest);
    const candidateEntry = path.join(
      isolation.env.AW_HOME!,
      'catalog-store',
      createCatalogStoreKey(candidate.candidate.logicalIdentity, candidate.candidate.snapshotDigest),
    );
    const stateBeforeReview = await readCatalogGenerationState(isolation.env);
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 100, rows: 28 }} />);
    await waitFor(() => controller.snapshot.phase === 'ready', 'fully damaged mismatched Active');
    controller.push({ name: 'sourceDetail', sourceId: 'local' });
    await nextTurn(2);
    await input(instance, '\r');
    await waitFor(
      () => controller.snapshot.reviewPreparation?.state === 'failed',
      'fully damaged Active comparison block',
    );

    expect(controller.snapshot.reviewPreparation).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('不能安全比较候选'),
    });
    expect(instance.lastFrame()).toContain('当前 Active 保持不变');
    expect(await readCatalogGenerationState(isolation.env)).toEqual(stateBeforeReview);
    await expect(fs.pathExists(candidateEntry)).resolves.toBe(false);
    await expect(fs.readFile(path.join(activeEntry, 'metadata.json'), 'utf8'))
      .resolves.toBe('damaged metadata\n');
    await expect(fs.readFile(path.join(activeEntry, 'snapshot', 'catalog-manifest.json'), 'utf8'))
      .resolves.toBe('damaged snapshot\n');
    controller.dispose();
  });

  it('allows a real source edit to select a new key without repairing the damaged old entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { controller, work } = await configuredGitController();
    await git(work, ['checkout', '-b', 'replacement']);
    await pushGitCatalogVersion(work, '2.0.0', 'replacement candidate', 'replacement');
    await git(work, ['checkout', 'main']);
    const active = (await readCatalogGenerationState(isolation.env)).sources['git-local']!.active!;
    const activeEntry = path.join(
      isolation.env.AW_HOME!,
      'catalog-store',
      createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
    );
    const damagedPath = path.join(activeEntry, 'snapshot', 'catalog-manifest.json');
    await fs.writeFile(damagedPath, 'damaged old entry\n');
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'git-local',
      sourceMutation: {
        action: 'update',
        update: { type: 'git', refPolicy: { type: 'explicit', ref: 'refs/heads/replacement' } },
      },
    });
    expect(review.primaryLabel).toBe('验证并切换');
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded', operationKind: 'catalogGeneration',
    });

    const switched = (await readCatalogGenerationState(isolation.env)).sources['git-local']!.active!;
    expect(switched.snapshotDigest).not.toBe(active.snapshotDigest);
    await expect(fs.readFile(damagedPath, 'utf8')).resolves.toBe('damaged old entry\n');
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources[0]).toMatchObject({
      refPolicy: { type: 'explicit', ref: 'refs/heads/replacement' },
    });
    expect(controller.getCatalogGeneration('git-local')).toMatchObject({
      state: 'ready', active: { catalogVersion: '2.0.0' },
    });
    controller.dispose();
  });

  it('saves and activates a real path source through Ink keys', async () => {
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
      operationKind: 'catalogGeneration',
    });
    expect(instance.lastFrame()).toContain('获取并启用');
    expect(JSON.stringify(controller.snapshot)).not.toContain(secondRoot);
    await confirmReview(instance, controller);
    expect((await readCatalogSourcesConfigSnapshot(getCurrentSourceTestIsolation().env)).config.sources)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'team', type: 'path' })]));
    expect((await readCatalogGenerationState(getCurrentSourceTestIsolation().env)).sources.team?.active)
      .toBeDefined();
    expect(controller.getPluginOverview('team/two')).toBeDefined();
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
      schemaVersion: 3,
      pluginId: 'team/two',
      values: {},
    });
    await fs.outputFile(
      path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json'),
      '{ invalid json\n',
    );
    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
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
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation', action: 'remove', sourceId: 'team',
    });
    await controller.executeOperation(review.reviewToken);
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

  it('rejects an invalid prospective source without committing its config', async () => {
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
    await waitFor(() => controller.snapshot.reviewPreparation?.state === 'failed', 'invalid source rejection');
    expect(controller.snapshot.activeReview).toBeUndefined();
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .some((source) => source.id === 'broken')).toBe(false);
    expect(JSON.stringify(controller.snapshot)).not.toContain(invalidRoot);
    expect(instance.lastFrame()).toContain('无法准备确认信息');
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
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'catalogGeneration', 'add Review');
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
      operationKind: 'catalogGeneration',
      review: {
        operationKind: 'catalogGeneration',
      },
    });
    const after = await readCatalogSourcesConfigSnapshot(isolation.env);
    expect(after.config.sources.map((source) => source.id).sort()).toEqual(['concurrent', 'local']);
    controller.dispose();
  });
});
