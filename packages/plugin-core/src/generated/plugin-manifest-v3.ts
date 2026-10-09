/* This file is generated. Run `pnpm generate` in packages/plugin-core to update it. */

/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "pluginPath".
 */
export type PluginPath = string
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "stringArray".
 */
export type StringArray = string[]
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "artifactTarget".
 */
export type ArtifactTarget = ({
id: string
platform?: ("codex" | "claude")
distribution?: "agent-skills"
scopes: ("user" | "project")[]
target: "codex.skill"
kind?: ("instruction" | "codexRole" | "skill")
projectManagedKind?: ("skill" | "mcpServer" | "instruction" | "permission" | "hook" | "agent")
states: ("present" | "disabled")[]
refreshKeys: StringArray
requiresCodexProjectConfig?: boolean
delivery: CodexSkillDelivery
roleKey?: string
skillKey?: string
sourceDirs?: StringArray
runtimeImports?: ArtifactRuntimeImports
runtimeConfig?: RuntimeConfig
} | {
id: string
platform?: ("codex" | "claude")
distribution?: "agent-skills"
scopes: ("user" | "project")[]
target: ("codex.developerInstructionsBlock" | "codex.agentRole" | "claude.skill" | "agent-skills.skill")
kind?: ("instruction" | "codexRole" | "skill")
projectManagedKind?: ("skill" | "mcpServer" | "instruction" | "permission" | "hook" | "agent")
states: ("present" | "disabled")[]
refreshKeys: StringArray
requiresCodexProjectConfig?: boolean
roleKey?: string
skillKey?: string
sourceDirs?: StringArray
runtimeImports?: ArtifactRuntimeImports
runtimeConfig?: RuntimeConfig
})
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "codexSkillDelivery".
 */
export type CodexSkillDelivery = ({
mode: "codex-native"
identity: "shared"
renderProfile: "user"
} | {
mode: "aw-extension"
})
export type Capabilities = string[]
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "artifactRuntimeImports".
 */
export type ArtifactRuntimeImports = {
name: string
plugin: string
export: string
resolved?: {
path: string
digest: string
providerPluginId: string
providerVersion: Semver
source: string
requiredCapabilities: Capabilities
capabilitySetDigest: string
}
}[]
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "config".
 */
export type Config = (ConfigV2 | ConfigV3 | ConfigV4)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configField".
 */
