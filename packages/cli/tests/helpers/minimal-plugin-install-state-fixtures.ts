import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

export type PlatformName = 'codex' | 'claude';
export type Scope = 'user' | 'project';

export type MinimalInstallStateKind =
  | 'installed'
  | 'cleanupRequired'
  | 'external'
  | 'notInstalled';

export type MinimalInstallFixtureScenario =
  | 'installed'
  | 'needsRepair'
  | 'adoptable'
  | 'residual'
  | 'externallyManaged'
  | 'notInstalled'
  | 'freshCloneProject'
  | 'corruptedRecord'
  | 'corruptedDiagnosticCache'
  | 'corruptedIdentityMetadata'
  | 'staleDependencyIndex'
  | 'unreadableDependencyIndex'
  | 'missingHistoricalLifecycle'
  | 'nativeMarkerOnly'
  | 'recordAndInstallMarkerResidual';

export type RepoManagedArtifactKind =
  | 'instruction'
  | 'permission'
  | 'hook'
  | 'agent'
  | 'skill'
  | 'mcpServer';

export interface PluginLocation {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string | null;
}

export interface HistoricalLifecycleRuntimeRef {
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
  pluginVersion: string;
  sourceManifestDigest: string;
  bundleFingerprint: string;
  events: Array<'install' | 'upgrade' | 'uninstall'>;
  createdAt: string;
}

export interface InstallRecordInstallSource {
  kind: 'explicit' | 'dependency';
  explicitlyRequested: boolean;
}

export interface InstallRecordDependencyEdge {
  dependency: PluginLocation;
  declaration: {
    name: string;
    target?: {
      scope?: Scope;
    };
    inheritInstallOptions?: boolean;
    when?: {
      platforms?: PlatformName[];
    };
  };
}

export interface InstallRecordArtifact {
  kind: RepoManagedArtifactKind;
  platform: PlatformName;
  path: string;
  paths?: string[];
  artifactKey?: string;
  hookGroups?: Array<{ id: string; event: string }>;
  id?: string;
  target?: 'codex.developerInstructionsBlock' | 'codex.agentRole';
  roleKey?: string;
  ownershipMarker?: string;
  state?: 'present' | 'disabled';
  configDigest?: string;
  contentDigest?: string;
}

export interface InstallRecord {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  installedAt: string;
  updatedAt: string;
  source: {
    pluginVersion: string;
    manifestDigest: string;
    bundleFingerprint: string;
  };
  installSource: InstallRecordInstallSource;
  options?: {
    skillTriggerPreference?: 'default' | 'manual' | 'auto';
  };
  native?: {
    pluginId: string;
    installedByAw: boolean;
  };
  lifecycle?: HistoricalLifecycleRuntimeRef;
  artifacts: InstallRecordArtifact[];
  dependencyEdges: InstallRecordDependencyEdge[];
}

export interface InstallRecordFile {
  version: 2;
  recordId: string;
  record: InstallRecord;
}

export interface DynamicArtifactDiagnosticEntry {
  id: string;
  target: string;
  state: 'present' | 'disabled';
  disabledReason?: string;
  artifactKey?: string;
  roleKey?: string;
  refreshKeys?: string[];
  configDigest?: string;
  contentDigest?: string;
  lastRefresh?: {
    status: 'success' | 'failed';
    at: string;
    event: 'install' | 'upgrade' | 'repair' | 'config';
    error?: string;
  };
  refreshReach?: {
    commandScope: 'user' | 'projectShared';
    refreshedUserTarget?: boolean;
    refreshedCurrentProjectTarget?: boolean;
  };
}

export interface DynamicArtifactDiagnosticCache {
  version: 1;
  recordId: string;
  location: PluginLocation;
  updatedAt: string;
  artifacts: DynamicArtifactDiagnosticEntry[];
}

export interface ProjectArtifactSharedLocator {
  plugin: string;
  platform: PlatformName;
  scope: 'project';
  repoRelativeProjectRoot: string;
}

export interface ProjectArtifactIdentityArtifact {
  kind: RepoManagedArtifactKind;
  platform: PlatformName;
  path: string;
  paths?: string[];
  artifactKey?: string;
  hookGroups?: Array<{ id: string; event: string }>;
  id?: string;
  target?: string;
  roleKey?: string;
  ownershipMarker?: string;
  state?: 'present' | 'disabled';
  contentDigest?: string;
}

export interface ProjectArtifactIdentityFile {
  version: 1;
  sharedIdentityId: string;
  locator: ProjectArtifactSharedLocator;
  source: {
    pluginVersion: string;
    manifestDigest: string;
    bundleFingerprint: string;
  };
  generatedAt: string;
  artifacts: ProjectArtifactIdentityArtifact[];
}

export interface GlobalDependencyIndexRecord {
  location: PluginLocation;
  recordPath: string;
  recordDigest: string;
  installSource: InstallRecordInstallSource;
  dependencyEdges: InstallRecordDependencyEdge[];
  lastSeenAt: string;
}

export interface GlobalDependencyIndex {
  version: 1;
  updatedAt: string;
  records: GlobalDependencyIndexRecord[];
}

