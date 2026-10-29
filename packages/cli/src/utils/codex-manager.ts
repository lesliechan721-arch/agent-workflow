import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  AgentVersionProbeResult,
  CodexOperationRequirement,
} from '../types.js';
import {
  extractStrictSemVerTokenFromVersionOutput,
  probeAgentVersion,
} from './agent-version.js';
import { tryParseStrictSemVer } from './manifest.js';
import {
  getDefaultNativeCliRunner,
  runNativeCli,
  type CodexManager,
  type NativeCliRunner,
} from './native-cli.js';
import { getCodexHome, resolveAwHome } from './state-paths.js';

export const MANAGED_CODEX_PACKAGE_NAME = '@openai/codex';
export const MANAGED_CODEX_VERSION = '0.151.0';
export const MANAGED_CODEX_REGISTRY = 'https://registry.npmjs.org/';
export const MANAGED_CODEX_MARKER_FILE = '.aw-managed-runtime.json';

export type CodexManagerErrorCode =
  | 'codexSystemCliUnsupported'
  | 'managedCodexAuthorizationRequired'
  | 'managedCodexUnavailable';

export class CodexManagerError extends Error {
  readonly code: CodexManagerErrorCode;

  constructor(code: CodexManagerErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'CodexManagerError';
    this.code = code;
  }
}

export type ManagedCodexAuthorizer = () => boolean | Promise<boolean>;

export interface CodexManagerOptions {
  arch?: NodeJS.Architecture;
  authorizer?: ManagedCodexAuthorizer;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  operationRequirement?: CodexOperationRequirement;
  platform?: NodeJS.Platform;
  pnpmEntry?: string;
  runner?: NativeCliRunner;
}

export type CodexOperationConsumer =
  | {
      support: 'observed';
      manager: CodexManager;
      requirement: CodexOperationRequirement;
    }
  | {
      support: 'assumed';
      requirement: CodexOperationRequirement;
    };

export interface ResolveCodexOperationConsumerOptions extends CodexManagerOptions {
  operationRequirement: CodexOperationRequirement;
  requiresNativeMaterialization: boolean;
}

export interface InspectSystemCodexOptions {
  runner?: NativeCliRunner;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  operationRequirement: CodexOperationRequirement;
  platform?: NodeJS.Platform;
}

export type SystemCodexInspection =
  | {
      state: 'missing';
      requiredMinVersion: string;
    }
  | {
      state: 'unobserved';
      requiredMinVersion: string;
    }
  | {
      state: 'compatible';
      detectedVersion: string;
      requiredMinVersion: string;
    }
  | {
      state: 'incompatible';
      code: 'codexSystemCliUnsupported';
      detectedVersion: string;
      diagnostic: string;
      requiredMinVersion: string;
    }
  | {
      state: 'unresolved';
      code: 'codexSystemCliUnsupported';
      diagnostic: string;
      requiredMinVersion: string;
    };

export type CodexManagerPreview =
  | { state: 'system' | 'cached'; manager: CodexManager }
  | { state: 'requires-install' }
  | { state: 'blocked'; code: CodexManagerErrorCode; diagnostic: string };

interface ManagedRuntimeMarker {
  schemaVersion: 1;
  owner: 'aw';
  packageName: typeof MANAGED_CODEX_PACKAGE_NAME;
  version: typeof MANAGED_CODEX_VERSION;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}

type ManagedRuntimeInspection =
  | { state: 'absent' }
  | { state: 'valid'; manager: CodexManager }
  | { state: 'rebuildable'; diagnostic: string }
  | { state: 'blocked'; diagnostic: string };

interface CanonicalManagedPackagePaths {
  launcher: string;
  packageJson: string;
}

type ManagedPackagePathInspection =
  | { state: 'complete'; paths: CanonicalManagedPackagePaths }
  | { state: 'incomplete' }
  | { state: 'unsafe'; diagnostic: string };

const requireFromCli = createRequire(import.meta.url);

function managedRuntimeRoot(options: CodexManagerOptions): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return path.join(
    path.resolve(resolveAwHome(env)),
    'runtimes',
    'codex',
    MANAGED_CODEX_VERSION,
    `${platform}-${arch}`,
  );
}

