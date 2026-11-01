import type { PluginManifestSourceV3 } from './generated/plugin-manifest-v3.js';
import type { ManagedCommands, ManagedCommandPermission, PermissionCommand } from './managed-commands.js';

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

export type PluginInterfaceMeta = NonNullable<PluginManifestSourceV3['interface']>;

export interface MarketplaceOwner { name: string; url: string }
export interface MarketplaceInterfaceMeta { displayName: string }
export interface MarketplaceSourceMeta {
  owner: MarketplaceOwner;
  interface: MarketplaceInterfaceMeta;
  catalog: { version: string };
}
export type MarketplacePolicy = PluginManifestSourceV3['marketplace']['policy'];
export type MarketplaceAuthenticationPolicy = MarketplacePolicy['authentication'];
export type PluginMarketplaceMeta = PluginManifestSourceV3['marketplace'];

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
export interface BuildConfigRuntimeExport {
  name: string;
  source: string;
  requires: { aw: { capabilities: string[] } };
}
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

export interface PluginPreApplyScript { path: string; timeoutMs?: number }
export interface PluginScriptHelpersConfig { config: string }
export interface PluginNodeBuildScript { runner: 'node'; path: string; args?: string[] }
export interface PluginNodeScriptsConfig { packageRoot?: string; build?: PluginNodeBuildScript }
export interface PluginScriptTestsConfig { node?: string[] }
export interface PluginArtifactRenderScriptEntry { runner: 'node'; path: string; args?: string[] }
export interface PluginArtifactScriptsConfig { render?: PluginArtifactRenderScriptEntry }
export interface PluginScriptsConfig {
  preApply?: PluginPreApplyScript;
  helpers?: PluginScriptHelpersConfig;
  node?: PluginNodeScriptsConfig;
  artifacts?: PluginArtifactScriptsConfig;
  tests?: PluginScriptTestsConfig;
}

export type PluginConfigScalar = string | number | boolean;
export type PluginConfigScalarArray = string[] | number[] | boolean[];
export type PluginConfigScalarObject = Record<string, PluginConfigScalar>;
export type PluginConfigObject = Record<string, PluginConfigScalar | PluginConfigScalarArray | PluginConfigScalarObject>;
export type PluginConfigArray = PluginConfigScalarArray | PluginConfigObject[];
export type PluginConfigValue = PluginConfigScalar | PluginConfigObject | PluginConfigArray;
export type PluginConfigFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export type PluginConfigStringFormat =
  | 'identifier'
  | 'slug'
  | 'semver'
  | 'url'
  | 'hostname'
  | 'email';
export interface PluginConfigPreset<Value extends PluginConfigValue = PluginConfigValue> {
  id: string;
  title: string;
  description?: string;
  value: Value;
  recommended?: true;
}
export interface PluginConfigChoices<Value extends PluginConfigValue = PluginConfigValue> {
  allowCustom: boolean;
  presets: PluginConfigPreset<Value>[];
}
export interface PluginConfigStringValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: PluginConfigStringFormat;
}
export interface PluginConfigNumberValidation {
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
}
export interface PluginConfigObjectValidation {
  minProperties?: number;
  maxProperties?: number;
  key?: PluginConfigStringValidation;
}
export interface PluginConfigArrayValidation {
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  uniqueBy?: string;
}
export interface PluginConfigValueReference {
  field: string;
  key: string;
  label?: string;
  include?: PluginConfigScalar[];
}
export interface PluginConfigFieldBase<Value extends PluginConfigValue> {
  title?: string;
  description?: string;
  default?: Value;
  required?: boolean;
  sensitive?: never;
}
interface PluginConfigPlainStringField extends Omit<PluginConfigFieldBase<string>, 'sensitive'> {
  type: 'string';
  const?: string;
  sensitive?: false;
  valueRef?: PluginConfigValueReference;
  choices?: PluginConfigChoices<string>;
  validation?: PluginConfigStringValidation;
}
interface PluginConfigSensitiveStringField extends Omit<PluginConfigFieldBase<string>, 'default' | 'sensitive'> {
  type: 'string';
  sensitive: true;
  default?: never;
  choices?: never;
  const?: never;
  validation?: PluginConfigStringValidation;
}
export type PluginConfigStringField =
  | PluginConfigPlainStringField
  | PluginConfigSensitiveStringField;
