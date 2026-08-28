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
} from '../../src/utils/codex-manager.js';
import type {
  NativeCliInvocation,
  NativeCliResult,
  NativeCliRunner,
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

describe('Codex manager resolver', () => {
  let isolation: IsolatedTestEnvironment;

  beforeEach(async () => {
    isolation = await createIsolatedTestEnv();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await isolation.cleanup();
  });

  it('selects a supported system Codex and does not inspect or authorize managed state', async () => {
    const authorizer = vi.fn(() => true);
    const runner: NativeCliRunner = async (invocation) => {
      expect(invocation.command).toBe('codex');
      return result('codex-cli 0.151.0');
    };

    await expect(resolveCodexManager({
      env: isolation.env,
      cwd: isolation.layout.fixtureCwd,
      runner,
      authorizer,
    })).resolves.toEqual({
      kind: 'system',
      version: '0.151.0',
      command: 'codex',
      argsPrefix: [],
    });
    expect(authorizer).not.toHaveBeenCalled();
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
  });

  it.each([
    ['too old', result('codex-cli 0.1.0')],
    ['unparseable', result('Codex development build')],
    ['probe failure', result('', 'probe failed', 2)],
  ])('blocks an unsupported system Codex (%s) without managed fallback', async (_label, probeResult) => {
    const authorizer = vi.fn(() => true);
    await expect(resolveCodexManager({
      env: isolation.env,
      runner: async () => probeResult,
      authorizer,
    })).rejects.toMatchObject({ code: 'codexSystemCliUnsupported' });
    expect(authorizer).not.toHaveBeenCalled();
  });

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
    expect(manager).toEqual({
      kind: 'aw-managed',
      version: MANAGED_CODEX_VERSION,
      command: process.execPath,
      argsPrefix: [path.join(runtimeRoot(isolation), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')],
      runtimeRoot: runtimeRoot(isolation),
    });
    expect(calls.filter((call) => call.command === 'codex')).toHaveLength(2);
    expect(authorizer).not.toHaveBeenCalled();
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
    expect(invocations).toHaveLength(1);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('foreign');
  });
});

function managedPackagePath(isolation: IsolatedTestEnvironment): string {
  return path.join(runtimeRoot(isolation), 'node_modules', '@openai', 'codex', 'package.json');
}
