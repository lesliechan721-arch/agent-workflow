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

describe('CLI entry v4', () => {
  it('publishes the five write commands plus status and config', async () => {
    const output = capture();
    expect(await runCli(['--help'], { io: output.io })).toBe(0);
    for (const command of [
      'install',
      'upgrade',
      'reinstall',
      'uninstall',
      'cleanup',
      'status',
      'config',
      'plugin',
      'skill',
      'review',
    ]) {
      expect(output.stdout()).toContain(command);
    }
    expect(output.stdout()).not.toContain('diagnose');
  });

  it('publishes the standalone Skill validator options', async () => {
    const output = capture();
    expect(await runCli(['skill', 'validate', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('Usage: aw skill validate');
    expect(output.stdout()).toContain('--frontmatter-profile');
    expect(output.stdout()).toContain('--codex-metadata');
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
  ])('prints usage before starting the non-interactive %s write path', async (command) => {
    const output = capture();
    expect(await runCli([command], { interactive: false, io: output.io })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(`Usage: aw ${command}`);
    expect(output.stdout()).not.toContain('\u001B[');
  });

  it.each([
    ['list'],
    ['get'],
  ])('prints copyable plain usage when non-interactive config %s arguments are missing', async (command) => {
    const output = capture();
    expect(await runCli(['config', command], { interactive: false, io: output.io })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(`Usage: aw config ${command}`);
    expect(output.stderr()).not.toContain('\u001B[');
  });

  it.each([
    ['set'],
    ['unset'],
    ['reset'],
  ])('prints usage before starting the non-interactive config %s mutation path', async (command) => {
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
    { command: 'install', argv: ['install', '--json'], usage: 'Usage: aw install' },
    { command: 'config:set', argv: ['config', 'set', '--json'], usage: 'Usage: aw config set' },
  ])('does not start a TUI for incomplete $command', async ({ argv, usage }) => {
    const output = capture();
    expect(await runCli(argv, { interactive: true, io: output.io })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain(usage);
  });

  it.each([
    { name: 'write CI', argv: ['install'] },
    { name: 'config CI', argv: ['config', 'set'] },
  ])('fails closed without starting a TUI for $name', async ({ argv }) => {
    const output = capture();
    expect(await runCli(argv, {
      interactive: true,
      env: { ...process.env, CI: '1' },
      io: output.io,
    })).toBe(1);
    expect(`${output.stdout()}${output.stderr()}`).toContain('Usage:');
    expect(`${output.stdout()}${output.stderr()}`).not.toContain('\u001B[');
  });
});