export interface PluginConfigNumberField extends PluginConfigFieldBase<number> {
  type: 'number';
  const?: number;
  valueRef?: PluginConfigValueReference;
  choices?: PluginConfigChoices<number>;
  validation?: PluginConfigNumberValidation;
}
export interface PluginConfigBooleanField extends PluginConfigFieldBase<boolean> {
  type: 'boolean';
  const?: boolean;
  valueRef?: PluginConfigValueReference;
  choices?: PluginConfigChoices<boolean>;
}
export type PluginConfigScalarField =
  | PluginConfigStringField
  | PluginConfigNumberField
  | PluginConfigBooleanField;
type DistributiveOmit<Value, Key extends PropertyKey> =
  Value extends unknown ? Omit<Value, Key> : never;
type PluginConfigNonSensitiveScalarField =
  | PluginConfigPlainStringField
  | PluginConfigNumberField
  | PluginConfigBooleanField;
export type PluginConfigScalarPropertyField = DistributiveOmit<
  PluginConfigNonSensitiveScalarField,
  'default' | 'sensitive'
> & { sensitive?: never };
export interface PluginConfigLeafArrayField extends Omit<PluginConfigFieldBase<PluginConfigScalarArray>, 'default'> {
  type: 'array';
  items: PluginConfigAdditionalPropertiesField;
  choices?: PluginConfigChoices<PluginConfigScalarArray>;
  validation?: Omit<PluginConfigArrayValidation, 'uniqueBy'>;
}
export interface PluginConfigLeafObjectField extends Omit<PluginConfigFieldBase<PluginConfigScalarObject>, 'default'> {
  type: 'object';
  properties?: never;
  additionalProperties: PluginConfigAdditionalPropertiesField;
  choices?: PluginConfigChoices<PluginConfigScalarObject>;
  validation?: PluginConfigObjectValidation;
}
export type PluginConfigObjectPropertyField =
  | PluginConfigScalarPropertyField
  | PluginConfigLeafArrayField
  | PluginConfigLeafObjectField;
export type PluginConfigAdditionalPropertiesField = DistributiveOmit<
  PluginConfigNonSensitiveScalarField,
  'default' | 'required' | 'sensitive'
> & { sensitive?: never };
interface PluginConfigObjectFieldBase extends PluginConfigFieldBase<PluginConfigObject> {
  type: 'object';
  choices?: PluginConfigChoices<PluginConfigObject>;
  validation?: PluginConfigObjectValidation;
}
export interface PluginConfigFixedObjectField extends PluginConfigObjectFieldBase {
  properties: Record<string, PluginConfigObjectPropertyField>;
  additionalProperties?: false;
  variants?: PluginConfigObjectVariants;
}
export interface PluginConfigObjectVariant {
  properties: Record<string, PluginConfigObjectPropertyField>;
}
export interface PluginConfigObjectVariants {
  discriminator: string;
  cases: Record<string, PluginConfigObjectVariant>;
  missing?: string;
  otherwise?: PluginConfigObjectVariant;
}
export interface PluginConfigKeyValueObjectField extends PluginConfigObjectFieldBase {
  default?: PluginConfigScalarObject;
  choices?: PluginConfigChoices<PluginConfigScalarObject>;
  properties?: never;
  variants?: never;
  additionalProperties: PluginConfigAdditionalPropertiesField;
}
export type PluginConfigObjectField =
  | PluginConfigFixedObjectField
  | PluginConfigKeyValueObjectField;
export type PluginConfigArrayItemField = DistributiveOmit<
  PluginConfigNonSensitiveScalarField | PluginConfigObjectField,
  'default' | 'required' | 'sensitive'
