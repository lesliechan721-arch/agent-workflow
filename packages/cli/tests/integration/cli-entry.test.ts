import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import type { InstalledLedger } from '../../src/types.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
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

function createCapturedIo() {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  const codexHome = path.join(root, 'codex-home');
  const claudeHome = path.join(root, 'claude-home');

  const env = {
    ...process.env,
    AW_HOME: awHome,
    AW_CODEX_HOME: codexHome,
    AW_CLAUDE_HOME: claudeHome,
    AW_FORCE_CODEX_AVAILABLE: '1',
    PATH: '',
  } as NodeJS.ProcessEnv;

  return {
    repoRoot,
    awHome,
    codexHome,
    claudeHome,
    embeddedRoot,
    env,
  };
}

function createDegradedLedger(): InstalledLedger {
  return {
    version: 1,
    ledgerState: {
      status: 'degraded',
      degradedAt: '2026-04-28T00:00:00.000Z',
      reason: 'operation_interrupted_after_native_write',
    },
    plugins: {},
  };
}

async function readCodexAllowImplicitInvocation(awHome: string): Promise<boolean> {
  const openAiYamlPath = path.join(
    awHome,
    'plugins',
    'git-commit',
    'codex',
    'skills',
    'commit',
    'agents',
    'openai.yaml',
  );
  const parsed = YAML.parse(await fs.readFile(openAiYamlPath, 'utf8')) as {
    policy?: { allow_implicit_invocation?: boolean };
  };
  return parsed.policy?.allow_implicit_invocation === true;
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cli entry integration', () => {
  it('rejects invalid --skill-trigger values at the source entry', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--skill-trigger', 'sometimes'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('Unsupported skill trigger preference "sometimes"');
  });

  it('applies install --skill-trigger manual, auto, and default through runCli', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    for (const [preference, expected] of [
      ['manual', false],
      ['auto', true],
      ['default', true],
    ] as const) {
      const { io, readStderr } = createCapturedIo();
      const exitCode = await runCli(
        [
          'install',
          'git-commit',
          '--scope',
          'user',
          '--platform',
          'codex',
          '--skill-trigger',
          preference,
        ],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
          io,
        },
      );

      expect(exitCode, readStderr()).toBe(0);
      expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(expected);
    }
  });

  it('applies explicit upgrade --skill-trigger manual, auto, and default through runCli', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '--skill-trigger',
        'auto',
      ],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);

    for (const [preference, expected] of [
      ['manual', false],
      ['auto', true],
      ['default', true],
    ] as const) {
      capture = createCapturedIo();
      const exitCode = await runCli(
        [
          'upgrade',
          'git-commit',
          '--scope',
          'user',
          '--platform',
          'codex',
          '--skill-trigger',
          preference,
        ],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
          io: capture.io,
        },
      );

      expect(exitCode, capture.readStderr()).toBe(0);
      expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(expected);
    }
  });

  it('rejects upgrade --all --skill-trigger at the entry layer', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();

    const exitCode = await runCli(
      ['upgrade', '--all', '--platform', 'codex', '--skill-trigger', 'manual'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('`upgrade --all` 首版不支持 `--skill-trigger`');
  });

  it('prints degraded replay warnings before upgrade --all errors', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);

    await writeInstalledLedger(createDegradedLedger(), workspace.env);
    await fs.writeFile(path.join(workspace.awHome, 'config.json'), '{"version":', 'utf8');

    capture = createCapturedIo();
    const exitCode = await runCli(
      ['upgrade', '--all', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    const stderr = capture.readStderr();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('跳过 skill trigger 偏好 replay');
    expect(stderr).toContain('`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行');
    expect(stderr.indexOf('跳过 skill trigger 偏好 replay')).toBeLessThan(
      stderr.indexOf('`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行'),
    );
  });

  it('prints degraded replay warnings before explicit upgrade inheritance errors', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);

    const degraded = createDegradedLedger();
    degraded.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(degraded, workspace.env);
    await fs.writeFile(path.join(workspace.awHome, 'config.json'), '{"version":', 'utf8');

    capture = createCapturedIo();
    const exitCode = await runCli(
      ['upgrade', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    const stderr = capture.readStderr();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('跳过 skill trigger 偏好 replay');
    expect(stderr).toContain('无法从 degraded installed.json 安全恢复');
    expect(stderr.indexOf('跳过 skill trigger 偏好 replay')).toBeLessThan(
      stderr.indexOf('无法从 degraded installed.json 安全恢复'),
    );
  });

  it('prints preparation warnings once for init and install entry flows', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);

    const degraded = createDegradedLedger();
    degraded.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(degraded, workspace.env);

    capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);
    expect(capture.readStderr().match(/跳过 skill trigger 偏好 replay/g)).toHaveLength(1);

    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    await fs.writeFile(path.join(workspace.awHome, 'config.json'), '{"version":', 'utf8');
    capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '--skill-trigger',
        'manual',
      ],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);
    expect(capture.readStderr().match(/跳过 skill trigger 偏好 replay/g)).toBeNull();
  });
});
