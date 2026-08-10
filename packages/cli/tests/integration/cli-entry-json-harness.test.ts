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

function rebuildResult(status: 'succeeded' | 'failed') {
  return {
    platforms: ['codex'],
    plugins: ['git-commit'],
    warnings: [],
    overallState: status,
    rebuildResults: [{
      status,
      command: 'install',
      target: {
        pluginName: 'git-commit',
        pluginVersion: '1.0.0',
        platform: 'codex',
        scope: 'user',
        cwd: '/workspace',
      },
      actions: status === 'succeeded'
        ? [{ name: 'postcheck.inspect', status: 'succeeded' }]
        : [{ name: 'postcheck.inspect', status: 'failed' }],
      cleanupAttempted: status === 'failed',
      removed: [],
      absent: [],
      residual: [],
      quarantined: [],
      failures: status === 'failed'
        ? [{ phase: 'postcheck.inspect', message: 'live ownership check failed' }]
        : [],
      ...(status === 'failed'
        ? { error: { phase: 'postcheck.inspect', message: 'live ownership check failed' } }
        : {}),
    }],
  };
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../../src/commands/status.js');
  vi.doUnmock('../../src/commands/write-commands.js');
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await setEmbeddedRootOverride(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CLI JSON v3 harness', () => {
  it('keeps status v3 JSON on stdout and verbose notices on stderr', async () => {
    vi.resetModules();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-v3-'));
    tempDirs.push(tempDir);
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand: vi.fn(async (_plugins, _options, context) => {
        await context.reporter.notice({
          level: 'info',
          message: 'live ownership detail',
          identity: 'status-live-detail',
          target: 'stderr',
        });
        const payload = {
          schemaVersion: 3,
          catalog: { source: 'cache', catalogVersion: '1.0.0' },
          filters: {
            plugins: ['git-commit'],
            platform: 'codex',
            scope: 'project',
            cwd: tempDir,
          },
          targets: [{
            target: {
              plugin: 'git-commit',
              version: '1.0.0',
              platform: 'codex',
              scope: 'project',
              cwd: tempDir,
            },
            state: 'partial',
            components: [],
            errors: [],
            recommendation: {
              command: 'aw reinstall git-commit -p codex -s project',
              reason: 'partial',
            },
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
    expect(result.parseJsonStdout()).toMatchObject({
      schemaVersion: 3,
      targets: [{ state: 'partial' }],
    });
    expect(result.stdout).not.toContain('live ownership detail');
    expect(result.stderr).toContain('live ownership detail');
  });

  it('returns empty stdout, stderr error text, and exit 1 for a status execution error', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-json-error-'));
    tempDirs.push(tempDir);
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand: vi.fn(async () => {
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

  it('emits write receipt v3 and maps target success or failure to the exit code', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-write-json-v3-'));
    tempDirs.push(tempDir);
    const commands = {
      installWriteCommand: vi.fn(async () => rebuildResult('succeeded')),
      upgradeWriteCommand: vi.fn(),
      reinstallWriteCommand: vi.fn(),
      uninstallWriteCommand: vi.fn(),
      cleanupWriteCommand: vi.fn(),
    };
    vi.doMock('../../src/commands/write-commands.js', () => commands);

    const success = await runCliEntry(
      ['install', 'git-commit', '-p', 'codex', '--json'],
      { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv },
    );
    expect(success.exitCode).toBe(0);
    expect(success.stderr).toBe('');
    expect(success.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'install',
      receiptSchemaVersion: 3,
      overallState: 'succeeded',
      targets: [{ plugin: 'git-commit', status: 'succeeded' }],
    });

    commands.installWriteCommand.mockResolvedValueOnce(rebuildResult('failed') as never);
    const failure = await runCliEntry(
      ['install', 'git-commit', '-p', 'codex', '--json'],
      { cwd: tempDir, env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv },
    );
    expect(failure.exitCode).toBe(1);
    expect(failure.parseJsonStdout()).toMatchObject({
      ok: false,
      receiptSchemaVersion: 3,
      overallState: 'failed',
      targets: [{ status: 'failed', failures: [{ message: 'live ownership check failed' }] }],
    });
  });

  it('emits config receipt v3 and keeps confirmation errors off stdout', async () => {
    const workspace = await makeWorkspace();
    await setEmbeddedRootOverride(workspace.embeddedRoot);

    const noOp = await runCliEntry(
      ['config', 'reset', 'git-commit', '-s', 'user', '--yes', '--json'],
      { cwd: workspace.repoRoot, env: workspace.env },
    );
    expect(noOp.exitCode, noOp.stderr).toBe(0);
    expect(noOp.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'config:reset',
      receiptSchemaVersion: 3,
      plugin: 'git-commit',
      scope: 'user',
      deleted: false,
    });

    await fs.outputJson(
      path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'),
      { version: 1, values: { mode: 'strict' } },
    );
    const blocked = await runCliEntry(
      ['config', 'reset', 'git-commit', '-s', 'user', '--json'],
      { cwd: workspace.repoRoot, env: workspace.env },
    );
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toContain('Reset requires confirmation');
  });
});
