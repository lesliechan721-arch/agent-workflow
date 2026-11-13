import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectSystemCodex, resolveCodexManager } from '../../src/utils/codex-manager.js';
import { getCodexOperationRequirement } from '../../src/utils/agent-version.js';
import { setCodexDiscoveryOverridesForTests } from '../../src/utils/codex-executable-discovery.js';
import { discoverPlatform, installationInvocation } from '../../src/platforms/discovery.js';
import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import { NativeCliError, type NativeCliInvocation, type NativeCliRunner } from '../../src/utils/native-cli.js';
import {
  createIsolatedTestEnv,
  type IsolatedTestEnvironment,
} from '../helpers/test-isolation.js';

describe('Codex executable discovery', () => {
  let isolation: IsolatedTestEnvironment;

  beforeEach(async () => {
    isolation = await createIsolatedTestEnv();
    isolation.env.PATH = '';
    isolation.env.SystemRoot = path.join(isolation.layout.rootDir, 'windows');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [], queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }) });
    await isolation.cleanup();
  });

  // Test Value Gate: a stale first PATH entry must not hide a newer usable CLI.
  it('selects the highest CLI version across PATH directories', async () => {
    const commands = await Promise.all(['first', 'second'].map(async (directory) => {
      const command = path.join(isolation.layout.fixtureCwd, directory, 'codex');
      await fs.outputFile(command, 'fixture');
      await fs.chmod(command, 0o755);
      return fs.realpath(command);
    }));
    const runner = vi.fn<NativeCliRunner>(async (invocation) => ({
      exitCode: 0,
      stdout: `codex-cli ${invocation.command === commands[0] ? '0.154.0' : '0.157.0'}`,
      stderr: '',
    }));

    await expect(resolveCodexManager({
      platform: 'linux',
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'first:second' },
      runner,
    })).resolves.toMatchObject({ command: commands[1], version: '0.157.0' });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  async function executable(relative: string): Promise<string> {
    const target = path.join(isolation.layout.fixtureCwd, relative);
    await fs.outputFile(target, 'fixture');
    await fs.chmod(target, 0o755);
    return fs.realpath(target);
  }

  describe.runIf(process.platform !== 'win32')('POSIX npm launcher identity', () => {
    async function npmLauncher(name = 'npm'): Promise<{ launcher: string; metadata: string; env: NodeJS.ProcessEnv }> {
      const packageRoot = path.join(isolation.layout.fixtureCwd, name, 'node_modules', '@openai', 'codex');
      const launcher = await executable(path.relative(isolation.layout.fixtureCwd, path.join(packageRoot, 'bin', 'codex.js')));
      const metadata = path.join(packageRoot, 'package.json');
      await fs.outputJson(metadata, { name: '@openai/codex', version: '0.200.0', bin: { codex: 'bin/codex.js' } });
      const binRoot = path.join(isolation.layout.fixtureCwd, `${name}-bin`);
      await fs.ensureDir(binRoot);
      await fs.symlink(launcher, path.join(binRoot, 'codex'));
      return { launcher, metadata, env: { ...isolation.env, PATH: binRoot } };
    }

    // Test Value Gate: one verified npm entry must reuse list evidence across planner and adapter reads.
    it('keeps one manager identity and preserves explicit fresh observation boundaries', async () => {
      const fixture = await npmLauncher();
      const runner = vi.fn<NativeCliRunner>(async (invocation) => ({ exitCode: 0,
        stdout: invocation.args.at(-1) === '--version' ? 'codex-cli 0.200.0' : JSON.stringify({ installed: [], available: [] }),
        stderr: '' }));
      const ctx = { platform: 'linux' as const, cwd: isolation.layout.fixtureCwd, env: fixture.env, runner };
      const manager = await resolveCodexManager(ctx);
      expect(manager).toEqual({ kind: 'system', command: process.execPath, argsPrefix: [fixture.launcher], version: '0.200.0' });
      const discovery = await discoverPlatform('codex', ctx);
      const product = discovery.installations[0]!;
      expect(product).toMatchObject({ availability: 'available', entry: { executable: fixture.launcher } });
      const invocation = await installationInvocation(product, ctx, []);
      const session = await createCodexNativeObservationSession({ exactCwd: ctx.cwd, env: ctx.env, runner, manager });
      try {
        await session.inspectPlugin({ pluginId: 'demo@aw', scope: 'user' });
        session.setManager({ ...manager, command: invocation.command, argsPrefix: invocation.args });
        await session.inspectPlugin({ pluginId: 'demo@aw', scope: 'user' });
        expect(runner.mock.calls.filter(([request]) => request.args.includes('list'))).toHaveLength(1);
        session.invalidate('aw');
        await session.inspectPlugin({ pluginId: 'demo@aw', scope: 'user' });
        expect(runner.mock.calls.filter(([request]) => request.args.includes('list'))).toHaveLength(2);
        expect(runner.mock.calls.filter(([request]) => request.args.at(-1) === '--version')).toHaveLength(2);
      } finally { await session.dispose(); }
    });

    it('keeps separate product identities for two verified npm launchers using the same Node', async () => {
      const first = await npmLauncher('first');
      const second = await npmLauncher('second');
      const runner = vi.fn<NativeCliRunner>(async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }));
      const discovery = await discoverPlatform('codex', { platform: 'linux', cwd: isolation.layout.fixtureCwd,
        env: { ...isolation.env, PATH: `${first.env.PATH}:${second.env.PATH}` }, runner });
      expect(discovery.installations.map((product) => product.entry?.kind === 'cli' ? product.entry.executable : null))
        .toEqual([first.launcher, second.launcher]);
      expect(new Set(discovery.installations.map((product) => product.id)).size).toBe(2);
      expect(runner.mock.calls.map(([request]) => ({ command: request.command, args: request.args }))).toEqual([
        { command: process.execPath, args: [first.launcher, '--version'] },
        { command: process.execPath, args: [second.launcher, '--version'] },
      ]);
    });

    // Test Value Gate: a .js suffix or unverified metadata cannot select a different interpreter.
    it.each(['missing metadata', 'foreign package', 'different bin', 'linked metadata', 'custom script'] as const)(
      'keeps the original direct entry for %s', async (failure) => {
        const fixture = await npmLauncher();
        if (failure === 'missing metadata') await fs.remove(fixture.metadata);
        if (failure === 'foreign package' || failure === 'different bin') await fs.writeJson(fixture.metadata, {
          name: failure === 'foreign package' ? '@foreign/codex' : '@openai/codex', version: '0.200.0',
          bin: { codex: failure === 'different bin' ? 'bin/custom.js' : 'bin/codex.js' },
        });
        if (failure === 'linked metadata') {
          const external = path.join(isolation.layout.fixtureCwd, 'external-package.json');
          await fs.copyFile(fixture.metadata, external);
          await fs.remove(fixture.metadata);
          await fs.symlink(external, fixture.metadata);
        }
        if (failure === 'custom script') {
          const custom = await executable('custom.js');
          await fs.remove(path.join(fixture.env.PATH!, 'codex'));
          await fs.symlink(custom, path.join(fixture.env.PATH!, 'codex'));
          fixture.launcher = custom;
        }
        const runner = vi.fn<NativeCliRunner>(async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }));
        await expect(resolveCodexManager({ platform: 'linux', cwd: isolation.layout.fixtureCwd, env: fixture.env, runner }))
          .resolves.toEqual({ kind: 'system', command: fixture.launcher, argsPrefix: [], version: '0.200.0' });
        expect(runner).toHaveBeenCalledTimes(1);
        expect(runner.mock.calls[0]![0]).toMatchObject({ command: fixture.launcher, args: ['--version'] });
      },
    );

    it('excludes a verified npm launcher when its reported version differs from its metadata', async () => {
      const fixture = await npmLauncher();
      const runner = vi.fn<NativeCliRunner>(async () => ({ exitCode: 0, stdout: 'codex-cli 0.201.0', stderr: '' }));
      await expect(inspectSystemCodex({ platform: 'linux', cwd: isolation.layout.fixtureCwd, env: fixture.env,
        operationRequirement: getCodexOperationRequirement('project'), runner }))
        .resolves.toMatchObject({ state: 'unresolved', diagnostics: [expect.stringContaining('package version')] });
      expect(runner.mock.calls[0]![0]).toMatchObject({ command: process.execPath, args: [fixture.launcher, '--version'] });
    });
  });

  async function macApp(name = 'Codex.app', directory = 'Applications'): Promise<{ command: string; directory: string }> {
    const root = path.join(isolation.layout.fixtureCwd, directory);
    await fs.outputFile(path.join(root, name, 'Contents', 'Info.plist'), 'controlled plist query');
    return { command: await executable(path.join(directory, name, 'Contents', 'Resources', 'codex')), directory: root };
  }

  function versionRunner(versions: Map<string, string>): NativeCliRunner {
    return async (invocation) => ({ exitCode: 0, stdout: `codex-cli ${versions.get(invocation.command) ?? 'invalid'}`, stderr: '' });
  }

  const requirement = getCodexOperationRequirement('project');

  // Test Value Gate: PATH and App candidates share one SemVer selection and stable tie rule.
  it.each([
    ['0.155.0', '0.157.0', 'app'],
    ['0.157.0', '0.156.0', 'system'],
    ['0.157.0', '0.157.0', 'system'],
    ['0.157.0-rc.2', '0.157.0-rc.10', 'app'],
    ['0.157.0', '0.157.0-rc.10', 'system'],
  ] as const)('merges PATH %s and App %s and selects %s', async (pathVersion, appVersion, kind) => {
    const pathCommand = await executable('bin/codex');
    const app = await macApp();
    const runner = vi.fn(versionRunner(new Map([[pathCommand, pathVersion], [app.command, appVersion]])));
    await expect(resolveCodexManager({
      platform: 'darwin', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'bin' }, macApplicationsDirectories: [app.directory],
      queryRunner: async () => ({ exitCode: 0, stdout: 'com.openai.codex', stderr: '' }), runner,
    })).resolves.toMatchObject({ kind, command: kind === 'app' ? app.command : pathCommand });
    expect(runner.mock.calls.map(([invocation]) => invocation.command)).toEqual([pathCommand, app.command]);
  });

  it('uses PATH discovery order to break equal SemVer precedence', async () => {
    const first = await executable('first/codex');
    const second = await executable('second/codex');
    await expect(resolveCodexManager({
      platform: 'linux', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'first:second' },
      runner: versionRunner(new Map([[first, '0.157.0+first'], [second, '0.157.0+second']])),
    })).resolves.toMatchObject({ command: first, version: '0.157.0+first' });
  });

  it.runIf(process.platform !== 'win32')('probes a shared real PATH/App executable only once', async () => {
    const app = await macApp();
    const shim = path.join(isolation.layout.fixtureCwd, 'bin', 'codex');
    await fs.ensureDir(path.dirname(shim));
    await fs.symlink(app.command, shim);
    const runner = vi.fn(versionRunner(new Map([[app.command, '0.157.0']])));
    await expect(resolveCodexManager({
      platform: 'darwin', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'bin:bin' }, macApplicationsDirectories: [app.directory],
      queryRunner: async () => ({ exitCode: 0, stdout: 'com.openai.codex', stderr: '' }), runner,
    })).resolves.toMatchObject({ kind: 'system', command: app.command });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not query App sources on Linux', async () => {
    const app = await macApp();
    const queryRunner = vi.fn<NativeCliRunner>(async () => { throw new Error('must not query'); });
    const runner = vi.fn<NativeCliRunner>();
    await expect(inspectSystemCodex({
      platform: 'linux', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      macApplicationsDirectories: [app.directory], operationRequirement: requirement, queryRunner, runner,
    })).resolves.toMatchObject({ state: 'missing' });
    expect(queryRunner).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('isolates App sources through external boundaries and permits an explicit fixture', async () => {
    const app = await macApp('ChatGPT.app');
    const blockedQuery = vi.fn<NativeCliRunner>(async () => { throw new Error('must not query'); });
    const runner = vi.fn(versionRunner(new Map([[app.command, '0.157.0']])));
    setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [], queryRunner: blockedQuery });
    const options = {
      platform: 'darwin' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      operationRequirement: requirement, runner,
    };
    await expect(inspectSystemCodex(options)).resolves.toMatchObject({ state: 'missing' });
    expect(blockedQuery).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    await expect(inspectSystemCodex({
      ...options, macApplicationsDirectories: [app.directory],
      queryRunner: async () => ({ exitCode: 0, stdout: 'com.openai.codex', stderr: '' }),
    })).resolves.toMatchObject({ state: 'compatible', manager: { command: app.command, kind: 'app' } });
  });

  it('checks bundle identity instead of trusting the App name', async () => {
    const app = await macApp();
    const runner = vi.fn<NativeCliRunner>();
    await expect(inspectSystemCodex({
      platform: 'darwin', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      macApplicationsDirectories: [app.directory], operationRequirement: requirement,
      queryRunner: async () => ({ exitCode: 0, stdout: 'com.openai.chat', stderr: '' }), runner,
    })).resolves.toMatchObject({ state: 'missing' });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'executable'] as const)('excludes a macOS bundle with escaping %s', async (part) => {
    const app = await macApp();
    const target = part === 'metadata'
      ? path.join(app.directory, 'Codex.app', 'Contents', 'Info.plist') : app.command;
    const external = await executable('outside-bundle');
    await fs.remove(target);
    await fs.symlink(external, target, 'file');
    const runner = vi.fn<NativeCliRunner>();
    await expect(inspectSystemCodex({
      platform: 'darwin', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      macApplicationsDirectories: [app.directory], operationRequirement: requirement,
      queryRunner: async () => ({ exitCode: 0, stdout: 'com.openai.codex', stderr: '' }), runner,
    })).resolves.toMatchObject({ state: 'unresolved', diagnostics: [expect.any(String)] });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['launcher', 'version', 'query'] as const)('keeps healthy candidates after a local %s failure with safe diagnostics', async (failure) => {
    const pathCommand = await executable('bin/codex');
    const app = await macApp();
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.command === pathCommand && failure === 'launcher') throw new Error('secret launch error');
      return { exitCode: 0, stdout: invocation.command === pathCommand && failure === 'version'
        ? 'secret invalid version' : `codex-cli ${invocation.command === app.command ? '0.157.0' : '0.155.0'}`, stderr: '' };
    };
    const inspection = await inspectSystemCodex({
      platform: 'darwin', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'bin' }, macApplicationsDirectories: [app.directory],
      operationRequirement: requirement, runner,
      queryRunner: async () => {
        if (failure === 'query') throw new Error('secret query error');
        return { exitCode: 0, stdout: 'com.openai.codex', stderr: '' };
      },
    });
    expect(inspection).toMatchObject({
      state: 'compatible', manager: { command: failure === 'query' ? pathCommand : app.command },
      diagnostics: [expect.any(String)],
    });
    expect(JSON.stringify(inspection)).not.toContain('secret');
  });

  // Test Value Gate: OS query cancellation and unconfirmed cleanup must retain identity and safe public messages.
  it.each(['aborted', 'cleanup', 'renamed abort', 'renamed cleanup'] as const)('propagates an App query %s failure before probing healthy PATH candidates', async (failure) => {
    await executable('bin/codex');
    const app = await macApp();
    await macApp('ChatGPT.app');
    const command = path.join(isolation.layout.fixtureCwd, 'private-command', 'plutil');
    const cleanupError = failure.includes('cleanup') ? new Error('private-cleanup') : undefined;
    const error = new NativeCliError({
      invocation: { command, args: [] },
      exitCode: 1, stdout: 'private-stdout', stderr: 'private-stderr', reason: failure === 'aborted' ? 'aborted' : 'timeout',
      cleanupError,
    });
    if (failure.startsWith('renamed')) error.name = 'AbortError';
    const queryRunner = vi.fn<NativeCliRunner>(async () => { throw error; });
    const runner = vi.fn<NativeCliRunner>();
    await expect(resolveCodexManager({
      platform: 'darwin', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'bin' }, macApplicationsDirectories: [app.directory],
      queryRunner, runner,
    })).rejects.toBe(error);
    expect(runner).not.toHaveBeenCalled();
    expect(queryRunner).toHaveBeenCalledTimes(1);
    expect(error.message).not.toContain(command);
    expect(error.message).not.toContain('private-');
    expect(error.message).toContain(failure === 'aborted' ? 'nativeCliFailed' : 'nativeCliTimedOut');
    expect(error.reason).toBe(failure === 'aborted' ? 'aborted' : 'timeout');
    expect(error.cleanupError).toBe(cleanupError);
  });

  function registered(root: string, architecture = 'X64', family = 'OpenAI.Codex_fixture') {
    return { root, architecture, family, version: '999.0.0.0' };
  }

  function windowsQuery(packages: unknown[], unsafePaths: string[] = []): NativeCliRunner {
    return async (invocation: NativeCliInvocation) => {
      const target = invocation.env?.AW_CODEX_DISCOVERY_PATH;
      if (target && unsafePaths.includes(target)) throw new Error('secret reparse rejection');
      return { exitCode: 0, stdout: target ? 'true' : JSON.stringify(packages), stderr: '' };
    };
  }

  it('compares every registered Windows App CLI after architecture filtering', async () => {
    const pathCommand = await executable('path/codex.EXE');
    const first = await executable('a-app/codex.exe');
    const nested = await executable('a-app/resources/codex.exe');
    const neutral = await executable('b-app/codex.exe');
    const foreign = await executable('foreign/codex.exe');
    const arm = await executable('arm-app/codex.exe');
    const appRoot = (name: string) => path.join(isolation.layout.fixtureCwd, name);
    const versions = new Map([
      [pathCommand, '0.155.0'], [first, '0.156.0'], [nested, '0.158.0'],
      [neutral, '0.157.0'], [foreign, '0.999.0'], [arm, '0.999.0'],
    ]);
    const runner = vi.fn(versionRunner(versions));
    await expect(resolveCodexManager({
      platform: 'win32', arch: 'x64', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'path', PATHEXT: '.EXE' }, runner,
      queryRunner: windowsQuery([
        registered(appRoot('b-app'), 'Neutral'), registered(appRoot('arm-app'), 'Arm64'),
        registered(appRoot('foreign'), 'X64', 'Foreign.App_fixture'), registered(appRoot('a-app')),
      ]),
    })).resolves.toMatchObject({ kind: 'app', command: nested, version: '0.158.0' });
    expect(runner.mock.calls.map(([invocation]) => invocation.command)).toEqual([pathCommand, first, nested, neutral]);
  });

  it('sorts registered Windows packages before equal-version selection', async () => {
    const first = await executable('a-app/codex.exe');
    const second = await executable('z-app/codex.exe');
    const runner = versionRunner(new Map([[first, '0.157.0'], [second, '0.157.0']]));
    const packages = [registered(path.dirname(second)), registered(path.dirname(first))];
    const options = {
      platform: 'win32' as const, arch: 'x64' as const, cwd: isolation.layout.fixtureCwd,
      env: isolation.env, runner,
    };
    await expect(resolveCodexManager({ ...options, queryRunner: windowsQuery(packages) }))
      .resolves.toMatchObject({ command: first });
    await expect(resolveCodexManager({ ...options, queryRunner: windowsQuery(packages.reverse()) }))
      .resolves.toMatchObject({ command: first });
  });

  it.each(['root reparse', 'candidate reparse', 'link escape', 'depth limit'] as const)(
    'excludes unsafe Windows discovery while keeping a healthy package: %s', async (failure) => {
      const healthy = await executable('healthy/codex.exe');
      const unsafeRoot = path.join(isolation.layout.fixtureCwd, 'unsafe');
      let unsafe = await executable('unsafe/codex.exe');
      if (failure === 'link escape') {
        const external = await executable('external/codex.exe');
        await fs.remove(unsafe);
        await fs.symlink(external, unsafe, 'file');
      }
      if (failure === 'depth limit') {
        await fs.remove(unsafe);
        unsafe = await executable(path.join('unsafe', ...Array.from({ length: 17 }, (_, index) => `d${index}`), 'codex.exe'));
      }
      const unsafePaths = failure === 'root reparse' ? [unsafeRoot] : failure === 'candidate reparse' ? [unsafe] : [];
      const runner = vi.fn(versionRunner(new Map([[healthy, '0.155.0'], [unsafe, '0.999.0']])));
      const inspection = await inspectSystemCodex({
        platform: 'win32', arch: 'x64', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        operationRequirement: requirement, runner,
        queryRunner: windowsQuery([registered(unsafeRoot), registered(path.dirname(healthy))], unsafePaths),
      });
      expect(inspection).toMatchObject({ state: 'compatible', manager: { command: healthy }, diagnostics: [expect.any(String)] });
      expect(runner.mock.calls.map(([invocation]) => invocation.command)).toEqual([healthy]);
      expect(JSON.stringify(inspection)).not.toContain('secret');
    },
  );

  // Test Value Gate: oversized external directory listings must not execute entries past the scan bound.
  it('stops Windows App discovery after 50000 entries and keeps a healthy PATH CLI', async () => {
    const pathCommand = await executable('bin/codex.EXE');
    const appCommand = await executable('app/codex.exe');
    const ignored = await executable('app/ignored');
    const root = path.dirname(appCommand);
    const listing = await fs.readdir(root, { withFileTypes: true });
    const ignoredEntry = listing.find((entry) => entry.name === 'ignored')!;
    const excludedEntry = listing.find((entry) => entry.name === 'codex.exe')!;
    const stats = await fs.lstat(ignored);
    const lstat = fs.lstat;
    const realpath = fs.realpath;
    const virtualEntry = (target: string): boolean => path.dirname(target) === root
      && /^a[0-9]+$/u.test(path.basename(target));
    vi.spyOn(fs, 'readdir').mockResolvedValue([
      ...Array.from({ length: 50_000 }, (_, index) => ({ ...ignoredEntry, name: `a${index}` })), excludedEntry,
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0]) =>
      virtualEntry(String(target)) ? stats : lstat(target)) as typeof fs.lstat);
    vi.spyOn(fs, 'realpath').mockImplementation((async (target: Parameters<typeof fs.realpath>[0]) =>
      virtualEntry(String(target)) ? String(target) : realpath(target)) as typeof fs.realpath);
    const runner = vi.fn(versionRunner(new Map([[pathCommand, '0.155.0'], [appCommand, '0.999.0']])));
    await expect(inspectSystemCodex({
      platform: 'win32', arch: 'x64', cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: 'bin', PATHEXT: '.EXE' },
      operationRequirement: requirement, runner, queryRunner: windowsQuery([registered(root)]),
    })).resolves.toMatchObject({ state: 'compatible', manager: { command: pathCommand }, diagnostics: [expect.any(String)] });
    expect(runner.mock.calls.map(([invocation]) => invocation.command)).toEqual([pathCommand]);
  });

  it.each([
    { entries: [['Path', 'legacy'], ['Pathext', '.BAT'], ['PATH', 'selected'], ['PATHEXT', '.EXE;.CMD']], directory: 'selected', extension: '.EXE' },
    { entries: [['PATH', 'selected'], ['PATHEXT', '.CMD;.EXE'], ['Path', 'legacy']], directory: 'selected', extension: '.EXE' },
    { entries: [['Path', 'legacy'], ['PATH', ''], ['PATHEXT', '.EXE']], directory: '', extension: '.EXE' },
    { entries: [['PATH', 'selected'], ['PATHEXT', '']], directory: 'selected', extension: '' },
  ])('uses child Windows environment key and extension precedence: $entries', async ({ entries, directory, extension }) => {
    for (const prefix of ['', 'legacy', 'selected']) {
      await executable(path.join(prefix, 'codex.EXE'));
      await executable(path.join(prefix, 'codex'));
      await executable(path.join(prefix, 'codex.CMD'));
    }
    const env = Object.fromEntries(Object.entries(isolation.env).filter(([key]) => !['PATH', 'PATHEXT'].includes(key.toUpperCase())));
    const runner = vi.fn<NativeCliRunner>(async () => ({ exitCode: 0, stdout: 'codex-cli 0.155.0', stderr: '' }));
    const command = await fs.realpath(path.join(isolation.layout.fixtureCwd, directory, `codex${extension}`));
    await expect(resolveCodexManager({
      platform: 'win32', arch: 'x64', cwd: isolation.layout.fixtureCwd,
      env: { ...env, ...Object.fromEntries(entries) }, runner, queryRunner: windowsQuery([]),
    })).resolves.toMatchObject({ command });
    expect(runner.mock.calls.map(([invocation]) => invocation.command)).toEqual([command]);
  });

});
