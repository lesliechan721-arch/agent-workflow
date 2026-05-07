import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  InstalledDependencyEdge,
  CodexSharedNativeRefs,
  GeneratedArtifact,
  InstalledLedger,
  InstalledLedgerPluginPlatforms,
  InstalledScopeInstallSource,
  LedgerStateReason,
  LocalMarketplaceConfig,
  PlatformName,
  Scope,
} from '../types.js';
import { readJsonFile, readJsonFileIfExistsSafe, writeJsonFile } from './json.js';
import { CODEX_NATIVE_RECOVERY_DIR } from './codex-native-recovery.js';
import {
  resolveAwHome,
  resolveCliPackageRoot,
  resolveEmbeddedPluginsRoot,
} from './paths.js';
import { validateBundleLayout } from './bundle-layout.js';
import { replaySkillTriggerPreferencesFromLedger } from './skill-trigger-preferences.js';

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

function isSkillTriggerPreference(value: unknown): boolean {
  return value === 'default' || value === 'manual' || value === 'auto';
}

function isScope(value: unknown): value is Scope {
  return value === 'user' || value === 'project';
}

function isPlatformName(value: unknown): value is PlatformName {
  return value === 'codex' || value === 'claude';
}

function isUniquePlatformNameArray(value: unknown): value is PlatformName[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isPlatformName(entry)) &&
    new Set(value).size === value.length
  );
}

function isInstalledScopeInstallOptions(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = new Set(['skillTriggerPreference']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }

  return (
    value.skillTriggerPreference === undefined ||
    isSkillTriggerPreference(value.skillTriggerPreference)
  );
}

function isInstalledScopeInstallSource(value: unknown): value is InstalledScopeInstallSource {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = new Set(['kind', 'explicitlyRequested', 'allowsUnusedCleanup']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }

  return (
    (value.kind === 'explicit' || value.kind === 'dependency') &&
    typeof value.explicitlyRequested === 'boolean' &&
    typeof value.allowsUnusedCleanup === 'boolean'
  );
}

function isPluginLocation(value: unknown): boolean {
  if (!isRecord(value) || !isScope(value.scope) || !isPlatformName(value.platform) || typeof value.plugin !== 'string') {
    return false;
  }

  if (value.scope === 'user') {
    return value.projectKey === undefined || value.projectKey === null;
  }

  return typeof value.projectKey === 'string';
}

function isInstalledDependencyEdgeDeclaration(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return false;
  }

  const allowedKeys = new Set(['name', 'target', 'inheritInstallOptions', 'when']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }

  const validTarget =
    value.target === undefined ||
    (
      isRecord(value.target) &&
      Object.keys(value.target).every((key) => key === 'scope') &&
      (value.target.scope === undefined || isScope(value.target.scope))
    );
  const validWhen =
    value.when === undefined ||
    (
      isRecord(value.when) &&
      Object.keys(value.when).every((key) => key === 'platforms') &&
      isUniquePlatformNameArray(value.when.platforms)
    );

  return (
    validTarget &&
    validWhen &&
    (value.inheritInstallOptions === undefined || typeof value.inheritInstallOptions === 'boolean')
  );
}

function isInstalledDependencyEdge(value: unknown): value is InstalledDependencyEdge {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = new Set(['dependency', 'declaration']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }

  return isPluginLocation(value.dependency) && isInstalledDependencyEdgeDeclaration(value.declaration);
}

function isLifecycleConfigSnapshotMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const createdFrom = value.createdFrom;
  return (
    typeof value.snapshotRoot === 'string' &&
    typeof value.bundleRoot === 'string' &&
    typeof value.manifestPath === 'string' &&
    typeof value.pluginName === 'string' &&
    typeof value.pluginVersion === 'string' &&
    typeof value.sourceManifestDigest === 'string' &&
    typeof value.bundleFingerprint === 'string' &&
    typeof value.createdAt === 'string' &&
    isRecord(createdFrom) &&
    (
      createdFrom.source === 'currentCatalog' ||
      createdFrom.source === 'test' ||
      createdFrom.source === 'unknown'
    ) &&
    (createdFrom.catalogRoot === undefined || typeof createdFrom.catalogRoot === 'string') &&
    (createdFrom.catalogSource === undefined ||
      createdFrom.catalogSource === 'local' ||
      createdFrom.catalogSource === 'embedded') &&
    (createdFrom.pluginRoot === undefined || typeof createdFrom.pluginRoot === 'string')
  );
}

