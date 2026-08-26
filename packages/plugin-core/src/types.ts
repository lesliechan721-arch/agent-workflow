import type { PluginManifestSourceV1 } from './generated/plugin-manifest-v1.js';

export type PlatformName = 'codex' | 'claude';
export type DistributionName = 'agent-skills';
export type Scope = 'project' | 'user';
export type CatalogChannel = 'latest' | 'beta';
export type CliVersion = string;
export type PluginVersion = string;
export type PluginId = string;
export type CatalogSourceId = string;
export type SourceIdentity = string;
export type SupportedPlatformSet = ReadonlySet<PlatformName>;
export type CodexProjectManagedKind =
  | 'skill'
  | 'mcpServer'
  | 'instruction'
  | 'permission'
  | 'hook'
  | 'agent';

export type PluginInterfaceMeta = NonNullable<PluginManifestSourceV1['interface']>;

export interface MarketplaceOwner { name: string; url: string }
export interface MarketplaceInterfaceMeta { displayName: string }
export interface MarketplaceSourceMeta {
  owner: MarketplaceOwner;
  interface: MarketplaceInterfaceMeta;
  catalog: { version: string };
}
export type MarketplacePolicy = PluginManifestSourceV1['marketplace']['policy'];
export type MarketplaceAuthenticationPolicy = MarketplacePolicy['authentication'];
export type PluginMarketplaceMeta = PluginManifestSourceV1['marketplace'];

export type TemplateValue = string | boolean;
export interface TemplateVarByPlatform { claude: TemplateValue; codex: TemplateValue }
export interface BuildConfigTemplates {
  vars: Record<string, TemplateVarByPlatform>;
  include: string[];
}
export interface BuildConfigFileRuleSet { include: string[]; exclude: string[] }
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
export interface BuildConfigRuntimeExport { name: string; source: string }
export interface BuildConfigImportReference { plugin: string; export: string }
export interface BuildConfigBuildImport extends BuildConfigImportReference { env: string }
export interface BuildConfigSkillRuntimeFile {
  skill: string;
  target: string;
  platforms?: PlatformName[];
  distributions?: DistributionName[];
  source?: string;
  import?: BuildConfigImportReference;
}
export interface BuildConfigGeneratedSkillRuntimeFile {
  skill: string;
  target: string;
  distributions?: DistributionName[];
}
export interface BuildConfig {
  cacheable?: true;
  templates?: BuildConfigTemplates;
  fileRules?: Partial<Record<PlatformName, BuildConfigFileRuleSet>>;
  manifestOverrides?: BuildConfigManifestOverrides;
  runtimeExports?: BuildConfigRuntimeExport[];
  buildImports?: BuildConfigBuildImport[];
  skillRuntimeFiles?: BuildConfigSkillRuntimeFile[];
  generatedSkillRuntimeFiles?: BuildConfigGeneratedSkillRuntimeFile[];
}

export type PluginLifecycleEvent = 'install' | 'upgrade' | 'uninstall';
export type PluginLifecycleOsSelector = 'default' | 'unix' | 'windows' | 'linux' | 'darwin' | 'win32';
export type PluginLifecycleRuntimeOs = 'linux' | 'darwin' | 'win32';
export type PluginLifecycleScriptRunner = 'node' | 'sh' | 'bash' | 'pwsh' | 'powershell' | 'cmd' | 'auto';
export interface PluginLifecycleScriptEntry { runner: PluginLifecycleScriptRunner; path: string; args?: string[] }
export type PluginLifecycleScriptSelector = Partial<Record<PluginLifecycleOsSelector, PluginLifecycleScriptEntry>>;
export type PluginLifecycleScriptDefinition = string | PluginLifecycleScriptSelector;
export type PluginLifecycleScripts = Partial<Record<PluginLifecycleEvent, PluginLifecycleScriptSelector>>;
export interface PluginScriptHelpersConfig { config: string }
export interface PluginNodeBuildScript { runner: 'node'; path: string; args?: string[] }
export interface PluginNodeScriptsConfig { packageRoot?: string; build?: PluginNodeBuildScript }
export interface PluginScriptTestsConfig { node?: string[] }
export interface PluginArtifactRenderScriptEntry { runner: 'node'; path: string; args?: string[] }
export interface PluginArtifactScriptsConfig { render?: PluginArtifactRenderScriptEntry }
export interface PluginScriptsConfig {
  timeoutMs?: number;
  lifecycle?: PluginLifecycleScripts;
  helpers?: PluginScriptHelpersConfig;
  node?: PluginNodeScriptsConfig;
  artifacts?: PluginArtifactScriptsConfig;
  tests?: PluginScriptTestsConfig;
}

export type PluginConfigFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'file' | 'directory';
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

