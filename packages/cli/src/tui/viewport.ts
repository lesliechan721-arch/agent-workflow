import stringWidth from 'string-width';

export interface RowViewport {
  offset: number;
  limit: number;
  hiddenBefore: number;
  hiddenAfter: number;
  position: number;
  total: number;
}

export function wrapDisplayText(value: string, columns: number): string[] {
  const width = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return value.split('\n').flatMap((sourceLine) => {
    const lines: string[] = [];
    let line = '';
    let lineWidth = 0;
    for (const { segment } of segmenter.segment(sourceLine)) {
      const segmentWidth = stringWidth(segment);
      if (line && lineWidth + segmentWidth > width) {
        lines.push(line);
        line = '';
        lineWidth = 0;
      }
      line += segment;
      lineWidth += segmentWidth;
    }
    if (line || lines.length === 0) lines.push(line);
    return lines;
  });
}

export function contentRowBudget(options: {
  terminalRows: number;
  description: boolean;
  compact: boolean;
  staticRows?: number;
}): number {
  const frameRows = 2 + 1 + (options.description ? 1 : 0) + (options.compact ? 3 : 2);
  return Math.max(1, options.terminalRows - frameRows - (options.staticRows ?? 0));
}

export function rowViewport(options: {
  rowHeights: number[];
  focus: number;
  requestedOffset: number;
  rowBudget: number;
}): RowViewport {
  const total = options.rowHeights.length;
  if (total === 0) {
    return { offset: 0, limit: 0, hiddenBefore: 0, hiddenAfter: 0, position: 0, total: 0 };
  }
  const focus = Math.min(Math.max(0, options.focus), total - 1);
  const height = (start: number, end: number): number =>
    options.rowHeights.slice(start, end).reduce((sum, rowHeight) => sum + rowHeight, 0);
  let offset = Math.min(Math.max(0, options.requestedOffset), focus);
  while (offset < focus && height(offset, focus + 1) > options.rowBudget) offset += 1;
  let end = focus + 1;
  while (end < total && height(offset, end + 1) <= options.rowBudget) end += 1;
  while (offset > 0 && height(offset - 1, end) <= options.rowBudget) offset -= 1;
  return {
    offset,
    limit: end - offset,
    hiddenBefore: offset,
    hiddenAfter: total - end,
    position: focus + 1,
    total,
  };
}