function isInstalledScopeRecord(
  value: unknown,
  options: { requireDependencyMetadata?: boolean } = {},
): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = new Set([
    'managed',
    'updatedAt',
    'resolvedVersion',
    'capabilitySnapshot',
    'projectKey',
    'installSource',
    'dependencyEdges',
    'installOptions',
    'skillTriggerWriteOrder',
    'lifecycleConfigSnapshot',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }

  if (
    typeof value.managed !== 'boolean' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.resolvedVersion !== 'string' ||
    !isRecord(value.capabilitySnapshot)
  ) {
    return false;
  }

  if (value.installOptions !== undefined && !isInstalledScopeInstallOptions(value.installOptions)) {
    return false;
  }

  if (value.installSource !== undefined && !isInstalledScopeInstallSource(value.installSource)) {
    return false;
  }

  if (
    value.dependencyEdges !== undefined &&
    (!Array.isArray(value.dependencyEdges) || value.dependencyEdges.some((edge) => !isInstalledDependencyEdge(edge)))
  ) {
    return false;
  }

  if (options.requireDependencyMetadata && (value.installSource === undefined || value.dependencyEdges === undefined)) {
    return false;
  }

  if (value.lifecycleConfigSnapshot !== undefined && !isLifecycleConfigSnapshotMetadata(value.lifecycleConfigSnapshot)) {
    return false;
  }

  if (value.projectKey !== undefined && typeof value.projectKey !== 'string') {
    return false;
  }

  return (
    value.skillTriggerWriteOrder === undefined ||
    (
      typeof value.skillTriggerWriteOrder === 'number' &&
      Number.isInteger(value.skillTriggerWriteOrder) &&
      value.skillTriggerWriteOrder >= 0
    )
  );
}

function isClaudePlatformRecord(
  value: unknown,
  options: { requireDependencyMetadata?: boolean } = {},
): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { userScope, projectScopes, lastRequestedScope, lastRequestedAt } = value;

  return (
    (userScope === undefined || isInstalledScopeRecord(userScope, options)) &&
    (projectScopes === undefined ||
      (isRecord(projectScopes) && Object.values(projectScopes).every((entry) => isInstalledScopeRecord(entry, options)))) &&
    (lastRequestedScope === undefined ||
      lastRequestedScope === 'project' ||
      lastRequestedScope === 'user') &&
    (lastRequestedAt === undefined || typeof lastRequestedAt === 'string')
  );
}

function isCodexPlatformRecord(
  value: unknown,
  options: { requireDependencyMetadata?: boolean } = {},
): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { userScope, projectScopes, sharedNativeRefs, lastRequestedScope, lastRequestedAt } = value;

  const sharedNativeRefsValid =
    sharedNativeRefs === undefined ||
    (isRecord(sharedNativeRefs) &&
      typeof sharedNativeRefs.user === 'boolean' &&
      isStringArray(sharedNativeRefs.projects));

  return (
    (userScope === undefined || isInstalledScopeRecord(userScope, options)) &&
    (projectScopes === undefined ||
      (isRecord(projectScopes) && Object.values(projectScopes).every((entry) => isInstalledScopeRecord(entry, options)))) &&
    sharedNativeRefsValid &&
    (lastRequestedScope === undefined ||
      lastRequestedScope === 'project' ||
      lastRequestedScope === 'user') &&
    (lastRequestedAt === undefined || typeof lastRequestedAt === 'string')
  );
}

function isInstalledLedgerPluginPlatforms(
  value: unknown,
  options: { requireDependencyMetadata?: boolean } = {},
): value is InstalledLedgerPluginPlatforms {
  return (
    isRecord(value) &&
    (value.claude === undefined || isClaudePlatformRecord(value.claude, options)) &&
    (value.codex === undefined || isCodexPlatformRecord(value.codex, options))
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

export function validateInstalledLedger(
  rawValue: unknown,
  options: { requireDependencyMetadata?: boolean } = {},
): InstalledLedger | null {
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
    'capability_changed_upgrade_restore_incomplete',
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
      !isInstalledLedgerPluginPlatforms(pluginRecord.platforms, options)
    ) {
      return null;
    }
  }

  return rawValue as unknown as InstalledLedger;
}

