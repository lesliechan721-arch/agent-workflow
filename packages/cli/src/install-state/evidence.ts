import path from 'node:path';

import fs from 'fs-extra';

import type {
  ArtifactState,
  ArtifactTarget,
  PlatformName,
  TrackedHookGroupIdentity,
} from '../types.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import { getCodexHome } from '../utils/paths.js';
import {
  inspectGlobalDependencyIndex,
  readDynamicArtifactDiagnosticCacheForLocation,
  readInstallRecordFileAt,
  readInstallRecordForLocation,
  readNativeTransactionMarker,
  readProjectArtifactIdentityForLocator,
  readSharedSkillTriggerRuntimeOwner,
} from './facade.js';
import { createRecordId } from './ids.js';
import { sha256Hex, stableStringify } from './internal.js';
import {
  createProjectArtifactSharedLocator,
  getInstallStatePrivateRoot,
  resolveProjectArtifactProjectRoot,
  resolveProjectScopeRepoRoot,
} from './paths.js';
import type {
  DynamicArtifactDiagnosticCache,
  DynamicArtifactDiagnosticEntry,
  GlobalDependencyIndexInspection,
  InstallRecordArtifact,
  InstallRecordFile,
  InstallStateReadResult,
  NativeTransactionMarker,
  PluginLocation,
  ProjectArtifactIdentityArtifact,
  ProjectArtifactIdentityFile,
  RepoManagedArtifactKind,
  SharedSkillTriggerRuntimeOwner,
} from './types.js';

export interface CurrentCatalogSource {
  pluginVersion: string;
  manifestDigest: string;
  bundleFingerprint: string;
}

export interface CurrentCatalogArtifact {
  kind: RepoManagedArtifactKind;
  platform: PlatformName;
  path: string;
  paths?: string[];
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
  id?: string;
  target?: ArtifactTarget;
  roleKey?: string;
  ownershipMarker?: string;
  state?: ArtifactState;
  contentDigest?: string;
}

export interface CurrentCatalogDynamicArtifact {
  id: string;
  target: ArtifactTarget;
  state: ArtifactState;
  disabledReason?: string;
  artifactKey?: string;
  roleKey?: string;
  configDigest?: string;
  contentDigest?: string;
}

export interface CurrentCatalogEvidenceInput {
  source: CurrentCatalogSource;
  artifacts?: CurrentCatalogArtifact[];
  dynamicArtifacts?: CurrentCatalogDynamicArtifact[];
}

export interface CollectInstallEvidenceOptions {
  cwd: string;
  location: PluginLocation;
  env?: NodeJS.ProcessEnv;
  currentCatalog?: CurrentCatalogEvidenceInput | null;
  projectSharedRenderConfigDigest?: string | null;
}

export interface ArtifactFileEvidence {
  path: string;
  exists: boolean;
  contentDigest: string | null;
  rawContent: string | null;
}

export interface CatalogArtifactEvidence extends CurrentCatalogArtifact {
  resolvedPath: string;
  file: ArtifactFileEvidence;
}

export interface IdentityArtifactEvidence {
  artifact: ProjectArtifactIdentityArtifact;
  resolvedPath: string;
  file: ArtifactFileEvidence;
}

export interface RecordArtifactEvidence {
  artifact: InstallRecordArtifact;
  files: ArtifactFileEvidence[];
  matchedCatalogArtifact: CatalogArtifactEvidence | null;
  matchedIdentityArtifact: IdentityArtifactEvidence | null;
  matchedDynamicEntry: DynamicArtifactDiagnosticEntry | null;
  matchedCurrentDynamicArtifact: CurrentCatalogDynamicArtifact | null;
}

export interface DynamicEntryEvidence {
  entry: DynamicArtifactDiagnosticEntry;
  matchedRecordArtifact: RecordArtifactEvidence | null;
  matchedCatalogArtifact: CurrentCatalogDynamicArtifact | null;
}

export interface DependencyHealthEvidence {
  dependency: PluginLocation;
  recordPath: string;
  status:
    | 'ok'
    | 'missingRecord'
    | 'invalidRecord'
    | 'missingArtifact'
    | 'nativeMarkerPresent'
    | 'nativeEvidenceMissing';
  reason: string;
}

export interface DependencyIndexCoverageEvidence {
  coverageTrusted: boolean;
  trusted: boolean;
  reasons: string[];
  verifiedLocations: PluginLocation[];
  revisitProjectLocations: PluginLocation[];
  recoverySuggestion: string | null;
}

