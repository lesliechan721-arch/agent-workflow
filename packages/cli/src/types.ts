export type PlatformName = 'codex' | 'claude';
export type SupportedPlatformSet = ReadonlySet<PlatformName>;
export type PlatformSelection = PlatformName | 'both';
export type Scope = 'project' | 'user';
export type CommandAction =
  | 'install'
  | 'uninstall'
  | 'upgrade'
  | 'upgradeAll'
  | 'reinstall'
  | 'cleanup'
  | 'config'
  | 'status';
export type RebuildCommand = 'install' | 'upgrade' | 'cleanup' | 'reinstall' | 'uninstall';
export type RebuildActionName =
  | 'preflight.inspect'
  | 'stale.cleanup'
  | 'native.write'
  | 'artifacts.write'
  | 'active.prepare'
  | 'active.discard'
  | `lifecycle.${PluginLifecycleEvent}`
  | 'active.promote'
  | 'postcheck.inspect'
  | 'marketplace.commit'
  | 'marketplace.rollback'
  | 'recovery.cleanup'
  | 'cleanup.owned'
  | 'active.read'
  | 'active.remove'
  | 'active.release'
  | 'operation.lock'
  | 'operation.release';
export type RebuildActionEventData =
  | {
      name: RebuildActionName;
      phase: 'start';
    }
  | {
      name: RebuildActionName;
      phase: 'success';
      durationMs: number;
    }
  | {
      name: RebuildActionName;
      phase: 'failure';
      durationMs: number;
      message?: string;
    };
export interface RebuildActionEvent {
  type: 'rebuild:action';
  source: {
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    action: RebuildCommand;
  };
  data: RebuildActionEventData;
}
export type StrictSemVerString = string;
export type CliVersion = StrictSemVerString;
export type CatalogVersion = StrictSemVerString;
export type PluginVersion = StrictSemVerString;
export type CatalogSourceId = string;
export type PluginId = string;
export type SourceIdentity = string;
export type AgentVersionStatus = 'supported' | 'missing' | 'probeFailed' | 'unparseable' | 'tooOld';
export type AgentVersionReasonCode =
  | 'agentVersionMissing'
  | 'agentVersionProbeFailed'
  | 'agentVersionUnparseable'
  | 'agentVersionTooLow';
export type CatalogChannel = 'latest' | 'beta';
export type ConfigFieldKind = 'manifest';
export type ConfigValueState = 'default' | 'configured' | 'invalid';
export type NextStepKind = 'uiAction' | 'cliCommand' | 'manual';
export type ManualNextStepKind = 'guidance' | 'blocker' | 'documentation';
export type TargetWriteState = 'completed' | 'failed';
export type ReceiptOverallState = 'succeeded' | 'failed';

export type CatalogGitRefPolicy =
  | { type: 'explicit'; ref: string }
  | { type: 'cliChannel' };

interface CatalogSourceBase {
  id: CatalogSourceId;
  primary: boolean;
}

export interface GitCatalogSource extends CatalogSourceBase {
  type: 'git';
  url: string;
  refPolicy: CatalogGitRefPolicy;
  subdir?: string;
}

export interface PathCatalogSource extends CatalogSourceBase {
  type: 'path';
  path: string;
}

export type CatalogSource = GitCatalogSource | PathCatalogSource;

export interface CatalogSourcesConfig {
  schemaVersion: 1;
  sources: CatalogSource[];
}

export interface CatalogSourceResolution {
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  resolvedCommit: string;
  rootDir: string;
  manifest: CatalogManifestV3;
  manifestDigest: string;
  snapshotDigest: string;
  cacheEntryKey: string;
  source: 'remote' | 'cache' | 'path';
  cacheFallback: boolean;
  remoteFailure?: string;
}

export interface CatalogProviderRuntimeOptions {
  cliVersion: CliVersion;
  freshnessPolicy: CatalogFreshnessPolicy;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

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
  pluginId?: PluginId;
  marketplaceName?: string;
  sourceId?: CatalogSourceId;
  sourceIdentity?: SourceIdentity;
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
}

