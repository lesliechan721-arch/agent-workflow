import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { readCodexConfigFile } from './codex-config.js';
import { getCodexHome } from './paths.js';

const MARKETPLACE_NAME = 'aw';
const CACHE_MANIFEST_CANDIDATES = [
  'plugin.json',
  path.join('.codex-plugin', 'plugin.json'),
] as const;

export type CodexNativeCacheStatus = 'missing' | 'active' | 'invalid' | 'ambiguous';

export interface CodexNativePluginState {
  pluginName: string;
  pluginId: `${string}@aw`;
  configPath: string;
  cacheRootPath: string;
  configEntryPresent: boolean;
  pluginEnabled: boolean;
  pluginInstalled: boolean;
  cacheStatus: CodexNativeCacheStatus;
  activeCacheVersion?: string;
  activeCachePath?: string;
  validCachePaths: string[];
  invalidCachePaths: string[];
  ignoredCacheEntries: string[];
}

export interface CodexNativePostCheckResult {
  ok: boolean;
  state: CodexNativePluginState;
}

export interface CodexMarketplaceCleanupAssessment {
  marketplaceConfigPresent: boolean;
  canCleanup: boolean;
  blockingEvidence: CodexNativePluginState[];
}

export interface CodexNativePluginRollbackBaseline {
  pluginName: string;
  configPath: string;
  configContent: string | null;
  cacheRootPath: string;
  cacheBackupPath: string | null;
  cleanupRoot: string | null;
}

function buildPluginId(pluginName: string): `${string}@aw` {
  return `${pluginName}@${MARKETPLACE_NAME}`;
}

function getCodexConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(getCodexHome(env), 'config.toml');
}

function getCodexMarketplaceCacheRoot(env: NodeJS.ProcessEnv): string {
  return path.join(getCodexHome(env), 'plugins', 'cache', MARKETPLACE_NAME);
}

export function getCodexNativePluginCacheRootPath(
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getCodexMarketplaceCacheRoot(env), pluginName);
}

function stripMarketplaceSuffix(pluginId: string): string | null {
  const suffix = `@${MARKETPLACE_NAME}`;
  if (!pluginId.endsWith(suffix)) {
    return null;
  }

  return pluginId.slice(0, -suffix.length);
}

export function hasCodexNativeCacheEvidence(state: CodexNativePluginState): boolean {
  return state.cacheStatus !== 'missing';
}

export function hasCodexNativeStateEvidence(state: CodexNativePluginState): boolean {
  return state.pluginEnabled || state.pluginInstalled || hasCodexNativeCacheEvidence(state);
}

async function isValidCodexCacheVersionDir(versionPath: string): Promise<boolean> {
  for (const relativePath of CACHE_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(versionPath, relativePath);
    try {
      const stats = await fs.stat(manifestPath);
      if (stats.isFile()) {
        return true;
      }
    } catch {
      // Ignore missing manifest candidates.
    }
  }

  return false;
}

async function inspectCodexActiveCache(
  pluginName: string,
  env: NodeJS.ProcessEnv,
): Promise<Pick<
  CodexNativePluginState,
  | 'cacheRootPath'
  | 'pluginInstalled'
  | 'cacheStatus'
  | 'activeCacheVersion'
  | 'activeCachePath'
  | 'validCachePaths'
  | 'invalidCachePaths'
  | 'ignoredCacheEntries'
>> {
  const cacheRootPath = path.join(getCodexMarketplaceCacheRoot(env), pluginName);
  const validEntries: Array<{ name: string; path: string }> = [];
  const invalidCachePaths: string[] = [];
  const ignoredCacheEntries: string[] = [];

  let rootStats;
  try {
    rootStats = await fs.stat(cacheRootPath);
  } catch {
    return {
      cacheRootPath,
      pluginInstalled: false,
      cacheStatus: 'missing',
      validCachePaths: [],
      invalidCachePaths,
      ignoredCacheEntries,
    };
  }

  if (!rootStats.isDirectory()) {
    return {
      cacheRootPath,
      pluginInstalled: false,
      cacheStatus: 'invalid',
      validCachePaths: [],
      invalidCachePaths: [cacheRootPath],
      ignoredCacheEntries,
    };
  }

  const entries = await fs.readdir(cacheRootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(cacheRootPath, entry.name);
    if (!entry.isDirectory()) {
      ignoredCacheEntries.push(entryPath);
      continue;
    }

    if (await isValidCodexCacheVersionDir(entryPath)) {
      validEntries.push({ name: entry.name, path: entryPath });
    } else {
      invalidCachePaths.push(entryPath);
    }
  }

  validEntries.sort((left, right) => left.name.localeCompare(right.name));
  const validCachePaths = validEntries.map((entry) => entry.path);

  if (validEntries.length === 1) {
    return {
      cacheRootPath,
      pluginInstalled: true,
      cacheStatus: 'active',
      activeCacheVersion: validEntries[0].name,
      activeCachePath: validEntries[0].path,
      validCachePaths,
      invalidCachePaths,
      ignoredCacheEntries,
    };
  }

  const cacheStatus: CodexNativeCacheStatus =
    validEntries.length > 1
      ? 'ambiguous'
      : invalidCachePaths.length > 0 || ignoredCacheEntries.length > 0
        ? 'invalid'
        : 'missing';

  return {
    cacheRootPath,
    pluginInstalled: false,
    cacheStatus,
    validCachePaths,
    invalidCachePaths,
    ignoredCacheEntries,
  };
}

