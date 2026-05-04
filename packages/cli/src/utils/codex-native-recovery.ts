import path from 'node:path';

import fs from 'fs-extra';

import { resolveAwHome } from './paths.js';

export const CODEX_NATIVE_RECOVERY_DIR = 'native-recovery';
const CODEX_NATIVE_RECOVERY_PLATFORM_DIR = 'codex';
const CODEX_NATIVE_RECOVERY_SCOPE_DIR = 'user';
const CODEX_NATIVE_RECOVERY_MARKETPLACE_NAME = 'aw';

const VALID_STATES = new Set([
  'pending_after_native_write',
  'post_check_failed',
  'lifecycle_failed',
  'tracking_write_failed',
  'ledger_write_failed',
  'snapshot_write_failed',
  'cleanup_failed',
] as const);

export type CodexNativeRecoveryState =
  | 'pending_after_native_write'
  | 'post_check_failed'
  | 'lifecycle_failed'
  | 'tracking_write_failed'
  | 'ledger_write_failed'
  | 'snapshot_write_failed'
  | 'cleanup_failed';

export interface CodexNativeRecoveryBreadcrumb {
  version: 1;
  platform: 'codex';
  scope: 'user';
  marketplaceName: 'aw';
  pluginName: string;
  pluginId: `${string}@aw`;
  state: CodexNativeRecoveryState;
  reason: string;
  nativeWrittenAt: string;
  updatedAt: string;
  marketplacePath?: string;
  pluginVersion?: string;
  bundleFingerprint?: string;
  activeCachePath?: string;
  lastError?: string;
}

export interface WriteCodexNativeRecoveryBreadcrumbOptions {
  pluginName: string;
  state?: CodexNativeRecoveryState;
  reason: string;
  nativeWrittenAt?: string;
  updatedAt?: string;
  marketplacePath?: string;
  pluginVersion?: string;
  bundleFingerprint?: string;
  activeCachePath?: string;
  lastError?: string;
  env?: NodeJS.ProcessEnv;
}

export interface UpdateCodexNativeRecoveryBreadcrumbOptions {
  pluginName: string;
  state?: CodexNativeRecoveryState;
  reason?: string;
  nativeWrittenAt?: string;
  updatedAt?: string;
  marketplacePath?: string | null;
  pluginVersion?: string | null;
  bundleFingerprint?: string | null;
  activeCachePath?: string | null;
  lastError?: string | null;
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function normalizePluginId(pluginNameOrId: string): `${string}@aw` {
  const normalized = pluginNameOrId.endsWith(`@${CODEX_NATIVE_RECOVERY_MARKETPLACE_NAME}`)
    ? pluginNameOrId
    : `${pluginNameOrId}@${CODEX_NATIVE_RECOVERY_MARKETPLACE_NAME}`;

  if (normalized.includes('/') || normalized.includes('\\') || normalized.trim() === '') {
    throw new Error(`Invalid Codex native recovery plugin id: "${pluginNameOrId}".`);
  }

  return normalized as `${string}@aw`;
}

function pluginNameFromPluginId(pluginId: `${string}@aw`): string {
  return pluginId.slice(0, -(`@${CODEX_NATIVE_RECOVERY_MARKETPLACE_NAME}`.length));
}

function assertOptionalStringField(
  value: unknown,
  fieldName: keyof Pick<
    CodexNativeRecoveryBreadcrumb,
    'marketplacePath' | 'pluginVersion' | 'bundleFingerprint' | 'activeCachePath' | 'lastError'
  >,
): asserts value is string | undefined {
  if (!isOptionalString(value)) {
    throw new Error(`Invalid Codex native recovery breadcrumb field "${fieldName}".`);
  }
}

export function validateCodexNativeRecoveryBreadcrumb(
  value: unknown,
): CodexNativeRecoveryBreadcrumb | null {
  if (!isRecord(value)) {
    return null;
  }

  const pluginId = value.pluginId;
  let normalizedPluginId: `${string}@aw`;
  if (typeof pluginId !== 'string') {
    return null;
  }

  try {
    normalizedPluginId = normalizePluginId(pluginId);
  } catch {
    return null;
  }

  if (
    value.version !== 1 ||
    value.platform !== 'codex' ||
    value.scope !== 'user' ||
    value.marketplaceName !== CODEX_NATIVE_RECOVERY_MARKETPLACE_NAME ||
    typeof value.pluginName !== 'string' ||
    normalizedPluginId !== pluginId ||
    pluginNameFromPluginId(normalizedPluginId) !== value.pluginName ||
    !VALID_STATES.has(value.state as CodexNativeRecoveryState) ||
    typeof value.reason !== 'string' ||
    typeof value.nativeWrittenAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }

  try {
    assertOptionalStringField(value.marketplacePath, 'marketplacePath');
    assertOptionalStringField(value.pluginVersion, 'pluginVersion');
    assertOptionalStringField(value.bundleFingerprint, 'bundleFingerprint');
    assertOptionalStringField(value.activeCachePath, 'activeCachePath');
    assertOptionalStringField(value.lastError, 'lastError');
  } catch {
    return null;
  }

  return value as unknown as CodexNativeRecoveryBreadcrumb;
}

export function getCodexNativeRecoveryRootDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveAwHome(env),
    CODEX_NATIVE_RECOVERY_DIR,
    CODEX_NATIVE_RECOVERY_PLATFORM_DIR,
    CODEX_NATIVE_RECOVERY_SCOPE_DIR,
  );
}

export function getCodexNativeRecoveryBreadcrumbPath(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    getCodexNativeRecoveryRootDir(env),
    `${normalizePluginId(pluginNameOrId)}.json`,
  );
}

