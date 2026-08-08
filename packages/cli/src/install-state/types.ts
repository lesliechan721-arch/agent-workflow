import type {
  ArtifactState,
  ArtifactTarget,
  PlatformName,
  PluginVersion,
  Scope,
  SkillTriggerPreference,
  TrackedHookGroupIdentity,
} from '../types.js';

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

export type PluginConsoleStatus =
  | 'notInstalled'
  | 'installed'
  | 'upgradeAvailable'
  | 'abnormal';

export type PluginConsoleReasonCode =
  | 'duplicateInstall'
  | 'missingRequiredConfig'
  | 'artifactRefreshFailed'
  | 'recordCorrupted'
  | 'nativeIncomplete'
  | 'claimableProjectArtifacts'
  | 'foreignOwnershipConflict'
  | 'residueDetected'
  | 'dependencyBlocked';

export interface HistoricalLifecycleRuntimeRef {
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
  pluginVersion: PluginVersion;
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
    minVersion?: string;
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
  hookGroups?: TrackedHookGroupIdentity[];
  id?: string;
  target?: ArtifactTarget;
  state?: ArtifactState;
  refreshKeys?: string[];
  roleKey?: string;
  ownershipMarker?: string;
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
    pluginVersion: PluginVersion;
    manifestDigest: string;
    bundleFingerprint: string;
  };
  installSource: InstallRecordInstallSource;
  options?: {
    skillTriggerPreference?: SkillTriggerPreference;
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
  target: ArtifactTarget;
  state: ArtifactState;
  disabledReason?: string;
  artifactKey?: string;
  roleKey?: string;
  refreshKeys?: string[];
  configDigest?: string;
  contentDigest?: string;
  lastRefresh?: {
    status: 'success' | 'failed';
    at: string;
    event: 'install' | 'upgrade' | 'config';
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
  hookGroups?: TrackedHookGroupIdentity[];
  id?: string;
  target?: ArtifactTarget;
  roleKey?: string;
  ownershipMarker?: string;
  state?: ArtifactState;
  configDigest?: string;
  contentDigest?: string;
}

export interface ProjectArtifactIdentityFile {
  version: 1;
  sharedIdentityId: string;
  locator: ProjectArtifactSharedLocator;
  source: {
    pluginVersion: PluginVersion;
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
  preference?: SkillTriggerPreference;
  updatedAt: string;
}

export interface HistoricalLifecycleRuntimePathSet {
  scopeKey: string;
  runtimeId: string;
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
}

export interface LegacyInstallStateEvidence {
  kind: 'installedLedger' | 'trackingManifest' | 'codexNativeBreadcrumb';
  path: string;
  reason: string;
}

export interface InstallStateReadFailure {
  status: 'missing' | 'invalid' | 'unsupported' | 'unavailable';
  path: string;
  error: string;
  code: string;
  legacyEvidence?: LegacyInstallStateEvidence;
}

export type InstallStateReadResult<T> =
  | { status: 'ok'; path: string; value: T }
  | InstallStateReadFailure;

export type DependencyIndexReferenceStatus =
  | 'verified'
  | 'staleCandidate'
  | 'unreadableReference';

export interface DependencyIndexReferenceInspection {
  recordPath: string;
  location: PluginLocation;
  status: DependencyIndexReferenceStatus;
  error?: string;
}

export type GlobalDependencyIndexInspection =
  | { status: 'missing'; path: string }
  | { status: 'corrupted'; path: string; error: string }
  | {
    status: 'ok';
    path: string;
    value: GlobalDependencyIndex;
    references: DependencyIndexReferenceInspection[];
  };
