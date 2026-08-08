export type PlatformName = 'codex' | 'claude';
export type SupportedPlatformSet = ReadonlySet<PlatformName>;
export type PlatformSelection = PlatformName | 'both';
export type Scope = 'project' | 'user';
export type CommandAction =
  | 'install'
  | 'uninstall'
  | 'upgrade'
  | 'upgradeAll'
  | 'repair'
  | 'reinstall'
  | 'cleanup'
  | 'config'
  | 'status';
export type StrictSemVerString = string;
export type CliVersion = StrictSemVerString;
export type CatalogVersion = StrictSemVerString;
export type PluginVersion = StrictSemVerString;
export type DependencyVersion = StrictSemVerString;
export type AgentVersionStatus = 'supported' | 'missing' | 'probeFailed' | 'unparseable' | 'tooOld';
export type AgentVersionReasonCode =
  | 'agentVersionMissing'
  | 'agentVersionProbeFailed'
  | 'agentVersionUnparseable'
  | 'agentVersionTooLow';
export type InstalledVersion = string;
export type CatalogChannel = 'latest' | 'beta';
export type ConfigFieldKind = 'manifest';
export type ConfigValueState = 'default' | 'configured' | 'invalid';
export type NativePluginsByPlatform = Partial<Record<PlatformName, string[]>>;
export type NextStepKind = 'uiAction' | 'cliCommand' | 'manual';
export type ManualNextStepKind = 'guidance' | 'blocker' | 'documentation';
export type TargetWriteState = 'completed' | 'rolledBack' | 'notRun' | 'failed';
export type ReceiptOverallState = 'succeeded' | 'failed';
export type ConfigStoreRemovalState = 'removed' | 'notFound' | 'skipped' | 'failed';

export interface NextStepInstruction {
  kind: NextStepKind;
  label: string;
  description: string;
  manualKind?: ManualNextStepKind;
  uiAction?: string;
  command?: string;
}

export interface NextStepsPayloadBoundary {
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
}

export interface ReceiptTargetIdentity {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
}

export interface ReceiptTargetResult {
  target: ReceiptTargetIdentity;
  action: string;
  state: TargetWriteState;
  message?: string;
  errorCode?: string;
  rollbackState?: 'notNeeded' | 'completed' | 'failed';
}

export interface ConfigStoreIdentity {
  pluginName: string;
  storeKind: 'user' | 'projectShared' | 'projectLocal';
  projectRoot?: string;
}

export interface ConfigStoreRemovalResult {
  store: ConfigStoreIdentity;
  state: ConfigStoreRemovalState;
  subjectTargets: ReceiptTargetIdentity[];
  reasonCode?: 'subjectFailed' | 'removeFailed';
  message?: string;
  path?: string;
}

export interface LegacyConfigStoreEntryV2 {
  plugin: string;
  storeKind: 'user' | 'projectShared' | 'projectLocal';
  projectRoot?: string;
  reason: 'pluginRemoved' | 'schemaUnavailable';
  fieldVisibility: 'storeOnly';
  cleanupOnly: true;
}

export interface ConfigFieldEntryV2 {
  key: string;
  title: string;
  kind: ConfigFieldKind;
  reserved: boolean;
  writable: boolean;
  valueState: ConfigValueState;
  effectiveValue: unknown | null;
  sourceLayer: 'default' | 'user' | 'project' | 'local' | null;
  storedValue?: unknown;
  storedSourceLayer?: 'user' | 'project' | 'local';
}

export interface ConfigReceiptFieldEntryV2 {
  key: string;
  title: string;
  kind: ConfigFieldKind;
  reserved: boolean;
  action: 'set' | 'unset' | 'reset';
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  valueState?: ConfigValueState;
}

export interface ConfigSchemaEvidenceV2 {
  source: 'currentCatalog' | 'installedHistorical';
  identity: string;
  pluginVersion: PluginVersion;
  manifestDigest: string;
  location?: {
    platform: PlatformName;
    scope: Scope;
    projectKey?: string;
    recordPath: string;
  };
}

export interface PluginInterfaceMeta {
  displayName?: string;
  shortDescription?: string;
  capabilities?: string[];
}

export interface MarketplaceOwner {
  name: string;
  url: string;
}

export interface MarketplaceInterfaceMeta {
  displayName: string;
}

export interface MarketplaceSourceMeta {
  owner: MarketplaceOwner;
  interface: MarketplaceInterfaceMeta;
}

export interface MarketplacePolicy {
  installation: string;
  authentication: string;
  products?: string[];
}

export interface PluginMarketplaceMeta {
  category: string;
  tags?: string[];
  strict: boolean;
  policy: MarketplacePolicy;
}

export type TemplateValue = string | boolean;

export interface TemplateVarByPlatform {
  claude: TemplateValue;
  codex: TemplateValue;
}

export interface BuildConfigTemplates {
  vars: Record<string, TemplateVarByPlatform>;
  include: string[];
}

export interface BuildConfigFileRuleSet {
  include: string[];
  exclude: string[];
}

