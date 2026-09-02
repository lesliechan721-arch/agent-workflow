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

describe('CLI JSON Status v7 and Receipt v6 harness', () => {
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
        ]),
      },
    });
  });

  it('keeps exact status v7 JSON on stdout', async () => {
    vi.resetModules();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-v3-'));
    tempDirs.push(tempDir);
    vi.doMock('../../src/commands/status-v6.js', () => ({
      statusCommandV7: vi.fn(async () => {
        const payload = {
          schemaVersion: 7,
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
            platform: 'codex',
            scope: 'project',
            cwd: tempDir,
            state: 'needsSync',
            components: [
              {
                kind: 'intent',
                key: 'desired',
                state: 'desired',
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
      schemaVersion: 7,
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
        scope: 'project', cwd: tempDir,
        state: 'needsSync',
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
      errors: [],
    });
    expect(result.stdout).not.toContain('调试：');
    expect(result.stderr).toContain('调试：command:start');
  });

  it('returns empty stdout, stderr error text, and exit 1 for a status execution error', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-error-'));
    tempDirs.push(tempDir);
    vi.doMock('../../src/commands/status-v6.js', () => ({
      statusCommandV7: vi.fn(async () => {
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

  it.each([
    'codexProjectPluginVersionTooLow',
    'codexProjectPluginUnsupported',
    'codexSystemCliUnsupported',
  ])('emits only the official system Codex CLI recovery for %s', async (code) => {
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

  it('emits a fail-closed config mutation receipt v5', async () => {
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
      receiptSchemaVersion: 5,
      plugin: 'git-commit',
      overallState: 'failed',
      errors: [expect.objectContaining({ code: 'configStoreMissing' })],
    });
  });
});
