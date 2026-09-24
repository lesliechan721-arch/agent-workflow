import stringWidth from 'string-width';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { buildUnifiedDependencyGraphProjection } from '../../src/tui/dependency-graph.js';
import { DependencyGraphView, projectDependencyGraphView } from '../../src/tui/dependency-graph-view.js';
import { ScreenFrame } from '../../src/tui/components.js';
import type { PluginDependencyItemViewModel, PluginDependencyOverviewViewModel } from '../../src/tui/model.js';
import { contentRowBudget } from '../../src/tui/viewport.js';

afterEach(() => cleanup());

const summary = {
  directCount: 0, transitiveCount: 0, totalCount: 0, readyCount: 0, missingCount: 0, issueCount: 0,
};

function item(
  pluginId: string,
  relation: PluginDependencyItemViewModel['relation'],
  requiredBy: string[] = [],
  state: PluginDependencyItemViewModel['aggregateStatus'] = 'ready',
  verified = false,
): PluginDependencyItemViewModel {
  return {
    pluginId,
    displayName: pluginId.split('/')[1]!,
    relation,
    depth: 1,
    requiredBy: requiredBy.map((parent) => ({ pluginId: parent, displayName: parent.split('/')[1]! })),
    placements: [],
    aggregateStatus: state,
    availablePlacementReferences: verified && requiredBy[0] ? [{
      consumer: { pluginId: requiredBy[0], platform: 'codex', scope: 'project', project: 'current' },
      dependency: { pluginId, platform: 'codex', scope: 'project', project: 'current' },
    }] : [],
  };
}

function overview(
  pluginId: string,
  dependencies: PluginDependencyItemViewModel[] = [],
  dependents: PluginDependencyItemViewModel[] = [],
): PluginDependencyOverviewViewModel {
  return { pluginId, summary, dependencies, dependents, blockers: [] };
}

function mixedGraph(): PluginDependencyOverviewViewModel[] {
  return [
    overview('team/root', [
      item('team/ready', 'direct', ['team/root'], 'ready', true),
      item('team/blocked', 'direct', ['team/root'], 'unavailable'),
    ], [item('team/consumer', 'dependent')]),
    overview('team/ready', [item('team/shared', 'direct', ['team/ready'])]),
    overview('team/blocked', [item('team/shared', 'direct', ['team/blocked'])]),
    overview('team/shared', [item('team/root', 'direct', ['team/shared'])]),
  ];
}

function simpleGraph(): PluginDependencyOverviewViewModel[] {
  const consumer = item('team/consumer', 'dependent');
  consumer.displayName = '消费者';
  return [overview('team/root', [
    item('team/ready', 'direct', ['team/root'], 'ready', true),
    item('team/blocked', 'direct', ['team/root'], 'unavailable'),
  ], [consumer])];
}

