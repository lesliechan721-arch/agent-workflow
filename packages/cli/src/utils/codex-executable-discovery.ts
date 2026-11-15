import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import { tryParseStrictSemVer } from './manifest.js';
import { NativeCliError, type CodexManager, type NativeCliRunner } from './native-cli.js';
import { readEnvironmentValue, resolveUserHome } from './state-paths.js';

export interface CodexExecutableDiscoveryOptions {
  arch?: NodeJS.Architecture;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** Controlled OS query boundary; it does not replace CLI version probes. */
  queryRunner?: NativeCliRunner;
  /** Override standard App locations for isolated filesystem tests. */
  macApplicationsDirectories?: readonly string[];
}

export interface CodexExecutableCandidate {
  manager: CodexManager;
  expectedVersion?: string;
}

export interface CodexExecutableDiscovery {
  candidates: CodexExecutableCandidate[];
  diagnostics: string[];
  foundEntry: boolean;
  appsWithoutExecutable?: string[];
  appExecutables?: string[];
}

type CodexDiscoveryTestOverrides = Pick<CodexExecutableDiscoveryOptions, 'macApplicationsDirectories' | 'queryRunner'>;
let discoveryOverridesForTests: CodexDiscoveryTestOverrides | undefined;

export function setCodexDiscoveryOverridesForTests(overrides: CodexDiscoveryTestOverrides | undefined): void {
  discoveryOverridesForTests = overrides;
}

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_QUERY_TIMEOUT_MS = 30_000;
const MAX_WINDOWS_SEARCH_DEPTH = 16;
const MAX_WINDOWS_SEARCH_ENTRIES = 50_000;
const PACKAGE_NAME = '@openai/codex';

const queryRunner: NativeCliRunner = async (invocation) => {
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    timeout: invocation.timeoutMs ?? QUERY_TIMEOUT_MS,
    signal: invocation.signal,
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
};

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function diagnostic(discovery: CodexExecutableDiscovery, message: string): void {
  if (!discovery.diagnostics.includes(message)) discovery.diagnostics.push(message);
}

export function rethrowFatalError(error: unknown): void {
  if (error instanceof NativeCliError && (
    error.reason === 'aborted' || error.cleanupError || error.name === 'AbortError'
  )) {
    const { code, safeMessage } = error.operationDiagnostic;
    error.message = `${code}: ${safeMessage}${error.cleanupError ? ' Native CLI cleanup could not be confirmed.' : ''}`;
    throw error;
  }
  if (error instanceof Error && error.name === 'AbortError') throw error;
}

