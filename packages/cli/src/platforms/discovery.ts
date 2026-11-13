import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { PLATFORM_TARGETS, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS, MINIMUM_AGENT_VERSIONS } from '../constants.js';
import { discoverCodexExecutables, rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { extractStrictSemVerTokenFromVersionOutput } from '../utils/agent-version.js';
import { compareStrictSemVer } from '../utils/manifest.js';
import { runNativeCli, type NativeCliInvocation, type NativeCliRunner } from '../utils/native-cli.js';
import { getCodexHome, getClaudeHome, readEnvironmentValue, resolveUserHome } from '../utils/state-paths.js';
import { resolveWindowsNpmCommand } from '../utils/windows-npm-shim.js';
import { assertTestReadablePath } from '../utils/test-path-fence.js';
import type { Diagnostic } from '../output/public-result.js';

export type { Diagnostic } from '../output/public-result.js';
export type Availability = 'available' | 'missing' | 'unsupported' | 'unknown' | 'notApplicable';
export type HostEntry =
  | { kind: 'cli'; executable: string; configRoot: string }
  | { kind: 'directory'; configRoot: string }
  | { kind: 'generic'; root: string };
export interface ProductInstallation {
  id: string;
  product: 'cli' | 'app' | 'generic';
  version: string | null;
  availability: Availability;
  reasonCodes: string[];
  entry: HostEntry | null;
}
export interface DiscoveryResult {
  platform: PlatformTarget;
  availability: Availability;
  installations: ProductInstallation[];
  diagnostics: Diagnostic[];
}
export interface ReadContext {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  signal?: AbortSignal;
  /** Replaces only external process probes, including OS identity queries. */
  runner?: NativeCliRunner;
  codexObservationSession?: import('../utils/codex-native-observation.js').CodexNativeObservationSession;
  /** Explicit status observation may start the supported native app-server. */
  observeNative?: boolean;
  /** Isolated filesystem boundary for App discovery tests. */
  macApplicationsDirectories?: readonly string[];
  windowsApplicationsDirectories?: readonly string[];
  linuxDesktopDirectories?: readonly string[];
}
export interface TargetAvailabilityView extends DiscoveryResult {
  id: PlatformTarget;
  displayName: string;
  selected: boolean;
  recovery: string[];
}
export const TARGET_DISPLAY_NAMES = {
  codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', antigravity: 'Antigravity',
  opencode: 'OpenCode', pi: 'Pi', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI',
  grok: 'Grok Build', generic: 'Generic',
} as const satisfies Record<PlatformTarget, string>;
const cliProfiles = {
  claude: { names: ['claude'], minimum: MINIMUM_AGENT_VERSIONS.claude, identity: /Claude Code/iu, packageName: '@anthropic-ai/claude-code' },
  cursor: { names: ['cursor-agent', 'agent'], minimum: '2026.11.05-86047df', identity: /Cursor(?: Agent)?/iu },
  antigravity: { names: ['agy'], minimum: '1.3.4', identity: /(?:Antigravity|\bagy\b)/iu },
  opencode: { names: ['opencode'], minimum: '2.0.0', identity: /\bopencode\b/iu, packageName: 'opencode-ai' },
  pi: { names: ['pi'], minimum: '1.0.0',
    identity: /(?:pi coding agent|pi-coding-agent)|^pi - AI coding assistant with read, bash, edit, write tools\r?$/imu,
    packageName: '@earendil-works/pi-coding-agent' },
  gemini: { names: ['gemini'], minimum: '0.63.0', identity: /Gemini(?: CLI)?/iu, packageName: '@google/gemini-cli' },
  copilot: { names: ['copilot'], minimum: '1.0.95', identity: /(?:GitHub Copilot|Copilot CLI)/iu, packageName: '@github/copilot' },
  grok: { names: ['grok'], identity: /\bgrok\b/iu, packageName: '@xai-official/grok' },
} as const;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

function diagnostic(platform: PlatformTarget, code: string, message: string): Diagnostic {
  return { code, severity: 'warning', message, subject: { target: platform } };
}
function productId(platform: PlatformTarget, product: ProductInstallation['product'], entry: HostEntry | null, fallback = ''): string {
  return JSON.stringify([platform, product, entry?.kind === 'cli' ? entry.executable : '',
    entry?.kind === 'generic' ? entry.root : entry?.configRoot ?? fallback]);
}
function installation(platform: PlatformTarget, product: ProductInstallation['product'], entry: HostEntry | null,
  availability: Availability, version: string | null, reasonCodes: string[], fallback?: string): ProductInstallation {
  return { id: productId(platform, product, entry, fallback), product, version, availability, reasonCodes, entry };
}
export function resolvePlatformConfigRoot(platform: PlatformTarget, ctx: ReadContext): string {
  const env = ctx.env ?? process.env;
  const home = resolveUserHome(env, ctx.platform ?? process.platform);
  if (platform === 'codex') return getCodexHome(env, ctx.platform);
  if (platform === 'claude') return getClaudeHome(env, ctx.platform);
  if (platform === 'gemini') {
    const root = readEnvironmentValue(env, 'GEMINI_CLI_HOME', ctx.platform) ?? home;
    if (!path.isAbsolute(root) || root.includes('\0')) throw new Error('clientConfigRootInvalid');
    return path.join(root, '.gemini');
  }
  if (platform === 'grok') {
    const root = readEnvironmentValue(env, 'GROK_HOME', ctx.platform) ?? path.join(home, '.grok');
    if (!path.isAbsolute(root) || root.includes('\0')) throw new Error('clientConfigRootInvalid');
    return root;
  }
  if (platform === 'copilot') {
    const root = readEnvironmentValue(env, 'COPILOT_HOME', ctx.platform) ?? path.join(home, '.copilot');
    if (!path.isAbsolute(root) || root.includes('\0')) throw new Error('clientConfigRootInvalid');
    return root;
  }
  if (platform === 'pi') {
    // Pi 1.5 getAgentDir/normalizePath: use only the official override. Relative
    // paths have the same meaning as in the Native invocation's exact cwd.
    const windows = (ctx.platform ?? process.platform) === 'win32';
    const paths = windows ? path.win32 : path.posix;
    let root = readEnvironmentValue(env, 'PI_CODING_AGENT_DIR', ctx.platform) || paths.join(home, '.pi', 'agent');
    if (windows && root.startsWith('/') && !root.startsWith('//') && !root.includes('\\')) {
      const drive = root.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
      if (drive) root = `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? '').replaceAll('/', '\\')}`;
    }
    if (root === '~') root = home;
    else if (root.startsWith('~/') || windows && root.startsWith('~\\')) root = paths.join(home, root.slice(2));
    if (root.startsWith('file://')) root = fileURLToPath(root, { windows });
    if (root.includes('\0')) throw new Error('clientConfigRootInvalid');
    return paths.resolve(ctx.cwd, root);
  }
  if (platform === 'generic') return path.join(home, '.agents', 'skills');
  if (platform === 'opencode') {
    const root = readEnvironmentValue(env, 'XDG_CONFIG_HOME', ctx.platform) ?? path.join(home, '.config');
    if (!path.isAbsolute(root) || root.includes('\0')) throw new Error('clientConfigRootInvalid');
    return path.join(root, 'opencode');
  }
  return path.join(home, platform === 'antigravity' ? '.gemini/config' : `.${platform}`);
}
async function probe(ctx: ReadContext, command: string, args: string[]): Promise<string> {
  ctx.signal?.throwIfAborted();
  const result = await runNativeCli({ command, args, cwd: ctx.cwd, env: ctx.env,
    signal: ctx.signal, timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, ctx.runner);
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_PROBE_OUTPUT_BYTES) {
    throw new Error('probeFailed');
  }
  return `${result.stdout}\n${result.stderr}`;
}
async function present(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
async function cliPaths(names: readonly string[], ctx: ReadContext): Promise<{ paths: string[]; incomplete: boolean }> {
  const os = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const pathValue = readEnvironmentValue(env, 'PATH', os);
  if (pathValue === undefined) return { paths: [], incomplete: false };
  const directories = pathValue.split(os === 'win32' ? ';' : ':');
  const extensions = os === 'win32' ? ['.exe', '.com', '.cmd', '.bat', ''] : [''];
  const result: string[] = [];
  let incomplete = false;
  for (const directory of directories) for (const name of names) {
    for (const extension of extensions) {
      const file = path.resolve(ctx.cwd, directory.replace(/^"|"$/gu, ''), name + extension);
      try {
        if (!await present(file)) continue;
        if (os !== 'win32') await fs.access(file, constants.X_OK);
        result.push(await fs.realpath(file));
        break;
      } catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); incomplete = true; }
    }
  }
  return { paths: [...new Set(result)], incomplete };
}
export async function installationInvocation(product: ProductInstallation, ctx: ReadContext,
  args: string[]): Promise<NativeCliInvocation> {
  if (product.entry?.kind !== 'cli') throw new Error('clientEntryUnavailable');
  const executable = product.entry.executable;
  if (executable.endsWith('.js')) return { command: process.execPath, args: [executable, ...args], cwd: ctx.cwd, env: ctx.env, signal: ctx.signal };
  const commandName = path.basename(executable).replace(/\.(?:cmd|exe|com|bat)$/iu, '');
  const profile = Object.values(cliProfiles).find((candidate) => candidate.names.some((name) => name === commandName));
  if ((ctx.platform ?? process.platform) === 'win32' && profile && 'packageName' in profile) {
    const resolved = await resolveWindowsNpmCommand({ command: executable, packageName: profile.packageName,
      binName: profile.names[0], cwd: ctx.cwd, env: ctx.env });
    return { command: resolved.command, args: [...resolved.argsPrefix, ...args], cwd: ctx.cwd, env: ctx.env, signal: ctx.signal };
  }
  if (/\.(?:cmd|bat)$/iu.test(executable)) throw new Error('clientLauncherUnsupported');
  return { command: executable, args, cwd: ctx.cwd, env: ctx.env, signal: ctx.signal };
}
async function discoverCli(platform: keyof typeof cliProfiles, ctx: ReadContext): Promise<DiscoveryResult> {
  const profile = cliProfiles[platform];
  const products: ProductInstallation[] = [];
  const candidates = await cliPaths(profile.names, ctx);
  const diagnostics: Diagnostic[] = candidates.incomplete ? [diagnostic(platform, 'clientEntryUnresolved',
    'A client entry could not be inspected safely. Repair its permissions or launcher and check again.')] : [];
  for (const executable of candidates.paths) {
    const entry: HostEntry = { kind: 'cli', executable, configRoot: resolvePlatformConfigRoot(platform, ctx) };
    const product = installation(platform, 'cli', entry, 'unknown', null, ['clientProbeFailed']);
    try {
      const invocation = await installationInvocation(product, ctx, ['--version']);
      const versionOutput = await probe(ctx, invocation.command, invocation.args);
      if (!profile.identity.test(versionOutput)) {
        const help = await probe(ctx, invocation.command, [...invocation.args.slice(0, -1), '--help']);
        if (!profile.identity.test(help)) {
          product.reasonCodes = ['clientIdentityUnconfirmed']; throw new Error('clientIdentityUnconfirmed');
        }
      }
      const version = platform === 'cursor' ? versionOutput.match(/\b(\d{4}\.\d{2}\.\d{2}-[a-z0-9]+)\b/u)?.[1] ?? null
        : extractStrictSemVerTokenFromVersionOutput(platform === 'opencode'
          ? versionOutput.replace(/\bopencode\s+v(?=\d)/giu, 'opencode ')
          : platform === 'copilot' ? versionOutput.replace(/^GitHub Copilot CLI ([^\s]+)\.\r?$/gmu, 'GitHub Copilot CLI $1') : versionOutput);
      product.version = version;
      if (!version) {
        product.reasonCodes = ['clientVersionUnknown'];
        if (platform === 'grok') product.availability = 'available';
      }
      else {
        const minimum = 'minimum' in profile ? profile.minimum : undefined;
        const compatible = !minimum || (platform === 'cursor' ? version >= minimum : compareStrictSemVer(version, minimum) >= 0);
        product.availability = compatible ? 'available' : 'unsupported';
        product.reasonCodes = compatible ? [] : ['clientVersionUnsupported'];
      }
      if (platform === 'grok' && product.availability === 'available') {
        // Grok has an interface gate instead of an invented numeric minimum.
        const baseArgs = invocation.args.slice(0, -1);
        const help = await probe(ctx, invocation.command, [...baseArgs, 'plugin', '--help']);
        const list = await probe(ctx, invocation.command, [...baseArgs, 'plugin', 'list', '--help']);
        if (!['install', 'uninstall', 'enable', 'disable'].every((name) => new RegExp(`\\b${name}\\b`, 'u').test(help))
          || !list.includes('--json')) {
          product.availability = 'unsupported'; product.reasonCodes = ['clientInstallInterfaceUnsupported'];
        }
      }
    } catch (error) {
      rethrowFatalError(error);
      ctx.signal?.throwIfAborted();
      diagnostics.push(diagnostic(platform, product.reasonCodes[0]!, 'The client identity, version, or read-only interface could not be confirmed. Repair the client and check again.'));
    }
    products.push(product);
  }
  return result(platform, products, diagnostics);
}
function result(platform: PlatformTarget, installations: ProductInstallation[], diagnostics: Diagnostic[]): DiscoveryResult {
  const states = installations.map((item) => item.availability);
  const availability: Availability = states.includes('available') ? 'available' : states.includes('unknown') || diagnostics.length ? 'unknown'
    : states.includes('unsupported') ? 'unsupported' : states.includes('notApplicable') ? 'notApplicable' : 'missing';
  return { platform, availability, installations, diagnostics };
}
async function discoverCodex(ctx: ReadContext): Promise<DiscoveryResult> {
  const found = await discoverCodexExecutables({ ...ctx, queryRunner: ctx.runner });
  const products: ProductInstallation[] = [];
  for (const candidate of found.candidates) {
    const executable = candidate.manager.argsPrefix[0] ?? candidate.manager.command;
    const entry: HostEntry = { kind: 'cli', executable, configRoot: resolvePlatformConfigRoot('codex', ctx) };
    const product = installation('codex', candidate.manager.kind === 'app' ? 'app' : 'cli', entry, 'unknown', null, ['clientProbeFailed']);
    try {
      const output = await probe(ctx, candidate.manager.command, [...candidate.manager.argsPrefix, '--version']);
      const version = extractStrictSemVerTokenFromVersionOutput(output);
      if (!version || !/\bcodex(?:-cli)?\b/iu.test(output) || candidate.expectedVersion && version !== candidate.expectedVersion) throw new Error('clientIdentityUnconfirmed');
      product.version = version;
      product.availability = compareStrictSemVer(version, MINIMUM_AGENT_VERSIONS.codex) >= 0 ? 'available' : 'unsupported';
      product.reasonCodes = product.availability === 'available' ? [] : ['clientVersionUnsupported'];
    } catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); }
    products.push(product);
  }
  for (const app of found.appsWithoutExecutable ?? []) {
    products.push(installation('codex', 'app', null, 'unsupported', null, ['clientInstallEntryUnavailable'], app));
  }
  for (const executable of found.appExecutables ?? []) {
    if (products.some((product) => product.product === 'app' && product.entry?.kind === 'cli' && product.entry.executable === executable)) continue;
    const shared = products.find((product) => product.entry?.kind === 'cli' && product.entry.executable === executable);
    if (shared) products.push(installation('codex', 'app', shared.entry, shared.availability, shared.version, [...shared.reasonCodes]));
  }
  const diagnostics = found.diagnostics.map(() => diagnostic('codex', 'clientDiscoveryIncomplete', 'Codex discovery could not complete safely. Repair the client entry or check again.'));
  if (found.foundEntry && !products.length && !diagnostics.length) diagnostics.push(diagnostic('codex', 'clientEntryUnresolved', 'A Codex entry exists but could not be resolved safely. Repair the client.'));
  return result('codex', products, diagnostics);
}

