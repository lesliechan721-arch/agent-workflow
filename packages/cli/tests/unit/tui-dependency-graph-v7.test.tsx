import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import type { TuiController, TuiControllerSnapshot } from '../../src/tui/controller.js';
import { buildDependencyGraphProjection } from '../../src/tui/dependency-graph.js';
import type {
  PluginDependencyOverviewViewModel,
  PluginListItemViewModel,
} from '../../src/tui/model.js';
import type { TuiPageContext, TuiRoute } from '../../src/tui/router.js';

afterEach(() => cleanup());

const plugin = (pluginId: string, displayName: string): PluginListItemViewModel => ({
  pluginId,
  sourceId: pluginId.split('/')[0]!,
  displayName,
  description: pluginId === 'official/root' ? '生成团队审查规则' : '依赖图测试插件',
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

// Synthetic current-availability references exercise the projection contract.
function chainOverviews(mismatched = false): PluginDependencyOverviewViewModel[] {
  const aToB = reference('official/a', 'official/b');
  const bToC = reference('official/b', 'official/c');
  if (mismatched) bToC.consumer.scope = 'user';
  const summary = { directCount: 1, transitiveCount: 1, totalCount: 2, readyCount: 2, missingCount: 0, issueCount: 0 };
  const item = (
    pluginId: string,
    relation: 'direct' | 'transitive' | 'dependent',
    depth: number,
    availablePlacementReferences: ReturnType<typeof reference>[],
    requiredBy: Array<{ pluginId: string; displayName: string }> = [],
  ) => ({
    pluginId,
    displayName: pluginId.split('/')[1]!.toUpperCase(),
    relation,
    depth,
    requiredBy,
    placements: [],
    aggregateStatus: 'ready' as const,
    availablePlacementReferences,
  });
  return [{
    pluginId: 'official/a', summary,
    dependencies: [
      item('official/b', 'direct', 1, [aToB], [{ pluginId: 'official/a', displayName: 'A' }]),
      item('official/c', 'transitive', 2, [bToC], [{ pluginId: 'official/b', displayName: 'B' }]),
    ], dependents: [], blockers: [],
  }, {
    pluginId: 'official/b', summary,
    dependencies: [item('official/c', 'direct', 1, [bToC], [{ pluginId: 'official/b', displayName: 'B' }])],
    dependents: [item('official/a', 'dependent', 1, [aToB])], blockers: [],
  }, {
    pluginId: 'official/c', summary,
    dependencies: [], dependents: [item('official/b', 'dependent', 1, [bToC])], blockers: [],
  }];
}

function overviews(): PluginDependencyOverviewViewModel[] {
  return [{
    pluginId: 'official/root',
    summary: { directCount: 2, transitiveCount: 1, totalCount: 3, readyCount: 2, missingCount: 1, issueCount: 1 },
    dependencies: [
      {
        pluginId: 'official/left', displayName: '左分支', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/root', displayName: '根插件' }],
        placements: [], aggregateStatus: 'ready',
        availablePlacementReferences: [reference('official/root', 'official/left')],
      },
      {
        pluginId: 'official/right', displayName: '右分支', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/root', displayName: '根插件' }],
        placements: [], aggregateStatus: 'ready',
        availablePlacementReferences: [reference('official/root', 'official/right')],
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
      pluginId: 'official/consumer', displayName: '当前依赖者', relation: 'dependent', depth: 1,
      requiredBy: [], placements: [], aggregateStatus: 'ready',
      availablePlacementReferences: [reference('official/consumer', 'official/root')],
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
    plugin('official/consumer', '当前依赖者'),
  ];
  readonly dependencies = overviews();
  listeners = new Set<(snapshot: TuiControllerSnapshot) => void>();
  route: TuiRoute = { name: 'pluginDependencies', pluginId: 'official/root' };
  context: TuiPageContext = {};
  previousRoutes: Array<{ route: TuiRoute; context: TuiPageContext }> = [];

  get snapshot(): TuiControllerSnapshot {
    return {
      phase: 'ready',
      router: {
        current: { route: this.route, context: this.context }, currentFrameId: 'test', depth: 2,
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
  updatePageContext(context: Partial<TuiPageContext>): void { Object.assign(this.context, context); }
  push(route: TuiRoute): void {
    this.previousRoutes.push({ route: this.route, context: this.context });
    this.route = route;
    this.context = {};
    this.publish();
  }
  replace(route: TuiRoute): void { this.route = route; this.publish(); }
  back(): void {
    const previous = this.previousRoutes.pop();
    this.route = previous?.route ?? { name: 'pluginDependencies', pluginId: 'official/root' };
    this.context = previous?.context ?? {};
    this.publish();
  }
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

  it('requires continuous placements for a verified multi-hop reverse path', () => {
    const continuous = buildDependencyGraphProjection({
      overviews: chainOverviews(), rootPluginId: 'official/c', direction: 'dependents',
    });
    expect(continuous.rows.find((row) => row.pluginId === 'official/a'))
      .toMatchObject({ relationship: 'indirectAvailable', pathPluginIds: ['official/c', 'official/b', 'official/a'] });

    const discontinuous = buildDependencyGraphProjection({
      overviews: chainOverviews(true), rootPluginId: 'official/c', direction: 'dependents',
    });
    expect(discontinuous.rows.map((row) => row.pluginId)).not.toContain('official/a');
  });

  it('opens an indirect reverse node with the selected verified path', async () => {
    const controller = new DependencyControllerStub();
    controller.dependencies.splice(0, controller.dependencies.length, ...chainOverviews());
    controller.plugins.splice(0, controller.plugins.length,
      plugin('official/a', 'A'), plugin('official/b', 'B'), plugin('official/c', 'C'));
    controller.route = { name: 'pluginDependencies', pluginId: 'official/c', direction: 'dependents' };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }}
    />);
    await input(instance, '', '', '', '\u001b[B', '\u001b[B', '\r');

    expect(controller.route).toMatchObject({
      name: 'pluginDependencyNode',
      nodePluginId: 'official/a',
      nodePathPluginIds: ['official/c', 'official/b', 'official/a'],
    });
    expect(instance.lastFrame()).toContain('A 通过 B 需要 C，且各段依赖当前可用');
    expect(instance.lastFrame()).not.toContain('本次尚未确认依赖可用');
  });

  it('describes a forward declaration in the consumer-to-dependency direction', async () => {
    const controller = new DependencyControllerStub();
    controller.dependencies[0]!.dependencies[0]!.availablePlacementReferences = [];
    controller.route = {
      name: 'pluginDependencyNode', pluginId: 'official/root',
      nodePluginId: 'official/left', direction: 'dependencies',
      nodePathPluginIds: ['official/root', 'official/left'],
    };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }}
    />);
    await input(instance, '', '', '');

    expect(instance.lastFrame()).toContain('根插件 声明需要 左分支');
    expect(instance.lastFrame()).not.toContain('左分支 声明依赖当前插件');
  });

  it('keeps four placement references reachable and returns to the selected node', async () => {
    const controller = new DependencyControllerStub();
    const dependent = controller.dependencies[0]!.dependents[0]!;
    dependent.availablePlacementReferences = [
      {
        consumer: { pluginId: 'official/consumer', platform: 'codex', scope: 'project', project: 'current' },
        dependency: { pluginId: 'official/root', platform: 'codex', scope: 'user', project: null },
      },
      {
        consumer: { pluginId: 'official/consumer', platform: 'codex', scope: 'user', project: null },
        dependency: { pluginId: 'official/root', platform: 'codex', scope: 'project', project: 'current' },
      },
      {
        consumer: { pluginId: 'official/consumer', platform: 'claude', scope: 'project', project: 'current' },
        dependency: { pluginId: 'official/root', platform: 'claude', scope: 'user', project: null },
      },
      {
        consumer: { pluginId: 'official/consumer', platform: 'claude', scope: 'user', project: null },
        dependency: { pluginId: 'official/root', platform: 'claude', scope: 'project', project: 'current' },
      },
    ];
    controller.route = {
      name: 'pluginDependencyNode', pluginId: 'official/root',
      nodePluginId: 'official/consumer', direction: 'dependents',
      nodePathPluginIds: ['official/root', 'official/consumer'],
    };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }}
    />);
    await input(instance, '', '', '', '\r');
    expect(controller.route).toMatchObject({ name: 'pluginDependencyNode', view: 'references' });
    expect(instance.lastFrame()).toContain('当前可用依赖位置 4 个');
    expect(instance.lastFrame()).toContain('当前依赖者 · 当前项目 · Codex');
    expect(instance.lastFrame()).not.toContain('consumer · platform=');
    await input(instance, 'd');
    const expectedPlacements = [
      ['Codex', 'project', 'current', 'Codex', 'user', 'none'],
      ['Codex', 'user', 'none', 'Codex', 'project', 'current'],
      ['Claude Code', 'project', 'current', 'Claude Code', 'user', 'none'],
      ['Claude Code', 'user', 'none', 'Claude Code', 'project', 'current'],
    ];
    for (const [consumerPlatform, consumerScope, consumerProject,
      dependencyPlatform, dependencyScope, dependencyProject] of expectedPlacements) {
      expect(instance.lastFrame()).toContain(`consumer · platform=${consumerPlatform} · scope=${consumerScope}`);
      expect(instance.lastFrame()).toContain(`consumer · project=${consumerProject}`);
      expect(instance.lastFrame()).toContain(`dependency · platform=${dependencyPlatform} · scope=${dependencyScope}`);
      expect(instance.lastFrame()).toContain(`dependency · project=${dependencyProject}`);
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
      await input(instance, '\u001b[B');
    }
    await input(instance, '\u001b[B', '\r');
    expect(controller.route).toMatchObject({
      name: 'pluginDependencyNode', nodePluginId: 'official/consumer',
    });
    expect(instance.lastFrame()).toContain('当前可用依赖位置 4 个');
  });

  it('paginates complete long canonical reference IDs at 60 columns', async () => {
    const controller = new DependencyControllerStub();
    const sourceId = 'source-abcdefghijklmnopqrstuvwxy';
    const consumerId = `${sourceId}/consumer-${'c'.repeat(200)}`;
    const dependencyId = `${sourceId}/dependency-${'d'.repeat(200)}`;
    const dependent = controller.dependencies[0]!.dependents[0]!;
    dependent.availablePlacementReferences = [{
      consumer: { pluginId: consumerId, platform: 'codex', scope: 'project', project: 'current' },
      dependency: { pluginId: dependencyId, platform: 'claude', scope: 'user', project: null },
    }, {
      consumer: { pluginId: consumerId, platform: 'claude', scope: 'user', project: null },
      dependency: { pluginId: dependencyId, platform: 'codex', scope: 'project', project: 'current' },
    }];
    controller.route = {
      name: 'pluginDependencyNode', pluginId: 'official/root',
      nodePluginId: 'official/consumer', direction: 'dependents',
      nodePathPluginIds: ['official/root', 'official/consumer'], view: 'references',
    };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }}
    />);
    await input(instance, '', '', '', 'd', '');

    const readCurrentReference = async (): Promise<{
      consumer: string;
      dependency: string;
      text: string;
    }> => {
      const chunks = { consumer: [] as string[], dependency: [] as string[] };
      const pages: string[] = [];
      while (true) {
        const frame = instance.lastFrame() ?? '';
        pages.push(frame);
        expect(frame.split('\n').length).toBeLessThanOrEqual(18);
        expect(frame).toContain('PgUp/PgDn 查看当前位置详情');
        for (const line of frame.split('\n')) {
          const match = /^\s*(consumer|dependency) · (\S+)\s*$/u.exec(line);
          if (!match || match[2]!.startsWith('platform=') || match[2]!.startsWith('project=')) continue;
          chunks[match[1] as 'consumer' | 'dependency'].push(match[2]!);
        }
        if (!frame.includes('↓ 后面还有')) break;
        await input(instance, '\u001b[6~');
      }
      return {
        consumer: chunks.consumer.join(''),
        dependency: chunks.dependency.join(''),
        text: pages.join('\n'),
      };
    };

    const first = await readCurrentReference();
    expect(first.consumer).toBe(consumerId);
    expect(first.dependency).toBe(dependencyId);
    expect(first.text).toContain('consumer · platform=Codex · scope=project');
    expect(first.text).toContain('consumer · project=current');
    expect(first.text).toContain('dependency · platform=Claude Code · scope=user');
    expect(first.text).toContain('dependency · project=none');

    await input(instance, '\u001b[B');
    const second = await readCurrentReference();
    expect(second.consumer).toBe(consumerId);
    expect(second.dependency).toBe(dependencyId);
    expect(second.text).toContain('consumer · platform=Claude Code · scope=user');
    expect(second.text).toContain('consumer · project=none');
    expect(second.text).toContain('dependency · platform=Codex · scope=project');
    expect(second.text).toContain('dependency · project=current');
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
      expect(instance.lastFrame()).toContain('每一层表示上面的插件需要下面的插件');
      expect(instance.lastFrame()).toContain('共享组件');
      expect(instance.lastFrame()).toContain('共用，见上方');
      expect(instance.lastFrame()).not.toContain('必需依赖 ·');
      expect(instance.lastFrame()).not.toContain('根插件 ·');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, '\u001b[B', '\u001b[D');
      expect(instance.lastFrame()).not.toContain('共用，见上方');
      await input(instance, '\u001b[C');
      expect(instance.lastFrame()).toContain('共用，见上方');
      await input(instance, '\u001b[A');
      await input(instance, '\r');
      expect(controller.route.name).toBe('pluginDependencyNode');
      expect(instance.lastFrame()).toContain('用途');
      expect(instance.lastFrame()).toContain('为何需要');
      expect(instance.lastFrame()).toContain('影响');
      expect(instance.lastFrame()).toContain('生成团队审查规则');
      expect(instance.lastFrame()).not.toContain('official/root');
      await input(instance, 'd');
      expect(instance.lastFrame()).toContain('official/root');
      await input(instance, 'b');
      expect(controller.route.name).toBe('pluginDependencies');

      await input(instance, ...Array.from({ length: 5 }, () => '\u001b[B'), '\r');
      expect(controller.route).toMatchObject({ name: 'pluginDependencies', direction: 'dependents' });
      expect(instance.lastFrame()).toContain('下面的插件在本次检查中需要上面的插件');
      expect(instance.lastFrame()).toContain('当前依赖者');
      expect(instance.lastFrame()).toContain('未验证声明者 · 1 个');
      expect(instance.lastFrame()).toContain('未安装声明者');
      expect(instance.lastFrame()).toContain('仅声明 · 未安装');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, '\u001b[B', '\u001b[B', '\r');
      expect(controller.route).toMatchObject({
        name: 'pluginDependencyNode', nodePluginId: 'official/not-installed',
      });
      expect(instance.lastFrame()).toContain('声明需要当前插件，但本次尚未确认依赖可用');
      expect(instance.lastFrame()).not.toContain('已安装位置实际引用当前插件');
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'keeps long node explanations readable at %ix%i and restores node focus',
    async (columns, rows) => {
      const controller = new DependencyControllerStub();
      const root = controller.plugins.find((entry) => entry.pluginId === 'official/root')!;
      root.description = `生成团队审查规则${'，并保留完整的项目审查依据'.repeat(18)}。依赖说明唯一结尾。`;
      const instance = render(<ConsoleAppV4
        controller={controller as unknown as TuiController}
        size={{ columns, rows }}
      />);
      await input(instance, '', '', '', '\r');
      expect(controller.route).toMatchObject({ name: 'pluginDependencyNode', nodePluginId: 'official/root' });
      expect(instance.lastFrame()).not.toContain('依赖说明唯一结尾');
      expect(instance.lastFrame()).toContain('› 阅读完整说明');
      await input(instance, '\r');
      expect(controller.route).toMatchObject({ name: 'pluginDependencyNode', view: 'details' });
      const pages: string[] = [];
      for (let page = 0; page < 20; page += 1) {
        const frame = instance.lastFrame() ?? '';
        pages.push(frame);
        expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
        if (!frame.includes('↓ 后面还有')) break;
        await input(instance, '\u001b[6~');
      }
      expect(pages.join('\n')).toContain('生成团队审查规则');
      expect(pages.join('\n')).toContain('依赖说明唯一结尾');
      const completeText = pages.join('\n').replace(/\s/gu, '');
      expect(completeText).toContain('为何需要这是当前关系图的根插件。');
      expect(completeText).toContain('影响可用');
      await input(instance, 'b');
      expect(controller.route).toMatchObject({
        name: 'pluginDependencyNode', nodePluginId: 'official/root',
      });
      expect(instance.lastFrame()).toContain('› 阅读完整说明');
    },
  );

  it('keeps every referenced non-root node action and its full explanation reachable at 60x18', async () => {
    const controller = new DependencyControllerStub();
    const left = controller.plugins.find((entry) => entry.pluginId === 'official/left')!;
    left.description = `提供依赖检查${'，保留每一个完整依据'.repeat(18)}。非根用途唯一结尾。`;
    controller.route = {
      name: 'pluginDependencyNode',
      pluginId: 'official/root',
      nodePluginId: 'official/left',
      direction: 'dependencies',
      nodePathPluginIds: ['official/root', 'official/left'],
    };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }}
    />);
    await input(instance, '');

    const expectedActions = [
      '› 查看全部位置（1）',
      '› 以此节点查看关系',
      '› 阅读完整说明',
      '› 返回关系图',
    ];
    for (const [index, expected] of expectedActions.entries()) {
      expect(instance.lastFrame()).toContain(expected);
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
      if (index < expectedActions.length - 1) await input(instance, '\u001b[B');
    }
    await input(instance, '\u001b[A', '\r');
    expect(controller.route).toMatchObject({ name: 'pluginDependencyNode', view: 'details' });
    const pages: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const frame = instance.lastFrame() ?? '';
      pages.push(frame);
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
      if (!frame.includes('↓ 后面还有')) break;
      await input(instance, '\u001b[6~');
    }
    const completeText = pages.join('\n').replace(/\s/gu, '');
    expect(completeText).toContain('非根用途唯一结尾');
    expect(completeText).toContain('为何需要');
    expect(completeText).toContain('根插件在本次检查的位置需要此插件，所需依赖当前可用。');
    expect(completeText).toContain('影响已可用');
    await input(instance, 'b');
    expect(controller.route).toMatchObject({
      name: 'pluginDependencyNode', nodePluginId: 'official/left',
    });
    expect(instance.lastFrame()).toContain('› 阅读完整说明');
  });

  it('keeps every unverified declarer accessible without counting it as an actual consumer', async () => {
    const controller = new DependencyControllerStub();
    controller.dependencies[0]!.dependents.forEach((dependent) => {
      dependent.availablePlacementReferences = [];
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
    expect(instance.lastFrame()).not.toContain('└─ 当前依赖者');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('0 个当前可用依赖者');
    await input(instance, '\u001b[B', '\r');
    expect(controller.route).toMatchObject({
      name: 'pluginDependencyNode', nodePluginId: 'official/consumer',
    });
    expect(instance.lastFrame()).toContain('声明需要当前插件，但本次尚未确认依赖可用');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });
});