export interface DependencyProjectionEvidence {
  autoInstalled: boolean;
  dependents: PluginLocation[];
  localScopedDependents: PluginLocation[];
  unusedDependencyHint: boolean;
  dependencyHealth: DependencyHealthEvidence[];
  coverage: DependencyIndexCoverageEvidence;
}

export interface HistoricalLifecycleEvidence {
  expected: boolean;
  path: string | null;
  runtimeRootExists: boolean;
  bundleRootExists: boolean;
  manifestExists: boolean;
  sourceMatchesRecord: boolean;
  healthy: boolean;
}

export interface SharedOwnerEvidence {
  read: InstallStateReadResult<SharedSkillTriggerRuntimeOwner>;
  ownerMatchesTarget: boolean;
  ownerRecordDigestVerified: boolean;
  needsTakeover: boolean;
}

export interface NativeTransactionEvidence {
  read: InstallStateReadResult<NativeTransactionMarker>;
  present: boolean;
  classification:
    | 'none'
    | 'markerOnlyInstall'
    | 'recordInstallResidual'
    | 'markerOnlyUninstall'
    | 'recordUninstallResidual'
    | 'invalid';
}

export interface CodexNativeEvidence {
  pluginId: string;
  configPath: string;
  configEntryPresent: boolean;
  pluginEnabled: boolean;
  installedManifestPath: string;
  installedManifestPresent: boolean;
  activeCacheRootPath: string;
  activeCachePresent: boolean;
  minimumSatisfied: boolean;
  anyNativeEvidence: boolean;
}

export interface InstallEvidence {
  location: PluginLocation;
  cwd: string;
  repoRoot: string | null;
  currentCatalog: {
    provided: boolean;
    source: CurrentCatalogSource | null;
    artifacts: CatalogArtifactEvidence[];
    dynamicArtifacts: CurrentCatalogDynamicArtifact[];
  };
  installRecord: {
    read: InstallStateReadResult<InstallRecordFile>;
    present: boolean;
    fileExists: boolean;
    sourceDrift: boolean;
    sameBundleAsCatalog: boolean | null;
    artifacts: RecordArtifactEvidence[];
  };
  projectSharedIdentity: {
    attempted: boolean;
    read: InstallStateReadResult<ProjectArtifactIdentityFile> | null;
    present: boolean;
    sourceDrift: boolean;
    sourceMatchesRecord: boolean | null;
    artifacts: IdentityArtifactEvidence[];
  };
  dynamicDiagnostic: {
    read: InstallStateReadResult<DynamicArtifactDiagnosticCache> | null;
    available: boolean;
    unavailableReason: string | null;
    dynamicDiagnosticUnavailable: boolean;
    entries: DynamicEntryEvidence[];
  };
  historicalLifecycle: HistoricalLifecycleEvidence;
  dependencyIndex: {
    inspection: GlobalDependencyIndexInspection;
    projection: DependencyProjectionEvidence;
  };
  sharedRuntimeOwner: SharedOwnerEvidence;
  nativeTransaction: NativeTransactionEvidence;
  platform: {
    codexNative: CodexNativeEvidence | null;
  };
  adoptable: {
    possible: boolean;
    source: 'identity' | 'catalog' | 'none';
    artifactEvidencePresent: boolean;
    blockers: string[];
  };
  residualEvidence: {
    privateStatePresent: boolean;
    repoVisibleArtifactPresent: boolean;
    sharedIdentityPresent: boolean;
    historicalLifecyclePresent: boolean;
    nativeMarkerPresent: boolean;
    sharedOwnerPresent: boolean;
  };
}

function sameSource(
  left: CurrentCatalogSource | null | undefined,
  right: CurrentCatalogSource | null | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.pluginVersion === right.pluginVersion
    && left.manifestDigest === right.manifestDigest
    && left.bundleFingerprint === right.bundleFingerprint,
  );
}

function normalizeHookGroups(value: TrackedHookGroupIdentity[] | undefined): Array<Record<string, string | null>> {
  return (value ?? []).map((group) => ({
    command: group.command,
    event: group.event,
    matcher: group.matcher ?? null,
  }));
}

