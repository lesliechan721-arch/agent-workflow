import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandWarningError } from '../../src/types.js';
import { NativeCliError } from '../../src/utils/native-cli.js';
import {
  createSafeCliExecutionContext,
  createSafeCommandExecutionContext,
  runSafeCli,
} from '../helpers/cli-runtime.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { TestPathFenceError } from '../helpers/test-isolation.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
} from '../setup/test-isolation.js';

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

function currentReceiptTestPaths(): {
  cwd: string;
  awHome: string;
  env: NodeJS.ProcessEnv;
  pathFromCwd: (...segments: string[]) => string;
} {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const awHome = isolation.layout.awHomeDir;
  return {
    cwd,
    awHome,
    env: { ...isolation.env },
    pathFromCwd: (...segments: string[]) => path.join(cwd, ...segments),
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
  it('runCliEntry 默认注入安全 env、cwd，并捕获 IO', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const runCli = vi.fn(async (_argv: string[], options = {}) => {
      expect(options.cwd).toBe(process.cwd());
      expect(options.env).toMatchObject({
        AW_HOME: isolation.env.AW_HOME,
        AW_CODEX_HOME: isolation.env.AW_CODEX_HOME,
        AW_CLAUDE_HOME: isolation.env.AW_CLAUDE_HOME,
      });
      options.io?.stdout?.('safe stdout');
      options.io?.stderr?.('safe stderr');
      return 0;
    });

    const result = await runCliEntry(['status'], { runCli });

    expect(runCli).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('safe stdout');
    expect(result.stderr).toBe('safe stderr');
  });

  it('runCliEntry 会在调用前拦截不安全的 env 覆盖', async () => {
    const runCli = vi.fn(async () => 0);

    await expect(runCliEntry(
      ['status'],
      {
        runCli,
        env: {
          AW_HOME: getSourceTestRepositoryCwd(),
        } as NodeJS.ProcessEnv,
      },
    )).rejects.toBeInstanceOf(TestPathFenceError);
    expect(runCli).not.toHaveBeenCalled();
  });

  it('runSafeCli 默认注入安全 env 和 cwd', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const runCli = vi.fn(async () => 0);

    await runSafeCli(['--version'], { runCli });

    expect(runCli).toHaveBeenCalledWith(['--version'], expect.objectContaining({
      cwd: process.cwd(),
      env: expect.objectContaining({
        AW_HOME: isolation.env.AW_HOME,
        AW_CODEX_HOME: isolation.env.AW_CODEX_HOME,
        AW_CLAUDE_HOME: isolation.env.AW_CLAUDE_HOME,
      }),
    }));
  });

  it('safe context helper 继承安全 env，并允许显式 env overlay', () => {
    const isolation = getCurrentSourceTestIsolation();
    const commandContext = createSafeCommandExecutionContext({
      env: {
        AW_FORCE_CLAUDE_AVAILABLE: '1',
      } as NodeJS.ProcessEnv,
    });
    const cliContext = createSafeCliExecutionContext();

    expect(commandContext.env).toMatchObject({
      AW_HOME: isolation.env.AW_HOME,
      AW_FORCE_CLAUDE_AVAILABLE: '1',
    });
    expect(cliContext.cwd).toBe(process.cwd());
    expect(cliContext.env).toMatchObject({
      AW_HOME: isolation.env.AW_HOME,
    });
  });

  it('safe command context 允许显式注入 fake native runner', async () => {
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'fake native stdout',
      stderr: '',
    }));
    const context = createSafeCommandExecutionContext({
      nativeCliRunner,
    });

    const result = await context.nativeCliRunner({
      command: 'codex',
      args: ['plugin', 'marketplace', 'add', context.env.AW_HOME!],
      cwd: process.cwd(),
      env: context.env,
    });

    expect(nativeCliRunner).toHaveBeenCalledOnce();
    expect(result.stdout).toBe('fake native stdout');
  });

  it('safe CLI context helper 会拦截不安全的 cwd 覆盖', () => {
    expect(() => createSafeCliExecutionContext({
      cwd: getSourceTestRepositoryCwd(),
    })).toThrow(TestPathFenceError);
  });

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

  it('prints a readable install receipt without English warning prefixes', async () => {
    const { cwd, awHome, env } = currentReceiptTestPaths();
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      nativePlugins: {
        codex: ['git-commit'],
      },
      marketplace: {
        rootDir: awHome,
        changed: false,
        catalog: {
          rootDir: awHome,
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
        cwd,
        env,
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
    const { cwd, awHome, env, pathFromCwd } = currentReceiptTestPaths();
    const repoManagedArtifacts = [
      {
        platform: 'codex',
        kind: 'skill',
        path: pathFromCwd('.agents', 'skills', 'repo-check'),
        artifactKey: 'repo-check',
      },
      {
        platform: 'codex',
        kind: 'mcpServer',
        path: pathFromCwd('.codex', 'config.toml'),
        artifactKey: 'acme.tools v1',
      },
    ];
    const installCommand = vi.fn(async () => ({
      plugins: ['skills-mcp'],
      platforms: ['codex'],
      nativePlugins: {},
      repoManagedArtifacts,
      marketplace: {
        rootDir: pathFromCwd('.embedded-aw'),
        changed: false,
        mode: 'readOnly',
        catalog: {
          rootDir: pathFromCwd('.embedded-aw'),
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
        rootDir: pathFromCwd('.embedded-aw'),
        changed: false,
        mode: 'readOnly',
        catalog: {
          rootDir: pathFromCwd('.embedded-aw'),
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
        cwd,
        env: { ...env, AW_HOME: awHome } as NodeJS.ProcessEnv,
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
    const { cwd, awHome, env } = currentReceiptTestPaths();
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
        rootDir: awHome,
        changed: true,
        catalog: {
          rootDir: awHome,
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
      { cwd, env, io: capture.io },
    )).toBe(0);
    expect(capture.readStdout()).toContain('已卸载 git-commit。');
    expect(capture.readStdout()).toContain('目标：Codex；当前用户。');
    expect(capture.readStdout()).toContain('已清理相关文件和已安装项。');

    capture = createCapturedIo();
    expect(await runCli(
      ['upgrade', 'git-commit', '--platform', 'claude'],
      { cwd, env: { ...env, AW_HOME: awHome } as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(capture.readStdout()).toContain('已升级 git-commit。');
    expect(capture.readStdout()).toContain('目标：Claude Code；当前用户。');
    expect(capture.readStdout()).toContain('下一步：查看当前状态。运行 aw status git-commit -p claude 后');
  });

  it.each([
    'scopeNotInitialized',
    'repairRequired',
    'cleanupRequired',
    'notInstalled',
    'dependencySkipped',
    'capabilityChanged',
    'codexProjectUserConfigUnreadable',
    'externalOwnershipUnknown',
    'externalOwnershipPresent',
    'roleNameConflict',
    'trackingIntegrityError',
    'catalogNotCurrent',
    'catalogNotProjectInstallable',
    'projectConfigUnreadable',
    'unmanagedRepoArtifactConflict',
  ])('prints skipped upgrade receipts and exits 1 when every target is skipped (%s)', async (code) => {
    const { cwd, awHome, env } = currentReceiptTestPaths();
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
        cwd,
        env: { ...env, AW_HOME: awHome } as NodeJS.ProcessEnv,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStdout()).toContain('这次没有完成升级，已跳过 1 个目标。');
    expect(capture.readStdout()).toContain('Codex / 当前项目 / git-commit');
    expect(capture.readStdout()).toContain(`${code} reason`);
  });

  it('prints succeeded + skipped upgrade receipts and keeps exit 0', async () => {
    const { cwd, awHome, env } = currentReceiptTestPaths();
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
        rootDir: awHome,
        changed: false,
        catalog: {
          rootDir: awHome,
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
        cwd,
        env: { ...env, AW_HOME: awHome } as NodeJS.ProcessEnv,
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
    const { cwd, awHome, env, pathFromCwd } = currentReceiptTestPaths();
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      marketplace: {
        rootDir: awHome,
        changed: false,
        catalog: {
          rootDir: pathFromCwd('.embedded-aw'),
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
      { cwd, env: { ...env, AW_HOME: awHome } as NodeJS.ProcessEnv, io },
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

  it('forwards catalog selector options to init, install, and status commands', async () => {
    const initCommand = vi.fn(async () => ({
      changed: true,
      rootDir: '/tmp/catalog-cache',
      warnings: [],
      catalog: {
        rootDir: '/tmp/catalog-cache',
        source: 'remote',
      },
    }));
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const statusCommand = vi.fn(async () => ({
      reports: [],
      output: JSON.stringify({ ok: true }),
    }));
    vi.doMock('../../src/commands/init.js', () => ({ initCommand }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/status.js', () => ({ statusCommand }));

    const { runCli } = await import('../../src/index.js');

    expect(await runCli(
      ['init', '--channel', 'beta'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(initCommand).toHaveBeenCalledWith(expect.objectContaining({
      catalogChannel: 'beta',
    }));

    expect(await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--catalog-version', '1.2.3'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        catalogVersion: '1.2.3',
      }),
      expect.anything(),
    );

    expect(await runCli(
      ['status', '--catalog-channel', 'beta', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(statusCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        catalogChannel: 'beta',
      }),
      expect.anything(),
    );
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
    expect(readStdout()).not.toContain('repair');
    expect(readStdout()).toContain('cleanup');
    expect(readStdout()).toContain('reinstall');
    expect(readStderr()).toBe('');
  });

  it('does not use repair wording in cleanup help output', async () => {
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['cleanup', '--help'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io },
    );

    expect(exitCode).toBe(0);
    expect(readStdout()).toContain('--dependency-index');
    expect(readStdout()).not.toContain('repair');
    expect(readStderr()).toBe('');
  });

  it('fails diagnose help before Commander renders legacy help output', async () => {
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['diagnose', '--help'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io },
    );

    expect(exitCode).toBe(1);
    expect(readStdout()).toBe('');
    expect(readStderr()).toContain('`aw diagnose` 已移除，请改用 `aw status --verbose`');
    expect(readStderr()).not.toContain('Usage: aw diagnose');
    expect(readStderr()).not.toContain('--deep');
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
    expect(capture.readStderr()).toContain('原 `--deep` 诊断已并入 `status --verbose`');
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

  it('routes install, cleanup, and reinstall through the CLI entry with parseable JSON stdout', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
      receiptTargets: [{
        plugin: 'git-commit',
        platform: 'codex',
        scope: 'project',
        requested: true,
      }],
      receiptDetails: {
        adoptExistingLifecycleReason: 'adoptExistingFirstLocalRecord',
      },
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
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/cleanup.js', () => ({ cleanupCommand, isCleanupExecutionFailure }));
    vi.doMock('../../src/commands/reinstall.js', () => ({ reinstallCommand }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['install', 'git-commit', '--scope', 'project', '--platform', 'codex', '--adopt-existing', '--json'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      ok: true,
      command: 'install',
      adoptExistingLifecycleReason: 'adoptExistingFirstLocalRecord',
    });
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'project',
        platform: 'codex',
        adoptExisting: true,
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
      ['reinstall', 'git-commit', '--scope', 'user', '--platform', 'codex', '--json'],
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
        json: true,
      }),
      expect.anything(),
    );
  });

  it('fails removed or illegal legacy combinations before invoking write commands', async () => {
    const upgradeCommand = vi.fn();
    const cleanupCommand = vi.fn();
    const isCleanupExecutionFailure = vi.fn(() => false);
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
    vi.doMock('../../src/commands/cleanup.js', () => ({ cleanupCommand, isCleanupExecutionFailure }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['upgrade', '--all', '--takeover-shared-runtime'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('unknown option');
    expect(capture.readStderr()).toContain('--takeover-shared-runtime');
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
    expect(capture.readStderr()).toContain('unknown command');
    expect(capture.readStderr()).toContain('repair');
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

  it('passes catalog selector flags through to bare console invocations', async () => {
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

    const exitCode = await runCli(['--catalog-channel', 'beta'], {
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
    expect(runConsoleController.mock.calls[0][0].env.AW_CATALOG_CHANNEL).toBe('beta');
    expect(runConsoleController.mock.calls[0][0].env.AW_CATALOG_VERSION).toBeUndefined();
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
                authentication: 'ON_INSTALL',
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
                authentication: 'ON_INSTALL',
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
                authentication: 'ON_INSTALL',
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
                authentication: 'ON_INSTALL',
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
                authentication: 'ON_INSTALL',
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
    const { cwd, awHome, env } = currentReceiptTestPaths();
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      nativePlugins: {
        codex: ['git-commit'],
      },
      marketplace: {
        rootDir: awHome,
        changed: false,
        catalog: {
          rootDir: awHome,
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
        cwd,
        env: { ...env, AW_HOME: awHome } as NodeJS.ProcessEnv,
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
      catalog: {
        rootDir: '/tmp/aw-home',
        source: 'cache',
        selector: {
          kind: 'distTag',
          cliVersion: '1.4.0',
          defaultChannel: 'latest',
          requestedChannel: 'beta',
          overrideSource: 'option:channel-alias',
        },
        sidecarManifestPackage: {
          source: '@yiliang/aw-plugins-manifest',
          version: '2.0.0-beta.3',
          channel: 'beta',
          npmIntegrity: 'sha512-sidecar',
          manifestDigest: 'sha256:sidecar-manifest',
        },
        fullCatalog: {
          source: 'cache',
          version: '1.9.0-beta.2',
          channel: 'beta',
          minAwVersion: '1.4.0',
          revision: 'sha256:full-manifest',
          freshness: 'cached',
          resolutionSource: 'historyCompatibleCatalog',
        },
        channel: 'beta',
        catalogVersion: '1.9.0-beta.2',
        minAwVersion: '1.4.0',
        latestCatalog: {
          channel: 'beta',
          catalogVersion: '2.0.0-beta.3',
          minAwVersion: '2.0.0',
          blocked: true,
        },
        latestCatalogBlocked: {
          channel: 'beta',
          catalogVersion: '2.0.0-beta.3',
          minAwVersion: '2.0.0',
        },
        historySchemaVersion: 1,
        cacheFallback: {
          used: true,
          source: 'currentCatalogCache',
          cacheKey: 'cache-key-1',
          selectorKey: 'selector-key-1',
          blockingCode: 'catalogUnavailable',
          matchedSelector: {
            kind: 'distTag',
            cliVersion: '1.4.0',
            defaultChannel: 'latest',
            requestedChannel: 'beta',
            overrideSource: 'option:channel-alias',
          },
          matchedCatalog: {
            source: 'cache',
            version: '1.9.0-beta.2',
            channel: 'beta',
            minAwVersion: '1.4.0',
            revision: 'sha256:full-manifest',
            freshness: 'cached',
            resolutionSource: 'historyCompatibleCatalog',
          },
        },
        remoteFailure: {
          stage: 'fullTarball',
          packageName: '@yiliang/aw-plugins',
          packageVersion: '1.9.0-beta.2',
          integrity: 'sha512-full',
          message: 'simulated offline',
        },
        reason: 'simulated offline',
      },
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
      receiptSchemaVersion: 2,
      changed: true,
      rootDir: '/tmp/aw-home',
      warnings: ['init warning'],
      catalog: {
        selector: {
          kind: 'distTag',
          requestedChannel: 'beta',
          overrideSource: 'option:channel-alias',
        },
        sidecarManifestPackage: {
          source: '@yiliang/aw-plugins-manifest',
          version: '2.0.0-beta.3',
          channel: 'beta',
          npmIntegrity: 'sha512-sidecar',
          manifestDigest: 'sha256:sidecar-manifest',
        },
        fullCatalog: {
          source: 'cache',
          version: '1.9.0-beta.2',
          channel: 'beta',
          minAwVersion: '1.4.0',
          revision: 'sha256:full-manifest',
          freshness: 'cached',
          resolutionSource: 'historyCompatibleCatalog',
        },
        latestCatalog: {
          catalogVersion: '2.0.0-beta.3',
          minAwVersion: '2.0.0',
          blocked: true,
        },
        historySchemaVersion: 1,
        cacheFallback: {
          used: true,
          source: 'currentCatalogCache',
          selectorKey: 'selector-key-1',
          blockingCode: 'catalogUnavailable',
          matchedSelector: {
            requestedChannel: 'beta',
          },
          matchedCatalog: {
            source: 'cache',
            version: '1.9.0-beta.2',
            channel: 'beta',
          },
        },
      },
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
                authentication: 'ON_INSTALL',
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