export async function readCodexNativePluginState(
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNativePluginState> {
  const pluginId = buildPluginId(pluginName);
  const configPath = getCodexConfigPath(env);
  const config = await readCodexConfigFile(configPath);
  const pluginSnapshot = config.snapshot.plugins[pluginId];
  const configEntryPresent = pluginSnapshot !== undefined;
  const pluginEnabled = pluginSnapshot?.enabled === true;
  const cacheState = await inspectCodexActiveCache(pluginName, env);

  return {
    pluginName,
    pluginId,
    configPath,
    configEntryPresent,
    pluginEnabled,
    ...cacheState,
  };
}

export async function listCodexNativeEvidence(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNativePluginState[]> {
  const configPath = getCodexConfigPath(env);
  const config = await readCodexConfigFile(configPath);
  const pluginNames = new Set<string>();

  for (const [pluginId, pluginSnapshot] of Object.entries(config.snapshot.plugins)) {
    if (pluginSnapshot.enabled !== true) {
      continue;
    }

    const pluginName = stripMarketplaceSuffix(pluginId);
    if (pluginName) {
      pluginNames.add(pluginName);
    }
  }

  const cacheRootPath = getCodexMarketplaceCacheRoot(env);
  try {
    const cacheEntries = await fs.readdir(cacheRootPath, { withFileTypes: true });
    for (const entry of cacheEntries) {
      pluginNames.add(entry.name);
    }
  } catch {
    // Ignore missing cache roots.
  }

  const states = await Promise.all(
    [...pluginNames].sort((left, right) => left.localeCompare(right)).map((pluginName) =>
      readCodexNativePluginState(pluginName, env),
    ),
  );

  return states.filter((state) => hasCodexNativeStateEvidence(state));
}

export async function checkCodexNativeInstallPostCheck(
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNativePostCheckResult> {
  const state = await readCodexNativePluginState(pluginName, env);
  return {
    ok: state.pluginEnabled && state.pluginInstalled,
    state,
  };
}

export async function checkCodexNativeUninstallPostCheck(
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNativePostCheckResult> {
  const state = await readCodexNativePluginState(pluginName, env);
  return {
    ok: !state.configEntryPresent && !hasCodexNativeCacheEvidence(state),
    state,
  };
}

export async function captureCodexNativePluginRollbackBaseline(
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNativePluginRollbackBaseline> {
  const configPath = getCodexConfigPath(env);
  const configContent = await fs.pathExists(configPath)
    ? await fs.readFile(configPath, 'utf8')
    : null;
  const cacheRootPath = getCodexNativePluginCacheRootPath(pluginName, env);
  const cacheExists = await fs.pathExists(cacheRootPath);
  if (!cacheExists) {
    return {
      pluginName,
      configPath,
      configContent,
      cacheRootPath,
      cacheBackupPath: null,
      cleanupRoot: null,
    };
  }

  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), `aw-codex-native-cache-${pluginName}-`));
  const cacheBackupPath = path.join(cleanupRoot, path.basename(cacheRootPath));
  await fs.copy(cacheRootPath, cacheBackupPath, {
    overwrite: true,
    errorOnExist: false,
  });
  return {
    pluginName,
    configPath,
    configContent,
    cacheRootPath,
    cacheBackupPath,
    cleanupRoot,
  };
}

export async function restoreCodexNativePluginRollbackBaseline(
  baseline: CodexNativePluginRollbackBaseline,
): Promise<void> {
  if (baseline.configContent === null) {
    await fs.remove(baseline.configPath);
  } else {
    await fs.ensureDir(path.dirname(baseline.configPath));
    await fs.writeFile(baseline.configPath, baseline.configContent, 'utf8');
  }

  await fs.remove(baseline.cacheRootPath);
  if (baseline.cacheBackupPath && await fs.pathExists(baseline.cacheBackupPath)) {
    await fs.ensureDir(path.dirname(baseline.cacheRootPath));
    await fs.copy(baseline.cacheBackupPath, baseline.cacheRootPath, {
      overwrite: true,
      errorOnExist: false,
    });
  }
}

export async function disposeCodexNativePluginRollbackBaseline(
  baseline: CodexNativePluginRollbackBaseline | undefined,
): Promise<void> {
  if (!baseline?.cleanupRoot) {
    return;
  }
  await fs.remove(baseline.cleanupRoot).catch(() => undefined);
}

export async function assessCodexMarketplaceCleanup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexMarketplaceCleanupAssessment> {
  const config = await readCodexConfigFile(getCodexConfigPath(env));
  const blockingEvidence = await listCodexNativeEvidence(env);

  return {
    marketplaceConfigPresent: config.snapshot.marketplaces[MARKETPLACE_NAME] !== undefined,
    canCleanup: blockingEvidence.length === 0,
    blockingEvidence,
  };
}
