import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogChannel,
  CatalogResolution,
  CatalogSelector,
  CatalogVersion,
  CliVersion,
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
import { CURRENT_CATALOG_MANIFEST_FILE } from '../constants.js';
import { readInstallRecordFileAt } from '../install-state/facade.js';
import type { InstallRecordArtifact } from '../install-state/types.js';
import { AW_RUNTIME_STATE_PRESERVE_DIR_SET } from '../install-state/runtime-state.js';
import { readJsonFile, readJsonFileIfExistsSafe, writeJsonFile } from './json.js';
import {
  getCodexHome,
  resolveCurrentCatalogCacheEntriesDir,
  resolveCurrentCatalogCacheEntryDir,
  resolveCurrentCatalogCacheStagingDir,
  resolveAwHome,
  resolveCliTempRoot,
  resolveCliPackageRoot,
  resolveEmbeddedPluginsRoot,
} from './paths.js';
import { validateBundleLayout } from './bundle-layout.js';
import {
  assertStrictSemVer,
  compareStrictSemVer,
  tryParseStrictSemVer,
} from './manifest.js';
import { replaySkillTriggerPreferencesFromLedger } from './skill-trigger-preferences.js';
import { assertTestWritablePath } from './test-path-fence.js';

function resolveCliPackageJsonPath(): string {
  return path.join(resolveCliPackageRoot(), 'package.json');
}

export function getLocalMarketplacePluginRoot(rootDir: string, pluginName: string): string {
  return path.join(rootDir, 'plugins', pluginName);
}

export function getLocalMarketplaceCodexSkillsRoot(rootDir: string, pluginName: string): string {
  return path.join(getLocalMarketplacePluginRoot(rootDir, pluginName), 'codex', 'skills');
}

export function getLocalMarketplaceCodexSkillRoot(
  rootDir: string,
  pluginName: string,
  skillKey: string,
): string {
  return path.join(getLocalMarketplaceCodexSkillsRoot(rootDir, pluginName), skillKey);
}

const CODEX_PLATFORM_PLUGIN_MANIFEST_SKILLS_ROOT = './codex/skills';

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function hasCatalogSelectorOverride(env: NodeJS.ProcessEnv): boolean {
  return env.AW_CATALOG_VERSION !== undefined ||
    env.AW_CATALOG_CHANNEL === 'latest' ||
    env.AW_CATALOG_CHANNEL === 'beta' ||
    env.AW_CLI_VERSION !== undefined;
}

function resolveCodexManifestSkillsDeclaration(manifest: Record<string, unknown>): string {
  return typeof manifest.skills === 'string' && manifest.skills.trim() !== ''
    ? manifest.skills
    : CODEX_PLATFORM_PLUGIN_MANIFEST_SKILLS_ROOT;
}

function hasCodexManifestSkillsDeclaration(manifest: Record<string, unknown>): boolean {
  return typeof manifest.skills === 'string' && manifest.skills.trim() !== '';
}

function getCodexPlatformPluginManifestPath(pluginRoot: string): string {
  return path.join(pluginRoot, '.codex-plugin', 'plugin.json');
}

function resolveCodexManifestSkillsRoot(pluginRoot: string, manifestSkills: string): string {
  return path.join(pluginRoot, stripDotSlash(manifestSkills));
}

function getDeclaredCodexDynamicSkillKeys(sourceManifest: Record<string, unknown>): Set<string> {
  const skillTriggers = isRecord(sourceManifest.skillTriggers)
    ? sourceManifest.skillTriggers
    : {};
  const artifacts = isRecord(sourceManifest.artifacts) && Array.isArray(sourceManifest.artifacts.targets)
    ? sourceManifest.artifacts.targets
    : [];

  return new Set(
    artifacts
      .filter((artifact): artifact is Record<string, unknown> => isRecord(artifact))
      .filter((artifact) =>
        artifact.platform === 'codex' &&
        artifact.target === 'codex.skill' &&
        Array.isArray(artifact.scopes) &&
        artifact.scopes.includes('user') &&
        typeof artifact.skillKey === 'string' &&
        Object.hasOwn(skillTriggers, artifact.skillKey.trim()))
      .map((artifact) => (artifact.skillKey as string).trim()),
  );
}

