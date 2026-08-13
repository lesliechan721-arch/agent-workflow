export const tuiTheme = {
  colors: {
    accent: 'cyan',
    muted: 'gray',
    text: 'white',
    border: 'gray',
  },
  statusColors: {
    success: 'green',
    warning: 'yellow',
    error: 'red',
    info: 'cyan',
    muted: 'gray',
  },
} as const;

export type TuiStatus = keyof typeof tuiTheme.statusColors;

export function getTuiStatusColor(status: TuiStatus): string {
  return tuiTheme.statusColors[status];
}
