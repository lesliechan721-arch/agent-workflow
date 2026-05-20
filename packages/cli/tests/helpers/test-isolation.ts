import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { expect } from 'vitest';

import {
  TestPathFenceError,
  assertPathWithinReadableRoots,
  assertPathWithinWritableRoots,
  createPathFenceRegistry,
  normalizeAbsolutePath,
  registerReadonlyFixtureRoot,
  registerWritableStateRoot,
  type TestRootRegistry,
  type TestRootAccess,
} from './path-fence.js';

export interface TestIsolationLayout {
  rootDir: string;
  homeDir: string;
  awHomeDir: string;
  localMarketplaceStagingRoot: string;
  localMarketplaceBackupRoot: string;
  codexHomeDir: string;
  claudeHomeDir: string;
  xdgConfigHomeDir: string;
  xdgCacheHomeDir: string;
  xdgStateHomeDir: string;
  npmDir: string;
  npmUserConfigPath: string;
  tmpDir: string;
  debugLogsDir: string;
  fixtureCwd: string;
}

export interface CreateIsolatedTestEnvOptions {
  rootDir?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface IsolatedTestEnvironment {
  env: NodeJS.ProcessEnv;
  layout: TestIsolationLayout;
  rootRegistry: TestRootRegistry;
  cleanup: () => Promise<void>;
}

export interface ExpectedPathFenceViolation {
  access: TestRootAccess;
  path: string;
  source: string;
  reason?: 'outsideRegisteredRoots' | 'writeToReadOnlyRoot';
  conflictingRootPath?: string;
  recommendedFixIncludes?: string;
}

interface EnvPathEntry {
  key: string;
  path: string;
}

function buildIsolationLayout(rootDir: string): TestIsolationLayout {
  return {
    rootDir,
    homeDir: path.join(rootDir, 'home'),
    awHomeDir: path.join(rootDir, 'aw-home'),
    localMarketplaceStagingRoot: path.join(rootDir, '.aw-local-marketplace-staging'),
    localMarketplaceBackupRoot: path.join(rootDir, '.aw-local-marketplace-backups'),
    codexHomeDir: path.join(rootDir, 'codex-home'),
    claudeHomeDir: path.join(rootDir, 'claude-home'),
    xdgConfigHomeDir: path.join(rootDir, 'xdg-config'),
    xdgCacheHomeDir: path.join(rootDir, 'xdg-cache'),
    xdgStateHomeDir: path.join(rootDir, 'xdg-state'),
    npmDir: path.join(rootDir, 'npm'),
    npmUserConfigPath: path.join(rootDir, 'npm', '.npmrc'),
    tmpDir: path.join(rootDir, 'tmp'),
    debugLogsDir: path.join(rootDir, 'debug-logs'),
    fixtureCwd: path.join(rootDir, 'fixture-cwd'),
  };
}

function buildIsolatedEnv(
  layout: TestIsolationLayout,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir,
    AW_HOME: layout.awHomeDir,
    AW_CODEX_HOME: layout.codexHomeDir,
    AW_CLAUDE_HOME: layout.claudeHomeDir,
    XDG_CONFIG_HOME: layout.xdgConfigHomeDir,
    XDG_CACHE_HOME: layout.xdgCacheHomeDir,
    XDG_STATE_HOME: layout.xdgStateHomeDir,
    npm_config_userconfig: layout.npmUserConfigPath,
    NPM_CONFIG_USERCONFIG: layout.npmUserConfigPath,
    TMPDIR: layout.tmpDir,
    TEMP: layout.tmpDir,
    TMP: layout.tmpDir,
  };
}