export interface ClaudeManifestOverrides {
  commands?: string;
  outputStyles?: string;
  lspServers?: string | Array<string | Record<string, unknown>> | Record<string, unknown>;
  userConfig?: Record<string, unknown>;
  channels?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface BuildConfigManifestOverrides {
  claude?: ClaudeManifestOverrides;
  codex?: Record<string, never>;
}

export interface BuildConfig {
  templates?: BuildConfigTemplates;
  fileRules?: Partial<Record<PlatformName, BuildConfigFileRuleSet>>;
  manifestOverrides?: BuildConfigManifestOverrides;
}

export type PluginLifecycleEvent = 'install' | 'upgrade' | 'uninstall';
export type PluginLifecycleOsSelector = 'default' | 'unix' | 'windows' | 'linux' | 'darwin' | 'win32';
export type PluginLifecycleRuntimeOs = 'linux' | 'darwin' | 'win32';
export type PluginLifecycleScriptRunner =
  | 'node'
  | 'sh'
  | 'bash'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'auto';

export interface PluginLifecycleScriptEntry {
  runner: PluginLifecycleScriptRunner;
  path: string;
  args?: string[];
}

export type PluginLifecycleScriptSelector = Partial<
  Record<PluginLifecycleOsSelector, PluginLifecycleScriptEntry>
>;

export type PluginLifecycleScriptDefinition =
  | string
  | PluginLifecycleScriptSelector;

export type PluginLifecycleScripts = Partial<
  Record<PluginLifecycleEvent, PluginLifecycleScriptSelector>
>;

export interface PluginScriptHelpersConfig {
  config: string;
}

export interface PluginNodeBuildScript {
  runner: 'node';
  path: string;
  args?: string[];
}

export interface PluginNodeScriptsConfig {
  packageRoot?: string;
  build?: PluginNodeBuildScript;
}

export interface PluginScriptTestsConfig {
  node?: string[];
}

export interface PluginArtifactRenderScriptEntry {
  runner: 'node';
  path: string;
  args?: string[];
}

export interface PluginArtifactScriptsConfig {
  render?: PluginArtifactRenderScriptEntry;
}

export interface PluginScriptsConfig {
  timeoutMs?: number;
  lifecycle?: PluginLifecycleScripts;
  helpers?: PluginScriptHelpersConfig;
  node?: PluginNodeScriptsConfig;
  artifacts?: PluginArtifactScriptsConfig;
  tests?: PluginScriptTestsConfig;
}

export type PluginConfigFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'file'
  | 'directory';

export interface PluginConfigSchemaField {
  type: PluginConfigFieldType;
  title?: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  sensitive?: boolean;
  values?: string[];
  min?: number;
  max?: number;
}

export interface PluginConfigSchema {
  schema: Record<string, PluginConfigSchemaField>;
}

export interface PlatformAgentOverrides<T> {
  claude?: Partial<T> | null;
  codex?: Partial<T> | null;
}

export interface InstructionDefinition {
  name: string;
  title: string;
  content: string;
  paths?: string[];
  agentOverrides?: PlatformAgentOverrides<{
    name: string;
    title: string;
    content: string;
    paths?: string[];
  }>;
}

export interface PermissionDefinition {
  name: string;
  allow?: string[];
  ask?: string[];
  deny?: string[];
  agentOverrides?: PlatformAgentOverrides<{
    name: string;
    allow?: string[];
    ask?: string[];
    deny?: string[];
  }>;
}

export type HookEvent =
  | 'before_tool'
  | 'after_tool'
  | 'session_start';

export interface HookDefinition {
  event: HookEvent;
  matcher?: string;
  command: string;
  agentOverrides?: PlatformAgentOverrides<{
    event: HookEvent;
    matcher?: string;
    command: string;
  }>;
}

export interface NativeHookDefinition {
  event: string;
  matcher?: string;
  command: string;
}

export interface NativeHooksByPlatform {
  claude?: NativeHookDefinition[];
  codex?: NativeHookDefinition[];
}

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  agentOverrides?: PlatformAgentOverrides<{
    name: string;
    description: string;
    prompt: string;
    tools?: string[];
  }>;
}

export interface PluginExtensions {
  instructions?: InstructionDefinition[];
  permissions?: PermissionDefinition[];
  hooks?: HookDefinition[];
  nativeHooks?: NativeHooksByPlatform;
  agents?: AgentDefinition[];
}

export type ArtifactState = 'present' | 'disabled';
export type ArtifactTarget =
  | 'codex.developerInstructionsBlock'
  | 'codex.agentRole'
  | 'codex.skill'
  | 'claude.skill';
export type DynamicArtifactKind = 'instruction' | 'codexRole' | 'skill';
export type ManagedArtifactId = string;

export interface PluginArtifactTargetDefinition {
  id: ManagedArtifactId;
  platform: PlatformName;
  scopes: Scope[];
  target: ArtifactTarget;
  kind?: DynamicArtifactKind;
  projectManagedKind?: CodexProjectManagedKind;
  states: ArtifactState[];
  refreshKeys: string[];
  requiresCodexProjectConfig?: boolean;
  roleKey?: string;
  skillKey?: string;
  sourceDirs?: string[];
}

export interface PluginArtifactsConfig {
  targets?: PluginArtifactTargetDefinition[];
}

export interface ArtifactPlanBase {
  version: 2;
  artifacts: ArtifactPlanArtifact[];
}

export type ArtifactPlan = ArtifactPlanBase;

