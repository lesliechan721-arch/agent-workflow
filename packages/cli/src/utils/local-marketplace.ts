import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CodexSharedNativeRefs,
  InstalledLedger,
  InstalledLedgerPluginPlatforms,
  LedgerStateReason,
  LocalMarketplaceConfig,
  PlatformName,
  Scope,
} from '../types.js';
import { readJsonFile, readJsonFileIfExists, writeJsonFile } from './json.js';
import {
  resolveAwHome,
  resolveCliPackageRoot,
  resolveEmbeddedPluginsRoot,
} from './paths.js';
import { validateBundleLayout } from './bundle-layout.js';

function resolveCliPackageJsonPath(): string {
  return path.join(resolveCliPackageRoot(), 'package.json');
}

async function readCliPackageInfo(): Promise<{ name: string; version: string }> {
  const packageJson = await readJsonFile<{ name: string; version: string }>(resolveCliPackageJsonPath());
  return {
    name: packageJson.name,
    version: packageJson.version,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isClaudePlatformRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { userScope, projectScopes, lastRequestedScope, lastRequestedAt } = value;
  const isScopeRecord = (scopeRecord: unknown): boolean =>
    isRecord(scopeRecord) &&
    typeof scopeRecord.managed === 'boolean' &&
    typeof scopeRecord.updatedAt === 'string' &&
    typeof scopeRecord.resolvedVersion === 'string' &&
    isRecord(scopeRecord.capabilitySnapshot);

  return (
    (userScope === undefined || isScopeRecord(userScope)) &&
    (projectScopes === undefined ||
      (isRecord(projectScopes) && Object.values(projectScopes).every((entry) => isScopeRecord(entry)))) &&
    (lastRequestedScope === undefined ||
      lastRequestedScope === 'project' ||
      lastRequestedScope === 'user') &&
    (lastRequestedAt === undefined || typeof lastRequestedAt === 'string')
  );
}

function isCodexPlatformRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { userScope, projectScopes, sharedNativeRefs, lastRequestedScope, lastRequestedAt } = value;
  const isScopeRecord = (scopeRecord: unknown): boolean =>
    isRecord(scopeRecord) &&
    typeof scopeRecord.managed === 'boolean' &&
    typeof scopeRecord.updatedAt === 'string' &&
    typeof scopeRecord.resolvedVersion === 'string' &&
    isRecord(scopeRecord.capabilitySnapshot);

  const sharedNativeRefsValid =
    sharedNativeRefs === undefined ||
    (isRecord(sharedNativeRefs) &&
      typeof sharedNativeRefs.user === 'boolean' &&
      isStringArray(sharedNativeRefs.projects));

  return (
    (userScope === undefined || isScopeRecord(userScope)) &&
    (projectScopes === undefined ||
      (isRecord(projectScopes) && Object.values(projectScopes).every((entry) => isScopeRecord(entry)))) &&
    sharedNativeRefsValid &&
    (lastRequestedScope === undefined ||
      lastRequestedScope === 'project' ||
      lastRequestedScope === 'user') &&
    (lastRequestedAt === undefined || typeof lastRequestedAt === 'string')
  );
}

function isInstalledLedgerPluginPlatforms(value: unknown): value is InstalledLedgerPluginPlatforms {
  return (
    isRecord(value) &&
    (value.claude === undefined || isClaudePlatformRecord(value.claude)) &&
    (value.codex === undefined || isCodexPlatformRecord(value.codex))
  );
}

export function normalizeSharedNativeRefs(value: unknown): CodexSharedNativeRefs | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.user !== 'boolean' || !isStringArray(value.projects)) {
    return null;
  }

  return {
    user: value.user,
    projects: [...new Set(value.projects)].sort(),
  };
}

