import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import {
  InputDisplay,
  removeLastGrapheme,
  renderInputTail,
} from '../../src/tui/input-display.js';

describe('TUI input display', () => {
  it('places an empty input cursor before the placeholder and keeps actual cursor editing independent', () => {
    const view = render(<InputDisplay value="" placeholder="名称或来源" cursor={0} columns={11} />);
    expect(view.lastFrame()).toBe('▌名称或来源');
    const editing = render(<InputDisplay value="中文" placeholder="名称或来源" cursor={1} columns={10} />);
    expect(editing.lastFrame()).toBe('中▌文');
    const narrow = render(<InputDisplay value="" placeholder="名称或来源的长提示" columns={7} />);
    expect(narrow.lastFrame()).toMatch(/^▌名称/u);
    expect(stringWidth(narrow.lastFrame()!)).toBeLessThanOrEqual(7);
  });

  it('keeps a static cursor visible and clips a long CJK value by terminal width', () => {
    expect(renderInputTail('前部中文abcdef', 9)).toBe('…abcdef');
    const view = render(<InputDisplay value="前部中文abcdef" columns={10} />);
    expect(view.lastFrame()).toBe('…文abcdef▌');
  });

  it('masks a sensitive value before rendering the cursor', () => {
    const view = render(<InputDisplay value="机密secret" sensitive columns={10} />);
    expect(view.lastFrame()).toBe('••••••••▌');
    expect(view.lastFrame()).not.toContain('机密');
    expect(view.lastFrame()).not.toContain('secret');
  });

  it.each([
    ['emoji', 'A😀'],
    ['flag', 'A🇨🇳'],
    ['family ZWJ', 'A👨‍👩‍👧‍👦'],
    ['combining', 'Ae\u0301'],
    ['CJK', 'A中'],
  ])('removes one complete %s grapheme', (_label, value) => {
    expect(removeLastGrapheme(value)).toBe('A');
  });

  it.each([60, 80])('keeps complex graphemes and the cursor within %i columns', (columns) => {
    const value = `${'前'.repeat(40)}😀🇨🇳👨‍👩‍👧‍👦e\u0301中文`;
    const view = render(<InputDisplay value={value} columns={columns} />);
    const frame = view.lastFrame()!;
    expect(frame).toContain('▌');
    expect(stringWidth(frame)).toBeLessThanOrEqual(columns);
    expect(frame.split('\n')).toHaveLength(1);
    expect(frame).toMatch(/….*😀🇨🇳👨‍👩‍👧‍👦é中文▌$/u);
  });
});