export interface ArtifactPlanArtifactBase {
  id: ManagedArtifactId;
  platform: PlatformName;
  target: ArtifactTarget;
  kind: DynamicArtifactKind;
  state: ArtifactState;
  refreshKeys: string[];
  disabledReason?: string;
}

export interface DeveloperInstructionsBlockArtifact extends ArtifactPlanArtifactBase {
  target: 'codex.developerInstructionsBlock';
  kind: 'instruction';
  content?: string;
}

export interface CodexAgentRoleArtifact extends ArtifactPlanArtifactBase {
  target: 'codex.agentRole';
  kind: 'codexRole';
  roleKey?: string;
  content?: {
    registration?: {
      description?: string;
    };
    roleFile?: {
      name?: string;
      description?: string;
      developer_instructions?: string;
      model?: string;
      model_reasoning_effort?: string;
    };
  };
}

export interface CodexSkillArtifact extends ArtifactPlanArtifactBase {
  target: 'codex.skill';
  kind: 'skill';
  skillKey?: string;
  content?: {
    files?: Record<string, string>;
  };
}

export interface ClaudeSkillArtifact extends ArtifactPlanArtifactBase {
  target: 'claude.skill';
  kind: 'skill';
  skillKey?: string;
  content?: {
    files?: Record<string, string>;
  };
}

export type ArtifactPlanArtifact =
  | DeveloperInstructionsBlockArtifact
  | CodexAgentRoleArtifact
  | CodexSkillArtifact
  | ClaudeSkillArtifact;

export interface PluginCompatibility {
  aw: {
    minVersion: CliVersion;
  };
}

export interface PluginDependencyWhen {
  platforms: PlatformName[];
}

export interface PluginDependencyTarget {
  scope: Scope;
}

export interface PluginDependencyEntry {
  name: string;
  minVersion?: DependencyVersion;
  target?: PluginDependencyTarget;
  when?: PluginDependencyWhen;
}

export interface PluginDependenciesConfig {
  plugins: PluginDependencyEntry[];
}

export interface PluginManifestSource {
  name: string;
  version: PluginVersion;
  description: string;
  compatibility?: PluginCompatibility;
  skills?: string;
  slashCommands?: string;
  mcpServers?: string;
  apps?: string;
  marketplace: PluginMarketplaceMeta;
  interface?: PluginInterfaceMeta;
  dependencies?: PluginDependenciesConfig;
  extensions?: PluginExtensions;
  artifacts?: PluginArtifactsConfig;
  buildConfig?: BuildConfig;
  scripts?: PluginScriptsConfig;
  config?: PluginConfigSchema;
}

export interface PluginMeta {
  rootDir: string;
  manifestPath: string;
  manifest: PluginManifestSource;
}

export interface MarketplaceManifestEntry {
  name: string;
  source: string;
  description: string;
  interface?: PluginInterfaceMeta;
  category: string;
  tags?: string[];
  strict: boolean;
  policy: MarketplacePolicy;
}

export interface MarketplaceManifest {
  name: string;
  owner: MarketplaceOwner;
  interface: MarketplaceInterfaceMeta;
  plugins: MarketplaceManifestEntry[];
}

export interface CatalogManifestPackageIdentity {
  name: string;
  version: CatalogVersion;
  channel: CatalogChannel;
  manifestPath?: string;
}

export interface CatalogHistoryPluginRelease {
  name: string;
  version: PluginVersion;
  minAwVersion: CliVersion;
  artifactDigest: string;
  manifestDigest: string;
}

export interface CatalogHistoryRelease {
  catalogVersion: CatalogVersion;
  minAwVersion: CliVersion;
  plugins: CatalogHistoryPluginRelease[];
}

export interface CatalogManifestHistory {
  schemaVersion: 1;
  channel: CatalogChannel;
  releases: CatalogHistoryRelease[];
}

export interface CatalogManifestEntry {
  name: string;
  version: PluginVersion;
  description: string;
  interface?: PluginInterfaceMeta;
  category: string;
  tags?: string[];
  strict: boolean;
  policy: MarketplacePolicy;
  compatibility: PluginCompatibility;
  dependencies?: PluginDependenciesConfig;
  source: string;
  artifactDigest: string;
  manifestDigest: string;
}

export interface CatalogManifest {
  schemaVersion: 1;
  catalogVersion: CatalogVersion;
  channel: CatalogChannel;
  compatibility: PluginCompatibility;
  history: CatalogManifestHistory;
  packages: {
    sidecar: CatalogManifestPackageIdentity;
    full: CatalogManifestPackageIdentity;
  };
  entries: CatalogManifestEntry[];
}