async function pathIsDirectory(filePath: string): Promise<boolean> {
  const stats = await fs.stat(filePath).catch(() => null);
  return stats?.isDirectory() === true;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const key = path.resolve(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export async function stageLocalMarketplaceCodexDynamicSkills(
  options: {
    rootDir: string;
    pluginName: string;
    skillKeys: readonly string[];
  },
): Promise<void> {
  const manifestPath = getCodexPlatformPluginManifestPath(
    getLocalMarketplacePluginRoot(options.rootDir, options.pluginName),
  );
  const manifest = await readJsonFile<Record<string, unknown>>(manifestPath);
  const hasDeclaredSkills = hasCodexManifestSkillsDeclaration(manifest);
  const manifestSkills = resolveCodexManifestSkillsDeclaration(manifest);

  const runtimeSkillsRoot = getLocalMarketplaceCodexSkillsRoot(options.rootDir, options.pluginName);
  const manifestSkillsRoot = resolveCodexManifestSkillsRoot(
    getLocalMarketplacePluginRoot(options.rootDir, options.pluginName),
    manifestSkills,
  );

  if (path.resolve(runtimeSkillsRoot) !== path.resolve(manifestSkillsRoot)) {
    for (const skillKey of [...new Set(options.skillKeys)].sort()) {
      const sourceSkillRoot = path.join(runtimeSkillsRoot, skillKey);
      const targetSkillRoot = path.join(manifestSkillsRoot, skillKey);
      if (!(await fs.pathExists(sourceSkillRoot))) {
        await fs.remove(targetSkillRoot);
        continue;
      }

      await fs.remove(targetSkillRoot);
      await fs.ensureDir(path.dirname(targetSkillRoot));
      await fs.copy(sourceSkillRoot, targetSkillRoot, {
        overwrite: true,
        errorOnExist: false,
      });
    }
  }

  if (!hasDeclaredSkills && await pathIsDirectory(manifestSkillsRoot)) {
    await writeJsonFile(manifestPath, {
      ...manifest,
      skills: manifestSkills,
    });
  }
}

export interface LocalMarketplaceGateOptions {
  interactive?: boolean;
  confirmOverwrite?: (options: { message: string; defaultValue: boolean }) => Promise<boolean>;
  onNotice?: (message: string) => void | Promise<void>;
}

interface LocalMarketplaceConfigInspection {
  state: 'missing' | 'valid' | 'invalid';
  config: LocalMarketplaceConfig | null;
  sourceVersion: string | null | undefined;
}

type LocalMarketplaceSourceVersionStatus =
  | 'absent'
  | 'missing'
  | 'invalid'
  | 'ahead'
  | 'equal'
  | 'behind';

interface LocalMarketplaceInspection {
  awHome: string;
  embeddedRoot: string;
  packageInfo: {
    name: string;
    version: string;
  };
  bundleFingerprint: string;
  configInspection: LocalMarketplaceConfigInspection;
  sourceVersionStatus: LocalMarketplaceSourceVersionStatus;
  layoutHealthy: boolean;
  layoutError?: string;
}

export async function readCliPackageInfo(): Promise<{ name: string; version: string }> {
  const packageJson = await readJsonFile<{ name: string; version: string }>(resolveCliPackageJsonPath());
  const version = assertStrictSemVer(packageJson.version, 'packages/cli/package.json version');
  return {
    name: packageJson.name,
    version,
  };
}

export interface CurrentCatalogCacheIdentity {
  selector: CatalogSelector;
  channel: CatalogChannel;
  catalogVersion: CatalogVersion;
  minAwVersion: CliVersion;
  schemaVersion: number;
  historySchemaVersion: number | null;
  sidecarIntegrity: string;
  fullIntegrity: string;
}

export interface CurrentCatalogCacheEntryRecord extends CurrentCatalogCacheIdentity {
  version: 1;
  manifestDigest: string;
  createdAt: string;
}

export interface CurrentCatalogCacheEntry {
  cacheKey: string;
  selectorKey: string;
  rootDir: string;
  metadataPath: string;
  metadata: CurrentCatalogCacheEntryRecord;
}

function createSha256Digest(value: Buffer | string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function serializeCatalogSelectorForCache(selector: CatalogSelector): string {
  return JSON.stringify({
    kind: selector.kind,
    cliVersion: selector.cliVersion,
    defaultChannel: selector.defaultChannel,
    requestedChannel: selector.requestedChannel ?? null,
    requestedCatalogVersion: selector.requestedCatalogVersion ?? null,
  });
}

function createCurrentCatalogCacheIdentityPayload(
  identity: CurrentCatalogCacheIdentity,
): Record<string, unknown> {
  return {
    selector: serializeCatalogSelectorForCache(identity.selector),
    channel: identity.channel,
    catalogVersion: identity.catalogVersion,
    minAwVersion: identity.minAwVersion,
    schemaVersion: identity.schemaVersion,
    historySchemaVersion: identity.historySchemaVersion,
    sidecarIntegrity: identity.sidecarIntegrity,
    fullIntegrity: identity.fullIntegrity,
  };
}

export function buildCurrentCatalogCacheKey(
  identity: CurrentCatalogCacheIdentity,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(createCurrentCatalogCacheIdentityPayload(identity)))
    .digest('hex');
}

function getCurrentCatalogCacheMetadataPath(entryDir: string): string {
  return path.join(entryDir, 'entry.json');
}

function getCurrentCatalogCacheRootDir(entryDir: string): string {
  return path.join(entryDir, 'catalog');
}

function isCurrentCatalogCacheEntryRecord(value: unknown): value is CurrentCatalogCacheEntryRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    isRecord(value.selector) &&
    typeof value.channel === 'string' &&
    typeof value.catalogVersion === 'string' &&
    typeof value.minAwVersion === 'string' &&
    typeof value.schemaVersion === 'number' &&
    (value.historySchemaVersion === null || typeof value.historySchemaVersion === 'number') &&
    typeof value.sidecarIntegrity === 'string' &&
    typeof value.fullIntegrity === 'string' &&
    typeof value.manifestDigest === 'string' &&
    typeof value.createdAt === 'string'
  );
}

