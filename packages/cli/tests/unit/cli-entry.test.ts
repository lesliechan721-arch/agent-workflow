import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandWarningError } from '../../src/types.js';
import { NativeCliError } from '../../src/utils/native-cli.js';

const tempDirs: string[] = [];

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

async function readCliPackageVersion(): Promise<string> {
  const packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'package.json',
  );
  const packageJson = await fs.readJson(packageJsonPath) as { version: string };
  return packageJson.version;
}

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cli entry', () => {
  it.each([
    ['--version'],
    ['-V'],
  ])('prints the current CLI version for %s', async (flag) => {
    const expectedVersion = await readCliPackageVersion();
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli([flag], {
      cwd: '/tmp/workspace',
      env: {} as NodeJS.ProcessEnv,
      io,
    });

    expect(exitCode).toBe(0);
    expect(readStdout()).toBe(`${expectedVersion}\n`);
    expect(readStderr()).toBe('');
  });

  it('rejects deprecated --skill-trigger at the entry layer', async () => {
    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--skill-trigger', 'sometimes'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('`install` 不再接受 `--skill-trigger` / `-t`');
  });

  it('rejects install --skill-trigger before dispatching installCommand', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io } = createCapturedIo();
    const env = {} as NodeJS.ProcessEnv;
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--skill-trigger', 'manual'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(installCommand).not.toHaveBeenCalled();
  });

  it('prints a readable install receipt without English warning prefixes', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      nativePlugins: {
        codex: ['git-commit'],
      },
      marketplace: {
        rootDir: '/tmp/aw-home',
        changed: false,
        catalog: {
          rootDir: '/tmp/aw-home',
          source: 'local',
        },
      },
      warnings: ['当前 repo trust 状态未知，project scope 会话可见性无法确定。'],
    }));
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--scope', 'user'],
      {
        cwd: '/tmp/workspace',
        env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(readStdout()).toContain('已安装 git-commit。');
    expect(readStdout()).toContain('目标：Codex；当前用户。');
    expect(readStdout()).toContain('下一步：查看当前状态。运行 aw status git-commit -p codex 后');
    expect(readStderr()).not.toContain('Warning:');
    expect(readStderr()).toContain('注意：Codex 已写入当前仓库需要的项目文件');
  });

  it('prints repo-managed Codex project receipts without native marketplace success lines', async () => {
    const repoManagedArtifacts = [
      {
        platform: 'codex',
        kind: 'skill',
        path: '/tmp/workspace/.agents/skills/repo-check',
        artifactKey: 'repo-check',
      },
      {
        platform: 'codex',
        kind: 'mcpServer',
        path: '/tmp/workspace/.codex/config.toml',
        artifactKey: 'acme.tools v1',
      },
    ];
    const installCommand = vi.fn(async () => ({
      plugins: ['skills-mcp'],
      platforms: ['codex'],
      nativePlugins: {},
      repoManagedArtifacts,
      marketplace: {
        rootDir: '/tmp/embedded-aw',
        changed: false,
        mode: 'readOnly',
        catalog: {
          rootDir: '/tmp/embedded-aw',
          source: 'embedded',
        },
      },
      warnings: [],
    }));
    const uninstallCommand = vi.fn(async () => ({
      plugins: ['skills-mcp'],
      platforms: ['codex'],
      repoManagedArtifacts,
      warnings: [],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['skills-mcp'],
      platforms: ['codex'],
      skipped: [],
      nativePlugins: {},
      repoManagedArtifacts,
      marketplace: {
        rootDir: '/tmp/embedded-aw',
        changed: false,
        mode: 'readOnly',
        catalog: {
          rootDir: '/tmp/embedded-aw',
          source: 'embedded',
        },
      },
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));

    const { runCli } = await import('../../src/index.js');

    for (const [args, expectedLine] of [
      [['install', 'skills-mcp', '--platform', 'codex', '--scope', 'project'], '已更新项目文件'],
      [['upgrade', 'skills-mcp', '--platform', 'codex', '--scope', 'project'], '已更新项目文件'],
      [['uninstall', 'skills-mcp', '--platform', 'codex', '--scope', 'project'], '已清理项目文件'],
    ] as const) {
      const capture = createCapturedIo();
      expect(await runCli(args, {
        cwd: '/tmp/workspace',
        env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv,
        io: capture.io,
      })).toBe(0);
      const stdout = capture.readStdout();
      expect(stdout).toContain(
        `${expectedLine}：.agents/skills、.codex/config.toml、.codex/.agent-workflows-manifest.json。`,
      );
      expect(stdout).not.toMatch(/repo-managed/i);
      expect(stdout).not.toContain('已确认 Codex marketplace 注册');
      expect(stdout).not.toContain('已确认插件启用');
      expect(stdout).not.toContain('已复用本地 marketplace');
      expect(stdout).not.toContain('已同步本地 marketplace');
    }
  });

  it('prints readable uninstall and upgrade receipts', async () => {
    const uninstallCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['claude'],
      nativePlugins: {
        claude: ['git-commit'],
      },
      marketplace: {
        rootDir: '/tmp/aw-home',
        changed: true,
        catalog: {
          rootDir: '/tmp/aw-home',
          source: 'local',
        },
      },
      warnings: [],
    }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['uninstall', 'git-commit', '--platform', 'codex'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(capture.readStdout()).toContain('已卸载 git-commit。');
    expect(capture.readStdout()).toContain('目标：Codex；当前用户。');
    expect(capture.readStdout()).toContain('已清理相关文件和已安装项。');

    capture = createCapturedIo();
    expect(await runCli(
      ['upgrade', 'git-commit', '--platform', 'claude'],
      { cwd: '/tmp/workspace', env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(capture.readStdout()).toContain('已升级 git-commit。');
    expect(capture.readStdout()).toContain('目标：Claude Code；当前用户。');
    expect(capture.readStdout()).toContain('下一步：查看当前状态。运行 aw status git-commit -p claude 后');
  });

  it.each([
    'scopeNotInitialized',
    'codexProjectUserConfigUnreadable',
    'externalOwnershipUnknown',
    'externalOwnershipPresent',
    'roleNameConflict',
    'trackingIntegrityError',
    'installOptionsUnavailable',
    'catalogNotCurrent',
    'catalogNotProjectInstallable',
    'projectConfigUnreadable',
    'unmanagedRepoArtifactConflict',
  ])('prints skipped upgrade receipts and exits 1 when every target is skipped (%s)', async (code) => {
    const upgradeCommand = vi.fn(async () => ({
      plugins: [],
      platforms: ['codex'],
      skipped: [{
        platform: 'codex',
        scope: 'project',
        plugin: 'git-commit',
        code,
        reason: `${code} reason`,
      }],
      warnings: [],
      nativePlugins: {},
    }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));

    const { runCli } = await import('../../src/index.js');
    const capture = createCapturedIo();
    const exitCode = await runCli(
      ['upgrade', '--all', '--platform', 'codex', '--scope', 'project'],
      {
        cwd: '/tmp/workspace',
        env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStdout()).toContain('这次没有完成升级，已跳过 1 个目标。');
    expect(capture.readStdout()).toContain('Codex / 当前项目 / git-commit');
    expect(capture.readStdout()).toContain(`${code} reason`);
  });

  it('prints succeeded + skipped upgrade receipts and keeps exit 0', async () => {
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex', 'claude'],
      skipped: [{
        platform: 'codex',
        scope: 'project',
        plugin: 'git-commit',
        code: 'externalOwnershipUnknown',
        reason: 'externalOwnershipUnknown reason',
      }],
      warnings: [],
      nativePlugins: {
        claude: ['git-commit'],
      },
      marketplace: {
        rootDir: '/tmp/aw-home',
        changed: false,
        catalog: {
          rootDir: '/tmp/aw-home',
          source: 'local',
        },
      },
    }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));

    const { runCli } = await import('../../src/index.js');
    const capture = createCapturedIo();
    const exitCode = await runCli(
      ['upgrade', '--all', '--platform', 'both', '--scope', 'project'],
      {
        cwd: '/tmp/workspace',
        env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(0);
    expect(capture.readStdout()).toContain('已升级 git-commit。');
    expect(capture.readStdout()).toContain('目标：Codex、Claude Code；当前项目。');
    expect(capture.readStdout()).toContain('未处理 1 个目标：');
    expect(capture.readStdout()).toContain('externalOwnershipUnknown reason');
  });

  it('prints embedded catalog receipts only when the command returns that decision', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      marketplace: {
        rootDir: '/tmp/aw-home',
        changed: false,
        catalog: {
          rootDir: '/tmp/embedded-aw',
          source: 'embedded',
          reason: 'local marketplace is missing, stale, or unhealthy',
        },
      },
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io, readStdout } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    expect(await runCli(
      ['install', 'git-commit', '--platform', 'codex'],
      { cwd: '/tmp/workspace', env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv, io },
    )).toBe(0);

    const stdout = readStdout();
    expect(stdout).toContain('已安装 git-commit。');
    expect(stdout).toContain('目标：Codex；当前用户。');
    expect(stdout).not.toMatch(/marketplace/i);
  });

  it('dispatches install, uninstall, and upgrade directly even when a fake prompt is injected', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const uninstallCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const prompt = {
      selectScope: vi.fn(async () => 'project' as const),
      selectPlatform: vi.fn(async () => 'claude' as const),
      selectPlugins: vi.fn(async () => ['not-used']),
      selectUpgradeMode: vi.fn(async () => 'all' as const),
    };
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));

    const { runCli } = await import('../../src/index.js');

    expect(await runCli(
      ['install', 'git-commit', '--platform', 'codex'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io, prompt },
    )).toBe(0);
    expect(await runCli(
      ['uninstall', 'git-commit', '--platform', 'codex'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io, prompt },
    )).toBe(0);
    expect(await runCli(
      ['upgrade', 'git-commit', '--platform', 'codex'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io, prompt },
    )).toBe(0);

    expect(prompt.selectScope).not.toHaveBeenCalled();
    expect(prompt.selectPlatform).not.toHaveBeenCalled();
    expect(prompt.selectPlugins).not.toHaveBeenCalled();
    expect(prompt.selectUpgradeMode).not.toHaveBeenCalled();
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        platform: 'codex',
      }),
      expect.anything(),
    );
    expect(uninstallCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        platform: 'codex',
      }),
      expect.anything(),
    );
    expect(upgradeCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        platform: 'codex',
      }),
      expect.anything(),
    );
  });

  it('rejects upgrade --skill-trigger before dispatching upgradeCommand', async () => {
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['claude'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/upgrade.js', () => ({
      upgradeCommand,
    }));

    const { io } = createCapturedIo();
    const env = {} as NodeJS.ProcessEnv;
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['upgrade', 'git-commit', '--platform', 'claude', '--skill-trigger', 'auto'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(upgradeCommand).not.toHaveBeenCalled();
  });

  it('passes --script-timeout to install, upgrade, and uninstall handlers', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const uninstallCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));

    const { runCli } = await import('../../src/index.js');
    const runOptions = { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv };

    expect(await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--script-timeout', '45000'],
      { ...runOptions, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['upgrade', 'git-commit', '--platform', 'codex', '--script-timeout', '46000'],
      { ...runOptions, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['uninstall', 'git-commit', '--platform', 'codex', '--script-timeout', '47000'],
      { ...runOptions, io: createCapturedIo().io },
    )).toBe(0);

    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ scriptTimeoutMs: 45000 }),
      expect.anything(),
    );
    expect(upgradeCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ scriptTimeoutMs: 46000 }),
      expect.anything(),
    );
    expect(uninstallCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ scriptTimeoutMs: 47000 }),
      expect.anything(),
    );
  });

  it('rejects invalid --script-timeout values at the entry layer', async () => {
    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--script-timeout', '999'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('Unsupported script timeout "999"');
  });

  it('parses short options with the same raw values as long options', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const statusCommand = vi.fn(async () => ({
      reports: [],
      output: JSON.stringify({ ok: true }),
    }));
    const initCommand = vi.fn(async () => ({
      changed: true,
      rootDir: '/tmp/aw',
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
    vi.doMock('../../src/commands/status.js', () => ({ statusCommand }));
    vi.doMock('../../src/commands/init.js', () => ({ initCommand }));

    const { runCli } = await import('../../src/index.js');

    expect(await runCli(
      ['init', '-f'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['install', 'git-commit', '-p', 'codex', '-s', 'user'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['upgrade', '-a', '-p', 'both'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['status', '-j'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(initCommand).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'codex',
      }),
      expect.anything(),
    );
    expect(upgradeCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'both',
        all: true,
      }),
      expect.anything(),
    );
    expect(statusCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        json: true,
      }),
      expect.anything(),
    );
    expect(statusCommand.mock.calls[0][1]).not.toHaveProperty('scope');
    expect(statusCommand.mock.calls[0][1]).toMatchObject({
      platform: 'both',
    });
  });

  it('does not list diagnose in CLI help output', async () => {
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['--help'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io },
    );

    expect(exitCode).toBe(0);
    expect(readStdout()).not.toContain('diagnose');
    expect(readStdout()).toContain('repair');
    expect(readStdout()).toContain('cleanup');
    expect(readStdout()).toContain('reinstall');
    expect(readStderr()).toBe('');
  });

  it.each([
    ['install'],
    ['upgrade'],
    ['repair'],
    ['reinstall'],
  ])('does not list --skill-trigger in %s help output', async (commandName) => {
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      [commandName, '--help'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io },
    );

    expect(exitCode).toBe(0);
    expect(readStdout()).not.toContain('skill-trigger');
    expect(readStderr()).toBe('');
  });

  it('fails diagnose entrypoints with a migration error and empty stdout', async () => {
    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['diagnose', 'git-commit'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStdout()).toBe('');
    expect(capture.readStderr()).toContain('请改用 `aw status git-commit --verbose`');

    capture = createCapturedIo();
    expect(await runCli(
      ['diagnose', 'git-commit', '--json', '--deep'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStdout()).toBe('');
    expect(capture.readStderr()).toContain('请改用 `aw status git-commit --verbose`');
  });

  it('rejects legacy --platform auto before dispatching public write commands', async () => {
    const installCommand = vi.fn();
    const cleanupCommand = vi.fn();
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/cleanup.js', () => ({
      cleanupCommand,
      isCleanupExecutionFailure: () => false,
    }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['install', 'git-commit', '--platform', 'auto'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStdout()).toBe('');
    expect(capture.readStderr()).toContain('Unsupported platform "auto". Expected one of: codex, claude, both.');
    expect(installCommand).not.toHaveBeenCalled();

    capture = createCapturedIo();
    expect(await runCli(
      ['cleanup', 'git-commit', '--platform', 'auto'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStdout()).toBe('');
    expect(capture.readStderr()).toContain('Unsupported platform "auto". Expected one of: codex, claude, both.');
    expect(cleanupCommand).not.toHaveBeenCalled();
  });

  it('routes repair, cleanup, and reinstall through the CLI entry with parseable JSON stdout', async () => {
    const repairCommand = vi.fn(async () => ({
      output: JSON.stringify({ ok: true, command: 'repair', locations: [] }),
      payload: { ok: true, command: 'repair', locations: [] },
    }));
    const cleanupCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
      repoManagedArtifacts: [],
      payload: {
        ok: true,
        command: 'cleanup',
        receiptSchemaVersion: 2,
        overallState: 'succeeded',
        dependencyIndex: false,
        cleanupPlanSchemaVersion: 1,
        generatedAt: '2026-05-15T00:00:00.000Z',
        dryRun: false,
        force: false,
        removeConfig: false,
        nextStepsSchemaVersion: 1,
        nextSteps: [],
        targetResults: [],
        target: {
          plugin: 'git-commit',
          platform: 'codex',
          scope: 'user',
          targetType: 'installed',
        },
        forceReason: null,
        plannedRemovals: [],
        wouldBackups: [],
        wouldRemoveConfig: [],
        skippedForeignItems: [],
        affectedDependents: [],
        blockingReasons: [],
        recommendedCommand: 'aw status git-commit --platform codex --scope user',
        actualRemovals: [],
        actualBackups: [],
        skippedItems: [],
        remainingItems: [],
      },
    }));
    const isCleanupExecutionFailure = vi.fn(() => false);
    const reinstallCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
    }));
    vi.doMock('../../src/commands/repair.js', () => ({ repairCommand }));
    vi.doMock('../../src/commands/cleanup.js', () => ({ cleanupCommand, isCleanupExecutionFailure }));
    vi.doMock('../../src/commands/reinstall.js', () => ({ reinstallCommand }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['repair', 'git-commit', '--scope', 'project', '--platform', 'codex', '--adopt-existing', '--takeover-shared-runtime', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      ok: true,
      command: 'repair',
    });
    expect(repairCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'project',
        platform: 'codex',
        adoptExisting: true,
        takeoverSharedRuntime: true,
        json: true,
      }),
      expect.anything(),
    );

    capture = createCapturedIo();
    expect(await runCli(
      ['cleanup', 'git-commit', '--scope', 'user', '--platform', 'codex', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      ok: true,
      command: 'cleanup',
    });
    expect(cleanupCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'codex',
        json: true,
      }),
      expect.anything(),
    );

    capture = createCapturedIo();
    expect(await runCli(
      ['reinstall', 'git-commit', '--scope', 'user', '--platform', 'codex', '--takeover-shared-runtime', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      ok: true,
      command: 'reinstall',
      receipt: {
        ok: true,
        command: 'install',
      },
    });
    expect(reinstallCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'codex',
        takeoverSharedRuntime: true,
        json: true,
      }),
      expect.anything(),
    );
  });

  it('fails P11 illegal combinations before invoking write commands', async () => {
    const upgradeCommand = vi.fn();
    const cleanupCommand = vi.fn();
    const isCleanupExecutionFailure = vi.fn(() => false);
    const repairCommand = vi.fn();
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
    vi.doMock('../../src/commands/cleanup.js', () => ({ cleanupCommand, isCleanupExecutionFailure }));
    vi.doMock('../../src/commands/repair.js', () => ({ repairCommand }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['upgrade', '--all', '--takeover-shared-runtime'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('`upgrade --all` 不支持 `--takeover-shared-runtime`');
    expect(upgradeCommand).not.toHaveBeenCalled();

    capture = createCapturedIo();
    expect(await runCli(
      ['cleanup', '--dependency-index'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('cleanup --dependency-index 目前只支持 --prune-stale <token>。');
    expect(cleanupCommand).not.toHaveBeenCalled();

    capture = createCapturedIo();
    expect(await runCli(
      ['repair', '--dependency-index', '--adopt-existing'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('--dependency-index 不能与 --adopt-existing 一起使用。');
    expect(repairCommand).not.toHaveBeenCalled();
  });

  it('fails missing install and uninstall plugin names at the entry layer with guidance', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['unexpected'],
      platforms: ['codex'],
      warnings: [],
    }));
    const uninstallCommand = vi.fn(async () => ({
      plugins: ['unexpected'],
      platforms: ['codex'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['install'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('install 命令至少需要一个插件名');
    expect(capture.readStderr()).toContain('`aw`');
    expect(capture.readStderr()).toContain('`aw install <plugin>`');
    expect(capture.readStderr()).not.toContain('missing required argument');
    expect(installCommand).not.toHaveBeenCalled();

    capture = createCapturedIo();
    expect(await runCli(
      ['uninstall'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('uninstall 命令至少需要一个插件名');
    expect(capture.readStderr()).toContain('`aw`');
    expect(capture.readStderr()).toContain('`aw uninstall <plugin>`');
    expect(capture.readStderr()).not.toContain('missing required argument');
    expect(uninstallCommand).not.toHaveBeenCalled();
  });

  it('fails bare aw deterministically in non-interactive mode instead of printing help', async () => {
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli([], {
      cwd: '/tmp/workspace',
      env: { CI: '1' } as NodeJS.ProcessEnv,
      io,
    });

    expect(exitCode).toBe(1);
    expect(readStdout()).toBe('');
    expect(readStderr()).toContain('当前运行环境不可交互');
    expect(readStderr()).toContain('`aw status`');
    expect(readStderr()).toContain('`aw install <plugin> --platform codex --scope user`');
    expect(readStderr()).toContain('`aw status --json`');
    expect(readStderr()).not.toContain('Usage:');
  });

  it('routes bare aw into the console controller when interactive prompt support is injected', async () => {
    const runConsoleController = vi.fn(async () => 0);
    vi.doMock('../../src/commands/console.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/commands/console.js')>('../../src/commands/console.js');
      return {
        ...actual,
        runConsoleController,
      };
    });

    const { io } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli([], {
      cwd: '/tmp/workspace',
      env: {} as NodeJS.ProcessEnv,
      io,
      prompt: {
        select: vi.fn(async () => ({ action: 'cancel', cancelled: true })),
      },
      consoleDriver: {
        render: vi.fn(),
      },
    });

    expect(exitCode).toBe(0);
    expect(runConsoleController).toHaveBeenCalledTimes(1);
    expect(runConsoleController.mock.calls[0][0]).toMatchObject({
      interactive: true,
      cwd: '/tmp/workspace',
    });
  });

  it('fails install without entering a fake prompt', async () => {
    let promptCalled = false;
    const prompt = {
      selectScope: async () => {
        promptCalled = true;
        return 'user' as const;
      },
      selectPlatform: async () => {
        promptCalled = true;
        return 'codex' as const;
      },
      selectPlugins: async () => {
        promptCalled = true;
        return ['git-commit'];
      },
    };
    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(['install'], {
      cwd: '/tmp/workspace',
      env: {} as NodeJS.ProcessEnv,
      io,
      prompt,
    });

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(readStderr()).toContain('install 命令至少需要一个插件名');
  });

  it.each([
    ['uninstall', ['uninstall'], 'uninstall 命令至少需要一个插件名'],
    ['upgrade', ['upgrade'], '`aw upgrade <plugin>` / `aw upgrade --all`'],
  ])(
    '%s fails before entering a fake prompt',
    async (_command, argv, expectedMessage) => {
      let promptCalled = false;
      const prompt = {
        selectScope: async () => {
          promptCalled = true;
          return 'user' as const;
        },
        selectPlatform: async () => {
          promptCalled = true;
          return 'codex' as const;
        },
        selectPlugins: async () => {
          promptCalled = true;
          return ['git-commit'];
        },
      };
      const { io, readStderr } = createCapturedIo();
      const { runCli } = await import('../../src/index.js');

      const exitCode = await runCli(argv, {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
        prompt,
      });

      expect(exitCode).toBe(1);
      expect(promptCalled).toBe(false);
      expect(readStderr()).toContain(expectedMessage);
    },
  );

  it.each([
    ['install', ['install', '--interactive']],
    ['install', ['install', '--no-interactive']],
    ['uninstall', ['uninstall', 'git-commit', '--interactive']],
    ['upgrade', ['upgrade', 'git-commit', '--no-interactive']],
    ['config reset', ['config', 'reset', 'git-commit', '--interactive']],
    ['config reset', ['config', 'reset', 'git-commit', '--no-interactive']],
  ])('rejects removed interactive flags for %s', async (_label, argv) => {
    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(argv, {
      cwd: '/tmp/workspace',
      env: {} as NodeJS.ProcessEnv,
      io,
    });

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('unknown option');
  });

  it('rejects removed config configure subcommand', async () => {
    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['config', 'configure', 'git-commit'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('unknown command');
    expect(readStderr()).toContain('configure');
  });

  it('reads project local config through configSchemaVersion 2 field entries', async () => {
    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCatalogPlugins: vi.fn(async () => ({
        plugins: [{
          rootDir: '/synthetic/plugin',
          manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
          manifest: {
            name: 'git-commit',
            version: '1.0.0',
            marketplace: {
              category: 'test',
              strict: false,
              policy: {
                installation: 'AVAILABLE',
                authentication: 'NONE',
              },
            },
            config: {
              schema: {
                token: { type: 'string', sensitive: true },
                mode: { type: 'enum', values: ['fast', 'safe'] },
              },
            },
          },
        }],
      })),
    }));
    vi.doMock('../../src/utils/plugin-config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>('../../src/utils/plugin-config.js');
      return {
        ...actual,
        resolveConfigReadV2: vi.fn(async () => ({
          pluginName: 'git-commit',
          scope: 'project',
          projectLayer: 'local',
          fields: [
            {
              key: 'token',
              title: 'token',
              kind: 'manifest',
              reserved: false,
              writable: true,
              valueState: 'configured',
              effectiveValue: '[redacted]',
              sourceLayer: 'local',
            },
            {
              key: 'mode',
              title: 'mode',
              kind: 'manifest',
              reserved: false,
              writable: true,
              valueState: 'default',
              effectiveValue: null,
              sourceLayer: null,
            },
          ],
          legacyConfigStores: [],
        })),
      };
    });

    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['config', 'get', 'git-commit', 'token', '--scope', 'project', '--local'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(readStdout()).toContain('token: configured');
    expect(readStdout()).toContain('[redacted]');
    expect(readStderr()).toBe('');
  });

  it('prints project local config JSON via configSchemaVersion 2 fields', async () => {
    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCatalogPlugins: vi.fn(async () => ({
        plugins: [{
          rootDir: '/synthetic/plugin',
          manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
          manifest: {
            name: 'git-commit',
            version: '1.0.0',
            marketplace: {
              category: 'test',
              strict: false,
              policy: {
                installation: 'AVAILABLE',
                authentication: 'NONE',
              },
            },
            config: {
              schema: {
                token: { type: 'string', sensitive: true },
                mode: { type: 'enum', values: ['fast', 'safe'] },
              },
            },
          },
        }],
      })),
    }));
    vi.doMock('../../src/utils/plugin-config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>('../../src/utils/plugin-config.js');
      return {
        ...actual,
        resolveConfigReadV2: vi.fn(async () => ({
          pluginName: 'git-commit',
          scope: 'project',
          projectLayer: 'local',
          fields: [
            {
              key: 'token',
              title: 'token',
              kind: 'manifest',
              reserved: false,
              writable: true,
              valueState: 'configured',
              effectiveValue: '[redacted]',
              sourceLayer: 'local',
            },
          ],
          legacyConfigStores: [],
        })),
      };
    });

    const { io, readStdout } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['config', 'list', 'git-commit', '--scope', 'project', '--local', '--json'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    const payload = JSON.parse(readStdout()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      configSchemaVersion: 2,
      command: 'config:list',
      plugin: 'git-commit',
      scope: 'project',
      projectLayer: 'local',
      fields: [{
        key: 'token',
        title: 'token',
        kind: 'manifest',
        reserved: false,
        writable: true,
        valueState: 'configured',
        effectiveValue: '[redacted]',
        sourceLayer: 'local',
      }],
    });
  });

  it('prints project-scope config JSON via configSchemaVersion 2 fields', async () => {
    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCatalogPlugins: vi.fn(async () => ({
        plugins: [{
          rootDir: '/synthetic/plugin',
          manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
          manifest: {
            name: 'git-commit',
            version: '1.0.0',
            marketplace: {
              category: 'test',
              strict: false,
              policy: {
                installation: 'AVAILABLE',
                authentication: 'NONE',
              },
            },
            config: {
              schema: {
                token: { type: 'string', sensitive: true },
                mode: { type: 'enum', values: ['fast', 'safe'] },
              },
            },
          },
        }],
      })),
    }));
    vi.doMock('../../src/utils/plugin-config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>('../../src/utils/plugin-config.js');
      return {
        ...actual,
        resolveConfigReadV2: vi.fn(async () => ({
          pluginName: 'git-commit',
          scope: 'project',
          projectLayer: 'shared',
          fields: [
            {
              key: 'token',
              title: 'token',
              kind: 'manifest',
              reserved: false,
              writable: true,
              valueState: 'configured',
              effectiveValue: '[redacted]',
              sourceLayer: 'local',
            },
            {
              key: 'mode',
              title: 'mode',
              kind: 'manifest',
              reserved: false,
              writable: true,
              valueState: 'configured',
              effectiveValue: 'safe',
              sourceLayer: 'project',
            },
          ],
          legacyConfigStores: [],
        })),
      };
    });

    const { io, readStdout } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['config', 'list', 'git-commit', '--scope', 'project', '--json'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    const payload = JSON.parse(readStdout()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      configSchemaVersion: 2,
      command: 'config:list',
      plugin: 'git-commit',
      scope: 'project',
      projectLayer: 'shared',
      fields: [
        {
          key: 'token',
          title: 'token',
          kind: 'manifest',
          reserved: false,
          writable: true,
          valueState: 'configured',
          effectiveValue: '[redacted]',
          sourceLayer: 'local',
        },
        {
          key: 'mode',
          title: 'mode',
          kind: 'manifest',
          reserved: false,
          writable: true,
          valueState: 'configured',
          effectiveValue: 'safe',
          sourceLayer: 'project',
        },
      ],
    });
  });

  it('passes through config refresh skipped reason in config set JSON receipts', async () => {
    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCatalogPlugins: vi.fn(async () => ({
        plugins: [{
          rootDir: '/synthetic/plugin',
          manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
          manifest: {
            name: 'git-commit',
            version: '1.0.0',
            marketplace: {
              category: 'test',
              strict: false,
              policy: {
                installation: 'AVAILABLE',
                authentication: 'NONE',
              },
            },
            config: {
              schema: {
                token: { type: 'string' },
              },
            },
          },
        }],
      })),
    }));
    vi.doMock('../../src/utils/plugin-config-write.js', () => ({
      applyPluginConfigWrite: vi.fn(async () => ({
        plugin: 'git-commit',
        scope: 'project',
        projectLayer: 'local',
        updatedKeys: ['token'],
        removedKeys: [],
        effective: {},
        artifactRefresh: {
          attempted: false,
          status: 'skipped',
          triggerKeys: ['token'],
          artifacts: [],
        },
        configRefreshSkippedReason: 'projectLocalOverride',
        warnings: [],
      })),
      resetPluginConfigWithHelper: vi.fn(),
    }));

    const { io, readStdout } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['config', 'set', 'git-commit', 'token', 'secret', '--scope', 'project', '--local', '--json'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(readStdout())).toMatchObject({
      ok: true,
      command: 'config:set',
      plugin: 'git-commit',
      configRefreshSkippedReason: 'projectLocalOverride',
      artifactRefresh: {
        attempted: false,
        status: 'skipped',
      },
    });
  });

  it('rejects config write --local unless scope is project before any write helper runs', async () => {
    const applyPluginConfigWrite = vi.fn();
    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCatalogPlugins: vi.fn(async () => ({
        plugins: [{
          rootDir: '/synthetic/plugin',
          manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
          manifest: {
            name: 'git-commit',
            version: '1.0.0',
            marketplace: {
              category: 'test',
              strict: false,
              policy: {
                installation: 'AVAILABLE',
                authentication: 'NONE',
              },
            },
            config: {
              schema: {
                token: { type: 'string' },
              },
            },
          },
        }],
      })),
    }));
    vi.doMock('../../src/utils/plugin-config-write.js', () => ({
      applyPluginConfigWrite,
      resetPluginConfigWithHelper: vi.fn(),
    }));

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['config', 'set', 'git-commit', 'token', 'secret', '--local'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('`--local` 只能与 `--scope project` 一起使用');
    expect(applyPluginConfigWrite).not.toHaveBeenCalled();
  });

  it('P0 baseline: default install receipts should not leak internal implementation nouns', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      nativePlugins: {
        codex: ['git-commit'],
      },
      marketplace: {
        rootDir: '/tmp/aw-home',
        changed: false,
        catalog: {
          rootDir: '/tmp/aw-home',
          source: 'local',
        },
      },
      warnings: ['当前 repo trust 状态未知，project scope 会话可见性无法确定。'],
    }));
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--scope', 'user'],
      {
        cwd: '/tmp/workspace',
        env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv,
        io,
      },
    );

    const combinedOutput = `${readStdout()}\n${readStderr()}`;
    expect(exitCode).toBe(0);
    expect(combinedOutput).not.toMatch(/marketplace/i);
    expect(combinedOutput).not.toMatch(/app-server/i);
    expect(combinedOutput).not.toMatch(/repo-managed/i);
    expect(combinedOutput).not.toMatch(/\bledger\b/i);
    expect(combinedOutput).not.toMatch(/\bcache\b/i);
    expect(combinedOutput).not.toMatch(/breadcrumb/i);
  });

  it('prints init/install/uninstall/upgrade --json receipts as parseable single JSON objects', async () => {
    const initCommand = vi.fn(async () => ({
      changed: true,
      rootDir: '/tmp/aw-home',
      warnings: ['init warning'],
    }));
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      nativePlugins: {
        codex: ['git-commit'],
      },
      repoManagedArtifacts: [{
        platform: 'codex',
        kind: 'skill',
        path: '/tmp/workspace/.agents/skills/git-commit',
        artifactKey: 'git-commit',
      }],
      warnings: ['install warning'],
    }));
    const uninstallCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      repoManagedArtifacts: [{
        platform: 'codex',
        kind: 'skill',
        path: '/tmp/workspace/.agents/skills/git-commit',
        artifactKey: 'git-commit',
      }],
      warnings: ['uninstall warning'],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      skipped: [{
        platform: 'claude',
        scope: 'user',
        plugin: 'git-commit',
        code: 'catalogNotCurrent',
        reason: 'catalogNotCurrent reason',
      }],
      nativePlugins: {
        codex: ['git-commit'],
      },
      repoManagedArtifacts: [{
        platform: 'codex',
        kind: 'skill',
        path: '/tmp/workspace/.agents/skills/git-commit',
        artifactKey: 'git-commit',
      }],
      warnings: ['upgrade warning'],
    }));
    vi.doMock('../../src/commands/init.js', () => ({ initCommand }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));

    const { runCli } = await import('../../src/index.js');

    const initCapture = createCapturedIo();
    expect(await runCli(
      ['init', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: initCapture.io },
    )).toBe(0);
    expect(JSON.parse(initCapture.readStdout())).toMatchObject({
      ok: true,
      command: 'init',
      changed: true,
      rootDir: '/tmp/aw-home',
      warnings: ['init warning'],
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ label: expect.any(String), description: expect.any(String) })],
    });

    const installCapture = createCapturedIo();
    expect(await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: installCapture.io },
    )).toBe(0);
    expect(JSON.parse(installCapture.readStdout())).toMatchObject({
      ok: true,
      command: 'install',
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      plugins: ['git-commit'],
      targets: [{ plugin: 'git-commit', platform: 'codex', scope: 'user' }],
      actions: [{ type: 'install', plugin: 'git-commit', platform: 'codex', scope: 'user', status: 'succeeded' }],
      artifacts: [{ platform: 'codex', kind: 'skill', path: '/tmp/workspace/.agents/skills/git-commit', artifactKey: 'git-commit' }],
      native: {
        plugins: [{ platform: 'codex', plugin: 'git-commit' }],
      },
      warnings: ['install warning'],
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ label: expect.any(String), description: expect.any(String) })],
      targetResults: [expect.objectContaining({ action: 'install', state: 'completed' })],
    });

    const uninstallCapture = createCapturedIo();
    expect(await runCli(
      ['uninstall', 'git-commit', '--platform', 'codex', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: uninstallCapture.io },
    )).toBe(0);
    expect(JSON.parse(uninstallCapture.readStdout())).toMatchObject({
      ok: true,
      command: 'uninstall',
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      plugins: ['git-commit'],
      targets: [{ plugin: 'git-commit', platform: 'codex', scope: 'user' }],
      actions: [{ type: 'uninstall', plugin: 'git-commit', platform: 'codex', scope: 'user', status: 'succeeded' }],
      artifacts: [{ platform: 'codex', kind: 'skill', path: '/tmp/workspace/.agents/skills/git-commit', artifactKey: 'git-commit' }],
      native: {
        plugins: [],
      },
      warnings: ['uninstall warning'],
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ label: expect.any(String), description: expect.any(String) })],
      targetResults: [expect.objectContaining({ action: 'uninstall', state: 'completed' })],
    });

    const upgradeCapture = createCapturedIo();
    expect(await runCli(
      ['upgrade', 'git-commit', '--platform', 'codex', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: upgradeCapture.io },
    )).toBe(0);
    expect(JSON.parse(upgradeCapture.readStdout())).toMatchObject({
      ok: true,
      command: 'upgrade',
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      upgraded: [{ plugin: 'git-commit', platform: 'codex', scope: 'user' }],
      skipped: [{
        platform: 'claude',
        scope: 'user',
        plugin: 'git-commit',
        code: 'catalogNotCurrent',
        reason: 'catalogNotCurrent reason',
      }],
      targets: expect.arrayContaining([
        { plugin: 'git-commit', platform: 'codex', scope: 'user' },
        { plugin: 'git-commit', platform: 'claude', scope: 'user' },
      ]),
      actions: [{ type: 'upgrade', plugin: 'git-commit', platform: 'codex', scope: 'user', status: 'succeeded' }],
      artifacts: [{ platform: 'codex', kind: 'skill', path: '/tmp/workspace/.agents/skills/git-commit', artifactKey: 'git-commit' }],
      native: {
        plugins: [{ platform: 'codex', plugin: 'git-commit' }],
      },
      warnings: ['upgrade warning'],
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ label: expect.any(String), description: expect.any(String) })],
      targetResults: expect.arrayContaining([
        expect.objectContaining({ action: 'upgrade', state: 'completed' }),
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: 'git-commit',
            platform: 'claude',
            scope: 'user',
          }),
          action: 'upgrade',
          state: 'notRun',
        }),
      ]),
    });
  });

  it('keeps stdout empty when a write command fails in --json mode', async () => {
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand: vi.fn(async () => {
        throw new CommandWarningError('fatal install error', {
          warnings: ['install warning'],
        });
      }),
    }));

    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--json'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStdout()).toBe('');
    expect(readStderr()).toContain('注意：install warning');
    expect(readStderr()).toContain('fatal install error');
  });

  it('hides non-actionable diagnostic warnings from default write-command stderr', async () => {
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand: vi.fn(async () => ({
        plugins: ['git-commit'],
        platforms: ['codex'],
        nativePlugins: {
          codex: ['git-commit'],
        },
        repoManagedArtifacts: [],
        warnings: [
          '内部诊断：shared owner digest changed',
          '无法自动确保 .codex/.agent-workflows 的 project private state ignore 规则。建议在 .gitignore 中追加 \".codex/.agent-workflows/\"。',
        ],
      })),
    }));

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(readStderr()).toContain('.codex/.agent-workflows');
    expect(readStderr()).not.toContain('shared owner digest changed');
  });

  it('P0 baseline: default status and error copy should avoid internal terms like healthSource and scope prose', async () => {
    const statusCommand = vi.fn(async () => ({
      reports: [],
      output: [
        '插件状态',
        '- git-commit',
        '  状态：需要处理',
        '  位置：Codex（个人）',
        '  下一步：查看详情：aw status git-commit --verbose',
      ].join('\n'),
    }));
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const { runCli } = await import('../../src/index.js');
    let capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(0);

    const statusProse = capture.readStdout().replace(/`[^`]*`/g, '');
    expect(statusProse).toContain('位置：Codex（个人）');
    expect(statusProse).not.toMatch(/healthSource|artifactRefresh|user scope|project scope|\bscope\b/i);

    capture = createCapturedIo();
    expect(await runCli(
      ['install'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(1);

    const errorProse = capture.readStderr().replace(/`[^`]*`/g, '');
    expect(errorProse).toContain('install 命令至少需要一个插件名');
    expect(errorProse).not.toMatch(/healthSource|artifactRefresh|user scope|project scope|\bscope\b/i);
  });

  it('P0 baseline: dynamic artifact refresh failed default copy should be rewritten without leaking internal fields', async () => {
    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCatalogPlugins: vi.fn(async () => ({
        plugins: [{
          rootDir: '/synthetic/plugin',
          manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
          manifest: {
            name: 'git-commit',
            version: '1.0.0',
            marketplace: {
              category: 'test',
              strict: false,
              policy: {
                installation: 'AVAILABLE',
                authentication: 'NONE',
              },
            },
            config: {
              schema: {
                token: { type: 'string' },
              },
            },
          },
        }],
      })),
    }));
    vi.doMock('../../src/utils/plugin-config-write.js', () => ({
      applyPluginConfigWrite: vi.fn(async () => ({
        plugin: 'git-commit',
        scope: 'user',
        updatedKeys: ['token'],
        removedKeys: [],
        effective: {},
        artifactRefresh: {
          attempted: true,
          status: 'failed',
          triggerKeys: ['token'],
          artifacts: [],
          error: 'render failed',
        },
      })),
      resetPluginConfigWithHelper: vi.fn(),
    }));

    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['config', 'set', 'git-commit', 'token', 'secret'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    const combinedOutput = `${readStdout()}\n${readStderr()}`;
    expect(exitCode).toBe(0);
    expect(readStdout()).toBe('已写入 git-commit.token（个人配置）。\n');
    expect(readStderr()).toContain('配置已保存，但相关项目文件刷新失败：render failed');
    expect(combinedOutput).not.toMatch(/artifact refresh|artifactRefresh|\(user\)|\buser\b|\bscope\b/i);
  });

  it('threads injected native runner, prompt, reporter, and debug logger through one context', async () => {
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    }));
    const prompt = {
      confirm: vi.fn(async () => true),
    };
    const reporter = {
      event: vi.fn(),
      notice: vi.fn(),
    };
    const debugLogger = {
      log: vi.fn(),
      flush: vi.fn(),
    };
    const env = {} as NodeJS.ProcessEnv;

    const installCommand = vi.fn(async (
      _plugins: string[],
      commandOptions: { cwd: string },
      context: {
        env: NodeJS.ProcessEnv;
        nativeCliRunner: (invocation: {
          command: string;
          args: string[];
          cwd?: string;
          env?: NodeJS.ProcessEnv;
        }) => Promise<unknown>;
        prompt: typeof prompt;
        reporter: typeof reporter;
        debugLogger: typeof debugLogger;
      },
    ) => {
      await context.nativeCliRunner({
        command: 'probe',
        args: ['install'],
        cwd: commandOptions.cwd,
        env: context.env,
      });
      await context.prompt.confirm({ message: 'continue?' });
      await context.reporter.event({ type: 'inside-command' });
      await context.debugLogger.log({ type: 'inside-command' });
      return {
        plugins: ['git-commit'],
        platforms: ['codex'],
        warnings: [],
      };
    });
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');
    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
        nativeCliRunner,
        prompt,
        reporter,
        debugLogger,
      },
    );

    expect(exitCode).toBe(0);
    expect(nativeCliRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'probe',
        args: ['install'],
        cwd: '/tmp/workspace',
        env,
      }),
    );
    expect(prompt.confirm).toHaveBeenCalledTimes(1);
    expect(reporter.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'command:start',
        commandName: 'install',
      }),
    );
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'native:success',
        commandName: 'install',
      }),
    );
    expect(debugLogger.flush).toHaveBeenCalled();
  });

  it('normalizes AW_DEBUG, --debug, and --log-file into command diagnostics', async () => {
    const diagnostics: Array<{ debug: boolean; verbose: boolean; logFile?: string }> = [];
    const statusCommand = vi.fn(async (
      _plugins: string[],
      _options: unknown,
      context: { diagnostics: { debug: boolean; verbose: boolean; logFile?: string } },
    ) => {
      diagnostics.push(context.diagnostics);
      return {
        reports: [],
        output: JSON.stringify({ ok: true }),
      };
    });
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const { runCli } = await import('../../src/index.js');
    let capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit'],
      {
        cwd: '/tmp/workspace',
        env: { AW_DEBUG: '1' } as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(0);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-debug-'));
    tempDirs.push(tempDir);
    const logFile = path.join(tempDir, 'debug.log');
    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit', '--debug', '--log-file', logFile],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(0);

    const logOnlyFile = path.join(tempDir, 'log-only.log');
    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit', '--log-file', logOnlyFile],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(0);

    expect(diagnostics[0]).toMatchObject({
      debug: true,
      verbose: true,
    });
    expect(diagnostics[1]).toMatchObject({
      debug: true,
      verbose: true,
      logFile,
    });
    expect(diagnostics[2]).toMatchObject({
      debug: false,
      verbose: false,
      logFile: logOnlyFile,
    });
    expect(await fs.pathExists(logFile)).toBe(true);
    expect(await fs.pathExists(logOnlyFile)).toBe(false);
  });

  it('keeps status JSON stdout parseable with verbose and debug diagnostics', async () => {
    const statusCommand = vi.fn(async (
      _plugins: string[],
      options: { json?: boolean; verbose?: boolean },
    ) => ({
      reports: [],
      output: JSON.stringify({
        json: options.json === true,
        verbose: options.verbose === true,
      }),
    }));
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const { runCli } = await import('../../src/index.js');
    for (const args of [
      ['status', 'git-commit', '-j'],
      ['status', 'git-commit', '-j', '--verbose'],
      ['status', 'git-commit', '-j', '--debug'],
      ['status', 'git-commit', '-j', '--verbose', '--debug'],
    ]) {
      const { io, readStdout } = createCapturedIo();
      const exitCode = await runCli(
        args,
        {
          cwd: '/tmp/workspace',
          env: {} as NodeJS.ProcessEnv,
          io,
        },
      );

      expect(exitCode).toBe(0);
      expect(() => JSON.parse(readStdout())).not.toThrow();
      expect(JSON.parse(readStdout())).toMatchObject({
        json: true,
      });
    }
  });

  it('prints warnings before the final error message', async () => {
    vi.doMock('../../src/commands/upgrade.js', () => ({
      upgradeCommand: vi.fn(async () => {
        throw new CommandWarningError('fatal upgrade error', {
          warnings: ['rebuild replay skipped'],
        });
      }),
    }));

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['upgrade', 'git-commit', '--platform', 'codex'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    const stderr = readStderr();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('注意：rebuild replay skipped');
    expect(stderr).toContain('fatal upgrade error');
    expect(stderr.indexOf('注意：rebuild replay skipped')).toBeLessThan(
      stderr.indexOf('fatal upgrade error'),
    );
  });

  it('translates degraded skill-trigger warnings for users', async () => {
    vi.doMock('../../src/commands/uninstall.js', () => ({
      uninstallCommand: vi.fn(async () => ({
        plugins: ['git-commit'],
        platforms: ['codex'],
        warnings: ['[codex/git-commit] installed.json 处于 degraded 状态，跳过卸载后的 skill trigger 重选。'],
      })),
    }));

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['uninstall', 'git-commit', '--platform', 'codex'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(readStderr()).toContain('本地安装记录处于异常恢复状态');
    expect(readStderr()).toContain('配置管理维护 skill trigger 偏好');
    expect(readStderr()).not.toContain('[codex/git-commit]');
    expect(readStderr()).not.toContain('Warning:');
  });

  it('writes and redacts debug logs while keeping status JSON stdout clean', async () => {
    const installCommand = vi.fn(async (
      _plugins: string[],
      _options: unknown,
      context: {
        nativeCliRunner: (invocation: {
          command: string;
          args: string[];
        }) => Promise<unknown>;
      },
    ) => {
      await context.nativeCliRunner({
        command: 'probe',
        args: ['install'],
      });
      return {
        plugins: ['git-commit'],
        platforms: ['codex'],
        warnings: [],
      };
    });
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-debug-redact-'));
    tempDirs.push(tempDir);
    const logFile = path.join(tempDir, 'debug.log');
    const secret = 'super-secret-value';
    const nativeCliRunner = vi.fn(async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: `TOKEN=${secret}`,
        stderr: `Authorization: Bearer ${secret}`,
      });
    });

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');
    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--debug', '--log-file', logFile],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
        nativeCliRunner,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain(`调试日志：${logFile}`);
    const logContent = await fs.readFile(logFile, 'utf8');
    expect(logContent).not.toContain(secret);
    expect(logContent).toContain('[REDACTED]');
  });

  it('does not create AW_HOME logs for default status debug logs', async () => {
    const statusCommand = vi.fn(async () => ({
      reports: [],
      output: JSON.stringify({ ok: true }),
    }));
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-debug-'));
    tempDirs.push(tempDir);
    const awHome = path.join(tempDir, 'aw-home');
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['status', '-j', '--debug'],
      {
        cwd: '/tmp/workspace',
        env: { AW_HOME: awHome } as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(readStdout())).toEqual({ ok: true });
    expect(readStderr()).toContain(path.join(os.tmpdir(), 'agent-workflows'));
    expect(await fs.pathExists(awHome)).toBe(false);
  });
});