function artifactMatchKey(
  artifact: Pick<
    InstallRecordArtifact | ProjectArtifactIdentityArtifact | CurrentCatalogArtifact | CurrentCatalogDynamicArtifact | DynamicArtifactDiagnosticEntry,
    'artifactKey' | 'id' | 'target' | 'roleKey'
  > & {
    kind?: RepoManagedArtifactKind;
    ownershipMarker?: string;
    hookGroups?: TrackedHookGroupIdentity[];
  },
): string {
  return stableStringify({
    artifactKey: artifact.artifactKey ?? null,
    hookGroups: normalizeHookGroups(artifact.hookGroups),
    id: artifact.id ?? null,
    kind: artifact.kind ?? null,
    ownershipMarker: 'ownershipMarker' in artifact ? artifact.ownershipMarker ?? null : null,
    roleKey: artifact.roleKey ?? null,
    target: artifact.target ?? null,
  });
}

function makeDynamicArtifactKey(
  artifact: {
    artifactKey?: string;
    id?: string;
    target?: ArtifactTarget;
    roleKey?: string;
  },
): string {
  return stableStringify({
    artifactKey: artifact.artifactKey ?? null,
    id: artifact.id ?? null,
    roleKey: artifact.roleKey ?? null,
    target: artifact.target ?? null,
  });
}

function matchesCurrentDynamicArtifact(
  artifact: InstallRecordArtifact,
  current: CurrentCatalogDynamicArtifact,
): boolean {
  if (artifact.id !== current.id || artifact.target !== current.target) {
    return false;
  }

  if (current.artifactKey !== undefined && artifact.artifactKey !== current.artifactKey) {
    return false;
  }
  if (current.roleKey !== undefined && artifact.roleKey !== current.roleKey) {
    return false;
  }

  return true;
}

function resolveLocationCwd(location: PluginLocation, fallbackCwd: string): string {
  if (location.scope === 'project') {
    return location.projectKey ?? fallbackCwd;
  }
  return fallbackCwd;
}

async function inspectFile(filePath: string): Promise<ArtifactFileEvidence> {
  const exists = await fs.pathExists(filePath);
  if (!exists) {
    return {
      path: filePath,
      exists: false,
      contentDigest: null,
      rawContent: null,
    };
  }

  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    return {
      path: filePath,
      exists: true,
      contentDigest: null,
      rawContent: null,
    };
  }

  const rawContent = await fs.readFile(filePath, 'utf8');
  return {
    path: filePath,
    exists: true,
    contentDigest: sha256Hex(Buffer.from(rawContent, 'utf8')),
    rawContent,
  };
}

function resolveCatalogArtifactPath(
  artifactPath: string,
  location: PluginLocation,
  repoRoot: string | null,
): string {
  if (path.isAbsolute(artifactPath)) {
    return artifactPath;
  }
  if (location.scope === 'project' && repoRoot) {
    return path.join(repoRoot, artifactPath);
  }
  return path.resolve(artifactPath);
}

function resolveIdentityArtifactPath(
  artifact: ProjectArtifactIdentityArtifact,
  repoRoot: string,
): string {
  return path.join(repoRoot, artifact.path.split('/').join(path.sep));
}

async function inspectCatalogArtifacts(
  location: PluginLocation,
  repoRoot: string | null,
  catalog: CurrentCatalogEvidenceInput | null | undefined,
): Promise<CatalogArtifactEvidence[]> {
  const artifacts = catalog?.artifacts ?? [];
  return Promise.all(artifacts.map(async (artifact) => {
    const resolvedPath = resolveCatalogArtifactPath(artifact.path, location, repoRoot);
    return {
      ...artifact,
      resolvedPath,
      file: await inspectFile(resolvedPath),
    };
  }));
}

async function inspectIdentityArtifacts(
  repoRoot: string | null,
  readResult: InstallStateReadResult<ProjectArtifactIdentityFile> | null,
): Promise<IdentityArtifactEvidence[]> {
  if (!repoRoot || !readResult || readResult.status !== 'ok') {
    return [];
  }
  return Promise.all(readResult.value.artifacts.map(async (artifact) => {
    const resolvedPath = resolveIdentityArtifactPath(artifact, repoRoot);
    return {
      artifact,
      resolvedPath,
      file: await inspectFile(resolvedPath),
    };
  }));
}