export async function readCurrentCatalogCacheEntry(
  identity: CurrentCatalogCacheIdentity,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CurrentCatalogCacheEntry | null> {
  const selectorKey = serializeCatalogSelectorForCache(identity.selector);
  const cacheKey = buildCurrentCatalogCacheKey(identity);
  const entryDir = resolveCurrentCatalogCacheEntryDir(cacheKey, env);
  const metadataPath = getCurrentCatalogCacheMetadataPath(entryDir);
  const rootDir = getCurrentCatalogCacheRootDir(entryDir);

  const metadata = await readJsonFileIfExistsSafe<unknown>(metadataPath);
  if (!isCurrentCatalogCacheEntryRecord(metadata)) {
    return null;
  }

  if (
    serializeCatalogSelectorForCache(metadata.selector) !== selectorKey ||
    metadata.channel !== identity.channel ||
    metadata.catalogVersion !== identity.catalogVersion ||
    metadata.minAwVersion !== identity.minAwVersion ||
    metadata.schemaVersion !== identity.schemaVersion ||
    metadata.historySchemaVersion !== identity.historySchemaVersion ||
    metadata.sidecarIntegrity !== identity.sidecarIntegrity ||
    metadata.fullIntegrity !== identity.fullIntegrity
  ) {
    return null;
  }

  const manifestPath = path.join(rootDir, CURRENT_CATALOG_MANIFEST_FILE);
  if (!(await fs.pathExists(manifestPath))) {
    return null;
  }

  const manifestDigest = createSha256Digest(await fs.readFile(manifestPath));
  if (manifestDigest !== metadata.manifestDigest) {
    return null;
  }

  return {
    cacheKey,
    selectorKey,
    rootDir,
    metadataPath,
    metadata,
  };
}

export async function writeCurrentCatalogCacheEntry(
  options: CurrentCatalogCacheIdentity & {
    sourceRoot: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CurrentCatalogCacheEntry> {
  const env = options.env ?? process.env;
  const selectorKey = serializeCatalogSelectorForCache(options.selector);
  const cacheKey = buildCurrentCatalogCacheKey(options);
  const entriesDir = resolveCurrentCatalogCacheEntriesDir(env);
  const stagingParent = resolveCurrentCatalogCacheStagingDir(env);
  await fs.ensureDir(stagingParent);
  const stagingDir = await fs.mkdtemp(path.join(stagingParent, `${cacheKey}-`));
  const finalEntryDir = resolveCurrentCatalogCacheEntryDir(cacheKey, env);
  const finalRootDir = getCurrentCatalogCacheRootDir(finalEntryDir);
  const metadataPath = getCurrentCatalogCacheMetadataPath(finalEntryDir);

  try {
    await fs.ensureDir(entriesDir);
    const stagedRootDir = getCurrentCatalogCacheRootDir(stagingDir);
    await fs.copy(options.sourceRoot, stagedRootDir);

    const manifestPath = path.join(stagedRootDir, CURRENT_CATALOG_MANIFEST_FILE);
    const manifestDigest = createSha256Digest(await fs.readFile(manifestPath));
    const metadata: CurrentCatalogCacheEntryRecord = {
      version: 1,
      selector: options.selector,
      channel: options.channel,
      catalogVersion: options.catalogVersion,
      minAwVersion: options.minAwVersion,
      schemaVersion: options.schemaVersion,
      historySchemaVersion: options.historySchemaVersion,
      sidecarIntegrity: options.sidecarIntegrity,
      fullIntegrity: options.fullIntegrity,
      manifestDigest,
      createdAt: new Date().toISOString(),
    };
    await writeJsonFile(getCurrentCatalogCacheMetadataPath(stagingDir), metadata);

    await fs.remove(finalEntryDir);
    await fs.move(stagingDir, finalEntryDir, { overwrite: true });

    return {
      cacheKey,
      selectorKey,
      rootDir: finalRootDir,
      metadataPath,
      metadata,
    };
  } catch (error) {
    await fs.remove(stagingDir);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isCatalogChannel(value: unknown): value is CatalogChannel {
  return value === 'latest' || value === 'beta';
}

function isStrictSemVerString(value: unknown): value is CliVersion {
  return typeof value === 'string' && tryParseStrictSemVer(value) !== null;
}

function isCatalogSelectorOverrideSource(
  value: unknown,
): value is NonNullable<CatalogSelector['overrideSource']> {
  return value === 'option:catalog-channel' ||
    value === 'option:channel-alias' ||
    value === 'option:catalog-version' ||
    value === 'env:AW_CATALOG_CHANNEL' ||
    value === 'env:AW_CATALOG_VERSION';
}

function isCatalogSelector(value: unknown): value is CatalogSelector {
  if (
    !isRecord(value) ||
    !isStrictSemVerString(value.cliVersion) ||
    !isCatalogChannel(value.defaultChannel) ||
    (value.overrideSource !== undefined && !isCatalogSelectorOverrideSource(value.overrideSource))
  ) {
    return false;
  }

  if (value.kind === 'default') {
    return value.requestedChannel === undefined && value.requestedCatalogVersion === undefined;
  }

  if (value.kind === 'distTag') {
    return isCatalogChannel(value.requestedChannel) && value.requestedCatalogVersion === undefined;
  }

  if (value.kind === 'exactVersion') {
    return isStrictSemVerString(value.requestedCatalogVersion) && value.requestedChannel === undefined;
  }

  return false;
}

function resolveDefaultLocalMarketplaceCatalogSelector(cliVersion: CliVersion): CatalogSelector {
  return {
    kind: 'default',
    cliVersion,
    defaultChannel: (tryParseStrictSemVer(cliVersion)?.prerelease.length ?? 0) > 0
      ? 'beta'
      : 'latest',
  };
}

function localMarketplaceCatalogSelectorMatches(
  config: LocalMarketplaceConfig,
  expectedSelector: CatalogSelector,
): boolean {
  return serializeCatalogSelectorForCache(config.catalogSelector) ===
    serializeCatalogSelectorForCache(expectedSelector);
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

  const allowedKeys = new Set(['name', 'minVersion', 'target', 'inheritInstallOptions', 'when']);
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
    (value.minVersion === undefined || typeof value.minVersion === 'string') &&
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
  ...AW_RUNTIME_STATE_PRESERVE_DIR_SET,
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
    value.version === 2 &&
    typeof value.initializedAt === 'string' &&
    typeof value.sourcePackage === 'string' &&
    typeof value.sourceVersion === 'string' &&
    isCatalogSelector(value.catalogSelector) &&
    typeof value.bundleFingerprint === 'string'
  );
}

export async function readLocalMarketplaceConfig(rootDir: string): Promise<LocalMarketplaceConfig | null> {
  const rawConfig = await readJsonFileIfExistsSafe<unknown>(path.join(rootDir, 'config.json'));
  return isLocalMarketplaceConfig(rawConfig) ? rawConfig : null;
}

async function inspectLocalMarketplaceConfig(
  rootDir: string,
): Promise<LocalMarketplaceConfigInspection> {
  const configPath = path.join(rootDir, 'config.json');
  if (!(await fs.pathExists(configPath))) {
    return {
      state: 'missing',
      config: null,
      sourceVersion: null,
    };
  }

  let rawConfig: unknown;
  try {
    rawConfig = await fs.readJson(configPath);
  } catch {
    return {
      state: 'invalid',
      config: null,
      sourceVersion: undefined,
    };
  }

  if (isLocalMarketplaceConfig(rawConfig)) {
    return {
      state: 'valid',
      config: rawConfig,
      sourceVersion: rawConfig.sourceVersion,
    };
  }

  return {
    state: 'invalid',
    config: null,
    sourceVersion: isRecord(rawConfig) && typeof rawConfig.sourceVersion === 'string'
      ? rawConfig.sourceVersion
      : null,
  };
}

function classifyLocalSourceVersionStatus(options: {
  inspection: LocalMarketplaceConfigInspection;
  cliVersion: string;
}): LocalMarketplaceSourceVersionStatus {
  if (options.inspection.state === 'missing') {
    return 'absent';
  }

  if (options.inspection.sourceVersion === undefined) {
    return 'invalid';
  }
  if (typeof options.inspection.sourceVersion !== 'string' || options.inspection.sourceVersion.trim() === '') {
    return 'missing';
  }

  const parsedSourceVersion = tryParseStrictSemVer(options.inspection.sourceVersion);
  if (!parsedSourceVersion) {
    return 'invalid';
  }

  const relation = compareStrictSemVer(parsedSourceVersion.raw, options.cliVersion);
  if (relation > 0) {
    return 'ahead';
  }
  if (relation < 0) {
    return 'behind';
  }
  return 'equal';
}

async function inspectLocalMarketplaceState(
  env: NodeJS.ProcessEnv = process.env,
  bundleRootOverride?: string,
): Promise<LocalMarketplaceInspection> {
  const awHome = resolveAwHome(env);
  const embeddedRoot = bundleRootOverride ?? await resolveEmbeddedPluginsRoot();
  const [packageInfo, bundleFingerprint, configInspection] = await Promise.all([
    readCliPackageInfo(),
    calculateBundleFingerprint(embeddedRoot),
    inspectLocalMarketplaceConfig(awHome),
  ]);
  const sourceVersionStatus = classifyLocalSourceVersionStatus({
    inspection: configInspection,
    cliVersion: packageInfo.version,
  });
  const validConfig = configInspection.state === 'valid' ? configInspection.config : null;

  let layoutHealthy = false;
  let layoutError: string | undefined;
  if (
    validConfig &&
    sourceVersionStatus === 'equal' &&
    validConfig.bundleFingerprint === bundleFingerprint
  ) {
    try {
      await validateLocalMarketplaceLayout(awHome);
      layoutHealthy = true;
    } catch (error) {
      layoutError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    awHome,
    embeddedRoot,
    packageInfo,
    bundleFingerprint,
    configInspection,
    sourceVersionStatus,
    layoutHealthy,
    ...(layoutError ? { layoutError } : {}),
  };
}

async function resolveCurrentCatalogBundleRoot(
  env: NodeJS.ProcessEnv,
): Promise<{ rootDir: string; selector: CatalogSelector | undefined }> {
  const { resolveCurrentCatalog } = await import('./plugin-catalog.js');
  const catalog = await resolveCurrentCatalog(env);
  await validateBundleLayout(catalog.rootDir);
  return {
    rootDir: catalog.rootDir,
    selector: catalog.selector,
  };
}

async function tryReuseExistingLocalMarketplace(
  env: NodeJS.ProcessEnv,
  expectedSelector: CatalogSelector,
): Promise<EnsureLocalMarketplaceResult | null> {
  const awHome = resolveAwHome(env);
  const [packageInfo, config] = await Promise.all([
    readCliPackageInfo(),
    readLocalMarketplaceConfig(awHome),
  ]);

  if (
    !config ||
    config.sourcePackage !== packageInfo.name ||
    config.sourceVersion !== packageInfo.version ||
    !localMarketplaceCatalogSelectorMatches(config, expectedSelector)
  ) {
    return null;
  }

  try {
    await validateLocalMarketplaceLayout(awHome);
    return {
      rootDir: awHome,
      changed: false,
      warnings: [],
    };
  } catch {
    return null;
  }
}

export async function resolveReadOnlyCatalogResolution(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogResolution> {
  const hasSelectorOverride = hasCatalogSelectorOverride(env);
  const { isCatalogResolutionError, resolveCurrentCatalog } = await import('./plugin-catalog.js');
  let currentCatalogError: unknown = null;
  let fallbackSelector: CatalogSelector | null = null;
  try {
    return await resolveCurrentCatalog(env);
  } catch (error) {
    if (!isCatalogResolutionError(error) || error.resolution.reasonCode !== 'catalogUnavailable') {
      throw error;
    }
    currentCatalogError = error;
    fallbackSelector = error.resolution.selector;
  }

  if (fallbackSelector) {
    const reusableMarketplace = await tryReuseExistingLocalMarketplace(env, fallbackSelector);
    if (reusableMarketplace) {
      return {
        rootDir: reusableMarketplace.rootDir,
        source: 'local',
        selector: fallbackSelector,
      };
    }
  }

  if (!hasSelectorOverride) {
    try {
      const embeddedRoot = await resolveEmbeddedPluginsRoot();
      await validateBundleLayout(embeddedRoot);
      return {
        rootDir: embeddedRoot,
        source: 'embedded',
        selector: fallbackSelector,
      };
    } catch {
      // Preserve the current catalog failure as the actionable error when the
      // embedded bundle is also unavailable or invalid.
    }
  }

  throw currentCatalogError;
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

async function replayCodexUserDynamicSkillsToMarketplace(options: {
  previousMarketplaceRoot: string;
  marketplaceRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const recordsDir = path.join(getCodexHome(options.env), '.agent-workflows', 'records');
  if (!(await fs.pathExists(recordsDir))) {
    return { warnings };
  }

  const recordEntries = (await fs.readdir(recordsDir))
    .filter((entry) => entry.endsWith('.json'))
    .sort();

  for (const entry of recordEntries) {
    const recordPath = path.join(recordsDir, entry);
    const recordRead = await readInstallRecordFileAt(recordPath, { env: options.env });
    if (recordRead.status !== 'ok') {
      warnings.push(`跳过 user dynamic skill replay：无法读取 install record ${recordPath}。`);
      continue;
    }

    const recordFile = recordRead.value;
    if (recordFile.record.platform !== 'codex' || recordFile.record.scope !== 'user') {
      continue;
    }

    const dynamicSkillArtifacts = recordFile.record.artifacts
      .filter((artifact): artifact is InstallRecordArtifact & { artifactKey: string } =>
        artifact.target === 'codex.skill' && Boolean(artifact.artifactKey));
    if (dynamicSkillArtifacts.length === 0) {
      continue;
    }

    const targetPluginManifestPath = getCodexPlatformPluginManifestPath(
      getLocalMarketplacePluginRoot(options.marketplaceRoot, recordFile.record.pluginName),
    );
    if (!(await fs.pathExists(targetPluginManifestPath))) {
      warnings.push(
        `跳过 user dynamic skill replay：current catalog 缺少 Codex plugin ${recordFile.record.pluginName}。`,
      );
      continue;
    }

    const targetPluginRoot = getLocalMarketplacePluginRoot(
      options.marketplaceRoot,
      recordFile.record.pluginName,
    );
    const targetSourceManifestPath = path.join(targetPluginRoot, '.agents-plugin', 'plugin.json');
    const targetSourceManifest = await readJsonFile<Record<string, unknown>>(targetSourceManifestPath);
    const declaredDynamicSkillKeys = getDeclaredCodexDynamicSkillKeys(targetSourceManifest);
    const targetCodexManifest = await readJsonFile<Record<string, unknown>>(targetPluginManifestPath);
    const targetManifestSkillsRoot = resolveCodexManifestSkillsRoot(
      targetPluginRoot,
      resolveCodexManifestSkillsDeclaration(targetCodexManifest),
    );

    for (const artifact of dynamicSkillArtifacts) {
      if (!declaredDynamicSkillKeys.has(artifact.artifactKey)) {
        warnings.push(
          `跳过 user dynamic skill replay：current catalog 不再为 user scope 声明 Codex dynamic skill ${recordFile.record.pluginName}/${artifact.artifactKey}。`,
        );
        continue;
      }

      const targetRuntimeSkillRoot = getLocalMarketplaceCodexSkillRoot(
        options.marketplaceRoot,
        recordFile.record.pluginName,
        artifact.artifactKey,
      );
      const targetSkillRoots = uniquePaths([
        targetRuntimeSkillRoot,
        path.join(targetManifestSkillsRoot, artifact.artifactKey),
      ]);

      if (artifact.state === 'disabled') {
        await Promise.all(targetSkillRoots.map((targetSkillRoot) => fs.remove(targetSkillRoot)));
        continue;
      }

      const sourceSkillRoot = path.isAbsolute(artifact.path)
        ? artifact.path
        : getLocalMarketplaceCodexSkillRoot(
            options.previousMarketplaceRoot,
            recordFile.record.pluginName,
            artifact.artifactKey,
          );
      if (!(await fs.pathExists(sourceSkillRoot))) {
        warnings.push(
          `跳过 user dynamic skill replay：缺少 runtime skill ${recordFile.record.pluginName}/${artifact.artifactKey}（${sourceSkillRoot}）。`,
        );
        await Promise.all(targetSkillRoots.map((targetSkillRoot) => fs.remove(targetSkillRoot)));
        continue;
      }

      for (const targetSkillRoot of targetSkillRoots) {
        await fs.remove(targetSkillRoot);
        await fs.ensureDir(path.dirname(targetSkillRoot));
        await fs.copy(sourceSkillRoot, targetSkillRoot, {
          overwrite: true,
          errorOnExist: false,
        });
      }
    }
  }

  return { warnings };
}

function resolveLocalMarketplaceTempRoot(env: NodeJS.ProcessEnv): string {
  return assertTestWritablePath(
    path.join(resolveCliTempRoot(env), 'local-marketplace'),
    'local marketplace temporary root',
    '用 createIsolatedTestEnv() 生成默认 TMPDIR，或通过 registerWritableStateRoot() 登记本地 marketplace 临时目录根。',
  );
}

function createLocalMarketplaceBackupDirPath(env: NodeJS.ProcessEnv): string {
  return assertTestWritablePath(
    path.join(
      resolveLocalMarketplaceTempRoot(env),
      'backups',
      `.aw-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ),
    'local marketplace backup dir',
    '用 createIsolatedTestEnv() 生成默认 TMPDIR，或通过 registerWritableStateRoot() 登记本地 marketplace backup 临时目录根。',
  );
}

async function replaceDirectoryAtomically(
  targetDir: string,
  stagingDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const backupDir = createLocalMarketplaceBackupDirPath(env);
  const targetExists = await fs.pathExists(targetDir);
  await fs.ensureDir(path.dirname(backupDir));

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

function localMarketplaceRequiresConfirmation(
  inspection: LocalMarketplaceInspection,
): boolean {
  return (
    inspection.sourceVersionStatus === 'missing' ||
    inspection.sourceVersionStatus === 'invalid' ||
    inspection.sourceVersionStatus === 'ahead'
  );
}

function createLocalMarketplaceOverwriteMessage(
  inspection: LocalMarketplaceInspection,
): string {
  if (
    inspection.configInspection.state === 'invalid' &&
    inspection.configInspection.sourceVersion === undefined
  ) {
    return `本地插件目录 ${inspection.awHome} 的 config.json 无法读取或 schema 不受支持，当前 CLI 无法安全判断是否应该覆盖。继续会用当前 embedded bundle 重建本地目录。`;
  }
  if (inspection.sourceVersionStatus === 'ahead') {
    return `本地插件目录 ${inspection.awHome} 的 sourceVersion ${inspection.configInspection.sourceVersion ?? 'unknown'} 高于当前 CLI 版本 ${inspection.packageInfo.version}。继续会用当前 embedded bundle 覆盖这份本地目录。`;
  }
  if (inspection.sourceVersionStatus === 'missing') {
    return `本地插件目录 ${inspection.awHome} 的 sourceVersion 缺失，当前 CLI 无法安全判断是否应该覆盖。继续会用当前 embedded bundle 重建本地目录。`;
  }
  return `本地插件目录 ${inspection.awHome} 的 sourceVersion ${inspection.configInspection.sourceVersion ?? 'unknown'} 不符合严格 SemVer 2.0.0，当前 CLI 无法安全判断是否应该覆盖。继续会用当前 embedded bundle 重建本地目录。`;
}

async function confirmLocalMarketplaceOverwrite(options: {
  inspection: LocalMarketplaceInspection;
  gate?: LocalMarketplaceGateOptions;
}): Promise<void> {
  const message = createLocalMarketplaceOverwriteMessage(options.inspection);
  await options.gate?.onNotice?.(message);

  if (!options.gate?.interactive || !options.gate.confirmOverwrite) {
    throw new Error(`${message} 非交互环境不会自动覆盖；请在交互模式下确认后重试。`);
  }

  const confirmed = await options.gate.confirmOverwrite({
    message: `${message} 是否继续覆盖？`,
    defaultValue: false,
  });
  if (!confirmed) {
    throw new Error('已取消覆盖本地插件目录，本次没有写入任何状态。');
  }
}

export interface EnsureLocalMarketplaceResult {
  rootDir: string;
  changed: boolean;
  warnings?: string[];
}

export async function ensureLocalMarketplace(
  env: NodeJS.ProcessEnv = process.env,
  gate?: LocalMarketplaceGateOptions,
): Promise<EnsureLocalMarketplaceResult> {
  return initializeLocalMarketplace({ force: false, env, gate });
}

export async function initializeLocalMarketplace(
  options: { force: boolean; env?: NodeJS.ProcessEnv; gate?: LocalMarketplaceGateOptions },
): Promise<EnsureLocalMarketplaceResult> {
  const env = options.env ?? process.env;
  let bundleRootOverride: string | undefined;
  let resolvedCatalogSelector: CatalogSelector | undefined;
  const resolveCurrentCatalogWithLocalFallback = async (): Promise<EnsureLocalMarketplaceResult | null> => {
    const { isCatalogResolutionError } = await import('./plugin-catalog.js');
    try {
      const resolved = await resolveCurrentCatalogBundleRoot(env);
      bundleRootOverride = resolved.rootDir;
      resolvedCatalogSelector = resolved.selector;
      return null;
    } catch (error) {
      if (
        !options.force &&
        isCatalogResolutionError(error) &&
        error.resolution.reasonCode === 'catalogUnavailable'
      ) {
        const reusableMarketplace = await tryReuseExistingLocalMarketplace(
          env,
          error.resolution.selector,
        );
        if (reusableMarketplace) {
          return reusableMarketplace;
        }
      }
      throw error;
    }
  };
  if (hasCatalogSelectorOverride(env)) {
    const reusableMarketplace = await resolveCurrentCatalogWithLocalFallback();
    if (reusableMarketplace) {
      return reusableMarketplace;
    }
  } else {
    try {
      bundleRootOverride = await resolveEmbeddedPluginsRoot();
    } catch {
      const reusableMarketplace = await resolveCurrentCatalogWithLocalFallback();
      if (reusableMarketplace) {
        return reusableMarketplace;
      }
    }
  }
  const inspection = await inspectLocalMarketplaceState(env, bundleRootOverride);
  const validConfig = inspection.configInspection.state === 'valid'
    ? inspection.configInspection.config
    : null;
  const expectedCatalogSelector = resolvedCatalogSelector ??
    resolveDefaultLocalMarketplaceCatalogSelector(inspection.packageInfo.version);

  if (
    !options.force &&
    validConfig &&
    inspection.sourceVersionStatus === 'equal' &&
    validConfig.bundleFingerprint === inspection.bundleFingerprint &&
    localMarketplaceCatalogSelectorMatches(validConfig, expectedCatalogSelector) &&
    inspection.layoutHealthy
  ) {
    return {
      rootDir: inspection.awHome,
      changed: false,
      warnings: [],
    };
  }

  if (localMarketplaceRequiresConfirmation(inspection)) {
    await confirmLocalMarketplaceOverwrite({
      inspection,
      gate: options.gate,
    });
  }

  const stagingParent = assertTestWritablePath(
    path.join(resolveLocalMarketplaceTempRoot(env), 'staging'),
    'local marketplace staging root',
    '用 createIsolatedTestEnv() 生成默认 TMPDIR，或通过 registerWritableStateRoot() 登记本地 marketplace staging 临时目录根。',
  );
  await fs.ensureDir(stagingParent);
  const stagingDir = await fs.mkdtemp(path.join(stagingParent, '.aw-staging-'));
  const warnings: string[] = [];

  try {
    await copyBundleToStaging(inspection.embeddedRoot, stagingDir);
    const { ledger, ledgerFileExists } = await readPreservedLedger(inspection.awHome);
    await preserveLocalRuntimeStateDirectories(inspection.awHome, stagingDir);
    const replay = await replaySkillTriggerPreferencesFromLedger({
      ledger,
      marketplaceRoot: stagingDir,
      embeddedRoot: inspection.embeddedRoot,
      previousMarketplaceRoot: inspection.awHome,
      warnOnDegraded: ledgerFileExists,
    });
    warnings.push(...replay.warnings);
    const dynamicSkillReplay = await replayCodexUserDynamicSkillsToMarketplace({
      previousMarketplaceRoot: inspection.awHome,
      marketplaceRoot: stagingDir,
      env,
    });
    warnings.push(...dynamicSkillReplay.warnings);
    await writeJsonFile(path.join(stagingDir, 'installed.json'), ledger);
    await writeJsonFile(path.join(stagingDir, 'config.json'), {
      version: 2,
      initializedAt: new Date().toISOString(),
      sourcePackage: inspection.packageInfo.name,
      sourceVersion: inspection.packageInfo.version,
      catalogSelector: expectedCatalogSelector,
      bundleFingerprint: inspection.bundleFingerprint,
    } satisfies LocalMarketplaceConfig);
    await validateLocalMarketplaceLayout(stagingDir);
    await replaceDirectoryAtomically(inspection.awHome, stagingDir, env);
  } catch (error) {
    await fs.remove(stagingDir);
    throw error;
  }

  return {
    rootDir: inspection.awHome,
    changed: true,
    warnings,
  };
}
