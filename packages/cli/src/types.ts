export type PlatformName = 'codex' | 'claude';
export type PlatformSelection = PlatformName | 'auto' | 'both';
export type Scope = 'project' | 'user';
export type CommandAction = 'install' | 'uninstall' | 'upgrade' | 'status';

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
  | 'session_start'
  | 'session_stop'
  | 'command';

export interface HookDefinition {
  event: HookEvent;
  matcher?: string;
  command: string;
  description?: string;
  agentOverrides?: PlatformAgentOverrides<{
    event: HookEvent;
    matcher?: string;
    command: string;
    description?: string;
  }>;
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
  agents?: AgentDefinition[];
}

export interface PluginManifestSource {
  name: string;
  version: string;
  description: string;
  skills?: string;
  mcpServers?: string;
  apps?: string;
  marketplace: PluginMarketplaceMeta;
  interface?: PluginInterfaceMeta;
  extensions?: PluginExtensions;
  buildConfig?: BuildConfig;
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

export interface CodexHookCommand {
  matcher: string;
  command: string;
  description?: string;
}

export interface GeneratedArtifact {
  path: string;
  kind: 'instruction' | 'permission' | 'hook' | 'agent';
  platform: PlatformName;
  hookCommands?: CodexHookCommand[];
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

export interface NativePluginStatus {
  marketplaceRegistered: boolean;
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
}

export type ScopeInitializedState = 'yes' | 'no' | 'unknown';
export type CatalogCompatibility = 'current' | 'missing' | 'capabilityChanged';
export type ProjectTrust = 'trusted' | 'untrusted' | 'unknown' | 'not_applicable';
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
  marketplace?: string;
  owner?: string;
  details?: string;
}

export interface ScopeManagedEvidence {
  ledger: boolean;
  tracking: boolean;
  sharedNativeRef: boolean;
}

export interface RepoManagedSessionStateReport {
  instructions: InstructionsSessionState;
  rules: RepoManagedSessionVisibility;
  hooks: RepoManagedSessionVisibility;
  agents: RepoManagedSessionVisibility;
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
  ledgerStateStatus?: LedgerStateStatus;
  ledgerStateReason?: LedgerStateReason | null;
  scopeInitialized?: ScopeInitializedState;
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
  | 'operation_interrupted_after_artifact_write';

export interface LedgerState {
  status: LedgerStateStatus;
  degradedAt: string | null;
  reason: LedgerStateReason | null;
}

export interface ClaudeCapabilitySnapshot {
  managedExtensions?: string[];
}

export interface CodexCapabilitySnapshot {
  requiresNativePlugin?: boolean;
  hasRepoManagedArtifacts?: boolean;
}

export interface InstalledScopeRecord<TCapabilitySnapshot> {
  managed: boolean;
  updatedAt: string;
  resolvedVersion: string;
  capabilitySnapshot: TCapabilitySnapshot;
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