const APP_NAMES = { cursor: 'Cursor', antigravity: 'Antigravity', opencode: 'OpenCode' } as const;
type AppPlatform = keyof typeof APP_NAMES;
async function containedFile(root: string, file: string): Promise<string | null> {
  if (!await present(file)) return null;
  const [canonicalRoot, canonicalFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  const relative = path.relative(canonicalRoot, canonicalFile);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('appIdentityUnsafe');
  return canonicalFile;
}
async function smallText(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('appMetadataInvalid');
  return fs.readFile(file, 'utf8');
}
async function appRuntime(platform: AppPlatform, root: string, product: ProductInstallation, ctx: ReadContext): Promise<void> {
  if (platform !== 'opencode') return;
  // Official DesktopCli resolves this packaged resources binary and its version
  // file. It is read in place; AW never stages the executable or starts serve.
  const runtime = await containedFile(path.dirname(root), path.join(root, (ctx.platform ?? process.platform) === 'win32' ? 'opencode-cli.exe' : 'opencode-cli'));
  if (!runtime) { product.availability = 'unsupported'; product.reasonCodes = ['clientLocalRuntimeMissing']; return; }
  if ((ctx.platform ?? process.platform) !== 'win32') await fs.access(runtime, constants.X_OK);
  let version: string | null = null;
  const versionFile = await containedFile(path.dirname(root), path.join(root, 'opencode-cli.version'));
  if (versionFile) {
    const value = (await smallText(versionFile)).trim();
    version = extractStrictSemVerTokenFromVersionOutput(value) === value ? value : null;
  } else {
    const output = await probe(ctx, runtime, ['--version']);
    if (/\bopencode\b/iu.test(output)) version = extractStrictSemVerTokenFromVersionOutput(output.replace(/\bopencode\s+v(?=\d)/giu, 'opencode '));
  }
  if (!version) { product.availability = 'unknown'; product.reasonCodes = ['clientRuntimeVersionUnknown']; return; }
  product.version = version;
  product.availability = compareStrictSemVer(version, '2.0.0') >= 0 ? 'available' : 'unsupported';
  product.reasonCodes = product.availability === 'available' ? [] : ['clientRuntimeVersionUnsupported'];
  const remote = readEnvironmentValue(ctx.env ?? process.env, 'OPENCODE_SERVER_URL', ctx.platform);
  if (remote) {
    let local = false;
    try { local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(remote).hostname); } catch { /* Unknown endpoint is not a local runtime. */ }
    if (!local) { product.availability = 'unknown'; product.reasonCodes = ['clientLocalRuntimeUnconfirmed']; }
  }
}
function appProduct(platform: AppPlatform, root: string, ctx: ReadContext): ProductInstallation {
  const entry: HostEntry = { kind: 'directory', configRoot: resolvePlatformConfigRoot(platform, ctx) };
  const product = installation(platform, 'app', entry, 'unknown', null, ['clientVersionUnknown']);
  product.id = JSON.stringify([platform, 'app', root, entry.configRoot]);
  return product;
}
function cursorVersion(product: ProductInstallation, version: string): void {
  const match = version.match(/^(\d+)\.(\d+)(?:\.\d+)?$/u);
  if (!match) return;
  product.version = version;
  product.availability = Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 29 ? 'available' : 'unsupported';
  product.reasonCodes = product.availability === 'available' ? [] : ['clientVersionUnsupported'];
}
async function discoverApps(platform: AppPlatform, ctx: ReadContext): Promise<{ installations: ProductInstallation[]; diagnostics: Diagnostic[] }> {
  const installations: ProductInstallation[] = [];
  const diagnostics: Diagnostic[] = [];
  const os = ctx.platform ?? process.platform;
  const recordFailure = (error: unknown) => { rethrowFatalError(error); ctx.signal?.throwIfAborted();
    diagnostics.push(diagnostic(platform, 'appDiscoveryIncomplete', 'The App identity or local runtime could not be inspected safely. Repair the App and check again.')); };
  if (os === 'darwin') {
    const directories = ctx.macApplicationsDirectories ?? [path.join(resolveUserHome(ctx.env ?? process.env, os), 'Applications'), '/Applications'];
    for (const directory of directories) {
      const bundle = path.join(directory, `${APP_NAMES[platform]}.app`);
      let product: ProductInstallation | undefined;
      try {
        assertTestReadablePath(bundle, 'App discovery', 'Use isolated macApplicationsDirectories for App discovery.');
        const plist = await containedFile(bundle, path.join(bundle, 'Contents', 'Info.plist'));
        if (!plist) continue;
        const canonicalBundle = await fs.realpath(bundle);
        product = appProduct(platform, canonicalBundle, ctx);
        installations.push(product);
        const read = async (key: string) => (await probe(ctx, '/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).trim();
        const identity = await read('CFBundleIdentifier');
        if (platform === 'cursor' && identity !== 'com.todesktop.230313mzl4w4u92'
          || platform === 'opencode' && identity !== 'ai.opencode.desktop') { installations.pop(); continue; }
        if (platform === 'antigravity' && (!identity.startsWith('com.google.') || await read('CFBundleName') !== 'Antigravity')) { installations.pop(); continue; }
        if (platform === 'antigravity') {
          // The official App is distributed into Applications. Validate the
          // sealed Google application, rather than treating a display name as identity.
          product.reasonCodes = ['appIdentityUnconfirmed'];
          await probe(ctx, '/usr/bin/codesign', ['--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.O] = "Google LLC"', canonicalBundle]);
          const signature = await probe(ctx, '/usr/bin/codesign', ['--display', '--verbose=2', canonicalBundle]);
          if (!/Authority=Developer ID Application: Google LLC \(/u.test(signature)
            || !signature.split(/\r?\n/u).includes(`Identifier=${identity}`)) continue;
          product.availability = 'available'; product.reasonCodes = [];
          try { product.version = extractStrictSemVerTokenFromVersionOutput(await read('CFBundleShortVersionString')); }
          catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); }
        } else if (platform === 'cursor') cursorVersion(product, await read('CFBundleShortVersionString'));
        else await appRuntime(platform, path.join(canonicalBundle, 'Contents', 'Resources'), product, ctx);
      } catch (error) { if (product) { product.availability = 'unknown'; product.reasonCodes = ['appIdentityOrRuntimeUnconfirmed']; } recordFailure(error); }
    }
  } else if (os === 'win32' && platform !== 'antigravity') {
    const env = ctx.env ?? process.env;
    const directories = ctx.windowsApplicationsDirectories ?? [
      readEnvironmentValue(env, 'LOCALAPPDATA', os) ? path.join(readEnvironmentValue(env, 'LOCALAPPDATA', os)!, 'Programs') : undefined,
      readEnvironmentValue(env, 'ProgramFiles', os),
    ].filter((entry): entry is string => Boolean(entry));
    for (const directory of directories) {
      const root = path.join(directory, platform === 'cursor' ? 'cursor' : 'OpenCode');
      let product: ProductInstallation | undefined;
      try {
        const executable = await containedFile(root, path.join(root, `${APP_NAMES[platform]}.exe`));
        if (!executable) continue;
        product = appProduct(platform, await fs.realpath(root), ctx);
        installations.push(product);
        const metadata = JSON.parse(await probe({ ...ctx, env: { ...env, AW_DISCOVERY_EXECUTABLE: executable } }, 'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:AW_DISCOVERY_EXECUTABLE).VersionInfo | Select-Object ProductName,ProductVersion,OriginalFilename | ConvertTo-Json -Compress'])) as Record<string, unknown>;
        if (metadata.ProductName !== APP_NAMES[platform] || typeof metadata.OriginalFilename !== 'string'
          || metadata.OriginalFilename.toLowerCase() !== `${APP_NAMES[platform]}.exe`.toLowerCase()) {
          product.reasonCodes = ['appIdentityUnconfirmed']; continue;
        }
        if (platform === 'cursor' && typeof metadata.ProductVersion === 'string') cursorVersion(product, metadata.ProductVersion);
        else if (platform === 'opencode') await appRuntime(platform, path.join(root, 'resources'), product, ctx);
      } catch (error) { if (product) { product.availability = 'unknown'; product.reasonCodes = ['appIdentityOrRuntimeUnconfirmed']; } recordFailure(error); }
    }
    if (!directories.length) diagnostics.push(diagnostic(platform, 'appDiscoveryUnverified', 'The official Windows installation roots could not be resolved.'));
  } else if (os === 'linux' && platform !== 'antigravity') {
    const env = ctx.env ?? process.env;
    const dataHome = readEnvironmentValue(env, 'XDG_DATA_HOME', os) ?? path.join(resolveUserHome(env, os), '.local', 'share');
    const directories = ctx.linuxDesktopDirectories ?? [path.join(dataHome, 'applications'), '/usr/local/share/applications', '/usr/share/applications'];
    for (const directory of directories) {
      const desktop = path.join(directory, platform === 'opencode' ? 'ai.opencode.desktop.desktop' : 'cursor.desktop');
      let product: ProductInstallation | undefined;
      try {
        if (!await present(desktop)) continue;
        const metadata = await smallText(desktop);
        if (platform === 'opencode' ? !/^StartupWMClass=ai\.opencode\.desktop$/mu.test(metadata) || !/^Name=OpenCode$/mu.test(metadata)
          : !/^StartupWMClass=Cursor$/mu.test(metadata) || !/^Name=Cursor$/mu.test(metadata)) continue;
        const command = metadata.match(/^Exec=(?:"([^"\n]+)"|([^\s]+))/mu);
        const executable = command?.[1] ?? command?.[2];
        product = appProduct(platform, await fs.realpath(desktop), ctx);
        installations.push(product);
        if (!executable || !path.isAbsolute(executable) || !await present(executable)) {
          product.reasonCodes = ['clientLocalRuntimeUnconfirmed']; continue;
        }
        const root = path.dirname(await fs.realpath(executable));
        if (platform === 'opencode') await appRuntime(platform, path.join(root, 'resources'), product, ctx);
        else {
          const manifest = await containedFile(root, path.join(root, 'resources', 'app', 'product.json'));
          const packageFile = await containedFile(root, path.join(root, 'resources', 'app', 'package.json'));
          if (!manifest || !packageFile) { product.reasonCodes = ['appIdentityUnconfirmed']; continue; }
          const identity = JSON.parse(await smallText(manifest)) as Record<string, unknown>;
          if (identity.applicationName !== 'cursor' || identity.nameShort !== 'Cursor') { product.reasonCodes = ['appIdentityUnconfirmed']; continue; }
          const pkg = JSON.parse(await smallText(packageFile)) as Record<string, unknown>;
          if (typeof pkg.version === 'string') cursorVersion(product, pkg.version);
        }
      } catch (error) { if (product) { product.availability = 'unknown'; product.reasonCodes = ['appIdentityOrRuntimeUnconfirmed']; } recordFailure(error); }
    }
  } else diagnostics.push(diagnostic(platform, 'appDiscoveryUnverified', 'This OS has no verified bounded discovery entry for the official App. Check the App settings or use a supported CLI.'));
  return { installations, diagnostics };
}

