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
    ['install', []],
    ['upgrade', []],
    ['reinstall', []],
    ['uninstall', []],
    ['cleanup', []],
  ])('emits a namespaced %s receipt with the explicit qualified target', async (command) => {
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
      nativePlugins: {},
      repoManagedArtifacts: [],
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