export type ConfigField = (ConfigStringField | ConfigNumberField | ConfigBooleanField | ConfigObjectField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringField".
 */
export type ConfigStringField = (ConfigPlainStringField | ConfigSensitiveStringField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalar".
 */
export type ConfigScalar = (string | number | boolean)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configObjectField".
 */
export type ConfigObjectField = (ConfigFixedObjectField | ConfigKeyValueObjectField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarChildField".
 */
export type ConfigScalarChildField = (ConfigStringChildField | ConfigNumberChildField | ConfigBooleanChildField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarDynamicField".
 */
export type ConfigScalarDynamicField = (ConfigStringDynamicField | ConfigNumberDynamicField | ConfigBooleanDynamicField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV3Field".
 */
export type ConfigV3Field = (ConfigScalarField | ConfigV3FixedObjectField | ConfigV3KeyValueObjectField | ConfigArrayField | ConfigReference)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarField".
 */
export type ConfigScalarField = (ConfigStringField | ConfigNumberField | ConfigBooleanField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayValue".
 */
export type ConfigArrayValue = (string[] | number[] | boolean[] | ConfigArrayObjectValue[])
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayItem".
 */
export type ConfigArrayItem = (ConfigScalarDynamicField | ConfigArrayFixedObjectItem | ConfigArrayKeyValueObjectItem | ConfigArrayItemReference)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4Field".
 */
export type ConfigV4Field = (ConfigV4ScalarField | ConfigV4FixedObjectField | ConfigV4KeyValueObjectField | ConfigV4ArrayField | ConfigV4Reference)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ScalarField".
 */
export type ConfigV4ScalarField = (ConfigV4StringField | ConfigV4NumberField | ConfigV4BooleanField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4StringField".
 */
export type ConfigV4StringField = (ConfigV4PlainStringField | ConfigSensitiveStringField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarArrayValue".
 */
export type ConfigScalarArrayValue = (string[] | number[] | boolean[])
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4PropertyField".
 */
export type ConfigV4PropertyField = (ConfigV4ScalarChildField | ConfigV4LeafArrayField | ConfigV4LeafObjectField | ConfigChildReference)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ScalarChildField".
 */
export type ConfigV4ScalarChildField = (ConfigV4StringChildField | ConfigV4NumberChildField | ConfigV4BooleanChildField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ScalarDynamicField".
 */
export type ConfigV4ScalarDynamicField = (ConfigV4StringDynamicField | ConfigV4NumberDynamicField | ConfigV4BooleanDynamicField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ArrayValue".
 */
export type ConfigV4ArrayValue = (string[] | number[] | boolean[] | ConfigV4ObjectValue[])
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ArrayItem".
 */
export type ConfigV4ArrayItem = (ConfigV4ScalarDynamicField | ConfigV4ArrayFixedObjectItem | ConfigV4ArrayKeyValueObjectItem | ConfigArrayItemReference)

export interface PluginManifestSourceV3 {
schemaVersion: 3
name: string
version: Semver
description: string
/**
 * @maxItems 64
 */
dependencies?: string[]
requires?: Requires
skills?: PluginPath
slashCommands?: PluginPath
mcpServers?: PluginPath
apps?: PluginPath
distributions?: Distributions
marketplace: Marketplace
interface?: Interface
extensions?: Extensions
artifacts?: Artifacts
buildConfig?: BuildConfig
scripts?: Scripts
config?: Config
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "requires".
 */
export interface Requires {
aw: {
capabilities?: string[]
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "distributions".
 */
export interface Distributions {
agentSkills?: {
skills?: PluginPath
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "marketplace".
 */
export interface Marketplace {
category: string
tags?: string[]
strict: boolean
policy: {
installation: ("AVAILABLE" | "NOT_AVAILABLE" | "INSTALLED_BY_DEFAULT")
authentication: ("ON_INSTALL" | "ON_USE")
products?: string[]
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "interface".
 */
export interface Interface {
displayName?: string
shortDescription?: string
capabilities?: string[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "extensions".
 */
export interface Extensions {
instructions?: Instruction[]
permissions?: Permission[]
hooks?: Hook[]
nativeHooks?: {
claude?: NativeHook[]
codex?: NativeHook[]
}
agents?: Agent[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "instruction".
 */
export interface Instruction {
name: string
title: string
content: string
paths?: StringArray
agentOverrides?: PlatformOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "platformOverrides".
 */
export interface PlatformOverrides {
claude?: ({
[k: string]: unknown
} | null)
codex?: ({
[k: string]: unknown
} | null)
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "permission".
 */
export interface Permission {
name: string
allow?: StringArray
ask?: StringArray
deny?: StringArray
agentOverrides?: PlatformOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "hook".
 */
export interface Hook {
event: string
matcher?: string
command: string
agentOverrides?: PlatformOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "nativeHook".
 */
export interface NativeHook {
event: string
matcher?: string
command: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "agent".
 */
export interface Agent {
name: string
description: string
prompt: string
tools?: StringArray
agentOverrides?: PlatformOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "artifacts".
 */
export interface Artifacts {
targets?: ArtifactTarget[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "runtimeConfig".
 */
export interface RuntimeConfig {
/**
 * @minItems 1
 */
keys: [string, ...(string)[]]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "buildConfig".
 */
export interface BuildConfig {
cacheable?: true
templates?: {
vars: {
[k: string]: PlatformTemplateValue
}
include: StringArray
}
fileRules?: {
claude?: FileRules
codex?: FileRules
}
manifestOverrides?: {
claude?: {
commands?: string
outputStyles?: string
lspServers?: unknown
userConfig?: unknown
channels?: unknown
}
codex?: {
[k: string]: unknown
}
}
runtimeExports?: {
name: string
source: string
requires: RuntimeExportRequires
}[]
buildImports?: {
plugin: string
export: string
env: string
}[]
skillRuntimeFiles?: {
skill: string
target: string
platforms?: ("codex" | "claude")[]
distributions?: ("agent-skills")[]
source?: string
import?: ImportReference
}[]
generatedSkillRuntimeFiles?: {
skill: string
target: string
distributions?: ("agent-skills")[]
}[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "platformTemplateValue".
 */
export interface PlatformTemplateValue {
claude: (string | boolean)
codex: (string | boolean)
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "fileRules".
 */
export interface FileRules {
include: StringArray
exclude: StringArray
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "runtimeExportRequires".
 */
export interface RuntimeExportRequires {
aw: {
capabilities: Capabilities
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "importReference".
 */
export interface ImportReference {
plugin: string
export: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "scripts".
 */
export interface Scripts {
preApply?: PreApply
helpers?: {
config: string
}
node?: {
packageRoot?: string
build?: ScriptEntry
}
artifacts?: {
render?: ScriptEntry
}
tests?: {
node?: StringArray
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "preApply".
 */
export interface PreApply {
path: PluginPath
timeoutMs?: number
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "scriptEntry".
 */
export interface ScriptEntry {
runner: "node"
path: string
args?: StringArray
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV2".
 */
export interface ConfigV2 {
fields: {
[k: string]: ConfigField
}
presentation?: {
groups?: {
id: string
title: string
description?: string
fields: StringArray
advanced?: boolean
}[]
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configPlainStringField".
 */
export interface ConfigPlainStringField {
valueRef?: ConfigValueReference
type: "string"
title?: string
description?: string
default?: string
required?: boolean
sensitive?: false
choices?: ConfigStringChoices
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configValueReference".
 */
export interface ConfigValueReference {
field: string
key: string
label?: string
/**
 * @maxItems 128
 */
include?: ConfigScalar[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringChoices".
 */
export interface ConfigStringChoices {
allowCustom: boolean
presets: ConfigStringPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringPreset".
 */
export interface ConfigStringPreset {
id: string
title: string
description?: string
value: string
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringValidation".
 */
export interface ConfigStringValidation {
minLength?: number
maxLength?: number
pattern?: string
format?: ("identifier" | "slug" | "semver" | "url" | "hostname" | "email")
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configSensitiveStringField".
 */
export interface ConfigSensitiveStringField {
type: "string"
title?: string
description?: string
required?: boolean
sensitive: true
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberField".
 */
export interface ConfigNumberField {
valueRef?: ConfigValueReference
type: "number"
title?: string
description?: string
default?: number
required?: boolean
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberChoices".
 */
export interface ConfigNumberChoices {
allowCustom: boolean
presets: ConfigNumberPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberPreset".
 */
export interface ConfigNumberPreset {
id: string
title: string
description?: string
value: number
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberValidation".
 */
export interface ConfigNumberValidation {
integer?: boolean
minimum?: number
maximum?: number
multipleOf?: number
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configBooleanField".
 */
export interface ConfigBooleanField {
valueRef?: ConfigValueReference
type: "boolean"
title?: string
description?: string
default?: boolean
required?: boolean
sensitive?: never
choices?: ConfigBooleanChoices
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configBooleanChoices".
 */
export interface ConfigBooleanChoices {
allowCustom: boolean
presets: ConfigBooleanPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configBooleanPreset".
 */
export interface ConfigBooleanPreset {
id: string
title: string
description?: string
value: boolean
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configFixedObjectField".
 */
export interface ConfigFixedObjectField {
type: "object"
title?: string
description?: string
default?: {
[k: string]: ConfigScalar
}
required?: boolean
sensitive?: never
choices?: ConfigObjectChoices
properties: {
[k: string]: ConfigScalarChildField
}
additionalProperties?: false
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configObjectChoices".
 */
export interface ConfigObjectChoices {
allowCustom: boolean
presets: ConfigObjectPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configObjectPreset".
 */
export interface ConfigObjectPreset {
id: string
title: string
description?: string
value: {
[k: string]: ConfigScalar
}
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringChildField".
 */
export interface ConfigStringChildField {
valueRef?: ConfigValueReference
type: "string"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigStringChoices
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberChildField".
 */
export interface ConfigNumberChildField {
valueRef?: ConfigValueReference
type: "number"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configBooleanChildField".
 */
export interface ConfigBooleanChildField {
valueRef?: ConfigValueReference
type: "boolean"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigBooleanChoices
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configObjectValidation".
 */
export interface ConfigObjectValidation {
minProperties?: number
maxProperties?: number
key?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configKeyValueObjectField".
 */
export interface ConfigKeyValueObjectField {
type: "object"
title?: string
description?: string
default?: {
[k: string]: ConfigScalar
}
required?: boolean
sensitive?: never
choices?: ConfigObjectChoices
additionalProperties: ConfigScalarDynamicField
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringDynamicField".
 */
export interface ConfigStringDynamicField {
valueRef?: ConfigValueReference
type: "string"
title?: string
description?: string
sensitive?: never
choices?: ConfigStringChoices
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberDynamicField".
 */
export interface ConfigNumberDynamicField {
valueRef?: ConfigValueReference
type: "number"
title?: string
description?: string
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configBooleanDynamicField".
 */
export interface ConfigBooleanDynamicField {
valueRef?: ConfigValueReference
type: "boolean"
title?: string
description?: string
sensitive?: never
choices?: ConfigBooleanChoices
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV3".
 */
export interface ConfigV3 {
fields: {
[k: string]: ConfigV3Field
}
presentation?: {
groups?: {
id: string
title: string
description?: string
fields: StringArray
advanced?: boolean
}[]
summaries?: {
[k: string]: ConfigJoinSummary
}
fieldViews?: {
[k: string]: ({
summary: string
} | {
itemSummary: string
})
}
}
schemaVersion: 3
definitions?: {
[k: string]: ConfigV3Field
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV3FixedObjectField".
 */
export interface ConfigV3FixedObjectField {
type: "object"
title?: string
description?: string
default?: {
[k: string]: ConfigScalar
}
required?: boolean
sensitive?: never
choices?: ConfigObjectChoices
properties: {
[k: string]: (ConfigScalarChildField | ConfigChildReference)
}
additionalProperties?: false
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configChildReference".
 */
export interface ConfigChildReference {
$ref: string
title?: string
description?: string
required?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV3KeyValueObjectField".
 */
export interface ConfigV3KeyValueObjectField {
type: "object"
title?: string
description?: string
default?: {
[k: string]: ConfigScalar
}
required?: boolean
sensitive?: never
choices?: ConfigObjectChoices
additionalProperties: (ConfigScalarDynamicField | ConfigDynamicReference)
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configDynamicReference".
 */
export interface ConfigDynamicReference {
$ref: string
title?: string
description?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayField".
 */
export interface ConfigArrayField {
type: "array"
title?: string
description?: string
default?: ConfigArrayValue
required?: boolean
sensitive?: never
items: ConfigArrayItem
choices?: ConfigArrayChoices
validation?: ConfigArrayValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayObjectValue".
 */
export interface ConfigArrayObjectValue {
[k: string]: ConfigScalar
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayFixedObjectItem".
 */
export interface ConfigArrayFixedObjectItem {
type: "object"
title?: string
description?: string
sensitive?: never
choices?: ConfigObjectChoices
properties: {
[k: string]: (ConfigScalarChildField | ConfigChildReference)
}
additionalProperties?: false
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayKeyValueObjectItem".
 */
export interface ConfigArrayKeyValueObjectItem {
type: "object"
title?: string
description?: string
sensitive?: never
choices?: ConfigObjectChoices
additionalProperties: (ConfigScalarDynamicField | ConfigDynamicReference)
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayItemReference".
 */
export interface ConfigArrayItemReference {
$ref: string
title?: string
description?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayChoices".
 */
export interface ConfigArrayChoices {
allowCustom: boolean
presets: ConfigArrayPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayPreset".
 */
export interface ConfigArrayPreset {
id: string
title: string
description?: string
value: ConfigArrayValue
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configArrayValidation".
 */
export interface ConfigArrayValidation {
minItems?: number
maxItems?: number
uniqueItems?: boolean
uniqueBy?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configReference".
 */
export interface ConfigReference {
$ref: string
title?: string
description?: string
default?: (ConfigScalar | ConfigArrayValue | {
[k: string]: ConfigScalar
})
required?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configJoinSummary".
 */
export interface ConfigJoinSummary {
kind: "join"
parts: {
path: string
format?: ("raw" | "choiceTitle")
}[]
separator: string
missing: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4".
 */
export interface ConfigV4 {
fields: {
[k: string]: ConfigV4Field
}
presentation?: {
groups?: {
id: string
title: string
description?: string
fields: StringArray
advanced?: boolean
}[]
summaries?: {
[k: string]: ConfigJoinSummary
}
fieldViews?: {
[k: string]: ({
summary: string
} | {
itemSummary: string
})
}
}
schemaVersion: 4
definitions?: {
[k: string]: ConfigV4Field
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4PlainStringField".
 */
export interface ConfigV4PlainStringField {
valueRef?: ConfigValueReference
type: "string"
title?: string
description?: string
default?: string
required?: boolean
sensitive?: false
choices?: ConfigStringChoices
validation?: ConfigStringValidation
const?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4NumberField".
 */
export interface ConfigV4NumberField {
valueRef?: ConfigValueReference
type: "number"
title?: string
description?: string
default?: number
required?: boolean
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
const?: number
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4BooleanField".
 */
export interface ConfigV4BooleanField {
valueRef?: ConfigValueReference
type: "boolean"
title?: string
description?: string
default?: boolean
required?: boolean
sensitive?: never
choices?: ConfigBooleanChoices
const?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4FixedObjectField".
 */
export interface ConfigV4FixedObjectField {
type: "object"
title?: string
description?: string
default?: ConfigV4ObjectValue
required?: boolean
sensitive?: never
choices?: ConfigV4ObjectChoices
properties: {
[k: string]: ConfigV4PropertyField
}
additionalProperties?: false
validation?: ConfigObjectValidation
variants?: ConfigV4ObjectVariants
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ObjectValue".
 */
export interface ConfigV4ObjectValue {
[k: string]: (ConfigScalar | ConfigScalarArrayValue | ConfigArrayObjectValue)
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ObjectChoices".
 */
export interface ConfigV4ObjectChoices {
allowCustom: boolean
presets: ConfigV4ObjectPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ObjectPreset".
 */
export interface ConfigV4ObjectPreset {
id: string
title: string
description?: string
value: ConfigV4ObjectValue
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4StringChildField".
 */
export interface ConfigV4StringChildField {
valueRef?: ConfigValueReference
type: "string"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigStringChoices
validation?: ConfigStringValidation
const?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4NumberChildField".
 */
export interface ConfigV4NumberChildField {
valueRef?: ConfigValueReference
type: "number"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
const?: number
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4BooleanChildField".
 */
export interface ConfigV4BooleanChildField {
valueRef?: ConfigValueReference
type: "boolean"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigBooleanChoices
const?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4LeafArrayField".
 */
export interface ConfigV4LeafArrayField {
type: "array"
title?: string
description?: string
required?: boolean
sensitive?: never
items: (ConfigV4ScalarDynamicField | ConfigDynamicReference)
choices?: ConfigScalarArrayChoices
validation?: {
minItems?: number
maxItems?: number
uniqueItems?: boolean
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4StringDynamicField".
 */
export interface ConfigV4StringDynamicField {
valueRef?: ConfigValueReference
type: "string"
title?: string
description?: string
sensitive?: never
choices?: ConfigStringChoices
validation?: ConfigStringValidation
const?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4NumberDynamicField".
 */
export interface ConfigV4NumberDynamicField {
valueRef?: ConfigValueReference
type: "number"
title?: string
description?: string
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
const?: number
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4BooleanDynamicField".
 */
export interface ConfigV4BooleanDynamicField {
valueRef?: ConfigValueReference
type: "boolean"
title?: string
description?: string
sensitive?: never
choices?: ConfigBooleanChoices
const?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarArrayChoices".
 */
export interface ConfigScalarArrayChoices {
allowCustom: boolean
presets: ConfigScalarArrayPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarArrayPreset".
 */
export interface ConfigScalarArrayPreset {
id: string
title: string
description?: string
value: ConfigScalarArrayValue
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4LeafObjectField".
 */
export interface ConfigV4LeafObjectField {
type: "object"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigObjectChoices
additionalProperties: (ConfigV4ScalarDynamicField | ConfigDynamicReference)
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ObjectVariants".
 */
export interface ConfigV4ObjectVariants {
discriminator: string
cases: {
[k: string]: ConfigV4ObjectVariant
}
missing?: string
otherwise?: ConfigV4ObjectVariant
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ObjectVariant".
 */
export interface ConfigV4ObjectVariant {
properties: {
[k: string]: ConfigV4PropertyField
}
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4KeyValueObjectField".
 */
export interface ConfigV4KeyValueObjectField {
type: "object"
title?: string
description?: string
default?: {
[k: string]: ConfigScalar
}
required?: boolean
sensitive?: never
choices?: ConfigObjectChoices
additionalProperties: (ConfigV4ScalarDynamicField | ConfigDynamicReference)
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ArrayField".
 */
export interface ConfigV4ArrayField {
type: "array"
title?: string
description?: string
default?: ConfigV4ArrayValue
required?: boolean
sensitive?: never
items: ConfigV4ArrayItem
choices?: ConfigV4ArrayChoices
validation?: ConfigArrayValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ArrayFixedObjectItem".
 */
export interface ConfigV4ArrayFixedObjectItem {
type: "object"
title?: string
description?: string
sensitive?: never
choices?: ConfigV4ObjectChoices
properties: {
[k: string]: ConfigV4PropertyField
}
additionalProperties?: false
validation?: ConfigObjectValidation
variants?: ConfigV4ObjectVariants
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ArrayKeyValueObjectItem".
 */
export interface ConfigV4ArrayKeyValueObjectItem {
type: "object"
title?: string
description?: string
sensitive?: never
choices?: ConfigObjectChoices
additionalProperties: (ConfigV4ScalarDynamicField | ConfigDynamicReference)
validation?: ConfigObjectValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ArrayChoices".
 */
export interface ConfigV4ArrayChoices {
allowCustom: boolean
presets: ConfigV4ArrayPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4ArrayPreset".
 */
export interface ConfigV4ArrayPreset {
id: string
title: string
description?: string
value: ConfigV4ArrayValue
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configV4Reference".
 */
export interface ConfigV4Reference {
$ref: string
title?: string
description?: string
default?: (ConfigScalar | ConfigV4ArrayValue | ConfigV4ObjectValue)
required?: boolean
}
