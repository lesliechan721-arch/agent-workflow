import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CodexManagerError,
  inspectSystemCodex,
  previewCodexManager,
  resolveCodexManager,
  resolveCodexOperationConsumer,
} from '../../src/utils/codex-manager.js';
import { getCodexOperationRequirement } from '../../src/utils/agent-version.js';
import {
  buildCodexMarketplaceAddInvocation,
  buildCodexPluginListJsonInvocation,
  execFileNativeCliRunner,
  NativeCliError,
  runNativeCli,
  type NativeCliInvocation,
  type NativeCliResult,
  type NativeCliRunner,
} from '../../src/utils/native-cli.js';
import {
  createIsolatedTestEnv,
  type IsolatedTestEnvironment,
} from '../helpers/test-isolation.js';

function result(stdout = '', stderr = '', exitCode = 0): NativeCliResult {
  return { stdout, stderr, exitCode };
}

async function executable(root: string, relative: string): Promise<string> {
  const target = path.join(root, relative);
  await fs.outputFile(target, 'fixture');
  await fs.chmod(target, 0o755);
  return fs.realpath(target);
}

async function windowsNpm(root: string, version = '0.155.0'): Promise<string> {
  const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  await fs.outputFile(path.join(root, 'codex.CMD'), '@echo off\r\n');
  await fs.outputJson(path.join(packageRoot, 'package.json'), {
    name: '@openai/codex', version, bin: { codex: 'bin/codex.js' },
  });
  await fs.outputFile(launcher, [
    'const args = process.argv.slice(2);',
    "process.stdout.write(args[0] === '--version' ? 'codex-cli 0.155.0' : JSON.stringify(args));",
  ].join('\n'));
  return fs.realpath(launcher);
}

