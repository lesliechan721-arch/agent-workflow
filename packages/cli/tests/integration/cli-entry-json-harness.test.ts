import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../helpers/cli-entry.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-json-v3-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  return {
    repoRoot,
    awHome,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    },
  };
}

async function setEmbeddedRootOverride(rootDir: string | null): Promise<void> {
  const paths = await import('../../src/utils/paths.js');
  paths.setEmbeddedPluginsRootOverrideForTests(rootDir);
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../../src/commands/status-v6.js');
  vi.doUnmock('../../src/commands/write-commands.js');
  vi.doUnmock('../../src/recovery/coordinator.js');
  vi.doUnmock('../../src/recovery/status.js');
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await setEmbeddedRootOverride(null);
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
      'install', 'official/git-commit', '--scope', scope, '--target', 'codex', '--json', '--unknown',
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
      'install', 'official/git-commit', '--scope', 'project', '--target', 'invalid', '--json',
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
    expect(result.parseJsonStdout()).toMatchObject({
      command: 'plugin:capabilities',
      schemaVersion: 1,
      surface: 'artifacts',
      capabilities: {
        artifacts: expect.arrayContaining([
          expect.objectContaining({ field: 'artifacts.targets[].target', owner: 'core' }),
          expect.objectContaining({
            field: 'artifacts.targets[].delivery',
            owner: 'core',
            profiles: 'CODEX dynamic Skill',
          }),
          {
            field: 'artifacts.targets[].delivery.identity',
            type: 'literal shared',
            required: 'when delivery.mode is codex-native',
            acceptedValues: ['shared'],
            owner: 'core',
            provenance: ['@lesliechan721/aw-plugin-core manifest structure registry'],
          },
          {
            field: 'artifacts.targets[].delivery.renderProfile',
            type: 'literal user',
            required: 'when delivery.mode is codex-native',
            acceptedValues: ['user'],
            owner: 'core',
            provenance: ['@lesliechan721/aw-plugin-core manifest structure registry'],
          },
        ]),
      },
    });
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
      'sync', 'official/git-commit', '--scope', 'project', '--target', 'codex', '--json',
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
    const result = await runCliEntry(['status', '--scope', 'user', '--json', '--verbose'], {
      cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv,
    });
    expect(result.exitCode).toBe(0);
    expect(result.parseJsonStdout()).toEqual(status);
    expect(result.stderr).toBe('');
    expect(readRecoveryStatus).toHaveBeenCalledOnce();
  });

  it.each([
    ['set', ['config', 'set', '--json']],
    ['unset', ['config', 'unset', '-j']],
    ['reset', ['config', 'reset', '--json']],
  ] as const)('emits one Config Mutation Receipt v7 when config %s arguments are missing', async (
    command,
    argv,
  ) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(1);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: `config:${command}`,
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{ code: 'invalidArguments', message: expect.stringContaining('Usage:') }],
    });
    expect(result.stderr.match(/Usage:/gu)).toHaveLength(1);
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
      'config', command, cluster, ...clusterValue, '--unknown=private-value',
    ]);

    expect(result.exitCode).toBe(1);
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
      'config', 'set', 'official/demo', 'mode',
      '--value-json', '"safe"', '--json', '--unknown=private-value',
    ]],
    ['unset', ['config', 'unset', 'official/demo', 'mode', '-j', '--unknown=private-value']],
    ['reset', ['config', 'reset', 'official/demo', '--yes', '--json', '--unknown=private-value']],
  ] as const)('emits one safe Config Mutation Receipt v7 for config %s unknown options', async (
    command,
    argv,
  ) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(1);
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
      'config', 'set', 'official/demo', 'mode', '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: 'config:set',
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{
        code: 'configMutationFailed',
        message: 'Use exactly one of --value-json <json>, --value-stdin, or --preset <id>.',
      }],
    });
    expect(result.stderr).toBe(
      'Use exactly one of --value-json <json>, --value-stdin, or --preset <id>.\n',
    );
  });

  it.each([
    ['list', '-jv'],
    ['get', '-vj'],
  ] as const)(
    'does not misclassify config %s parsing failures as mutation receipts',
    async (command, jsonOptions) => {
      const result = await runCliEntry([
        'config', command, 'official/demo', jsonOptions, '--unknown',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("error: unknown option '--unknown'");
    },
  );

  it('does not expose a secret value-json token in a config set usage failure', async () => {
    const sensitivePath = path.join(os.tmpdir(), 'private', 'config-secret.json');
    const secret = 'config-secret-value';
    const valueJson = JSON.stringify({ path: sensitivePath, token: secret });
    const result = await runCliEntry([
      'config', 'set', 'official/demo', '--value-json', valueJson, '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      command: 'config:set',
      receiptSchemaVersion: 7,
      overallState: 'failed',
      configWrite: 'notStarted',
      errors: [{ code: 'invalidArguments', message: expect.stringContaining('Usage:') }],
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(valueJson);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(sensitivePath);
  });

  it.each(['--json', '-j'] as const)(
    'does not treat a %s value-json argument as JSON intent',
    async (valueJson) => {
      const result = await runCliEntry([
        'config', 'set', 'official/demo', 'mode',
        '--value-json', valueJson, '--unknown=private-value',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("error: unknown option '--unknown=private-value'");
    },
  );

  it.each([
    ['an attached scope value', ['-sj']],
    ['a following scope value', ['-s', '-j']],
  ] as const)('does not scan %s as short JSON options', async (_label, scopeOptions) => {
    const result = await runCliEntry([
      'config', 'set', 'official/demo', 'mode', ...scopeOptions, '--unknown',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown option '--unknown'");
  });

  it('does not scan for JSON intent after --', async () => {
    const result = await runCliEntry(['config', 'set', '--', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: aw config set');
  });

  it('emits a fail-closed config mutation receipt v7', async () => {
    const workspace = await makeWorkspace();
    await setEmbeddedRootOverride(workspace.embeddedRoot);

    const noOp = await runCliEntry(
      ['config', 'reset', 'git-commit', '-s', 'user', '--yes', '--json'],
      { cwd: workspace.repoRoot, env: workspace.env },
    );
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
