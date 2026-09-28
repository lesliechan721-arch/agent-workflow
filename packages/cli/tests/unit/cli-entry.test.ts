import { describe, expect, it, vi } from 'vitest';

import { createManagedCodexAuthorizer, runCli } from '../../src/index.js';

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
  it('publishes the write commands plus sync, status, and config', async () => {
    const output = capture();
    expect(await runCli(['--help'], { io: output.io })).toBe(0);
    for (const command of [
      'install',
      'reinstall',
      'uninstall',
      'cleanup',
      'sync',
      'intent',
      'targets',
      'status',
      'config',
      'plugin',
      'skill',
      'review',
    ]) {
      expect(output.stdout()).toContain(command);
    }
    expect(output.stdout()).not.toMatch(/^\s+project\s/mu);
  });

  it('requires a scope and supports exact repeated Agent selection', async () => {
    const help = capture();
    expect(await runCli(['sync', '--help'], { io: help.io })).toBe(0);
    expect(help.stdout()).toContain('--all');
    expect(help.stdout()).toContain('--scope <scope>');
    expect(help.stdout()).toContain('--target <agent>');
    expect(help.stdout()).toContain('--yes');
    expect(help.stdout()).toContain('--allow-managed-codex-install');
    expect(help.stdout()).not.toContain('--platform');

    const missing = capture();
    expect(await runCli(['sync', '--all', '--json'], { interactive: false, io: missing.io }))
      .toBe(2);
    expect(JSON.parse(missing.stdout())).toMatchObject({
      kind: 'aw-recovery', scope: null, errors: [{ code: 'invalidArguments',
        message: expect.stringContaining('--scope') }],
    });

    const removed = capture();
    expect(await runCli(['sync', '--all', '--scope', 'user', '-p', 'both'], {
      interactive: false, io: removed.io,
    })).toBe(2);
    expect(removed.stderr()).toContain("unknown option '-p'");
  });

  it.each(['install', 'reinstall', 'uninstall', 'cleanup'])(
    'publishes managed Codex authorization on %s',
    async (command) => {
      const output = capture();
      expect(await runCli([command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).toContain('--allow-managed-codex-install');
    },
  );

  it('publishes one-time dependency placement on recovery commands that can install', async () => {
    const install = capture();
    expect(await runCli(['install', '--help'], { io: install.io })).toBe(0);
    expect(install.stdout()).toContain('--dependency-scope');

    const sync = capture();
    expect(await runCli(['sync', '--help'], { io: sync.io })).toBe(0);
    expect(sync.stdout()).toContain('--dependency-scope');

    const uninstall = capture();
    expect(await runCli(['uninstall', '--help'], { io: uninstall.io })).toBe(0);
    expect(uninstall.stdout()).not.toContain('--dependency-scope');
  });

  it('publishes preApply timeout only on commands that can run preApply', async () => {
    for (const command of [
      ['install'],
      ['sync'],
      ['reinstall'],
      ['config', 'set'],
      ['config', 'unset'],
      ['config', 'reset'],
    ]) {
      const output = capture();
      expect(await runCli([...command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).toContain('--script-timeout');
    }
    for (const command of [['cleanup'], ['uninstall']]) {
      const output = capture();
      expect(await runCli([...command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).not.toContain('--script-timeout');
    }
  });

  it('publishes explicit authorization for deleted-plugin cleanup', async () => {
    const output = capture();
    expect(await runCli(['cleanup', '--help'], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain('--yes');
    expect(output.stdout()).toContain('--force');
    const retire = capture();
    expect(await runCli(['intent', 'retire', '--help'], { io: retire.io })).toBe(0);
    expect(retire.stdout()).toContain('--delete-config');
  });

  it('asks once at the first interactive managed Codex acquisition', async () => {
    const confirm = vi.fn().mockResolvedValue({ cancelled: false, value: true });
    const authorizer = createManagedCodexAuthorizer(
      {},
      { interactive: true, isTty: true, isCi: false, prompt: { confirm } },
    );

    await expect(authorizer?.()).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: false }));
  });

  it('requires the explicit managed Codex flag outside an interactive terminal', async () => {
    const confirm = vi.fn();
    expect(createManagedCodexAuthorizer(
      { json: true },
      { interactive: true, isTty: true, isCi: false, prompt: { confirm } },
    )).toBeUndefined();
    expect(createManagedCodexAuthorizer(
      {},
      { interactive: false, isTty: false, isCi: false, prompt: { confirm } },
    )).toBeUndefined();
    await expect(createManagedCodexAuthorizer(
      { allowManagedCodexInstall: true, json: true },
      { interactive: false, isTty: false, isCi: false, prompt: { confirm } },
    )?.()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
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
      [['plugin', 'status'], 'nearest ancestor from current directory'],
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
      'cleanup', 'git-commit', '--scope', 'user', '--target', 'codex', '--dependency-index',
    ], { io: output.io })).toBe(2);
    expect(output.stderr()).toContain("unknown option '--dependency-index'");
  });

  it.each([
    ['install'],
    ['uninstall'],
    ['reinstall'],
    ['cleanup'],
  ])('requires a scope before starting the non-interactive %s write path', async (command) => {
    const output = capture();
    expect(await runCli([command], { interactive: false, io: output.io })).toBe(2);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain("required option '--scope <scope>'");
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

  it.each([
    {
      command: 'install',
      argv: ['install', '--json'],
      usage: 'Usage: aw install',
      receiptCommand: 'install',
      stderr: '',
    },
    {
      command: 'config:set',
      argv: ['config', 'set', '--json'],
      usage: 'Usage: aw config set',
      receiptCommand: 'config:set',
      stderr: 'usage',
    },
  ])('does not start a TUI for incomplete $command', async ({
    argv,
    usage,
    receiptCommand,
    stderr,
  }) => {
    const output = capture();
    expect(await runCli(argv, { interactive: true, io: output.io }))
      .toBe(receiptCommand === 'config:set' ? 1 : 2);
    expect(JSON.parse(output.stdout())).toMatchObject(receiptCommand === 'config:set' ? {
      ok: false, command: receiptCommand, receiptSchemaVersion: 7,
      overallState: 'failed', configWrite: 'notStarted',
      errors: [{ code: 'invalidArguments', message: expect.stringContaining(usage) }],
    } : {
      schemaVersion: 1, kind: 'aw-recovery', command: receiptCommand, ok: false,
      errors: [{ code: 'invalidArguments', message: expect.stringContaining('--scope') }],
    });
    if (stderr === 'usage') expect(output.stderr()).toContain(usage);
    else expect(output.stderr()).toBe(stderr);
  });

  it.each([
    { name: 'write CI', argv: ['install'] },
    { name: 'config CI', argv: ['config', 'set'] },
  ])('fails closed without starting a TUI for $name', async ({ argv, name }) => {
    const output = capture();
    expect(await runCli(argv, {
      interactive: true,
      env: { ...process.env, CI: '1' },
      io: output.io,
    })).toBe(name === 'write CI' ? 2 : 1);
    expect(`${output.stdout()}${output.stderr()}`).toContain(name === 'write CI' ? '--scope' : 'Usage:');
    expect(`${output.stdout()}${output.stderr()}`).not.toContain('\u001B[');
  });
});
