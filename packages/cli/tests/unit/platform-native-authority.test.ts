import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { deploymentPackageComponent, inspectDeployment } from '../../src/platforms/inspection.js';
import { geminiExtensionPaths, geminiScopePattern } from '../../src/platforms/gemini-activation.js';
import { readPlatformPackageContentDigest } from '../../src/utils/platform-empty-state.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { NativeCliError, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../../src/constants.js';
import { createNativeQuerySession, queryNativeDeploymentResult } from '../../src/platforms/inspection-query.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
import type { ReadContext, ScopeRef } from '../../src/platforms/contracts.js';

const platforms = ['codex', 'claude', 'gemini', 'copilot'] as const;
type Platform = typeof platforms[number];

async function fixture(platform: Platform, project = true) {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = isolated.layout.fixtureCwd;
  const ctx: ReadContext = { cwd, env: isolated.env };
  const scope: ScopeRef = project ? { kind: 'project', projectRoot: cwd } : { kind: 'user' };
  const host = resolvePlatformConfigRoot(platform, ctx);
  const resolved = await resolveDeployments(ctx, { plugin: { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`,
    pluginId: 'team/example', version: '1.0.0' }, operation: 'ensure', scope, recoveryCandidates: [], discovery: {
    platform, availability: 'available', diagnostics: [], installations: [{ id: 'client', product: 'cli', availability: 'available',
      version: { codex: '0.167.0', claude: '2.1.317', gemini: '0.67.0', copilot: '1.0.95' }[platform], reasonCodes: [],
      entry: { kind: 'cli', executable: path.join(cwd, platform), configRoot: host } }],
  } });
  const binding = resolved.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  const id = layout.nativeIdentity.registrationId ?? layout.nativeIdentity.packageId;
  const calls: NativeCliInvocation[] = [];
  const native = { enabled: true, installed: true, fail: false, marketplaceFail: false,
    marketplace: 'canonical' as 'canonical' | 'foreign' | 'absent', folder: true,
    claudeScope: 'user' as 'user' | 'managed' | 'project' | 'local', claudeProjectPath: cwd };
  ctx.runner = async (request) => {
    calls.push(request);
    const command = request.args.slice(request.command === process.execPath ? 1 : 0).join(' ');
    if (command !== `plugin list --marketplace ${layout.marketplaceName} --json`
      && !['plugin list --json', 'plugin marketplace list --json', 'extensions list --output-format json'].includes(command)) {
      throw new Error('Unexpected native query.');
    }
    if (native.fail || native.marketplaceFail && request.args.includes('marketplace')) {
      return { exitCode: 1, stdout: '', stderr: 'Native query failed.' };
    }
    let value: unknown;
    if (request.args.includes('marketplace')) {
      const root = native.marketplace === 'foreign' ? path.join(cwd, 'foreign-marketplace') : layout.marketplaceRoot;
      value = native.marketplace === 'absent' ? [] : [{ name: layout.marketplaceName,
        source: platform === 'claude' ? 'directory' : root, path: root, installLocation: root }];
    }
    else if (platform === 'codex') value = { installed: native.installed ? [{ pluginId: id, installed: true, enabled: native.enabled }] : [], available: [] };
    else if (platform === 'claude') value = native.installed ? [{ id, scope: native.claudeScope, enabled: native.enabled,
      ...(['local', 'project'].includes(native.claudeScope) ? { projectPath: native.claudeProjectPath } : {}),
      version: '1.0.0', installPath: path.join(host, 'cache', 'example'), ...(native.folder ? { readFromFolder: layout.packageRoot } : {}) }] : [];
    else if (platform === 'gemini') value = native.installed ? [{ name: id, isActive: native.enabled,
      path: path.join(geminiExtensionPaths(ctx).root, id), installMetadata: { type: 'local', source: layout.packageRoot } }] : [];
    else value = native.installed ? [{ name: layout.nativeIdentity.packageId, marketplace: layout.marketplaceName, enabled: native.enabled }] : [];
    return platform === 'gemini'
      ? { exitCode: 0, stdout: '', stderr: `${JSON.stringify(value)}\n` }
      : { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  const settings = platform === 'codex' ? path.join(layout.activationPath, 'config.toml')
    : platform === 'gemini' ? geminiExtensionPaths(ctx).file
      : path.join(layout.activationPath, project ? 'settings.local.json' : 'settings.json');
  async function configure(enabled: boolean) {
    if (platform === 'codex') await fs.outputFile(settings, `[plugins.${JSON.stringify(id)}]\nenabled = ${enabled}\n`);
    else if (platform === 'gemini') await fs.outputJson(settings, { [id]: { overrides: project
      ? ['!*', `${enabled ? '' : '!'}${geminiScopePattern(cwd)}`] : [enabled ? '*' : '!*'] } });
    else await fs.outputJson(settings, { enabledPlugins: { [id]: enabled } });
  }
  return { ctx, binding, layout, id, host, native, calls, settings, configure };
}

async function geminiNpmFixture(project = true, bin = 'bundle/gemini.js') {
  const item = await fixture('gemini', project);
  const packageRoot = path.join(item.ctx.cwd, 'native-client/node_modules/@google/gemini-cli');
  const entry = path.join(packageRoot, bin);
  const metadata = { name: '@google/gemini-cli', version: '0.67.0', bin: { gemini: bin } };
  await fs.outputFile(entry, '#!/usr/bin/env node\n');
  await fs.outputJson(path.join(packageRoot, 'package.json'), metadata);
  item.binding.consumers[0]!.entry = { kind: 'cli', executable: entry, configRoot: item.host };
  return { ...item, packageRoot, entry, metadata };
}

async function geminiCompileFixture(project = true, bin?: string) {
  const item = await geminiNpmFixture(project, bin);
  item.ctx.platform = 'darwin';
  item.ctx.env = { ...item.ctx.env, GEMINI_CLI_NO_RELAUNCH: 'caller-value' };
  if (process.platform === 'win32') {
    // Simulate the Darwin home syntax while keeping all files in this host's isolated tree.
    item.ctx.env.HOME = `/${item.ctx.env.HOME!.replaceAll('\\', '/')}`;
    item.ctx.env.GEMINI_CLI_HOME = path.dirname(item.host);
  }
  delete item.ctx.env.NODE_COMPILE_CACHE;
  delete item.ctx.env.NODE_DISABLE_COMPILE_CACHE;
  const compileDir = path.join(item.ctx.cwd, 'session/native-node-compile-cache');
  let directoryRequests = 0;
  item.ctx.nativeNodeCompileCacheDir = async () => { directoryRequests += 1; return compileDir; };
  return { ...item, compileDir, directoryRequests: () => directoryRequests };
}

describe('native deployment state authority', () => {
  // Test Value Gate: a full client inventory serves multiple roots in the same
  // read operation; a new operation and reads outside a session remain fresh.
  it('shares Claude inventories across roots and owns the neutral query directory', async () => {
    const item = await fixture('claude', false);
    const session = createNativeQuerySession();
    const ctx = { ...item.ctx, nativeQuerySession: session };
    let cwd = '';
    try {
      const sibling = { ...item.binding, plugin: { ...item.binding.plugin, pluginId: 'team/sibling' } };
      await Promise.all([inspectDeployment(ctx, item.binding), inspectDeployment(ctx, sibling)]);
      expect(item.calls.map((call) => call.args)).toEqual(expect.arrayContaining([
        ['plugin', 'list', '--json'], ['plugin', 'marketplace', 'list', '--json'],
      ]));
      expect(item.calls).toHaveLength(2);
      cwd = item.calls[0]!.cwd!;
      expect(item.calls.every((call) => call.cwd === cwd)).toBe(true);
      expect(await fs.pathExists(cwd)).toBe(true);
    } finally { await session.dispose(); }
    expect(await fs.pathExists(cwd)).toBe(false);
    await inspectDeployment(item.ctx, item.binding);
    expect(item.calls).toHaveLength(4);
    const next = createNativeQuerySession();
    try { await inspectDeployment({ ...item.ctx, nativeQuerySession: next }, item.binding); }
    finally { await next.dispose(); }
    expect(item.calls).toHaveLength(6);
  });

  // Test Value Gate: scope, real entry, config namespace, source arguments and
  // observation mode must not reuse another native result, even within a session.
  it('separates native inventory inputs and returns independent result objects', async () => {
    const item = await fixture('claude', false);
    const session = createNativeQuerySession();
    const calls: NativeCliInvocation[] = [];
    const ctx: ReadContext = { ...item.ctx, nativeQuerySession: session, runner: async (invocation) => {
      calls.push(invocation); return { exitCode: 0, stdout: '[]', stderr: '' };
    } };
    const args = (cwd: string) => ['plugin', 'list', '--location', cwd, '--json'];
    try {
      const first = await queryNativeDeploymentResult(ctx, item.binding, args);
      first.stdout = 'changed by consumer';
      expect((await queryNativeDeploymentResult(ctx, item.binding, args)).stdout).toBe('[]');
      expect(calls).toHaveLength(1);
      await queryNativeDeploymentResult(ctx, { ...item.binding, scope: { kind: 'project', projectRoot: ctx.cwd } }, args);
      const product = item.binding.consumers[0]!;
      await queryNativeDeploymentResult(ctx, { ...item.binding, consumers: [{ ...product,
        entry: { kind: 'cli', executable: path.join(ctx.cwd, 'other-client'), configRoot: item.host } }] }, args);
      await queryNativeDeploymentResult(ctx, { ...item.binding, consumers: [{ ...product,
        entry: { kind: 'cli', executable: path.join(ctx.cwd, 'claude'), configRoot: path.join(item.host, 'other') } }] }, args);
      await queryNativeDeploymentResult(ctx, item.binding, ['plugin', 'list', '--marketplace', 'other-source', '--json']);
      await queryNativeDeploymentResult({ ...ctx, env: { ...ctx.env, CLAUDE_CONFIG_DIR: path.join(item.host, 'alternate') } }, item.binding, args);
      await queryNativeDeploymentResult({ ...ctx, observeNative: true }, item.binding, args);
      expect(calls).toHaveLength(7);
      expect(calls[0]!.cwd).not.toBe(calls[1]!.cwd);
      expect(calls[0]!.args).toEqual(['plugin', 'list', '--location', calls[0]!.cwd, '--json']);
    } finally { await session.dispose(); }
    expect((await Promise.all(calls.filter((call) => call.cwd !== ctx.cwd).map((call) => fs.pathExists(call.cwd!)))).every((present) => !present)).toBe(true);
  });

  // Test Value Gate: one failed snapshot preserves its native reason without
  // retry storms, but a new operation retries and cancellation cannot return cache.
  it('retains native failure evidence only inside its operation', async () => {
    const item = await fixture('claude');
    let calls = 0;
    const failure = new NativeCliError({ invocation: { command: 'claude', args: [] }, exitCode: 124,
      stdout: '', stderr: '', reason: 'timeout' });
    const controller = new AbortController();
    const session = createNativeQuerySession();
    const ctx: ReadContext = { ...item.ctx, signal: controller.signal, nativeQuerySession: session,
      runner: async () => { calls += 1; throw failure; } };
    const read = () => queryNativeDeploymentResult(ctx, item.binding, ['plugin', 'list', '--json']);
    try {
      for (let index = 0; index < 2; index += 1) await expect(read()).rejects.toBe(failure);
      expect(calls).toBe(1);
      const cancellation = new Error('cancelled'); controller.abort(cancellation);
      await expect(read()).rejects.toBe(cancellation);
      expect(calls).toBe(1);
    } finally { await session.dispose(); }
    await expect(queryNativeDeploymentResult({ ...ctx, nativeQuerySession: undefined, signal: undefined },
      item.binding, ['plugin', 'list', '--json'])).rejects.toBe(failure);
    expect(calls).toBe(2);
  });

  // Test Value Gate: shared code compilation must still read every native state
  // change, with exact scope, cancellation, deadline and caller env intact.
  it.each([false, true])('uses local Gemini probe overrides with fresh inventory (project=%s)', async (project) => {
    const item = await geminiCompileFixture(project);
    const originalEnv = { ...item.ctx.env };
    const originalProcessEnv = { ...process.env };
    item.ctx.signal = new AbortController().signal;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    item.native.enabled = false;
    expect((await inspectDeployment(item.ctx, item.binding)).consumers[0]?.activation).toBe('disabled');
    expect(item.calls.length).toBe(2);
    expect(item.directoryRequests()).toBe(2);
    for (const call of item.calls) {
      expect(call.command).toBe(process.execPath);
      expect(call.args).toEqual([item.entry, 'extensions', 'list', '--output-format', 'json']);
      expect(call.cwd === item.ctx.cwd).toBe(project);
      if (!project) {
        expect(call.cwd.startsWith(`${item.ctx.cwd}${path.sep}`)).toBe(false);
        expect(await fs.pathExists(call.cwd)).toBe(false);
      }
      expect(call.signal).toBe(item.ctx.signal);
      expect(call.timeoutMs).toBe(DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS);
      expect(isDeepStrictEqual(call.env, { ...originalEnv,
        GEMINI_CLI_NO_RELAUNCH: 'true', NODE_COMPILE_CACHE: item.compileDir })).toBe(true);
      expect(call.env === item.ctx.env).toBe(false);
    }
    expect(isDeepStrictEqual(item.ctx.env, originalEnv)).toBe(true);
    expect(isDeepStrictEqual({ ...process.env }, originalProcessEnv)).toBe(true);
  });

  // Test Value Gate: caller cache or disable settings, including empty values,
  // must suppress directory allocation without changing the native query.
  it.each([
    { key: 'NODE_COMPILE_CACHE', value: '' },
    { key: 'NODE_COMPILE_CACHE', value: '/caller/compile-cache' },
    { key: 'NODE_DISABLE_COMPILE_CACHE', value: '' },
    { key: 'NODE_DISABLE_COMPILE_CACHE', value: '1' },
  ])('preserves caller $key=$value on Gemini inventory', async ({ key, value }) => {
    const item = await geminiCompileFixture();
    item.ctx.env![key] = value;
    const expectedEnv = { ...item.ctx.env, GEMINI_CLI_NO_RELAUNCH: 'true' };
    expect((await inspectDeployment(item.ctx, item.binding)).registration).toBe('present');
    expect(item.directoryRequests()).toBe(0);
    expect(item.calls.length).toBe(1);
    expect(isDeepStrictEqual(item.calls[0]!.env, expectedEnv)).toBe(true);
    expect(item.ctx.env![key] === value).toBe(true);
  });

  // Test Value Gate: other host platforms retain the already verified relaunch
  // optimization and never request the Darwin compilation directory.
  it.each(['linux', 'win32'] as const)('keeps Gemini compilation hints out of %s inventory', async (platform) => {
    const item = await geminiCompileFixture();
    item.ctx.platform = platform;
    const expectedEnv = { ...item.ctx.env, GEMINI_CLI_NO_RELAUNCH: 'true' };
    item.ctx.runner = async (call) => {
      item.calls.push(call);
      return { exitCode: 0, stdout: '', stderr: '[]\n' };
    };
    const result = await queryNativeDeploymentResult(item.ctx, item.binding, ['extensions', 'list', '--output-format', 'json']);
    expect(result.exitCode).toBe(0);
    expect(item.directoryRequests()).toBe(0);
    expect(item.calls.length).toBe(1);
    expect(isDeepStrictEqual(item.calls[0]!.env, expectedEnv)).toBe(true);
  });

  // Test Value Gate: cache allocation is optional; only abort or unconfirmed
  // cleanup may stop the native observation before its command runs.
  it.each(['filesystem', 'aborted', 'cleanup', 'signal'] as const)('handles Gemini compile directory %s failures', async (failure) => {
    const item = await geminiCompileFixture(false);
    const controller = new AbortController();
    item.ctx.signal = controller.signal;
    const filesystemError = Object.assign(new Error('compile directory unavailable'), { code: 'EACCES' });
    const fatalError = new NativeCliError({ invocation: { command: process.execPath, args: [], cwd: item.ctx.cwd },
      exitCode: 1, stdout: '', stderr: '', ...(failure === 'cleanup'
        ? { cleanupError: new Error('cleanup unconfirmed') } : { reason: 'aborted' }) });
    const cancellation = new Error('query cancelled');
    let directoryRequests = 0;
    item.ctx.nativeNodeCompileCacheDir = async () => {
      directoryRequests += 1;
      if (failure === 'signal') controller.abort(cancellation);
      throw failure === 'aborted' || failure === 'cleanup' ? fatalError : filesystemError;
    };
    const pending = queryNativeDeploymentResult(item.ctx, item.binding, ['extensions', 'list', '--output-format', 'json']);
    if (failure === 'filesystem') {
      expect((await pending).exitCode).toBe(0);
      expect(item.calls.length).toBe(1);
      expect(isDeepStrictEqual(item.calls[0]!.env, { ...item.ctx.env, GEMINI_CLI_NO_RELAUNCH: 'true' })).toBe(true);
      expect(await fs.pathExists(item.calls[0]!.cwd)).toBe(false);
    } else {
      await expect(pending.catch((error: unknown) => error === (failure === 'signal' ? cancellation : fatalError))).resolves.toBe(true);
      expect(item.calls.length).toBe(0);
    }
    expect(directoryRequests).toBe(1);
  });

  // Test Value Gate: the optimization must use the verified Node entry behind
  // Windows npm shims, without executing a foreign command file.
  it('uses only the verified Gemini Windows npm entry for inventory', async () => {
    const item = await geminiNpmFixture();
    const binRoot = path.dirname(path.dirname(path.dirname(item.packageRoot)));
    const shim = path.join(binRoot, 'gemini.cmd');
    await fs.outputFile(shim, renderNpmCmdShim('node_modules\\@google\\gemini-cli\\bundle\\gemini.js'));
    item.ctx.platform = 'win32';
    item.binding.consumers[0]!.entry = { kind: 'cli', executable: shim, configRoot: item.host };
    const calls: NativeCliInvocation[] = [];
    item.ctx.runner = async (call) => {
      calls.push(call);
      return { exitCode: 0, stdout: '', stderr: '[]\n' };
    };
    await queryNativeDeploymentResult(item.ctx, item.binding, ['extensions', 'list', '--output-format', 'json']);
    expect(calls.length).toBe(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([item.entry, 'extensions', 'list', '--output-format', 'json']);
    expect(calls[0]!.env?.GEMINI_CLI_NO_RELAUNCH).toBe('true');
    await fs.outputJson(path.join(item.packageRoot, 'package.json'), { ...item.metadata, name: 'foreign-cli' });
    await expect(queryNativeDeploymentResult(item.ctx, item.binding,
      ['extensions', 'list', '--output-format', 'json'])).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  // Test Value Gate: metadata selects only a startup optimization. A mismatch
  // must still execute the original query and preserve its native bytes.
  it.each([
    'missing', 'invalid', 'foreign', 'manifest-version', 'product-version', 'bin-mismatch', 'other-entry', 'native', 'other-args',
  ] as const)('keeps the original Gemini query for %s', async (kind) => {
    const item = await geminiCompileFixture(true, kind === 'other-entry' ? 'dist/index.js' : undefined);
    const file = path.join(item.packageRoot, 'package.json');
    if (kind === 'missing') await fs.remove(file);
    else if (kind === 'invalid') await fs.writeFile(file, '{invalid');
    else {
      if (kind === 'foreign') item.metadata.name = 'foreign-cli';
      if (kind === 'manifest-version') item.metadata.version = '0.67.1';
      if (kind === 'product-version') item.binding.consumers[0]!.version = '0.67.1';
      if (kind === 'bin-mismatch') {
        item.metadata.bin.gemini = 'bundle/other.js';
        await fs.outputFile(path.join(item.packageRoot, 'bundle/other.js'), 'Different entry.');
      }
      if (kind === 'native') item.binding.consumers[0]!.entry = {
        kind: 'cli', executable: path.join(item.ctx.cwd, 'gemini'), configRoot: item.host,
      };
      await fs.outputJson(file, item.metadata);
    }
    item.ctx.env = { ...item.ctx.env, GEMINI_CLI_NO_RELAUNCH: 'caller-value' };
    const args = ['extensions', 'list', '--output-format', 'json', ...(kind === 'other-args' ? ['--help'] : [])];
    const nativeResult = { exitCode: 0, stdout: 'native stdout', stderr: 'native stderr' };
    item.ctx.runner = async (call) => {
      item.calls.push(call);
      return nativeResult;
    };
    expect(await queryNativeDeploymentResult(item.ctx, item.binding, (cwd) => {
      expect(cwd).toBe(item.ctx.cwd);
      return args;
    })).toBe(nativeResult);
    expect(item.calls.length).toBe(1);
    expect(item.calls[0]!.env === item.ctx.env).toBe(true);
    expect(item.directoryRequests()).toBe(0);
  });

  // Test Value Gate: direct bootstrap inventory cannot convert native exit,
  // timeout, abort or cleanup failures into successful JSON observations.
  it.each(['exit', 'timeout', 'cleanup', 'aborted'] as const)('retains optimized Gemini %s query failure', async (failure) => {
    const item = await geminiCompileFixture(false);
    const calls: NativeCliInvocation[] = [];
    item.ctx.runner = async (invocation) => {
      calls.push(invocation);
      if (failure === 'exit') return { exitCode: 1, stdout: '', stderr: '[]\n' };
      throw new NativeCliError({ invocation, exitCode: failure === 'timeout' ? 124 : 1, stdout: '', stderr: '[]\n',
        ...(failure === 'cleanup' ? { cleanupError: new Error('cleanup unconfirmed') } : { reason: failure }) });
    };
    await expect(queryNativeDeploymentResult(item.ctx, item.binding,
      ['extensions', 'list', '--output-format', 'json'])).rejects.toMatchObject({ name: 'NativeCliError',
      ...(failure === 'cleanup' ? { cleanupError: expect.any(Error) } : failure === 'exit' ? { exitCode: 1 } : { reason: failure }) });
    expect(calls.length).toBe(1);
    expect(calls[0]!.env?.GEMINI_CLI_NO_RELAUNCH).toBe('true');
    expect(calls[0]!.env?.NODE_COMPILE_CACHE === item.compileDir).toBe(true);
    expect(await fs.pathExists(calls[0]!.cwd)).toBe(false);
  });

  // Test Value Gate: Gemini 0.67 writes its empty inventory to stderr, not stdout.
  it('reads the Gemini empty stderr inventory as absent', async () => {
    const item = await fixture('gemini', false);
    item.native.installed = false;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('absent');
    expect(observed.diagnostics).toEqual([]);
  });

  // Test Value Gate: native disabled remains authoritative over local enablement.
  it('reads Gemini disabled activation from stderr despite local enablement', async () => {
    const item = await fixture('gemini');
    await item.configure(true);
    item.native.enabled = false;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('disabled');
    expect(observed.configuration?.activation).toBe('enabled');
  });

  // Test Value Gate: invalid or ambiguous streams cannot authorize native absence or activation.
  it.each([
    { label: 'empty streams', stdout: '', stderr: '' },
    { label: 'stdout-only JSON', stdout: '[]', stderr: '' },
    { label: 'conflicting streams', stdout: '[{"name":"demo","isActive":true,"path":"/native/demo"}]', stderr: '[]\n' },
    { label: 'invalid JSON', stdout: '', stderr: 'Warning\n[]' },
    { label: 'invalid envelope', stdout: '', stderr: '{}' },
    { label: 'invalid row', stdout: '', stderr: '[null]' },
    { label: 'missing identity', stdout: '', stderr: '[{"isActive":true,"path":"/native/demo"}]' },
    { label: 'invalid activation', stdout: '', stderr: '[{"name":"demo","isActive":"true","path":"/native/demo"}]' },
    { label: 'invalid path', stdout: '', stderr: '[{"name":"demo","isActive":true,"path":null}]' },
  ])('keeps Gemini state unknown for $label', async ({ stdout, stderr }) => {
    const item = await fixture('gemini');
    await item.configure(true);
    item.ctx.runner = async () => ({ exitCode: 0, stdout, stderr });
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('unknown');
    expect(observed.consumers[0]?.activation).toBe('unknown');
    expect(observed.configuration?.activation).toBe('enabled');
  });

  // Test Value Gate: valid inventory bytes cannot hide native exit, timeout, or cleanup failures.
  it.each(['exit', 'timeout', 'cleanup', 'aborted'] as const)('rejects Gemini %s failures with valid stderr JSON', async (failure) => {
    const item = await fixture('gemini');
    item.ctx.runner = async (invocation) => {
      if (failure === 'exit') return { exitCode: 1, stdout: '', stderr: '[]\n' };
      throw new NativeCliError({ invocation, exitCode: failure === 'timeout' ? 124 : 1, stdout: '', stderr: '[]\n',
        ...(failure === 'cleanup' ? { cleanupError: new Error('cleanup unconfirmed') } : { reason: failure }) });
    };
    const pending = inspectDeployment(item.ctx, item.binding);
    if (failure === 'cleanup' || failure === 'aborted') {
      await expect(pending).rejects.toMatchObject({ name: 'NativeCliError',
        ...(failure === 'cleanup' ? { cleanupError: expect.any(Error) } : { reason: 'aborted' }) });
    } else {
      const observed = await pending;
      expect(observed.registration).toBe('unknown');
      expect(observed.consumers[0]?.activation).toBe('unknown');
    }
  });

  // Test Value Gate: conflicting local entries must not replace native effective activation.
  it.each(platforms)('preserves %s native enabled when local activation is disabled', async (platform) => {
    const item = await fixture(platform);
    await item.configure(false);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.configuration).toMatchObject({ scope: 'project', activation: 'disabled' });
    expect(item.calls.some((call) => call.cwd === item.ctx.cwd)).toBe(true);
  });

  // Test Value Gate: inherited native activation is distinct from an independent project entry.
  it.each(platforms)('preserves %s inherited activation without a project entry', async (platform) => {
    const item = await fixture(platform);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.configuration).toMatchObject({ scope: 'project', activation: 'absent' });
  });

  // Test Value Gate: supplemental parse failures cannot erase successful native facts.
  it.each(platforms)('keeps %s native facts when local configuration is malformed', async (platform) => {
    const item = await fixture(platform);
    await fs.outputFile(item.settings, '{ invalid');
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.configuration).toMatchObject({ activation: 'unknown' });
    expect(observed.configuration?.reasonCodes.length).toBeGreaterThan(0);
  });

  // Test Value Gate: a failed native query cannot use local enablement as a fallback.
  it.each(platforms)('keeps %s native state unknown after a failed query', async (platform) => {
    const item = await fixture(platform);
    await item.configure(true);
    item.native.fail = true;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('unknown');
    expect(observed.consumers[0]?.activation).toBe('unknown');
    expect(observed.configuration).toMatchObject({ activation: 'enabled' });
    if (platform === 'claude') expect(observed.scopeRegistration).toBe('unknown');
  });

  // Test Value Gate: inherited and shared-project registrations cannot replace
  // the exact installation record needed for an independent AW scope.
  it.each([
    { scope: 'user', project: true, registered: 'absent' },
    { scope: 'local', project: true, registered: 'present' },
    { scope: 'project', project: true, registered: 'absent' },
    { scope: 'managed', project: false, registered: 'absent' },
    { scope: 'user', project: false, registered: 'present' },
  ] as const)('reports Claude $scope installation independently in project=$project', async ({ scope, project, registered }) => {
    const item = await fixture('claude', project);
    item.native.claudeScope = scope;
    await item.configure(true);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed).toMatchObject({ registration: 'present', scopeRegistration: registered });
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.consumers[0]).not.toHaveProperty('trust');
  });

  // Test Value Gate: another project's local record cannot authorize this scope.
  it('does not claim a Claude local registration from another project', async () => {
    const item = await fixture('claude');
    item.native.claudeScope = 'local';
    item.native.claudeProjectPath = path.join(item.ctx.cwd, 'other-project');
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed).toMatchObject({ registration: 'absent', scopeRegistration: 'absent' });
  });

  // Test Value Gate: User inventory must not include the caller project's merged settings.
  it.each(platforms)('runs %s User queries outside the caller project', async (platform) => {
    const item = await fixture(platform, false);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(item.calls.length).toBeGreaterThan(0);
    expect(item.calls.every((call) => call.cwd !== item.ctx.cwd && !call.cwd.startsWith(`${item.ctx.cwd}${path.sep}`))).toBe(true);
  });

  // Test Value Gate: marketplace ownership failure cannot erase the independent plugin inventory.
  it.each(['claude', 'copilot'] as const)('keeps %s native activation when marketplace lookup fails', async (platform) => {
    const item = await fixture(platform);
    item.native.marketplaceFail = true;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('unknown');
  });

  // Test Value Gate: a native identity with an absent source cannot authorize shared package removal.
  it.each(['claude', 'copilot'] as const)('keeps %s ownership unknown when the native source is absent', async (platform) => {
    const item = await fixture(platform);
    item.native.marketplace = 'absent';
    item.native.folder = false;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('unknown');
  });

  // Test Value Gate: unrecognized row source fields must retain a confirmed foreign marketplace conflict.
  it.each(['claude', 'copilot'] as const)('keeps %s foreign marketplace ownership beside native activation', async (platform) => {
    const item = await fixture(platform);
    item.native.marketplace = 'foreign';
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('foreign');
  });

  // Test Value Gate: installed native copies remain observable when their local identity is unreadable.
  it('keeps Gemini native facts when copied metadata is malformed', async () => {
    const item = await fixture('gemini');
    const root = path.join(geminiExtensionPaths(item.ctx).root, item.id);
    await fs.outputFile(path.join(root, '.gemini-extension-install.json'), '{ invalid');
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('unknown');
    expect(observed.nativePackageContentDigest).toBeUndefined();
  });

  // Test Value Gate: the actual native copy's owner and digest remain required maintenance evidence.
  it('keeps the Gemini installed copy digest beside native effective activation', async () => {
    const item = await fixture('gemini');
    await fs.outputJson(path.join(item.layout.packageRoot, 'gemini-extension.json'), { name: item.id, version: '1.0.0' });
    const digest = (await readPlatformPackageContentDigest(item.layout.packageRoot))!;
    await writeSkillOwnerMarker({ skillRoot: item.layout.packageRoot, allowedRoot: path.dirname(item.layout.packageRoot),
      identity: deploymentPackageComponent(item.binding, item.layout).identity,
      nativeProjection: { physicalIdentity: item.layout.physicalIdentity, preparation: 'complete', inputDigest: `sha256:${'b'.repeat(64)}`,
        contentDigest: digest, components: [] } });
    const root = path.join(geminiExtensionPaths(item.ctx).root, item.id);
    await fs.copy(item.layout.packageRoot, root);
    await fs.outputJson(path.join(root, '.gemini-extension-install.json'), { type: 'local', source: item.layout.packageRoot });
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed).toMatchObject({ ownership: 'aw', registration: 'present', nativePackageContentDigest: digest });
    expect(observed.consumers[0]?.activation).toBe('enabled');
  });
});