export function validateInstalledLedger(rawValue: unknown): InstalledLedger | null {
  if (!isRecord(rawValue)) {
    return null;
  }

  if (rawValue.version !== 1 || !isRecord(rawValue.ledgerState) || !isRecord(rawValue.plugins)) {
    return null;
  }

  const status = rawValue.ledgerState.status;
  const degradedAt = rawValue.ledgerState.degradedAt;
  const reason = rawValue.ledgerState.reason;
  const validReasons: Array<LedgerStateReason | null> = [
    'rebuilt_from_missing_or_invalid',
    'operation_interrupted_after_native_write',
    'operation_interrupted_after_artifact_write',
    null,
  ];

  if (
    (status !== 'available' && status !== 'degraded') ||
    (degradedAt !== null && typeof degradedAt !== 'string') ||
    !validReasons.includes(reason as LedgerStateReason | null)
  ) {
    return null;
  }

  for (const pluginRecord of Object.values(rawValue.plugins)) {
    if (
      !isRecord(pluginRecord) ||
      typeof pluginRecord.lastResolvedVersion !== 'string' ||
      !isInstalledLedgerPluginPlatforms(pluginRecord.platforms)
    ) {
      return null;
    }
  }

  return rawValue as unknown as InstalledLedger;
}

function createDegradedLedger(reason: LedgerStateReason): InstalledLedger {
  return {
    version: 1,
    ledgerState: {
      status: 'degraded',
      degradedAt: new Date().toISOString(),
      reason,
    },
    plugins: {},
  };
}

export function createAvailableLedger(): InstalledLedger {
  return {
    version: 1,
    ledgerState: {
      status: 'available',
      degradedAt: null,
      reason: null,
    },
    plugins: {},
  };
}

export function getInstalledLedgerPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAwHome(env), 'installed.json');
}