function managedRuntimeAncestors(options: CodexManagerOptions): string[] {
  const awHome = path.resolve(resolveAwHome(options.env ?? process.env));
  return [
    awHome,
    path.join(awHome, 'runtimes'),
    path.join(awHome, 'runtimes', 'codex'),
    path.join(awHome, 'runtimes', 'codex', MANAGED_CODEX_VERSION),
  ];
}

function managedRuntimeMarker(options: CodexManagerOptions): ManagedRuntimeMarker {
  return {
    schemaVersion: 1,
    owner: 'aw',
    packageName: MANAGED_CODEX_PACKAGE_NAME,
    version: MANAGED_CODEX_VERSION,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
  };
}

function managedLauncher(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

function managedPackageRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', '@openai', 'codex');
}

function managedPackageJson(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', '@openai', 'codex', 'package.json');
}

function managerForRuntime(
  runtimeRoot: string,
  launcher: string,
  execPath: string,
): CodexManager {
  return {
    kind: 'aw-managed',
    version: MANAGED_CODEX_VERSION,
    command: execPath,
    argsPrefix: [launcher],
    runtimeRoot,
  };
}

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

async function inspectCanonicalManagedPackagePaths(
  runtimeRoot: string,
): Promise<ManagedPackagePathInspection> {
  const runtimeStats = await lstatOrUndefined(runtimeRoot);
  if (!runtimeStats?.isDirectory() || runtimeStats.isSymbolicLink()) {
    return { state: 'unsafe', diagnostic: 'The managed runtime root is not a regular directory.' };
  }

  let canonicalRuntimeRoot: string;
  try {
    canonicalRuntimeRoot = await fs.realpath(runtimeRoot);
  } catch {
    return { state: 'incomplete' };
  }

  const candidates = [
    ['package root', managedPackageRoot(runtimeRoot), 'directory'],
    ['package.json', managedPackageJson(runtimeRoot), 'file'],
    ['launcher', managedLauncher(runtimeRoot), 'file'],
  ] as const;
  const canonicalPaths: string[] = [];
  let canonicalPackageRoot: string | undefined;

  for (const [label, candidatePath, expectedKind] of candidates) {
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'incomplete' };
      throw error;
    }
    const containmentRoot = canonicalPackageRoot ?? canonicalRuntimeRoot;
    if (!isPathWithin(containmentRoot, canonicalPath)) {
      return {
        state: 'unsafe',
        diagnostic: `The managed Codex ${label} resolves outside its managed ${canonicalPackageRoot ? 'package root' : 'runtime'}.`,
      };
    }
    const stats = await fs.stat(canonicalPath);
    if (expectedKind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
      return { state: 'incomplete' };
    }
    if (label === 'package root') canonicalPackageRoot = canonicalPath;
    canonicalPaths.push(canonicalPath);
  }

  return {
    state: 'complete',
    paths: {
      packageJson: canonicalPaths[1]!,
      launcher: canonicalPaths[2]!,
    },
  };
}

async function lstatOrUndefined(targetPath: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function inspectRegularDirectoryChain(
  paths: readonly string[],
): Promise<{ state: 'complete' | 'missing' } | { state: 'blocked'; diagnostic: string }> {
  for (const targetPath of paths) {
    const stats = await lstatOrUndefined(targetPath);
    if (!stats) return { state: 'missing' };
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return {
        state: 'blocked',
        diagnostic: `The managed runtime path chain contains a non-directory or symbolic link: ${targetPath}.`,
      };
    }
  }
  return { state: 'complete' };
}

async function ensureRegularManagedRuntimeAncestors(options: CodexManagerOptions): Promise<void> {
  for (const targetPath of managedRuntimeAncestors(options)) {
    const stats = await lstatOrUndefined(targetPath);
    if (!stats) await fs.mkdir(targetPath);
    const current = await lstatOrUndefined(targetPath);
    if (!current?.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`The managed runtime path chain is not a regular directory: ${targetPath}.`);
    }
  }
}

