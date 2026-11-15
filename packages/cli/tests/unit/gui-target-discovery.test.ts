import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { discoverPlatform, type ReadContext } from '../../src/platforms/discovery.js';
import { resolveDeployments } from '../../src/platforms/layout.js';
import { targetsList } from '../../src/commands/targets-command.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(platform: NodeJS.Platform = 'darwin'): Promise<ReadContext> {
  const isolation = getCurrentSourceTestIsolation();
  const bin = path.join(isolation.layout.fixtureCwd, 'gui-bin');
  const apps = path.join(isolation.layout.fixtureCwd, 'Applications');
  await Promise.all([fs.ensureDir(bin), fs.ensureDir(apps)]);
  return { cwd: isolation.layout.fixtureCwd, env: { ...isolation.env, USERPROFILE: isolation.env.HOME, PATH: bin }, platform,
    macApplicationsDirectories: [apps], windowsApplicationsDirectories: [apps], linuxDesktopDirectories: [apps],
    runner: async () => { throw new Error('unexpected process'); } };
}
async function app(ctx: ReadContext, name: string) {
  const root = path.join(ctx.macApplicationsDirectories![0]!, `${name}.app`);
  await fs.outputFile(path.join(root, 'Contents', 'Info.plist'), '<plist/>');
  return root;
}
async function resolve(ctx: ReadContext, platform: 'antigravity' | 'opencode' | 'cursor') {
  return resolveDeployments(ctx, { plugin: { sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`, pluginId: 'team/demo', version: '1.0.0' },
    scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [], discovery: await discoverPlatform(platform, ctx) });
}

describe('bounded GUI discovery through public list and deployment resolution', () => {
  // Test Value Gate: an installed GUI can supply the documented directory route without a PATH CLI, while a name alone cannot prove identity.
  it('uses a sealed Google Antigravity App, never its display name alone', async () => {
    const ctx = await fixture(); await app(ctx, 'Antigravity');
    const calls: string[][] = [];
    const verified: ReadContext = { ...ctx, runner: async ({ command, args }) => {
      calls.push([command, ...args]);
      return { exitCode: 0, stderr: '', stdout: command.endsWith('plutil')
        ? args.includes('CFBundleIdentifier') ? 'com.google.verified-antigravity' : args.includes('CFBundleName') ? 'Antigravity' : '1.0.0'
        : args.includes('--verify') ? '' : 'Identifier=com.google.verified-antigravity\nAuthority=Developer ID Application: Google LLC (TEST)' };
    } };
    const listed = await targetsList({ ...verified, discovery: verified });
    expect(listed.availability?.find((item) => item.id === 'antigravity')).toMatchObject({ availability: 'available',
      installations: [{ product: 'app', availability: 'available', entry: { kind: 'directory' } }] });
    expect((await resolve(verified, 'antigravity')).bindings).toMatchObject([{ route: 'antigravity-directory', consumers: [{ product: 'app' }] }]);
    expect(calls).toContainEqual(['/usr/bin/codesign', '--verify', '--strict',
      '-R=anchor apple generic and certificate leaf[subject.O] = "Google LLC"', path.join(ctx.macApplicationsDirectories![0]!, 'Antigravity.app')]);
    expect(calls.every(([command, ...args]) => command === '/usr/bin/plutil'
      || command === '/usr/bin/codesign' && (args.includes('--verify') || args.includes('--display')))).toBe(true);
    const unsealed = { ...verified, runner: async ({ command, args }: Parameters<NonNullable<ReadContext['runner']>>[0]) => ({ exitCode: 0, stderr: '',
      stdout: command.endsWith('plutil') ? args.includes('CFBundleIdentifier') ? 'com.google.verified-antigravity' : 'Antigravity' : 'Authority=Ad Hoc' }) };
    expect((await discoverPlatform('antigravity', unsealed)).installations).toMatchObject([{ product: 'app', availability: 'unknown', reasonCodes: ['appIdentityUnconfirmed'] }]);
    expect((await resolve(unsealed, 'antigravity')).bindings).toEqual([]);
  });

  // Test Value Gate: Desktop package metadata does not establish the V2 runtime required by OpenCode; missing, unreadable and old runtime facts stay distinct.
  it.each([
    ['2.2.6', 'available', undefined], ['1.9.9', 'unsupported', 'clientRuntimeVersionUnsupported'],
    ['not-a-version', 'unknown', 'clientRuntimeVersionUnknown'], [null, 'unsupported', 'clientLocalRuntimeMissing'],
  ] as const)('keeps OpenCode Desktop runtime %s as %s', async (version, availability, reason) => {
    const ctx = await fixture(); const root = await app(ctx, 'OpenCode');
    if (version !== null) {
      const runtime = path.join(root, 'Contents', 'Resources', 'opencode-cli');
      await fs.outputFile(runtime, 'controlled runtime'); await fs.chmod(runtime, 0o755);
      await fs.outputFile(path.join(root, 'Contents', 'Resources', 'opencode-cli.version'), version);
    }
    ctx.runner = async () => ({ exitCode: 0, stdout: 'ai.opencode.desktop', stderr: '' });
    const listed = await targetsList({ ...ctx, discovery: ctx });
    const found = listed.availability!.find((item) => item.id === 'opencode')!;
    expect(found.availability).toBe(availability);
    expect(found.installations).toMatchObject([{ product: 'app', availability,
      reasonCodes: reason ? [reason] : [], entry: { kind: 'directory' } }]);
    const resolution = await resolve(ctx, 'opencode');
    if (availability === 'available') expect(resolution.bindings).toMatchObject([{ route: 'opencode-directory', consumers: [{ product: 'app' }] }]);
    else { expect(resolution.bindings).toEqual([]); expect(resolution.exclusions).toEqual([{ productId: found.installations[0]!.id, reasonCode: reason }]); }
  });

  // Test Value Gate: a remote server URL cannot promote a bundled executable into evidence that this Desktop uses local plugins.
  it('keeps remote OpenCode Desktop runtime unconfirmed', async () => {
    const ctx = await fixture(); const root = await app(ctx, 'OpenCode');
    const runtime = path.join(root, 'Contents', 'Resources', 'opencode-cli');
    await fs.outputFile(runtime, 'fixture'); await fs.chmod(runtime, 0o755);
    await fs.outputFile(path.join(root, 'Contents', 'Resources', 'opencode-cli.version'), '2.2.6');
    ctx.env!.OPENCODE_SERVER_URL = 'https://remote.invalid';
    ctx.runner = async () => ({ exitCode: 0, stdout: 'ai.opencode.desktop', stderr: '' });
    expect((await discoverPlatform('opencode', ctx)).installations[0]).toMatchObject({ availability: 'unknown', reasonCodes: ['clientLocalRuntimeUnconfirmed'] });
    expect((await resolve(ctx, 'opencode')).bindings).toEqual([]);
  });

  // Test Value Gate: a known wrong bundle cannot supply a route, and absence is only claimed after the implemented discovery scope is checked.
  it('rejects another bundle identity and reports checked macOS absence separately from unverified OS coverage', async () => {
    const ctx = await fixture(); await app(ctx, 'OpenCode');
    ctx.runner = async () => ({ exitCode: 0, stdout: 'unrelated.desktop', stderr: '' });
    expect((await discoverPlatform('opencode', ctx)).installations).toEqual([]);
    expect((await resolve(ctx, 'opencode')).bindings).toEqual([]);
    await fs.remove(path.join(ctx.macApplicationsDirectories![0]!, 'OpenCode.app'));
    for (const platform of ['opencode', 'cursor', 'antigravity'] as const) expect((await discoverPlatform(platform, ctx)).availability).toBe('missing');
    const unverified = await discoverPlatform('antigravity', { ...ctx, platform: 'linux' });
    expect(unverified).toMatchObject({ availability: 'unknown', installations: [], diagnostics: [{ code: 'appDiscoveryUnverified' }] });
  });

  // Test Value Gate: Windows PE metadata and Linux desktop/product metadata must identify the official Cursor App independently of its CLI.
  it.each(['win32', 'linux'] as const)('discovers Cursor GUI-only on %s through the bounded official entry', async (platform) => {
    const ctx = await fixture(platform); const apps = ctx.windowsApplicationsDirectories![0]!;
    if (platform === 'win32' && process.platform !== 'win32') ctx.env!.USERPROFILE = 'C:\\Users\\AWFixture';
    const root = path.join(apps, 'cursor');
    if (platform === 'win32') await fs.outputFile(path.join(root, 'Cursor.exe'), 'PE fixture');
    else {
      const executable = path.join(root, 'cursor'); await fs.outputFile(executable, 'fixture');
      await fs.outputFile(path.join(apps, 'cursor.desktop'), `[Desktop Entry]\nName=Cursor\nStartupWMClass=Cursor\nExec="${executable}" %F\n`);
      await fs.outputJson(path.join(root, 'resources', 'app', 'product.json'), { applicationName: 'cursor', nameShort: 'Cursor' });
      await fs.outputJson(path.join(root, 'resources', 'app', 'package.json'), { version: '3.29.0' });
    }
    ctx.runner = async ({ command }) => {
      expect(command).toBe('powershell.exe');
      return { exitCode: 0, stdout: JSON.stringify({ ProductName: 'Cursor', ProductVersion: '3.29.0', OriginalFilename: 'Cursor.exe' }), stderr: '' };
    };
    const listed = await targetsList({ ...ctx, discovery: ctx });
    expect(listed.availability?.find((item) => item.id === 'cursor')).toMatchObject({ availability: 'available', installations: [{ product: 'app', version: '3.29.0' }] });
    const resolution = await resolve(ctx, 'cursor');
    if (platform === 'win32' && process.platform !== 'win32') {
      // The real canonical path implementation must not reinterpret a Windows drive home on a POSIX host.
      expect(resolution.bindings).toEqual([]);
      expect(resolution.exclusions).toEqual([{ productId: listed.availability!.find((item) => item.id === 'cursor')!.installations[0]!.id, reasonCode: 'deploymentLayoutUnconfirmed' }]);
    } else expect(resolution.bindings).toMatchObject([{ route: 'cursor-workspace-hook', consumers: [{ product: 'app' }] }]);
  });
});
