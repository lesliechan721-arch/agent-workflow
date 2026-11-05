import { Text } from 'ink';
import { createRequire } from 'node:module';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it } from 'vitest';

import { EntityIdentityCard, PluginDetailCard, ProjectRootCard,
  entityCardWindowHeight, pluginDetailCardLayout, projectRootCardLayout } from '../../src/tui/entity-cards.js';
import type { PluginDetailSubject } from '../../src/tui/plugin-detail.js';
import type { InventoryRoot as ProjectInventoryRoot } from '../../src/tui/scoped-inventory.js';

afterEach(cleanup);

function subject(overrides: Partial<PluginDetailSubject> = {}): PluginDetailSubject {
  return {
    pluginId: 'team/workflow', sourceId: 'team', displayName: '流程助手',
    description: '核对项目中的中文配置与依赖关系。', catalogVersion: '2.0.0',
    definitionAvailable: true, savedConfigScopes: [], placements: [],
    declarations: {
      user: { state: 'unobserved', targets: 'unobserved', agents: [] },
      project: { state: 'unobserved', targets: 'unobserved', agents: [] },
    },
    relations: { outgoing: [], incoming: [], checkState: 'unknown', hasKnownRelations: false },
    ...overrides,
  };
}

function assertWidth(frame: string, columns: number): void {
  expect(frame.split('\n').every((line) => stringWidth(line) <= columns)).toBe(true);
}

function declaredScopes(...scopes: Array<'user' | 'project'>): PluginDetailSubject['declarations'] {
  const declaration = (scope: 'user' | 'project'): PluginDetailSubject['declarations']['user'] => ({
    state: scopes.includes(scope) ? 'declared' : 'not-declared',
    targets: 'selected', agents: ['codex', 'claude', 'cursor'],
  });
  return { user: declaration('user'), project: declaration('project') };
}

function compact(frame: string): string {
  return frame.replace(/ +/gu, ' ');
}