export interface PlatformPluginManifest {
  name: string;
  version: PluginVersion;
  description: string;
  compatibility: PluginCompatibility;
  skills?: string;
  mcpServers?: string;
  apps?: string;
  interface?: PluginInterfaceMeta;
  agents?: string[];
  hooks?: string | RenderedHooksManifest;
  commands?: string;
  outputStyles?: string;
  lspServers?: string | Array<string | Record<string, unknown>> | Record<string, unknown>;
  userConfig?: Record<string, unknown>;
  channels?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface CodexHookHandler {
  type: 'command';
  command: string;
}

export interface RenderedHooksManifest {
  hooks: Record<string, Array<{
    matcher?: string;
    hooks: CodexHookHandler[];
  }>>;
}

export interface RenderedHookGroup {
  event: string;
  matcher?: string;
  hooks: CodexHookHandler[];
}

export interface TrackedHookGroupIdentity {
  event: string;
  matcher?: string;
  command: string;
}

export interface CodexSharedHookGroup {
  event: string;
  matcher?: string | null;
  hooks: Record<string, unknown>[];
  rawGroup: Record<string, unknown>;
}

export type ArtifactRefreshEvent = 'install' | 'upgrade' | 'refresh';
export type ArtifactRefreshStatus = 'succeeded' | 'failed' | 'skipped';

export interface ArtifactLastRefresh {
  status: ArtifactRefreshStatus;
  updatedAt: string;
  triggerKeys?: string[];
  event: ArtifactRefreshEvent;
  error?: string;
}

export interface ArtifactRefreshReach {
  commandScope: Scope;
  refreshedUserTarget?: boolean;
  refreshedCurrentProjectTarget?: boolean;
  scannedHistoricalProjects?: boolean;
  historicalProjectTargetsMayBeStale?: boolean;
  knownProjectTargetsOutsideReach?: string[];
}

export interface GeneratedArtifact {
  path: string;
  paths?: string[];
  kind: 'instruction' | 'permission' | 'hook' | 'agent' | 'skill' | 'mcpServer';
  platform: PlatformName;
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
  id?: ManagedArtifactId;
  target?: ArtifactTarget;
  state?: ArtifactState;
  disabledReason?: string;
  refreshKeys?: string[];
  configDigest?: string;
  contentDigest?: string;
  roleKey?: string;
  lastRefresh?: ArtifactLastRefresh;
  refreshReach?: ArtifactRefreshReach;
}

export interface TrackingPluginRecord {
  name: string;
  generatedAt: string;
  artifacts: GeneratedArtifact[];
}

export interface TrackingManifest {
  version: 1;
  plugins: Record<string, TrackingPluginRecord>;
}

export interface AgentVersionRequirement {
  platform: PlatformName;
  command: string;
  displayName: string;
  minVersion: StrictSemVerString;
}

export interface AgentVersionProbeResult {
  platform: PlatformName;
  command: string;
  status: AgentVersionStatus;
  requiredMinVersion: StrictSemVerString;
  detectedVersion?: StrictSemVerString;
  reasonCode?: AgentVersionReasonCode;
  stdout: string;
  stderr: string;
  rawOutput: string;
  exitCode?: number;
  details?: string;
}

export interface AgentVersionGateFailure {
  platform: PlatformName;
  command: CommandAction | string;
  probeCommand: string;
  status: Exclude<AgentVersionStatus, 'supported'>;
  reasonCode: AgentVersionReasonCode;
  detectedVersion?: StrictSemVerString;
  requiredMinVersion: StrictSemVerString;
  failureReason: string;
  suggestedAction: string;
  rawVersionOutput?: string;
}

export interface AgentVersionGateErrorPayload {
  command: CommandAction | string;
  failures: AgentVersionGateFailure[];
}

export interface PlatformDetection {
  available: boolean;
  scopes: Scope[];
  preferredScope?: Scope;
  reason?: string;
  agentVersion?: AgentVersionProbeResult;
}

export interface EnvironmentDetection {
  codex: PlatformDetection;
  claude: PlatformDetection;
}

export type MarketplaceSourceStatus = 'local' | 'missing' | 'invalid';
export type MarketplaceRootResolution = 'localSource' | 'installedCopy' | 'missing' | 'unknown';
export type CodexNativeCacheStatus = 'missing' | 'active' | 'invalid' | 'ambiguous';
export type NativeRecoveryState =
  | 'pending_after_native_write'
  | 'post_check_failed'
  | 'lifecycle_failed'
  | 'tracking_write_failed'
  | 'ledger_write_failed'
  | 'snapshot_write_failed'
  | 'cleanup_failed';

export interface NativeRecoveryStatus {
  present: boolean;
  state: NativeRecoveryState | null;
  reason: string | null;
  evidenceMatches: boolean | null;
  suggestion: string | null;
}

export interface NativePluginStatus {
  marketplaceRegistered: boolean;
  marketplaceSource?: string;
  marketplaceSourceType?: MarketplaceSourceStatus;
  marketplaceRootResolution?: MarketplaceRootResolution;
  requiresNativePlugin?: boolean;
  pluginAvailable: boolean;
  pluginInstalled: boolean;
  pluginEnabled?: boolean;
  configEntryPresent?: boolean;
  configPath?: string;
  cacheRootPath?: string;
  cacheStatus?: CodexNativeCacheStatus;
  activeCacheVersion?: string;
  activeCachePath?: string;
  validCachePaths?: string[];
  invalidCachePaths?: string[];
  ignoredCacheEntries?: string[];
  recovery?: NativeRecoveryStatus;
  version?: string;
  details?: string;
  declaredSource?: string;
  materializedInstallLocation?: string;
  activeLocalBundlePath?: string | null;
  sharedNativeRefs?: CodexSharedNativeRefs | null;
}

export interface GeneratedArtifactStatus {
  path: string;
  exists: boolean;
  kind: GeneratedArtifact['kind'];
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
  paths?: string[];
  id?: ManagedArtifactId;
  target?: ArtifactTarget;
  state?: ArtifactState;
  disabledReason?: string;
  refreshKeys?: string[];
  configDigest?: string;
  currentConfigDigest?: string;
  contentDigest?: string;
  currentContentDigest?: string;
  roleKey?: string;
  lastRefresh?: ArtifactLastRefresh;
  refreshReach?: ArtifactRefreshReach;
}

export type GeneratedArtifactHealth =
  | 'healthy'
  | 'disabledByConfig'
  | 'blockMissing'
  | 'missing'
  | 'contentDrift'
  | 'roleLayerMissing'
  | 'registrationDrift'
  | 'configDigestStale'
  | 'recentRefreshFailed'
  | 'unknown'
  | 'unavailable';
export type GeneratedArtifactSessionVisibility =
  | InstructionsSessionState
  | RepoManagedSessionVisibility;

export interface ManagedArtifactStatus extends GeneratedArtifactStatus {
  tracked: boolean;
  health: GeneratedArtifactHealth;
  sessionVisibility: GeneratedArtifactSessionVisibility;
  diagnostics: string[];
}

export type ScopeInitializedState = 'yes' | 'no' | 'unknown';
export type CatalogCompatibility = 'current' | 'missing' | 'capabilityChanged';
export type ProjectTrust = 'trusted' | 'untrusted' | 'unknown' | 'not_applicable';
export type RepoManagedProjectItemState =
  | 'visible'
  | 'missing'
  | 'drifted'
  | 'orphan'
  | 'blockedByProjectTrust'
  | 'projectTrustUnknown'
  | 'absent'
  | 'unknown';
export type RepoManagedProjectSummaryState = RepoManagedProjectItemState | 'not_applicable';
export type InstructionsSessionState =
  | 'visible'
  | 'shadowedByProjectDeveloperInstructions'
  | 'blockedByProjectTrust'
  | 'projectTrustUnknown'
  | 'unknownByExternalLayer'
  | 'absent'
  | 'not_applicable';
export type RepoManagedSessionVisibility =
  | 'visible'
  | 'blockedByProjectTrust'
  | 'projectTrustUnknown'
  | 'unknownByExternalLayer'
  | 'absent'
  | 'not_applicable';

export interface PlatformRuntimeEvidence {
  present: boolean;
  details?: string;
}

export interface PlatformNativeFallbackEvidence {
  present: boolean;
  details?: string;
}

export interface ExternalOwnershipStatus {
  present: boolean;
  checkState?: 'known' | 'unknown';
  marketplace?: string;
  owner?: string;
  details?: string;
}

export interface ScopeManagedEvidence {
  ledger: boolean;
  tracking: boolean;
  sharedNativeRef: boolean;
}

export interface RepoManagedProjectKindSummary {
  state: RepoManagedProjectSummaryState;
  totalCount: number;
  visibleCount: number;
  missingCount: number;
  driftedCount: number;
  orphanCount: number;
  blockedCount: number;
  projectTrustUnknownCount: number;
  unknownCount: number;
  absentCount: number;
}

export interface RepoManagedProjectItemReport {
  kind: GeneratedArtifact['kind'];
  path: string;
  artifactKey?: string;
  tracked: boolean;
  exists: boolean;
  state: RepoManagedProjectItemState;
  drift: 'yes' | 'no' | 'unknown';
  diagnostics: string[];
}

export interface RepoManagedSessionStateReport {
  instructions: InstructionsSessionState;
  rules: RepoManagedSessionVisibility;
  hooks: RepoManagedSessionVisibility;
  agents: RepoManagedSessionVisibility;
  skills?: RepoManagedProjectKindSummary;
  mcpServers?: RepoManagedProjectKindSummary;
  items?: RepoManagedProjectItemReport[];
  diagnostics: string[];
}

export interface CurrentCatalogStatus {
  rootDir: string;
  source: CatalogResolution['source'];
  available: boolean;
  reason?: string;
  reasonCode?: CatalogResolution['reasonCode'];
  selector?: CatalogResolution['selector'];
  sidecarManifestPackage?: CatalogResolution['sidecarManifestPackage'];
  fullCatalog?: CatalogResolution['fullCatalog'];
  channel?: CatalogResolution['channel'];
  catalogVersion?: CatalogResolution['catalogVersion'];
  minAwVersion?: CatalogResolution['minAwVersion'];
  latestCatalog?: CatalogResolution['latestCatalog'];
  latestCatalogBlocked?: CatalogResolution['latestCatalogBlocked'];
  historySchemaVersion?: CatalogResolution['historySchemaVersion'];
  cacheFallback?: CatalogResolution['cacheFallback'];
  remoteFailure?: CatalogResolution['remoteFailure'];
  pluginVersion?: PluginVersion;
}

export type PluginStatusDependencyHealthSource =
  | 'installSnapshot'
  | 'currentCatalog'
  | 'historical'
  | 'none';
export type PluginStatusDependencyResolvedSource =
  | 'installSnapshot'
  | 'currentCatalog';
export type PluginStatusDependencyCatalogDriftKind =
  | 'none'
  | 'snapshotMissing'
  | 'currentCatalogMissing'
  | 'dependenciesChanged';
export type PluginStatusDependencyVersionComparison =
  | 'notRequired'
  | 'satisfies'
  | 'belowMinimum'
  | 'missing'
  | 'invalid';
export type PluginStatusDependencyAutoUpgradeState =
  | 'notNeeded'
  | 'available'
  | 'catalogUnavailable'
  | 'blockedByCli'
  | 'unavailable'
  | 'unknown';

export interface PluginStatusDependencyVersionState {
  declaredMinVersion?: DependencyVersion;
  installedVersion?: string;
  candidateVersion?: PluginVersion;
  installedVersionComparison: PluginStatusDependencyVersionComparison;
  candidateVersionComparison: PluginStatusDependencyVersionComparison;
  autoUpgradeState: PluginStatusDependencyAutoUpgradeState;
}

export interface PluginStatusDependencyResolvedEntry {
  declaration: PluginDependencyEntry;
  source: PluginStatusDependencyResolvedSource;
  versionState: PluginStatusDependencyVersionState;
}

export interface PluginStatusDependencySatisfiedEntry {
  declaration: PluginDependencyEntry;
  location: PluginLocation;
}

export interface PluginStatusDependencyMissingEntry {
  declaration: PluginDependencyEntry;
  expectedLocation?: PluginLocation;
  reason: string;
}

export interface PluginStatusDependencyCatalogDrift {
  kind: PluginStatusDependencyCatalogDriftKind;
  snapshotDependencies: string[];
  currentDependencies: string[];
}

export interface PluginStatusDependencies {
  healthSource: PluginStatusDependencyHealthSource;
  declared: PluginDependencyEntry[];
  resolved: PluginStatusDependencyResolvedEntry[];
  satisfied: PluginStatusDependencySatisfiedEntry[];
  missing: PluginStatusDependencyMissingEntry[];
  dependents: PluginLocation[];
  autoInstalled: boolean;
  autoRemovable: boolean;
  catalogDrift: PluginStatusDependencyCatalogDrift;
}

export interface PluginStatusReport {
  pluginName: string;
  native: NativePluginStatus;
  generatedArtifacts: GeneratedArtifactStatus[];
  managedArtifacts?: ManagedArtifactStatus[];
  driftWarnings: string[];
  ledgerStateStatus?: LedgerStateStatus;
  ledgerStateReason?: LedgerStateReason | null;
  scopeInitialized?: ScopeInitializedState;
  projectManagedKinds?: CodexProjectManagedKind[];
  catalogCompatibility?: CatalogCompatibility;
  externalOwnership?: ExternalOwnershipStatus;
  projectTrust?: ProjectTrust;
  platformRuntimeEvidence?: PlatformRuntimeEvidence;
  platformNativeFallbackEvidence?: PlatformNativeFallbackEvidence;
  scopeManagedEvidence?: ScopeManagedEvidence;
  repoManagedSessionState?: RepoManagedSessionStateReport;
  currentCatalog?: CurrentCatalogStatus;
  activeLocalBundle?: string | null;
  artifactsInitialized?: boolean;
  dependencies?: PluginStatusDependencies;
}

export interface StatusReport {
  platform: PlatformName;
  scope: Scope;
  initialized: boolean;
  scopeInitialized?: ScopeInitializedState;
  plugins: PluginStatusReport[];
}

export interface CatalogSelectionOptions {
  catalogChannel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
}

export interface CommandOptions extends CatalogSelectionOptions {
  scope: Scope;
  platform: PlatformSelection;
  cwd: string;
  scriptTimeoutMs?: number;
}

export interface InstallCommandOptions extends CommandOptions {
  adoptExisting?: boolean;
}

export interface UpgradeCommandOptions extends CommandOptions {
  all?: boolean;
}

export type SkippedUpgradeCode =
  | 'scopeNotInitialized'
  | 'repairRequired'
  | 'cleanupRequired'
  | 'notInstalled'
  | 'dependencySkipped'
  | 'capabilityChanged'
  | 'codexProjectUserConfigUnreadable'
  | 'externalOwnershipUnknown'
  | 'externalOwnershipPresent'
  | 'roleNameConflict'
  | 'trackingIntegrityError'
  | 'catalogNotCurrent'
  | 'catalogNotProjectInstallable'
  | 'projectConfigUnreadable'
  | 'unmanagedRepoArtifactConflict';

export interface SkippedUpgradeTarget {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  reason: string;
  code: SkippedUpgradeCode;
  requested?: boolean;
  dependencyOf?: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
  }>;
}

