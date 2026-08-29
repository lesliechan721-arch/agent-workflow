import { Text } from 'ink';
import stringWidth from 'string-width';

import { tuiTheme } from './theme.js';

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
    .map((part) => part.segment);
}

export function removeLastGrapheme(value: string): string {
  return graphemes(value).slice(0, -1).join('');
}

export function renderInputTail(value: string, columns: number): string {
  const textColumns = Math.max(0, columns - stringWidth('▌'));
  if (textColumns === 0) return '';
  const parts = graphemes(value);
  if (stringWidth(value) <= textColumns) return value;
  const tailColumns = Math.max(0, textColumns - stringWidth('…'));
  let used = 0;
  let start = parts.length;
  while (start > 0) {
    const width = stringWidth(parts[start - 1]!);
    if (used + width > tailColumns) break;
    used += width;
    start -= 1;
  }
  return `…${parts.slice(start).join('')}`;
}

export function InputDisplay(props: {
  value: string;
  columns: number;
  sensitive?: boolean;
  placeholder?: string;
}): React.JSX.Element {
  const value = props.sensitive ? '•'.repeat(graphemes(props.value).length) : props.value;
  const visible = renderInputTail(value || props.placeholder || '', props.columns);
  return <Text>{visible}<Text color={tuiTheme.colors.accent}>▌</Text></Text>;
}
