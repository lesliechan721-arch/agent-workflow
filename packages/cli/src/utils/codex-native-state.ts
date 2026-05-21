import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import {
  CodexAppServerError,
  listCodexPluginsViaAppServer,
  listInstalledCodexPluginsViaAppServer,
  readCodexPluginViaAppServer,
  type CodexAppServerErrorContext,
  type CodexAppServerProcessRunner,
  type CodexAppServerPluginMethod,
} from './codex-app-server-client.js';
import { readCodexConfigFile } from './codex-config.js';
import { getCodexHome } from './paths.js';
import { assertTestWritablePath } from './test-path-fence.js';

const MARKETPLACE_NAME = 'aw';
const CACHE_MANIFEST_CANDIDATES = [
  'plugin.json',
  path.join('.codex-plugin', 'plugin.json'),
] as const;

function assertCodexNativeRollbackPathForTests(
  targetPath: string,
  source: string,
): string {
  return assertTestWritablePath(
    targetPath,
    source,
    '用 createIsolatedTestEnv() 生成默认 TMPDIR/AW_CODEX_HOME，或通过 registerWritableStateRoot() 登记 Codex native cache rollback/backup 路径。',
  );
}

export type CodexNativeCacheStatus = 'missing' | 'active' | 'invalid' | 'ambiguous';

export interface CodexNativePluginState {
  pluginName: string;
  pluginId: `${string}@aw`;
  configPath: string;
  installRootPath: string;
  installedManifestPath: string;
  installedManifestPresent: boolean;
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

export interface CodexNativeViewSummary {
  method: CodexAppServerPluginMethod;
  pluginId?: string;
  marketplace?: string;
  source?: string;
  installed?: boolean;
  enabled?: boolean;
  injectable?: boolean;
  mentionable?: boolean;
}

export interface CodexNativeViewAvailableDiagnostic {
  status: 'nativeViewAvailable';
  reason: null;
  pluginId: string;
  summaries: CodexNativeViewSummary[];
  raw: {
    pluginList: unknown;
    pluginInstalled: unknown;
    pluginRead: unknown;
  };
}

export interface CodexNativeViewUnknownDiagnostic {
  status: 'nativeViewUnknown';
  reason: 'codexNativeDiagnosticUnavailable';
  method: string;
  pluginId: string;
  errorCategory?: string;
  debugContext?: CodexAppServerErrorContext;
}

export type CodexNativeViewDiagnostic =
  | CodexNativeViewAvailableDiagnostic
  | CodexNativeViewUnknownDiagnostic;

export interface InspectCodexNativeViewDiagnosticOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  pluginName: string;
  pluginId?: string;
  timeoutMs?: number;
  runner?: CodexAppServerProcessRunner;
  clientName?: string;
  clientVersion?: string;
}

function buildPluginId(pluginName: string): `${string}@aw` {
  return `${pluginName}@${MARKETPLACE_NAME}`;
}

function normalizePluginId(pluginNameOrId: string): `${string}@aw` {
  return pluginNameOrId.endsWith(`@${MARKETPLACE_NAME}`)
    ? pluginNameOrId as `${string}@aw`
    : buildPluginId(pluginNameOrId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getStringField(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim() !== '') {
      return entry;
    }
  }
  return undefined;
}

function getBooleanField(value: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === 'boolean') {
      return entry;
    }
  }
  return undefined;
}

function extractPluginRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ['plugins', 'installed', 'items', 'entries', 'results']) {
    const entry = value[key];
    if (Array.isArray(entry)) {
      return entry.filter(isRecord);
    }
  }
  return [value];
}

function summarizePluginRecord(
  method: CodexAppServerPluginMethod,
  record: Record<string, unknown>,
): CodexNativeViewSummary {
  const sourceValue = record.source;
  const marketplaceValue = record.marketplace;
  const marketplace = typeof marketplaceValue === 'string'
    ? marketplaceValue
    : isRecord(marketplaceValue)
      ? getStringField(marketplaceValue, ['name', 'id', 'path'])
      : undefined;
  const source = typeof sourceValue === 'string'
    ? sourceValue
    : isRecord(sourceValue)
      ? getStringField(sourceValue, ['path', 'url', 'name', 'id', 'kind'])
      : undefined;

  return {
    method,
    pluginId: getStringField(record, ['pluginId', 'id', 'name']),
    marketplace,
    source,
    installed: getBooleanField(record, ['installed', 'isInstalled']),
    enabled: getBooleanField(record, ['enabled', 'isEnabled']),
    injectable: getBooleanField(record, ['injectable', 'canInject', 'injectionEnabled']),
    mentionable: getBooleanField(record, ['mentionable', 'canMention', 'mentionEnabled']),
  };
}

function summarizeNativeViewResult(
  method: CodexAppServerPluginMethod,
  result: unknown,
): CodexNativeViewSummary[] {
  return extractPluginRecords(result).map((record) => summarizePluginRecord(method, record));
}

function mapCodexNativeViewError(
  error: unknown,
  pluginId: string,
): CodexNativeViewUnknownDiagnostic {
  if (error instanceof CodexAppServerError) {
    return {
      status: 'nativeViewUnknown',
      reason: 'codexNativeDiagnosticUnavailable',
      method: error.debugContext.method,
      pluginId,
      errorCategory: error.category,
      debugContext: error.debugContext,
    };
  }

  return {
    status: 'nativeViewUnknown',
    reason: 'codexNativeDiagnosticUnavailable',
    method: 'codex app-server',
    pluginId,
    errorCategory: 'protocol_error',
  };
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

export function getCodexNativePluginInstallRootPath(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getCodexHome(env), 'plugins', normalizePluginId(pluginNameOrId));
}

