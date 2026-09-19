import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it } from 'vitest';

import {
  diagnosticDetailLines,
  ObjectCardRow,
  objectCardRowLayout,
  PluginListRow,
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
    })).toMatchObject({ height: 7, descriptionLines: [
      'Git · github.com/example/catalog',
      '当前 2.4.0 → 2.5.0',
      '检查：失败，旧目录仍可用',
    ] });
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
  });

  it('uses tags in place of an empty plugin placement row', () => {
    const frame = render(<PluginListRow
      name="Review Gate"
      sourceLabel="团队"
      description="团队审查和风险检查"
      tags={<StatusBadge items={badges.slice(0, 2)} />}
    />).lastFrame() ?? '';

    expect(frame.split('\n')).toHaveLength(5);
    expect(frame).toContain('[✓ Codex]');
    expect(frame).toContain('[○ Claude Code]');
  });

  it('keeps all bounded multi-platform badges on the object card at 60 columns', () => {
    const platformBadges = [
      { key: 'codex', label: 'Codex ! ↑', symbol: '✓' as const, status: 'warning' as const },
      { key: 'claude', label: 'Claude Code ! ↑', symbol: '✓' as const, status: 'warning' as const },
      { key: 'skills', label: 'Skills 可选', symbol: '?' as const, status: 'info' as const },
    ];
    const frame = render(<ObjectCardRow
      width={60}
      title="Review Gate"
      description="团队审查和风险检查"
      tags={<StatusBadge items={platformBadges} />}
      compact
    />).lastFrame() ?? '';
    const badgeLine = frame.split('\n').find((line) => line.includes('[✓ Codex ! ↑]')) ?? '';

    expect(stringWidth('[✓ Codex ! ↑] [✓ Claude Code ! ↑] [? Skills 可选]')).toBeLessThanOrEqual(58);
    expect(badgeLine).toContain('[✓ Codex ! ↑]');
    expect(badgeLine).toContain('[✓ Claude Code ! ↑]');
    expect(badgeLine).toContain('[? Skills 可选]');
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
  });
});
