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
export type Capabilities = string[]
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configField".
 */
export type ConfigField = (ConfigStringField | ConfigNumberField | ConfigBooleanField | ConfigObjectField) | undefined
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalar".
 */
export type ConfigScalar = (string | number | boolean) | undefined
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarChildField".
 */
export type ConfigScalarChildField = (ConfigStringChildField | ConfigNumberChildField | ConfigBooleanChildField) | undefined
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarDynamicField".
 */
export type ConfigScalarDynamicField = (ConfigStringDynamicField | ConfigNumberDynamicField | ConfigBooleanDynamicField)
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configScalarField".
 */
export type ConfigScalarField = (ConfigStringField | ConfigNumberField | ConfigBooleanField)

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
[k: string]: unknown | undefined
} | null)
codex?: ({
[k: string]: unknown | undefined
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
 * via the `definition` "artifactTarget".
 */
export interface ArtifactTarget {
id: string
platform?: ("codex" | "claude")
distribution?: "agent-skills"
scopes: ("user" | "project")[]
target: ("codex.developerInstructionsBlock" | "codex.agentRole" | "codex.skill" | "claude.skill" | "agent-skills.skill")
kind?: ("instruction" | "codexRole" | "skill")
projectManagedKind?: ("skill" | "mcpServer" | "instruction" | "permission" | "hook" | "agent")
states: ("present" | "disabled")[]
refreshKeys: StringArray
requiresCodexProjectConfig?: boolean
roleKey?: string
skillKey?: string
sourceDirs?: StringArray
runtimeImports?: {
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
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "buildConfig".
 */
export interface BuildConfig {
cacheable?: true
templates?: {
vars: {
[k: string]: PlatformTemplateValue | undefined
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
[k: string]: unknown | undefined
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
postApply?: PostApply
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
 * via the `definition` "postApply".
 */
export interface PostApply {
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
 * via the `definition` "config".
 */
export interface Config {
fields: {
[k: string]: ConfigField | undefined
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
 * via the `definition` "configStringField".
 */
export interface ConfigStringField {
type: "string"
title?: string
description?: string
default?: string
required?: boolean
sensitive?: boolean
choices?: ConfigStringChoices
validation?: ConfigStringValidation
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
format?: ("identifier" | "slug" | "semver" | "url" | "hostname" | "email" | "path" | "file" | "directory")
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberField".
 */
export interface ConfigNumberField {
type: "number"
title?: string
description?: string
default?: number
required?: boolean
sensitive?: boolean
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
type: "boolean"
title?: string
description?: string
default?: boolean
required?: boolean
sensitive?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configObjectField".
 */
export interface ConfigObjectField {
type: "object"
title?: string
description?: string
default?: {
[k: string]: ConfigScalar | undefined
}
required?: boolean
sensitive?: boolean
choices?: ConfigObjectChoices
properties?: {
[k: string]: ConfigScalarChildField | undefined
}
additionalProperties?: (false | ConfigScalarDynamicField)
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
[k: string]: ConfigScalar | undefined
}
recommended?: true
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringChildField".
 */
export interface ConfigStringChildField {
type: "string"
title?: string
description?: string
required?: boolean
sensitive?: boolean
choices?: ConfigStringChoices
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberChildField".
 */
export interface ConfigNumberChildField {
type: "number"
title?: string
description?: string
required?: boolean
sensitive?: boolean
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configBooleanChildField".
 */
export interface ConfigBooleanChildField {
type: "boolean"
title?: string
description?: string
required?: boolean
sensitive?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configStringDynamicField".
 */
export interface ConfigStringDynamicField {
type: "string"
title?: string
description?: string
sensitive?: boolean
choices?: ConfigStringChoices
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configNumberDynamicField".
 */
export interface ConfigNumberDynamicField {
type: "number"
title?: string
description?: string
sensitive?: boolean
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV3`'s JSON-Schema
 * via the `definition` "configBooleanDynamicField".
 */
export interface ConfigBooleanDynamicField {
type: "boolean"
title?: string
description?: string
sensitive?: boolean
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
