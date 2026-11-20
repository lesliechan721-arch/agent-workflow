import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core';
import { discoverPlatforms, discoverPlatform, resolvePlatformConfigRoot, type ReadContext } from '../../src/platforms/discovery.js';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../../src/constants.js';
import { targetsList, targetsSet } from '../../src/commands/targets-command.js';
import { createEmptyPreferences, observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { projectReceipt } from '../../src/output/receipt-projection.js';
import { publicExitCode, renderPublicResult } from '../../src/output/public-result.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
import { NativeCliError } from '../../src/utils/native-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(): Promise<ReadContext> {
  const isolation = getCurrentSourceTestIsolation();
  const bin = path.join(isolation.layout.fixtureCwd, 'target-bin');
  await fs.ensureDir(bin);
  return { cwd: isolation.layout.fixtureCwd, platform: 'linux', env: { ...isolation.env, PATH: bin },
    runner: async ({ command }) => {
      const name = path.basename(command);
      if (name === 'codex') return { exitCode: 0, stdout: 'codex-cli 0.155.0', stderr: '' };
      if (name === 'claude') return { exitCode: 0, stdout: '2.1.291 (Claude Code)', stderr: '' };
      if (name === 'pi') throw new Error('controlled timeout');
      return { exitCode: 1, stdout: '', stderr: 'must not be exposed' };
    } };
}
async function executable(ctx: ReadContext, name: string): Promise<void> {
  const file = path.join(ctx.env!.PATH!, name);
  await fs.writeFile(file, 'controlled probe boundary'); await fs.chmod(file, 0o755);
}

async function piNpmFixture(windows = false, bin = 'dist/bundle/cli.js') {
  const ctx = await fixture();
  const packageRoot = path.join(ctx.env!.PATH!, 'node_modules/@earendil-works/pi-coding-agent');
  const entry = path.join(packageRoot, bin);
  const metadata = { name: '@earendil-works/pi-coding-agent', version: '1.5.0', bin: { pi: bin } };
  await fs.outputFile(entry, '#!/usr/bin/env node\n', { mode: 0o755 });
  await fs.outputJson(path.join(packageRoot, 'package.json'), metadata);
  if (windows) {
    ctx.platform = 'win32';
    ctx.env = { ...ctx.env, USERPROFILE: 'C:\\Users\\qualification', PI_CODING_AGENT_DIR: 'C:\\qualification\\pi' };
    await fs.outputFile(path.join(ctx.env!.PATH!, 'pi.cmd'),
      renderNpmCmdShim(`node_modules\\@earendil-works\\pi-coding-agent\\${bin.replaceAll('/', '\\')}`));
  } else await fs.symlink(entry, path.join(ctx.env!.PATH!, 'pi'));
  return { ctx, packageRoot, entry: await fs.realpath(entry), metadata };
}

async function piLaunchersFixture(windows: boolean) {
  const ctx = await fixture();
  const entries = await Promise.all(['first', 'second', 'third'].map(async (name) => {
    const file = path.join(ctx.cwd, name, windows ? 'pi.exe' : 'pi');
    await fs.outputFile(file, 'controlled launcher', { mode: 0o755 });
    return fs.realpath(file);
  }));
  ctx.platform = windows ? 'win32' : 'linux';
  ctx.env = { ...ctx.env, PATH: entries.map((file) => path.dirname(file)).join(windows ? ';' : ':'),
    ...(windows ? { USERPROFILE: 'C:\\Users\\qualification', PI_CODING_AGENT_DIR: 'C:\\qualification\\pi' } : {}) };
  return { ctx, entries };
}

