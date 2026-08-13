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

  it.each([
    ['install'],
    ['upgrade'],
    ['uninstall'],
    ['reinstall'],
    ['cleanup'],
  ])('prints copyable plain usage when non-interactive %s arguments are missing', async (command) => {
    const output = capture();
    expect(await runCli([command], { interactive: false, io: output.io })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(`Usage: aw ${command}`);
    expect(output.stderr()).not.toContain('\u001B[');
  });

  it.each([
    ['list'],
    ['get'],
    ['set'],
    ['unset'],
    ['reset'],
  ])('prints copyable plain usage when non-interactive config %s arguments are missing', async (command) => {
    const output = capture();
    expect(await runCli(['config', command], { interactive: false, io: output.io })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(`Usage: aw config ${command}`);
    expect(output.stderr()).not.toContain('\u001B[');
  });

  it('rejects upgrade --all with explicit plugins before execution', async () => {
    const output = capture();
    expect(await runCli([
      'upgrade', 'git-commit', '--all', '--platform', 'codex',
    ], { interactive: false, io: output.io })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('不能同时使用插件名和 `--all`');
  });

  it.each([
    { name: 'write JSON', argv: ['install', '--json'], env: process.env },
    { name: 'config JSON', argv: ['config', 'set', '--json'], env: process.env },
    { name: 'write CI', argv: ['install'], env: { ...process.env, CI: '1' } },
    { name: 'config CI', argv: ['config', 'set'], env: { ...process.env, CI: '1' } },
  ])('never starts a TUI for missing $name arguments', async ({ argv, env }) => {
    const output = capture();
    expect(await runCli(argv, { interactive: true, env, io: output.io })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('Usage: aw');
    expect(output.stderr()).not.toContain('\u001B[');
  });
});
