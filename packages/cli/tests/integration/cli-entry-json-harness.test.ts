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
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await setEmbeddedRootOverride(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CLI JSON Status v8 and Receipt v6 harness', () => {
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

  it.each([
    ['install', '-jy'],
    ['reinstall', '-jy'],
    ['uninstall', '-j'],
    ['cleanup', '-j'],
    ['sync', '-jy'],
  ] as const)('emits one exact Receipt v6 when %s short options fail during Commander parsing', async (
    command,
    jsonOption,
  ) => {
    const result = await runCliEntry([
      command, 'official/git-commit', '-sproject', '-pcodex', jsonOption, '--unknown',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.parseJsonStdout()).toEqual({
      ok: false,
      command,
      receiptSchemaVersion: 6,
      overallState: 'failed',
      changes: [],
      targetResults: [{
        target: {
          pluginName: 'git-commit',
          pluginId: 'official/git-commit',
          sourceId: 'official',
          platform: 'codex',
          scope: 'project',
        },
        action: command,
        state: 'failed',
        message: "error: unknown option '--unknown'",
        errorCode: 'invalidArguments',
        relation: 'requested',
        requiredBy: [],
        changes: [],
        recoveryActions: ['run sync', 'run reinstall', 'run cleanup for AW-owned residue'],
        cleanupAttempted: false,
        actions: [],
        removed: [],
        absent: [],
        residual: [],
        quarantined: [],
        failures: [],
      }],
      warnings: [],
      recoveryActions: ['run sync', 'run reinstall', 'run cleanup for AW-owned residue'],
      errors: [{ code: 'invalidArguments', message: "error: unknown option '--unknown'" }],
    });
  });

  it('projects attached short option values in a JSON failure receipt', async () => {
    const result = await runCliEntry([
      'install', 'official/git-commit', '-sproject', '-pclaude', '-j', '--unknown',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.parseJsonStdout()).toMatchObject({
      errors: [{ code: 'invalidArguments' }],
      receiptSchemaVersion: 6,
      targetResults: [expect.objectContaining({
        action: 'install',
        state: 'failed',
        target: expect.objectContaining({
          pluginId: 'official/git-commit', platform: 'claude', scope: 'project',
        }),
      })],
    });
  });

  it.each([
    [['install', 'official/git-commit', '-sproject', '-pinvalid', '-j'], 'invalidArguments'],
    [['sync', 'official/git-commit', '-p', 'claude', '--json'], 'invalidArguments'],
  ] as const)('uses a stable early failure code for %j', async (argv, code) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      receiptSchemaVersion: 6,
      overallState: 'failed',
      errors: [{ code, message: expect.any(String) }],
      changes: expect.any(Array),
      targetResults: expect.any(Array),
      recoveryActions: expect.any(Array),
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

  it('keeps exact status v8 JSON on stdout', async () => {
    vi.resetModules();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-v3-'));
    tempDirs.push(tempDir);
    vi.doMock('../../src/commands/status-v6.js', () => ({
      statusCommandV8: vi.fn(async () => {
        const payload = {
          schemaVersion: 8,
          catalog: {
            primarySourceId: 'official',
            configDigest: 'sha256:config',
            compositeDigest: 'sha256:composite',
            sources: [],
          },
          filters: {
            plugins: ['git-commit'],
            platform: 'codex',
            scope: 'project',
            cwd: tempDir,
          },
          targets: [{
            pluginName: 'git-commit',
            pluginId: 'official/git-commit',
            sourceId: 'official',
            sourceIdentity: 'sha256:source',
            version: '1.0.0',
            platform: 'codex', cwd: tempDir,
            state: 'needsSync',
            components: [],
            reasons: [{
              code: 'codexExtensionDrift',
              message: 'codexExtensionDrift: extension drift requires repair.',
              severity: 'warning',
            }],
            recoveryActions: [{ command: 'reinstall', scope: 'project', description: 'repair drift' }],
            placements: [{
              scope: 'project', state: 'needsSync',
              components: [
                {
                  kind: 'intent', key: 'desired', state: 'desired',
                  metadata: { enabled: true, scopes: ['project'], relation: 'root' },
                },
                { kind: 'ownership', key: 'aw', state: 'partial' },
              ],
              reasons: [{
                code: 'codexExtensionDrift',
                message: 'codexExtensionDrift: extension drift requires repair.',
                severity: 'warning',
              }],
              recoveryActions: [{ command: 'reinstall', scope: 'project', description: 'repair drift' }],
            }],
          }],
          errors: [],
        };
        return {
          output: JSON.stringify(payload),
          payload,
          pluginSummaries: [],
          hasErrors: false,
          targetRevisions: [],
        };
      }),
    }));

    const result = await runCliEntry(
      ['status', 'git-commit', '-p', 'codex', '-s', 'project', '--json', '--verbose'],
      { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toEqual({
      schemaVersion: 8,
      catalog: {
        primarySourceId: 'official', configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite', sources: [],
      },
      filters: {
        plugins: ['git-commit'], platform: 'codex', scope: 'project', cwd: tempDir,
      },
      targets: [{
        pluginName: 'git-commit', pluginId: 'official/git-commit', sourceId: 'official',
        sourceIdentity: 'sha256:source', version: '1.0.0', platform: 'codex',
        cwd: tempDir,
        state: 'needsSync',
        components: [],
        reasons: [{
          code: 'codexExtensionDrift',
          message: 'codexExtensionDrift: extension drift requires repair.',
          severity: 'warning',
        }],
        recoveryActions: [{ command: 'reinstall', scope: 'project', description: 'repair drift' }],
        placements: [{
          scope: 'project', state: 'needsSync',
          components: [
            {
              kind: 'intent', key: 'desired', state: 'desired',
              metadata: { enabled: true, scopes: ['project'], relation: 'root' },
            },
            { kind: 'ownership', key: 'aw', state: 'partial' },
          ],
          reasons: [{
            code: 'codexExtensionDrift',
            message: 'codexExtensionDrift: extension drift requires repair.',
            severity: 'warning',
          }],
          recoveryActions: [{ command: 'reinstall', scope: 'project', description: 'repair drift' }],
        }],
      }],
      errors: [],
    });
    expect(result.stdout).not.toContain('调试：');
    expect(result.stderr).toContain('调试：command:start');
  });

  it('returns empty stdout, stderr error text, and exit 1 for a status execution error', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-error-'));
    tempDirs.push(tempDir);
    vi.doMock('../../src/commands/status-v6.js', () => ({
      statusCommandV8: vi.fn(async () => {
        throw new Error('status inspection failed');
      }),
    }));

    const result = await runCliEntry(
      ['status', 'git-commit', '--json'],
      { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('status inspection failed');
  });

  it.each([
    'install',
    'reinstall',
    'uninstall',
    'cleanup',
  ] as const)('emits a namespaced successful %s receipt with the requested target', async (command) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-write-json-v3-'));
    tempDirs.push(tempDir);
    const result = {
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
      rebuildResults: [],
      targetResults: [],
      overallState: 'succeeded',
      receiptTargets: [{
        pluginName: 'git-commit',
        pluginId: 'official/git-commit',
        sourceId: 'official',
        platform: 'codex',
        scope: 'project',
      }],
    };
    const commands = {
      installWriteCommand: vi.fn(async () => result),
      reinstallWriteCommand: vi.fn(async () => result),
      uninstallWriteCommand: vi.fn(async () => result),
      cleanupWriteCommand: vi.fn(async () => result),
    };
    vi.doMock('../../src/commands/write-commands.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../src/commands/write-commands.js')>(),
      ...commands,
    }));

    const success = await runCliEntry(
      [command, 'official/git-commit', '-p', 'codex', '-s', 'project', '--json'],
      { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv },
    );
    expect(success.exitCode).toBe(0);
    const receipt = success.parseJsonStdout();
    expect(receipt).toMatchObject({
      ok: true,
      command,
      receiptSchemaVersion: 6,
      overallState: 'succeeded',
      changes: [command],
      targetResults: [{
        target: {
          pluginName: 'git-commit',
          pluginId: 'official/git-commit',
          sourceId: 'official',
          platform: 'codex',
          scope: 'project',
        },
        action: command,
        state: 'completed',
        relation: 'requested',
        requiredBy: [],
        changes: [command],
        recoveryActions: [],
        cleanupAttempted: false,
        actions: [],
        removed: [],
        absent: [],
        residual: [],
        quarantined: [],
        failures: [],
      }],
      recoveryActions: [],
      errors: [],
    });
    expect(receipt).not.toHaveProperty('layers');
    expect(receipt).not.toHaveProperty('targets');
    expect(commands[`${command}WriteCommand` as keyof typeof commands]).toHaveBeenCalledOnce();
  });

  it('emits only the official system Codex CLI recovery for an unsupported consumer', async () => {
    const code = 'codexSystemCliUnsupported';
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-write-json-codex-recovery-'));
    tempDirs.push(tempDir);
    const error = Object.assign(new Error(`${code}: consumer probe failed`), { code });
    const installWriteCommand = vi.fn(async () => {
      throw error;
    });
    vi.doMock('../../src/commands/write-commands.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../src/commands/write-commands.js')>(),
      installWriteCommand,
    }));

    const result = await runCliEntry(
      ['install', 'official/demo', '-p', 'codex', '-s', 'project', '-jy'],
      { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      errors: [{ code }],
      receiptSchemaVersion: 6,
      targetResults: [{
        target: { pluginId: 'official/demo' },
        recoveryActions: [
          'upgrade or repair the official system Codex CLI, then retry the original operation',
        ],
      }],
      recoveryActions: [
        'upgrade or repair the official system Codex CLI, then retry the original operation',
      ],
    });
    expect(installWriteCommand).toHaveBeenCalledOnce();
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