async function inspectRecordArtifacts(
  record: InstallRecordFile | null,
  catalogArtifacts: CatalogArtifactEvidence[],
  identityArtifacts: IdentityArtifactEvidence[],
  dynamicEntries: DynamicArtifactDiagnosticEntry[],
  currentDynamicArtifacts: CurrentCatalogDynamicArtifact[],
): Promise<RecordArtifactEvidence[]> {
  if (!record) {
    return [];
  }
  const catalogByKey = new Map(catalogArtifacts.map((artifact) => [artifactMatchKey(artifact), artifact]));
  const identityByKey = new Map(identityArtifacts.map((artifact) => [artifactMatchKey(artifact.artifact), artifact]));
  const dynamicByKey = new Map(dynamicEntries.map((artifact) => [makeDynamicArtifactKey(artifact), artifact]));

  return Promise.all(record.record.artifacts.map(async (artifact) => {
    const files = await Promise.all(
      [artifact.path, ...(artifact.paths ?? [])].map((entryPath) => inspectFile(entryPath)),
    );
    return {
      artifact,
      files,
      matchedCatalogArtifact: catalogByKey.get(artifactMatchKey(artifact)) ?? null,
      matchedIdentityArtifact: identityByKey.get(artifactMatchKey(artifact)) ?? null,
      matchedDynamicEntry: dynamicByKey.get(makeDynamicArtifactKey(artifact)) ?? null,
      matchedCurrentDynamicArtifact: currentDynamicArtifacts.find((current) =>
        matchesCurrentDynamicArtifact(artifact, current)) ?? null,
    };
  }));
}

function createProjectLocator(
  cwd: string,
  location: PluginLocation,
): { repoRoot: string; locator: ReturnType<typeof createProjectArtifactSharedLocator> } | null {
  if (location.scope !== 'project') {
    return null;
  }
  const repoRoot = resolveProjectScopeRepoRoot(cwd);
  const projectRoot = resolveProjectArtifactProjectRoot(cwd, location);
  return {
    repoRoot,
    locator: createProjectArtifactSharedLocator({
      plugin: location.plugin,
      platform: location.platform,
      repoRoot,
      projectRoot,
    }),
  };
}

async function inspectHistoricalLifecycle(record: InstallRecordFile | null): Promise<HistoricalLifecycleEvidence> {
  if (!record?.record.lifecycle) {
    return {
      expected: false,
      path: null,
      runtimeRootExists: false,
      bundleRootExists: false,
      manifestExists: false,
      sourceMatchesRecord: false,
      healthy: true,
    };
  }

  const runtime = record.record.lifecycle;
  const [runtimeRootExists, bundleRootExists, manifestExists] = await Promise.all([
    fs.pathExists(runtime.runtimeRoot),
    fs.pathExists(runtime.bundleRoot),
    fs.pathExists(runtime.manifestPath),
  ]);
  const sourceMatchesRecord =
    runtime.pluginVersion === record.record.source.pluginVersion
    && runtime.sourceManifestDigest === record.record.source.manifestDigest
    && runtime.bundleFingerprint === record.record.source.bundleFingerprint;

  return {
    expected: true,
    path: runtime.runtimeRoot,
    runtimeRootExists,
    bundleRootExists,
    manifestExists,
    sourceMatchesRecord,
    healthy: runtimeRootExists && bundleRootExists && manifestExists && sourceMatchesRecord,
  };
}