async function statIfPresent(target: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

function manager(command: string, kind: 'system' | 'app', argsPrefix: string[] = []): CodexManager {
  return { kind, command, argsPrefix, version: 'unknown' };
}

function executableNames(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['codex'];
  const pathExt = readEnvironmentValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD';
  const supported = new Set(['.com', '.exe', '.bat', '.cmd']);
  const extensions = pathExt.split(';').map((entry) => entry.trim())
    .filter((entry) => supported.has(entry.toLowerCase()));
  return [
    ...extensions.filter((entry) => ['.com', '.exe'].includes(entry.toLowerCase())),
    ...extensions.filter((entry) => ['.bat', '.cmd'].includes(entry.toLowerCase())),
  ].map((extension) => `codex${extension}`).concat('codex');
}

async function codexNpmLauncher(packageRoot: string): Promise<{
  packageRoot: string;
  launcher: string;
  version: string;
}> {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const launcherPath = path.join(packageRoot, 'bin', 'codex.js');
  const [packageStats, metadataStats, launcherStats] = await Promise.all([
    fs.lstat(packageRoot), fs.lstat(packageJsonPath), fs.lstat(launcherPath),
  ]);
  if (
    !packageStats.isDirectory() || packageStats.isSymbolicLink()
    || !metadataStats.isFile() || metadataStats.isSymbolicLink()
    || !launcherStats.isFile() || launcherStats.isSymbolicLink()
  ) throw new Error('Invalid npm file tree.');
  const [packagePath, metadata, launcher] = await Promise.all([
    fs.realpath(packageRoot),
    fs.realpath(packageJsonPath), fs.realpath(launcherPath),
  ]);
  if (!inside(packagePath, metadata) || !inside(packagePath, launcher)) {
    throw new Error('Invalid npm path boundary.');
  }
  const value: unknown = await fs.readJson(metadata);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid npm metadata.');
  const record = value as Record<string, unknown>;
  const bin = record.bin;
  if (
    record.name !== PACKAGE_NAME || typeof record.version !== 'string'
    || !tryParseStrictSemVer(record.version)
    || !bin || typeof bin !== 'object' || Array.isArray(bin)
    || (bin as Record<string, unknown>).codex !== 'bin/codex.js'
  ) throw new Error('Invalid npm launcher contract.');
  return { packageRoot: packagePath, launcher, version: record.version };
}

async function windowsNpmCandidate(shimPath: string): Promise<CodexExecutableCandidate> {
  const shimStats = await fs.lstat(shimPath);
  if (!shimStats.isFile() || shimStats.isSymbolicLink()) throw new Error('Invalid npm file tree.');
  const prefixRoot = path.dirname(shimPath);
  const npm = await codexNpmLauncher(path.join(prefixRoot, 'node_modules', '@openai', 'codex'));
  if (!inside(await fs.realpath(prefixRoot), npm.packageRoot)) throw new Error('Invalid npm path boundary.');
  return { manager: manager(process.execPath, 'system', [npm.launcher]), expectedVersion: npm.version };
}

async function posixPathCandidate(canonical: string): Promise<CodexExecutableCandidate> {
  if (path.basename(canonical) === 'codex.js' && path.basename(path.dirname(canonical)) === 'bin') {
    try {
      const npm = await codexNpmLauncher(path.dirname(path.dirname(canonical)));
      if (npm.launcher === canonical) {
        return { manager: manager(process.execPath, 'system', [npm.launcher]), expectedVersion: npm.version };
      }
    } catch (error) {
      rethrowFatalError(error);
      // An unverified or custom launcher retains its original direct invocation.
    }
  }
  return { manager: manager(canonical, 'system') };
}

async function discoverPath(
  options: CodexExecutableDiscoveryOptions,
  discovery: CodexExecutableDiscovery,
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const pathValue = readEnvironmentValue(env, 'PATH', platform);
  if (pathValue === undefined) return;
  const directories = pathValue.split(platform === 'win32' ? ';' : ':');
  for (const entry of directories) {
    options.signal?.throwIfAborted();
    const directory = path.resolve(cwd, entry.replace(/^"|"$/gu, '') || '.');
    for (const name of executableNames(env, platform)) {
      const candidate = path.join(directory, name);
      try {
        if (!(await statIfPresent(candidate))?.isFile()) continue;
        discovery.foundEntry = true;
        if (platform === 'win32' && path.extname(candidate).toLowerCase() === '.cmd') {
          discovery.candidates.push(await windowsNpmCandidate(candidate));
        } else {
          if (platform === 'win32' && path.extname(candidate).toLowerCase() === '.bat') {
            throw new Error('Unsupported batch launcher.');
          }
          if (platform !== 'win32') await fs.access(candidate, fsConstants.X_OK);
          const canonical = await fs.realpath(candidate);
          discovery.candidates.push(platform === 'win32'
            ? { manager: manager(canonical, 'system') } : await posixPathCandidate(canonical));
        }
      } catch (error) {
        rethrowFatalError(error);
        discovery.foundEntry = true;
        diagnostic(discovery, 'A PATH Codex entry could not be resolved safely. Repair its launcher or permissions.');
      }
      // Windows extension priority identifies one entry per directory.
      break;
    }
  }
}

async function discoverMacApps(
  options: CodexExecutableDiscoveryOptions,
  discovery: CodexExecutableDiscovery,
): Promise<void> {
  const env = options.env ?? process.env;
  const directories = options.macApplicationsDirectories
    ?? [path.join(resolveUserHome(env, 'darwin'), 'Applications'), '/Applications'];
  for (const directory of directories) {
    for (const name of ['Codex.app', 'ChatGPT.app']) {
      options.signal?.throwIfAborted();
      try {
        const bundlePath = path.join(directory, name);
        const bundleStats = await statIfPresent(bundlePath);
        if (!bundleStats?.isDirectory()) continue;
        const bundle = await fs.realpath(bundlePath);
        const plist = path.join(bundle, 'Contents', 'Info.plist');
        if (!(await statIfPresent(plist))?.isFile()) continue;
        if (!inside(bundle, await fs.realpath(plist))) {
          throw new Error('Invalid bundle metadata.');
        }
        const result = await (options.queryRunner ?? queryRunner)({
          command: '/usr/bin/plutil',
          args: ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist],
          cwd: options.cwd,
          env,
          timeoutMs: QUERY_TIMEOUT_MS,
          signal: options.signal,
        });
        if (result.exitCode !== 0) throw new Error('Bundle identity query failed.');
        if (result.stdout.trim() !== 'com.openai.codex') continue;
        discovery.foundEntry = true;
        const executable = path.join(bundle, 'Contents', 'Resources', 'codex');
        if (!(await statIfPresent(executable))?.isFile()) {
          (discovery.appsWithoutExecutable ??= []).push(bundle);
          continue;
        }
        discovery.foundEntry = true;
        const canonical = await fs.realpath(executable);
        if (!inside(bundle, canonical)) throw new Error('Bundle executable escapes its root.');
        await fs.access(canonical, fsConstants.X_OK);
        (discovery.appExecutables ??= []).push(canonical);
        discovery.candidates.push({ manager: manager(canonical, 'app') });
      } catch (error) {
        rethrowFatalError(error);
        diagnostic(discovery, 'A macOS Codex App could not be inspected safely. Repair the App or use a PATH CLI.');
      }
    }
  }
}

