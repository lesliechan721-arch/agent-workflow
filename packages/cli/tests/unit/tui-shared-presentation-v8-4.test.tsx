import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionRow, DiagnosticSummary } from '../../src/tui/components.js';
import type { DiagnosticSummaryViewModel } from '../../src/tui/diagnostics.js';
import { QueryHeader } from '../../src/tui/query-header.js';
import { Reader, readerBodyRows, readerPage } from '../../src/tui/reader.js';

afterEach(() => cleanup());

describe('TUI shared presentation', () => {
  it('renders a white action label while keeping status independent and disabled text muted', () => {
    const active = render(<ActionRow title="恢复正常" status="warning" focused meta="待同步" />).lastFrame() ?? '';
    const disabled = render(<ActionRow title="不可安装" status="error" disabled="来源不可用" />).lastFrame() ?? '';

    expect(active).toContain('› 恢复正常');
    expect(active).toContain('待同步');
    if (active.includes('\u001b[')) {
      expect(active).toMatch(/\u001b\[38;2;230;237;243m[^\n]*恢复正常/u);
      expect(active).toMatch(/\u001b\[38;2;242;204;96m[^\n]*! 待同步/u);
      expect(disabled).toMatch(/\u001b\[38;2;139;150;165m[^\n]*不可安装/u);
    }
    expect(disabled).toContain('来源不可用');
  });

  it('renders only present query slots in fixed order and preserves injected cursor display', () => {
    const frame = render(<QueryHeader width={58}
      tabs={{ label: '来源', items: [{ id: 'all', label: '全部来源' }, { id: 'official', label: '官方' }], currentId: 'official' }}
      search={{ value: 'ABC', input: <Text>A│BC</Text> }}
      filter={{ label: '需处理', count: 0, currentZero: true }}
      selection={{ total: 5, hidden: 2 }}
    />).lastFrame() ?? '';
    const lines = frame.split('\n');

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('来源');
    expect(lines[1]).toContain('A│BC');
    expect(lines[2]).toContain('当前条件无匹配');
    expect(lines[3]).toContain('隐藏已选 2');
    expect(lines.every((line) => stringWidth(line) <= 58)).toBe(true);
    const searchOnly = render(<QueryHeader width={58} search={{ value: '' }} />).lastFrame() ?? '';
    expect(searchOnly.split('\n')).toHaveLength(1);
    expect(render(<QueryHeader width={58} />).lastFrame()).toBe('');
  });

  it('keeps the tab keycap visible with a long current label at 60 columns', () => {
    const frame = render(<QueryHeader width={58} tabs={{ label: '类型', currentId: 'long', items: [
      { id: 'short', label: '全部' },
      { id: 'long', label: '非常长的内容类型标签'.repeat(8) },
      { id: 'next', label: '下一项' },
    ] }} />).lastFrame() ?? '';

    expect(frame).toContain('非常长');
    expect(frame.replaceAll(/\u001b\[[\d;]*m/gu, '')).toContain('[←→] 切换');
    expect(stringWidth(frame)).toBeLessThanOrEqual(58);
  });

  it('wraps wide text before paging, reaches the last marker, and clamps resize and empty pages', () => {
    const text = `${'中文👩‍💻 LongLineWithoutSpaces'.repeat(18)}\nEND-OF-SAFE-DETAIL`;
    const first = readerPage({ text, columns: 28, rows: 3, page: 1 });
    const all = Array.from({ length: first.pageCount }, (_, index) => readerPage({
      text, columns: 28, rows: 3, page: index + 1,
    }));
    const last = all.at(-1)!;

    expect(first.pageCount).toBeGreaterThan(3);
    expect(first.hasPrevious).toBe(false);
    expect(last.hasNext).toBe(false);
    expect(all.flatMap((page) => page.lines).join('').replaceAll('\n', '')).toBe(text.replaceAll('\n', ''));
    expect(last.lines.at(-1)).toBe('END-OF-SAFE-DETAIL');
    expect(all.every((page) => page.lines.every((line) => stringWidth(line) <= 28))).toBe(true);
    expect(readerPage({ text, columns: 58, rows: 11, page: 999 }).page).toBe(
      readerPage({ text, columns: 58, rows: 11 }).pageCount,
    );
    expect(readerPage({ text: '', columns: 58, rows: 11 })).toMatchObject({ page: 1, pageCount: 1,
      hasPrevious: false, hasNext: false });
    expect(readerBodyRows({ terminalRows: 24 })).toBe(18);
    expect(readerBodyRows({ terminalRows: 18, compact: true })).toBe(11);
  });

  it('renders horizontal pager state and content at the 60-column body budget', () => {
    const text = Array.from({ length: 26 }, (_, index) => `记录 ${index + 1}`).join('\n');
    const frame = render(<Reader text={text} columns={58} rows={11} page={3} />).lastFrame() ?? '';

    expect(frame).toContain('记录 26');
    expect(frame).toContain('3 / 3');
    expect(frame).toContain('← 上一页');
    expect(frame).toContain('下一页 →');
    expect(frame.split('\n').length).toBeLessThanOrEqual(12);
    expect(frame.split('\n').every((line) => stringWidth(line) <= 58)).toBe(true);
  });

  it('uses the same horizontal pager for technical diagnostic pages', () => {
    const diagnostic: DiagnosticSummaryViewModel = {
      severity: 'error', title: '来源问题', userMessage: '无法读取来源', impact: [], nextStep: '检查来源',
      technical: { code: 'sourceUnavailable', stage: 'fetch', sourceId: 'official',
        checks: ['检查网络', '重试'] },
    };
    const frame = render(<DiagnosticSummary diagnostic={diagnostic} technical columns={60} offset={2}
      limit={2} />).lastFrame() ?? '';

    expect(frame).toContain('2 / 3');
    expect(frame).toContain('← 上一页');
    expect(frame).toContain('下一页 →');
    expect(frame).not.toContain('前面还有');
    expect(frame).not.toContain('后面还有');
  });
});