async function ensureIsolationLayout(layout: TestIsolationLayout): Promise<void> {
  await Promise.all([
    fs.ensureDir(layout.homeDir),
    fs.ensureDir(layout.awHomeDir),
    fs.ensureDir(layout.localMarketplaceStagingRoot),
    fs.ensureDir(layout.localMarketplaceBackupRoot),
    fs.ensureDir(layout.codexHomeDir),
    fs.ensureDir(layout.claudeHomeDir),
    fs.ensureDir(layout.xdgConfigHomeDir),
    fs.ensureDir(layout.xdgCacheHomeDir),
    fs.ensureDir(layout.xdgStateHomeDir),
    fs.ensureDir(layout.npmDir),
    fs.ensureDir(layout.tmpDir),
    fs.ensureDir(layout.debugLogsDir),
    fs.ensureDir(layout.fixtureCwd),
    fs.ensureFile(layout.npmUserConfigPath),
  ]);
}

function registerDefaultWritableRoots(
  registry: TestRootRegistry,
  layout: TestIsolationLayout,
): void {
  registerWritableStateRoot(registry, layout.homeDir, 'HOME/USERPROFILE');
  registerWritableStateRoot(registry, layout.awHomeDir, 'AW_HOME');
  registerWritableStateRoot(registry, layout.localMarketplaceStagingRoot, 'local marketplace staging');
  registerWritableStateRoot(registry, layout.localMarketplaceBackupRoot, 'local marketplace backup');
  registerWritableStateRoot(registry, layout.codexHomeDir, 'AW_CODEX_HOME');
  registerWritableStateRoot(registry, layout.claudeHomeDir, 'AW_CLAUDE_HOME');
  registerWritableStateRoot(registry, layout.xdgConfigHomeDir, 'XDG_CONFIG_HOME');
  registerWritableStateRoot(registry, layout.xdgCacheHomeDir, 'XDG_CACHE_HOME');
  registerWritableStateRoot(registry, layout.xdgStateHomeDir, 'XDG_STATE_HOME');
  registerWritableStateRoot(registry, layout.npmDir, 'npm userconfig');
  registerWritableStateRoot(registry, layout.tmpDir, 'TMPDIR/TEMP/TMP');
  registerWritableStateRoot(registry, layout.debugLogsDir, 'debug logs');
  registerWritableStateRoot(registry, layout.fixtureCwd, 'fixture cwd');
}