const WINDOWS_PACKAGES_QUERY = [
  "$families = @(Get-StartApps -ErrorAction Stop | Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' } | ForEach-Object { $_.AppID.Substring(0, $_.AppID.Length - 4) } | Sort-Object -Unique)",
  '$packages = @()',
  'if ($families.Count -gt 0) {',
  '  $registered = @(Get-AppxPackage -PackageTypeFilter Main -ErrorAction Stop)',
  '  foreach ($family in $families) {',
  '    foreach ($package in $registered) {',
  '      if ($package.PackageFamilyName -ieq $family) {',
  '        $packages += @{ family = $family; root = $package.InstallLocation; architecture = $package.Architecture.ToString(); version = $package.Version.ToString() }',
  '      }',
  '    }',
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($packages) -Compress -Depth 4',
].join('\n');

const WINDOWS_PATH_QUERY = [
  '$target = [IO.Path]::GetFullPath($env:AW_CODEX_DISCOVERY_PATH)',
  '$current = [IO.Path]::GetPathRoot($target)',
  '$chain = @($current)',
  'foreach ($part in $target.Substring($current.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {',
  '  $current = [IO.Path]::Combine($current, $part)',
  '  $chain += $current',
  '}',
  'foreach ($item in $chain) {',
  '  $entry = Get-Item -LiteralPath $item -Force -ErrorAction Stop',
  "  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe reparse path.' }",
  "  $directory = $item -ne $target -or $env:AW_CODEX_DISCOVERY_KIND -eq 'directory'",
  "  if ($entry.PSIsContainer -ne $directory) { throw 'Invalid path node type.' }",
  '}',
  "'true'",
].join('\n');

async function windowsQuery(
  source: string,
  options: CodexExecutableDiscoveryOptions,
  input: NodeJS.ProcessEnv = {},
): Promise<unknown> {
  const env = options.env ?? process.env;
  const systemRoot = readEnvironmentValue(env, 'SystemRoot', 'win32');
  if (!systemRoot || !path.isAbsolute(systemRoot) || systemRoot.includes('\0')) {
    throw new Error('The Windows system directory is unavailable.');
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Environment]::SetEnvironmentVariable("PSModulePath", [IO.Path]::Combine($PSHOME, "Modules"), "Process")',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    source,
  ].join('\n');
  const result = await (options.queryRunner ?? queryRunner)({
    command: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    cwd: options.cwd,
    env: {
      ...Object.fromEntries(Object.entries(env).filter(([name]) => !['psmodulepath', 'winpsmodulepath'].includes(name.toLowerCase()))),
      ...input,
    },
    timeoutMs: WINDOWS_QUERY_TIMEOUT_MS,
    signal: options.signal,
  });
  if (result.exitCode !== 0) throw new Error('Windows App query failed.');
  return JSON.parse(result.stdout);
}

async function assertWindowsPath(
  target: string,
  kind: 'file' | 'directory',
  options: CodexExecutableDiscoveryOptions,
): Promise<void> {
  if (await windowsQuery(WINDOWS_PATH_QUERY, options, {
    AW_CODEX_DISCOVERY_PATH: target,
    AW_CODEX_DISCOVERY_KIND: kind,
  }) !== true) throw new Error('Unsafe Windows App path.');
}

interface WindowsPackage {
  family: string;
  root: string;
  architecture: string;
  version: string;
}

function windowsArchitecture(options: CodexExecutableDiscoveryOptions): string {
  const env = options.env ?? process.env;
  const raw = options.arch
    ?? readEnvironmentValue(env, 'PROCESSOR_ARCHITEW6432', 'win32')
    ?? readEnvironmentValue(env, 'PROCESSOR_ARCHITECTURE', 'win32')
    ?? process.arch;
  const value = raw.toLowerCase();
  return value === 'amd64' ? 'x64' : value === 'ia32' ? 'x86' : value;
}

function packageOrder(value: WindowsPackage): string {
  return [value.root.toLowerCase(), value.root, value.family.toLowerCase(), value.architecture, value.version].join('\0');
}

