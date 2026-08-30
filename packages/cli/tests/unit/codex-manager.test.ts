import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CodexManagerError,
  MANAGED_CODEX_MARKER_FILE,
  MANAGED_CODEX_PACKAGE_NAME,
  MANAGED_CODEX_REGISTRY,
  MANAGED_CODEX_VERSION,
  previewCodexManager,
  resolveCodexManager,
  resolveCodexOperationConsumer,
} from '../../src/utils/codex-manager.js';
import { getCodexOperationRequirement } from '../../src/utils/agent-version.js';
import {
  buildCodexMarketplaceAddInvocation,
  buildCodexPluginListInvocation,
  execFileNativeCliRunner,
  runNativeCli,
  type NativeCliInvocation,
  type NativeCliResult,
  type NativeCliRunner,
} from '../../src/utils/native-cli.js';
import {
  createIsolatedTestEnv,
  type IsolatedTestEnvironment,
} from '../helpers/test-isolation.js';

function missingExecutable(): Error & { code: string } {
  return Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
}

function result(stdout = '', stderr = '', exitCode = 0): NativeCliResult {
  return { stdout, stderr, exitCode };
}

function runtimeRoot(isolation: IsolatedTestEnvironment): string {
  return path.join(
    isolation.layout.awHomeDir,
    'runtimes',
    'codex',
    MANAGED_CODEX_VERSION,
    `${process.platform}-${process.arch}`,
  );
}

async function writeRuntime(
  isolation: IsolatedTestEnvironment,
  options: { marker?: boolean; version?: string; sentinel?: boolean } = {},
): Promise<void> {
  const root = runtimeRoot(isolation);
  const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
  await fs.ensureDir(path.join(packageRoot, 'bin'));
  await fs.writeJson(path.join(packageRoot, 'package.json'), {
    name: MANAGED_CODEX_PACKAGE_NAME,
    version: options.version ?? MANAGED_CODEX_VERSION,
  });
  await fs.writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// fixture launcher\n');
  if (options.marker !== false) {
    await fs.writeJson(path.join(root, MANAGED_CODEX_MARKER_FILE), {
      schemaVersion: 1,
      owner: 'aw',
      packageName: MANAGED_CODEX_PACKAGE_NAME,
      version: MANAGED_CODEX_VERSION,
      platform: process.platform,
      arch: process.arch,
    });
  }
  if (options.sentinel) await fs.writeFile(path.join(root, 'old-runtime'), 'old');
}

async function writePathCodex(
  isolation: IsolatedTestEnvironment,
  directoryName: string,
  platform: NodeJS.Platform,
): Promise<{ command: string; pathEntry: string }> {
  const pathEntry = directoryName;
  const binRoot = path.join(isolation.layout.fixtureCwd, pathEntry);
  const executableName = platform === 'win32' ? 'codex.CMD' : 'codex';
  const executablePath = path.join(binRoot, executableName);
  await fs.ensureDir(binRoot);
  await fs.writeFile(executablePath, 'fixture');
  await fs.chmod(executablePath, 0o755);
  return {
    command: process.platform === 'win32'
      ? path.resolve(executablePath)
      : await fs.realpath(executablePath),
    pathEntry,
  };
}