describe('dependency graph view v8', () => {
  it('keeps declared incoming and cycles visible without granting availability', () => {
    const projection = buildUnifiedDependencyGraphProjection({
      overviews: mixedGraph(), rootPluginId: 'team/root',
      expandedPluginIds: new Set(['team/root', 'team/ready', 'team/blocked', 'team/shared']),
    });
    const declared = projection.rows.find((row) => row.branch === 'dependents'
      && row.pluginId === 'team/consumer');
    const verified = projection.rows.find((row) => row.branch === 'dependencies'
      && row.pluginId === 'team/ready');
    expect(projection.status.state).toBe('invalid');
    expect(declared).toMatchObject({ relationship: 'declared', nodeState: 'ready', pathReferences: [] });
    expect(declared?.edge?.availablePlacementReferences).toEqual([]);
    expect(projection.dependents.scopeSummary.availableConsumerPluginIds).toEqual([]);
    expect(verified).toMatchObject({ relationship: 'directAvailable', nodeState: 'ready' });
    expect(verified?.edge?.availablePlacementReferences).toHaveLength(1);
    expect(projection.rows.filter((row) => row.branch === 'root')).toHaveLength(1);
    expect(projection.rows.some((row) => row.branch === 'dependencies'
      && row.pluginId === 'team/root' && row.sharedWithRowId)).toBe(true);
    expect(projection.rows.some((row) => row.pluginId === 'team/shared' && row.sharedWithRowId)).toBe(true);
    expect(projection.rows.length).toBeLessThan(20);
    const layout = projectDependencyGraphView(projection, { columns: 60, rowBudget: 10 });
    expect(layout.rows.some((row) => row.node.branch === 'dependents'
      && row.node.depth > 1 && row.edgeTarget?.trim().startsWith('rea'))).toBe(true);
    expect(layout.rows.some((row) => row.tree.includes('│'))).toBe(true);
    expect(layout.rows.some((row) => row.node.branch !== 'root'
      && row.node.pluginId === projection.root.pluginId && row.label.startsWith('↩当前'))).toBe(true);
    const referenceRow = layout.rows.find((row) => row.node.branch !== 'root'
      && row.node.pluginId === projection.root.pluginId)!;
    const instance = render(<ScreenFrame size={{ columns: 60, rows: 18 }} title="依赖关系"
      breadcrumb="root / 依赖关系" help="↑↓ 节点 · Enter 查看">
      <DependencyGraphView projection={projection} columns={58} rowBudget={11}
        focusRowId={referenceRow.id} />
    </ScreenFrame>);
    const lines = (instance.lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.every((line) => stringWidth(line) <= 60)).toBe(true);
    expect(instance.lastFrame()).toContain('↩当前');
  });

  it.each([[80, 24], [60, 18]] as const)(
    'renders ordered, independently labeled nodes in a %ix%i frame',
    (columns, terminalRows) => {
      const projection = buildUnifiedDependencyGraphProjection({
        overviews: simpleGraph(), rootPluginId: 'team/root',
      });
      const compact = columns === 60;
      const rowBudget = contentRowBudget({ terminalRows, description: true, compact });
      const first = projectDependencyGraphView(projection, { columns, rowBudget });
      expect(first.rows.map((row) => row.id)).toEqual([
        ...projection.rows.filter((row) => row.branch === 'dependents').map((row) => `dependents:${row.id}`),
        ...projection.rows.filter((row) => row.branch === 'root').map((row) => `root:${row.id}`),
        ...projection.rows.filter((row) => row.branch === 'dependencies').map((row) => `dependencies:${row.id}`),
      ]);
      expect(new Set(first.rows.map((row) => row.id)).size).toBe(projection.rows.length);
      expect(first.rows.map((row) => row.node.branch)).toEqual([
        ...first.rows.filter((row) => row.node.branch === 'dependents').map(() => 'dependents'),
        'root',
        ...first.rows.filter((row) => row.node.branch === 'dependencies').map(() => 'dependencies'),
      ]);
      expect(first.rows.find((row) => row.node.pluginId === 'team/consumer')).toMatchObject({
        edge: '┄┄▷', edgeVerified: false, health: '✓ 可用',
      });
      expect(first.rows.find((row) => row.node.branch === 'dependencies'
        && row.node.pluginId === 'team/ready')).toMatchObject({
        edge: '━━▶', edgeVerified: true, health: '✓ 可用',
      });
      expect(first.rows.find((row) => row.node.branch === 'dependencies'
        && row.node.pluginId === 'team/blocked')).toMatchObject({
        edge: '┄┄▷', edgeVerified: false, health: '! 不可用',
      });
      const frame = (focusRowId: string) => <ScreenFrame size={{ columns, rows: terminalRows }}
        title="依赖关系" description="箭头指向所需插件" breadcrumb="root / 依赖关系"
        help="↑↓ 节点 · ←→ 展开/收起 · Enter 查看">
        <DependencyGraphView projection={projection} columns={columns - 2}
          rowBudget={rowBudget} focusRowId={focusRowId} scrollAnchorRowId={first.scrollAnchorRowId} />
      </ScreenFrame>;
      const instance = render(frame(first.focusRowId));
      const renderedLines = (instance.lastFrame() ?? '').split('\n');
      const consumerIndex = renderedLines.findIndex((line) => line.includes('消费者') && line.includes('┐'));
      const rootLine = renderedLines.find((line) => line.includes('◆ root'))!;
      expect(consumerIndex).toBeGreaterThanOrEqual(0);
      const displayColumn = (line: string, marker: string): number =>
        stringWidth(line.slice(0, line.indexOf(marker)));
      const junctionColumn = displayColumn(renderedLines[consumerIndex]!, '┐');
      expect(renderedLines[consumerIndex + 1]).toContain('│');
      expect(displayColumn(renderedLines[consumerIndex + 1]!, '│')).toBe(junctionColumn);
      expect(displayColumn(rootLine, '◆')).toBe(junctionColumn);
      expect(first.rows[0]?.section).toBe('使用它的插件 → 当前插件');
      expect(first.rows.find((row) => row.node.branch === 'root')?.beforeLines)
        .toEqual(expect.arrayContaining([expect.stringContaining('▼ 需要')]));
      expect(instance.lastFrame()).toContain('┄┄▷');
      expect(instance.lastFrame()).toContain('[✓ 可用]');
      expect(first.rows.filter((row) => row.node.branch === 'root')).toHaveLength(1);
      expect(first.rows.find((row) => row.node.branch === 'dependencies')?.beforeLines)
        .toEqual(expect.arrayContaining([expect.stringContaining('▼ 需要')]));
      for (const row of first.rows) {
        const view = projectDependencyGraphView(projection, {
          columns, rowBudget, focusRowId: row.id, scrollAnchorRowId: first.scrollAnchorRowId,
        });
        expect(view.visibleRows.some((visible) => visible.id === row.id)).toBe(true);
        expect(view.rows[view.focusIndex]?.id).toBe(row.id);
        instance.rerender(frame(row.id));
        const lines = (instance.lastFrame() ?? '').split('\n');
        expect(lines.length).toBeLessThanOrEqual(terminalRows);
        expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true);
      }
    },
  );

  it('keeps deep nodes reachable and normalizes a vanished focus to the root', () => {
    const ids = Array.from({ length: 16 }, (_, index) => `team/deep-${index}`);
    const overviews = ids.map((pluginId, index) => overview(pluginId,
      index + 1 < ids.length ? [item(ids[index + 1]!, 'direct', [pluginId])] : []));
    const projection = buildUnifiedDependencyGraphProjection({
      overviews, rootPluginId: ids[0]!, expandedPluginIds: new Set(ids),
    });
    const initial = projectDependencyGraphView(projection, { columns: 60, rowBudget: 10 });
    expect(initial.rows).toHaveLength(16);
    for (const row of initial.rows) {
      const view = projectDependencyGraphView(projection, {
        columns: 60, rowBudget: 10, focusRowId: row.id,
      });
      expect(view.visibleRows.some((visible) => visible.id === row.id)).toBe(true);
    }
    const vanished = projectDependencyGraphView(projection, {
      columns: 60, rowBudget: 10, focusRowId: 'dependencies:team/gone',
    });
    expect(vanished.rows.find((row) => row.id === vanished.focusRowId)?.node.branch).toBe('root');
  });
});
