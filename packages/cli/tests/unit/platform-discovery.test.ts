import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core';
import { discoverPlatforms, discoverPlatform, resolvePlatformConfigRoot, type ReadContext } from '../../src/platforms/discovery.js';
import { targetsList, targetsSet } from '../../src/commands/targets-command.js';
import { createEmptyPreferences, observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { projectReceipt } from '../../src/output/receipt-projection.js';
import { publicExitCode, renderPublicResult } from '../../src/output/public-result.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
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
      if (name === 'gemini') throw new Error('controlled timeout');
      return { exitCode: 1, stdout: '', stderr: 'must not be exposed' };
    } };
}
async function executable(ctx: ReadContext, name: string): Promise<void> {
  const file = path.join(ctx.env!.PATH!, name);
  await fs.writeFile(file, 'controlled probe boundary'); await fs.chmod(file, 0o755);
}

describe('read-only target discovery and production selection', () => {
  // Test Value Gate: a failed client probe must retain independent observations and all target IDs without changing preferences.
  it('retains available, unsupported, unknown, missing, and generic facts in the public list', async () => {
    const ctx = await fixture();
    for (const name of ['codex', 'claude', 'gemini']) await executable(ctx, name);
    const found = await discoverPlatforms(ctx);
    expect(found.map((item) => item.platform)).toEqual([...PLATFORM_TARGETS]);
    expect(Object.fromEntries(found.map((item) => [item.platform, item.availability]))).toMatchObject({
      codex: 'available', claude: 'unsupported', gemini: 'unknown', copilot: 'missing', generic: 'notApplicable',
    });
    const listed = await targetsList({ ...ctx, discovery: ctx });
    const result = projectReceipt('target.list', listed);
    expect(result.status).toBe('success');
    expect((result.data as { availability: unknown[] }).availability).toHaveLength(10);
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
    const rejected = await targetsSet({ ...ctx, discovery: ctx, targets: ['codex', 'claude', 'gemini'] });
    expect(rejected.preferencesChanged).toBe(false);
    expect(publicExitCode(projectReceipt('target.set', rejected))).toBe(3);
    expect(rejected.policy?.targets).toEqual(['claude']);
    expect(projectReceipt('target.set', rejected).nextActions).toContainEqual(expect.objectContaining({
      argv: ['aw', 'target', 'set', 'claude', 'codex', 'gemini', '--force'],
    }));
    const forced = await targetsSet({ ...ctx, discovery: ctx, targets: ['codex', 'claude', 'gemini'], force: true });
    expect(forced.ok).toBe(true); expect(forced.policy?.targets).toEqual(['claude', 'codex', 'gemini']);
    expect(forced.availability?.find((item) => item.id === 'gemini')?.availability).toBe('missing');
    expect((await targetsSet({ ...ctx, discovery: ctx, targets: ['claude', 'gemini'] })).ok).toBe(true);
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
    const found = await discoverPlatform('copilot', { ...ctx, runner: async () => ({ exitCode: 0, stdout, stderr: '' }) });
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

  // Test Value Gate: Gemini's public home override must bind discovery to the actual host namespace and reject relative roots.
  it('uses the Gemini CLI home override only as an absolute host home', async () => {
    const ctx = await fixture(); await executable(ctx, 'gemini');
    const root = path.join(ctx.cwd, 'gemini-home');
    const runner: ReadContext['runner'] = async () => ({ exitCode: 0, stdout: 'Gemini CLI 0.63.0', stderr: '' });
    const supported = await discoverPlatform('gemini', { ...ctx, env: { ...ctx.env, GEMINI_CLI_HOME: root }, runner });
    expect(supported.installations[0]?.entry).toMatchObject({ configRoot: path.join(root, '.gemini') });
    expect((await discoverPlatform('gemini', { ...ctx, env: { ...ctx.env, GEMINI_CLI_HOME: 'relative-home' }, runner })).availability).toBe('unknown');
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

  // Test Value Gate: the official Pi CLI prints only a version; discovery must confirm its help identity without accepting an unrelated pi executable.
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
