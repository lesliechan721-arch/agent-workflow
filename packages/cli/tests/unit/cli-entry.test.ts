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

describe('CLI entry', () => {
  it('publishes demand and recovery commands under plugin', async () => {
    const output = capture();
    expect(await runCli(['plugin', '--help'], { io: output.io })).toBe(0);
    for (const command of ['install', 'remove', 'cleanup', 'sync', 'intent', 'targets', 'status', 'config']) {
      expect(output.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, 'mu'));
    }
    expect(output.stdout()).not.toMatch(/^\s+(reinstall|uninstall|project)\b/mu);
  });

  it('publishes joint sync with execution filters and rebuild', async () => {
    const help = capture();
    expect(await runCli(['plugin', 'sync', '--help'], { io: help.io })).toBe(0);
    expect(help.stdout()).toContain('--context <context>');
    expect(help.stdout()).toContain('--target <target>');
    expect(help.stdout()).toContain('--rebuild');
    expect(help.stdout()).toContain('--yes');
    expect(help.stdout()).not.toContain('--scope');
    expect(help.stdout()).not.toMatch(/--all(?:\s|,|$)/u);
    expect(help.stdout()).not.toContain('--platform');
    expect(help.stdout()).not.toContain('--dependency-scope');
  });

  it.each(['install', 'remove', 'cleanup', 'sync'])(
    'rejects the removed managed Codex flag on %s', async (command) => {
      const output = capture();
      expect(await runCli([
        'plugin', command, 'team/demo',
        ...(command === 'cleanup' ? ['--scope', 'project', '--target', 'codex'] : []),
        '--allow-managed-codex-install',
      ], { io: output.io })).toBe(2);
      expect(output.stdout()).toBe('');
      expect(output.stderr()).toContain("unknown option '--allow-managed-codex-install'");
    });

  it('keeps install targets in the saved policy and physical cleanup explicit', async () => {
    const install = capture();
    expect(await runCli(['plugin', 'install', '--help'], { io: install.io })).toBe(0);
    expect(install.stdout()).toContain('--scope');
    expect(install.stdout()).not.toContain('--target');
    expect(install.stdout()).not.toContain('--dependency-scope');
    const cleanup = capture();
    expect(await runCli(['plugin', 'cleanup', '--help'], { io: cleanup.io })).toBe(0);
    for (const flag of ['--scope', '--target', '--yes', '--force']) expect(cleanup.stdout()).toContain(flag);
  });

  it('publishes preApply timeout only on commands that can run preApply', async () => {
    for (const command of [['install'], ['sync'], ['config', 'set'], ['config', 'unset'], ['config', 'reset'], ['config', 'apply']]) {
      const output = capture();
      expect(await runCli(['plugin', ...command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).toContain('--script-timeout');
    }
    for (const command of ['cleanup', 'remove']) {
      const output = capture();
      expect(await runCli(['plugin', command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).not.toContain('--script-timeout');
    }
  });

  it('keeps explicit retirement authorization', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'intent', 'retire', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('--delete-config');
  });

  it('publishes the standalone Skill validator options', async () => {
    const output = capture();
    expect(await runCli(['skill', 'validate', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('Usage: aw skill validate');
    expect(output.stdout()).toContain('--frontmatter-profile');
    expect(output.stdout()).toContain('--codex-metadata');
  });

  it('documents Workspace and publication defaults on representative authoring help', async () => {
    // Static contract exception: incorrect help sends authors to the wrong Workspace or remote; behavior tests cannot verify the text that users read before execution.
    for (const [command, expected] of [
      [['plugin', 'init'], 'nearest ancestor from current directory'],
      [['plugin', 'validate'], 'nearest ancestor from plugin directory'],
      [['catalog', 'init'], 'then Git worktree root'],
      [['catalog', 'build'], 'nearest ancestor from current directory'],
      [['catalog', 'publish', 'plan'], 'otherwise sole remote'],
    ] as const) {
      const output = capture();
      expect(await runCli([...command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout().replace(/\s+/gu, ' ')).toContain(expected);
    }

    const status = capture();
    expect(await runCli(['catalog', 'status', '--help'], { io: status.io })).toBe(0);
    expect(status.stdout()).not.toContain('--preflight');
    expect(status.stdout()).not.toContain('--remote');
    expect(status.stdout()).not.toContain('--branch');

    const catalog = capture();
    expect(await runCli(['catalog', '--help'], { io: catalog.io })).toBe(0);
    expect(catalog.stdout()).not.toMatch(/^\s+context\b/mu);

    const removedContext = capture();
    expect(await runCli(['catalog', 'context'], { io: removedContext.io })).toBe(1);
    expect(removedContext.stderr()).toContain("unknown command 'context'");

    const apply = capture();
    expect(await runCli(['catalog', 'publish', 'apply', '--help'], { io: apply.io })).toBe(0);
    expect(apply.stdout()).toContain('--expected-plan-digest <sha256>');
    expect(apply.stdout()).toContain('--yes');

    const removedPublish = capture();
    expect(await runCli([
      'catalog', 'publish', '--workspace-root', '.', '--yes',
    ], { io: removedPublish.io })).toBe(1);
    expect(removedPublish.stderr()).toContain("unknown option '--workspace-root'");
  });

  it.each(['init', 'add-skill'])('keeps plugin %s help on public authoring commands', async (command) => {
    const output = capture();
    expect(await runCli(['plugin', command, '--help'], { io: output.io })).toBe(0);
    for (const nextCommand of [
      'aw plugin validate',
      'aw plugin test',
      'aw plugin build',
      'aw catalog build',
      'aw catalog publish plan --help',
    ]) expect(output.stdout()).toContain(nextCommand);
    expect(output.stdout()).not.toContain('pnpm release');
    expect(output.stdout()).not.toContain('--plugin-root');
  });

  it('publishes only the preApply scaffold flag', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'init', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('--with-pre-apply');
    expect(output.stdout()).not.toContain('--with-post-apply');
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
      'plugin', 'cleanup', 'git-commit', '--scope', 'user', '--target', 'codex', '--dependency-index',
    ], { io: output.io })).toBe(2);
    expect(output.stderr()).toContain("unknown option '--dependency-index'");
  });

  it.each(['install', 'remove', 'cleanup'])(
    'rejects incomplete %s arguments without starting the TUI', async (command) => {
      const output = capture();
      expect(await runCli(['plugin', command, '--json'], { interactive: true, io: output.io })).toBe(2);
      expect(JSON.parse(output.stdout())).toMatchObject({ ok: false, errors: [{ code: 'invalidArguments' }] });
      expect(output.stderr()).toBe('');
    });

  it.each(['schema', 'get', 'set', 'unset', 'reset'])(
    'rejects incomplete config %s arguments without starting the TUI', async (command) => {
      const output = capture();
      expect(await runCli(['plugin', 'config', command, '--json'], { interactive: true, io: output.io })).toBe(2);
      expect(JSON.parse(output.stdout())).toMatchObject({ ok: false, errors: [{ code: 'invalidArguments' }] });
      expect(output.stdout()).not.toContain('\u001B[');
    });
});
