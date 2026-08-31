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

describe('CLI JSON Status v6 and Receipt v5 harness', () => {
  it.each([
    ['install', 'add', '-jy'],
    ['upgrade', 'keep', '-jy'],
    ['reinstall', 'keep', '-jy'],
    ['uninstall', 'remove', '-j'],
    ['cleanup', 'keep', '-j'],
    ['sync', 'keep', '-jy'],
  ] as const)('emits one exact Receipt v5 when %s short options fail during Commander parsing', async (
    command,
    action,
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
      receiptSchemaVersion: 5,
      overallState: 'failed',
      layers: {
        projectIntent: [{
          pluginId: 'official/git-commit',
          platform: 'codex',
          scope: 'project',
          relation: 'requested',
          action,
          requiredBy: [],
        }],
        userIntent: [],
        sharedCodexNative: [],
        userActivation: [],
        projectActivation: [],
        awExtensions: [],
      },
      targets: [{
        pluginName: 'git-commit',
        pluginId: 'official/git-commit',
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
        recovery: [`correct the ${command} request and retry`],
      }],
      warnings: [],
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
      layers: {
        projectIntent: [expect.objectContaining({
          pluginId: 'official/git-commit', platform: 'claude', scope: 'project',
        })],
      },
      targets: [expect.objectContaining({ platform: 'claude', scope: 'project' })],
    });
  });

  it.each([
    [['install', 'official/git-commit', '-sproject', '-pinvalid', '-j'], 'invalidArguments'],
    [['upgrade', 'official/git-commit', '--all', '-p', 'codex', '--json'], 'invalidArguments'],
    [['sync', 'official/git-commit', '-p', 'claude', '--json'], 'invalidArguments'],
  ] as const)('uses a stable early failure code for %j', async (argv, code) => {
    const result = await runCliEntry([...argv]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.parseJsonStdout()).toMatchObject({
      ok: false,
      receiptSchemaVersion: 5,
      overallState: 'failed',
      errors: [{ code, message: expect.any(String) }],
      layers: {
        projectIntent: expect.any(Array),
        userIntent: expect.any(Array),
        sharedCodexNative: [],
        userActivation: [],
        projectActivation: [],
        awExtensions: [],
      },
    });
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

  it('keeps exact status v6 JSON on stdout', async () => {
    vi.resetModules();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-v3-'));
    tempDirs.push(tempDir);
    vi.doMock('../../src/commands/status-v6.js', () => ({
      statusCommandV6: vi.fn(async () => {
        const payload = {
          schemaVersion: 6,
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
            desired: { enabled: true, scopes: ['project'], relation: 'root' },
            actual: { state: 'drifted' },
            state: 'partial',
            components: [],
            errors: [],
            recovery: [{ command: 'reinstall', scope: 'project', description: 'repair drift' }],
          }],
          errors: [],
        };
        return {
          output: JSON.stringify(payload),
          payload,
          plugins: [],
          hasErrors: false,
        };
      }),
    }));

    const result = await runCliEntry(
      ['status', 'git-commit', '-p', 'codex', '-s', 'project', '--json', '--verbose'],
      { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toEqual({
      schemaVersion: 6,
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
        desired: { enabled: true, scopes: ['project'], relation: 'root' },
        actual: { state: 'drifted' }, state: 'partial', components: [], errors: [],
        recovery: [{ command: 'reinstall', scope: 'project', description: 'repair drift' }],
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
      statusCommandV6: vi.fn(async () => {
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
    ['install', 'add'],
    ['upgrade', 'keep'],
    ['reinstall', 'keep'],
    ['uninstall', 'remove'],
    ['cleanup', 'keep'],
  ] as const)('emits a namespaced successful %s receipt with the explicit desired intent', async (
    command,
    intentAction,
  ) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-write-json-v3-'));
    tempDirs.push(tempDir);
    const result = {
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
      rebuildResults: [],
      targetResults: [],
      overallState: 'succeeded',
      layers: {
        projectIntent: [], userIntent: [], sharedCodexNative: [],
        userActivation: [], projectActivation: [], awExtensions: [],
      },
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
      upgradeWriteCommand: vi.fn(async () => result),
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
    expect(success.parseJsonStdout()).toMatchObject({
      ok: true,
      command,
      receiptSchemaVersion: 5,
      overallState: 'succeeded',
      layers: {
        projectIntent: [expect.objectContaining({
          pluginId: 'official/git-commit', action: intentAction,
        })],
      },
      targets: [{
        pluginName: 'git-commit',
        pluginId: 'official/git-commit',
        sourceId: 'official',
        platform: 'codex',
        scope: 'project',
        status: 'succeeded',
        desired: { scope: 'project', relation: 'requested' },
        recovery: [],
      }],
      errors: [],
    });
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
      targets: [{
        pluginId: 'official/demo',
        recovery: [
          'upgrade or repair the official system Codex CLI, then retry the original operation',
        ],
      }],
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
      errors: [expect.objectContaining({ code: 'sourceMissing' })],
    });
  });
});
