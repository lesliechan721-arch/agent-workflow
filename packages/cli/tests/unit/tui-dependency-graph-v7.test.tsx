import path from 'node:path';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import type { TuiController, TuiControllerSnapshot } from '../../src/tui/controller.js';
import {
  buildDependencyGraphProjection,
  buildUnifiedDependencyGraphProjection,
} from '../../src/tui/dependency-graph.js';
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
  portableDraft?: { selectedCount: number; candidates: Array<{
    selected: boolean; name: string; providerDisplayName: string; providerPluginId: string;
  }> };
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
      portableDraft: this.portableDraft,
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
    if (this.route.name === 'pluginDetail') return undefined;
    return this.plugins.find((entry) => entry.pluginId === pluginId);
  }

  getPluginDetailSubject(pluginId: string) {
    const item = this.plugins.find((entry) => entry.pluginId === pluginId);
    const relation = this.dependencies.flatMap((entry) => [...entry.dependencies, ...entry.dependents])
      .find((entry) => entry.pluginId === pluginId);
    if (!item && !relation) return undefined;
    return {
      pluginId, sourceId: pluginId.split('/')[0]!, displayName: item?.displayName ?? relation!.displayName,
      description: item?.description, catalogVersion: item?.version, definitionAvailable: Boolean(item),
      savedConfigScopes: [], placements: item ? [{
        platform: 'codex' as const, scope: 'project' as const,
        platformLabel: 'Codex', scopeLabel: '当前项目',
        observation: 'known' as const, declared: true, actual: true,
        sharedWithCurrentProject: false, installedVersion: '0.9.0', reasonCodes: [],
      }] : [], relations: {
        outgoing: [], incoming: [], checkState: 'unknown' as const, hasKnownRelations: false,
      },
    };
  }

  getProjectInventoryRoot(): undefined { return undefined; }
  getSourceOverview() { return { source: undefined }; }

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

async function writeAcceptanceTrace(
  name: string, size: { columns: number; rows: number }, frames: Record<string, string | string[]>,
): Promise<void> {
  const outputDir = process.env.AW_TUI_ACCEPTANCE_TRACE_DIR;
  if (!outputDir) return;
  await fs.outputJson(path.join(outputDir, `b05-${name}-${size.columns}x${size.rows}.json`), {
    schemaVersion: 1, synthetic: true, size, frames,
  }, { spaces: 2 });
}

