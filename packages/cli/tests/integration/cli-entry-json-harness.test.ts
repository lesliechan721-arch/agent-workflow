import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../helpers/cli-entry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../../src/commands/status-v6.js');
  vi.doUnmock('../../src/commands/write-commands.js');
  vi.doUnmock('../../src/recovery/coordinator.js');
  vi.doUnmock('../../src/recovery/status.js');
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CLI JSON recovery and independent command harness', () => {
  it.each([
    [['catalog', 'publish', 'apply', '--json'], "error: required option '--expected-plan-digest <sha256>' not specified"],
    [[
      'catalog', 'publish', 'apply', '--json',
      '--expected-plan-digest', `sha256:${'a'.repeat(64)}`,
      '--unknown',
    ], "error: unknown option '--unknown'"],
  ] as const)('uses the flat Catalog publication failure contract for %j', async (argv, message) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(1);
    expect(result.parseJsonStdout()).toEqual({
      ok: false,
      code: 'invalidArguments',
      message,
    });
    expect(result.stderr).toBe(`${message}\n`);
  });

  it('redacts Catalog publication argument errors on stdout and stderr', async () => {
    const sensitivePath = '/Users/alice/private';
    const result = await runCliEntry([
      'catalog', 'publish', 'apply', '--json',
      '--expected-plan-digest', `sha256:${'a'.repeat(64)}`,
      `--unknown=${sensitivePath}`,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.parseJsonStdout()).toEqual({
      ok: false,
      code: 'invalidArguments',
      message: "error: unknown option '--unknown=[private-path]'",
    });
    expect(result.stderr).toBe("error: unknown option '--unknown=[private-path]'\n");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sensitivePath);
  });

  it.each(['user', 'project'] as const)('emits one scoped recovery error for %s parse failures', async (scope) => {
    const result = await runCliEntry([
      'plugin', 'install', 'official/git-commit', '--scope', scope, '--json', '--unknown',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', scope, command: 'install', ok: false,
      intent: { state: 'unreadable', roots: null },
      selection: { agents: [], origin: 'none', preferences: 'unreadable' },
      requestedTargets: [], targetResults: [], remainingTargets: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false,
      outputsMayHaveChanged: false,
      errors: [{ code: 'invalidArguments', message: "error: unknown option '--unknown'" }],
    });
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stdout.trim().endsWith('}')).toBe(true);
  });

  it('rejects an invalid Agent without writing declaration state', async () => {
    const result = await runCliEntry([
      'plugin', 'install', 'official/git-commit', '--scope', 'project', '--target', 'invalid', '--json',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', scope: 'project', command: 'install', ok: false,
      declarationChanged: false, outputsMayHaveChanged: false,
      errors: [{ code: 'invalidArguments' }],
    });
  });

  it('does not expose the removed public upgrade command', async () => {
    const result = await runCliEntry(['upgrade', 'official/git-commit', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown command 'upgrade'");
  });

  it('publishes the runtime plugin capability contract with isolated stdout', async () => {
    const result = await runCliEntry([
      'plugin', 'capabilities', '--surface', 'artifacts', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const value = result.parseJsonStdout<{ command: string; schemaVersion: number; capabilities: { artifacts: Array<{ field: string; acceptedValues?: string[] }> } }>();
    expect(value).toMatchObject({ command: 'plugin:capabilities', schemaVersion: 1 });
    expect(value.capabilities.artifacts).toContainEqual(expect.objectContaining({
      field: 'artifacts.targets[].platform',
      acceptedValues: ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'generic'],
    }));
    expect(value.capabilities.artifacts.some((entry) => entry.field.startsWith('artifacts.targets[].delivery'))).toBe(false);
  });

  it('emits a unified recovery receipt from the scoped coordinator', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-recovery-json-'));
    tempDirs.push(tempDir);
    const receipt = {
      schemaVersion: 1, kind: 'aw-recovery', scope: 'project', command: 'sync', ok: true,
      intent: { state: 'valid', digest: 'sha256:fixture', roots: ['official/git-commit'] },
      requestedRoots: ['official/git-commit'],
      requestedTargets: [{ pluginId: 'official/git-commit', agent: 'codex', scope: 'project',
        delivery: { kind: 'native', platform: 'codex' } }],
      selection: { agents: ['codex'], origin: 'argument', preferences: 'absent' },
      blockers: [], errors: [], targetResults: [{
        pluginId: 'official/git-commit', agent: 'codex', scope: 'project',
        delivery: { kind: 'native', platform: 'codex' }, execution: 'no-op',
        observation: 'verified', content: 'satisfied', blockers: [],
        requiredBy: ['official/git-commit'], relation: 'root',
      }], remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false,
      outputsMayHaveChanged: false,
    };
    const runRecovery = vi.fn(async () => receipt);
    vi.doMock('../../src/recovery/coordinator.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../src/recovery/coordinator.js')>(), runRecovery,
    }));
    const result = await runCliEntry([
      'plugin', 'sync', 'official/git-commit', '--context', 'user', '--target', 'codex', '--json',
    ], { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv });
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.parseJsonStdout()).toEqual(receipt);
    expect(runRecovery).toHaveBeenCalledOnce();
  });

  it('emits one status object and keeps diagnostics on stderr', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-'));
    tempDirs.push(tempDir);
    const status = { schemaVersion: 1, kind: 'aw-recovery-status', scope: 'user', ok: true,
      intent: { state: 'absent' }, selection: { agents: [], origin: 'none', preferences: 'absent' },
      inventory: [], extraObserved: [], coverage: { native: true, portable: true },
      counts: { blocked: 0, unconfirmed: 0, pending: 0, ready: 0 }, allSatisfied: true, errors: [] };
    const readRecoveryStatus = vi.fn(async () => status);
    vi.doMock('../../src/recovery/status.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../src/recovery/status.js')>(), readRecoveryStatus,
    }));
    const result = await runCliEntry(['plugin', 'status', '--context', 'user', '--json', '--verbose'], {
      cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv,
    });
    expect(result.exitCode).toBe(0);
    expect(result.parseJsonStdout()).toEqual(status);
    expect(result.stderr).toBe('');
    expect(readRecoveryStatus).toHaveBeenCalledOnce();
  });

  it.each([
    ['set', ['plugin', 'config', 'set', '--json']],
    ['unset', ['plugin', 'config', 'unset', '-j']],
    ['reset', ['plugin', 'config', 'reset', '--json']],
  ] as const)('emits one Config Mutation Receipt v7 when config %s arguments are missing', async (
    command,
    argv,
  ) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: `config:${command}`,
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{ code: 'invalidArguments', message: 'error: invalid config mutation arguments' }],
    });
    expect(result.stderr).toBe('error: invalid config mutation arguments\n');
  });

  it.each([
    ['set', '-jv', []],
    ['unset', '-vj', []],
    ['reset', '-jD', []],
    ['set', '-js', ['project']],
  ] as const)('recognizes JSON intent in the config %s %s short option cluster', async (
    command,
    cluster,
    clusterValue,
  ) => {
    const result = await runCliEntry([
      'plugin', 'config', command, cluster, ...clusterValue, '--unknown=private-value',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: `config:${command}`,
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{
        code: 'invalidArguments',
        message: 'error: invalid config mutation arguments',
      }],
    });
    expect(result.stderr).toBe('error: invalid config mutation arguments\n');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('private-value');
  });

  it.each([
    ['set', [
      'plugin', 'config', 'set', 'official/demo', 'mode',
      '--value-json', '"safe"', '--json', '--unknown=private-value',
    ]],
    ['unset', ['plugin', 'config', 'unset', 'official/demo', 'mode', '-j', '--unknown=private-value']],
    ['reset', ['plugin', 'config', 'reset', 'official/demo', '--yes', '--json', '--unknown=private-value']],
  ] as const)('emits one safe Config Mutation Receipt v7 for config %s unknown options', async (
    command,
    argv,
  ) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: `config:${command}`,
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{
        code: 'invalidArguments',
        message: 'error: invalid config mutation arguments',
      }],
    });
    expect(result.stderr).toBe('error: invalid config mutation arguments\n');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('private-value');
  });

  it('emits one Config Mutation Receipt v7 for an action failure', async () => {
    const result = await runCliEntry([
      'plugin', 'config', 'set', 'official/demo', 'mode', '--json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: 'config:set',
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{
        code: 'invalidArguments',
        message: 'Use exactly one of --value-json, --value-stdin, or --preset.',
      }],
    });
    expect(result.stderr).toBe(
      'Use exactly one of --value-json, --value-stdin, or --preset.\n',
    );
  });

  it.each([['schema', '-jv'], ['get', '-vj']])(
    'keeps config %s parse failures outside mutation receipts', async (command, jsonOptions) => {
      const result = await runCliEntry(['plugin', 'config', command, 'official/demo', jsonOptions, '--unknown']);
      expect(result.exitCode).toBe(2);
      expect(result.parseJsonStdout()).toMatchObject({ ok: false, command: `config:${command}`,
        errors: [{ code: 'invalidArguments' }] });
      expect(result.parseJsonStdout()).not.toHaveProperty('receiptSchemaVersion');
    });

  it.each([['apply', '-yj'], ['edit', '-j']])(
    'uses mutation receipt v7 for config %s parse failures', async (command, jsonOptions) => {
      const result = await runCliEntry(['plugin', 'config', command, 'official/demo', jsonOptions, '--unknown']);
      expect(result.exitCode).toBe(2);
      expect(result.parseJsonStdout()).toMatchObject({ receiptSchemaVersion: 7, command: `config:${command}`,
        ok: false, configWrite: 'notStarted', overallState: 'failed', errors: [{ code: 'invalidArguments' }] });
    });

  it('does not expose a secret value-json token in a config set usage failure', async () => {
    const sensitivePath = path.join(os.tmpdir(), 'private', 'config-secret.json');
    const secret = 'config-secret-value';
    const valueJson = JSON.stringify({ path: sensitivePath, token: secret });
    const result = await runCliEntry([
      'plugin', 'config', 'set', 'official/demo', '--value-json', valueJson, '--json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: 'config:set',
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{ code: 'invalidArguments', message: 'error: invalid config mutation arguments' }],
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(valueJson);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sensitivePath);
  });

  it.each(['--json', '-j'] as const)(
    'does not treat a %s value-json argument as JSON intent',
    async (valueJson) => {
      const result = await runCliEntry([
        'plugin', 'config', 'set', 'official/demo', 'mode',
        '--value-json', valueJson, '--unknown=private-value',
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("error: unknown option '--unknown=private-value'");
    },
  );

  it.each([
    ['an attached scope value', ['-sj']],
    ['a following scope value', ['-s', '-j']],
  ] as const)('does not scan %s as short JSON options', async (_label, scopeOptions) => {
    const result = await runCliEntry([
      'plugin', 'config', 'set', 'official/demo', 'mode', ...scopeOptions, '--unknown',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown option '-s");
  });

  it('does not scan for JSON intent after --', async () => {
    const result = await runCliEntry(['plugin', 'config', 'set', '--', '--json']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("missing required argument 'field'");
  });

  it('emits a fail-closed config mutation receipt v7', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-missing-store-'));
    tempDirs.push(root);
    const noOp = await runCliEntry(['plugin', 'config', 'reset', 'git-commit', '--yes', '--json'], {
      cwd: root, env: { ...process.env, AW_HOME: path.join(root, 'aw-home'),
        CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
    });
    expect(noOp.exitCode).toBe(1);
    expect(noOp.parseJsonStdout()).toMatchObject({
      ok: false,
      command: 'config:reset',
      receiptSchemaVersion: 7,
      plugin: 'git-commit',
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [expect.objectContaining({ code: 'configStoreMissing' })],
    });
  });
});