async function writeBreadcrumbAtomically(
  filePath: string,
  breadcrumb: CodexNativeRecoveryBreadcrumb,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  try {
    await fs.writeJson(tempPath, breadcrumb, { spaces: 2 });
    await fs.move(tempPath, filePath, { overwrite: true });
  } catch (error) {
    await fs.remove(tempPath).catch(() => undefined);
    throw error;
  }
}

function buildBreadcrumb(
  options: Omit<WriteCodexNativeRecoveryBreadcrumbOptions, 'env'>,
): CodexNativeRecoveryBreadcrumb {
  const pluginId = normalizePluginId(options.pluginName);
  const pluginName = pluginNameFromPluginId(pluginId);
  const nativeWrittenAt = options.nativeWrittenAt ?? new Date().toISOString();
  const updatedAt = options.updatedAt ?? nativeWrittenAt;

  return {
    version: 1,
    platform: 'codex',
    scope: 'user',
    marketplaceName: CODEX_NATIVE_RECOVERY_MARKETPLACE_NAME,
    pluginName,
    pluginId,
    state: options.state ?? 'pending_after_native_write',
    reason: options.reason,
    nativeWrittenAt,
    updatedAt,
    ...(options.marketplacePath ? { marketplacePath: options.marketplacePath } : {}),
    ...(options.pluginVersion ? { pluginVersion: options.pluginVersion } : {}),
    ...(options.bundleFingerprint ? { bundleFingerprint: options.bundleFingerprint } : {}),
    ...(options.activeCachePath ? { activeCachePath: options.activeCachePath } : {}),
    ...(options.lastError ? { lastError: options.lastError } : {}),
  };
}

function applyOptionalUpdate(
  target: Record<string, unknown>,
  key: keyof Pick<
    CodexNativeRecoveryBreadcrumb,
    'marketplacePath' | 'pluginVersion' | 'bundleFingerprint' | 'activeCachePath' | 'lastError'
  >,
  value: string | null | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}

export async function readCodexNativeRecoveryBreadcrumb(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNativeRecoveryBreadcrumb | null> {
  const filePath = getCodexNativeRecoveryBreadcrumbPath(pluginNameOrId, env);
  try {
    if (!(await fs.pathExists(filePath))) {
      return null;
    }
    return validateCodexNativeRecoveryBreadcrumb(await fs.readJson(filePath));
  } catch {
    return null;
  }
}

export async function writeCodexNativeRecoveryBreadcrumb(
  options: WriteCodexNativeRecoveryBreadcrumbOptions,
): Promise<CodexNativeRecoveryBreadcrumb> {
  const breadcrumb = buildBreadcrumb(options);
  await writeBreadcrumbAtomically(
    getCodexNativeRecoveryBreadcrumbPath(breadcrumb.pluginId, options.env),
    breadcrumb,
  );
  return breadcrumb;
}

export async function updateCodexNativeRecoveryBreadcrumb(
  options: UpdateCodexNativeRecoveryBreadcrumbOptions,
): Promise<CodexNativeRecoveryBreadcrumb> {
  const current = await readCodexNativeRecoveryBreadcrumb(options.pluginName, options.env);
  if (!current) {
    throw new Error(
      `Missing or invalid Codex native recovery breadcrumb for "${normalizePluginId(options.pluginName)}".`,
    );
  }

  const nextRecord: Record<string, unknown> = {
    ...current,
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.nativeWrittenAt !== undefined ? { nativeWrittenAt: options.nativeWrittenAt } : {}),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
  applyOptionalUpdate(nextRecord, 'marketplacePath', options.marketplacePath);
  applyOptionalUpdate(nextRecord, 'pluginVersion', options.pluginVersion);
  applyOptionalUpdate(nextRecord, 'bundleFingerprint', options.bundleFingerprint);
  applyOptionalUpdate(nextRecord, 'activeCachePath', options.activeCachePath);
  applyOptionalUpdate(nextRecord, 'lastError', options.lastError);

  const next = validateCodexNativeRecoveryBreadcrumb(nextRecord);
  if (!next) {
    throw new Error(`Unable to build Codex native recovery breadcrumb for "${current.pluginId}".`);
  }

  await writeBreadcrumbAtomically(
    getCodexNativeRecoveryBreadcrumbPath(current.pluginId, options.env),
    next,
  );
  return next;
}

async function removeEmptyParents(rootDir: string, startDir: string): Promise<void> {
  let currentDir = startDir;
  const normalizedRoot = path.resolve(rootDir);

  while (path.resolve(currentDir).startsWith(normalizedRoot)) {
    if (path.resolve(currentDir) === normalizedRoot) {
      return;
    }

    const entries = await fs.readdir(currentDir).catch(() => []);
    if (entries.length > 0) {
      return;
    }

    await fs.rmdir(currentDir).catch(() => undefined);
    currentDir = path.dirname(currentDir);
  }
}

export async function deleteCodexNativeRecoveryBreadcrumb(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const filePath = getCodexNativeRecoveryBreadcrumbPath(pluginNameOrId, env);
  if (!(await fs.pathExists(filePath))) {
    return false;
  }

  await fs.remove(filePath);
  await removeEmptyParents(getCodexNativeRecoveryRootDir(env), path.dirname(filePath));
  return true;
}

export async function listCodexNativeRecoveryBreadcrumbs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexNativeRecoveryBreadcrumb[]> {
  const rootDir = getCodexNativeRecoveryRootDir(env);
  if (!(await fs.pathExists(rootDir))) {
    return [];
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const breadcrumbs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => readCodexNativeRecoveryBreadcrumb(entry.name.slice(0, -5), env)),
  );

  return breadcrumbs
    .filter((entry): entry is CodexNativeRecoveryBreadcrumb => entry !== null)
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}