describe('entity cards in the real Ink renderer', () => {
  it('shows a merged scope badge and a human conflict reason in the project list', () => {
    const data = subject({ declarations: declaredScopes('project') });
    const root: ProjectInventoryRoot = { pluginId: data.pluginId, sourceId: data.sourceId,
      displayName: data.displayName, scope: 'project', section: 'declared', state: 'blocked',
      targets: [], dependencies: [], sourceState: 'ready', blockers: [], agentResults: [{
        agent: 'cursor', delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'cursor' },
        content: 'conflict', observation: 'unknown',
        blockers: [{ code: 'targetPlacementConflict', message: 'technical /private/path' }],
      }] };
    const instance = render(<ProjectRootCard root={root} subject={data} width={60} />);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[■ 当前项目]');
    expect(frame).toContain('Cursor');
    expect(frame).toContain('Agent 目录冲突');
    expect(frame).not.toContain('targetPlacementConflict');
    expect(frame).not.toContain('technical /private/path');
    expect(frame).not.toContain('项目需求');
    expect(frame).not.toContain('原生交付');
    assertWidth(frame, 60);
  });
  it('identifies a required installed dependency without offering it as residue', () => {
    const data = subject({ declarations: declaredScopes(), placements: [{
      platform: 'codex', agent: 'codex', scope: 'user', platformLabel: 'Codex', scopeLabel: '所有项目',
      statusState: 'ready', observation: 'known', declared: false, actual: true,
      sharedWithCurrentProject: false, installedVersion: '1.0.0', reasonCodes: [],
    }], relations: { outgoing: [], incoming: [{ pluginId: 'team/root', displayName: 'root',
      declared: true, verified: true }], checkState: 'checked', hasKnownRelations: true } });
    const instance = render(<PluginDetailCard subject={data} width={60} />);
    expect(instance.lastFrame()).toContain('依赖');
    expect(instance.lastFrame()).not.toContain('可清理');
    expect(instance.lastFrame()).toContain('1.0.0');
  });
  it('keeps Native and Portable Agent identities when the table shrinks and grows', () => {
    const data = subject({ declarations: declaredScopes('user'), placements: [{
      platform: 'codex', agent: 'codex', delivery: 'native', scope: 'user',
      platformLabel: 'Codex', scopeLabel: '所有项目', statusState: 'ready', observation: 'known',
      declared: true, actual: true, sharedWithCurrentProject: false, reasonCodes: [],
    }, {
      agent: 'cursor', delivery: 'agent-skills', scope: 'user', platformLabel: 'Cursor',
      scopeLabel: '所有项目', statusState: 'ready', observation: 'known', declared: true, actual: true,
      sharedWithCurrentProject: false, reasonCodes: [],
    }] });
    const instance = render(<PluginDetailCard subject={data} width={80} />);
    const wideFrame = instance.lastFrame() ?? '';
    assertWidth(wideFrame, 80);
    expect(compact(wideFrame)).toContain('Agent 状态 位置 版本');
    expect(compact(wideFrame)).toContain('Codex ✓ 可用 所有项目 —');
    expect(compact(wideFrame)).toContain('Cursor ✓ 可用 所有项目 —');
    expect(wideFrame).toContain('[■ 所有项目]');
    instance.rerender(<PluginDetailCard subject={data} width={60} />);
    const narrowFrame = instance.lastFrame() ?? '';
    assertWidth(narrowFrame, 60);
    expect(compact(narrowFrame)).toContain('Agent 状态 版本');
    expect(compact(narrowFrame)).toContain('Codex ✓ 可用 —');
    expect(compact(narrowFrame)).toContain('Cursor ✓ 可用 —');
    instance.rerender(<PluginDetailCard subject={data} width={80} />);
    expect(compact(instance.lastFrame() ?? '')).toContain('Cursor ✓ 可用 所有项目 —');
  });

  it.each([60, 80])('keeps separate position and version facts at %i columns', (width) => {
    const data = subject({ declarations: declaredScopes('user', 'project'), placements: [{
      platform: 'codex', scope: 'user', platformLabel: 'Codex', scopeLabel: '所有项目',
      statusState: 'ready', observation: 'known', declared: true, actual: true,
      sharedWithCurrentProject: false, installedVersion: '1.5.0', reasonCodes: [],
    }, {
      platform: 'codex', scope: 'project', platformLabel: 'Codex', scopeLabel: '当前项目',
      statusState: 'needsSync', projectState: 'pending', observation: 'unknown',
      declared: true, actual: false,
      sharedWithCurrentProject: false, reasonCodes: [],
    }] });
    const instance = render(<PluginDetailCard subject={data} width={width} />);
    const frame = instance.lastFrame() ?? '';
    assertWidth(frame, width);
    expect(frame).toContain('流程助手');
    expect(frame).toContain('[team]');
    expect(frame).toContain('最新版本 2.0.0');
    expect(frame).toContain('[■ 所有项目]');
    expect(frame).toContain('[□ 当前项目 待安装]');
    expect(compact(frame)).toContain(width >= 76
      ? 'Codex ✓ 可用 所有项目 1.5.0 ↑' : 'Codex ✓ 可用 1.5.0 ↑');
    expect(compact(frame)).toContain(width >= 76
      ? 'Codex ? 未确认 当前项目 —' : 'Codex ? 未确认 —');
    expect(frame).toContain('无法确认安装状态，请查看技术详情');
    expect(frame.split('\n')[0]).toContain('流程助手');
    expect(frame.split('\n')[0]).toContain('[team]');
    expect(frame).not.toContain('› 流程助手');
    const columns = frame.split('\n').find((line) => line.includes('Agent'))!;
    const placement = frame.split('\n').find((line) => line.includes('1.5.0'))!;
    expect(stringWidth(placement.slice(0, placement.indexOf('✓ 可用'))))
      .toBe(stringWidth(columns.slice(0, columns.indexOf('状态'))));
    expect(stringWidth(placement.slice(0, placement.indexOf('1.5.0'))))
      .toBe(stringWidth(columns.slice(0, columns.indexOf('版本'))));
    expect(placement).not.toContain('2.0.0');
    expect(frame).not.toContain('声明期望版本');
    expect(frame.split('\n'), frame).toHaveLength(pluginDetailCardLayout(data, width).fullHeight);
  });

  it.each([60, 80])('keeps unknown distinct from confirmed absent at %i columns', (width) => {
    const data = subject({ description: undefined, catalogVersion: undefined,
      declarations: declaredScopes('project'),
      definitionAvailable: false, savedConfigScopes: ['user'], placements: [{
        platform: 'codex', scope: 'project', platformLabel: 'Codex', scopeLabel: '当前项目',
        statusState: 'absent', observation: 'known', declared: true, actual: false,
        sharedWithCurrentProject: false, reasonCodes: [],
      }, {
        platform: 'claude', scope: 'project', platformLabel: 'Claude Code', scopeLabel: '当前项目',
        observation: 'unknown', declared: true, actual: false,
        sharedWithCurrentProject: false, reasonCodes: [],
      }] });
    const frame = render(<PluginDetailCard subject={data} width={width} />).lastFrame() ?? '';
    assertWidth(frame, width);
    expect(frame).toContain('[! 目录定义当前不可用]');
    expect(frame).toContain('[□ 当前项目 待安装]');
    expect(frame).not.toContain('所有项目');
    expect(compact(frame)).toContain(width >= 76
      ? 'Codex ○ 未安装 当前项目 —' : 'Codex ○ 未安装 —');
    expect(compact(frame)).toContain(width >= 76
      ? 'Claude Code ? 未确认 当前项目 —' : 'Claude Code ? 未确认 —');
    expect(frame).toContain('最新版本 未确认');
    expect(frame).not.toContain('2.0.0');
  });

  it.each([60, 80])('exposes every wrapped fact through a bounded card window at %i columns', (width) => {
    const description = `${'中文宽字符与 longLatinToken0123456789 '.repeat(8)}简介末尾标记`;
    const data = subject({ displayName: `${'名称很长的工作流程检查插件'.repeat(3)}名称末尾标记`,
      sourceId: `${'来源识别符'.repeat(5)}来源末尾标记`, description });
    const layout = pluginDetailCardLayout(data, width);
    expect(layout.sections.find((section) => section.key === 'description')?.height).toBeGreaterThan(2);
    let visited = '';
    for (let offset = 0; offset < layout.factRows; offset += 2) {
      const frame = render(<PluginDetailCard subject={data} width={width}
        lineOffset={offset} lineLimit={2} />).lastFrame() ?? '';
      assertWidth(frame, width);
      visited += frame;
      expect(frame.split('\n')).toHaveLength(entityCardWindowHeight(layout, offset, 2));
    }
    expect(visited).toContain('最新版本 2.0.0');
    expect(visited).toContain('○ 尚未添加');
    expect(visited).toContain('尚无安装结果');
    expect(visited).toContain('名称末尾标记');
    expect(visited.replace(/\s|[│╭╮╰╯─]/gu, '')).toContain('来源末尾标记');
    expect(visited).toContain('简介末尾标记');
    expect(visited).toContain('↑ 前面还有信息');
    expect(visited).toContain('↓ 后面还有信息');
    expect(visited).not.toContain('← 上一页');
    expect(visited).not.toContain('下一页 →');
    expect(layout.sections.at(-1)?.offset).toBeLessThan(layout.factRows);
  });

  it.each([60, 80])('shows one project root with independent mixed targets and proven sharing at %i columns', (width) => {
    const data = subject({ declarations: declaredScopes('project'), placements: [{
      platform: 'codex', scope: 'project', platformLabel: 'Codex', scopeLabel: '当前项目',
      projectState: 'blocked', observation: 'unknown', declared: true, actual: false,
      sharedWithCurrentProject: false, reasonCodes: [],
    }, {
      platform: 'claude', scope: 'project', platformLabel: 'Claude Code', scopeLabel: '当前项目',
      projectState: 'pending', observation: 'known', declared: true, actual: true,
      sharedWithCurrentProject: false, installedVersion: '1.0.0', reasonCodes: [],
    }] });
    const root: ProjectInventoryRoot = {
      pluginId: data.pluginId, sourceId: data.sourceId, displayName: data.displayName,
      section: 'declared', state: 'blocked', targets: [{
        platform: 'codex', scope: 'project', location: 'project', state: 'blocked',
        expectedVersion: '9.9.9', reasonCodes: ['sourceMissing'],
      }, {
        platform: 'claude', scope: 'project', location: 'project', state: 'pending',
        installedVersion: '1.0.0', reasonCodes: [],
      }], dependencies: [{ pluginId: 'team/shared', displayName: '共用依赖', targets: [{
        platform: 'codex', scope: 'user', location: 'sharedUser', state: 'ready',
        installedVersion: '1.0.0', reasonCodes: [],
      }] }],
    };
    const instance = render(<ProjectRootCard root={root} subject={data} width={width} focused />);
    const frame = instance.lastFrame() ?? '';
    assertWidth(frame, width);
    expect(frame.match(/流程助手/gu)).toHaveLength(1);
    expect(frame).toContain('总体状态 [! 受阻]');
    expect(frame).toContain('Codex [当前项目] [项目声明] 安装版本 未确认 [! 受阻]');
    expect(frame).toContain('Claude Code [当前项目] 安装版本 1.0.0 [↻ 待同步]');
    const detailFrame = render(<PluginDetailCard subject={data} width={width} />).lastFrame() ?? '';
    expect(compact(detailFrame)).toContain(width >= 76
      ? 'Codex ! 受阻 当前项目 —' : 'Codex ! 受阻 —');
    expect(compact(detailFrame)).toContain(width >= 76
      ? 'Claude Code ↻ 待同步 当前项目 1.0.0 ↑' : 'Claude Code ↻ 待同步 1.0.0 ↑');
    expect(detailFrame).toContain('[□ 当前项目 待安装]');
    expect(frame).toContain('依赖 共用依赖');
    expect(frame).toContain('共用依赖');
    expect(frame).toContain('共用个人安装');
    expect(frame).not.toContain('9.9.9');
    expect(frame.split('\n')).toHaveLength(projectRootCardLayout(root, data, width).fullHeight);
    const readyRoot: ProjectInventoryRoot = {
      ...root, state: 'ready', targets: [{ ...root.targets[1]!, state: 'ready' }], dependencies: [],
    };
    const readyFrame = render(<ProjectRootCard root={readyRoot} subject={data} width={width} />)
      .lastFrame() ?? '';
    expect(readyFrame).toContain('总体状态 [✓ 就绪]');
    expect(readyFrame).toContain('Claude Code [当前项目] 安装版本 1.0.0 [✓ 可用]');
  });

  it('lets another entity put independent fields in the same identity frame', () => {
    const frame = render(<EntityIdentityCard width={60} title="团队来源">
      <Text>地址 · example.invalid/team</Text>
      <Text>本次检查 · 失败，旧版可用</Text>
    </EntityIdentityCard>).lastFrame() ?? '';
    assertWidth(frame, 60);
    expect(frame).toContain('团队来源');
    expect(frame).toContain('地址 · example.invalid/team');
    expect(frame).toContain('本次检查 · 失败，旧版可用');
  });

  it('uses independent state colors in the Agent table and combined scope badge', async () => {
    const requireFromInk = createRequire(createRequire(import.meta.url).resolve('ink'));
    const chalk = (await import(requireFromInk.resolve('chalk'))).default;
    const previous = chalk.level;
    chalk.level = 3;
    try {
      const data = subject({ declarations: declaredScopes('project'), placements: [{
        platform: 'codex', scope: 'project', platformLabel: 'Codex', scopeLabel: '当前项目',
        projectState: 'blocked', observation: 'known', declared: true, actual: true,
        sharedWithCurrentProject: false, installedVersion: '1.0.0', reasonCodes: [],
      }] });
      const frame = render(<PluginDetailCard subject={data} width={60} />).lastFrame() ?? '';
      const placement = frame.split('\n').find((line) => line.includes('Codex')) ?? '';
      const platformColor = placement.match(/\u001b\[38;2;([\d;]+)mCodex/u)?.[1];
      const scopeColor = frame.match(/\u001b\[38;2;([\d;]+)m *\[□ 当前项目 待安装\]/u)?.[1];
      const statusColor = placement.match(/\u001b\[38;2;([\d;]+)m *! 受阻/u)?.[1];
      expect(platformColor).toBeDefined();
      expect(scopeColor).toBeDefined();
      expect(statusColor).toBeDefined();
      expect(statusColor).not.toBe(platformColor);
      expect(statusColor).not.toBe(scopeColor);
    } finally {
      chalk.level = previous;
    }
  });
});