> & { default?: never; required?: never; sensitive?: never };
export interface PluginConfigArrayField extends PluginConfigFieldBase<PluginConfigArray> {
  type: 'array';
  items: PluginConfigArrayItemField;
  choices?: PluginConfigChoices<PluginConfigArray>;
  validation?: PluginConfigArrayValidation;
}
export type PluginConfigSchemaField = PluginConfigScalarField | PluginConfigObjectField | PluginConfigArrayField;
export interface PluginConfigPresentationGroup {
  id: string;
  title: string;
  description?: string;
  fields: string[];
  advanced?: boolean;
}
export interface PluginConfigJoinSummary {
  kind: 'join';
  parts: Array<{ path: string; format?: 'raw' | 'choiceTitle' }>;
  separator: string;
  missing: string;
}
export interface PluginConfigPresentation {
  summaries?: Record<string, PluginConfigJoinSummary>;
  fieldViews?: Record<string, { summary: string; itemSummary?: never } | { itemSummary: string; summary?: never }>;
  groups?: PluginConfigPresentationGroup[];
}
type PluginConfigLegacyScalarField = DistributiveOmit<PluginConfigScalarField, 'const'>;
type PluginConfigLegacyScalarPropertyField = DistributiveOmit<PluginConfigScalarPropertyField, 'const'>;
type PluginConfigLegacyAdditionalPropertiesField = DistributiveOmit<PluginConfigAdditionalPropertiesField, 'const'>;
type PluginConfigLegacyObjectField =
  | (Omit<PluginConfigFixedObjectField, 'properties' | 'variants' | 'default' | 'choices'> & {
      properties: Record<string, PluginConfigLegacyScalarPropertyField>;
      default?: PluginConfigScalarObject;
      choices?: PluginConfigChoices<PluginConfigScalarObject>;
    })
  | (Omit<PluginConfigKeyValueObjectField, 'additionalProperties'> & {
      additionalProperties: PluginConfigLegacyAdditionalPropertiesField;
    });
type PluginConfigLegacyArray = PluginConfigScalarArray | PluginConfigScalarObject[];
type PluginConfigLegacyArrayField = Omit<PluginConfigArrayField, 'default' | 'choices' | 'items'> & {
  default?: PluginConfigLegacyArray;
  choices?: PluginConfigChoices<PluginConfigLegacyArray>;
  items: DistributiveOmit<PluginConfigLegacyScalarField | PluginConfigLegacyObjectField, 'default' | 'required' | 'sensitive'> & {
    default?: never; required?: never; sensitive?: never;
  };
};
export type PluginConfigDefinition =
  | {
      schemaVersion?: never;
      fields: Record<string, PluginConfigLegacyScalarField | PluginConfigLegacyObjectField>;
      presentation?: Pick<PluginConfigPresentation, 'groups'>;
    }
  | {
      schemaVersion: 3;
      fields: Record<string, PluginConfigLegacyScalarField | PluginConfigLegacyObjectField | PluginConfigLegacyArrayField>;
      presentation?: PluginConfigPresentation;
    }
  | {
      schemaVersion: 4;
      fields: Record<string, PluginConfigSchemaField>;
      presentation?: PluginConfigPresentation;
    };
export type PluginConfigSchema = PluginConfigDefinition;
export interface PluginConfigValidationIssue {
  code: string;
  path: { field: string; property?: string; segments?: Array<string | number> };
  message: string;
  recoverable: true;
}

