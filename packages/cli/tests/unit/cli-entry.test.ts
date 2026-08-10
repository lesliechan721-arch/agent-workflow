import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('CLI entry v3', () => {
  it('publishes the five write commands plus status and config', async () => {
    const output = capture();
    expect(await runCli(['--help'], { io: output.io })).toBe(0);
    for (const command of ['install', 'upgrade', 'reinstall', 'uninstall', 'cleanup', 'status', 'config']) {
      expect(output.stdout()).toContain(command);
    }
    expect(output.stdout()).not.toContain('diagnose');
  });

  it('treats diagnose as an unknown command', async () => {
    const output = capture();
    expect(await runCli(['diagnose'], { io: output.io })).toBe(1);
    expect(output.stderr()).toContain("unknown command 'diagnose'");
    expect(output.stdout()).toBe('');
  });

  it('rejects legacy cleanup flags at Commander parsing', async () => {
    const output = capture();
    expect(await runCli([
      'cleanup', 'git-commit', '-p', 'codex', '-s', 'user', '--dependency-index',
    ], { io: output.io })).toBe(1);
    expect(output.stderr()).toContain("unknown option '--dependency-index'");
  });
});