export interface PlatformAgentOverrides<T> { claude?: Partial<T> | null; codex?: Partial<T> | null }
export interface InstructionDefinition {
  name: string; title: string; content: string; paths?: string[];
  agentOverrides?: PlatformAgentOverrides<{ name: string; title: string; content: string; paths?: string[] }>;
}
export interface PermissionDefinition {
  name: string; allow?: string[]; ask?: string[]; deny?: string[];
  agentOverrides?: PlatformAgentOverrides<{ name: string; allow?: string[]; ask?: string[]; deny?: string[] }>;
}
export type HookEvent = 'before_tool' | 'after_tool' | 'session_start';
export interface HookDefinition {
  event: HookEvent; matcher?: string; command: string;
  agentOverrides?: PlatformAgentOverrides<{ event: HookEvent; matcher?: string; command: string }>;
}
export interface NativeHookDefinition { event: string; matcher?: string; command: string }
export interface NativeHooksByPlatform { claude?: NativeHookDefinition[]; codex?: NativeHookDefinition[] }
export interface AgentDefinition {
  name: string; description: string; prompt: string; tools?: string[];
  agentOverrides?: PlatformAgentOverrides<{ name: string; description: string; prompt: string; tools?: string[] }>;
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
  | 'claude.skill'
  | 'agent-skills.skill';
export type DynamicArtifactKind = 'instruction' | 'codexRole' | 'skill';
export type ManagedArtifactId = string;
export interface ArtifactRuntimeImportDefinition extends BuildConfigImportReference {
  name: string;
  resolved?: { path: string; digest: string; providerPluginId: PluginId; providerVersion: PluginVersion; source: string };
}
export interface PluginArtifactTargetDefinition {
  id: string;
  platform?: PlatformName;
  distribution?: DistributionName;
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
  runtimeImports?: ArtifactRuntimeImportDefinition[];
}
export interface PluginArtifactsConfig { targets?: PluginArtifactTargetDefinition[] }
export interface PluginAgentSkillsDistribution { skills?: string }
export interface PluginDistributionsConfig { agentSkills?: PluginAgentSkillsDistribution }
export interface PluginCompatibility { aw: { minVersion: CliVersion } }

export type PluginManifestSource = PluginManifestSourceV1;
export type NormalizedPluginManifest = Omit<
  PluginManifestSourceV1,
  'schemaVersion' | 'compatibility' | 'extensions' | 'artifacts' | 'buildConfig' | 'scripts' | 'config'
> & {
  schemaVersion: 1;
  compatibility: PluginCompatibility;
  extensions?: PluginExtensions;
  artifacts?: PluginArtifactsConfig;
  buildConfig?: BuildConfig;
  scripts?: PluginScriptsConfig;
  config?: PluginConfigSchema;
};
export interface PluginMeta {
  sourceId?: CatalogSourceId;
  sourceIdentity?: SourceIdentity;
  pluginId?: PluginId;
  marketplaceName?: string;
  rootDir: string;
  manifestPath: string;
  manifest: NormalizedPluginManifest;
}

export interface MarketplaceManifestEntry {
  name: string; source: string; description: string; interface?: PluginInterfaceMeta;
  category: string; tags?: string[]; strict: boolean; policy: MarketplacePolicy;
}
export interface MarketplaceManifest {
  name: string; owner: MarketplaceOwner; interface: MarketplaceInterfaceMeta; plugins: MarketplaceManifestEntry[];
}
export interface CatalogManifestEntry {
  name: string; version: PluginVersion; description: string; interface?: PluginInterfaceMeta;
  category: string; tags?: string[]; strict: boolean; policy: MarketplacePolicy;
  compatibility: PluginCompatibility; source: string; artifactDigest: string; manifestDigest: string;
}
export interface CatalogManifestV4Entry extends CatalogManifestEntry {
  name: PluginId;
  contentDigest: string;
}
export interface CatalogMarketplaceIdentity {
  owner: MarketplaceOwner;
  interface: MarketplaceInterfaceMeta;
}
export type CatalogManifestV4Release =
  | { state: 'development' }
  | {
      state: 'published';
      targetVersion: string;
      planId: string;
      sourceHead: string;
      contentDigest: string;
    };
export interface CatalogManifestV4 {
  schemaVersion: 4;
  catalogVersion: string;
  channel: CatalogChannel;
  compatibility: PluginCompatibility;
  marketplace: CatalogMarketplaceIdentity;
  release: CatalogManifestV4Release;
  entries: CatalogManifestV4Entry[];
}
export interface PlatformPluginManifest {
  name: string; version: PluginVersion; description: string; compatibility: PluginCompatibility;
  skills?: string; mcpServers?: string; apps?: string; interface?: PluginInterfaceMeta;
  agents?: string[]; hooks?: string | RenderedHooksManifest; commands?: string; outputStyles?: string;
  lspServers?: string | Array<string | Record<string, unknown>> | Record<string, unknown>;
  userConfig?: Record<string, unknown>; channels?: Record<string, unknown> | Array<Record<string, unknown>>;
}
export interface CodexHookHandler { type: 'command'; command: string }
export interface RenderedHooksManifest { hooks: Record<string, Array<{ matcher?: string; hooks: CodexHookHandler[] }>> }
export interface RenderedHookGroup { event: string; matcher?: string; hooks: CodexHookHandler[] }
export interface TrackedHookGroupIdentity { event: string; matcher?: string; command: string }
export interface CodexSharedHookGroup {
  event: string; matcher?: string | null; hooks: Record<string, unknown>[]; rawGroup: Record<string, unknown>;
}
export interface ArtifactPlanArtifactBase {
  id: string; platform?: PlatformName; distribution?: DistributionName; target: ArtifactTarget;
  kind: DynamicArtifactKind; state: ArtifactState; refreshKeys: string[]; disabledReason?: string;
}
export interface CodexSkillArtifact extends ArtifactPlanArtifactBase {
  target: 'codex.skill'; kind: 'skill'; skillKey?: string; content?: { files?: Record<string, string> };
}
export interface ClaudeSkillArtifact extends ArtifactPlanArtifactBase {
  target: 'claude.skill'; kind: 'skill'; skillKey?: string; content?: { files?: Record<string, string> };
}