async function discoverWindowsApps(
  options: CodexExecutableDiscoveryOptions,
  discovery: CodexExecutableDiscovery,
): Promise<void> {
  let registered: unknown;
  try {
    registered = await windowsQuery(WINDOWS_PACKAGES_QUERY, options);
    if (!Array.isArray(registered)) throw new Error('Invalid registered App query result.');
  } catch (error) {
    rethrowFatalError(error);
    diagnostic(discovery, 'The Windows registered Codex App query failed. Repair App registration or retry the system query.');
    return;
  }
  const architecture = windowsArchitecture(options);
  const packages: WindowsPackage[] = [];
  for (const item of registered as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      diagnostic(discovery, 'A Windows Codex App registration is invalid and was excluded.');
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.family !== 'string' || !/^OpenAI\.Codex_[^!\s]+$/iu.test(record.family)) continue;
    if (
      typeof record.root !== 'string' || !path.isAbsolute(record.root) || record.root.includes('\0')
      || path.normalize(record.root) !== record.root
      || typeof record.architecture !== 'string' || typeof record.version !== 'string'
    ) {
      diagnostic(discovery, 'A Windows Codex App registration is invalid and was excluded.');
      continue;
    }
    if (![architecture, 'neutral'].includes(record.architecture.toLowerCase())) continue;
    packages.push(record as unknown as WindowsPackage);
  }
  packages.sort((left, right) => packageOrder(left) < packageOrder(right) ? -1 : packageOrder(left) > packageOrder(right) ? 1 : 0);
  const roots = new Set<string>();
  let inspected = 0;
  for (const item of packages) {
    options.signal?.throwIfAborted();
    try {
      const rootStats = await fs.lstat(item.root);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Invalid App package root.');
      await assertWindowsPath(item.root, 'directory', options);
      const root = await fs.realpath(item.root);
      if (roots.has(root)) continue;
      roots.add(root);
      discovery.foundEntry = true;
      const candidateCount = discovery.candidates.length;
      const pending = [{ directory: root, depth: 0 }];
      while (pending.length > 0) {
        options.signal?.throwIfAborted();
        const { directory, depth } = pending.pop()!;
        const entries = (await fs.readdir(directory, { withFileTypes: true }))
          .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
          if (++inspected > MAX_WINDOWS_SEARCH_ENTRIES) {
            diagnostic(discovery, 'The Windows Codex App search reached its entry limit. Use a PATH CLI or repair the App.');
            return;
          }
          const target = path.join(directory, entry.name);
          const stats = await fs.lstat(target);
          if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
            diagnostic(discovery, 'An unsafe Windows Codex App path was excluded. Repair the App or use a PATH CLI.');
            continue;
          }
          const canonical = await fs.realpath(target);
          if (!inside(root, canonical)) {
            diagnostic(discovery, 'An unsafe Windows Codex App path was excluded. Repair the App or use a PATH CLI.');
            continue;
          }
          if (stats.isDirectory()) {
            if (depth >= MAX_WINDOWS_SEARCH_DEPTH) {
              diagnostic(discovery, 'The Windows Codex App search reached its depth limit. Use a PATH CLI or repair the App.');
              continue;
            }
            pending.push({ directory: target, depth: depth + 1 });
          } else if (entry.name.toLowerCase() === 'codex.exe') {
            discovery.foundEntry = true;
            try {
              await assertWindowsPath(target, 'file', options);
              (discovery.appExecutables ??= []).push(canonical);
              discovery.candidates.push({ manager: manager(canonical, 'app') });
            } catch (error) {
              rethrowFatalError(error);
              diagnostic(discovery, 'An unsafe Windows Codex App executable was excluded. Repair the App or use a PATH CLI.');
            }
          }
        }
      }
      if (discovery.candidates.length === candidateCount) {
        (discovery.appsWithoutExecutable ??= []).push(root);
      }
    } catch (error) {
      rethrowFatalError(error);
      diagnostic(discovery, 'A Windows Codex App package could not be inspected safely. Repair the App or use a PATH CLI.');
    }
  }
}

export async function discoverCodexExecutables(
  input: CodexExecutableDiscoveryOptions,
): Promise<CodexExecutableDiscovery> {
  const options: CodexExecutableDiscoveryOptions = {
    ...input,
    queryRunner: input.queryRunner ?? discoveryOverridesForTests?.queryRunner,
    macApplicationsDirectories: input.macApplicationsDirectories ?? discoveryOverridesForTests?.macApplicationsDirectories,
  };
  options.signal?.throwIfAborted();
  const discovery: CodexExecutableDiscovery = { candidates: [], diagnostics: [], foundEntry: false };
  await discoverPath(options, discovery);
  const platform = options.platform ?? process.platform;
  try {
    if (platform === 'darwin') await discoverMacApps(options, discovery);
    if (platform === 'win32') await discoverWindowsApps(options, discovery);
  } catch (error) {
    rethrowFatalError(error);
    diagnostic(discovery, 'Codex App discovery could not complete safely. Repair the App or use a PATH CLI.');
  }
  const identities = new Set<string>();
  discovery.candidates = discovery.candidates.filter((candidate) => {
    const { command, argsPrefix } = candidate.manager;
    const identity = JSON.stringify([command, argsPrefix]);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
  return discovery;
}
