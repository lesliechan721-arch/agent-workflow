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
    for (const command of ['list', 'show', 'install', 'remove', 'sync', 'status', 'config']) {
      expect(output.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, 'mu'));
    }
    expect(output.stdout()).not.toMatch(/^\s+(cleanup|intent|targets|reinstall|uninstall|project)\b/mu);
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

  it.each(['install', 'remove', 'sync'])(
    'rejects the removed managed Codex flag on %s', async (command) => {
      const output = capture();
      expect(await runCli([
        'plugin', command, 'team/demo',
        ...(command === 'sync' ? [] : ['--scope', 'project']),
        '--allow-managed-codex-install',
      ], { io: output.io })).toBe(2);
      expect(output.stdout()).toContain('FAILED');
      expect(output.stderr()).toContain('invalidArguments');
      expect(output.stderr()).toContain('--allow-managed-codex-install');
    });

  it('publishes execution target filters and explicit output removal', async () => {
    const install = capture();
    expect(await runCli(['plugin', 'install', '--help'], { io: install.io })).toBe(0);
    expect(install.stdout()).toContain('--scope');
    expect(install.stdout()).toContain('--target');
    expect(install.stdout()).not.toContain('--dependency-scope');
    const cleanup = capture();
    expect(await runCli(['plugin', 'remove', '--help'], { io: cleanup.io })).toBe(0);
    for (const flag of ['--scope', '--target', '--yes', '--force', '--keep-dependencies']) expect(cleanup.stdout()).toContain(flag);
  });

  it.each([
    ['remove', ['--only', 'requirements', '--force'], 'force'],
    ['remove', ['--only', 'requirements', '--keep-dependencies'], 'keepDependencies'],
    ['remove', ['--only', 'outputs', '--target', 'cursor', '--keep-dependencies'], 'keepDependencies'],
  ] as const)('rejects unsupported dependency options on %s %j before business work', async (command, flags, field) => {
    const output = capture();
    expect(await runCli([
      'plugin', command, 'team/demo', '--scope', 'user', ...flags, '--json',
    ], { io: output.io })).toBe(2);
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: `plugin.${command}`, status: 'failed', data: {},
      diagnostics: [{ code: 'invalidOptionValue', subject: { field } }],
    });
  });

  it.each(['install', 'sync', 'status'])(
    'rejects --keep-dependencies on %s', async (command) => {
      const output = capture();
      expect(await runCli([
        'plugin', command, 'team/demo', ...(command === 'install' ? ['--scope', 'user'] : []),
        '--keep-dependencies', '--json',
      ], { io: output.io })).toBe(2);
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: `plugin.${command}`, status: 'failed', data: {}, diagnostics: [{ code: 'invalidArguments' }],
      });
    });

  it('publishes preApply timeout only on commands that can run preApply', async () => {
    for (const command of [['install'], ['sync'], ['config', 'set'], ['config', 'unset'], ['config', 'reset'], ['config', 'apply']]) {
      const output = capture();
      expect(await runCli(['plugin', ...command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).toContain('--script-timeout');
    }
    for (const command of ['remove']) {
      const output = capture();
      expect(await runCli(['plugin', command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).not.toContain('--script-timeout');
    }
  });

  it('keeps explicit retirement authorization', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'remove', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('--delete-config');
  });

  it('publishes the standalone Skill validator options', async () => {
    const output = capture();
    expect(await runCli(['dev', 'skill', 'validate', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('Usage: aw dev skill validate');
    expect(output.stdout()).toContain('--frontmatter-profile');
    expect(output.stdout()).toContain('--codex-metadata');
  });

  it('documents Workspace and publication defaults on representative authoring help', async () => {
    // Static contract exception: incorrect help sends authors to the wrong Workspace or remote; behavior tests cannot verify the text that users read before execution.
    for (const [command, expected] of [
      [['dev', 'plugin', 'create'], 'nearest ancestor from current directory'],
      [['dev', 'plugin', 'validate'], 'nearest ancestor from plugin directory'],
      [['dev', 'catalog', 'create'], 'then Git worktree root'],
      [['dev', 'catalog', 'build'], 'nearest ancestor from current directory'],
      [['dev', 'catalog', 'publish', 'plan'], 'otherwise sole remote'],
    ] as const) {
      const output = capture();
      expect(await runCli([...command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout().replace(/\s+/gu, ' ')).toContain(expected);
    }

    const status = capture();
    expect(await runCli(['dev', 'catalog', 'status', '--help'], { io: status.io })).toBe(0);
    expect(status.stdout()).not.toContain('--preflight');
    expect(status.stdout()).not.toContain('--remote');
    expect(status.stdout()).not.toContain('--branch');

    const catalog = capture();
    expect(await runCli(['dev', 'catalog', '--help'], { io: catalog.io })).toBe(0);
    expect(catalog.stdout()).not.toMatch(/^\s+context\b/mu);

    const removedContext = capture();
    expect(await runCli(['dev', 'catalog', 'context'], { io: removedContext.io })).toBe(2);
    expect(removedContext.stderr()).toContain('invalidArguments');

    const apply = capture();
    expect(await runCli(['dev', 'catalog', 'publish', 'apply', '--help'], { io: apply.io })).toBe(0);
    expect(apply.stdout()).toContain('--expected-plan-digest <sha256>');
    expect(apply.stdout()).toContain('--yes');

    const removedPublish = capture();
    expect(await runCli([
      'dev', 'catalog', 'publish', '--workspace-root', '.', '--yes',
    ], { io: removedPublish.io })).toBe(2);
    expect(removedPublish.stderr()).toContain('invalidArguments');
    expect(removedPublish.stderr()).toContain('--workspace-root');
  });

  it.each([['plugin', 'create'], ['skill', 'create']])('keeps %s %s help on public authoring commands', async (...command) => {
    const output = capture();
    expect(await runCli(['dev', ...command, '--help'], { io: output.io })).toBe(0);
    for (const nextCommand of [
      'aw dev plugin validate',
      'aw dev plugin test',
      'aw dev plugin build',
      'aw dev catalog build',
      'aw dev catalog publish plan --help',
    ]) expect(output.stdout()).toContain(nextCommand);
    expect(output.stdout()).not.toContain('pnpm release');
    expect(output.stdout()).not.toContain('--plugin-root');
  });

  it('publishes only the preApply scaffold flag', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'create', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('--with-pre-apply');
    expect(output.stdout()).not.toContain('--with-post-apply');
  });

  it('publishes canonical authoring plugin removal options', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'remove', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('Usage: aw dev plugin remove');
    expect(output.stdout()).toContain('--workspace-root <path>');
    expect(output.stdout()).toContain('--yes');
    expect(output.stdout()).toContain('--json');
    expect(output.stdout()).not.toContain('--force');
    expect(output.stdout()).not.toContain('--plugin-root');
  });

  it('rejects legacy cleanup flags at Commander parsing', async () => {
    const output = capture();
    expect(await runCli([
      'plugin', 'remove', 'git-commit', '--only', 'outputs', '--scope', 'user', '--target', 'codex', '--dependency-index',
    ], { io: output.io })).toBe(2);
    expect(output.stderr()).toContain('invalidArguments');
    expect(output.stderr()).toContain('--dependency-index');
  });

  it.each(['install', 'remove'])(
    'rejects incomplete %s arguments without starting the TUI', async (command) => {
      const output = capture();
      expect(await runCli(['plugin', command, '--scope', 'user', '--json'], { interactive: true, io: output.io })).toBe(2);
      expect(JSON.parse(output.stdout())).toMatchObject({ schemaVersion: 1, command: `plugin.${command}`, status: 'failed', data: {}, diagnostics: [{ code: 'invalidArguments' }] });
      expect(output.stderr()).toContain('invalidArguments');
    });

  it.each(['schema', 'get', 'set', 'unset', 'reset'])(
    'rejects incomplete config %s arguments without starting the TUI', async (command) => {
      const output = capture();
      expect(await runCli(['plugin', 'config', command, '--json'], { interactive: true, io: output.io })).toBe(2);
      expect(JSON.parse(output.stdout())).toMatchObject({ schemaVersion: 1, command: `plugin.config.${command}`, status: 'failed', data: {}, diagnostics: [{ code: 'invalidArguments' }] });
      expect(output.stdout()).not.toContain('\u001B[');
    });
});
