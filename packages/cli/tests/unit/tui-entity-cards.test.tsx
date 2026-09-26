import { Text } from 'ink';
import { createRequire } from 'node:module';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it } from 'vitest';

import { EntityIdentityCard, PluginDetailCard, ProjectRootCard,
  entityCardWindowHeight, pluginDetailCardLayout, projectRootCardLayout } from '../../src/tui/entity-cards.js';
import type { PluginDetailSubject } from '../../src/tui/plugin-detail.js';
import type { ProjectInventoryRoot } from '../../src/tui/project-inventory.js';

afterEach(cleanup);

function subject(overrides: Partial<PluginDetailSubject> = {}): PluginDetailSubject {
  return {
    pluginId: 'team/workflow', sourceId: 'team', displayName: '流程助手',
    description: '核对项目中的中文配置与依赖关系。', catalogVersion: '2.0.0',
    definitionAvailable: true, savedConfigScopes: [], placements: [],
    relations: { outgoing: [], incoming: [], checkState: 'unknown', hasKnownRelations: false },
    ...overrides,
  };
}

function assertWidth(frame: string, columns: number): void {
  expect(frame.split('\n').every((line) => stringWidth(line) <= columns)).toBe(true);
}

describe('entity cards in the real Ink renderer', () => {
  it.each([60, 80])('keeps separate position and version facts at %i columns', (width) => {
    const data = subject({ placements: [{
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
    expect(frame).toContain('目录版本 2.0.0');
    expect(frame.replace(/ +/gu, ' ')).toContain('Codex [所有项目] 安装版本 1.5.0 [✓ 可用]');
    expect(frame.replace(/ +/gu, ' ')).toContain('Codex [当前项目] [项目声明] 安装版本 未确认 [? 未确认]');
    expect(frame.split('\n')[0]).toContain('流程助手');
    expect(frame.split('\n')[0]).toContain('[team]');
    expect(frame).not.toContain('› 流程助手');
    const placement = frame.split('\n').find((line) => line.includes('1.5.0'))!;
    expect(stringWidth(placement.slice(0, placement.indexOf('[✓ 可用]'))))
      .toBe(width - stringWidth('[✓ 可用]') - 2);
    expect(frame).not.toContain('声明期望版本');
    expect(frame.split('\n')).toHaveLength(pluginDetailCardLayout(data, width).fullHeight);
  });

  it.each([60, 80])('keeps unknown distinct from confirmed absent at %i columns', (width) => {
    const data = subject({ description: undefined, catalogVersion: undefined,
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
    expect(frame).toContain('已保存设置 所有项目');
    expect(frame.replace(/ +/gu, ' ')).toContain('Codex [当前项目] [项目声明] [○ 未安装]');
    expect(frame.replace(/[│\s]/gu, '')).toContain('ClaudeCode[当前项目][项目声明]安装版本未确认[?未确认]');
    const unknown = frame.split('\n').find((line) => line.includes('[? 未确认]'))!;
    expect(stringWidth(unknown.slice(0, unknown.indexOf('[? 未确认]'))))
      .toBe(width - stringWidth('[? 未确认]') - 2);
    expect(frame).not.toContain('安装版本 2.0.0');
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
    expect(visited).toContain('目录版本 2.0.0');
    expect(visited.replace(/ +/gu, ' ')).toContain('使用位置 [? 未确认]');
    expect(visited).toContain('名称末尾标记');
    expect(visited.replace(/\s|[│╭╮╰╯─]/gu, '')).toContain('来源末尾标记');
    expect(visited).toContain('简介末尾标记');
    expect(visited).toContain('← 上一页');
    expect(visited).toContain('下一页 →');
    const pages = Math.ceil(layout.factRows / 2);
    expect(visited).toContain(`${pages} / ${pages}`);
    expect(layout.sections.at(-1)?.offset).toBeLessThan(layout.factRows);
  });

  it.each([60, 80])('shows one project root with independent mixed targets and proven sharing at %i columns', (width) => {
    const data = subject({ placements: [{
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
    expect(detailFrame.replace(/ +/gu, ' ')).toContain('Codex [当前项目] [项目声明] 安装版本 未确认 [! 受阻]');
    expect(detailFrame.replace(/ +/gu, ' ')).toContain('Claude Code [当前项目] 安装版本 1.0.0 [↻ 待同步]');
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

  it('colors only status badges while platform and scope retain their own roles', async () => {
    const requireFromInk = createRequire(createRequire(import.meta.url).resolve('ink'));
    const chalk = (await import(requireFromInk.resolve('chalk'))).default;
    const previous = chalk.level;
    chalk.level = 3;
    try {
      const data = subject({ placements: [{
        platform: 'codex', scope: 'project', platformLabel: 'Codex', scopeLabel: '当前项目',
        projectState: 'blocked', observation: 'known', declared: true, actual: true,
        sharedWithCurrentProject: false, installedVersion: '1.0.0', reasonCodes: [],
      }] });
      const frame = render(<PluginDetailCard subject={data} width={60} />).lastFrame() ?? '';
      const placement = frame.split('\n').find((line) => line.includes('Codex')) ?? '';
      const platformColor = placement.match(/\u001b\[38;2;([\d;]+)mCodex/u)?.[1];
      const scopeColor = placement.match(/\u001b\[38;2;([\d;]+)m \[当前项目\]/u)?.[1];
      const statusColor = placement.match(/\u001b\[38;2;([\d;]+)m +\[! 受阻\]/u)?.[1];
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