export async function discoverPlatform(platform: PlatformTarget, ctx: ReadContext): Promise<DiscoveryResult> {
  try {
    ctx.signal?.throwIfAborted();
    if (platform === 'generic') {
      const entry: HostEntry = { kind: 'generic', root: resolvePlatformConfigRoot(platform, ctx) };
      return result(platform, [installation(platform, 'generic', entry, 'notApplicable', null, ['clientNotApplicable'])], []);
    }
    if (platform === 'codex') return await discoverCodex(ctx);
    const cli = await discoverCli(platform, ctx);
    if (platform === 'cursor' || platform === 'antigravity' || platform === 'opencode') {
      const app = await discoverApps(platform, ctx);
      return result(platform, [...cli.installations, ...app.installations], [...cli.diagnostics, ...app.diagnostics]);
    }
    return cli;
  } catch (error) {
    rethrowFatalError(error);
    ctx.signal?.throwIfAborted();
    return result(platform, [], [diagnostic(platform, 'clientDiscoveryIncomplete', 'The client discovery could not complete. Check permissions and retry.')]);
  }
}
export async function discoverPlatforms(ctx: ReadContext): Promise<DiscoveryResult[]> {
  return Promise.all(PLATFORM_TARGETS.map((platform) => discoverPlatform(platform, ctx)));
}
export function targetAvailabilityViews(discovery: readonly DiscoveryResult[], selected: readonly PlatformTarget[]): TargetAvailabilityView[] {
  return discovery.map((item) => ({ ...item, id: item.platform, displayName: TARGET_DISPLAY_NAMES[item.platform], selected: selected.includes(item.platform),
    recovery: item.availability === 'available' ? [] : item.availability === 'notApplicable' ? ['General output. No client is required.']
      : [`Install or repair ${TARGET_DISPLAY_NAMES[item.platform]}, then check again.`, 'Forced selection saves the preference. It does not bypass installation requirements.'] }));
}
export function requiresTargetConfirmation(availability: Availability): boolean {
  return availability !== 'available' && availability !== 'notApplicable';
}
export class TargetSelectionConfirmationRequiredError extends Error {
  constructor(readonly availability: TargetAvailabilityView[]) {
    super('targetSelectionConfirmationRequired');
    this.name = 'TargetSelectionConfirmationRequiredError';
  }
}