describe('dependency graph v7', () => {
  it('projects verified users and required dependencies into separate branches with one root', () => {
    const projection = buildUnifiedDependencyGraphProjection({
      overviews: overviews(), rootPluginId: 'official/root',
    });

    expect(projection.rows.filter((row) => row.pluginId === 'official/root')).toEqual([
      expect.objectContaining({ branch: 'root', depth: 0, relationship: 'root' }),
    ]);
    expect(projection.rows.some((row) => row.pluginId === 'official/consumer'
      && row.branch === 'dependents')).toBe(true);
    expect(projection.rows.some((row) => row.pluginId === 'official/left'
      && row.branch === 'dependencies')).toBe(true);
    expect(projection.dependents.rows.map((row) => row.pluginId)).toContain('official/consumer');
    expect(projection.dependencies.rows.map((row) => row.pluginId)).toContain('official/left');
  });

  it('keeps unavailable and missing states while separating declared users from available users', () => {
    const values = overviews();
    values[0]!.dependencies[0]!.aggregateStatus = 'unavailable';
    const projection = buildUnifiedDependencyGraphProjection({
      overviews: values, rootPluginId: 'official/root',
    });

    expect(projection.rows.find((row) => row.pluginId === 'official/left')).toMatchObject({
      branch: 'dependencies',
      nodeState: 'unavailable',
      relationship: 'directAvailable',
    });
    expect(projection.rows.find((row) => row.pluginId === 'official/shared')).toMatchObject({
      branch: 'dependencies',
      nodeState: 'missing',
      relationship: 'declared',
    });
    expect(projection.dependents.scopeSummary.unknownConsumerPluginIds)
      .toEqual(['official/not-installed']);
    expect(projection.rows.find((row) => row.pluginId === 'official/not-installed')).toMatchObject({
      branch: 'dependents', relationship: 'declared', pathReferences: [],
    });
    expect(projection.dependents.scopeSummary.availableConsumerPluginIds)
      .not.toContain('official/not-installed');
  });

  it('reports an absent dependency overview as unknown without creating relations', () => {
    const projection = buildUnifiedDependencyGraphProjection({
      overviews: [], rootPluginId: 'unknown/root',
    });

    expect(projection.status).toMatchObject({ state: 'unknown' });
    expect(projection.rows).toEqual([
      expect.objectContaining({
        pluginId: 'unknown/root', branch: 'root', nodeState: 'unknown', relationship: 'root',
      }),
    ]);
    expect(projection.dependencies.rows).toHaveLength(1);
    expect(projection.dependents.rows).toHaveLength(1);
  });

  it('uses explicit edges, marks a shared node, and retains an uninstalled declared consumer', () => {
    const forward = buildDependencyGraphProjection({
      overviews: overviews(), rootPluginId: 'official/root', direction: 'dependencies',
    });
    expect(forward.rows.filter((row) => row.pluginId === 'official/shared')).toHaveLength(2);
    expect(forward.rows.some((row) => row.pluginId === 'official/shared' && row.sharedWithRowId)).toBe(true);

    const reverse = buildDependencyGraphProjection({
      overviews: overviews(), rootPluginId: 'official/root', direction: 'dependents',
    });
    expect(reverse.rows.map((row) => row.pluginId)).toContain('official/consumer');
    expect(reverse.rows.map((row) => row.pluginId)).toContain('official/not-installed');
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

  it('requires continuous placements before calling a multi-hop reverse path available', () => {
    const continuous = buildDependencyGraphProjection({
      overviews: chainOverviews(), rootPluginId: 'official/c', direction: 'dependents',
    });
    expect(continuous.rows.find((row) => row.pluginId === 'official/a'))
      .toMatchObject({ relationship: 'indirectAvailable', pathPluginIds: ['official/c', 'official/b', 'official/a'] });

    const discontinuous = buildDependencyGraphProjection({
      overviews: chainOverviews(true), rootPluginId: 'official/c', direction: 'dependents',
    });
    expect(discontinuous.rows.find((row) => row.pluginId === 'official/a')).toMatchObject({
      relationship: 'unknown', pathReferences: [],
    });
  });

  it.each([[80, 24], [60, 18]] as const)(
    'opens unified detail from a selected incoming graph node and restores the graph at %ix%i',
    async (columns, rows) => {
      const controller = new DependencyControllerStub();
      const instance = render(<ConsoleAppV4
        controller={controller as unknown as TuiController} size={{ columns, rows }} />);
      await input(instance, '', '');
      const rootFrame = instance.lastFrame() ?? '';
      await input(instance, '\u001b[A');
      const before = instance.lastFrame() ?? '';
      expect(before).toContain('›');
      expect(before).toContain('当前依赖者');
      expect(before.indexOf('当前依赖者')).toBeLessThan(before.indexOf('◆ 根插件'));
      if (before.includes('右分支')) {
        expect(before.indexOf('◆ 根插件')).toBeLessThan(before.indexOf('右分支'));
      }
      expect((before.match(/◆ 根插件/gu) ?? [])).toHaveLength(1);
      await input(instance, '\r');
      expect(controller.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/consumer' });
      const nodeDetail = instance.lastFrame() ?? '';
      await input(instance, 'b', '', '');
      expect(controller.route).toMatchObject({ name: 'pluginDependencies', pluginId: 'official/root' });
      expect(instance.lastFrame()).toBe(before);
      await writeAcceptanceTrace('graph-navigation', { columns, rows }, {
        root: rootFrame, selectedIncomingNode: before, nodeDetail,
        returnedGraph: instance.lastFrame() ?? '',
      });
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'keeps edge evidence separate from node health and opens its complete Reader at %ix%i',
    async (columns, rows) => {
      const controller = new DependencyControllerStub();
      const instance = render(<ConsoleAppV4
        controller={controller as unknown as TuiController} size={{ columns, rows }} />);
      await input(instance, '', '', '\u001b[A');
      const graphFrame = instance.lastFrame() ?? '';
      expect(graphFrame).toContain('━━▶');
      expect(graphFrame).toContain('[✓ 可用]');
      await input(instance, 'r');
      const firstReaderFrame = instance.lastFrame();
      await input(instance, 'j', 'a', '/', '\r');
      expect(instance.lastFrame()).toBe(firstReaderFrame);
      expect(controller.route.name).toBe('pluginDependencies');
      await input(instance, '?');
      expect(instance.lastFrame()).toContain('当前页快捷键');
      await input(instance, '\r');
      expect(instance.lastFrame()).toBe(firstReaderFrame);
      const evidenceFrames: string[] = [];
      for (let page = 0; page < 40; page += 1) {
        const frame = instance.lastFrame() ?? '';
        evidenceFrames.push(frame);
        const pager = frame.match(/(\d+) \/ (\d+)/u);
        if (pager && pager[1] === pager[2]) break;
        await input(instance, '\u001b[C');
      }
      const evidence = evidenceFrames.join('\n');
      expect(evidence).toContain('pluginId · official/consumer');
      expect(evidence).toContain('目录版本 · 1.0.0');
      expect(evidence).toContain('实际安装版本 0.9.0');
      expect(evidence).toContain('relationship · directAvailable');
      expect(evidence).toContain('图路径 · official/root → official/consumer');
      expect(evidence).toContain('直接边已验证位置 · 1 个');
      expect(evidence).toContain('连续已验证路径 1 · 1 段');
      expect(evidence).toContain('consumer · official/consumer');
      expect(evidence).toContain('dependency · official/root');
      await input(instance, 'b');
      expect(instance.lastFrame()).toBe(graphFrame);
      await input(instance, '\u001b[A');
      const declaredGraph = instance.lastFrame() ?? '';
      expect(declaredGraph).toContain('┄┄▷');
      expect(declaredGraph).toContain('[○ 未安装]');
      await input(instance, 'r');
      const declaredFrames: string[] = [];
      for (let page = 0; page < 20; page += 1) {
        const frame = instance.lastFrame() ?? '';
        declaredFrames.push(frame);
        const pager = frame.match(/(\d+) \/ (\d+)/u);
        if (pager && pager[1] === pager[2]) break;
        await input(instance, '\u001b[C');
      }
      const declaredEvidence = declaredFrames.join('\n');
      expect(declaredEvidence).toContain('目录版本 · 未确认');
      expect(declaredEvidence).toContain('relationship · declared');
      expect(declaredEvidence).toContain('直接边已验证位置 · 0 个');
      expect(declaredEvidence).toContain('连续路径 · 未验证');
      await input(instance, 'b');
      await input(instance, '\r');
      expect(controller.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/not-installed' });
      await writeAcceptanceTrace('graph-references', { columns, rows }, {
        selectedVerifiedEdge: graphFrame,
        verifiedReferenceReaderPages: evidenceFrames,
        selectedDeclaredEdge: declaredGraph,
        declaredReferenceReaderPages: declaredFrames,
        declaredNodeDetail: instance.lastFrame() ?? '',
      });
    },
  );

  it('normalizes a legacy node summary to the same plugin detail', async () => {
    const controller = new DependencyControllerStub();
    controller.route = { name: 'pluginDependencyNode', pluginId: 'official/root',
      nodePluginId: 'official/left', direction: 'dependencies' };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController} size={{ columns: 60, rows: 18 }} />);
    await input(instance, '', '');
    expect(controller.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/left' });
  });

  it('reads both complete long canonical placement references in the historical route', async () => {
    const controller = new DependencyControllerStub();
    const sourceId = 'source-abcdefghijklmnopqrstuvwxy';
    const consumerId = `${sourceId}/consumer-${'c'.repeat(200)}-CONSUMER_END`;
    const dependencyId = `${sourceId}/dependency-${'d'.repeat(200)}-DEPENDENCY_END`;
    controller.dependencies[0]!.pluginId = dependencyId;
    const dependent = controller.dependencies[0]!.dependents[0]!;
    dependent.pluginId = consumerId;
    controller.plugins.splice(0, controller.plugins.length,
      plugin(dependencyId, '根插件'), plugin(consumerId, '当前依赖者'));
    dependent.availablePlacementReferences = [{
      consumer: { pluginId: consumerId, platform: 'codex', scope: 'project', project: 'current' },
      dependency: { pluginId: dependencyId, platform: 'claude', scope: 'user', project: null },
    }, {
      consumer: { pluginId: consumerId, platform: 'claude', scope: 'user', project: null },
      dependency: { pluginId: dependencyId, platform: 'codex', scope: 'project', project: 'current' },
    }];
    controller.route = { name: 'pluginDependencyNode', pluginId: dependencyId,
      nodePluginId: consumerId, direction: 'dependents',
      nodePathPluginIds: [dependencyId, consumerId], view: 'references' };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController} size={{ columns: 60, rows: 18 }} />);
    await input(instance, '', '');
    const frames: string[] = [];
    for (let page = 0; page < 100; page += 1) {
      const frame = instance.lastFrame() ?? '';
      frames.push(frame);
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
      expect(frame).toContain('[y] 复制全文');
      const pager = frame.match(/(\d+) \/ (\d+)/u);
      if (pager && pager[1] === pager[2]) break;
      await input(instance, '\u001b[C');
    }
    const all = frames.join('\n');
    expect(frames.length).toBeGreaterThan(3);
    expect(all).toContain('CONSUMER_END');
    expect(all).toContain('DEPENDENCY_END');
    expect(all).toContain('目录版本 · 1.0.0');
    expect(all).toContain('实际安装版本 0.9.0');
    expect(all).toContain('直接边已验证位置 · 2 个');
    expect(all).toContain('连续已验证路径 1 · 1 段');
    expect(all).toContain('platform=Codex · scope=project');
    expect(all).toContain('platform=Claude Code · scope=user');
    expect(all).toContain('project=current');
    expect(all).toContain('project=none');
  });

  it('keeps the removal blocker route separate from relation browsing', async () => {
    const controller = new DependencyControllerStub();
    controller.route = { name: 'pluginDependencies', pluginId: 'official/root',
      view: 'removeBlocked', platform: 'codex', scope: 'project' };
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController} size={{ columns: 60, rows: 18 }} />);
    await input(instance, '', '');
    expect(instance.lastFrame()).toContain('无法移除');
    expect(instance.lastFrame()).toContain('没有修改任何安装');
  });

  it.each([[80, 24], [60, 18]] as const)(
    'uses the same graph in the portable flow and reads the frozen Skills selection at %ix%i',
    async (columns, rows) => {
      const controller = new DependencyControllerStub();
      controller.route = { name: 'portableDependencies', pluginId: 'official/root' };
      controller.portableDraft = { selectedCount: 1, candidates: [{ selected: true,
        name: '完整审查 Skill', providerDisplayName: '根插件', providerPluginId: 'official/root' }] };
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
        size={{ columns, rows }} />);
      await input(instance, '', '');
      expect(instance.lastFrame()).toContain('使用它的插件 → 当前插件');
      expect(instance.lastFrame()).toContain('◆ 根插件');
      await input(instance, 'p');
      expect(instance.lastFrame()).toContain('完整审查 Skill');
      expect(instance.lastFrame()).toContain('1 /');
      await input(instance, 'b');
      expect(instance.lastFrame()).toContain('◆ 根插件');
    },
  );
});