function readRequiredEnvPath(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing isolated test env variable "${key}". Use createIsolatedTestEnv().`);
  }
  return value;
}

function collectRequiredEnvPaths(env: NodeJS.ProcessEnv): EnvPathEntry[] {
  const npmUserConfig = env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG;
  if (typeof npmUserConfig !== 'string' || npmUserConfig.trim() === '') {
    throw new Error('Missing isolated test env variable "npm_config_userconfig". Use createIsolatedTestEnv().');
  }

  return [
    { key: 'HOME', path: readRequiredEnvPath(env, 'HOME') },
    { key: 'USERPROFILE', path: readRequiredEnvPath(env, 'USERPROFILE') },
    { key: 'AW_HOME', path: readRequiredEnvPath(env, 'AW_HOME') },
    { key: 'AW_CODEX_HOME', path: readRequiredEnvPath(env, 'AW_CODEX_HOME') },
    { key: 'AW_CLAUDE_HOME', path: readRequiredEnvPath(env, 'AW_CLAUDE_HOME') },
    { key: 'XDG_CONFIG_HOME', path: readRequiredEnvPath(env, 'XDG_CONFIG_HOME') },
    { key: 'XDG_CACHE_HOME', path: readRequiredEnvPath(env, 'XDG_CACHE_HOME') },
    { key: 'XDG_STATE_HOME', path: readRequiredEnvPath(env, 'XDG_STATE_HOME') },
    { key: 'npm_config_userconfig', path: npmUserConfig },
    { key: 'TMPDIR', path: readRequiredEnvPath(env, 'TMPDIR') },
    { key: 'TEMP', path: readRequiredEnvPath(env, 'TEMP') },
    { key: 'TMP', path: readRequiredEnvPath(env, 'TMP') },
  ];
}

export function assertIsolatedTestEnv(
  env: NodeJS.ProcessEnv,
  rootRegistry: TestRootRegistry,
): void {
  for (const entry of collectRequiredEnvPaths(env)) {
    assertPathWithinWritableRoots(rootRegistry, {
      path: entry.path,
      source: entry.key,
      recommendedFix: `用 createIsolatedTestEnv() 生成默认 env，或先通过 registerWritableStateRoot() 登记你显式覆盖的 ${entry.key} 路径。`,
    });
  }
}

export function assertSafeTestCwd(
  cwd: string,
  rootRegistry: TestRootRegistry,
  source = 'cwd',
): string {
  return assertPathWithinWritableRoots(rootRegistry, {
    path: cwd,
    source,
    recommendedFix: '用 withSafeTestCwd() 切到测试可写 cwd，或先通过 registerWritableStateRoot() 登记该项目根。',
  });
}

export async function withSafeTestCwd<T>(
  rootRegistry: TestRootRegistry,
  cwd: string,
  callback: () => Promise<T> | T,
  source = 'withSafeTestCwd()',
): Promise<T> {
  const registeredPath = registerWritableStateRoot(rootRegistry, cwd, source);
  await fs.ensureDir(registeredPath);

  const previousCwd = process.cwd();
  process.chdir(registeredPath);
  try {
    return await callback();
  } finally {
    process.chdir(previousCwd);
  }
}

export async function runWithRepositoryCwdAsReadOnly<T>(
  rootRegistry: TestRootRegistry,
  callback: () => Promise<T> | T,
  options: {
    repositoryCwd?: string;
    source?: string;
  } = {},
): Promise<T> {
  const repositoryCwd = options.repositoryCwd ?? process.cwd();
  const registeredPath = registerReadonlyFixtureRoot(
    rootRegistry,
    repositoryCwd,
    options.source ?? 'runWithRepositoryCwdAsReadOnly()',
  );
  if (!await fs.pathExists(registeredPath)) {
    throw new Error(`Repository cwd does not exist: ${registeredPath}`);
  }

  const previousCwd = process.cwd();
  process.chdir(registeredPath);
  try {
    return await callback();
  } finally {
    process.chdir(previousCwd);
  }
}

export function expectPathFenceViolation(
  action: () => unknown,
  expected: ExpectedPathFenceViolation,
): TestPathFenceError {
  let caughtError: unknown;

  try {
    action();
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(TestPathFenceError);
  const pathFenceError = caughtError as TestPathFenceError;

  expect(pathFenceError.details.access).toBe(expected.access);
  expect(pathFenceError.details.source).toBe(expected.source);
  expect(pathFenceError.details.normalizedUnsafePath).toBe(normalizeAbsolutePath(expected.path));

  if (expected.reason) {
    expect(pathFenceError.details.reason).toBe(expected.reason);
  }

  if (expected.conflictingRootPath) {
    expect(pathFenceError.details.conflictingRoot?.path).toBe(normalizeAbsolutePath(expected.conflictingRootPath));
  }

  if (expected.recommendedFixIncludes) {
    expect(pathFenceError.details.recommendedFix).toContain(expected.recommendedFixIncludes);
  }

  return pathFenceError;
}

export async function createIsolatedTestEnv(
  options: CreateIsolatedTestEnvOptions = {},
): Promise<IsolatedTestEnvironment> {
  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'aw-test-isolation-'));
  const layout = buildIsolationLayout(rootDir);
  await ensureIsolationLayout(layout);

  const rootRegistry = createPathFenceRegistry();
  registerDefaultWritableRoots(rootRegistry, layout);

  const env = buildIsolatedEnv(layout, options.baseEnv ?? process.env);

  return {
    env,
    layout,
    rootRegistry,
    cleanup: async () => {
      await fs.remove(rootDir);
    },
  };
}

export {
  TestPathFenceError,
  assertPathWithinReadableRoots,
  assertPathWithinWritableRoots,
  createPathFenceRegistry,
  registerReadonlyFixtureRoot,
  registerWritableStateRoot,
};
