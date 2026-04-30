export type PlatformName = 'codex' | 'claude';
export type PlatformSelection = PlatformName | 'auto' | 'both';
export type Scope = 'project' | 'user';
export type CommandAction = 'install' | 'uninstall' | 'upgrade' | 'status';
export type SkillTriggerPreference = 'default' | 'manual' | 'auto';
export type SkillTriggerApplicability = 'none' | 'fixed' | 'overridable';
export type NativePluginsByPlatform = Partial<Record<PlatformName, string[]>>;

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

export interface PluginScriptsConfig {
  timeoutMs?: number;
  lifecycle?: PluginLifecycleScripts;
  helpers?: PluginScriptHelpersConfig;
  node?: PluginNodeScriptsConfig;
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

export interface SkillTriggerPolicy {
  allowInstallOverride: boolean;
}

export interface PluginManifestSource {
  name: string;
  version: string;
  description: string;
  skills?: string;
  slashCommands?: string;
  skillTriggers?: Record<string, SkillTriggerPolicy>;
  mcpServers?: string;
  apps?: string;
  marketplace: PluginMarketplaceMeta;
  interface?: PluginInterfaceMeta;
  extensions?: PluginExtensions;
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

export interface PlatformPluginManifest {
  name: string;
  version: string;
  description: string;
  skills?: string;
  mcpServers?: string;
  apps?: string;
  interface?: PluginInterfaceMeta;
  agents?: string[];
  hooks?: string | Record<string, unknown>;
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

export interface GeneratedArtifact {
  path: string;
  kind: 'instruction' | 'permission' | 'hook' | 'agent' | 'skill' | 'mcpServer';
  platform: PlatformName;
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
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

export interface PlatformDetection {
  available: boolean;
  scopes: Scope[];
  preferredScope?: Scope;
  reason?: string;
}

export interface EnvironmentDetection {
  codex: PlatformDetection;
  claude: PlatformDetection;
}

export type MarketplaceSourceStatus = 'local' | 'missing' | 'invalid';
export type MarketplaceRootResolution = 'localSource' | 'installedCopy' | 'missing' | 'unknown';

export interface NativePluginStatus {
  marketplaceRegistered: boolean;
  marketplaceSource?: string;
  marketplaceSourceType?: MarketplaceSourceStatus;
  marketplaceRootResolution?: MarketplaceRootResolution;
  pluginAvailable: boolean;
  pluginInstalled: boolean;
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
}

export interface PluginStatusReport {
  pluginName: string;
  native: NativePluginStatus;
  generatedArtifacts: GeneratedArtifactStatus[];
  driftWarnings: string[];
  installOptions?: InstalledScopeInstallOptions;
  skillTriggerApplicability?: SkillTriggerApplicability;
  skillTriggerPreference?: SkillTriggerPreference;
  skillTriggerRuntimeMatches?: SkillTriggerPreference[];
  skillTriggerRuntimeState?: 'matched' | 'mixed' | 'unknown';
  skillTriggerDrift?: 'yes' | 'no' | 'unknown';
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
}

export interface StatusReport {
  platform: PlatformName;
  scope: Scope;
  initialized: boolean;
  scopeInitialized?: ScopeInitializedState;
  plugins: PluginStatusReport[];
}

export interface CommandOptions {
  scope: Scope;
  platform: PlatformSelection;
  cwd: string;
  scriptTimeoutMs?: number;
}

export interface InstallCommandOptions extends CommandOptions {
  requestedSkillTrigger?: SkillTriggerPreference;
}

export interface UpgradeCommandOptions extends CommandOptions {
  all?: boolean;
  requestedSkillTrigger?: SkillTriggerPreference;
}

export type SkippedUpgradeCode =
  | 'scopeNotInitialized'
  | 'codexProjectUserConfigUnreadable'
  | 'externalOwnershipUnknown'
  | 'externalOwnershipPresent'
  | 'trackingIntegrityError'
  | 'installOptionsUnavailable'
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
}

export interface UpgradeCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  skipped: SkippedUpgradeTarget[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
  marketplace?: {
    rootDir: string;
    source: CatalogResolution['source'];
    changed: boolean;
    mode?: 'readOnly' | 'runtimeWritable';
    catalog: CatalogResolution;
  };
}

export interface StatusCommandOptions {
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

export type ResolvedInstallOptionsSource = 'cli' | 'ledger' | 'default';
export type ResolvedInstallOptionsLedgerTrust = 'available' | 'degraded';

export interface ResolvedInstallOptionsBase {
  applicability: SkillTriggerApplicability;
  ledgerTrust: ResolvedInstallOptionsLedgerTrust;
}

export interface ResolvedInstallOptionsNone extends ResolvedInstallOptionsBase {
  applicability: 'none';
}

export interface ResolvedInstallOptionsFixed extends ResolvedInstallOptionsBase {
  applicability: 'fixed';
}

export interface ResolvedInstallOptionsOverridable extends ResolvedInstallOptionsBase {
  applicability: 'overridable';
  skillTriggerPreference: SkillTriggerPreference;
  skillTriggerSource: ResolvedInstallOptionsSource;
}

export type ResolvedInstallOptions =
  | ResolvedInstallOptionsNone
  | ResolvedInstallOptionsFixed
  | ResolvedInstallOptionsOverridable;

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

export interface PlatformAdapter {
  name: PlatformName;
  detect(cwd: string): Promise<boolean>;
  installPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]>;
  uninstallExtensions(
    plugin: PluginMeta,
    scope: Scope,
    generatedArtifacts?: GeneratedArtifact[],
  ): Promise<void>;
  upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  status(plugin: PluginMeta, scope: Scope): Promise<StatusReport>;
}

export interface LocalMarketplaceConfig {
  version: 1;
  initializedAt: string;
  sourcePackage: string;
  sourceVersion: string;
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

export interface InstalledScopeInstallOptions {
  skillTriggerPreference?: SkillTriggerPreference;
}

export interface LifecycleConfigSnapshotMetadata {
  snapshotRoot: string;
  bundleRoot: string;
  manifestPath: string;
  pluginName: string;
  pluginVersion: string;
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

export interface InstalledScopeRecord<TCapabilitySnapshot> {
  managed: boolean;
  updatedAt: string;
  resolvedVersion: string;
  capabilitySnapshot: TCapabilitySnapshot;
  projectKey?: string;
  installOptions?: InstalledScopeInstallOptions;
  skillTriggerWriteOrder?: number;
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
  lastResolvedVersion: string;
  platforms: InstalledLedgerPluginPlatforms;
}

export interface InstalledLedger {
  version: 1;
  ledgerState: LedgerState;
  plugins: Record<string, InstalledLedgerPluginRecord>;
}

export interface CatalogResolution {
  rootDir: string;
  source: 'local' | 'embedded';
  reason?: string;
}