describe('read-only target discovery and production selection', () => {
  // Peers can share a successful version plus help identity for one image.
  // A failed identity, another working directory or a replaced image needs a new read.
  it('shares only confirmed placement capabilities of the same executable', async () => {
    const ctx = await fixture();
    const entry = path.join(ctx.env!.PATH!, 'pi');
    const writeImage = (value: string) => fs.outputFile(entry, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.from(value)]), { mode: 0o755 });
    await writeImage('first');
    ctx.placementProbeGroup = { scope: 'user', probes: new Map() };
    let version = '1.5.0';
    let help = 'unrelated program';
    const calls: string[] = [];
    ctx.runner = async ({ args }) => {
      calls.push(args[0]!);
      return { exitCode: 0, stdout: args[0] === '--version' ? version : help, stderr: '' };
    };
    expect((await discoverPlatform('pi', ctx)).availability).toBe('unknown');
    help = 'pi coding agent';
    expect((await discoverPlatform('pi', ctx)).availability).toBe('available');
    expect((await discoverPlatform('pi', ctx)).installations[0]?.version).toBe('1.5.0');
    expect(calls).toEqual(['--version', '--help', '--version', '--help']);
    version = '1.6.0';
    expect((await discoverPlatform('pi', { ...ctx, cwd: path.join(ctx.cwd, 'project') })).installations[0]?.version).toBe(version);
    await writeImage('replacement');
    expect((await discoverPlatform('pi', ctx)).installations[0]?.version).toBe(version);
    expect(calls).toHaveLength(8);
  });

  // The independent phase must start while an earlier read is still pending.
  // Its replacement evidence remains usable after the older process completes.
  it('keeps a delayed placement version out of the next independent decision', async () => {
    const ctx = await fixture();
    const entry = path.join(ctx.env!.PATH!, 'claude');
    await fs.outputFile(entry, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    ctx.runner = async () => {
      if (++calls === 1) {
        started.resolve();
        await finish.promise;
        return { exitCode: 0, stdout: '2.1.317 (Claude Code)', stderr: '' };
      }
      return { exitCode: 0, stdout: '2.1.318 (Claude Code)', stderr: '' };
    };
    const old = discoverPlatform('claude', { ...ctx, placementProbeGroup: { scope: 'user', probes: new Map() } });
    try {
      await started.promise;
      const current: ReadContext = { ...ctx, placementProbeGroup: { scope: 'user', probes: new Map() } };
      expect((await discoverPlatform('claude', current)).installations[0]?.version).toBe('2.1.318');
      finish.resolve();
      expect((await old).installations[0]?.version).toBe('2.1.317');
      expect((await discoverPlatform('claude', current)).installations[0]?.version).toBe('2.1.318');
      expect(calls).toBe(2);
    } finally { finish.resolve(); await old; }
  });

  // Test Value Gate: scope reads reuse one identity probe per safe entry while
  // changed namespaces, candidates and new operations obtain fresh evidence.
  it('reuses discovery across scope cwd changes with the same resolved client inputs', async () => {
    const ctx = await fixture();
    await executable(ctx, 'codex');
    const otherCwd = path.join(ctx.cwd, 'other-scope');
    await fs.ensureDir(otherCwd);
    let version = '0.169.0';
    let calls = 0;
    ctx.runner = async () => { calls += 1; return { exitCode: 0, stdout: `codex-cli ${version}`, stderr: '' }; };
    ctx.discoveryCache = new Map();
    const first = await discoverPlatform('codex', ctx);
    first.installations[0]!.version = 'mutated-output';
    const project = await discoverPlatform('codex', { ...ctx, cwd: otherCwd });
    expect(calls).toBe(1);
    expect(project.installations[0]!.version).toBe('0.169.0');
    version = '0.170.0';
    expect((await discoverPlatform('codex', ctx)).installations[0]!.version).toBe('0.169.0');
    const next = await discoverPlatform('codex', { ...ctx, discoveryCache: new Map() });
    expect(next.installations[0]!.version).toBe('0.170.0');
    expect(calls).toBe(2);
    const changedRoot = path.join(ctx.cwd, 'other-codex');
    expect((await discoverPlatform('codex', { ...ctx, env: { ...ctx.env, CODEX_HOME: changedRoot } })).installations[0]!.entry)
      .toMatchObject({ configRoot: changedRoot });
    expect(calls).toBe(3);
    const changedBin = path.join(ctx.cwd, 'other-bin');
    await fs.outputFile(path.join(changedBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    await discoverPlatform('codex', { ...ctx, env: { ...ctx.env, PATH: changedBin } });
    expect(calls).toBe(4);
  });

  // Test Value Gate: a failed client probe must retain independent observations and all target IDs without changing preferences.
  it('retains available, unsupported, unknown, missing, and generic facts in the public list', async () => {
    const ctx = await fixture();
    for (const name of ['codex', 'claude', 'pi']) await executable(ctx, name);
    const found = await discoverPlatforms(ctx);
    expect(found.map((item) => item.platform)).toEqual([...PLATFORM_TARGETS]);
    expect(Object.fromEntries(found.map((item) => [item.platform, item.availability]))).toMatchObject({
      codex: 'available', claude: 'unsupported', pi: 'unknown', copilot: 'missing', generic: 'notApplicable',
    });
    const listed = await targetsList({ ...ctx, discovery: ctx });
    const result = projectReceipt('target.list', listed);
    expect(result.status).toBe('success');
    expect((result.data as { availability: unknown[] }).availability).toHaveLength(PLATFORM_TARGETS.length);
    const text = renderPublicResult(result);
    expect(text).toContain('GitHub Copilot CLI'); expect(text).toContain('clientVersionUnsupported');
    expect(text).not.toContain('must not be exposed');
    expect((await observePreferences({ ...ctx, scope: 'user' })).state).toBe('absent');
  });

  // Test Value Gate: force confirms only new unavailable choices; rejection must preserve the whole previous strong configuration.
  it('rejects a mixed new selection atomically and permits explicit force, retention, removal, and none', async () => {
    const ctx = await fixture(); await executable(ctx, 'codex'); await executable(ctx, 'claude');
    const location = { ...ctx, scope: 'user' as const };
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['claude'] });
    const rejected = await targetsSet({ ...ctx, discovery: ctx, targets: ['codex', 'claude', 'pi'] });
    expect(rejected.preferencesChanged).toBe(false);
    expect(publicExitCode(projectReceipt('target.set', rejected))).toBe(3);
    expect(rejected.policy?.targets).toEqual(['claude']);
    expect(projectReceipt('target.set', rejected).nextActions).toContainEqual(expect.objectContaining({
      argv: ['aw', 'target', 'set', 'claude', 'codex', 'pi', '--force'],
    }));
    const forced = await targetsSet({ ...ctx, discovery: ctx, targets: ['codex', 'claude', 'pi'], force: true });
    expect(forced.ok).toBe(true); expect(forced.policy?.targets).toEqual(['claude', 'codex', 'pi']);
    expect(forced.availability?.find((item) => item.id === 'pi')?.availability).toBe('missing');
    expect((await targetsSet({ ...ctx, discovery: ctx, targets: ['claude', 'pi'] })).ok).toBe(true);
    expect((await targetsSet({ ...ctx, discovery: ctx, targets: [] })).policy?.targets).toEqual([]);
    const invalid = await targetsSet({ ...ctx, discovery: ctx, targets: ['not-an-agent'], force: true });
    expect(invalid.errors[0]?.code).toBe('invalidArguments');
  });

  // Test Value Gate: an independent apply failure cannot erase a committed target preference or report no change.
  it('retains the saved preference when apply is blocked by invalid requirements', async () => {
    const ctx = await fixture();
    await fs.outputFile(path.join(ctx.env!.AW_HOME!, 'plugin-intents.json'), '{invalid');
    const saved = await targetsSet({ ...ctx, discovery: ctx, targets: ['generic'], apply: true, cliVersion: '1.0.0' });
    expect(saved.ok).toBe(false); expect(saved.preferencesChanged).toBe(true);
    expect(saved.policy?.targets).toEqual(['generic']);
    expect(saved.apply?.ok).toBe(false);
    expect(projectReceipt('target.set', saved).status).toBe('partial');
    expect(await observePreferences({ ...ctx, scope: 'user' })).toMatchObject({ state: 'valid', value: { targets: ['generic'] } });
  });

  // Test Value Gate: an identified App without its public bundled executable is installed but cannot supply an automatic route.
  it('reports a Codex App without its bundled CLI as unsupported instead of missing', async () => {
    const ctx = await fixture();
    const apps = path.join(ctx.cwd, 'Applications');
    await fs.outputFile(path.join(apps, 'Codex.app', 'Contents', 'Info.plist'), '<plist/>');
    const found = await discoverPlatform('codex', { ...ctx, platform: 'darwin', macApplicationsDirectories: [apps],
      runner: async () => ({ exitCode: 0, stdout: 'com.openai.codex', stderr: '' }) });
    expect(found.availability).toBe('unsupported');
    expect(found.installations).toEqual([expect.objectContaining({ product: 'app', availability: 'unsupported',
      reasonCodes: ['clientInstallEntryUnavailable'], entry: null })]);
  });

  // Test Value Gate: a PATH alias of the App's bundled CLI is one version probe but remains two identified product faces.
  it.runIf(process.platform !== 'win32')('keeps both Codex product faces when they share one executable', async () => {
    const ctx = await fixture(); const apps = path.join(ctx.cwd, 'Applications');
    const bundled = path.join(apps, 'Codex.app', 'Contents', 'Resources', 'codex');
    await fs.outputFile(path.join(apps, 'Codex.app', 'Contents', 'Info.plist'), '<plist/>');
    await fs.outputFile(bundled, 'controlled probe'); await fs.chmod(bundled, 0o755);
    await fs.symlink(bundled, path.join(ctx.env!.PATH!, 'codex'));
    let versions = 0;
    const result = await discoverPlatform('codex', { ...ctx, platform: 'darwin', macApplicationsDirectories: [apps], runner: async ({ command }) => {
      if (command === '/usr/bin/plutil') return { exitCode: 0, stdout: 'com.openai.codex', stderr: '' };
      versions += 1; return { exitCode: 0, stdout: 'codex-cli 0.155.0', stderr: '' };
    } });
    expect(result.installations.map((product) => product.product)).toEqual(['cli', 'app']);
    expect(versions).toBe(1);
  });

  // Test Value Gate: a same-name executable is not sufficient product identity.
  it('does not accept an unrelated same-name executable with a plausible version', async () => {
    const ctx = await fixture(); await executable(ctx, 'copilot');
    const found = await discoverPlatform('copilot', { ...ctx, runner: async () => ({ exitCode: 0, stdout: '1.0.95 unrelated utility', stderr: '' }) });
    expect(found.availability).toBe('unknown');
  });

  // Test Value Gate: the official Copilot sentence punctuation must not hide its
  // version; only its complete branded line receives this normalization.
  it.each(['\n', '\r\n'])('reads the official Copilot version sentence with %j line endings', async (lineEnding) => {
    const ctx = await fixture(); await executable(ctx, 'copilot');
    const stdout = `GitHub Copilot CLI 1.0.95.${lineEnding}Run 'copilot update' to check for updates.${lineEnding}`;
    const found = await discoverPlatform('copilot', { ...ctx, runner: async ({ env, timeoutMs }) => {
      expect(env === ctx.env).toBe(true);
      expect(timeoutMs).toBe(DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS);
      return { exitCode: 0, stdout, stderr: '' };
    } });
    expect(found.availability).toBe('available');
    expect(found.installations[0]).toMatchObject({ version: '1.0.95', availability: 'available', reasonCodes: [] });
  });

  it('retains the valid unpunctuated Copilot version output', async () => {
    const ctx = await fixture(); await executable(ctx, 'copilot');
    const found = await discoverPlatform('copilot', { ...ctx,
      runner: async () => ({ exitCode: 0, stdout: 'GitHub Copilot CLI 1.0.95', stderr: '' }) });
    expect(found.installations[0]).toMatchObject({ version: '1.0.95', availability: 'available' });
  });

  it.each([
    'GitHub Copilot CLI 1.0.95..',
    'GitHub Copilot CLI 1.0.95-01.',
    'GitHub Copilot CLI 1.0.95-beta..',
    'GitHub Copilot CLI 01.0.95.',
    'Unrelated GitHub Copilot CLI 1.0.95.',
  ])('rejects malformed or unrecognized Copilot version lines: %s', async (line) => {
    const ctx = await fixture(); await executable(ctx, 'copilot');
    const found = await discoverPlatform('copilot', { ...ctx, runner: async () => ({ exitCode: 0,
      stdout: `${line}\nRun 'copilot update' to check for updates.\n`, stderr: '' }) });
    expect(found.availability).toBe('unknown');
    expect(found.installations[0]).toMatchObject({ version: null, reasonCodes: ['clientVersionUnknown'] });
  });

  // Test Value Gate: Copilot sentence normalization must not relax other clients.
  it('keeps the strict version token gate for other platforms', async () => {
    const ctx = await fixture(); await executable(ctx, 'codex');
    const found = await discoverPlatform('codex', { ...ctx,
      runner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.167.0.', stderr: '' }) });
    expect(found.availability).toBe('unknown');
    expect(found.installations[0]).toMatchObject({ version: null, reasonCodes: ['clientProbeFailed'] });
  });

  // Test Value Gate: a broken earlier PATH entry must not hide a healthy independent client entry.
  it.runIf(process.platform !== 'win32')('keeps a healthy CLI when another PATH entry lacks execute permission', async () => {
    const ctx = await fixture(); const healthyBin = path.join(ctx.cwd, 'healthy-bin'); await fs.ensureDir(healthyBin);
    const broken = path.join(ctx.env!.PATH!, 'copilot'); await fs.writeFile(broken, 'broken'); await fs.chmod(broken, 0o600);
    const healthy = path.join(healthyBin, 'copilot'); await fs.writeFile(healthy, 'healthy'); await fs.chmod(healthy, 0o755);
    const result = await discoverPlatform('copilot', { ...ctx, env: { ...ctx.env, PATH: `${ctx.env!.PATH!}:${healthyBin}` },
      runner: async () => ({ exitCode: 0, stdout: 'GitHub Copilot CLI 1.0.95', stderr: '' }) });
    expect(result.availability).toBe('available'); expect(result.diagnostics[0]?.code).toBe('clientEntryUnresolved');
  });

  // Test Value Gate: GUI-only Cursor uses its verified App identity and release line, without requiring a PATH CLI.
  it('discovers supported Cursor App independently and preserves unverified GUI coverage', async () => {
    const ctx = await fixture();
    const apps = path.join(ctx.cwd, 'Applications');
    await fs.outputFile(path.join(apps, 'Cursor.app', 'Contents', 'Info.plist'), '<plist/>');
    const cursor = await discoverPlatform('cursor', { ...ctx, platform: 'darwin', macApplicationsDirectories: [apps],
      runner: async ({ args }) => ({ exitCode: 0, stdout: args.includes('CFBundleIdentifier') ? 'com.todesktop.230313mzl4w4u92' : '3.29', stderr: '' }) });
    expect(cursor.availability).toBe('available');
    expect(cursor.installations).toEqual([expect.objectContaining({ product: 'app', version: '3.29',
      entry: { kind: 'directory', configRoot: path.join(ctx.env!.HOME!, '.cursor') } })]);
    const antigravity = await discoverPlatform('antigravity', ctx);
    expect(antigravity.availability).toBe('unknown');
    expect(antigravity.diagnostics[0]?.code).toBe('appDiscoveryUnverified');
  });

  // Test Value Gate: an override must select the actual host settings that
  // control global activation, rather than a separate HOME/.copilot file.
  it('discovers the Copilot settings root from its official home override', async () => {
    const ctx = await fixture(); await executable(ctx, 'copilot');
    const custom = path.join(ctx.cwd, 'copilot home');
    const runner = async () => ({ exitCode: 0, stdout: 'GitHub Copilot CLI 1.0.95', stderr: '' });
    const found = await discoverPlatform('copilot', { ...ctx, env: { ...ctx.env, COPILOT_HOME: custom }, runner });
    expect(found.availability).toBe('available');
    expect(found.installations[0]?.entry).toMatchObject({ configRoot: custom });
    expect((await discoverPlatform('copilot', { ...ctx, env: { ...ctx.env, COPILOT_HOME: 'relative-home' }, runner })).availability).toBe('unknown');
  });

  // Test Value Gate: Pi's Native settings/trust root and AW discovery must use the same official override normalization.
  it('uses the official Pi agent directory with Native path semantics', async () => {
    const ctx = await fixture(); await executable(ctx, 'pi');
    const custom = path.join(ctx.cwd, 'pi agent');
    const variants = [
      [undefined, path.join(ctx.env!.HOME!, '.pi', 'agent')], ['', path.join(ctx.env!.HOME!, '.pi', 'agent')],
      [custom, custom], ['~', ctx.env!.HOME!], ['~/pi-agent', path.join(ctx.env!.HOME!, 'pi-agent')],
      ['relative-agent', path.join(ctx.cwd, 'relative-agent')], [pathToFileURL(custom).href, custom],
    ] as const;
    for (const [override, expected] of variants) {
      const found = await discoverPlatform('pi', { ...ctx,
        env: { ...ctx.env, PI_CODING_AGENT_DIR: override, AW_PI_AGENT_DIR: path.join(ctx.cwd, 'ignored-aw-alias') },
        runner: async () => ({ exitCode: 0, stdout: 'pi coding agent 1.5.0', stderr: '' }) });
      expect(found.installations[0]?.entry).toMatchObject({ configRoot: expected });
    }
    const windows = { cwd: 'C:\\work', platform: 'win32' as const, env: { USERPROFILE: 'C:\\Users\\reader' } };
    for (const override of ['/mnt/d/pi-agent', '/cygdrive/d/pi-agent', '/d/pi-agent', 'file:///D:/pi-agent']) {
      expect(resolvePlatformConfigRoot('pi', { ...windows, env: { ...windows.env, PI_CODING_AGENT_DIR: override } })).toBe('D:\\pi-agent');
    }
    expect(resolvePlatformConfigRoot('pi', { ...windows, env: { ...windows.env, PI_CODING_AGENT_DIR: '~\\pi-agent' } })).toBe('C:\\Users\\reader\\pi-agent');
  });

  // Test Value Gate: the pinned npm package binds a bare Pi version to its real
  // three-level entry, while each discovery still executes the native version.
  it.each(process.platform === 'win32' ? [true] : [false, true])('identifies pinned Pi npm metadata without help (Windows=%s)', async (windows) => {
    const item = await piNpmFixture(windows);
    const calls: string[] = [];
    item.ctx.runner = async ({ command, args, env, timeoutMs }) => {
      expect(command).toBe(process.execPath); expect(args[0]).toBe(item.entry);
      expect(env === item.ctx.env).toBe(true);
      expect(timeoutMs).toBe(DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS);
      calls.push(args.at(-1)!);
      if (args.at(-1) !== '--version') throw new Error('Pinned identity must not need help.');
      return { exitCode: 0, stdout: '1.5.0\n', stderr: '' };
    };
    for (let index = 0; index < 2; index += 1) {
      expect((await discoverPlatform('pi', item.ctx)).installations[0]).toMatchObject({ availability: 'available', version: '1.5.0' });
    }
    expect(calls).toEqual(['--version', '--version']);
  });

  // Test Value Gate: metadata can remove only the fixed entry's redundant help
  // probe; missing or different evidence must retain independent identity.
  it.runIf(process.platform !== 'win32').each([
    'missing', 'invalid', 'foreign', 'version-mismatch', 'bin-mismatch', 'other-version', 'other-entry',
  ] as const)('keeps Pi native version and help confirmation for %s', async (kind) => {
    const item = await piNpmFixture(false, kind === 'other-entry' ? 'dist/cli.js' : undefined);
    const file = path.join(item.packageRoot, 'package.json');
    if (kind === 'missing') await fs.remove(file);
    else if (kind === 'invalid') await fs.writeFile(file, '{invalid');
    else {
      if (kind === 'foreign') item.metadata.name = 'foreign-cli';
      if (kind === 'version-mismatch') item.metadata.version = '1.5.1';
      if (kind === 'bin-mismatch') {
        item.metadata.bin.pi = 'dist/other.js';
        await fs.outputFile(path.join(item.packageRoot, 'dist/other.js'), 'Different entry.');
      }
      if (kind === 'other-version') item.metadata.version = '1.5.1';
      await fs.outputJson(file, item.metadata);
    }
    const observedVersion = kind === 'other-version' ? '1.5.1' : '1.5.0';
    const calls: string[] = [];
    item.ctx.runner = async ({ args }) => {
      calls.push(args.at(-1)!);
      return { exitCode: 0, stderr: '', stdout: args.at(-1) === '--version' ? `${observedVersion}\n` : 'pi coding agent' };
    };
    expect((await discoverPlatform('pi', item.ctx)).installations[0]).toMatchObject({ availability: 'available', version: observedVersion });
    expect(calls).toEqual(['--version', '--help']);
  });

  // Test Value Gate: a matching package must not turn failed native probes into
  // availability or swallow abort and unconfirmed process cleanup.
  it.runIf(process.platform !== 'win32').each(['exit', 'timeout', 'cleanup', 'aborted'] as const)(
    'retains Pi %s probe failure with matching metadata', async (failure) => {
      const item = await piNpmFixture();
      const calls: string[] = [];
      item.ctx.runner = async (invocation) => {
        calls.push(invocation.args.at(-1)!);
        if (failure === 'exit') return { exitCode: 1, stdout: '1.5.0\n', stderr: '' };
        throw new NativeCliError({ invocation, exitCode: failure === 'timeout' ? 124 : 1, stdout: '1.5.0\n', stderr: '',
          ...(failure === 'cleanup' ? { cleanupError: new Error('cleanup unconfirmed') } : { reason: failure }) });
      };
      const pending = discoverPlatform('pi', item.ctx);
      if (failure === 'cleanup' || failure === 'aborted') {
        await expect(pending).rejects.toMatchObject({ name: 'NativeCliError',
          ...(failure === 'cleanup' ? { cleanupError: expect.any(Error) } : { reason: 'aborted' }) });
      } else expect((await pending).installations[0]).toMatchObject({ availability: 'unknown', version: null });
      expect(calls).toEqual(['--version']);
    },
  );

  // Test Value Gate: a validated npm launcher without a matching package version
  // still needs Pi help, while a foreign Windows shim must never be executed.
  it('identifies the official Pi version and help output through its validated npm launcher', async () => {
    const ctx = await fixture();
    const packageRoot = path.join(ctx.env!.PATH!, 'node_modules', '@earendil-works', 'pi-coding-agent');
    const entry = path.join(packageRoot, 'dist', 'bundle', 'cli.js');
    await fs.outputFile(entry, 'controlled official entry');
    await fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: '@earendil-works/pi-coding-agent', bin: { pi: 'dist/bundle/cli.js' },
    });
    await fs.writeFile(path.join(ctx.env!.PATH!, 'pi.cmd'),
      renderNpmCmdShim('node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'));
    const env = { ...ctx.env, USERPROFILE: 'C:\\Users\\qualification', PI_CODING_AGENT_DIR: 'C:\\qualification\\pi' };
    const found = await discoverPlatform('pi', { ...ctx, env, platform: 'win32', runner: async ({ command, args }) => {
      expect(command).toBe(process.execPath);
      expect(args[0]).toBe(entry);
      return { exitCode: 0, stderr: '', stdout: args.at(-1) === '--version' ? '1.5.0\n'
        : 'pi - AI coding assistant with read, bash, edit, write tools\n\nUsage:\n  pi [options]\n' };
    } });
    expect(found.availability).toBe('available');
    expect(found.installations[0]).toMatchObject({ version: '1.5.0', availability: 'available' });

    await fs.writeJson(path.join(packageRoot, 'package.json'), { name: 'unrelated-package', bin: { pi: 'dist/bundle/cli.js' } });
    let foreignCalls = 0;
    const foreign = await discoverPlatform('pi', { ...ctx, env, platform: 'win32', runner: async () => {
      foreignCalls += 1;
      return { exitCode: 0, stderr: '', stdout: 'pi coding agent 1.5.0' };
    } });
    expect(foreign.availability).toBe('unknown');
    expect(foreignCalls).toBe(0);
  });

  // Test Value Gate: a plausible Pi version and command name alone must not establish client identity.
  it('rejects an unrelated Pi executable with a plausible version', async () => {
    const ctx = await fixture(); await executable(ctx, 'pi');
    const found = await discoverPlatform('pi', { ...ctx, runner: async ({ args }) => ({
      exitCode: 0, stderr: '', stdout: args.at(-1) === '--version' ? '1.5.0' : 'pi - unrelated utility',
    }) });
    expect(found.availability).toBe('unknown');
    expect(found.installations[0]?.reasonCodes).toContain('clientIdentityUnconfirmed');
  });

  // Test Value Gate: each launcher must prove its own identity and keep its
  // selection priority even if another launcher's probe finishes first.
  it.each(process.platform === 'win32' ? [true] : [false, true])('checks at most two Pi entries while preserving fallback (Windows=%s)', async (windows) => {
    const { ctx, entries: [first, second, third] } = await piLaunchersFixture(windows);
    const firstStarted = Promise.withResolvers<void>();
    const completeFirst = Promise.withResolvers<void>();
    const calls: Array<[string, string]> = [];
    const pending = discoverPlatform('pi', { ...ctx, runner: async ({ command, args }) => {
      calls.push([command, args.at(-1)!]);
      if (command === first) {
        firstStarted.resolve();
        await completeFirst.promise;
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: args.at(-1) === '--version' ? '1.5.0' :
        command === second ? 'Pi coding agent' : 'Unrelated utility', stderr: '' };
    } });
    await firstStarted.promise;
    try {
      await setImmediate();
      expect(calls).toEqual([[first, '--version'], [second, '--version'], [second, '--help']]);
    } finally {
      completeFirst.resolve();
      await pending;
    }
    const found = await pending;
    expect(calls.slice(3)).toEqual([[third, '--version'], [third, '--help']]);
    expect(found.installations).toMatchObject([
      { entry: { executable: first }, availability: 'unknown', reasonCodes: ['clientProbeFailed'] },
      { entry: { executable: second }, availability: 'available', reasonCodes: [] },
      { entry: { executable: third }, availability: 'unknown', reasonCodes: ['clientIdentityUnconfirmed'] },
    ]);
    expect(found.diagnostics.map(({ code }) => code)).toEqual(['clientProbeFailed', 'clientIdentityUnconfirmed']);
  });

  // Test Value Gate: a cancelled Review must wait for any launched sibling
  // and carry its unconfirmed process cleanup back to the controller.
  it.each(process.platform === 'win32' ? [true] : [false, true])('reports a later Pi cleanup failure after both probes settle (Windows=%s)', async (windows) => {
    const { ctx, entries: [first, second] } = await piLaunchersFixture(windows);
    const abort = new AbortController();
    const firstStarted = Promise.withResolvers<void>();
    const completeFirst = Promise.withResolvers<void>();
    const completeSecond = Promise.withResolvers<void>();
    const cleanupError = new Error('cleanup unconfirmed');
    const calls: string[] = [];
    let settled = false;
    const pending = discoverPlatform('pi', { ...ctx, signal: abort.signal, runner: async (invocation) => {
      calls.push(invocation.command);
      if (invocation.command === first) {
        firstStarted.resolve();
        await completeFirst.promise;
        throw abort.signal.reason;
      }
      await completeSecond.promise;
      throw new NativeCliError({ invocation, reason: 'aborted', exitCode: 1, stdout: '', stderr: '', cleanupError });
    } }).catch((error: unknown) => error).finally(() => { settled = true; });
    await firstStarted.promise;
    try {
      await setImmediate();
      expect(calls).toEqual([first, second]);
      abort.abort();
      completeFirst.resolve();
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      abort.abort();
      completeFirst.resolve();
      completeSecond.resolve();
      await pending;
    }
    expect(await pending).toMatchObject({ name: 'NativeCliError', cleanupError });
    expect(calls).toEqual([first, second]);
  });

  // Test Value Gate: Windows Grok must resolve its official npm shim while a
  // same-name shim from another package must not be executed.
  it('identifies Grok through its validated Windows npm launcher', async () => {
    const ctx = await fixture();
    const packageRoot = path.join(ctx.env!.PATH!, 'node_modules', '@xai-official', 'grok');
    const entry = path.join(packageRoot, 'bin', 'grok');
    await fs.outputFile(entry, '#!/usr/bin/env node\n// controlled official Node entry\n');
    await fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: '@xai-official/grok', bin: { grok: 'bin/grok' },
    });
    await fs.writeFile(path.join(ctx.env!.PATH!, 'grok.cmd'),
      renderNpmCmdShim('node_modules\\@xai-official\\grok\\bin\\grok'));
    const env = { ...ctx.env, USERPROFILE: 'C:\\Users\\qualification', GROK_HOME: path.join(ctx.cwd, 'grok-home') };
    let probes = 0;
    const found = await discoverPlatform('grok', { ...ctx, env, platform: 'win32', runner: async ({ command, args }) => {
      probes += 1;
      expect(command).toBe(process.execPath); expect(args[0]).toBe(entry);
      return { exitCode: 0, stderr: '', stdout: args.at(-1) === '--version' ? 'grok 1.0.77\n'
        : args.includes('list') ? 'Usage: grok plugin list --json'
        : 'Usage: grok plugin install uninstall enable disable' };
    } });
    expect(found.availability).toBe('available');
    expect(found.installations[0]?.version).toBe('1.0.77'); expect(probes).toBeGreaterThan(0);
    await fs.writeJson(path.join(packageRoot, 'package.json'), { name: 'unrelated-package', bin: { grok: 'bin/grok' } });
    let foreignCalls = 0;
    const foreign = await discoverPlatform('grok', { ...ctx, env, platform: 'win32', runner: async () => {
      foreignCalls += 1;
      throw new Error('An unverified package must not be executed');
    } });
    expect(foreign.availability).toBe('unknown');
    expect(foreign.installations[0]?.reasonCodes).toContain('clientProbeFailed');
    expect(foreignCalls).toBe(0);
  });

  // Test Value Gate: Grok uses its verified CLI interface and configured home, without an invented numeric minimum.
  it('accepts a confirmed Grok interface when its optional version is unavailable', async () => {
    const ctx = await fixture(); await executable(ctx, 'grok');
    const root = path.join(ctx.cwd, 'grok-home');
    const result = await discoverPlatform('grok', { ...ctx, env: { ...ctx.env, GROK_HOME: root }, runner: async ({ args }) => ({ exitCode: 0, stderr: '',
      stdout: args.includes('--version') ? 'grok build' : args.includes('list') ? 'Usage: grok plugin list --json' : 'Usage: grok plugin install uninstall enable disable' }) });
    expect(result.availability).toBe('available');
    expect(result.installations[0]).toMatchObject({ version: null, reasonCodes: ['clientVersionUnknown'], entry: { configRoot: root } });
  });

  // Test Value Gate: the official OpenCode v-prefixed output must pass its real format while malformed SemVer stays unknown.
  it.each([
    ['opencode v2.2.6', 'available', '2.2.6', 'available'],
    ['opencode v2.0.0-beta.1', 'unsupported', '2.0.0-beta.1', 'unsupported'],
    ['opencode v02.2.6', 'unknown', null, 'unknown'],
  ] as const)('reads OpenCode output %s with strict SemVer', async (stdout, availability, version, cliAvailability) => {
    const ctx = await fixture(); await executable(ctx, 'opencode');
    const result = await discoverPlatform('opencode', { ...ctx, runner: async () => ({ exitCode: 0, stdout, stderr: '' }) });
    expect(result.availability).toBe(availability);
    expect(result.installations[0]?.version).toBe(version);
    expect(result.installations[0]?.availability).toBe(cliAvailability);
  });
});