export interface ConfigFieldEntry {
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

export interface ConfigReceiptFieldEntry {
  key: string;
  title: string;
  kind: ConfigFieldKind;
  reserved: boolean;
  action: 'set' | 'unset' | 'reset';
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  valueState?: ConfigValueState;
}

export interface ConfigSchemaEvidence {
  source: 'currentCatalog';
  identity: string;
  pluginVersion: PluginVersion;
  manifestDigest: string;
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

export type MarketplaceAuthenticationPolicy = 'ON_INSTALL' | 'ON_USE';

export interface MarketplacePolicy {
  installation: string;
  authentication: MarketplaceAuthenticationPolicy;
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

export interface BuildConfigRuntimeExport {
  name: string;
  source: string;
}

export interface BuildConfigImportReference {
  plugin: string;
  export: string;
}

export interface BuildConfigBuildImport extends BuildConfigImportReference {
  env: string;
}

export interface BuildConfigSkillRuntimeFile {
  skill: string;
  target: string;
  platforms?: PlatformName[];
  source?: string;
  import?: BuildConfigImportReference;
}

export interface BuildConfig {
  cacheable?: true;
  templates?: BuildConfigTemplates;
  fileRules?: Partial<Record<PlatformName, BuildConfigFileRuleSet>>;
  manifestOverrides?: BuildConfigManifestOverrides;
  runtimeExports?: BuildConfigRuntimeExport[];
  buildImports?: BuildConfigBuildImport[];
  skillRuntimeFiles?: BuildConfigSkillRuntimeFile[];
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

export type PluginConfigPresentationValue = string | number | boolean;

export interface PluginConfigPresentationGroup {
  id: string;
  title: string;
  description?: string;
  fields: string[];
  advanced?: boolean;
}

export interface PluginConfigPresentationField {
  valueLabels?: Record<string, string>;
  recommendedValue?: PluginConfigPresentationValue;
  placeholder?: string;
  unit?: string;
  advanced?: boolean;
}

export interface PluginConfigPresentationPreset {
  id: string;
  title: string;
  description?: string;
  values: Record<string, PluginConfigPresentationValue>;
}

export interface PluginConfigPresentation {
  groups?: PluginConfigPresentationGroup[];
  fields?: Record<string, PluginConfigPresentationField>;
  presets?: PluginConfigPresentationPreset[];
}

export interface PluginConfigSchema {
  schema: Record<string, PluginConfigSchemaField>;
  presentation?: PluginConfigPresentation;
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
  extensions?: PluginExtensions;
  artifacts?: PluginArtifactsConfig;
  buildConfig?: BuildConfig;
  scripts?: PluginScriptsConfig;
  config?: PluginConfigSchema;
}

export interface PluginMeta {
  sourceId?: CatalogSourceId;
  sourceIdentity?: SourceIdentity;
  pluginId?: PluginId;
  marketplaceName?: string;
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
  source: string;
  artifactDigest: string;
  manifestDigest: string;
}

export interface CatalogManifestV3Entry extends CatalogManifestEntry {
  name: PluginId;
  contentDigest: string;
}

export interface CatalogManifestV3 {
  schemaVersion: 3;
  catalogVersion: CatalogVersion;
  channel: CatalogChannel;
  compatibility: PluginCompatibility;
  entries: CatalogManifestV3Entry[];
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

export interface CommandOptions {
  scope: Scope;
  platform: PlatformSelection;
  cwd: string;
  scriptTimeoutMs?: number;
}

export type InstallCommandOptions = CommandOptions;

export interface UpgradeCommandOptions extends CommandOptions {
  all?: boolean;
}

export interface StatusCommandOptions {
  cwd: string;
  scope?: Scope;
  platform?: PlatformName | 'both';
  verbose?: boolean;
  json?: boolean;
}

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

export type CodexProjectManagedKind =
  | 'skill'
  | 'mcpServer'
  | 'instruction'
  | 'permission'
  | 'hook'
  | 'agent';

export type CatalogFreshnessPolicy = 'cacheFirst' | 'requireRemote' | 'forceRemote';

export interface CatalogResolution {
  rootDir: string;
  source: 'local' | 'embedded' | 'remote' | 'cache';
  channel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
  minAwVersion?: CliVersion;
}