async function assertManagedStoreDirectory(options: CodexManagerOptions): Promise<string> {
  const storeRoot = path.join(
    path.resolve(resolveAwHome(options.env ?? process.env)),
    'runtimes',
    '.pnpm-store',
  );
  const stats = await lstatOrUndefined(storeRoot);
  if (!stats) {
    await fs.mkdir(storeRoot);
  } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('The AW-managed pnpm store path is not a regular directory.');
  }
  const current = await lstatOrUndefined(storeRoot);
  if (!current?.isDirectory() || current.isSymbolicLink()) {
    throw new Error('The AW-managed pnpm store path is not a regular directory.');
  }
  return storeRoot;
}

function isExpectedMarker(value: unknown, expected: ManagedRuntimeMarker): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.schemaVersion === expected.schemaVersion
    && marker.owner === expected.owner
    && marker.packageName === expected.packageName
    && marker.version === expected.version
    && marker.platform === expected.platform
    && marker.arch === expected.arch;
}

async function runManagedVersionCheck(
  launcher: string,
  options: CodexManagerOptions,
): Promise<string | undefined> {
  const runner = options.runner ?? getDefaultNativeCliRunner();
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  try {
    const result = await runNativeCli({
      command: execPath,
      args: [launcher, '--version'],
      agentKind: 'codex',
      cwd: options.cwd,
      env: { ...env, CODEX_HOME: getCodexHome(env) },
    }, runner);
    if (result.exitCode !== 0) return undefined;
    return extractStrictSemVerTokenFromVersionOutput(`${result.stdout}\n${result.stderr}`)
      ?? undefined;
  } catch {
    return undefined;
  }
}