export interface NativeTransactionMarker {
  version: 1;
  pluginName: string;
  pluginId: `${string}@aw`;
  platform: 'codex';
  scope: 'user';
  operation: 'install' | 'uninstall';
  nativeWriteSucceeded: true;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface SharedSkillTriggerRuntimeOwner {
  version: 1;
  pluginName: string;
  platform: PlatformName;
  owner: PluginLocation;
  ownerRecordPath: string;
  ownerRecordDigest: string;
  preference: 'default' | 'manual' | 'auto';
  updatedAt: string;
}

export interface MinimalPluginInstallStatePaths {
  rootDir: string;
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
}

export interface MinimalFixtureTarget {
  location: PluginLocation;
  recordId: string;
  pluginSlug: string;
  pluginHash: string;
  pluginId: `${string}@aw`;
  sharedIdentityId: string;
  locator: ProjectArtifactSharedLocator;
  repoArtifactRelativePath: string;
  repoArtifactPath: string;
  repoArtifactContent: string;
  repoArtifactDigest: string;
  runtimeId: string;
  timestamps: {
    installedAt: string;
    updatedAt: string;
    createdAt: string;
  };
  source: {
    pluginVersion: string;
    manifestDigest: string;
    bundleFingerprint: string;
  };
}

export interface MinimalFixtureResult {
  scenario: MinimalInstallFixtureScenario;
  state: MinimalInstallStateKind;
  paths: MinimalPluginInstallStatePaths;
  target: MinimalFixtureTarget;
  files: {
    installRecordPath: string;
    diagnosticCachePath: string;
    projectIdentityPath: string;
    dependencyIndexPath: string;
    lifecycleRuntimeRoot: string;
    nativeMarkerPath: string;
    sharedOwnerPath: string;
    externalNativeConfigPath: string;
    externalNativeCachePath: string;
  };
}

export interface ScopedRecordReadSuccess {
  path: string;
  recordId: string;
  value: InstallRecordFile;
}

export interface ScopedRecordReadFailure {
  path: string;
  error: string;
}

export interface ScopedRecordDirectoryRead {
  successes: ScopedRecordReadSuccess[];
  failures: ScopedRecordReadFailure[];
}

export interface LegacyStateBoundary {
  boundary: string;
  reads: string[];
  writes: string[];
}

export interface LegacyStateSurface {
  id: string;
  readPath: string;
  writePath: string;
  notes: string;
}

export interface LegacyFieldDisposition {
  legacyField: string;
  disposition: 'deleted' | 'installRecord' | 'diagnosticCache' | 'derived';
  targetField?: string;
  notes?: string;
}

export const DEFAULT_FORBIDDEN_STDOUT_TERMS = [
  'ledger',
  'tracking',
  'breadcrumb',
  'snapshot',
  'degraded',
] as const;

export const LEGACY_STATE_BOUNDARIES: LegacyStateBoundary[] = [
  {
    boundary: 'install',
    reads: ['installed.json', 'tracking manifest', 'Codex breadcrumb'],
    writes: ['installed.json', 'tracking manifest', 'install snapshot', 'Codex breadcrumb'],
  },
  {
    boundary: 'upgrade',
    reads: ['installed.json', 'tracking manifest', 'capability snapshot', 'install snapshot'],
    writes: ['installed.json', 'tracking manifest', 'install snapshot', 'Codex breadcrumb'],
  },
  {
    boundary: 'uninstall',
    reads: ['installed.json', 'tracking manifest', 'install snapshot', 'Codex breadcrumb'],
    writes: ['installed.json', 'tracking manifest', 'Codex breadcrumb'],
  },
  {
    boundary: 'status',
    reads: ['installed.json', 'tracking manifest', 'install snapshot', 'capability snapshot', 'Codex breadcrumb'],
    writes: [],
  },
  {
    boundary: 'discovery',
    reads: ['installed.json', 'tracking manifest', 'Codex breadcrumb'],
    writes: [],
  },
  {
    boundary: 'console',
    reads: ['installed.json', 'tracking manifest', 'capability snapshot'],
    writes: [],
  },
  {
    boundary: 'config refresh',
    reads: ['installed.json', 'tracking manifest', 'capability snapshot'],
    writes: ['tracking manifest', 'installed.json'],
  },
  {
    boundary: 'adapter tracking',
    reads: ['tracking manifest', 'Codex breadcrumb'],
    writes: ['tracking manifest', 'Codex breadcrumb'],
  },
  {
    boundary: 'local marketplace refresh',
    reads: ['installed.json', 'Codex breadcrumb'],
    writes: ['Codex breadcrumb'],
  },
];

export const LEGACY_STATE_SURFACES: LegacyStateSurface[] = [
  {
    id: 'installed.json',
    readPath: '~/.aw/installed.json',
    writePath: '~/.aw/installed.json',
    notes: 'legacy install ledger and capability snapshot carrier',
  },
  {
    id: 'tracking manifest',
    readPath: '<scope-root>/.agent-workflows-manifest.json',
    writePath: '<scope-root>/.agent-workflows-manifest.json',
    notes: 'legacy repo-managed artifact ownership and dynamic refresh cache',
  },
  {
    id: 'install snapshot',
    readPath: '~/.aw/plugin-install-snapshots/<platform>/<plugin>/<scope>/...',
    writePath: '~/.aw/plugin-install-snapshots/<platform>/<plugin>/<scope>/...',
    notes: 'legacy lifecycle and install-time runtime snapshot root',
  },
  {
    id: 'capability snapshot',
    readPath: '~/.aw/installed.json -> plugins[].platforms.*.capabilitySnapshot',
    writePath: '~/.aw/installed.json -> plugins[].platforms.*.capabilitySnapshot',
    notes: 'legacy command-side capability cache embedded inside installed.json',
  },
  {
    id: 'Codex breadcrumb',
    readPath: '~/.aw/native-recovery/codex/user/<pluginId>.json',
    writePath: '~/.aw/native-recovery/codex/user/<pluginId>.json',
    notes: 'legacy Codex native recovery breadcrumb envelope before the new marker model',
  },
];

export const LEGACY_FIELD_DISPOSITIONS: LegacyFieldDisposition[] = [
  { legacyField: 'ledgerState', disposition: 'deleted' },
  { legacyField: 'degradedAt', disposition: 'deleted' },
  { legacyField: 'degradedReason', disposition: 'deleted' },
  { legacyField: 'scopeInitialized', disposition: 'deleted' },
  { legacyField: 'capabilitySnapshot', disposition: 'deleted' },
  { legacyField: 'lastRequestedScope', disposition: 'deleted' },
  { legacyField: 'lastRequestedAt', disposition: 'deleted' },
  { legacyField: 'sharedNativeRefs', disposition: 'deleted' },
  { legacyField: 'skillTriggerWriteOrder', disposition: 'deleted' },
  {
    legacyField: 'lastResolvedVersion',
    disposition: 'installRecord',
    targetField: 'record.source.pluginVersion',
  },
  {
    legacyField: 'installOptions.skillTriggerPreference',
    disposition: 'installRecord',
    targetField: 'record.options.skillTriggerPreference',
  },
  {
    legacyField: 'native.installedByAw',
    disposition: 'installRecord',
    targetField: 'record.native.installedByAw',
  },
  {
    legacyField: 'generatedArtifacts',
    disposition: 'installRecord',
    targetField: 'record.artifacts',
  },
  {
    legacyField: 'dependencyInstallSource',
    disposition: 'installRecord',
    targetField: 'record.installSource',
  },
  {
    legacyField: 'outgoingDependencyEdges',
    disposition: 'installRecord',
    targetField: 'record.dependencyEdges',
  },
  {
    legacyField: 'lifecycleConfigSnapshot',
    disposition: 'installRecord',
    targetField: 'record.lifecycle',
  },
  {
    legacyField: 'lastRefresh',
    disposition: 'diagnosticCache',
    targetField: 'cache.artifacts[].lastRefresh',
  },
  {
    legacyField: 'refreshReach',
    disposition: 'diagnosticCache',
    targetField: 'cache.artifacts[].refreshReach',
  },
  {
    legacyField: 'configDigest',
    disposition: 'diagnosticCache',
    targetField: 'cache.artifacts[].configDigest',
  },
  {
    legacyField: 'contentDigest',
    disposition: 'diagnosticCache',
    targetField: 'cache.artifacts[].contentDigest',
  },
  {
    legacyField: 'dependents',
    disposition: 'derived',
    notes: 'recomputed from verified outgoing edges and trusted dependency index',
  },
  {
    legacyField: 'refCount',
    disposition: 'derived',
    notes: 'recomputed from verified incoming edges',
  },
  {
    legacyField: 'autoRemovable',
    disposition: 'derived',
    notes: 'derived from installSource plus trusted incoming coverage',
  },
  {
    legacyField: 'unusedDependencyHint',
    disposition: 'derived',
    notes: 'derived from installSource plus trusted incoming coverage',
  },
  {
    legacyField: 'dependencies.satisfied',
    disposition: 'derived',
    notes: 'runtime status projection only',
  },
  {
    legacyField: 'dependencies.missing',
    disposition: 'derived',
    notes: 'runtime status projection only',
  },
  {
    legacyField: 'dependencies.catalogDrift',
    disposition: 'derived',
    notes: 'runtime status projection only',
  },
];

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'plugin';
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function fixtureTimestamp(seed: string): string {
  const day = Number.parseInt(sha256(seed).slice(0, 2), 16) % 20 + 1;
  return `2026-05-${String(day).padStart(2, '0')}T08:00:00.000Z`;
}

function serializePluginLocation(location: PluginLocation): string {
  return stableJson({
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    projectKey: location.projectKey ?? null,
  });
}

function createProjectArtifactLocator(pluginName: string, platform: PlatformName): ProjectArtifactSharedLocator {
  return {
    plugin: pluginName,
    platform,
    scope: 'project',
    repoRelativeProjectRoot: '.',
  };
}

function defaultPaths(rootDir: string): MinimalPluginInstallStatePaths {
  const absoluteRoot = path.resolve(rootDir);
  return {
    rootDir: absoluteRoot,
    repoRoot: path.join(absoluteRoot, 'repo'),
    awHome: path.join(absoluteRoot, 'aw-home'),
    codexHome: path.join(absoluteRoot, 'codex-home'),
    claudeHome: path.join(absoluteRoot, 'claude-home'),
  };
}

function getPrivateStateRoot(paths: MinimalPluginInstallStatePaths, location: PluginLocation): string {
  if (location.scope === 'project') {
    return path.join(
      paths.repoRoot,
      location.platform === 'codex' ? '.codex' : '.claude',
      '.agent-workflows',
    );
  }
  return path.join(
    location.platform === 'codex' ? paths.codexHome : paths.claudeHome,
    '.agent-workflows',
  );
}

function getRecordPath(paths: MinimalPluginInstallStatePaths, target: MinimalFixtureTarget): string {
  return path.join(getPrivateStateRoot(paths, target.location), 'records', `${target.recordId}.json`);
}

function getDiagnosticCachePath(paths: MinimalPluginInstallStatePaths, target: MinimalFixtureTarget): string {
  return path.join(getPrivateStateRoot(paths, target.location), 'diagnostics', `${target.recordId}.json`);
}

function getProjectIdentityPath(paths: MinimalPluginInstallStatePaths, target: MinimalFixtureTarget): string {
  return path.join(
    paths.repoRoot,
    '.agent-workflows',
    'project-artifacts',
    target.location.platform,
    `${target.sharedIdentityId}.json`,
  );
}

function getDependencyIndexPath(paths: MinimalPluginInstallStatePaths): string {
  return path.join(paths.awHome, 'dependency-index', 'index.json');
}

function getLifecycleRuntimeRoot(paths: MinimalPluginInstallStatePaths, target: MinimalFixtureTarget): string {
  const scopeKey = target.location.scope === 'project'
    ? `project.${sha256(target.location.projectKey ?? '').slice(0, 16)}`
    : 'user';
  return path.join(
    paths.awHome,
    'lifecycle-runtimes',
    target.location.platform,
    target.location.scope,
    scopeKey,
    target.recordId,
    target.runtimeId,
  );
}

function getNativeMarkerPath(paths: MinimalPluginInstallStatePaths, target: MinimalFixtureTarget): string {
  return path.join(
    paths.awHome,
    'native-recovery',
    'codex',
    'user',
    `${target.pluginId}.json`,
  );
}

function getSharedOwnerPath(paths: MinimalPluginInstallStatePaths, target: MinimalFixtureTarget): string {
  return path.join(
    paths.awHome,
    'shared-runtime-owners',
    target.location.platform,
    `${target.pluginSlug}.${target.pluginHash}.json`,
  );
}

function getExternalNativeConfigPath(paths: MinimalPluginInstallStatePaths): string {
  return path.join(paths.codexHome, 'config.toml');
}

function getExternalNativeCachePath(paths: MinimalPluginInstallStatePaths, pluginId: string): string {
  return path.join(paths.codexHome, 'plugins', pluginId, 'manifest.json');
}

async function ensureFixtureRoots(paths: MinimalPluginInstallStatePaths): Promise<void> {
  await Promise.all([
    fs.ensureDir(paths.rootDir),
    fs.ensureDir(paths.repoRoot),
    fs.ensureDir(paths.awHome),
    fs.ensureDir(paths.codexHome),
    fs.ensureDir(paths.claudeHome),
  ]);
}

function createTarget(
  paths: MinimalPluginInstallStatePaths,
  options?: Partial<PluginLocation> & { pluginName?: string },
): MinimalFixtureTarget {
  const pluginName = options?.pluginName ?? options?.plugin ?? 'git-commit';
  const platform = options?.platform ?? 'codex';
  const scope = options?.scope ?? 'project';
  const pluginSlug = slugify(pluginName);
  const location: PluginLocation = {
    plugin: pluginName,
    platform,
    scope,
    ...(scope === 'project'
      ? { projectKey: options?.projectKey ?? 'repo:fixture-project' }
      : {}),
  };
  const locator = createProjectArtifactLocator(pluginName, platform);
  const recordId = `${pluginSlug}.${sha256(serializePluginLocation(location)).slice(0, 12)}`;
  const sharedIdentityId = `${pluginSlug}.${sha256(stableJson(locator)).slice(0, 12)}`;
  const runtimeId = sha256(`${recordId}:runtime`).slice(0, 12);
  const repoArtifactRelativePath = toPosixPath(path.join('.agents', 'skills', pluginSlug, 'SKILL.md'));
  const repoArtifactContent = `# ${pluginName}\nThis fixture is owned by AW.\n`;
  return {
    location,
    recordId,
    pluginSlug,
    pluginHash: sha256(pluginName).slice(0, 12),
    pluginId: `${pluginName}@aw`,
    sharedIdentityId,
    locator,
    repoArtifactRelativePath,
    repoArtifactPath: path.join(paths.repoRoot, repoArtifactRelativePath),
    repoArtifactContent,
    repoArtifactDigest: sha256(repoArtifactContent),
    runtimeId,
    timestamps: {
      installedAt: fixtureTimestamp(`${recordId}:installedAt`),
      updatedAt: fixtureTimestamp(`${recordId}:updatedAt`),
      createdAt: fixtureTimestamp(`${recordId}:createdAt`),
    },
    source: {
      pluginVersion: '0.1.0',
      manifestDigest: sha256(`${pluginName}:manifest`),
      bundleFingerprint: sha256(`${pluginName}:bundle`),
    },
  };
}

async function writeRepoArtifact(target: MinimalFixtureTarget): Promise<void> {
  await fs.outputFile(target.repoArtifactPath, target.repoArtifactContent, 'utf8');
}

function createArtifactRecord(target: MinimalFixtureTarget): InstallRecordArtifact {
  return {
    kind: 'instruction',
    platform: target.location.platform,
    path: target.repoArtifactPath,
    artifactKey: `${target.pluginSlug}.skill`,
    id: `${target.pluginSlug}-instruction`,
    target: 'codex.developerInstructionsBlock',
    ownershipMarker: `aw:${target.location.plugin}`,
    state: 'present',
  };
}

function createProjectIdentityArtifact(target: MinimalFixtureTarget): ProjectArtifactIdentityArtifact {
  return {
    kind: 'instruction',
    platform: target.location.platform,
    path: target.repoArtifactRelativePath,
    artifactKey: `${target.pluginSlug}.skill`,
    id: `${target.pluginSlug}-instruction`,
    target: 'codex.developerInstructionsBlock',
    ownershipMarker: `aw:${target.location.plugin}`,
    state: 'present',
    contentDigest: target.repoArtifactDigest,
  };
}

async function writeHistoricalLifecycleRuntime(
  paths: MinimalPluginInstallStatePaths,
  target: MinimalFixtureTarget,
): Promise<HistoricalLifecycleRuntimeRef> {
  const runtimeRoot = getLifecycleRuntimeRoot(paths, target);
  const bundleRoot = path.join(runtimeRoot, 'bundle');
  const manifestPath = path.join(bundleRoot, 'plugin.json');
  await fs.ensureDir(bundleRoot);
  await fs.writeJson(
    manifestPath,
    {
      name: target.location.plugin,
      version: target.source.pluginVersion,
      compatibility: {
        aw: {
          minVersion: '0.0.0',
        },
      },
      artifacts: [createProjectIdentityArtifact(target)],
    },
    { spaces: 2 },
  );
  return {
    runtimeRoot,
    bundleRoot,
    manifestPath,
    pluginVersion: target.source.pluginVersion,
    sourceManifestDigest: target.source.manifestDigest,
    bundleFingerprint: target.source.bundleFingerprint,
    events: ['install', 'upgrade', 'uninstall'],
    createdAt: target.timestamps.createdAt,
  };
}

function createInstallRecord(
  target: MinimalFixtureTarget,
  lifecycle?: HistoricalLifecycleRuntimeRef,
): InstallRecordFile {
  return {
    version: 2,
    recordId: target.recordId,
    record: {
      pluginName: target.location.plugin,
      platform: target.location.platform,
      scope: target.location.scope,
      ...(target.location.scope === 'project'
        ? { projectKey: target.location.projectKey ?? undefined }
        : {}),
      installedAt: target.timestamps.installedAt,
      updatedAt: target.timestamps.updatedAt,
      source: { ...target.source },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      options: {
        skillTriggerPreference: 'manual',
      },
      ...(target.location.scope === 'user' && target.location.platform === 'codex'
        ? {
          native: {
            pluginId: target.pluginId,
            installedByAw: true,
          },
        }
        : {}),
      ...(lifecycle ? { lifecycle } : {}),
      artifacts: [createArtifactRecord(target)],
      dependencyEdges: [],
    },
  };
}

async function writeInstallRecord(
  paths: MinimalPluginInstallStatePaths,
  target: MinimalFixtureTarget,
  lifecycle?: HistoricalLifecycleRuntimeRef,
): Promise<InstallRecordFile> {
  const recordFile = createInstallRecord(target, lifecycle);
  await fs.outputJson(getRecordPath(paths, target), recordFile, { spaces: 2 });
  return recordFile;
}

function createDiagnosticCache(target: MinimalFixtureTarget): DynamicArtifactDiagnosticCache {
  return {
    version: 1,
    recordId: target.recordId,
    location: target.location,
    updatedAt: target.timestamps.updatedAt,
    artifacts: [{
      id: `${target.pluginSlug}-instruction`,
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      artifactKey: `${target.pluginSlug}.skill`,
      refreshKeys: ['token'],
      configDigest: sha256(`${target.location.plugin}:config`),
      contentDigest: target.repoArtifactDigest,
      lastRefresh: {
        status: 'success',
        at: target.timestamps.updatedAt,
        event: 'install',
      },
      refreshReach: {
        commandScope: target.location.scope === 'project' ? 'projectShared' : 'user',
        refreshedUserTarget: target.location.scope === 'user',
        refreshedCurrentProjectTarget: target.location.scope === 'project',
      },
    }],
  };
}

async function writeDiagnosticCache(
  paths: MinimalPluginInstallStatePaths,
  target: MinimalFixtureTarget,
  cache?: DynamicArtifactDiagnosticCache,
): Promise<DynamicArtifactDiagnosticCache> {
  const value = cache ?? createDiagnosticCache(target);
  await fs.outputJson(getDiagnosticCachePath(paths, target), value, { spaces: 2 });
  return value;
}

function createProjectIdentity(target: MinimalFixtureTarget): ProjectArtifactIdentityFile {
  return {
    version: 1,
    sharedIdentityId: target.sharedIdentityId,
    locator: target.locator,
    source: { ...target.source },
    generatedAt: target.timestamps.updatedAt,
    artifacts: [createProjectIdentityArtifact(target)],
  };
}

async function writeProjectIdentity(
  paths: MinimalPluginInstallStatePaths,
  target: MinimalFixtureTarget,
  identity?: ProjectArtifactIdentityFile,
): Promise<ProjectArtifactIdentityFile> {
  const value = identity ?? createProjectIdentity(target);
  await fs.outputJson(getProjectIdentityPath(paths, target), value, { spaces: 2 });
  return value;
}

async function writeDependencyIndex(
  paths: MinimalPluginInstallStatePaths,
  records: Array<{ target: MinimalFixtureTarget; record: InstallRecordFile }>,
): Promise<GlobalDependencyIndex> {
  const index: GlobalDependencyIndex = {
    version: 1,
    updatedAt: fixtureTimestamp('dependency-index'),
    records: [],
  };
  for (const entry of records) {
    const recordPath = getRecordPath(paths, entry.target);
    const recordDigest = sha256(await fs.readFile(recordPath));
    index.records.push({
      location: entry.target.location,
      recordPath,
      recordDigest,
      installSource: entry.record.record.installSource,
      dependencyEdges: entry.record.record.dependencyEdges,
      lastSeenAt: entry.target.timestamps.updatedAt,
    });
  }
  await fs.outputJson(getDependencyIndexPath(paths), index, { spaces: 2 });
  return index;
}

async function writeNativeMarker(
  paths: MinimalPluginInstallStatePaths,
  target: MinimalFixtureTarget,
  operation: 'install' | 'uninstall' = 'install',
): Promise<NativeTransactionMarker> {
  const marker: NativeTransactionMarker = {
    version: 1,
    pluginName: target.location.plugin,
    pluginId: target.pluginId,
    platform: 'codex',
    scope: 'user',
    operation,
    nativeWriteSucceeded: true,
    createdAt: target.timestamps.createdAt,
    updatedAt: target.timestamps.updatedAt,
    ...(operation === 'install' ? { lastError: 'record commit interrupted' } : {}),
  };
  await fs.outputJson(getNativeMarkerPath(paths, target), marker, { spaces: 2 });
  return marker;
}

async function writeSharedRuntimeOwner(
  paths: MinimalPluginInstallStatePaths,
  target: MinimalFixtureTarget,
  recordPath: string,
): Promise<SharedSkillTriggerRuntimeOwner> {
  const owner: SharedSkillTriggerRuntimeOwner = {
    version: 1,
    pluginName: target.location.plugin,
    platform: target.location.platform,
    owner: target.location,
    ownerRecordPath: recordPath,
    ownerRecordDigest: sha256(await fs.readFile(recordPath)),
    preference: 'manual',
    updatedAt: target.timestamps.updatedAt,
  };
  await fs.outputJson(getSharedOwnerPath(paths, target), owner, { spaces: 2 });
  return owner;
}

async function writeExternalNativeEvidence(
  paths: MinimalPluginInstallStatePaths,
  target: MinimalFixtureTarget,
): Promise<void> {
  await fs.outputFile(
    getExternalNativeConfigPath(paths),
    `[plugins."${target.pluginId}"]\nenabled = true\n`,
    'utf8',
  );
  await fs.outputJson(
    getExternalNativeCachePath(paths, target.pluginId),
    { pluginId: target.pluginId, source: 'external' },
    { spaces: 2 },
  );
}

function fixtureFiles(paths: MinimalPluginInstallStatePaths, target: MinimalFixtureTarget) {
  return {
    installRecordPath: getRecordPath(paths, target),
    diagnosticCachePath: getDiagnosticCachePath(paths, target),
    projectIdentityPath: getProjectIdentityPath(paths, target),
    dependencyIndexPath: getDependencyIndexPath(paths),
    lifecycleRuntimeRoot: getLifecycleRuntimeRoot(paths, target),
    nativeMarkerPath: getNativeMarkerPath(paths, target),
    sharedOwnerPath: getSharedOwnerPath(paths, target),
    externalNativeConfigPath: getExternalNativeConfigPath(paths),
    externalNativeCachePath: getExternalNativeCachePath(paths, target.pluginId),
  };
}

export function findForbiddenStdoutTerms(stdout: string): string[] {
  const lower = stdout.toLowerCase();
  return DEFAULT_FORBIDDEN_STDOUT_TERMS.filter((term) => lower.includes(term));
}

export async function readInstallRecordFileSafe(
  filePath: string,
): Promise<{ ok: true; value: InstallRecordFile } | { ok: false; error: string }> {
  try {
    const value = await fs.readJson(filePath) as InstallRecordFile;
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readScopedInstallRecordDirectory(
  paths: MinimalPluginInstallStatePaths,
  options: { platform: PlatformName; scope: Scope },
): Promise<ScopedRecordDirectoryRead> {
  const root = getPrivateStateRoot(paths, {
    plugin: 'unused',
    platform: options.platform,
    scope: options.scope,
    ...(options.scope === 'project' ? { projectKey: 'repo:fixture-project' } : {}),
  });
  const recordsDir = path.join(root, 'records');
  if (!(await fs.pathExists(recordsDir))) {
    return { successes: [], failures: [] };
  }
  const entries = (await fs.readdir(recordsDir))
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const output: ScopedRecordDirectoryRead = { successes: [], failures: [] };
  for (const entry of entries) {
    const filePath = path.join(recordsDir, entry);
    const result = await readInstallRecordFileSafe(filePath);
    if (result.ok) {
      output.successes.push({
        path: filePath,
        recordId: result.value.recordId,
        value: result.value,
      });
    } else {
      output.failures.push({
        path: filePath,
        error: result.error,
      });
    }
  }
  return output;
}

export async function createMinimalPluginInstallStateFixtureBuilder(
  rootDir: string,
): Promise<{
  paths: MinimalPluginInstallStatePaths;
  createTarget: (options?: Partial<PluginLocation> & { pluginName?: string }) => MinimalFixtureTarget;
  writeRepoArtifact: (target: MinimalFixtureTarget) => Promise<void>;
  writeInstallRecord: (
    target: MinimalFixtureTarget,
    lifecycle?: HistoricalLifecycleRuntimeRef,
  ) => Promise<InstallRecordFile>;
  writeDiagnosticCache: (
    target: MinimalFixtureTarget,
    cache?: DynamicArtifactDiagnosticCache,
  ) => Promise<DynamicArtifactDiagnosticCache>;
  writeProjectIdentity: (
    target: MinimalFixtureTarget,
    identity?: ProjectArtifactIdentityFile,
  ) => Promise<ProjectArtifactIdentityFile>;
  writeDependencyIndex: (
    records: Array<{ target: MinimalFixtureTarget; record: InstallRecordFile }>,
  ) => Promise<GlobalDependencyIndex>;
  writeHistoricalLifecycleRuntime: (target: MinimalFixtureTarget) => Promise<HistoricalLifecycleRuntimeRef>;
  writeNativeMarker: (
    target: MinimalFixtureTarget,
    operation?: 'install' | 'uninstall',
  ) => Promise<NativeTransactionMarker>;
  writeSharedRuntimeOwner: (
    target: MinimalFixtureTarget,
    recordPath: string,
  ) => Promise<SharedSkillTriggerRuntimeOwner>;
  writeExternalNativeEvidence: (target: MinimalFixtureTarget) => Promise<void>;
  readScopedInstallRecordDirectory: (options: {
    platform: PlatformName;
    scope: Scope;
  }) => Promise<ScopedRecordDirectoryRead>;
}> {
  const paths = defaultPaths(rootDir);
  await ensureFixtureRoots(paths);
  return {
    paths,
    createTarget: (options) => createTarget(paths, options),
    writeRepoArtifact: (target) => writeRepoArtifact(target),
    writeInstallRecord: (target, lifecycle) => writeInstallRecord(paths, target, lifecycle),
    writeDiagnosticCache: (target, cache) => writeDiagnosticCache(paths, target, cache),
    writeProjectIdentity: (target, identity) => writeProjectIdentity(paths, target, identity),
    writeDependencyIndex: (records) => writeDependencyIndex(paths, records),
    writeHistoricalLifecycleRuntime: (target) => writeHistoricalLifecycleRuntime(paths, target),
    writeNativeMarker: (target, operation) => writeNativeMarker(paths, target, operation),
    writeSharedRuntimeOwner: (target, recordPath) => writeSharedRuntimeOwner(paths, target, recordPath),
    writeExternalNativeEvidence: (target) => writeExternalNativeEvidence(paths, target),
    readScopedInstallRecordDirectory: (options) => readScopedInstallRecordDirectory(paths, options),
  };
}

async function writeInstalledScenario(
  builder: Awaited<ReturnType<typeof createMinimalPluginInstallStateFixtureBuilder>>,
  target: MinimalFixtureTarget,
): Promise<MinimalFixtureResult> {
  await builder.writeRepoArtifact(target);
  const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
  const record = await builder.writeInstallRecord(target, lifecycle);
  await builder.writeDiagnosticCache(target);
  await builder.writeProjectIdentity(target);
  await builder.writeDependencyIndex([{ target, record }]);
  return {
    scenario: 'installed',
    state: 'installed',
    paths: builder.paths,
    target,
    files: fixtureFiles(builder.paths, target),
  };
}

function projectFixtureState(scenario: MinimalInstallFixtureScenario): MinimalInstallStateKind {
  switch (scenario) {
    case 'installed':
    case 'needsRepair':
    case 'corruptedDiagnosticCache':
    case 'corruptedIdentityMetadata':
    case 'missingHistoricalLifecycle':
    case 'recordAndInstallMarkerResidual':
      return 'installed';
    case 'adoptable':
    case 'freshCloneProject':
    case 'externallyManaged':
      return 'external';
    case 'residual':
    case 'corruptedRecord':
    case 'staleDependencyIndex':
    case 'unreadableDependencyIndex':
    case 'nativeMarkerOnly':
      return 'cleanupRequired';
    case 'notInstalled':
      return 'notInstalled';
  }
}

export async function writeMinimalPluginInstallStateFixture(options: {
  rootDir: string;
  scenario: MinimalInstallFixtureScenario;
}): Promise<MinimalFixtureResult> {
  const builder = await createMinimalPluginInstallStateFixtureBuilder(options.rootDir);
  const projectTarget = builder.createTarget({ platform: 'codex', scope: 'project' });
  const userTarget = builder.createTarget({ platform: 'codex', scope: 'user' });

  switch (options.scenario) {
    case 'installed':
      return writeInstalledScenario(builder, projectTarget);
    case 'needsRepair': {
      const result = await writeInstalledScenario(builder, projectTarget);
      await fs.writeFile(projectTarget.repoArtifactPath, `${projectTarget.repoArtifactContent}mutated\n`, 'utf8');
      return {
        ...result,
        scenario: 'needsRepair',
        state: projectFixtureState('needsRepair'),
      };
    }
    case 'adoptable':
    case 'freshCloneProject': {
      await builder.writeRepoArtifact(projectTarget);
      await builder.writeProjectIdentity(projectTarget);
      return {
        scenario: options.scenario,
        state: projectFixtureState(options.scenario),
        paths: builder.paths,
        target: projectTarget,
        files: fixtureFiles(builder.paths, projectTarget),
      };
    }
    case 'residual': {
      await builder.writeRepoArtifact(projectTarget);
      await builder.writeDiagnosticCache(projectTarget);
      return {
        scenario: 'residual',
        state: projectFixtureState('residual'),
        paths: builder.paths,
        target: projectTarget,
        files: fixtureFiles(builder.paths, projectTarget),
      };
    }
    case 'externallyManaged': {
      await builder.writeExternalNativeEvidence(userTarget);
      return {
        scenario: 'externallyManaged',
        state: projectFixtureState('externallyManaged'),
        paths: builder.paths,
        target: userTarget,
        files: fixtureFiles(builder.paths, userTarget),
      };
    }
    case 'notInstalled':
      return {
        scenario: 'notInstalled',
        state: 'notInstalled',
        paths: builder.paths,
        target: projectTarget,
        files: fixtureFiles(builder.paths, projectTarget),
      };
    case 'corruptedRecord': {
      const result = await writeInstalledScenario(builder, projectTarget);
      await fs.writeFile(result.files.installRecordPath, '{"version": 2,', 'utf8');
      return {
        ...result,
        scenario: 'corruptedRecord',
        state: projectFixtureState('corruptedRecord'),
      };
    }
    case 'corruptedDiagnosticCache': {
      const result = await writeInstalledScenario(builder, projectTarget);
      await fs.writeFile(result.files.diagnosticCachePath, '{"version": 1,', 'utf8');
      return {
        ...result,
        scenario: 'corruptedDiagnosticCache',
        state: projectFixtureState('corruptedDiagnosticCache'),
      };
    }
    case 'corruptedIdentityMetadata': {
      const result = await writeInstalledScenario(builder, projectTarget);
      const corruptedIdentity: ProjectArtifactIdentityFile = {
        ...createProjectIdentity(projectTarget),
        artifacts: [{
          ...createProjectIdentityArtifact(projectTarget),
          path: '../outside-repo.txt',
        }],
      };
      await builder.writeProjectIdentity(projectTarget, corruptedIdentity);
      return {
        ...result,
        scenario: 'corruptedIdentityMetadata',
        state: projectFixtureState('corruptedIdentityMetadata'),
      };
    }
    case 'staleDependencyIndex': {
      const result = await writeInstalledScenario(builder, projectTarget);
      const staleIndex: GlobalDependencyIndex = {
        version: 1,
        updatedAt: fixtureTimestamp('stale-index'),
        records: [{
          location: projectTarget.location,
          recordPath: result.files.installRecordPath,
          recordDigest: sha256(await fs.readFile(result.files.installRecordPath)),
          installSource: { kind: 'explicit', explicitlyRequested: true },
          dependencyEdges: [],
          lastSeenAt: projectTarget.timestamps.updatedAt,
        }],
      };
      await fs.remove(result.files.installRecordPath);
      await fs.outputJson(result.files.dependencyIndexPath, staleIndex, { spaces: 2 });
      return {
        ...result,
        scenario: 'staleDependencyIndex',
        state: projectFixtureState('staleDependencyIndex'),
      };
    }
    case 'unreadableDependencyIndex': {
      const result = await writeInstalledScenario(builder, projectTarget);
      await fs.writeFile(result.files.installRecordPath, '{"version": 2,', 'utf8');
      const unreadableIndex: GlobalDependencyIndex = {
        version: 1,
        updatedAt: fixtureTimestamp('unreadable-index'),
        records: [{
          location: projectTarget.location,
          recordPath: result.files.installRecordPath,
          recordDigest: 'mismatch',
          installSource: { kind: 'explicit', explicitlyRequested: true },
          dependencyEdges: [],
          lastSeenAt: projectTarget.timestamps.updatedAt,
        }],
      };
      await fs.outputJson(result.files.dependencyIndexPath, unreadableIndex, { spaces: 2 });
      return {
        ...result,
        scenario: 'unreadableDependencyIndex',
        state: projectFixtureState('unreadableDependencyIndex'),
      };
    }
    case 'missingHistoricalLifecycle': {
      const result = await writeInstalledScenario(builder, projectTarget);
      await fs.remove(result.files.lifecycleRuntimeRoot);
      return {
        ...result,
        scenario: 'missingHistoricalLifecycle',
        state: projectFixtureState('missingHistoricalLifecycle'),
      };
    }
    case 'nativeMarkerOnly': {
      await builder.writeNativeMarker(userTarget, 'install');
      return {
        scenario: 'nativeMarkerOnly',
        state: projectFixtureState('nativeMarkerOnly'),
        paths: builder.paths,
        target: userTarget,
        files: fixtureFiles(builder.paths, userTarget),
      };
    }
    case 'recordAndInstallMarkerResidual': {
      await builder.writeRepoArtifact(userTarget);
      const lifecycle = await builder.writeHistoricalLifecycleRuntime(userTarget);
      const record = await builder.writeInstallRecord(userTarget, lifecycle);
      await builder.writeDiagnosticCache(userTarget);
      await builder.writeDependencyIndex([{ target: userTarget, record }]);
      await builder.writeNativeMarker(userTarget, 'install');
      await builder.writeSharedRuntimeOwner(userTarget, getRecordPath(builder.paths, userTarget));
      return {
        scenario: 'recordAndInstallMarkerResidual',
        state: projectFixtureState('recordAndInstallMarkerResidual'),
        paths: builder.paths,
        target: userTarget,
        files: fixtureFiles(builder.paths, userTarget),
      };
    }
  }
}
