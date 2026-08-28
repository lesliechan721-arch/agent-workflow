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
  });

  it('publishes the standalone Skill validator options', async () => {
    const output = capture();
    expect(await runCli(['skill', 'validate', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('Usage: aw skill validate');
    expect(output.stdout()).toContain('--frontmatter-profile');
    expect(output.stdout()).toContain('--codex-metadata');
  });

  it('documents the Catalog status preflight execution boundary', async () => {
    const output = capture();
    expect(await runCli(['catalog', 'status', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('--preflight');
    expect(output.stdout()).toContain('executes plugin');
    expect(output.stdout()).toContain('--remote');
    expect(output.stdout()).toContain('--branch');
  });

  it.each(['init', 'add-skill'])('keeps plugin %s help on public authoring commands', async (command) => {
    const output = capture();
    expect(await runCli(['plugin', command, '--help'], { io: output.io })).toBe(0);
    for (const nextCommand of [
      'aw plugin validate',
      'aw plugin test',
      'aw plugin build',
      'aw catalog build',
      'aw catalog publish --help',
    ]) expect(output.stdout()).toContain(nextCommand);
    expect(output.stdout()).not.toContain('pnpm release');
    expect(output.stdout()).not.toContain('--plugin-root');
  });

  it('rejects the removed public plugin-root option', async () => {
    const initOutput = capture();
    expect(await runCli([
      'plugin', 'init', 'demo', '--description', 'Demo.', '--no-skills',
      '--plugin-root', 'tools/demo', '--json',
    ], { io: initOutput.io })).toBe(1);
    expect(initOutput.stderr()).toContain('Unknown option: --plugin-root');

  });

  it('publishes the confirmed canonical plugin removal options', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'remove', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('Usage: aw plugin remove');
    expect(output.stdout()).toContain('--workspace-root <path>');
    expect(output.stdout()).toContain('--yes');
    expect(output.stdout()).toContain('--json');
    expect(output.stdout()).not.toContain('--force');
    expect(output.stdout()).not.toContain('--plugin-root');
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