export function hasInstalledLedgerDependencyMetadata(
  ledger: InstalledLedger | null,
): boolean {
  return ledger !== null && validateInstalledLedger(ledger, { requireDependencyMetadata: true }) !== null;
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

const LOCAL_MARKETPLACE_RUNTIME_STATE_DIRS = new Set([
  'plugin-config',
  'plugin-install-snapshots',
  CODEX_NATIVE_RECOVERY_DIR,
]);

export function getInstalledLedgerPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAwHome(env), 'installed.json');
}

export async function readInstalledLedger(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstalledLedger> {
  const rawLedger = await readJsonFileIfExistsSafe<unknown>(getInstalledLedgerPath(env));
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

export function resolveCodexProjectScopeInitialized(options: {
  ledger: InstalledLedger | null;
  pluginName: string;
  projectKey?: string;
  trackingArtifacts?: GeneratedArtifact[];
  trackingIdentityComplete: boolean;
  externalOwnershipPresent?: boolean;
}): 'yes' | 'no' | 'unknown' {
  const ledgerScopeInitialized = resolveScopeInitialized(
    options.ledger,
    options.pluginName,
    'codex',
    'project',
    options.projectKey,
  );
  if (ledgerScopeInitialized === 'yes') {
    return 'yes';
  }

  if (!options.projectKey) {
    return 'unknown';
  }

  const trackedArtifacts = (options.trackingArtifacts ?? []).filter((artifact) => artifact.platform === 'codex');
  if (trackedArtifacts.length > 0) {
    return options.trackingIdentityComplete ? 'yes' : 'unknown';
  }

  if (options.externalOwnershipPresent === true) {
    return 'no';
  }

  return ledgerScopeInitialized;
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'config.json' || entry.name === 'installed.json') {
      continue;
    }
    if (LOCAL_MARKETPLACE_RUNTIME_STATE_DIRS.has(entry.name)) {
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

function isLocalMarketplaceConfig(value: unknown): value is LocalMarketplaceConfig {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.initializedAt === 'string' &&
    typeof value.sourcePackage === 'string' &&
    typeof value.sourceVersion === 'string' &&
    typeof value.bundleFingerprint === 'string'
  );
}

export async function readLocalMarketplaceConfig(rootDir: string): Promise<LocalMarketplaceConfig | null> {
  const rawConfig = await readJsonFileIfExistsSafe<unknown>(path.join(rootDir, 'config.json'));
  return isLocalMarketplaceConfig(rawConfig) ? rawConfig : null;
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

async function readPreservedLedger(
  awHome: string,
): Promise<{ ledger: InstalledLedger; ledgerFileExists: boolean }> {
  const ledgerPath = path.join(awHome, 'installed.json');
  const ledgerFileExists = await fs.pathExists(ledgerPath);
  const rawLedger = await readJsonFileIfExistsSafe<unknown>(ledgerPath);
  return {
    ledger: validateInstalledLedger(rawLedger) ?? createDegradedLedger('rebuilt_from_missing_or_invalid'),
    ledgerFileExists,
  };
}

async function preserveLocalRuntimeStateDirectories(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const directoryName of LOCAL_MARKETPLACE_RUNTIME_STATE_DIRS) {
    const sourceDir = path.join(sourceRoot, directoryName);
    if (!(await fs.pathExists(sourceDir))) {
      continue;
    }

    await fs.copy(sourceDir, path.join(targetRoot, directoryName), {
      overwrite: true,
      errorOnExist: false,
    });
  }
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
      await preserveLocalRuntimeStateDirectories(backupDir, targetDir);
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
  warnings?: string[];
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
        warnings: [],
      };
    }
  }

  const parentDir = path.dirname(awHome);
  await fs.ensureDir(parentDir);
  const stagingDir = await fs.mkdtemp(path.join(parentDir, '.aw-staging-'));
  const warnings: string[] = [];

  try {
    await copyBundleToStaging(embeddedRoot, stagingDir);
    const { ledger, ledgerFileExists } = await readPreservedLedger(awHome);
    await preserveLocalRuntimeStateDirectories(awHome, stagingDir);
    const replay = await replaySkillTriggerPreferencesFromLedger({
      ledger,
      marketplaceRoot: stagingDir,
      embeddedRoot,
      previousMarketplaceRoot: awHome,
      warnOnDegraded: ledgerFileExists,
    });
    warnings.push(...replay.warnings);
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
    warnings,
  };
}
