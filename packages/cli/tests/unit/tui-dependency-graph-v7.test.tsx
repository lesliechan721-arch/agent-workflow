import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import type { TuiController, TuiControllerSnapshot } from '../../src/tui/controller.js';
import { buildDependencyGraphProjection } from '../../src/tui/dependency-graph.js';
import type {
  PluginDependencyOverviewViewModel,
  PluginListItemViewModel,
} from '../../src/tui/model.js';
import type { TuiRoute } from '../../src/tui/router.js';

afterEach(() => cleanup());

const plugin = (pluginId: string, displayName: string): PluginListItemViewModel => ({
  pluginId,
  sourceId: pluginId.split('/')[0]!,
  displayName,
  description: '依赖图测试插件',
  version: '1.0.0',
  configFieldCount: 0,
  sourceLabel: pluginId.split('/')[0]!,
  supportedPlatforms: ['codex'],
  installedPlacements: [{
    platform: 'codex', state: 'installed', scope: 'project', health: 'ready', revision: 'current',
  }],
  aggregateStatus: 'installed',
  portableSkills: false,
  savedConfigScopes: [],
  technicalComponents: [],
  update: { pluginId, state: 'notChecked', targets: [] },
});

const reference = (consumer: string, dependency: string) => ({
  consumer: { pluginId: consumer, platform: 'codex' as const, scope: 'project' as const, project: 'current' as const },
  dependency: { pluginId: dependency, platform: 'codex' as const, scope: 'project' as const, project: 'current' as const },
});

function overviews(): PluginDependencyOverviewViewModel[] {
  return [{
    pluginId: 'official/root',
    summary: { directCount: 2, transitiveCount: 1, totalCount: 3, readyCount: 2, missingCount: 1, issueCount: 1 },
    dependencies: [
      {
        pluginId: 'official/left', displayName: '左分支', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/root', displayName: '根插件' }],
        placements: [], aggregateStatus: 'ready',
        placementReferences: [reference('official/root', 'official/left')],
      },
      {
        pluginId: 'official/right', displayName: '右分支', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/root', displayName: '根插件' }],
        placements: [], aggregateStatus: 'ready',
        placementReferences: [reference('official/root', 'official/right')],
      },
      {
        pluginId: 'official/shared', displayName: '共享组件', relation: 'transitive', depth: 2,
        requiredBy: [
          { pluginId: 'official/left', displayName: '左分支' },
          { pluginId: 'official/right', displayName: '右分支' },
        ],
        placements: [], aggregateStatus: 'notInstalled',
      },
    ],
    dependents: [{
      pluginId: 'official/consumer', displayName: '实际使用者', relation: 'dependent', depth: 1,
      requiredBy: [], placements: [], aggregateStatus: 'ready',
      placementReferences: [reference('official/consumer', 'official/root')],
    }, {
      pluginId: 'official/not-installed', displayName: '未安装声明者', relation: 'dependent', depth: 1,
      requiredBy: [], placements: [], aggregateStatus: 'notInstalled',
    }],
    blockers: [],
  }];
}

class DependencyControllerStub {
  readonly plugins = [
    plugin('official/root', '根插件'),
    plugin('official/left', '左分支'),
    plugin('official/right', '右分支'),
    plugin('official/shared', '共享组件'),
    plugin('official/consumer', '实际使用者'),
  ];
  readonly dependencies = overviews();
  listeners = new Set<(snapshot: TuiControllerSnapshot) => void>();
  route: TuiRoute = { name: 'pluginDependencies', pluginId: 'official/root' };

  get snapshot(): TuiControllerSnapshot {
    return {
      phase: 'ready',
      router: {
        current: { route: this.route, context: {} }, currentFrameId: 'test', depth: 2,
      },
      sourceHealth: [],
      catalogGenerations: [],
      catalogFreshness: [],
      reloadRequiredSourceIds: [],
      operationHistorySummaries: [],
      progress: { messages: [] },
      progressTargets: [],
      viewModel: { plugins: this.plugins, dependencyOverviews: this.dependencies },
    } as unknown as TuiControllerSnapshot;
  }

  get externalDrafts(): [] { return []; }

