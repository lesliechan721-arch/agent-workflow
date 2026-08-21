export type TuiLayoutMode = 'single-column' | 'compact' | 'too-small';

export const TUI_STANDARD_COLUMNS = 80;
export const TUI_STANDARD_ROWS = 24;
export const TUI_MINIMUM_COLUMNS = 60;
export const TUI_MINIMUM_ROWS = 18;

export interface TuiSizePolicy {
  mode: TuiLayoutMode;
  columns: number;
  rows: number;
  message?: string;
}

export function resolveTuiSizePolicy(columns: number, rows: number): TuiSizePolicy {
  if (columns < TUI_MINIMUM_COLUMNS || rows < TUI_MINIMUM_ROWS) {
    return {
      mode: 'too-small',
      columns,
      rows,
      message: '终端空间不足。请将终端调整到至少 60 列 × 18 行。',
    };
  }

  if (columns >= TUI_STANDARD_COLUMNS && rows >= TUI_STANDARD_ROWS) {
    return { mode: 'single-column', columns, rows };
  }

  return { mode: 'compact', columns, rows };
}