export interface PlatformAgentOverrides<T> { claude?: Partial<T> | null; codex?: Partial<T> | null }
export interface InstructionDefinition {
  name: string; title: string; content: string; paths?: string[];
  agentOverrides?: PlatformAgentOverrides<{ name: string; title: string; content: string; paths?: string[] }>;
}
export interface PermissionDefinition {
  name: string; allow?: PermissionCommand[]; ask?: PermissionCommand[]; deny?: PermissionCommand[];
  /** Present after resolving the Claude override; source declarations use agentOverrides.claude. */
  sandbox?: { excludedCommands: ManagedCommandPermission[] };
  agentOverrides?: {
    claude?: Partial<Omit<PermissionDefinition, 'agentOverrides'>> | null;
    codex?: Partial<Omit<PermissionDefinition, 'agentOverrides' | 'sandbox'>> | null;
  };
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
export interface CodexNativeSkillDelivery {
  mode: 'codex-native';
  identity: 'shared';
  renderProfile: 'user';
}
export interface AwExtensionSkillDelivery { mode: 'aw-extension' }
export type CodexSkillDelivery = CodexNativeSkillDelivery | AwExtensionSkillDelivery;
export type ArtifactTarget =
  | 'codex.developerInstructionsBlock'
  | 'codex.agentRole'
  | 'codex.skill'
  | 'claude.skill'
  | 'agent-skills.skill'
  | 'aw.command-set'
  | 'aw.command-package';
export type DynamicArtifactKind = 'instruction' | 'codexRole' | 'skill' | 'commandSet' | 'commandPackage';
export type ManagedArtifactId = string;
export interface ArtifactRuntimeImportDefinition extends BuildConfigImportReference {
  name: string;
  resolved?: {
    path: string;
    digest: string;
    providerPluginId: PluginId;
    providerVersion: PluginVersion;
    source: string;
    requiredCapabilities: string[];
    capabilitySetDigest: string;
  };
}
interface PluginArtifactTargetDefinitionBase {
  id: string;
  platform?: PlatformName;
  distribution?: DistributionName;
  scopes: Scope[];
  kind?: Exclude<DynamicArtifactKind, 'commandSet' | 'commandPackage'>;
  projectManagedKind?: CodexProjectManagedKind;
  states: ArtifactState[];
  refreshKeys: string[];
  requiresCodexProjectConfig?: boolean;
  roleKey?: string;
  skillKey?: string;
  sourceDirs?: string[];
  runtimeImports?: ArtifactRuntimeImportDefinition[];
  runtimeConfig?: import('./runtime-config.js').PluginRuntimeConfigDeclaration;
}
export type PluginArtifactTargetDefinition =
  | PluginArtifactTargetDefinitionBase & {
      target: 'codex.skill';
      delivery: CodexSkillDelivery;
    }
  | PluginArtifactTargetDefinitionBase & {
      target: Exclude<ArtifactTarget, 'codex.skill' | 'aw.command-set' | 'aw.command-package'>;
      delivery?: never;
    };
export interface PluginArtifactsConfig { targets?: PluginArtifactTargetDefinition[] }
export interface PluginAgentSkillsDistribution { skills?: string }
export interface PluginDistributionsConfig { agentSkills?: PluginAgentSkillsDistribution }
export interface PluginRequirements { aw: { capabilities?: string[] } }

export type PluginManifestSource = PluginManifestSourceV3;
export type NormalizedPluginManifest = Omit<
  PluginManifestSourceV3,
  'requires' | 'extensions' | 'artifacts' | 'buildConfig' | 'scripts' | 'config' | 'managedCommands'
> & {
  requires?: PluginRequirements;
  extensions?: PluginExtensions;
  artifacts?: PluginArtifactsConfig;
  buildConfig?: BuildConfig;
  scripts?: PluginScriptsConfig;
  config?: PluginConfigSchema;
  managedCommands?: ManagedCommands;
};
export interface PluginMeta {
  sourceId?: CatalogSourceId;
  sourceIdentity?: SourceIdentity;
  catalogLogicalIdentity?: string;
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
  dependencies: PluginId[]; requires: PluginRequirements;
  source: string; artifactDigest: string; manifestDigest: string;
}
export interface CatalogManifestV7Entry extends CatalogManifestEntry {
  name: PluginId;
  contentDigest: string;
}
export interface CatalogMarketplaceIdentity {
  owner: MarketplaceOwner;
  interface: MarketplaceInterfaceMeta;
}
export type CatalogManifestV7Release =
  | { state: 'development' }
  | {
      state: 'published';
      sourceHead: string;
    };
export interface CatalogManifestV7 {
  schemaVersion: 7;
  catalogVersion: string;
  channel: CatalogChannel;
  requires: PluginRequirements;
  marketplace: CatalogMarketplaceIdentity;
  release: CatalogManifestV7Release;
  entries: CatalogManifestV7Entry[];
}
export interface PlatformPluginManifest {
  name: string; version: PluginVersion; description: string;
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
