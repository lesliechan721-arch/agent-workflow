export type ShellKind = 'posix' | 'powershell';

export interface EquivalentCommandDisplay {
  kind: ShellKind | 'argv';
  label: 'POSIX shell 命令' | 'PowerShell 命令' | '参数列表';
  text: string;
  replayable: boolean;
}

function quotePosixToken(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShellToken(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderShellCommand(tokens: readonly string[], shell: ShellKind): string {
  if (shell === 'powershell') {
    return `& ${tokens.map(quotePowerShellToken).join(' ')}`;
  }
  return tokens.map(quotePosixToken).join(' ');
}

export function renderEquivalentCommandDisplays(
  tokens: readonly string[],
  platform: NodeJS.Platform = process.platform,
): EquivalentCommandDisplay[] {
  if (platform === 'win32') {
    return [
      {
        kind: 'powershell',
        label: 'PowerShell 命令',
        text: renderShellCommand(tokens, 'powershell'),
        replayable: true,
      },
      {
        kind: 'argv',
        label: '参数列表',
        text: JSON.stringify(tokens),
        replayable: false,
      },
    ];
  }
  return [{
    kind: 'posix',
    label: 'POSIX shell 命令',
    text: renderShellCommand(tokens, 'posix'),
    replayable: true,
  }];
}