async function inspectManagedCodexRuntime(
  options: CodexManagerOptions,
): Promise<ManagedRuntimeInspection> {
  const runtimeRoot = managedRuntimeRoot(options);
  try {
    const pathChain = await inspectRegularDirectoryChain([
      ...managedRuntimeAncestors(options),
      runtimeRoot,
    ]);
    if (pathChain.state === 'missing') return { state: 'absent' };
    if (pathChain.state === 'blocked') return pathChain;

    const markerPath = path.join(runtimeRoot, MANAGED_CODEX_MARKER_FILE);
    const markerStats = await lstatOrUndefined(markerPath);
    if (!markerStats?.isFile() || markerStats.isSymbolicLink()) {
      return { state: 'blocked', diagnostic: 'The managed runtime has no valid AW owner marker.' };
    }
    const marker = await fs.readJson(markerPath).catch(() => undefined);
    if (!isExpectedMarker(marker, managedRuntimeMarker(options))) {
      return { state: 'blocked', diagnostic: 'The managed runtime has an invalid AW owner marker.' };
    }

    const packagePaths = await inspectCanonicalManagedPackagePaths(runtimeRoot);
    if (packagePaths.state === 'incomplete') {
      return { state: 'rebuildable', diagnostic: 'The AW-owned managed runtime is incomplete.' };
    }
    if (packagePaths.state === 'unsafe') {
      return { state: 'blocked', diagnostic: packagePaths.diagnostic };
    }
    const packageJson = await fs.readJson(packagePaths.paths.packageJson).catch(() => undefined) as
      | { name?: unknown; version?: unknown }
      | undefined;
    if (
      packageJson?.name !== MANAGED_CODEX_PACKAGE_NAME
      || packageJson.version !== MANAGED_CODEX_VERSION
    ) {
      return { state: 'rebuildable', diagnostic: 'The AW-owned managed runtime package does not match the pinned package.' };
    }
    const detectedVersion = await runManagedVersionCheck(packagePaths.paths.launcher, options);
    if (detectedVersion !== MANAGED_CODEX_VERSION) {
      return { state: 'rebuildable', diagnostic: 'The AW-owned managed runtime failed its version self-check.' };
    }
    return {
      state: 'valid',
      manager: managerForRuntime(
        runtimeRoot,
        packagePaths.paths.launcher,
        options.execPath ?? process.execPath,
      ),
    };
  } catch (error) {
    return {
      state: 'blocked',
      diagnostic: `The managed runtime cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function assertAwOwnedRuntimeBeforeReplacement(
  runtimeRoot: string,
  options: CodexManagerOptions,
): Promise<void> {
  const chain = await inspectRegularDirectoryChain([
    ...managedRuntimeAncestors(options),
    runtimeRoot,
  ]);
  if (chain.state !== 'complete') {
    throw new Error(chain.state === 'blocked' ? chain.diagnostic : 'The managed runtime disappeared before replacement.');
  }
  const markerPath = path.join(runtimeRoot, MANAGED_CODEX_MARKER_FILE);
  const markerStats = await lstatOrUndefined(markerPath);
  const marker = markerStats?.isFile() && !markerStats.isSymbolicLink()
    ? await fs.readJson(markerPath).catch(() => undefined)
    : undefined;
  if (!isExpectedMarker(marker, managedRuntimeMarker(options))) {
    throw new Error('The managed runtime owner marker changed before replacement.');
  }
}

async function resolveBundledPnpmEntry(): Promise<string | undefined> {
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromCli.resolve('pnpm');
  } catch {
    return undefined;
  }
  const packageJson = await fs.readJson(packageJsonPath).catch(() => undefined) as
    | { name?: unknown; version?: unknown }
    | undefined;
  if (packageJson?.name !== 'pnpm' || packageJson.version !== '10.33.0') return undefined;
  const entry = path.join(path.dirname(packageJsonPath), 'bin', 'pnpm.cjs');
  const stats = await lstatOrUndefined(entry);
  return stats?.isFile() && !stats.isSymbolicLink() ? entry : undefined;
}

function neutralPnpmEnv(env: NodeJS.ProcessEnv, userConfigPath: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toLowerCase().startsWith('npm_config_')) result[key] = value;
  }
  result.npm_config_userconfig = userConfigPath;
  result.NPM_CONFIG_USERCONFIG = userConfigPath;
  return result;
}

async function validateAcquiredRuntime(
  stagingRoot: string,
  options: CodexManagerOptions,
): Promise<void> {
  const packagePaths = await inspectCanonicalManagedPackagePaths(stagingRoot);
  const packageJson = packagePaths.state === 'complete'
    ? await fs.readJson(packagePaths.paths.packageJson).catch(() => undefined) as
      | { name?: unknown; version?: unknown }
      | undefined
    : undefined;
  if (
    packagePaths.state !== 'complete'
    || packageJson?.name !== MANAGED_CODEX_PACKAGE_NAME
    || packageJson.version !== MANAGED_CODEX_VERSION
  ) {
    throw new Error('The installed Codex package does not match the pinned package and launcher contract.');
  }

  const runner = options.runner ?? getDefaultNativeCliRunner();
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const invocationBase = {
    command: execPath,
    agentKind: 'codex' as const,
    cwd: options.cwd,
    env: { ...env, CODEX_HOME: getCodexHome(env) },
  };
  const versionResult = await runNativeCli({
    ...invocationBase,
    args: [packagePaths.paths.launcher, '--version'],
  }, runner);
  const detectedVersion = extractStrictSemVerTokenFromVersionOutput(
    `${versionResult.stdout}\n${versionResult.stderr}`,
  );
  if (versionResult.exitCode !== 0 || detectedVersion !== MANAGED_CODEX_VERSION) {
    throw new Error('The installed Codex package failed its version self-check.');
  }
  const helpResult = await runNativeCli({
    ...invocationBase,
    args: [packagePaths.paths.launcher, 'plugin', '--help'],
  }, runner);
  if (helpResult.exitCode !== 0) {
    throw new Error('The installed Codex package failed its plugin help self-check.');
  }
}

async function adoptManagedRuntime(
  stagingRoot: string,
  options: CodexManagerOptions,
): Promise<CodexManager> {
  const runtimeRoot = managedRuntimeRoot(options);
  const current = await inspectManagedCodexRuntime(options);
  if (current.state === 'valid') return current.manager;
  if (current.state === 'blocked') throw new Error(current.diagnostic);
  if (current.state === 'absent') {
    const parentChain = await inspectRegularDirectoryChain(managedRuntimeAncestors(options));
    if (parentChain.state !== 'complete' || await lstatOrUndefined(runtimeRoot)) {
      throw new Error('The managed runtime path changed before adoption.');
    }
    await fs.rename(stagingRoot, runtimeRoot);
    const packagePaths = await inspectCanonicalManagedPackagePaths(runtimeRoot);
    if (packagePaths.state !== 'complete') {
      throw new Error('The managed runtime changed during adoption.');
    }
    return managerForRuntime(
      runtimeRoot,
      packagePaths.paths.launcher,
      options.execPath ?? process.execPath,
    );
  }

  const backupRoot = path.join(path.dirname(runtimeRoot), `.${path.basename(runtimeRoot)}.replaced-${randomUUID()}`);
  await assertAwOwnedRuntimeBeforeReplacement(runtimeRoot, options);
  await fs.rename(runtimeRoot, backupRoot);
  try {
    await fs.rename(stagingRoot, runtimeRoot);
  } catch (error) {
    await assertAwOwnedRuntimeBeforeReplacement(backupRoot, options);
    await fs.rename(backupRoot, runtimeRoot).catch(() => undefined);
    throw error;
  }
  await assertAwOwnedRuntimeBeforeReplacement(backupRoot, options);
  await fs.remove(backupRoot).catch(() => undefined);
  const packagePaths = await inspectCanonicalManagedPackagePaths(runtimeRoot);
  if (packagePaths.state !== 'complete') {
    throw new Error('The managed runtime changed during adoption.');
  }
  return managerForRuntime(
    runtimeRoot,
    packagePaths.paths.launcher,
    options.execPath ?? process.execPath,
  );
}

async function acquireManagedCodexRuntime(options: CodexManagerOptions): Promise<CodexManager> {
  const runtimeRoot = managedRuntimeRoot(options);
  const runtimeParent = path.dirname(runtimeRoot);
  const pnpmEntry = options.pnpmEntry ?? await resolveBundledPnpmEntry();
  if (!pnpmEntry) throw new Error('The bundled pnpm@10.33.0 entry is unavailable.');
  await ensureRegularManagedRuntimeAncestors(options);
  const storeRoot = await assertManagedStoreDirectory(options);
  const stagingRoot = await fs.mkdtemp(path.join(runtimeParent, `.${path.basename(runtimeRoot)}.staging-`));
  try {
    await fs.writeJson(path.join(stagingRoot, 'package.json'), {
      private: true,
      dependencies: { [MANAGED_CODEX_PACKAGE_NAME]: MANAGED_CODEX_VERSION },
    }, { spaces: 2 });
    const neutralUserConfig = path.join(stagingRoot, '.npmrc');
    const runner = options.runner ?? getDefaultNativeCliRunner();
    const env = options.env ?? process.env;
    const installResult = await runNativeCli({
      command: options.execPath ?? process.execPath,
      args: [
        pnpmEntry,
        'install',
        '--prod',
        '--ignore-scripts',
        '--ignore-workspace',
        // Adoption renames staging; absolute Windows junctions would retain its old path.
        '--config.node-linker=hoisted',
        `--registry=${MANAGED_CODEX_REGISTRY}`,
        `--store-dir=${storeRoot}`,
        `--config.userconfig=${neutralUserConfig}`,
      ],
      cwd: stagingRoot,
      env: neutralPnpmEnv(env, neutralUserConfig),
    }, runner);
    if (installResult.exitCode !== 0) {
      throw new Error('pnpm could not install the pinned Codex package.');
    }
    await validateAcquiredRuntime(stagingRoot, options);
    await fs.writeJson(
      path.join(stagingRoot, MANAGED_CODEX_MARKER_FILE),
      managedRuntimeMarker(options),
      { spaces: 2 },
    );
    return await adoptManagedRuntime(stagingRoot, options);
  } finally {
    await fs.remove(stagingRoot).catch(() => undefined);
  }
}

function readPathEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env.PATH;
  const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path');
  return pathEntry?.[1];
}

function executableNames(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'win32') return [command];
  const pathExt = Object.entries(env)
    .find(([key]) => key.toLowerCase() === 'pathext')?.[1]
    ?? '.COM;.EXE;.BAT;.CMD';
  const supportedExtensions = new Set(['.com', '.exe', '.bat', '.cmd']);
  const extensions = pathExt.split(';')
    .map((extension) => extension.trim())
    .filter((extension) => supportedExtensions.has(extension.toLowerCase()));
  const orderedExtensions = [
    ...extensions.filter((extension) => ['.com', '.exe'].includes(extension.toLowerCase())),
    ...extensions.filter((extension) => ['.bat', '.cmd'].includes(extension.toLowerCase())),
  ];
  return [...orderedExtensions.map((extension) => `${command}${extension}`), command];
}

type SystemCommandManagerResolution =
  | { state: 'supported'; manager: CodexManager; expectedVersion?: string }
  | { state: 'unsupported'; diagnostic: string };

function unsupportedSystemResolution(
  reason: string,
): Extract<SystemCommandManagerResolution, { state: 'unsupported' }> {
  return {
    state: 'unsupported',
    diagnostic: `The installed system Codex CLI is not supported. ${reason} Install or upgrade the official Codex CLI, or remove the invalid shim and retry; AW does not use managed fallback for this installation.`,
  };
}

async function resolveWindowsNpmCodexManager(
  shimPath: string,
): Promise<SystemCommandManagerResolution> {
  try {
    const shimStats = await fs.lstat(shimPath);
    if (!shimStats.isFile() || shimStats.isSymbolicLink()) {
      return unsupportedSystemResolution('The Windows npm shim is not a regular file.');
    }

    const prefixRoot = path.dirname(shimPath);
    const packageRoot = path.join(prefixRoot, 'node_modules', '@openai', 'codex');
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const launcherPath = path.join(packageRoot, 'bin', 'codex.js');
    const [packageStats, packageJsonStats, launcherStats] = await Promise.all([
      fs.lstat(packageRoot),
      fs.lstat(packageJsonPath),
      fs.lstat(launcherPath),
    ]);
    if (
      !packageStats.isDirectory()
      || packageStats.isSymbolicLink()
      || !packageJsonStats.isFile()
      || packageJsonStats.isSymbolicLink()
      || !launcherStats.isFile()
      || launcherStats.isSymbolicLink()
    ) {
      return unsupportedSystemResolution('The npm package or launcher is not a regular file tree.');
    }

    const [canonicalPrefix, canonicalPackageRoot, canonicalLauncher] = await Promise.all([
      fs.realpath(prefixRoot),
      fs.realpath(packageRoot),
      fs.realpath(launcherPath),
    ]);
    if (
      !isPathWithin(canonicalPrefix, canonicalPackageRoot)
      || !isPathWithin(canonicalPackageRoot, canonicalLauncher)
    ) {
      return unsupportedSystemResolution('The npm package or launcher resolves outside its npm prefix.');
    }

    const packageJson = await fs.readJson(packageJsonPath).catch(() => undefined) as
      | { name?: unknown; version?: unknown; bin?: unknown }
      | undefined;
    const bin = packageJson?.bin;
    if (
      packageJson?.name !== MANAGED_CODEX_PACKAGE_NAME
      || typeof packageJson.version !== 'string'
      || !tryParseStrictSemVer(packageJson.version)
      || !bin
      || typeof bin !== 'object'
      || Array.isArray(bin)
      || (bin as Record<string, unknown>).codex !== 'bin/codex.js'
    ) {
      return unsupportedSystemResolution('The npm package identity, version, or launcher contract is invalid.');
    }

    return {
      state: 'supported',
      expectedVersion: packageJson.version,
      manager: {
        kind: 'system',
        version: packageJson.version,
        command: process.execPath,
        argsPrefix: [canonicalLauncher],
      },
    };
  } catch {
    return unsupportedSystemResolution('The Windows npm package is missing or unreadable.');
  }
}

/** Probes only the PATH consumer; never inspects or acquires a managed runtime. */
export async function inspectSystemCodex(
  options: InspectSystemCodexOptions,
): Promise<SystemCodexInspection> {
  const requiredMinVersion = options.operationRequirement.minimumVersion;
  const unresolved = (diagnostic: string): SystemCodexInspection => ({
    state: 'unresolved',
    code: 'codexSystemCliUnsupported',
    diagnostic,
    requiredMinVersion,
  });
  let system: SystemCodexProbe;
  try {
    system = await probeSystemCodex(options);
  } catch {
    return unresolved('The PATH Codex launcher could not be inspected. Check the launcher and retry.');
  }
  if (system.state === 'missing') return { state: 'missing', requiredMinVersion };
  if (system.state === 'unsupported') return unresolved(system.diagnostic);
  const { result } = system;
  if (result.status === 'supported') {
    return { state: 'compatible', detectedVersion: result.detectedVersion!, requiredMinVersion };
  }
  if (result.status === 'tooOld') {
    return {
      state: 'incompatible',
      code: 'codexSystemCliUnsupported',
      detectedVersion: result.detectedVersion!,
      diagnostic: unsupportedSystemDiagnostic(result),
      requiredMinVersion,
    };
  }
  return unresolved('The PATH Codex version query failed or returned an invalid version. Check the launcher and retry.');
}

async function resolveSystemCommandManager(
  command: string,
  options: CodexManagerOptions,
): Promise<SystemCommandManagerResolution> {
  const platform = options.platform ?? process.platform;
  const extension = path.extname(command).toLowerCase();
  if (platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return {
      state: 'supported',
      manager: {
        kind: 'system',
        version: 'unknown',
        command,
        argsPrefix: [],
      },
    };
  }
  if (extension === '.bat') {
    return unsupportedSystemResolution('Only the official Windows npm .cmd launcher is supported.');
  }
  return resolveWindowsNpmCodexManager(command);
}

async function resolvePathExecutable(
  command: string,
  options: CodexManagerOptions,
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathEnvironment = readPathEnvironment(env, platform);
  if (pathEnvironment === undefined) return undefined;
  for (const rawEntry of pathEnvironment.split(delimiter)) {
    const entry = rawEntry.replace(/^"|"$/gu, '');
    const directory = path.resolve(cwd, entry || '.');
    for (const executableName of executableNames(command, env, platform)) {
      const candidate = path.join(directory, executableName);
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        if (platform === 'win32') return candidate;
        await fs.access(candidate, fsConstants.X_OK);
        return await fs.realpath(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') continue;
        throw error;
      }
    }
  }
  return undefined;
}

type SystemCodexProbe =
  | { state: 'missing' }
  | { state: 'unsupported'; diagnostic: string }
  | { state: 'probed'; manager: CodexManager; result: AgentVersionProbeResult };

async function probeSystemCodex(options: CodexManagerOptions): Promise<SystemCodexProbe> {
  const command = await resolvePathExecutable('codex', options);
  if (!command) return { state: 'missing' };
  const resolution = await resolveSystemCommandManager(command, options);
  if (resolution.state === 'unsupported') return resolution;
  const { manager } = resolution;
  const result = await probeAgentVersion('codex', {
    argsPrefix: manager.argsPrefix,
    cache: false,
    command: manager.command,
    cwd: options.cwd,
    env: options.env,
    minimumVersion: options.operationRequirement?.minimumVersion,
    runner: options.runner,
  });
  if (
    resolution.expectedVersion
    && result.status === 'supported'
    && result.detectedVersion !== resolution.expectedVersion
  ) {
    return {
      state: 'unsupported',
      diagnostic: 'The installed system Codex CLI is not supported. The npm package version does not match its launcher output. Reinstall or upgrade the official Codex CLI and retry; AW does not use managed fallback for this installation.',
    };
  }
  return { state: 'probed', manager, result };
}

function unsupportedSystemDiagnostic(
  system: AgentVersionProbeResult,
): string {
  const detected = system.detectedVersion ? ` Detected ${system.detectedVersion}.` : '';
  return `The installed system Codex CLI is not supported.${detected} Required minimum: ${system.requiredMinVersion}. Upgrade the official Codex CLI and retry; AW does not bypass an installed but unsupported system CLI.`;
}

const MANAGED_AUTHORIZATION_DIAGNOSTIC =
  'This operation must acquire or rebuild the pinned AW-managed Codex runtime. Retry with --allow-managed-codex-install, or approve the interactive prompt.';

const MANAGED_UNAVAILABLE_DIAGNOSTIC =
  'The AW-managed Codex runtime is unavailable. Retry the command, upgrade AW, or install a compatible official Codex CLI.';

export async function previewCodexManager(
  options: Omit<CodexManagerOptions, 'authorizer' | 'pnpmEntry'> = {},
): Promise<CodexManagerPreview> {
  const system = await probeSystemCodex(options);
  if (system.state === 'probed' && system.result.status === 'supported') {
    return {
      state: 'system',
      manager: {
        ...system.manager,
        version: system.result.detectedVersion!,
      },
    };
  }
  if (system.state === 'unsupported') {
    return {
      state: 'blocked',
      code: 'codexSystemCliUnsupported',
      diagnostic: system.diagnostic,
    };
  }
  if (system.state === 'probed') {
    return {
      state: 'blocked',
      code: 'codexSystemCliUnsupported',
      diagnostic: unsupportedSystemDiagnostic(system.result),
    };
  }
  const managed = await inspectManagedCodexRuntime(options);
  if (managed.state === 'valid') return { state: 'cached', manager: managed.manager };
  if (managed.state === 'absent' || managed.state === 'rebuildable') {
    return { state: 'requires-install' };
  }
  return {
    state: 'blocked',
    code: 'managedCodexUnavailable',
    diagnostic: MANAGED_UNAVAILABLE_DIAGNOSTIC,
  };
}

export async function resolveCodexManager(
  options: CodexManagerOptions = {},
): Promise<CodexManager> {
  const system = await probeSystemCodex(options);
  if (system.state === 'probed' && system.result.status === 'supported') {
    return {
      ...system.manager,
      version: system.result.detectedVersion!,
    };
  }
  if (system.state === 'unsupported') {
    throw new CodexManagerError('codexSystemCliUnsupported', system.diagnostic);
  }
  if (system.state === 'probed') {
    throw new CodexManagerError(
      'codexSystemCliUnsupported',
      unsupportedSystemDiagnostic(system.result),
    );
  }

  return resolveManagedCodexAfterMissingSystem(options);
}

async function resolveManagedCodexAfterMissingSystem(
  options: CodexManagerOptions,
): Promise<CodexManager> {
  const managed = await inspectManagedCodexRuntime(options);
  if (managed.state === 'valid') return managed.manager;
  if (managed.state === 'blocked') {
    throw new CodexManagerError('managedCodexUnavailable', MANAGED_UNAVAILABLE_DIAGNOSTIC);
  }
  if (!options.authorizer) {
    throw new CodexManagerError(
      'managedCodexAuthorizationRequired',
      MANAGED_AUTHORIZATION_DIAGNOSTIC,
    );
  }
  let authorized: boolean;
  try {
    authorized = await options.authorizer();
  } catch (error) {
    throw new CodexManagerError(
      'managedCodexUnavailable',
      MANAGED_UNAVAILABLE_DIAGNOSTIC,
    );
  }
  if (!authorized) {
    throw new CodexManagerError(
      'managedCodexAuthorizationRequired',
      MANAGED_AUTHORIZATION_DIAGNOSTIC,
    );
  }
  try {
    return await acquireManagedCodexRuntime(options);
  } catch (error) {
    throw new CodexManagerError(
      'managedCodexUnavailable',
      MANAGED_UNAVAILABLE_DIAGNOSTIC,
    );
  }
}

export async function resolveCodexOperationConsumer(
  options: ResolveCodexOperationConsumerOptions,
): Promise<CodexOperationConsumer> {
  const system = await probeSystemCodex(options);
  if (system.state === 'probed' && system.result.status === 'supported') {
    return {
      support: 'observed',
      manager: {
        ...system.manager,
        version: system.result.detectedVersion!,
      },
      requirement: options.operationRequirement,
    };
  }
  if (system.state === 'unsupported') {
    throw new CodexManagerError('codexSystemCliUnsupported', system.diagnostic);
  }
  if (system.state === 'probed') {
    throw new CodexManagerError(
      'codexSystemCliUnsupported',
      unsupportedSystemDiagnostic(system.result),
    );
  }
  if (!options.requiresNativeMaterialization) {
    const managed = await inspectManagedCodexRuntime(options);
    if (managed.state === 'valid') {
      return {
        support: 'observed',
        manager: managed.manager,
        requirement: options.operationRequirement,
      };
    }
    return {
      support: 'assumed',
      requirement: options.operationRequirement,
    };
  }
  return {
    support: 'observed',
    manager: await resolveManagedCodexAfterMissingSystem(options),
    requirement: options.operationRequirement,
  };
}