async function writeWindowsNpmCodex(
  isolation: IsolatedTestEnvironment,
  directoryName: string,
  options: {
    name?: string;
    version?: string;
  } = {},
): Promise<{ binRoot: string; launcher: string }> {
  const binRoot = path.join(isolation.layout.fixtureCwd, directoryName);
  const packageRoot = path.join(binRoot, 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  const shim = path.join(binRoot, 'codex.CMD');
  await fs.ensureDir(path.dirname(launcher));
  await Promise.all([
    fs.writeFile(shim, '@echo off\r\n'),
    fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: options.name ?? MANAGED_CODEX_PACKAGE_NAME,
      version: options.version ?? '0.151.0',
      bin: { codex: 'bin/codex.js' },
    }),
    fs.writeFile(launcher, [
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') {",
      "  process.stdout.write('codex-cli 0.151.0');",
      '} else {',
      '  process.stdout.write(JSON.stringify(args));',
      '}',
      '',
    ].join('\n')),
  ]);
  return { binRoot, launcher };
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

  it('selects a supported system Codex and does not inspect or authorize managed state', async () => {
    const executable = await writePathCodex(isolation, 'system-bin', 'linux');
    const authorizer = vi.fn(() => true);
    const runner: NativeCliRunner = async (invocation) => {
      expect(invocation.command).toBe(executable.command);
      return result('codex-cli 0.151.0');
    };

    await expect(resolveCodexManager({
      env: { ...isolation.env, PATH: executable.pathEntry, PATHEXT: '.CMD' },
      cwd: isolation.layout.fixtureCwd,
      platform: 'linux',
      runner,
      authorizer,
    })).resolves.toEqual({
      kind: 'system',
      version: '0.151.0',
      command: executable.command,
      argsPrefix: [],
    });
    expect(authorizer).not.toHaveBeenCalled();
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it('blocks system Codex 0.150 for a project operation without managed fallback', async () => {
    const executable = await writePathCodex(isolation, 'project-system-bin', 'linux');
    const authorizer = vi.fn(() => true);

    await expect(resolveCodexOperationConsumer({
      env: { ...isolation.env, PATH: executable.pathEntry },
      cwd: isolation.layout.fixtureCwd,
      platform: 'linux',
      runner: async () => result('codex-cli 0.150.0'),
      authorizer,
      operationRequirement: getCodexOperationRequirement('project'),
      requiresNativeMaterialization: false,
    })).rejects.toMatchObject({ code: 'codexProjectPluginVersionTooLow' });
    expect(authorizer).not.toHaveBeenCalled();
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it.each([
    ['unparseable', result('Codex development build')],
    ['probe failure', result('', 'probe failed', 2)],
  ])('uses the project-contract unsupported code for %s system evidence', async (
    _label,
    probeResult,
  ) => {
    const executable = await writePathCodex(isolation, 'project-unsupported-bin', 'linux');
    await expect(resolveCodexOperationConsumer({
      env: { ...isolation.env, PATH: executable.pathEntry },
      cwd: isolation.layout.fixtureCwd,
      platform: 'linux',
      runner: async () => probeResult,
      operationRequirement: getCodexOperationRequirement('project'),
      requiresNativeMaterialization: false,
    })).rejects.toMatchObject({ code: 'codexProjectPluginUnsupported' });
  });

  it('assumes an App consumer when project activation has no system CLI and needs no native write', async () => {
    const runner = vi.fn(async () => result('must not run'));
    const authorizer = vi.fn(() => true);
    const requirement = getCodexOperationRequirement('project');

    await expect(resolveCodexOperationConsumer({
      env: { ...isolation.env, PATH: '' },
      cwd: isolation.layout.fixtureCwd,
      runner,
      authorizer,
      operationRequirement: requirement,
      requiresNativeMaterialization: false,
    })).resolves.toEqual({ support: 'assumed', requirement });
    expect(runner).not.toHaveBeenCalled();
    expect(authorizer).not.toHaveBeenCalled();
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it('resolves and authorizes managed Codex only when native materialization is required', async () => {
    const authorizer = vi.fn(() => false);

    await expect(resolveCodexOperationConsumer({
      env: { ...isolation.env, PATH: '' },
      cwd: isolation.layout.fixtureCwd,
      runner: async () => { throw missingExecutable(); },
      authorizer,
      operationRequirement: getCodexOperationRequirement('project'),
      requiresNativeMaterialization: true,
    })).rejects.toMatchObject({ code: 'managedCodexAuthorizationRequired' });
    expect(authorizer).toHaveBeenCalledTimes(1);
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it.each([
    ['too old', result('codex-cli 0.1.0')],
    ['unparseable', result('Codex development build')],
    ['probe failure', result('', 'probe failed', 2)],
  ])('blocks an unsupported system Codex (%s) without managed fallback', async (_label, probeResult) => {
    const executable = await writePathCodex(isolation, 'unsupported-bin', 'linux');
    const authorizer = vi.fn(() => true);
    await expect(resolveCodexManager({
      env: { ...isolation.env, PATH: executable.pathEntry, PATHEXT: '.CMD' },
      cwd: isolation.layout.fixtureCwd,
      platform: 'linux',
      runner: async () => probeResult,
      authorizer,
    })).rejects.toMatchObject({ code: 'codexSystemCliUnsupported' });
    expect(authorizer).not.toHaveBeenCalled();
  });

  it('runs an official Windows npm shim through its canonical Node launcher without cmd parsing', async () => {
    const installation = await writeWindowsNpmCodex(
      isolation,
      'npm prefix with spaces & %value%',
    );
    const env: NodeJS.ProcessEnv = {
      ...isolation.env,
      PATH: installation.binRoot,
      PATHEXT: '.CMD',
    };
    const manager = await resolveCodexManager({
      platform: 'win32',
      cwd: isolation.layout.fixtureCwd,
      env,
      runner: execFileNativeCliRunner,
    });
    env.PATH = path.join(isolation.layout.fixtureCwd, 'replacement-bin');
    const marketplaceRoot = path.join(
      isolation.layout.fixtureCwd,
      'marketplace & %PATH% with spaces',
    );
    const operation = await runNativeCli(
      buildCodexMarketplaceAddInvocation(
        manager,
        marketplaceRoot,
        isolation.layout.fixtureCwd,
        env,
      ),
      execFileNativeCliRunner,
    );

    const canonicalLauncher = await fs.realpath(installation.launcher);
    expect(manager).toEqual({
      kind: 'system',
      version: '0.151.0',
      command: process.execPath,
      argsPrefix: [canonicalLauncher],
    });
    expect(operation).toMatchObject({
      exitCode: 0,
      stdout: JSON.stringify(['plugin', 'marketplace', 'add', marketplaceRoot]),
    });
  });

  it('blocks a foreign Windows npm package before probing', async () => {
    const installation = await writeWindowsNpmCodex(
      isolation,
      'foreign-package-prefix',
      { name: '@example/codex' },
    );
    const runner = vi.fn(async () => result('codex-cli 0.151.0'));
    const authorizer = vi.fn(() => true);

    await expect(resolveCodexManager({
      platform: 'win32',
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: installation.binRoot, PATHEXT: '.CMD' },
      runner,
      authorizer,
    })).rejects.toMatchObject({ code: 'codexSystemCliUnsupported' });
    expect(runner).not.toHaveBeenCalled();
    expect(authorizer).not.toHaveBeenCalled();
  });

  it('blocks a Windows .bat launcher without probing or managed fallback', async () => {
    const binRoot = path.join(isolation.layout.fixtureCwd, 'batch-prefix');
    await fs.ensureDir(binRoot);
    await fs.writeFile(path.join(binRoot, 'codex.bat'), '@echo off\r\n');
    const runner = vi.fn(async () => result('codex-cli 0.151.0'));
    const authorizer = vi.fn(() => true);

    await expect(resolveCodexManager({
      platform: 'win32',
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: binRoot, PATHEXT: '.BAT' },
      runner,
      authorizer,
    })).rejects.toMatchObject({ code: 'codexSystemCliUnsupported' });
    expect(runner).not.toHaveBeenCalled();
    expect(authorizer).not.toHaveBeenCalled();
  });

  it('blocks a Windows npm package that resolves outside its shim prefix', async () => {
    const installation = await writeWindowsNpmCodex(isolation, 'linked-package-prefix');
    const nodeModules = path.join(installation.binRoot, 'node_modules');
    const externalNodeModules = path.join(isolation.layout.rootDir, 'external-node-modules');
    await fs.move(nodeModules, externalNodeModules);
    await fs.symlink(
      externalNodeModules,
      nodeModules,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const runner = vi.fn(async () => result('codex-cli 0.151.0'));

    await expect(previewCodexManager({
      platform: 'win32',
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: installation.binRoot, PATHEXT: '.CMD' },
      runner,
    })).resolves.toMatchObject({
      state: 'blocked',
      code: 'codexSystemCliUnsupported',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('blocks a Windows npm launcher whose output does not match its package version', async () => {
    const installation = await writeWindowsNpmCodex(isolation, 'version-mismatch-prefix', {
      version: '0.152.0',
    });
    const authorizer = vi.fn(() => true);

    await expect(resolveCodexManager({
      platform: 'win32',
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: installation.binRoot, PATHEXT: '.CMD' },
      runner: async () => result('codex-cli 0.151.0'),
      authorizer,
    })).rejects.toMatchObject({ code: 'codexSystemCliUnsupported' });
    expect(authorizer).not.toHaveBeenCalled();
  });

  it('prefers and executes a resolved Windows .exe binary directly', async () => {
    const binRoot = path.join(isolation.layout.fixtureCwd, 'windows-exe-bin');
    const executable = path.join(binRoot, 'codex.EXE');
    await fs.ensureDir(binRoot);
    await fs.writeFile(path.join(binRoot, 'codex'), 'extensionless wrapper');
    await fs.writeFile(path.join(binRoot, 'codex.CMD'), '@echo off\r\n');
    await fs.writeFile(executable, 'fixture');
    const runner = vi.fn(async (invocation: NativeCliInvocation) => {
      expect(invocation).toMatchObject({
        command: path.resolve(executable),
        args: ['--version'],
      });
      return result('codex-cli 0.151.0');
    });

    await expect(resolveCodexManager({
      platform: 'win32',
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: binRoot, PATHEXT: '.CMD;.EXE' },
      runner,
    })).resolves.toEqual({
      kind: 'system',
      version: '0.151.0',
      command: path.resolve(executable),
      argsPrefix: [],
    });
  });

  it.runIf(process.platform !== 'win32')(
    'keeps using the probed POSIX executable after its PATH symlink changes',
    async () => {
      const binRoot = path.join(isolation.layout.fixtureCwd, 'symlink-bin');
      const targetRoot = path.join(isolation.layout.fixtureCwd, 'symlink-targets');
      const firstTarget = path.join(targetRoot, 'codex-first');
      const secondTarget = path.join(targetRoot, 'codex-second');
      const shim = path.join(binRoot, 'codex');
      await fs.ensureDir(binRoot);
      await fs.ensureDir(targetRoot);
      await fs.writeFile(firstTarget, 'first');
      await fs.writeFile(secondTarget, 'second');
      await fs.chmod(firstTarget, 0o755);
      await fs.chmod(secondTarget, 0o755);
      await fs.symlink(firstTarget, shim, 'file');
      const canonicalFirstTarget = await fs.realpath(firstTarget);
      const commands: string[] = [];
      const runner: NativeCliRunner = async (invocation) => {
        commands.push(invocation.command);
        if (invocation.args.at(-1) === '--version') {
          await fs.remove(shim);
          await fs.symlink(secondTarget, shim, 'file');
          return result('codex-cli 0.151.0');
        }
        return result('ok');
      };
      const env = { ...isolation.env, PATH: 'symlink-bin' };
      const manager = await resolveCodexManager({
        platform: process.platform,
        cwd: isolation.layout.fixtureCwd,
        env,
        runner,
      });

      await runNativeCli(
        buildCodexPluginListInvocation(manager, isolation.layout.fixtureCwd, env),
        runner,
      );

      expect(commands).toEqual([canonicalFirstTarget, canonicalFirstTarget]);
      expect(await fs.realpath(shim)).toBe(await fs.realpath(secondTarget));
    },
  );

  it('previews a missing runtime without writing or requesting authorization', async () => {
    const runner: NativeCliRunner = async () => { throw missingExecutable(); };

    await expect(previewCodexManager({ env: isolation.env, runner })).resolves.toEqual({
      state: 'requires-install',
    });
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it('reuses a valid cache, checks it on each resolve, and returns a Node launcher manager', async () => {
    await writeRuntime(isolation);
    const calls: NativeCliInvocation[] = [];
    const runner: NativeCliRunner = async (invocation) => {
      calls.push(invocation);
      if (invocation.command === 'codex') throw missingExecutable();
      return result(`codex-cli ${MANAGED_CODEX_VERSION}`);
    };
    const authorizer = vi.fn(() => true);

    const preview = await previewCodexManager({ env: isolation.env, runner });
    expect(preview).toMatchObject({ state: 'cached' });
    const manager = await resolveCodexManager({ env: isolation.env, runner, authorizer });
    const canonicalLauncher = await fs.realpath(
      path.join(runtimeRoot(isolation), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    );
    expect(manager).toEqual({
      kind: 'aw-managed',
      version: MANAGED_CODEX_VERSION,
      command: process.execPath,
      argsPrefix: [canonicalLauncher],
      runtimeRoot: runtimeRoot(isolation),
    });
    expect(calls).toHaveLength(2);
    expect(authorizer).not.toHaveBeenCalled();
  });

  it('blocks a managed package link outside the runtime before its launcher can run', async () => {
    await writeRuntime(isolation);
    const linkedPackageRoot = path.join(runtimeRoot(isolation), 'node_modules', '@openai', 'codex');
    const externalPackageRoot = path.join(isolation.layout.rootDir, 'external-codex');
    const sentinel = path.join(externalPackageRoot, 'executed');
    await fs.remove(linkedPackageRoot);
    await fs.ensureDir(path.join(externalPackageRoot, 'bin'));
    await fs.writeJson(path.join(externalPackageRoot, 'package.json'), {
      name: MANAGED_CODEX_PACKAGE_NAME,
      version: MANAGED_CODEX_VERSION,
    });
    await fs.writeFile(path.join(externalPackageRoot, 'bin', 'codex.js'), '// external launcher\n');
    await fs.symlink(externalPackageRoot, linkedPackageRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const runner: NativeCliRunner = async () => {
      await fs.writeFile(sentinel, 'executed');
      return result(`codex-cli ${MANAGED_CODEX_VERSION}`);
    };

    await expect(previewCodexManager({
      env: { ...isolation.env, PATH: '' },
      runner,
    })).resolves.toMatchObject({
      state: 'blocked',
      code: 'managedCodexUnavailable',
    });
    expect(await fs.pathExists(sentinel)).toBe(false);
  });

  it('blocks package metadata that resolves inside the runtime but outside its package root', async () => {
    await writeRuntime(isolation);
    const root = runtimeRoot(isolation);
    const packageJsonPath = managedPackagePath(isolation);
    const detachedPackageJson = path.join(root, 'detached-package.json');
    const sentinel = path.join(root, 'self-check-executed');
    await fs.remove(packageJsonPath);
    await fs.writeJson(detachedPackageJson, {
      name: MANAGED_CODEX_PACKAGE_NAME,
      version: MANAGED_CODEX_VERSION,
    });
    await fs.symlink(detachedPackageJson, packageJsonPath, 'file');
    const runner: NativeCliRunner = async () => {
      await fs.writeFile(sentinel, 'executed');
      return result(`codex-cli ${MANAGED_CODEX_VERSION}`);
    };

    await expect(previewCodexManager({ env: isolation.env, runner })).resolves.toMatchObject({
      state: 'blocked',
      code: 'managedCodexUnavailable',
    });
    expect(await fs.pathExists(sentinel)).toBe(false);
  });

  it('accepts a pnpm-style managed package link that stays within the runtime', async () => {
    const root = runtimeRoot(isolation);
    const packageRoot = path.join(
      root,
      'node_modules',
      '.pnpm',
      `@openai+codex@${MANAGED_CODEX_VERSION}`,
      'node_modules',
      '@openai',
      'codex',
    );
    await fs.ensureDir(path.join(packageRoot, 'bin'));
    await fs.ensureDir(path.join(root, 'node_modules', '@openai'));
    await fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: MANAGED_CODEX_PACKAGE_NAME,
      version: MANAGED_CODEX_VERSION,
    });
    await fs.writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// internal launcher\n');
    await fs.symlink(
      packageRoot,
      path.join(root, 'node_modules', '@openai', 'codex'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.writeJson(path.join(root, MANAGED_CODEX_MARKER_FILE), {
      schemaVersion: 1,
      owner: 'aw',
      packageName: MANAGED_CODEX_PACKAGE_NAME,
      version: MANAGED_CODEX_VERSION,
      platform: process.platform,
      arch: process.arch,
    });
    const canonicalLauncher = await fs.realpath(path.join(packageRoot, 'bin', 'codex.js'));

    await expect(previewCodexManager({
      env: { ...isolation.env, PATH: '' },
      runner: async () => result(`codex-cli ${MANAGED_CODEX_VERSION}`),
    })).resolves.toMatchObject({
      state: 'cached',
      manager: {
        argsPrefix: [canonicalLauncher],
      },
    });
  });

  it('requires authorization once only when installation is necessary', async () => {
    const authorizer = vi.fn(() => false);

    await expect(resolveCodexManager({
      env: isolation.env,
      runner: async () => { throw missingExecutable(); },
      authorizer,
    })).rejects.toEqual(expect.objectContaining({
      code: 'managedCodexAuthorizationRequired',
      message: expect.stringMatching(/^managedCodexAuthorizationRequired:/u),
    }));
    expect(authorizer).toHaveBeenCalledTimes(1);
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it('installs with the bundled pnpm contract, self-checks, marks, and atomically adopts', async () => {
    const invocations: NativeCliInvocation[] = [];
    const runner: NativeCliRunner = async (invocation) => {
      invocations.push(invocation);
      if (invocation.command === 'codex') throw missingExecutable();
      if (invocation.args[1] === 'install') {
        const stagingRoot = invocation.cwd!;
        const packageRoot = path.join(stagingRoot, 'node_modules', '@openai', 'codex');
        await fs.ensureDir(path.join(packageRoot, 'bin'));
        await fs.writeJson(path.join(packageRoot, 'package.json'), {
          name: MANAGED_CODEX_PACKAGE_NAME,
          version: MANAGED_CODEX_VERSION,
        });
        await fs.writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// launcher\n');
        return result();
      }
      if (invocation.args.at(-2) === 'plugin') return result('plugin help');
      return result(`codex-cli ${MANAGED_CODEX_VERSION}`);
    };
    const env = {
      ...isolation.env,
      PATH: '/fixture/path',
      npm_config_registry: 'https://foreign.invalid/',
      npm_config_store_dir: '/foreign/store',
    };

    const manager = await resolveCodexManager({
      env,
      runner,
      authorizer: () => true,
    });
    expect(manager.command).toBe(process.execPath);
    const install = invocations.find((call) => call.args[1] === 'install')!;
    expect(install.command).toBe(process.execPath);
    expect(install.args[0]).toMatch(/[/\\]pnpm\.cjs$/u);
    expect(install.args).toEqual([
      install.args[0],
      'install',
      '--prod',
      '--ignore-scripts',
      '--ignore-workspace',
      `--registry=${MANAGED_CODEX_REGISTRY}`,
      `--store-dir=${path.join(isolation.layout.awHomeDir, 'runtimes', '.pnpm-store')}`,
      expect.stringMatching(/^--config\.userconfig=/u),
    ]);
    expect(install.env?.PATH).toBe('/fixture/path');
    expect(install.env?.HOME).toBe(env.HOME);
    expect(install.env?.USERPROFILE).toBe(env.USERPROFILE);
    expect(install.env?.npm_config_registry).toBeUndefined();
    expect(install.env?.npm_config_store_dir).toBeUndefined();
    const selfChecks = invocations.filter((call) => call.command === process.execPath && call !== install);
    expect(selfChecks.map((call) => call.args.slice(-2))).toEqual([
      [expect.stringContaining('codex.js'), '--version'],
      ['plugin', '--help'],
    ]);
    expect(selfChecks.every((call) => call.env?.CODEX_HOME === isolation.layout.codexHomeDir)).toBe(true);
    expect(selfChecks.every((call) => call.env?.HOME === env.HOME)).toBe(true);
    await expect(fs.readJson(path.join(runtimeRoot(isolation), MANAGED_CODEX_MARKER_FILE))).resolves.toEqual({
      schemaVersion: 1,
      owner: 'aw',
      packageName: MANAGED_CODEX_PACKAGE_NAME,
      version: MANAGED_CODEX_VERSION,
      platform: process.platform,
      arch: process.arch,
    });
    const siblings = await fs.readdir(path.dirname(runtimeRoot(isolation)));
    expect(siblings).toEqual([path.basename(runtimeRoot(isolation))]);
  });

  it('cleans its staging directory when the installed artifact fails validation', async () => {
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.command === 'codex') throw missingExecutable();
      if (invocation.args[0] === '/fixture/pnpm.cjs') {
        const packageRoot = path.join(invocation.cwd!, 'node_modules', '@openai', 'codex');
        await fs.ensureDir(path.join(packageRoot, 'bin'));
        await fs.writeJson(path.join(packageRoot, 'package.json'), {
          name: MANAGED_CODEX_PACKAGE_NAME,
          version: '0.149.0',
        });
        await fs.writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// launcher\n');
      }
      return result();
    };

    await expect(resolveCodexManager({
      env: isolation.env,
      runner,
      authorizer: () => true,
      pnpmEntry: '/fixture/pnpm.cjs',
    })).rejects.toMatchObject({ code: 'managedCodexUnavailable' });
    expect(await fs.pathExists(runtimeRoot(isolation))).toBe(false);
    expect(await fs.readdir(path.dirname(runtimeRoot(isolation)))).toEqual([]);
  });

  it('rejects an acquired package link outside staging before running self-checks', async () => {
    const externalPackageRoot = path.join(isolation.layout.rootDir, 'external-install-codex');
    const sentinel = path.join(externalPackageRoot, 'executed');
    await fs.ensureDir(path.join(externalPackageRoot, 'bin'));
    await fs.writeJson(path.join(externalPackageRoot, 'package.json'), {
      name: MANAGED_CODEX_PACKAGE_NAME,
      version: MANAGED_CODEX_VERSION,
    });
    await fs.writeFile(path.join(externalPackageRoot, 'bin', 'codex.js'), '// external launcher\n');
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.args[0] === '/fixture/pnpm.cjs') {
        const linkedPackageRoot = path.join(invocation.cwd!, 'node_modules', '@openai', 'codex');
        await fs.ensureDir(path.dirname(linkedPackageRoot));
        await fs.symlink(
          externalPackageRoot,
          linkedPackageRoot,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        return result();
      }
      await fs.writeFile(sentinel, 'executed');
      return result(`codex-cli ${MANAGED_CODEX_VERSION}`);
    };

    await expect(resolveCodexManager({
      env: { ...isolation.env, PATH: '' },
      runner,
      authorizer: () => true,
      pnpmEntry: '/fixture/pnpm.cjs',
    })).rejects.toMatchObject({ code: 'managedCodexUnavailable' });
    expect(await fs.pathExists(sentinel)).toBe(false);
    expect(await fs.pathExists(path.join(externalPackageRoot, 'package.json'))).toBe(true);
  });

  it('rebuilds a damaged AW-owned runtime only after authorization and keeps it until self-check passes', async () => {
    await writeRuntime(isolation, { version: '0.149.0', sentinel: true });
    const authorizer = vi.fn(() => true);
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.command === 'codex') throw missingExecutable();
      if (invocation.args[0] === '/fixture/pnpm.cjs') {
        const packageRoot = path.join(invocation.cwd!, 'node_modules', '@openai', 'codex');
        await fs.ensureDir(path.join(packageRoot, 'bin'));
        await fs.writeJson(path.join(packageRoot, 'package.json'), {
          name: MANAGED_CODEX_PACKAGE_NAME,
          version: MANAGED_CODEX_VERSION,
        });
        await fs.writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// new launcher\n');
        return result();
      }
      expect(await fs.pathExists(path.join(runtimeRoot(isolation), 'old-runtime'))).toBe(true);
      return invocation.args.at(-1) === '--version'
        ? result(`codex-cli ${MANAGED_CODEX_VERSION}`)
        : result('plugin help');
    };

    await expect(resolveCodexManager({
      env: isolation.env,
      runner,
      authorizer,
      pnpmEntry: '/fixture/pnpm.cjs',
    })).resolves.toMatchObject({ kind: 'aw-managed' });
    expect(authorizer).toHaveBeenCalledTimes(1);
    expect(await fs.pathExists(path.join(runtimeRoot(isolation), 'old-runtime'))).toBe(false);
  });

  it('preserves a damaged AW-owned runtime when the replacement self-check fails', async () => {
    await writeRuntime(isolation, { version: '0.149.0', sentinel: true });
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.command === 'codex') throw missingExecutable();
      if (invocation.args[0] === '/fixture/pnpm.cjs') {
        const packageRoot = path.join(invocation.cwd!, 'node_modules', '@openai', 'codex');
        await fs.ensureDir(path.join(packageRoot, 'bin'));
        await fs.writeJson(path.join(packageRoot, 'package.json'), {
          name: MANAGED_CODEX_PACKAGE_NAME,
          version: MANAGED_CODEX_VERSION,
        });
        await fs.writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// new launcher\n');
        return result();
      }
      return invocation.args.at(-1) === '--version'
        ? result(`codex-cli ${MANAGED_CODEX_VERSION}`)
        : result('', 'plugin help unavailable', 1);
    };

    await expect(resolveCodexManager({
      env: isolation.env,
      runner,
      authorizer: () => true,
      pnpmEntry: '/fixture/pnpm.cjs',
    })).rejects.toMatchObject({ code: 'managedCodexUnavailable' });
    expect(await fs.pathExists(path.join(runtimeRoot(isolation), 'old-runtime'))).toBe(true);
    expect(await fs.readJson(managedPackagePath(isolation))).toMatchObject({ version: '0.149.0' });
    expect((await fs.readdir(path.dirname(runtimeRoot(isolation))))
      .filter((name) => name.includes('.staging-'))).toEqual([]);
  });

  it('preserves a foreign runtime directory and does not request authorization', async () => {
    await writeRuntime(isolation, { marker: false });
    const authorizer = vi.fn(() => true);

    await expect(resolveCodexManager({
      env: isolation.env,
      runner: async (invocation) => {
        if (invocation.command === 'codex') throw missingExecutable();
        return result();
      },
      authorizer,
    })).rejects.toBeInstanceOf(CodexManagerError);
    await expect(resolveCodexManager({
      env: isolation.env,
      runner: async () => { throw missingExecutable(); },
      authorizer,
    })).rejects.toMatchObject({ code: 'managedCodexUnavailable' });
    expect(authorizer).not.toHaveBeenCalled();
    expect(await fs.pathExists(managedPackagePath(isolation))).toBe(true);
  });

  it('blocks a symlinked runtimes ancestor without writing or touching its external target', async () => {
    const externalRoot = path.join(isolation.layout.rootDir, 'external-runtimes');
    const sentinel = path.join(externalRoot, 'sentinel');
    await fs.ensureDir(externalRoot);
    await fs.writeFile(sentinel, 'foreign');
    await fs.ensureDir(isolation.layout.awHomeDir);
    await fs.symlink(externalRoot, path.join(isolation.layout.awHomeDir, 'runtimes'), 'dir');
    const authorizer = vi.fn(() => true);
    const runner: NativeCliRunner = async () => { throw missingExecutable(); };

    await expect(previewCodexManager({ env: isolation.env, runner })).resolves.toMatchObject({
      state: 'blocked',
      code: 'managedCodexUnavailable',
    });
    await expect(resolveCodexManager({
      env: isolation.env,
      runner,
      authorizer,
    })).rejects.toMatchObject({ code: 'managedCodexUnavailable' });
    expect(authorizer).not.toHaveBeenCalled();
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('foreign');
    expect(await fs.pathExists(path.join(externalRoot, 'codex'))).toBe(false);
  });

  it('rejects a symlinked managed pnpm store before starting installation', async () => {
    const externalStore = path.join(isolation.layout.rootDir, 'external-store');
    const sentinel = path.join(externalStore, 'sentinel');
    await fs.ensureDir(externalStore);
    await fs.writeFile(sentinel, 'foreign');
    const runtimesRoot = path.join(isolation.layout.awHomeDir, 'runtimes');
    await fs.ensureDir(runtimesRoot);
    await fs.symlink(externalStore, path.join(runtimesRoot, '.pnpm-store'), 'dir');
    const authorizer = vi.fn(() => true);
    const invocations: NativeCliInvocation[] = [];

    await expect(resolveCodexManager({
      env: isolation.env,
      runner: async (invocation) => {
        invocations.push(invocation);
        throw missingExecutable();
      },
      authorizer,
      pnpmEntry: '/fixture/pnpm.cjs',
    })).rejects.toMatchObject({ code: 'managedCodexUnavailable' });
    expect(authorizer).toHaveBeenCalledTimes(1);
    expect(invocations).toHaveLength(0);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('foreign');
  });
});

function managedPackagePath(isolation: IsolatedTestEnvironment): string {
  return path.join(runtimeRoot(isolation), 'node_modules', '@openai', 'codex', 'package.json');
}
