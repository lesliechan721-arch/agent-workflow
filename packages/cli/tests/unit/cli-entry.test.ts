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

describe('CLI entry v4', () => {
  it('publishes the write commands plus sync, status, and config', async () => {
    const output = capture();
    expect(await runCli(['--help'], { io: output.io })).toBe(0);
    for (const command of [
      'install',
      'upgrade',
      'reinstall',
      'uninstall',
      'cleanup',
      'sync',
      'status',
      'config',
      'plugin',
      'skill',
      'review',
    ]) {
      expect(output.stdout()).toContain(command);
    }
  });

  it('publishes Codex sync selection and stable non-interactive failure', async () => {
    const help = capture();
    expect(await runCli(['sync', '--help'], { io: help.io })).toBe(0);
    expect(help.stdout()).toContain('--all');
    expect(help.stdout()).toContain('--yes');
    expect(help.stdout()).toContain('--allow-managed-codex-install');

    const conflict = capture();
    expect(await runCli([
      'sync', 'official/demo', '--all', '--platform', 'codex', '--scope', 'project', '--json',
    ], { interactive: false, io: conflict.io })).toBe(1);
    expect(JSON.parse(conflict.stdout())).toEqual({
      ok: false,
      command: 'sync',
      receiptSchemaVersion: 5,
      overallState: 'failed',
      warnings: [],
      errors: [{
        code: 'syncSelectorConflict',
        message: 'syncSelectorConflict: Plugin selectors and --all are mutually exclusive.',
      }],
      layers: {
        projectIntent: [{
          pluginId: 'official/demo', platform: 'codex', scope: 'project',
          relation: 'requested', action: 'keep', requiredBy: [],
        }],
        userIntent: [],
        sharedCodexNative: [],
        userActivation: [],
        projectActivation: [],
        awExtensions: [],
      },
      targets: [{
        pluginName: 'demo',
        pluginId: 'official/demo',
        sourceId: 'official',
        platform: 'codex',
        scope: 'project',
        status: 'failed',
        cleanupAttempted: false,
        actions: [],
        removed: [],
        absent: [],
        residual: [],
        quarantined: [],
        failures: [],
        desired: { scope: 'project', relation: 'requested' },
        recovery: ['remove either plugin selectors or --all, then rerun sync'],
      }],
    });

    const missing = capture();
    expect(await runCli([
      'sync', '--platform', 'codex', '--scope', 'project', '--json',
    ], { interactive: false, io: missing.io })).toBe(1);
    expect(JSON.parse(missing.stdout())).toMatchObject({
      ok: false,
      command: 'sync',
      errors: [{ code: 'syncSelectionRequired' }],
    });
  });

  it.each(['install', 'upgrade', 'reinstall', 'uninstall', 'cleanup'])(
    'publishes managed Codex authorization on %s',
    async (command) => {
      const output = capture();
      expect(await runCli([command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout()).toContain('--allow-managed-codex-install');
    },
  );

  it('publishes repeatable dependency placement on install only', async () => {
    const install = capture();
    expect(await runCli(['install', '--help'], { io: install.io })).toBe(0);
    expect(install.stdout()).toContain('--dependency-scope');

    const uninstall = capture();
    expect(await runCli(['uninstall', '--help'], { io: uninstall.io })).toBe(0);
    expect(uninstall.stdout()).not.toContain('--dependency-scope');
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
      [['catalog', 'publish'], 'otherwise sole remote'],
    ] as const) {
      const output = capture();
      expect(await runCli([...command, '--help'], { io: output.io })).toBe(0);
      expect(output.stdout().replace(/\s+/gu, ' ')).toContain(expected);
    }

    const status = capture();
    expect(await runCli(['catalog', 'status', '--help'], { io: status.io })).toBe(0);
    expect(status.stdout()).toContain('--preflight');
    expect(status.stdout()).toContain('executes plugin');
    expect(status.stdout().replace(/\s+/gu, ' ')).toContain('otherwise sole remote');
    expect(status.stdout()).toContain('--branch');
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
    { command: 'install', argv: ['install', '--json'], usage: 'Usage: aw install', jsonReceipt: true },
    { command: 'config:set', argv: ['config', 'set', '--json'], usage: 'Usage: aw config set', jsonReceipt: false },
  ])('does not start a TUI for incomplete $command', async ({ argv, usage, jsonReceipt }) => {
    const output = capture();
    expect(await runCli(argv, { interactive: true, io: output.io })).toBe(1);
    if (jsonReceipt) {
      expect(JSON.parse(output.stdout())).toMatchObject({
        ok: false,
        command: 'install',
        receiptSchemaVersion: 5,
        overallState: 'failed',
        errors: [{ code: 'invalidArguments', message: expect.stringContaining(usage) }],
      });
      expect(output.stderr()).toBe('');
    } else {
      expect(output.stdout()).toBe('');
      expect(output.stderr()).toContain(usage);
    }
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
