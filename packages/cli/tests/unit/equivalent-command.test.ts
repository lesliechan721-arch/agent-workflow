import { describe, expect, it } from 'vitest';

import {
  renderEquivalentCommandDisplays,
  renderShellCommand,
} from '../../src/output/equivalent-command.js';

const tokens = [
  'aw',
  'config',
  'set',
  'plugin name',
  'key',
  "space & | < > ' \" $ ` % !",
];

describe('equivalent command display', () => {
  it('renders POSIX argv with shell-safe single quotes', () => {
    expect(renderShellCommand(tokens, 'posix')).toBe(
      "aw config set 'plugin name' key 'space & | < > '\"'\"' \" $ ` % !'",
    );
  });

  it('renders PowerShell argv as literal single-quoted tokens', () => {
    const rendered = renderShellCommand(tokens, 'powershell');
    expect(rendered).toBe(
      "& 'aw' 'config' 'set' 'plugin name' 'key' 'space & | < > '' \" $ ` % !'",
    );

    const parsed = [...rendered.matchAll(/'((?:''|[^'])*)'/g)]
      .map((match) => match[1]!.replaceAll("''", "'"));
    expect(parsed).toEqual(tokens);
  });

  it('provides a replayable PowerShell command and argv on Windows', () => {
    expect(renderEquivalentCommandDisplays(tokens, 'win32')).toEqual([
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
    ]);
  });
});