export function getCodexNativePluginInstalledManifestPath(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getCodexNativePluginInstallRootPath(pluginNameOrId, env), 'manifest.json');
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
  return (
    state.pluginEnabled ||
    state.pluginInstalled ||
    state.installedManifestPresent ||
    hasCodexNativeCacheEvidence(state)
  );
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
  const installRootPath = getCodexNativePluginInstallRootPath(pluginId, env);
  const installedManifestPath = getCodexNativePluginInstalledManifestPath(pluginId, env);
  const [cacheState, installedManifestPresent] = await Promise.all([
    inspectCodexActiveCache(pluginName, env),
    fs.pathExists(installedManifestPath),
  ]);
  const configEntryPresent = pluginSnapshot !== undefined;
  const pluginEnabled = pluginSnapshot?.enabled === true;

  return {
    pluginName,
    pluginId,
    configPath,
    installRootPath,
    installedManifestPath,
    installedManifestPresent,
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

  const installedPluginsRoot = path.join(getCodexHome(env), 'plugins');
  try {
    const installEntries = await fs.readdir(installedPluginsRoot, { withFileTypes: true });
    for (const entry of installEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pluginName = stripMarketplaceSuffix(entry.name);
      if (!pluginName) {
        continue;
      }
      if (await fs.pathExists(path.join(installedPluginsRoot, entry.name, 'manifest.json'))) {
        pluginNames.add(pluginName);
      }
    }
  } catch {
    // Ignore missing install roots.
  }

  const states = await Promise.all(
    [...pluginNames].sort((left, right) => left.localeCompare(right)).map((pluginName) =>
      readCodexNativePluginState(pluginName, env),
    ),
  );

  return states.filter((state) => hasCodexNativeStateEvidence(state));
}

export async function inspectCodexNativeViewDiagnostic(
  options: InspectCodexNativeViewDiagnosticOptions,
): Promise<CodexNativeViewDiagnostic> {
  const env = options.env ?? process.env;
  const pluginId = options.pluginId ?? buildPluginId(options.pluginName);
  const baseOptions = {
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs,
    runner: options.runner,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
  };

  try {
    const installedResult = await listInstalledCodexPluginsViaAppServer(baseOptions);
    const readResult = await readCodexPluginViaAppServer({
      ...baseOptions,
      pluginId,
    });
    const listResult = await listCodexPluginsViaAppServer(baseOptions);
    const summaries = [
      ...summarizeNativeViewResult(installedResult.method, installedResult.result),
      ...summarizeNativeViewResult(readResult.method, readResult.result),
      ...summarizeNativeViewResult(listResult.method, listResult.result),
    ];

    if (summaries.length === 0) {
      return {
        status: 'nativeViewUnknown',
        reason: 'codexNativeDiagnosticUnavailable',
        method: 'codex app-server result',
        pluginId,
        errorCategory: 'protocol_error',
      };
    }

    return {
      status: 'nativeViewAvailable',
      reason: null,
      pluginId,
      summaries,
      raw: {
        pluginList: listResult.result,
        pluginInstalled: installedResult.result,
        pluginRead: readResult.result,
      },
    };
  } catch (error) {
    return mapCodexNativeViewError(error, pluginId);
  }
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
    ok: !state.configEntryPresent && !state.installedManifestPresent && !hasCodexNativeCacheEvidence(state),
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

  const cleanupRoot = await fs.mkdtemp(
    assertCodexNativeRollbackPathForTests(
      path.join(os.tmpdir(), `aw-codex-native-cache-${pluginName}-`),
      'Codex native cache rollback staging root',
    ),
  );
  const cacheBackupPath = assertCodexNativeRollbackPathForTests(
    path.join(cleanupRoot, path.basename(cacheRootPath)),
    'Codex native cache rollback backup',
  );
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
  const configPath = assertTestWritablePath(
    baseline.configPath,
    'Codex native rollback config path',
    '用 createIsolatedTestEnv() 生成默认 AW_CODEX_HOME，或通过 registerWritableStateRoot() 登记 Codex config 路径。',
  );
  const cacheRootPath = assertTestWritablePath(
    baseline.cacheRootPath,
    'Codex native cache rollback restore root',
    '用 createIsolatedTestEnv() 生成默认 AW_CODEX_HOME，或通过 registerWritableStateRoot() 登记 Codex native cache 根。',
  );

  if (baseline.configContent === null) {
    await fs.remove(configPath);
  } else {
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeFile(configPath, baseline.configContent, 'utf8');
  }

  await fs.remove(cacheRootPath);
  if (baseline.cacheBackupPath && await fs.pathExists(baseline.cacheBackupPath)) {
    await fs.ensureDir(path.dirname(cacheRootPath));
    await fs.copy(baseline.cacheBackupPath, cacheRootPath, {
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
  await fs.remove(
    assertCodexNativeRollbackPathForTests(
      baseline.cleanupRoot,
      'Codex native cache rollback cleanup root',
    ),
  ).catch(() => undefined);
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