  subscribe(listener: (snapshot: TuiControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  publish(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  getPluginOverview(pluginId: string): PluginListItemViewModel | undefined {
    return this.plugins.find((entry) => entry.pluginId === pluginId);
  }

  getPluginDependencyOverview(pluginId: string): PluginDependencyOverviewViewModel | undefined {
    return this.dependencies.find((entry) => entry.pluginId === pluginId);
  }

  listPluginDependencyOverviews(): PluginDependencyOverviewViewModel[] { return this.dependencies; }
  getBlockingDependents(): PluginDependencyOverviewViewModel['dependents'] { return []; }
  listPluginWriteTaskCandidates(): [] { return []; }
  listUserIssues(): [] { return []; }
  listPlugins(): PluginListItemViewModel[] { return this.plugins; }
  listSources(): [] { return []; }
  setExternalDraftState(): void {}
  updatePageContext(): void {}
  push(route: TuiRoute): void { this.route = route; this.publish(); }
  replace(route: TuiRoute): void { this.route = route; this.publish(); }
  back(): void { this.route = { name: 'pluginDependencies', pluginId: 'official/root' }; this.publish(); }
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('dependency graph v7', () => {
  it('uses explicit edges, marks a shared node, and excludes an uninstalled declared consumer', () => {
    const forward = buildDependencyGraphProjection({
      overviews: overviews(), rootPluginId: 'official/root', direction: 'dependencies',
    });
    expect(forward.rows.filter((row) => row.pluginId === 'official/shared')).toHaveLength(2);
    expect(forward.rows.some((row) => row.pluginId === 'official/shared' && row.sharedWithRowId)).toBe(true);

    const reverse = buildDependencyGraphProjection({
      overviews: overviews(), rootPluginId: 'official/root', direction: 'dependents',
    });
    expect(reverse.rows.map((row) => row.pluginId)).toContain('official/consumer');
    expect(reverse.rows.map((row) => row.pluginId)).not.toContain('official/not-installed');
    expect(reverse.scopeSummary.unknownConsumerPluginIds).toContain('official/not-installed');
  });

  it('does not infer an edge from depth when edge evidence is absent', () => {
    const value = overviews();
    value[0]!.dependencies.push({
      pluginId: 'official/depth-only', displayName: '只有深度', relation: 'transitive', depth: 9,
      requiredBy: [], placements: [], aggregateStatus: 'notInstalled',
    });
    const projection = buildDependencyGraphProjection({
      overviews: value, rootPluginId: 'official/root', direction: 'dependencies',
    });
    expect(projection.rows.map((row) => row.pluginId)).not.toContain('official/depth-only');
  });

  it.each([[80, 24], [60, 18]] as const)(
    'renders and operates the directional tree at %ix%i',
    async (columns, rows) => {
      const controller = new DependencyControllerStub();
      const instance = render(<ConsoleAppV4
        controller={controller as unknown as TuiController}
        size={{ columns, rows }}
      />);
      await input(instance, '', '', '');
      expect(instance.lastFrame()).toContain('当前方向：它需要的');
      expect(instance.lastFrame()).toContain('共享组件');
      expect(instance.lastFrame()).toContain('[same]');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, '\u001b[B', '\u001b[D');
      expect(instance.lastFrame()).not.toContain('[same]');
      await input(instance, '\u001b[C');
      expect(instance.lastFrame()).toContain('[same]');
      await input(instance, '\u001b[A');
      await input(instance, '\r');
      expect(controller.route.name).toBe('pluginDependencyNode');
      expect(instance.lastFrame()).toContain('official/root');
      await input(instance, 'b');
      expect(controller.route.name).toBe('pluginDependencies');

      await input(instance, ...Array.from({ length: 5 }, () => '\u001b[B'), '\r');
      expect(controller.route).toMatchObject({ name: 'pluginDependencies', direction: 'dependents' });
      expect(instance.lastFrame()).toContain('当前方向：谁在使用它');
      expect(instance.lastFrame()).toContain('实际使用者');
      expect(instance.lastFrame()).toContain('未验证声明者 · 1 个');
      expect(instance.lastFrame()).toContain('未验证声明者 · 未安装声明者');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, '\u001b[B', '\u001b[B', '\r');
      expect(controller.route).toMatchObject({
        name: 'pluginDependencyNode', nodePluginId: 'official/not-installed',
      });
      expect(instance.lastFrame()).toContain('声明依赖当前插件，但当前没有实际引用证据');
      expect(instance.lastFrame()).not.toContain('已安装位置实际引用当前插件');
    },
  );

  it('keeps every unverified declarer accessible without counting it as an actual consumer', async () => {
    const controller = new DependencyControllerStub();
    controller.dependencies[0]!.dependents.forEach((dependent) => {
      dependent.placementReferences = [];
    });
    controller.route = {
      name: 'pluginDependencies', pluginId: 'official/root', direction: 'dependents',
    };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }}
    />);
    await input(instance, '', '', '');

    expect(instance.lastFrame()).toContain('未验证声明者 · 2 个');
    expect(instance.lastFrame()).not.toContain('└─ 实际使用者');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('0 个实际使用者');
    await input(instance, '\u001b[B', '\r');
    expect(controller.route).toMatchObject({
      name: 'pluginDependencyNode', nodePluginId: 'official/consumer',
    });
    expect(instance.lastFrame()).toContain('声明依赖当前插件，但当前没有实际引用证据');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });
});