export async function readInstalledLedger(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstalledLedger> {
  const rawLedger = await readJsonFileIfExists<unknown>(getInstalledLedgerPath(env));
  return validateInstalledLedger(rawLedger) ?? createDegradedLedger('rebuilt_from_missing_or_invalid');
}

export async function writeInstalledLedger(
  ledger: InstalledLedger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const ledgerPath = getInstalledLedgerPath(env);
  await fs.ensureDir(path.dirname(ledgerPath));
  const tempPath = path.join(
    path.dirname(ledgerPath),
    `${path.basename(ledgerPath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeJsonFile(tempPath, ledger);
  await fs.move(tempPath, ledgerPath, { overwrite: true });
}

export function resolveScopeInitialized(
  ledger: InstalledLedger | null,
  pluginName: string,
  platform: PlatformName,
  scope: Scope,
  projectKey?: string,
): 'yes' | 'no' | 'unknown' {
  if (!ledger) {
    return 'unknown';
  }

  const pluginRecord = ledger.plugins[pluginName];
  if (!pluginRecord) {
    return ledger.ledgerState.status === 'available' ? 'no' : 'unknown';
  }

  const platformRecord = pluginRecord.platforms[platform];
  if (!platformRecord) {
    return ledger.ledgerState.status === 'available' ? 'no' : 'unknown';
  }

  const scopeRecord =
    scope === 'user'
      ? platformRecord.userScope
      : projectKey
        ? platformRecord.projectScopes?.[projectKey]
        : undefined;

  if (!scopeRecord) {
    return ledger.ledgerState.status === 'available' ? 'no' : 'unknown';
  }

  return scopeRecord.managed ? 'yes' : 'no';
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'config.json' || entry.name === 'installed.json') {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listFilesRecursively(entryPath);
      files.push(
        ...nestedFiles.map((nestedFile) => path.join(entry.name, nestedFile).split(path.sep).join('/')),
      );
      continue;
    }

    files.push(entry.name);
  }

  return files.sort();
}

export async function calculateBundleFingerprint(rootDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const files = await listFilesRecursively(rootDir);

  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(rootDir, relativePath)));
    hash.update('\0');
  }

  return `sha256:${hash.digest('hex')}`;
}

export async function validateLocalMarketplaceLayout(rootDir: string): Promise<void> {
  await validateBundleLayout(rootDir);
}

async function copyBundleToStaging(embeddedRoot: string, stagingRoot: string): Promise<void> {
  await fs.copy(path.join(embeddedRoot, '.claude-plugin'), path.join(stagingRoot, '.claude-plugin'));
  await fs.copy(path.join(embeddedRoot, '.agents'), path.join(stagingRoot, '.agents'));
  await fs.copy(path.join(embeddedRoot, 'plugins'), path.join(stagingRoot, 'plugins'));
}

async function readLocalMarketplaceConfig(rootDir: string): Promise<LocalMarketplaceConfig | null> {
  return readJsonFileIfExists<LocalMarketplaceConfig>(path.join(rootDir, 'config.json'));
}

async function isFreshLocalMarketplace(
  awHome: string,
  sourceVersion: string,
  bundleFingerprint: string,
): Promise<boolean> {
  const config = await readLocalMarketplaceConfig(awHome);
  if (!config) {
    return false;
  }

  if (config.version !== 1) {
    return false;
  }

  if (config.sourceVersion !== sourceVersion || config.bundleFingerprint !== bundleFingerprint) {
    return false;
  }

  try {
    await validateLocalMarketplaceLayout(awHome);
    return true;
  } catch {
    return false;
  }
}

async function readPreservedLedger(awHome: string): Promise<InstalledLedger> {
  const rawLedger = await readJsonFileIfExists<unknown>(path.join(awHome, 'installed.json'));
  return validateInstalledLedger(rawLedger) ?? createDegradedLedger('rebuilt_from_missing_or_invalid');
}

async function replaceDirectoryAtomically(targetDir: string, stagingDir: string): Promise<void> {
  const parentDir = path.dirname(targetDir);
  const backupDir = path.join(parentDir, `.aw-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const targetExists = await fs.pathExists(targetDir);

  try {
    if (targetExists) {
      await fs.move(targetDir, backupDir, { overwrite: true });
    }

    await fs.move(stagingDir, targetDir, { overwrite: true });
    if (targetExists) {
      await fs.remove(backupDir);
    }
  } catch (error) {
    if (targetExists && !(await fs.pathExists(targetDir)) && (await fs.pathExists(backupDir))) {
      await fs.move(backupDir, targetDir, { overwrite: true });
    }
    throw error;
  }
}

export interface EnsureLocalMarketplaceResult {
  rootDir: string;
  changed: boolean;
}

export async function ensureLocalMarketplace(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnsureLocalMarketplaceResult> {
  return initializeLocalMarketplace({ force: false, env });
}

export async function initializeLocalMarketplace(
  options: { force: boolean; env?: NodeJS.ProcessEnv },
): Promise<EnsureLocalMarketplaceResult> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const embeddedRoot = await resolveEmbeddedPluginsRoot();
  const [packageInfo, bundleFingerprint] = await Promise.all([
    readCliPackageInfo(),
    calculateBundleFingerprint(embeddedRoot),
  ]);

  if (!options.force) {
    const isFresh = await isFreshLocalMarketplace(awHome, packageInfo.version, bundleFingerprint);
    if (isFresh) {
      return {
        rootDir: awHome,
        changed: false,
      };
    }
  }

  const parentDir = path.dirname(awHome);
  await fs.ensureDir(parentDir);
  const stagingDir = await fs.mkdtemp(path.join(parentDir, '.aw-staging-'));

  try {
    await copyBundleToStaging(embeddedRoot, stagingDir);
    const ledger = await readPreservedLedger(awHome);
    await writeJsonFile(path.join(stagingDir, 'installed.json'), ledger);
    await writeJsonFile(path.join(stagingDir, 'config.json'), {
      version: 1,
      initializedAt: new Date().toISOString(),
      sourcePackage: packageInfo.name,
      sourceVersion: packageInfo.version,
      bundleFingerprint,
    } satisfies LocalMarketplaceConfig);
    await validateLocalMarketplaceLayout(stagingDir);
    await replaceDirectoryAtomically(awHome, stagingDir);
  } catch (error) {
    await fs.remove(stagingDir);
    throw error;
  }

  return {
    rootDir: awHome,
    changed: true,
  };
}