async function inspectScopedRecords(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<Array<{
  location: PluginLocation;
  path: string;
  dependencyEdges: InstallRecordFile['record']['dependencyEdges'];
}>> {
  const recordsDir = path.join(
    getInstallStatePrivateRoot(options.cwd, options.location, options.env),
    'records',
  );
  if (!(await fs.pathExists(recordsDir))) {
    return [];
  }

  const entries = (await fs.readdir(recordsDir))
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const output: Array<{
    location: PluginLocation;
    path: string;
    dependencyEdges: InstallRecordFile['record']['dependencyEdges'];
  }> = [];
  for (const entry of entries) {
    const recordPath = path.join(recordsDir, entry);
    const result = await readInstallRecordFileAt(recordPath, { env: options.env });
    if (result.status === 'ok') {
      output.push({
        location: {
          plugin: result.value.record.pluginName,
          platform: result.value.record.platform,
          scope: result.value.record.scope,
          ...(result.value.record.scope === 'project'
            ? { projectKey: result.value.record.projectKey ?? null }
            : {}),
        },
        path: recordPath,
        dependencyEdges: result.value.record.dependencyEdges,
      });
    }
  }
  return output;
}

async function inspectDependencyLocation(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<DependencyHealthEvidence> {
  const recordPath = path.join(
    getInstallStatePrivateRoot(resolveLocationCwd(options.location, options.cwd), options.location, options.env),
    'records',
    `${createRecordId(options.location)}.json`,
  );
  const readResult = await readInstallRecordForLocation({
    cwd: resolveLocationCwd(options.location, options.cwd),
    location: options.location,
    env: options.env,
  });
  if (readResult.status === 'missing') {
    return {
      dependency: options.location,
      recordPath,
      status: 'missingRecord',
      reason: 'dependency record missing',
    };
  }
  if (readResult.status !== 'ok') {
    return {
      dependency: options.location,
      recordPath,
      status: 'invalidRecord',
      reason: readResult.code,
    };
  }
  const files = await Promise.all(
    readResult.value.record.artifacts.flatMap((artifact) =>
      [artifact.path, ...(artifact.paths ?? [])].map((entryPath) => inspectFile(entryPath)),
    ),
  );
  if (files.some((artifact) => !artifact.exists)) {
    return {
      dependency: options.location,
      recordPath: readResult.path,
      status: 'missingArtifact',
      reason: 'dependency artifact missing',
    };
  }
  const nativeMarker = await readNativeTransactionMarker(options.location.plugin, options.env);
  if (nativeMarker.status === 'ok') {
    return {
      dependency: options.location,
      recordPath: readResult.path,
      status: 'nativeMarkerPresent',
      reason: nativeMarker.value.operation,
    };
  }
  if (
    readResult.value.record.scope === 'user'
    && readResult.value.record.platform === 'codex'
    && readResult.value.record.native?.installedByAw
  ) {
    const native = await inspectCodexNativeEvidence(options.location.plugin, readResult.value.record.native.pluginId, options.env);
    if (!native.minimumSatisfied) {
      return {
        dependency: options.location,
        recordPath: readResult.path,
        status: 'nativeEvidenceMissing',
        reason: 'dependency native evidence missing',
      };
    }
  }
  return {
    dependency: options.location,
    recordPath: readResult.path,
    status: 'ok',
    reason: 'verified',
  };
}

async function buildDependencyProjection(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
  record: InstallRecordFile | null;
  inspection: GlobalDependencyIndexInspection;
}): Promise<DependencyProjectionEvidence> {
  const dependencyHealth = options.record
    ? await Promise.all(options.record.record.dependencyEdges.map((edge) => inspectDependencyLocation({
      cwd: options.cwd,
      location: edge.dependency,
      env: options.env,
    })))
    : [];

  const coverageReasons: string[] = [];
  const verifiedLocations: PluginLocation[] = [];
  const revisitProjectLocations: PluginLocation[] = [];

  const scopedRecords = await inspectScopedRecords({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  for (const scopedRecord of scopedRecords) {
    verifiedLocations.push(scopedRecord.location);
  }
  const localScopedDependents = dedupeLocations(scopedRecords
    .filter((entry) => !sameLocation(entry.location, options.location))
    .filter((entry) => entry.dependencyEdges.some((edge) => sameLocation(edge.dependency, options.location)))
    .map((entry) => entry.location));

  let trusted = false;
  if (options.inspection.status === 'missing') {
    coverageReasons.push('indexMissing');
  } else if (options.inspection.status === 'corrupted') {
    coverageReasons.push('indexCorrupted');
  } else {
    trusted = options.inspection.references.every((reference) => reference.status === 'verified');
    for (const reference of options.inspection.references) {
      if (reference.status === 'verified') {
        verifiedLocations.push(reference.location);
        continue;
      }
      if (reference.status === 'staleCandidate') {
        coverageReasons.push('staleReference');
      } else {
        coverageReasons.push('unreadableReference');
      }
      if (reference.location.scope === 'project') {
        revisitProjectLocations.push(reference.location);
      }
    }
  }

  const dedupedVerifiedLocations = dedupeLocations(verifiedLocations);
  const dedupedRevisitLocations = dedupeLocations(revisitProjectLocations);
  const coverageTrusted = trusted && coverageReasons.length === 0;
  const recoverySuggestion = !coverageTrusted && dedupedRevisitLocations.length === 0
    ? 'revisitRelatedProjects'
    : null;

  let indexedDependents: PluginLocation[] = [];
  const inspection = options.inspection;
  if (inspection.status === 'ok' && trusted) {
    indexedDependents = inspection.value.records
      .filter((entry, index) => inspection.references[index]?.status === 'verified')
      .filter((entry) => entry.dependencyEdges.some((edge) => sameLocation(edge.dependency, options.location)))
      .map((entry) => entry.location);
  }
  const dependents = dedupeLocations([...indexedDependents, ...localScopedDependents]);

  const autoInstalled = options.record?.record.installSource.kind === 'dependency';
  const unusedDependencyHint = Boolean(
    autoInstalled
    && options.record
    && options.record.record.installSource.explicitlyRequested === false
    && dependents.length === 0
    && trusted,
  );

  return {
    autoInstalled: Boolean(autoInstalled),
    dependents,
    localScopedDependents,
    unusedDependencyHint,
    dependencyHealth,
    coverage: {
      coverageTrusted,
      trusted,
      reasons: [...new Set(coverageReasons)],
      verifiedLocations: dedupedVerifiedLocations,
      revisitProjectLocations: dedupedRevisitLocations,
      recoverySuggestion,
    },
  };
}

function dedupeLocations(locations: PluginLocation[]): PluginLocation[] {
  const seen = new Set<string>();
  const output: PluginLocation[] = [];
  for (const location of locations) {
    const key = stableStringify({
      plugin: location.plugin,
      platform: location.platform,
      projectKey: location.projectKey ?? null,
      scope: location.scope,
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(location);
  }
  return output;
}

function sameLocation(left: PluginLocation, right: PluginLocation): boolean {
  return stableStringify({
    plugin: left.plugin,
    platform: left.platform,
    projectKey: left.projectKey ?? null,
    scope: left.scope,
  }) === stableStringify({
    plugin: right.plugin,
    platform: right.platform,
    projectKey: right.projectKey ?? null,
    scope: right.scope,
  });
}

async function verifyOwnerDigest(
  readResult: InstallStateReadResult<SharedSkillTriggerRuntimeOwner>,
): Promise<boolean> {
  if (readResult.status !== 'ok') {
    return false;
  }
  if (!(await fs.pathExists(readResult.value.ownerRecordPath))) {
    return false;
  }
  return sha256Hex(await fs.readFile(readResult.value.ownerRecordPath)) === readResult.value.ownerRecordDigest;
}

async function inspectNativeTransaction(options: {
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
  hasRecord: boolean;
}): Promise<NativeTransactionEvidence> {
  const read = await readNativeTransactionMarker(options.location.plugin, options.env);
  if (read.status !== 'ok') {
    return {
      read,
      present: false,
      classification: read.status === 'missing' ? 'none' : 'invalid',
    };
  }

  if (read.value.operation === 'install') {
    return {
      read,
      present: true,
      classification: options.hasRecord ? 'recordInstallResidual' : 'markerOnlyInstall',
    };
  }
  return {
    read,
    present: true,
    classification: options.hasRecord ? 'recordUninstallResidual' : 'markerOnlyUninstall',
  };
}

async function inspectCodexNativeEvidence(
  pluginName: string,
  pluginIdHint: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<CodexNativeEvidence> {
  const pluginId = pluginIdHint ?? `${pluginName}@aw`;
  const codexHome = getCodexHome(env);
  const configPath = path.join(codexHome, 'config.toml');
  const config = await readCodexConfigFile(configPath);
  const pluginSnapshot = config.snapshot.plugins[pluginId];
  const installedManifestPath = path.join(codexHome, 'plugins', pluginId, 'manifest.json');
  const activeCacheRootPath = path.join(codexHome, 'plugins', 'cache', 'aw', pluginName);
  const [installedManifestPresent, activeCachePresent] = await Promise.all([
    fs.pathExists(installedManifestPath),
    fs.pathExists(activeCacheRootPath),
  ]);
  const configEntryPresent = pluginSnapshot !== undefined;
  const pluginEnabled = pluginSnapshot?.enabled === true;
  const anyNativeEvidence = configEntryPresent || installedManifestPresent || activeCachePresent;
  const minimumSatisfied = pluginEnabled && (installedManifestPresent || activeCachePresent);

  return {
    pluginId,
    configPath,
    configEntryPresent,
    pluginEnabled,
    installedManifestPath,
    installedManifestPresent,
    activeCacheRootPath,
    activeCachePresent,
    minimumSatisfied,
    anyNativeEvidence,
  };
}

function hasAlignedIdentityArtifacts(
  artifacts: IdentityArtifactEvidence[],
): boolean {
  return artifacts.length > 0 && artifacts.every((artifact) =>
    artifact.file.exists
    && (!artifact.artifact.contentDigest || artifact.artifact.contentDigest === artifact.file.contentDigest)
  );
}

function hasAlignedCatalogArtifacts(
  artifacts: CatalogArtifactEvidence[],
): boolean {
  return artifacts.length > 0 && artifacts.every((artifact) =>
    artifact.file.exists
    && (!artifact.contentDigest || artifact.contentDigest === artifact.file.contentDigest)
  );
}

export async function collectInstallEvidence(
  options: CollectInstallEvidenceOptions,
): Promise<InstallEvidence> {
  const env = options.env ?? process.env;
  const projectLocator = createProjectLocator(options.cwd, options.location);
  const repoRoot = projectLocator?.repoRoot ?? null;
  const installRecordRead = await readInstallRecordForLocation({
    cwd: options.cwd,
    location: options.location,
    env,
  });
  const installRecord = installRecordRead.status === 'ok' ? installRecordRead.value : null;
  const currentCatalog = options.currentCatalog ?? null;
  const catalogArtifacts = await inspectCatalogArtifacts(options.location, repoRoot, currentCatalog);
  const projectSharedIdentityRead = projectLocator
    ? await readProjectArtifactIdentityForLocator({
      repoRoot: projectLocator.repoRoot,
      locator: projectLocator.locator,
      projectKey: options.location.projectKey,
      cwd: options.cwd,
      homeDir: env.HOME,
    })
    : null;
  const identityArtifacts = await inspectIdentityArtifacts(repoRoot, projectSharedIdentityRead);
  const dynamicDiagnosticRead = await readDynamicArtifactDiagnosticCacheForLocation({
    cwd: options.cwd,
    location: options.location,
    currentRecord: installRecord ?? undefined,
    env,
  });
  const dynamicEntries = dynamicDiagnosticRead.status === 'ok'
    ? dynamicDiagnosticRead.value.artifacts
    : [];
  const recordArtifacts = await inspectRecordArtifacts(
    installRecord,
    catalogArtifacts,
    identityArtifacts,
    dynamicEntries,
    currentCatalog?.dynamicArtifacts ?? [],
  );
  const dynamicEntriesByKey = new Map(recordArtifacts
    .filter((artifact) => artifact.matchedDynamicEntry)
    .map((artifact) => [makeDynamicArtifactKey(artifact.artifact), artifact]));
  const dynamicEntryEvidence: DynamicEntryEvidence[] = dynamicEntries.map((entry) => ({
    entry,
    matchedRecordArtifact: dynamicEntriesByKey.get(makeDynamicArtifactKey(entry)) ?? null,
    matchedCatalogArtifact: (currentCatalog?.dynamicArtifacts ?? []).find((artifact) =>
      makeDynamicArtifactKey(artifact) === makeDynamicArtifactKey(entry),
    ) ?? null,
  }));
  const historicalLifecycle = await inspectHistoricalLifecycle(installRecord);
  const dependencyInspection = await inspectGlobalDependencyIndex(env);
  const dependencyProjection = await buildDependencyProjection({
    cwd: options.cwd,
    location: options.location,
    env,
    record: installRecord,
    inspection: dependencyInspection,
  });
  const sharedRuntimeOwnerRead = await readSharedSkillTriggerRuntimeOwner({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env,
  });
  const ownerRecordDigestVerified = await verifyOwnerDigest(sharedRuntimeOwnerRead);
  const ownerMatchesTarget = sharedRuntimeOwnerRead.status === 'ok'
    ? sameLocation(sharedRuntimeOwnerRead.value.owner, options.location)
    : false;
  const nativeTransaction = await inspectNativeTransaction({
    location: options.location,
    env,
    hasRecord: installRecord !== null,
  });
  const codexNative = options.location.platform === 'codex' && options.location.scope === 'user'
    ? await inspectCodexNativeEvidence(
      options.location.plugin,
      installRecord?.record.native?.pluginId,
      env,
    )
    : null;

  const installRecordPresent = installRecord !== null;
  const currentCatalogSource = currentCatalog?.source ?? null;
  const projectIdentityPresent = projectSharedIdentityRead?.status === 'ok';
  const sourceDrift = Boolean(
    installRecord
    && currentCatalogSource
    && !sameSource(currentCatalogSource, installRecord.record.source),
  );
  const identitySourceDrift = Boolean(
    projectSharedIdentityRead?.status === 'ok'
    && currentCatalogSource
    && !sameSource(currentCatalogSource, projectSharedIdentityRead.value.source),
  );
  const sharedIdentitySourceMatchesRecord = projectSharedIdentityRead?.status === 'ok' && installRecord
    ? sameSource(projectSharedIdentityRead.value.source, installRecord.record.source)
    : null;

  const dynamicDiagnosticUnavailable = dynamicDiagnosticRead.status !== 'ok';
  const dynamicUnavailableReason = dynamicDiagnosticUnavailable ? dynamicDiagnosticRead.code : null;

  const privateStatePresent = Boolean(
    installRecordRead.status !== 'missing'
    || dynamicDiagnosticRead.status !== 'unavailable'
    || nativeTransaction.present
    || sharedRuntimeOwnerRead.status === 'ok',
  );
  const repoVisibleArtifactPresent = identityArtifacts.some((artifact) => artifact.file.exists)
    || catalogArtifacts.some((artifact) => artifact.file.exists);

  let adoptableSource: 'identity' | 'catalog' | 'none' = 'none';
  const adoptableBlockers: string[] = [];
  if (options.location.scope === 'project') {
    if (installRecordPresent) {
      adoptableBlockers.push('installRecordPresent');
    }
    if (installRecordRead.status !== 'ok' && installRecordRead.status !== 'missing') {
      adoptableBlockers.push('invalidInstallRecord');
    }
    if (nativeTransaction.present) {
      adoptableBlockers.push('nativeTransactionPresent');
    }
    if (dynamicDiagnosticRead.status !== 'unavailable') {
      adoptableBlockers.push('privateStateResidual');
    }
    if (sharedRuntimeOwnerRead.status === 'ok') {
      adoptableBlockers.push('sharedOwnerResidual');
    }
    if (projectSharedIdentityRead && projectSharedIdentityRead.status !== 'missing' && projectSharedIdentityRead.status !== 'ok') {
      adoptableBlockers.push('invalidSharedIdentity');
    }
    if (projectSharedIdentityRead?.status === 'ok' && hasAlignedIdentityArtifacts(identityArtifacts)) {
      adoptableSource = 'identity';
    } else if (catalogArtifacts.some((artifact) => artifact.file.exists) || identityArtifacts.some((artifact) => artifact.file.exists)) {
      adoptableBlockers.push('artifactIdentityUnverifiable');
    }
  }
  const adoptablePossible = adoptableSource !== 'none' && adoptableBlockers.length === 0;

  return {
    location: options.location,
    cwd: options.cwd,
    repoRoot,
    currentCatalog: {
      provided: Boolean(currentCatalog),
      source: currentCatalogSource,
      artifacts: catalogArtifacts,
      dynamicArtifacts: currentCatalog?.dynamicArtifacts ?? [],
    },
    installRecord: {
      read: installRecordRead,
      present: installRecordPresent,
      fileExists: installRecordRead.status !== 'missing',
      sourceDrift,
      sameBundleAsCatalog: installRecord && currentCatalogSource
        ? sameSource(installRecord.record.source, currentCatalogSource)
        : null,
      artifacts: recordArtifacts,
    },
    projectSharedIdentity: {
      attempted: options.location.scope === 'project',
      read: projectSharedIdentityRead,
      present: Boolean(projectIdentityPresent),
      sourceDrift: identitySourceDrift,
      sourceMatchesRecord: sharedIdentitySourceMatchesRecord,
      artifacts: identityArtifacts,
    },
    dynamicDiagnostic: {
      read: dynamicDiagnosticRead,
      available: dynamicDiagnosticRead.status === 'ok',
      unavailableReason: dynamicUnavailableReason,
      dynamicDiagnosticUnavailable,
      entries: dynamicEntryEvidence,
    },
    historicalLifecycle,
    dependencyIndex: {
      inspection: dependencyInspection,
      projection: dependencyProjection,
    },
    sharedRuntimeOwner: {
      read: sharedRuntimeOwnerRead,
      ownerMatchesTarget,
      ownerRecordDigestVerified,
      needsTakeover: sharedRuntimeOwnerRead.status === 'ok' && !ownerMatchesTarget,
    },
    nativeTransaction,
    platform: {
      codexNative,
    },
    adoptable: {
      possible: adoptablePossible,
      source: adoptableSource,
      artifactEvidencePresent: repoVisibleArtifactPresent,
      blockers: adoptableBlockers,
    },
    residualEvidence: {
      privateStatePresent,
      repoVisibleArtifactPresent,
      sharedIdentityPresent: Boolean(projectIdentityPresent),
      historicalLifecyclePresent: historicalLifecycle.expected,
      nativeMarkerPresent: nativeTransaction.present,
      sharedOwnerPresent: sharedRuntimeOwnerRead.status === 'ok',
    },
  };
}
