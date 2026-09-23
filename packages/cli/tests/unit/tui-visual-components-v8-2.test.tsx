import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it } from 'vitest';

import {
  diagnosticDetailLines,
  diagnosticDetailText,
  ObjectCardRow,
  objectCardRowLayout,
  PluginListRow,
  pluginListRowLayout,
  StatusBadge,
} from '../../src/tui/components.js';
import type { DiagnosticSummaryViewModel } from '../../src/tui/diagnostics.js';

afterEach(() => cleanup());

const badges = [
  { key: 'codex', label: 'Codex', symbol: '✓' as const, status: 'success' as const },
  { key: 'claude', label: 'Claude Code', symbol: '○' as const, status: 'muted' as const },
  { key: 'problem', label: '异常', symbol: '!' as const, status: 'warning' as const },
  { key: 'update', label: '更新', symbol: '↑' as const, status: 'info' as const },
  { key: 'unknown', label: '待检查', symbol: '?' as const, status: 'muted' as const },
];

describe('TUI v8.2 shared visual components', () => {
  it.each([
    { width: 60, compact: false },
    { width: 60, compact: true },
    { width: 80, compact: false },
  ])('renders a complete object card with its calculated height at width $width, compact=$compact', ({ width, compact }) => {
    const description = '来源检查失败，但已验证的旧目录仍然可用。';
    const meta = 'github.com/example/a-very-long-catalog-address/release';
    const layout = objectCardRowLayout({
      width,
      description,
      meta,
      hasTags: true,
      compact,
    });
    const instance = render(<ObjectCardRow
      width={width}
      title="团队插件来源"
      description={description}
      meta={meta}
      tags={<StatusBadge items={badges.slice(0, 2)} />}
      focused
      compact={compact}
    />);
    const frame = instance.lastFrame() ?? '';

    expect(frame.split('\n')).toHaveLength(layout.height);
    expect(frame).toContain('› 团队插件来源');
    expect(frame.split('\n')[0]).toContain('› 团队插件来源');
    expect(frame).toContain('[✓ Codex]');
    expect(frame).toContain('[○ Claude Code]');
    expect(frame).toContain('来源检查失败');
    expect(frame).toContain('github.com/example');
    expect(frame.match(/╭/g)).toHaveLength(1);
    expect(frame.match(/╰/g)).toHaveLength(1);
  });

  it('renders each supported badge symbol and accepts a composed node', () => {
    const structured = render(<StatusBadge items={badges} />).lastFrame() ?? '';
    const composed = render(<StatusBadge><StatusBadge items={[badges[0]!]} /></StatusBadge>).lastFrame() ?? '';

    expect(structured).toContain('[✓ Codex]');
    expect(structured).toContain('[○ Claude Code]');
    expect(structured).toContain('[! 异常]');
    expect(structured).toContain('[↑ 更新]');
    expect(structured).toContain('[? 待检查]');
    expect(composed).toContain('[✓ Codex]');
  });

  it('counts explicit source description lines in the object card height', () => {
    expect(objectCardRowLayout({
      width: 60,
      description: 'Git · github.com/example/catalog\n当前 2.4.0 → 2.5.0\n检查：失败，旧目录仍可用',
      hasTags: true,
    })).toMatchObject({ height: 6, descriptionLines: [
      'Git · github.com/example/catalog',
      '当前 2.4.0 → 2.5.0',
      '检查：失败，旧目录仍可用',
    ] });
  });

  it('measures a card without summary text using its actual border rows', () => {
    const frame = render(<ObjectCardRow width={58} title="检查来源" description="" />).lastFrame() ?? '';

    expect(frame.split('\n')).toHaveLength(objectCardRowLayout({ width: 58, description: '' }).height);
  });

  it('uses structured plugin tags without repeating the legacy aggregate status', () => {
    const frame = render(<PluginListRow
      name="Review Gate"
      sourceLabel="团队"
      description="团队审查和风险检查"
      placementSummary="当前项目"
      status="success"
      statusLabel="已安装到所有平台"
      tags={<StatusBadge items={badges.slice(0, 2)} />}
    />).lastFrame() ?? '';

    expect(frame).toContain('[✓ Codex]');
    expect(frame).toContain('[○ Claude Code]');
    expect(frame).not.toContain('已安装到所有平台');
    expect(frame.split('\n').find((line) => line.includes('[✓ Codex]'))).toContain('团队');
  });

  it('uses tags in place of an empty plugin placement row', () => {
    const frame = render(<PluginListRow
      name="Review Gate"
      sourceLabel="团队"
      description="团队审查和风险检查"
      tags={<StatusBadge items={badges.slice(0, 2)} />}
    />).lastFrame() ?? '';

    expect(frame.split('\n')).toHaveLength(4);
    expect(frame).toContain('[✓ Codex]');
    expect(frame).toContain('[○ Claude Code]');
  });

  it.each([58, 78])('keeps a short CJK plugin summary complete with its measured height at %i columns', (width) => {
    const description = '按当前项目的需求选择检查方式，并保留每个任务的模型与推理设置。';
    const attention = '当前来源需要检查，已安装内容保持可用。';
    const layout = pluginListRowLayout({ width, description, attention, hasTags: true, sourceLabel: '团队' });
    const frame = render(<PluginListRow
      width={width}
      name="团队审查 👩‍💻 Review Gate"
      sourceLabel="团队"
      description={description}
      attention={attention}
      tags={<StatusBadge items={badges.slice(0, 2)} />}
      focused
    />).lastFrame() ?? '';
    const lines = frame.split('\n');
    const descriptionText = lines.slice(1, 1 + layout.descriptionLines.length)
      .map((line) => line.slice(1, -1).trim()).join('');

    expect(descriptionText).toBe(description);
    expect(lines).toHaveLength(layout.height);
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
    expect(lines[0]).toContain('╭─ › 团队审查 👩‍💻 Review Gate');
    expect(lines.find((line) => line.includes('[✓ Codex]'))).toContain('团队');
  });

  it('keeps a long card title within its border and puts source metadata beside badges', () => {
    const width = 58;
    const frame = render(<ObjectCardRow
      width={width}
      title={'插件来源 👩‍💻 '.repeat(12)}
      description="来源可用"
      sourceLabel="catalog/stable"
      tags={<StatusBadge items={badges.slice(0, 2)} />}
    />).lastFrame() ?? '';
    const lines = frame.split('\n');

    expect(lines[0]).toMatch(/^╭─ .*╮$/u);
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
    expect(lines.find((line) => line.includes('[✓ Codex]'))).toContain('catalog/stable');
    expect(lines).toHaveLength(objectCardRowLayout({
      width, description: '来源可用', hasTags: true, sourceLabel: 'catalog/stable',
    }).height);
  });

  it.each([58, 78])('bounds long plugin summaries while keeping status and source visible at %i columns', (width) => {
    const description = '这是合法的插件用途说明。 👩‍💻 LongPluginDescriptionWithoutSpaces'.repeat(24);
    const attention = `依赖 team/${'dependency'.repeat(12)}未就绪；影响 team/${'consumer'.repeat(12)}。`;
    const layout = pluginListRowLayout({ width, description, attention, hasTags: true, sourceLabel: '团队' });
    const frame = render(<PluginListRow
      width={width}
      name="Review Gate"
      sourceLabel="团队"
      description={description}
      attention={attention}
      tags={<StatusBadge items={badges.slice(0, 2)} />}
    />).lastFrame() ?? '';

    expect(layout.descriptionLines).toHaveLength(2);
    expect(layout.descriptionLines[1]).toMatch(/…$/u);
    expect(layout.attentionLines).toHaveLength(2);
    expect(layout.attentionLines[1]).toMatch(/…$/u);
    expect(frame.split('\n')).toHaveLength(layout.height);
    expect(frame.split('\n').every((line) => stringWidth(line) <= width)).toBe(true);
    expect(frame.split('\n').at(-2)).toContain('[✓ Codex]');
    expect(frame.split('\n').at(-2)).toContain('团队');
    expect(layout.height).toBe(7);
  });

  it.each([58, 78])('bounds batch card descriptions only when requested at %i columns', (width) => {
    const description = '👩‍💻 配置检查说明与可选择任务'.repeat(24);
    const options = { width, description, hasTags: true, sourceLabel: '团队', compact: true };
    const layout = objectCardRowLayout({ ...options, maxDescriptionRows: 2 });
    const frame = render(<ObjectCardRow
      {...options}
      title="[x] Review Gate"
      maxDescriptionRows={2}
      tags={<StatusBadge items={badges.slice(0, 2)} />}
    />).lastFrame() ?? '';

    expect(layout.descriptionLines).toHaveLength(2);
    expect(layout.descriptionLines[1]).toMatch(/…$/u);
    expect(frame.split('\n')).toHaveLength(layout.height);
    expect(frame.split('\n').every((line) => stringWidth(line) <= width)).toBe(true);
    expect(frame.split('\n').at(-2)).toContain('[✓ Codex]');
    expect(frame.split('\n').at(-2)).toContain('团队');
    expect(objectCardRowLayout(options).descriptionLines.join('')).toBe(description);
  });

  it('keeps all bounded multi-platform badges on the object card at 60 columns', () => {
    const platformBadges = [
      { key: 'codex', label: 'Codex ! ↑', symbol: '✓' as const, status: 'warning' as const },
      { key: 'claude', label: 'Claude Code ! ↑', symbol: '✓' as const, status: 'warning' as const },
      { key: 'skills', label: 'Skills 可选', symbol: '?' as const, status: 'info' as const },
    ];
    const frame = render(<PluginListRow
      width={58}
      name="Review Gate"
      sourceLabel="官方"
      description="团队审查和风险检查"
      tags={<StatusBadge items={platformBadges} />}
    />).lastFrame() ?? '';
    const badgeLine = frame.split('\n').find((line) => line.includes('[✓ Codex ! ↑]')) ?? '';

    expect(stringWidth('[✓ Codex ! ↑] [✓ Claude Code ! ↑] [? Skills 可选]')).toBeLessThanOrEqual(58);
    expect(badgeLine).toContain('[✓ Codex ! ↑]');
    expect(badgeLine).toContain('[✓ Claude Code ! ↑]');
    expect(badgeLine).toContain('[? Skills 可选]');
    expect(badgeLine).toContain('官方');
  });

  it('wraps every safe diagnostic field by display width without losing long values', () => {
    const requestedRef = 'refs/heads/releases/with-a-shared-prefix-but-distinct-tail-a';
    const resolvedCommit = '0123456789abcdef0123456789abcdef01234567';
    const cause = '已验证缓存不可用，请检查来源后重试完整安全值。';
    const diagnostic: DiagnosticSummaryViewModel = {
      severity: 'error',
      title: '来源不可用',
      userMessage: '无法读取来源。',
      impact: [],
      nextStep: '检查来源。',
      technical: {
        code: 'catalogSourceUnavailable',
        requestedRef,
        resolvedCommit,
        sanitizedCause: cause,
      },
    };
    const width = 28;
    const lines = diagnosticDetailLines(diagnostic, width);
    const rebuild = (label: string): string => lines
      .filter((line) => line.startsWith(`${label}: `))
      .map((line) => line.slice(`${label}: `.length))
      .join('');

    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
    expect(rebuild('requested ref')).toBe(requestedRef);
    expect(rebuild('resolved commit')).toBe(resolvedCommit);
    expect(rebuild('cause')).toBe(cause);
    expect(lines.filter((line) => line.startsWith('requested ref: ')).length).toBeGreaterThan(1);
    expect(diagnosticDetailText(diagnostic).split('\n')).toEqual([
      'code: catalogSourceUnavailable',
      `requested ref: ${requestedRef}`,
      `resolved commit: ${resolvedCommit}`,
      `cause: ${cause}`,
    ]);
  });
});
