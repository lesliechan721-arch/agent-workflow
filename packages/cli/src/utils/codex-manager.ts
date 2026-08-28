import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import fs from 'fs-extra';

import {
  extractStrictSemVerTokenFromVersionOutput,
  probeAgentVersion,
} from './agent-version.js';
import {
  getDefaultNativeCliRunner,
  runNativeCli,
  type CodexManager,
  type NativeCliRunner,
} from './native-cli.js';
import { getCodexHome, resolveAwHome } from './state-paths.js';

export const MANAGED_CODEX_PACKAGE_NAME = '@openai/codex';
export const MANAGED_CODEX_VERSION = '0.150.1';
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
  platform?: NodeJS.Platform;
  pnpmEntry?: string;
  runner?: NativeCliRunner;
}

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

function managedPackageJson(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', '@openai', 'codex', 'package.json');
}

function managerForRuntime(runtimeRoot: string, execPath: string): CodexManager {
  return {
    kind: 'aw-managed',
    version: MANAGED_CODEX_VERSION,
    command: execPath,
    argsPrefix: [managedLauncher(runtimeRoot)],
    runtimeRoot,
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
  runtimeRoot: string,
  options: CodexManagerOptions,
): Promise<string | undefined> {
  const runner = options.runner ?? getDefaultNativeCliRunner();
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  try {
    const result = await runNativeCli({
      command: execPath,
      args: [managedLauncher(runtimeRoot), '--version'],
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

    const packageStats = await lstatOrUndefined(managedPackageJson(runtimeRoot));
    const launcherStats = await lstatOrUndefined(managedLauncher(runtimeRoot));
    if (!packageStats?.isFile() || !launcherStats?.isFile() || launcherStats.isSymbolicLink()) {
      return { state: 'rebuildable', diagnostic: 'The AW-owned managed runtime is incomplete.' };
    }
    const packageJson = await fs.readJson(managedPackageJson(runtimeRoot)).catch(() => undefined) as
      | { name?: unknown; version?: unknown }
      | undefined;
    if (
      packageJson?.name !== MANAGED_CODEX_PACKAGE_NAME
      || packageJson.version !== MANAGED_CODEX_VERSION
    ) {
      return { state: 'rebuildable', diagnostic: 'The AW-owned managed runtime package does not match the pinned package.' };
    }
    const detectedVersion = await runManagedVersionCheck(runtimeRoot, options);
    if (detectedVersion !== MANAGED_CODEX_VERSION) {
      return { state: 'rebuildable', diagnostic: 'The AW-owned managed runtime failed its version self-check.' };
    }
    return {
      state: 'valid',
      manager: managerForRuntime(runtimeRoot, options.execPath ?? process.execPath),
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
  const packageStats = await lstatOrUndefined(managedPackageJson(stagingRoot));
  const launcherStats = await lstatOrUndefined(managedLauncher(stagingRoot));
  const packageJson = await fs.readJson(managedPackageJson(stagingRoot)).catch(() => undefined) as
    | { name?: unknown; version?: unknown }
    | undefined;
  if (
    !packageStats?.isFile()
    || !launcherStats?.isFile()
    || launcherStats.isSymbolicLink()
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
    args: [managedLauncher(stagingRoot), '--version'],
  }, runner);
  const detectedVersion = extractStrictSemVerTokenFromVersionOutput(
    `${versionResult.stdout}\n${versionResult.stderr}`,
  );
  if (versionResult.exitCode !== 0 || detectedVersion !== MANAGED_CODEX_VERSION) {
    throw new Error('The installed Codex package failed its version self-check.');
  }
  const helpResult = await runNativeCli({
    ...invocationBase,
    args: [managedLauncher(stagingRoot), 'plugin', '--help'],
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
    return managerForRuntime(runtimeRoot, options.execPath ?? process.execPath);
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
  return managerForRuntime(runtimeRoot, options.execPath ?? process.execPath);
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

async function probeSystemCodex(options: CodexManagerOptions) {
  return probeAgentVersion('codex', {
    cache: false,
    cwd: options.cwd,
    env: options.env,
    runner: options.runner,
  });
}

export async function previewCodexManager(
  options: Omit<CodexManagerOptions, 'authorizer' | 'pnpmEntry'> = {},
): Promise<CodexManagerPreview> {
  const system = await probeSystemCodex(options);
  if (system.status === 'supported') {
    return {
      state: 'system',
      manager: {
        kind: 'system',
        version: system.detectedVersion!,
        command: 'codex',
        argsPrefix: [],
      },
    };
  }
  if (system.status !== 'missing') {
    return {
      state: 'blocked',
      code: 'codexSystemCliUnsupported',
      diagnostic: system.details ?? `The system Codex probe returned ${system.status}.`,
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
    diagnostic: managed.diagnostic,
  };
}

export async function resolveCodexManager(
  options: CodexManagerOptions = {},
): Promise<CodexManager> {
  const system = await probeSystemCodex(options);
  if (system.status === 'supported') {
    return {
      kind: 'system',
      version: system.detectedVersion!,
      command: 'codex',
      argsPrefix: [],
    };
  }
  if (system.status !== 'missing') {
    throw new CodexManagerError(
      'codexSystemCliUnsupported',
      system.details ?? `The system Codex probe returned ${system.status}.`,
    );
  }

  const managed = await inspectManagedCodexRuntime(options);
  if (managed.state === 'valid') return managed.manager;
  if (managed.state === 'blocked') {
    throw new CodexManagerError('managedCodexUnavailable', managed.diagnostic);
  }
  if (!options.authorizer) {
    throw new CodexManagerError(
      'managedCodexAuthorizationRequired',
      'Installing or rebuilding the AW-managed Codex runtime requires authorization.',
    );
  }
  let authorized: boolean;
  try {
    authorized = await options.authorizer();
  } catch (error) {
    throw new CodexManagerError(
      'managedCodexUnavailable',
      `The managed Codex authorization check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!authorized) {
    throw new CodexManagerError(
      'managedCodexAuthorizationRequired',
      'Installing or rebuilding the AW-managed Codex runtime requires authorization.',
    );
  }
  try {
    return await acquireManagedCodexRuntime(options);
  } catch (error) {
    throw new CodexManagerError(
      'managedCodexUnavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}