export interface UpgradeCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  skipped: SkippedUpgradeTarget[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
  receiptTargets?: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    requested?: boolean;
    dependencyOf?: Array<{
      plugin: string;
      platform: PlatformName;
      scope: Scope;
    }>;
  }>;
  receiptActions?: Array<{
    type: 'installDependency' | 'upgradeDependency';
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    requested?: boolean;
    dependencyOf?: Array<{
      plugin: string;
      platform: PlatformName;
      scope: Scope;
    }>;
  }>;
  marketplace?: {
    rootDir: string;
    source: CatalogResolution['source'];
    changed: boolean;
    mode?: 'readOnly' | 'runtimeWritable';
    catalog: CatalogResolution;
  };
}

export interface StatusCommandOptions extends CatalogSelectionOptions {
  cwd: string;
  scope?: Scope;
  platform?: PlatformName | 'both';
  verbose?: boolean;
  json?: boolean;
}

export type StatusHealthSource = 'installSnapshot' | 'currentCatalog' | 'historical' | 'none';
export type StatusConfigHealth = 'configured' | 'missing-required' | 'invalid-config' | 'no-schema';
export type StatusScriptHealth =
  | 'declared'
  | 'not_declared'
  | 'missing-from-bundle'
  | 'unsupported-on-current-os';

