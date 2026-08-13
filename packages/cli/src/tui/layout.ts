export type TuiLayoutMode = 'three-column' | 'single-column' | 'too-small';

export interface TuiSizePolicy {
  mode: TuiLayoutMode;
  columns: number;
  rows: number;
  message?: string;
}

export function resolveTuiSizePolicy(columns: number, rows: number): TuiSizePolicy {
  if (columns >= 110 && rows >= 18) {
    return { mode: 'three-column', columns, rows };
  }

  if (columns >= 60 && rows >= 16) {
    return { mode: 'single-column', columns, rows };
  }

  return {
    mode: 'too-small',
    columns,
    rows,
    message: '终端空间不足。请调整到至少 60 列 × 16 行。',
  };
}