describe('Codex manager resolver', () => {
  let isolation: IsolatedTestEnvironment;

  beforeEach(async () => {
    isolation = await createIsolatedTestEnv();
    isolation.env.PATH = '';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await isolation.cleanup();
  });

  const requirement = getCodexOperationRequirement('project');

  // Test Value Gate: discovery is read-only and a missing CLI cannot authorize project writes.
  it('reports missing without running a command or creating AW state', async () => {
    const runner = vi.fn<NativeCliRunner>();
    const options = {
      env: isolation.env, cwd: isolation.layout.fixtureCwd,
      platform: 'linux' as const, operationRequirement: requirement, runner,
    };
    await expect(inspectSystemCodex(options)).resolves.toEqual({
      state: 'missing', requiredMinVersion: '0.155.0',
    });
    await expect(previewCodexManager(options)).resolves.toMatchObject({
      state: 'blocked', code: 'codexCliNotFound',
    });
    await expect(resolveCodexOperationConsumer(options)).rejects.toMatchObject({ code: 'codexCliNotFound' });
    expect(runner).not.toHaveBeenCalled();
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it.each([
    ['codex-cli 0.155.0', 0, 'compatible'],
    ['codex-cli 0.155.0+build.1', 0, 'compatible'],
    ['codex-cli 0.155.0-rc.1', 0, 'incompatible'],
    ['codex-cli 0.154.999', 0, 'incompatible'],
    ['codex-cli 00.155.0', 0, 'unresolved'],
    ['codex-cli 0.155.0-01', 0, 'unresolved'],
    ['codex-cli v0.155.0', 0, 'unresolved'],
    ['private-secret invalid version', 0, 'unresolved'],
    ['private-secret codex-cli 0.999.0', 1, 'unresolved'],
  ] as const)('applies strict SemVer and the minimum to %s / %s', async (stdout, exitCode, state) => {
    const command = await executable(isolation.layout.fixtureCwd, 'bin/codex');
    const runner = vi.fn<NativeCliRunner>(async () => result(stdout, 'private-secret', exitCode));
    const inspection = await inspectSystemCodex({
      env: { ...isolation.env, PATH: 'bin' }, cwd: isolation.layout.fixtureCwd,
      platform: 'linux', operationRequirement: requirement, runner,
    });
    expect(inspection).toMatchObject({ state, requiredMinVersion: '0.155.0' });
    if (inspection.state === 'compatible') {
      expect(inspection.manager).toMatchObject({ command, version: inspection.detectedVersion, kind: 'system' });
    }
    expect(JSON.stringify(inspection)).not.toContain('private-secret');
    expect(runner.mock.calls.map(([invocation]) => ({
      command: invocation.command, args: invocation.args,
    }))).toEqual([{ command, args: ['--version'] }]);
    expect(runner.mock.calls[0]![0].timeoutMs).toBeGreaterThan(0);
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it.each(['user', 'project'] as const)('rejects missing and old CLI evidence for %s activation', async (scope) => {
    const options = {
      env: isolation.env, cwd: isolation.layout.fixtureCwd, platform: 'linux' as const,
      operationRequirement: getCodexOperationRequirement(scope),
      runner: async () => result('codex-cli 0.154.0'),
    };
    await expect(resolveCodexOperationConsumer(options)).rejects.toMatchObject({ code: 'codexCliNotFound' });
    await executable(isolation.layout.fixtureCwd, 'bin/codex');
    await expect(resolveCodexOperationConsumer({ ...options, env: { ...isolation.env, PATH: 'bin' } }))
      .rejects.toMatchObject({ code: 'codexSystemCliUnsupported' });
  });

  it('ignores an old runtime and leaves it intact, but accepts an explicit PATH entry there', async () => {
    const oldRuntime = path.join(isolation.layout.awHomeDir, 'runtimes', 'codex', '0.151.0', 'old-runtime');
    const command = await executable(oldRuntime, 'codex');
    const marker = path.join(oldRuntime, '.aw-managed-runtime.json');
    await fs.writeFile(marker, 'broken owner data');
    const runner = vi.fn<NativeCliRunner>(async () => result('codex-cli 0.157.0'));
    const options = { env: isolation.env, cwd: isolation.layout.fixtureCwd, platform: 'linux' as const, runner };
    await expect(resolveCodexManager(options)).rejects.toBeInstanceOf(CodexManagerError);
    expect(runner).not.toHaveBeenCalled();
    expect(await fs.readFile(marker, 'utf8')).toBe('broken owner data');
    await expect(resolveCodexManager({ ...options, env: { ...isolation.env, PATH: oldRuntime } }))
      .resolves.toEqual({ kind: 'system', version: '0.157.0', command, argsPrefix: [] });
  });

  it('rediscovers and probes on each resolve without a persistent choice', async () => {
    const command = await executable(isolation.layout.fixtureCwd, 'bin/codex');
    const runner = vi.fn<NativeCliRunner>()
      .mockResolvedValueOnce(result('codex-cli 0.155.0'))
      .mockResolvedValueOnce(result('codex-cli 0.157.0'));
    const options = {
      env: { ...isolation.env, PATH: 'bin' }, cwd: isolation.layout.fixtureCwd,
      platform: 'linux' as const, runner,
    };
    await expect(previewCodexManager(options)).resolves.toMatchObject({
      state: 'system', manager: { command, version: '0.155.0' },
    });
    await expect(resolveCodexOperationConsumer({ ...options, operationRequirement: requirement }))
      .resolves.toMatchObject({ support: 'observed', manager: { command, version: '0.157.0' }, requirement });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('does not switch to a lower CLI after the selected native command fails', async () => {
    const first = await executable(isolation.layout.fixtureCwd, 'first/codex');
    const second = await executable(isolation.layout.fixtureCwd, 'second/codex');
    const runner = vi.fn<NativeCliRunner>(async (invocation) => {
      if (invocation.args[0] === '--version') return result(`codex-cli ${invocation.command === first ? '0.155.0' : '0.157.0'}`);
      return result('', 'native command failed', 1);
    });
    const env = { ...isolation.env, PATH: 'first:second' };
    const manager = await resolveCodexManager({ platform: 'linux', cwd: isolation.layout.fixtureCwd, env, runner });
    await expect(runNativeCli(buildCodexPluginListJsonInvocation(manager, 'aw', isolation.layout.fixtureCwd, env), runner))
      .resolves.toMatchObject({ exitCode: 1 });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls[2]![0].command).toBe(second);
  });

  // Test Value Gate: fatal probe errors must block fallback without exposing native paths or output.
  it.each(['abort', 'native abort', 'cleanup', 'renamed abort', 'renamed cleanup'] as const)('propagates %s instead of selecting another candidate', async (failure) => {
    await executable(isolation.layout.fixtureCwd, 'first/codex');
    await executable(isolation.layout.fixtureCwd, 'second/codex');
    const command = path.join(isolation.layout.fixtureCwd, 'private-command', 'codex');
    const cleanupError = failure.includes('cleanup') ? new Error('private-cleanup') : undefined;
    const error = failure === 'abort'
      ? Object.assign(new Error('cancelled'), { name: 'AbortError' })
      : new NativeCliError({
          invocation: { command, args: ['--version'] }, exitCode: 1,
          stdout: 'private-stdout', stderr: 'private-stderr', reason: failure === 'native abort' ? 'aborted' : 'timeout',
          cleanupError,
        });
    if (failure.startsWith('renamed')) error.name = 'AbortError';
    const runner = vi.fn<NativeCliRunner>(async () => { throw error; });
    await expect(resolveCodexManager({
      platform: 'linux', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'first:second' }, runner,
    })).rejects.toBe(error);
    expect(runner).toHaveBeenCalledTimes(1);
    if (error instanceof NativeCliError) {
      expect(error.message).not.toContain(command);
      expect(error.message).not.toContain('private-');
      expect(error.message).toContain(failure === 'native abort' ? 'nativeCliFailed' : 'nativeCliTimedOut');
      expect(error.reason).toBe(failure === 'native abort' ? 'aborted' : 'timeout');
      expect(error.cleanupError).toBe(cleanupError);
    }
  });

  it('runs an official Windows npm launcher through Node and keeps that exact entry', async () => {
    const prefix = path.join(isolation.layout.fixtureCwd, 'npm prefix & %value%');
    const launcher = await windowsNpm(prefix);
    const env = { ...isolation.env, PATH: prefix, PATHEXT: '.CMD' };
    const manager = await resolveCodexManager({
      platform: 'win32', cwd: isolation.layout.fixtureCwd, env,
      runner: execFileNativeCliRunner,
      queryRunner: async () => result('[]'),
    });
    env.PATH = '';
    const marketplace = path.join(isolation.layout.fixtureCwd, 'marketplace & %PATH%');
    await expect(runNativeCli(buildCodexMarketplaceAddInvocation(manager, marketplace, isolation.layout.fixtureCwd, env), execFileNativeCliRunner))
      .resolves.toMatchObject({ exitCode: 0, stdout: JSON.stringify(['plugin', 'marketplace', 'add', marketplace]) });
    expect(manager).toEqual({ kind: 'system', version: '0.155.0', command: process.execPath, argsPrefix: [launcher] });
  });

  it.each(['foreign package', 'version mismatch', 'batch launcher', 'package escape'] as const)(
    'excludes an unsafe Windows entry: %s', async (failure) => {
      const prefix = path.join(isolation.layout.fixtureCwd, 'npm-prefix');
      await windowsNpm(prefix);
      if (failure === 'foreign package') {
        await fs.writeJson(path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json'), {
          name: '@foreign/codex', version: '0.155.0', bin: { codex: 'bin/codex.js' },
        });
      }
      if (failure === 'batch launcher') await fs.writeFile(path.join(prefix, 'codex.BAT'), '@echo off');
      if (failure === 'package escape') {
        const nodeModules = path.join(prefix, 'node_modules');
        const external = path.join(isolation.layout.rootDir, 'external-node-modules');
        await fs.move(nodeModules, external);
        await fs.symlink(external, nodeModules, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const runner = vi.fn<NativeCliRunner>(async () => result(failure === 'version mismatch' ? 'codex-cli 0.157.0' : 'codex-cli 0.155.0'));
      await expect(previewCodexManager({
        platform: 'win32', cwd: isolation.layout.fixtureCwd,
        env: { ...isolation.env, PATH: prefix, PATHEXT: failure === 'batch launcher' ? '.BAT' : '.CMD' }, runner,
        queryRunner: async () => result('[]'),
      })).resolves.toMatchObject({ state: 'blocked', code: 'codexSystemCliUnsupported' });
      expect(runner).toHaveBeenCalledTimes(failure === 'version mismatch' ? 1 : 0);
    },
  );

  it.runIf(process.platform !== 'win32')('keeps the canonical POSIX entry when its PATH symlink changes', async () => {
    const first = await executable(isolation.layout.fixtureCwd, 'targets/first');
    const second = await executable(isolation.layout.fixtureCwd, 'targets/second');
    const shim = path.join(isolation.layout.fixtureCwd, 'bin', 'codex');
    await fs.ensureDir(path.dirname(shim));
    await fs.symlink(first, shim);
    const runner = vi.fn<NativeCliRunner>(async (invocation) => {
      if (invocation.args[0] === '--version') {
        await fs.remove(shim);
        await fs.symlink(second, shim);
      }
      return result('codex-cli 0.155.0');
    });
    const env = { ...isolation.env, PATH: 'bin' };
    const manager = await resolveCodexManager({ env, cwd: isolation.layout.fixtureCwd, platform: 'linux', runner });
    await runNativeCli(buildCodexPluginListJsonInvocation(manager, 'aw', isolation.layout.fixtureCwd, env), runner);
    expect(runner.mock.calls.map(([invocation]) => invocation.command)).toEqual([first, first]);
  });
});