export class CommandWarningError extends Error {
  readonly warnings: string[];
  readonly exitCode: number;

  constructor(
    message: string,
    options: {
      warnings?: string[];
      exitCode?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CommandWarningError';
    this.warnings = [...new Set(options.warnings ?? [])];
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isCommandWarningError(error: unknown): error is CommandWarningError {
  return (
    error instanceof Error &&
    error.name === 'CommandWarningError' &&
    Array.isArray((error as CommandWarningError).warnings) &&
    typeof (error as CommandWarningError).exitCode === 'number'
  );
}

export class AgentVersionGateError extends Error {
  readonly code = 'AGENT_VERSION_GATE_FAILED';
  readonly payload: AgentVersionGateErrorPayload;

  constructor(
    message: string,
    payload: AgentVersionGateErrorPayload,
  ) {
    super(message);
    this.name = 'AgentVersionGateError';
    this.payload = payload;
  }
}

export function isAgentVersionGateError(error: unknown): error is AgentVersionGateError {
  return (
    error instanceof Error &&
    error.name === 'AgentVersionGateError' &&
    typeof (error as AgentVersionGateError).code === 'string' &&
    typeof (error as AgentVersionGateError).payload === 'object' &&
    Array.isArray((error as AgentVersionGateError).payload.failures)
  );
}

export interface PlatformAdapter {
  name: PlatformName;
  detect(cwd: string): Promise<boolean>;
  installPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  installExtensions(
    plugin: PluginMeta,
    scope: Scope,
    options?: {
      event?: 'install' | 'upgrade' | 'refresh';
      changedConfigKeys?: string[];
      dynamicOnly?: boolean;
      previousArtifacts?: GeneratedArtifact[];
    },
  ): Promise<GeneratedArtifact[]>;
  uninstallExtensions(
    plugin: PluginMeta,
    scope: Scope,
    generatedArtifacts?: GeneratedArtifact[],
  ): Promise<void>;
  upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  status(
    plugin: PluginMeta,
    scope: Scope,
    options?: { previousArtifacts?: GeneratedArtifact[] },
  ): Promise<StatusReport>;
}

export interface LocalMarketplaceConfig {
  version: 2;
  initializedAt: string;
  sourcePackage: string;
  sourceVersion: CliVersion;
  catalogSelector: CatalogSelector;
  resolvedCatalog?: {
    channel: CatalogChannel;
    catalogVersion: CatalogVersion;
    minAwVersion: CliVersion;
    historySchemaVersion: number | null;
  };
  bundleFingerprint: string;
}

export type LedgerStateStatus = 'available' | 'degraded';
export type LedgerStateReason =
  | 'rebuilt_from_missing_or_invalid'
  | 'operation_interrupted_after_native_write'
  | 'operation_interrupted_after_artifact_write'
  | 'capability_changed_upgrade_restore_incomplete';

export interface LedgerState {
  status: LedgerStateStatus;
  degradedAt: string | null;
  reason: LedgerStateReason | null;
}

export interface ClaudeCapabilitySnapshot {
  managedExtensions?: string[];
}

export type CodexProjectManagedKind =
  | 'skill'
  | 'mcpServer'
  | 'instruction'
  | 'permission'
  | 'hook'
  | 'agent';

export interface CodexCapabilitySnapshot {
  requiresNativePlugin?: boolean;
  hasRepoManagedArtifacts?: boolean;
  projectManagedKinds?: CodexProjectManagedKind[];
  managedKinds?: CodexProjectManagedKind[];
}

export interface LifecycleConfigSnapshotMetadata {
  snapshotRoot: string;
  bundleRoot: string;
  manifestPath: string;
  pluginName: string;
  pluginVersion: PluginVersion;
  sourceManifestDigest: string;
  bundleFingerprint: string;
  createdAt: string;
  createdFrom: {
    source: 'currentCatalog' | 'test' | 'unknown';
    catalogRoot?: string;
    catalogSource?: CatalogResolution['source'];
    pluginRoot?: string;
  };
}

export interface PluginLocation {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
}

export interface InstalledScopeInstallSource {
  kind: 'explicit' | 'dependency';
  explicitlyRequested: boolean;
  allowsUnusedCleanup: boolean;
}

export interface InstalledDependencyEdgeDeclaration {
  name: string;
  minVersion?: DependencyVersion;
  target?: {
    scope?: Scope;
  };
  when?: {
    platforms?: PlatformName[];
  };
}

export interface InstalledDependencyEdge {
  dependency: PluginLocation;
  declaration: InstalledDependencyEdgeDeclaration;
}

export interface InstalledScopeRecord<TCapabilitySnapshot> {
  managed: boolean;
  updatedAt: string;
  resolvedVersion: InstalledVersion;
  capabilitySnapshot: TCapabilitySnapshot;
  projectKey?: string;
  installSource?: InstalledScopeInstallSource;
  dependencyEdges?: InstalledDependencyEdge[];
  lifecycleConfigSnapshot?: LifecycleConfigSnapshotMetadata;
}

export interface CodexSharedNativeRefs {
  user: boolean;
  projects: string[];
}

export interface InstalledLedgerPluginPlatforms {
  claude?: {
    userScope?: InstalledScopeRecord<ClaudeCapabilitySnapshot>;
    projectScopes?: Record<string, InstalledScopeRecord<ClaudeCapabilitySnapshot>>;
    lastRequestedScope?: Scope;
    lastRequestedAt?: string;
  };
  codex?: {
    userScope?: InstalledScopeRecord<CodexCapabilitySnapshot>;
    projectScopes?: Record<string, InstalledScopeRecord<CodexCapabilitySnapshot>>;
    sharedNativeRefs?: CodexSharedNativeRefs;
    lastRequestedScope?: Scope;
    lastRequestedAt?: string;
  };
}

export interface InstalledLedgerPluginRecord {
  lastResolvedVersion: InstalledVersion;
  platforms: InstalledLedgerPluginPlatforms;
}

export interface InstalledLedger {
  version: 1;
  ledgerState: LedgerState;
  plugins: Record<string, InstalledLedgerPluginRecord>;
}

export interface CatalogSelector {
  kind: 'default' | 'distTag' | 'exactVersion';
  cliVersion: CliVersion;
  defaultChannel: CatalogChannel;
  requestedChannel?: CatalogChannel;
  requestedCatalogVersion?: CatalogVersion;
  overrideSource?:
    | 'option:catalog-channel'
    | 'option:channel-alias'
    | 'option:catalog-version'
    | 'env:AW_CATALOG_CHANNEL'
    | 'env:AW_CATALOG_VERSION';
}

export interface CatalogLatestBlockedEvidence {
  channel: CatalogChannel;
  catalogVersion: CatalogVersion;
  minAwVersion: CliVersion;
}

export interface CatalogLatestEvidence extends CatalogLatestBlockedEvidence {
  blocked: boolean;
}

export interface CatalogSidecarManifestEvidence {
  source: string;
  version: CatalogVersion;
  channel: CatalogChannel;
  npmIntegrity?: string;
  manifestDigest: string;
}

export interface CatalogIdentityEvidence {
  source: 'local' | 'embedded' | 'remote' | 'cache';
  version: CatalogVersion;
  channel: CatalogChannel;
  minAwVersion: CliVersion;
  revision: string;
  freshness: 'fresh' | 'cached' | 'localFixture' | 'embedded';
  resolutionSource: 'requestedCatalog' | 'historyCompatibleCatalog';
}

export interface CatalogCacheFallbackEvidence {
  used: boolean;
  source?: 'currentCatalogCache';
  cacheKey?: string;
  selectorKey?: string;
  blockingCode?: CatalogResolutionFailure['reasonCode'];
  matchedSelector?: CatalogSelector;
  matchedCatalog?: CatalogIdentityEvidence;
}

export interface CatalogRemoteFailureEvidence {
  stage:
    | 'sidecarMetadata'
    | 'sidecarTarball'
    | 'sidecarManifest'
    | 'historyLookup'
    | 'fullMetadata'
    | 'fullTarball'
    | 'fullManifest'
    | 'artifactDigest';
  packageName?: string;
  packageVersion?: CatalogVersion;
  integrity?: string;
  message: string;
}

export interface CatalogResolutionFailure {
  selector: CatalogSelector;
  channel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
  minAwVersion?: CliVersion;
  latestCatalogBlocked?: CatalogLatestBlockedEvidence;
  historySchemaVersion?: number | null;
  cacheFallback?: CatalogCacheFallbackEvidence;
  remoteFailure?: CatalogRemoteFailureEvidence;
  reason: string;
  reasonCode:
    | 'catalogUnavailable'
    | 'catalogHistoryUnavailable'
    | 'awVersionTooLow'
    | 'explicitCatalogIncompatible';
}

export interface CatalogResolution {
  rootDir: string;
  source: 'local' | 'embedded' | 'remote' | 'cache';
  selector?: CatalogSelector;
  sidecarManifestPackage?: CatalogSidecarManifestEvidence;
  fullCatalog?: CatalogIdentityEvidence;
  channel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
  minAwVersion?: CliVersion;
  latestCatalog?: CatalogLatestEvidence;
  latestCatalogBlocked?: CatalogLatestBlockedEvidence;
  historySchemaVersion?: number | null;
  cacheFallback?: CatalogCacheFallbackEvidence;
  remoteFailure?: CatalogRemoteFailureEvidence;
  reason?: string;
  reasonCode?:
    | 'localCatalogMissing'
    | 'localCatalogConfigInvalid'
    | 'localCatalogSourceVersionMissing'
    | 'localCatalogSourceVersionInvalid'
    | 'localCatalogSourceVersionAhead'
    | 'localCatalogSourceVersionBehind'
    | 'localCatalogFingerprintMismatch'
    | 'localCatalogLayoutInvalid'
    | 'localLedgerDegraded'
    | CatalogResolutionFailure['reasonCode'];
}
