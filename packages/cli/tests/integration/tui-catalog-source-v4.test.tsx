import path from 'node:path';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { ConsoleAppV4, type ConsoleV4ScreenId } from '../../src/tui/console-app-v4.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

afterEach(() => cleanup());

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
  const changes = controller.snapshot.activeReview?.changes.length ?? 0;
  await input(instance, ...Array.from({ length: changes }, () => '\u001B[B'), '\r');
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
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: firstRoot }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  const context = createCliExecutionContext({
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
    interactive: false,
    nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    debugLogger: { log: async () => undefined },
  });
  return {
    controller: new TuiController(createTuiControllerDependencies(context)),
    firstRoot,
    secondRoot,
  };
}

describe('TUI v4 real catalog source boundary', () => {
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
    expect(instance.lastFrame()).toContain('验证并添加');
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
    expect(instance.lastFrame()).toContain('验证并保存');
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

  it('uses the real path validator and returns from S13 directly to the owned location editor', async () => {
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

    expect(screens).toContain('S13');
    expect(controller.snapshot.result).toMatchObject({
      state: 'blocked',
      operationKind: 'sourceMutation',
      sourceAction: 'add',
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain(invalidRoot);
    await input(instance, '\r');
    expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'sourceAdd',
      step: 'location',
    });
    expect(instance.lastFrame()).toContain('not-a-catalog');
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
