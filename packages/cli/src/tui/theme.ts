export const tuiTheme = {
  colors: {
    background: '#0c1117',
    panelBackground: '#0f161e',
    inputBackground: '#101720',
    selectionBackground: '#162b2f',
    text: '#e6edf3',
    muted: '#8b96a5',
    border: '#34404d',
    borderStrong: '#445160',
    accent: '#59d8cc',
    success: '#7ee787',
    warning: '#f2cc60',
    danger: '#ff7b72',
    info: '#79c0ff',
  },
  roles: {
    primaryValue: '#e6edf3',
    label: '#e6edf3',
    secondary: '#8b96a5',
    focus: '#59d8cc',
    change: '#79c0ff',
    success: '#7ee787',
    warning: '#f2cc60',
    error: '#ff7b72',
    unknown: '#8b96a5',
    keycap: '#e6edf3',
  },
  statusColors: {
    success: '#7ee787',
    warning: '#f2cc60',
    error: '#ff7b72',
    info: '#79c0ff',
    muted: '#8b96a5',
  },
} as const;

export type TuiStatus = keyof typeof tuiTheme.statusColors;

export function getTuiStatusColor(status: TuiStatus): string {
  return tuiTheme.statusColors[status];
}
