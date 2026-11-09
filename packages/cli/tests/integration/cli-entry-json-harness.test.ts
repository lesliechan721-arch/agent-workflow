import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCliEntry } from '../helpers/cli-entry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CLI JSON recovery and independent command harness', () => {
  it.each([
    [['dev', 'catalog', 'publish', 'apply', '--json'], "error: required option '--expected-plan-digest <sha256>' not specified"],
    [[
      'dev', 'catalog', 'publish', 'apply', '--json',
      '--expected-plan-digest', `sha256:${'a'.repeat(64)}`,
      '--unknown',
    ], "error: unknown option '--unknown'"],
  ] as const)('uses the unified Catalog publication argument failure contract for %j', async (argv, message) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1, command: 'dev.catalog.publish.apply', status: 'failed', data: {},
      diagnostics: [{ code: 'invalidArguments', message: expect.any(String) }], nextActions: [],
    });
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('redacts Catalog publication argument errors on stdout and stderr', async () => {
    const sensitivePath = '/Users/alice/private';
    const result = await runCliEntry([
      'dev', 'catalog', 'publish', 'apply', '--json',
      '--expected-plan-digest', `sha256:${'a'.repeat(64)}`,
      `--unknown=${sensitivePath}`,
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1, command: 'dev.catalog.publish.apply', status: 'failed', data: {},
      diagnostics: [{ code: 'invalidArguments', message: expect.any(String) }],
    });
    expect(result.stderr).not.toContain(sensitivePath);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sensitivePath);
  });

  it.each(['user', 'project'] as const)('emits one scoped recovery error for %s parse failures', async (scope) => {
    const result = await runCliEntry([
      'plugin', 'install', 'official/git-commit', '--scope', scope, '--json', '--unknown',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: 'plugin.install',
      diagnostics: [{ code: 'invalidArguments', message: expect.any(String) }],
      data: {}
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
      schemaVersion: 1,
      status: 'failed',
      command: 'plugin.install',
      diagnostics: [{ code: 'invalidOptionValue' }],
      data: {}
    });
  });

  it('does not expose the removed public upgrade command', async () => {
    const result = await runCliEntry(['upgrade', 'official/git-commit', '--json']);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({ schemaVersion: 1, command: null, status: 'failed', data: {}, diagnostics: [{ code: 'invalidArguments' }] });
  });

  it('publishes the runtime plugin capability contract with isolated stdout', async () => {
    const result = await runCliEntry([
      'dev', 'plugin', 'capabilities', '--surface', 'artifacts', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const value = result.parseJsonStdout<{ command: string; schemaVersion: number; data: { capabilities: { artifacts: Array<{ field: string; acceptedValues?: string[] }> } } }>();
    expect(value).toMatchObject({
      schemaVersion: 1,
      command: 'dev.plugin.capabilities',
      data: {}
    });
    expect(value.data.capabilities.artifacts).toContainEqual(expect.objectContaining({
      field: 'artifacts.targets[].platform',
      acceptedValues: ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'generic'],
    }));
    expect(value.data.capabilities.artifacts.some((entry) => entry.field.startsWith('artifacts.targets[].delivery'))).toBe(false);
  });

  it.each(['sync', 'status'] as const)('serializes real empty %s results as one complete document', async (command) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-empty-json-'));
    tempDirs.push(root);
    const env = {
      ...process.env, AW_HOME: path.join(root, 'aw-home'),
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude')
    };
    const result = await runCliEntry(['plugin', command, '--context', 'user', '--json', '--verbose'], { cwd: root, env });
    expect(result.exitCode).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1, command: `plugin.${command}`, status: 'success',
      data: command === 'sync' ? {
        request: { plugins: [], scope: null, context: 'user', targets: [], mode: 'apply' },
        requirements: { state: 'absent', roots: [] }, targetResults: [], remainingTargets: [],
        changes: { requirements: 'none', preferences: 'none', config: 'none', sources: 'none', outputs: 'none' },
      } : {
        requirements: { state: 'absent' }, inventory: [], extraObserved: [], allSatisfied: true,
      },
      diagnostics: [], nextActions: [],
    });
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stderr).toBe('');
  });

  it.each([
    ['set', ['plugin', 'config', 'set', '--json']],
    ['unset', ['plugin', 'config', 'unset', '-j']],
    ['reset', ['plugin', 'config', 'reset', '--json']],
  ] as const)('emits one unified config result when config %s arguments are missing', async (
    command,
    argv,
  ) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: `plugin.config.${command}`,
      diagnostics: [{ code: 'invalidArguments', message: expect.any(String) }],
      data: {}
    });
    expect(result.stderr).not.toContain('private-value');
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
      schemaVersion: 1,
      status: 'failed',
      command: `plugin.config.${command}`,
      diagnostics: [{
        code: 'invalidArguments',
        message: expect.any(String),
      }],
      data: {}
    });
    expect(result.stderr).not.toContain('private-value');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('private-value');
  });

  it.each([
    ['set', [
      'plugin', 'config', 'set', 'official/demo', 'mode',
      '--value-json', '"safe"', '--json', '--unknown=private-value',
    ]],
    ['unset', ['plugin', 'config', 'unset', 'official/demo', 'mode', '-j', '--unknown=private-value']],
    ['reset', ['plugin', 'config', 'reset', 'official/demo', '--yes', '--json', '--unknown=private-value']],
  ] as const)('emits one safe unified config result for config %s unknown options', async (
    command,
    argv,
  ) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: `plugin.config.${command}`,
      diagnostics: [{
        code: 'invalidArguments',
        message: expect.any(String),
      }],
      data: {}
    });
    expect(result.stderr).not.toContain('private-value');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('private-value');
  });

  it('emits one unified config result for an action failure', async () => {
    const result = await runCliEntry([
      'plugin', 'config', 'set', 'official/demo', 'mode', '--json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: 'plugin.config.set',
      diagnostics: [{
        code: 'invalidArguments',
        message: expect.any(String),
      }],
      data: {}
    });
    expect(result.stderr).not.toContain('private-value');
  });

  it.each([['schema', '-jv'], ['get', '-vj']])(
    'keeps config %s parse failures outside mutation receipts', async (command, jsonOptions) => {
      const result = await runCliEntry(['plugin', 'config', command, 'official/demo', jsonOptions, '--unknown']);
      expect(result.exitCode).toBe(2);
      expect(result.parseJsonStdout()).toMatchObject({
        schemaVersion: 1,
        status: 'failed',
        command: `plugin.config.${command}`,
        diagnostics: [{ code: 'invalidArguments' }],
        data: {}
      });
      expect(result.parseJsonStdout()).not.toHaveProperty('receiptSchemaVersion');
    });

  it.each([['apply', '-yj']])(
    'uses unified result for config %s parse failures', async (command, jsonOptions) => {
      const result = await runCliEntry(['plugin', 'config', command, 'official/demo', jsonOptions, '--unknown']);
      expect(result.exitCode).toBe(2);
      expect(result.parseJsonStdout()).toMatchObject({
        schemaVersion: 1,
        status: 'failed',
        command: `plugin.config.${command}`,
        diagnostics: [{ code: 'invalidArguments' }],
        data: {}
      });
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
      schemaVersion: 1,
      status: 'failed',
      command: 'plugin.config.set',
      diagnostics: [{ code: 'invalidArguments', message: expect.any(String) }],
      data: {}
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
      expect(() => JSON.parse(result.stdout)).toThrow();
      expect(result.stderr).toContain('--unknown');
      expect(result.stderr).not.toContain('private-value');
    },
  );

  it.each([
    ['an attached context value', ['--context=-j']],
    ['a following context value', ['--context', '-j']],
  ] as const)('does not scan %s as short JSON options', async (_label, scopeOptions) => {
    const result = await runCliEntry([
      'plugin', 'config', 'set', 'official/demo', 'mode', ...scopeOptions, '--unknown',
    ]);

    expect(result.exitCode).toBe(2);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stderr).toContain('--context');
  });

  it('does not scan for JSON intent after --', async () => {
    const result = await runCliEntry(['plugin', 'config', 'set', '--', '--json']);

    expect(result.exitCode).toBe(2);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stderr).toContain("missing required argument 'field'");
  });

  it('fails closed when the selected config store is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-missing-store-'));
    tempDirs.push(root);
    const noOp = await runCliEntry(['plugin', 'config', 'reset', 'git-commit', '--yes', '--json'], {
      cwd: root, env: { ...process.env, AW_HOME: path.join(root, 'aw-home'),
        CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
    });
    expect(noOp.exitCode).toBe(1);
    expect(noOp.parseJsonStdout()).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      command: 'plugin.config.reset',
      diagnostics: [expect.objectContaining({ code: 'configStoreMissing' })],
      data: {
        plugin: 'git-commit',
        configWrite: 'notStarted'
      }
    });
  });
});
