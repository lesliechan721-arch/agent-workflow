/* This file is generated. Run `pnpm generate` in packages/plugin-core to update it. */

/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "pluginPath".
 */
export type PluginPath = string
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "stringArray".
 */
export type StringArray = string[]
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "lifecycleDefinition".
 */
export type LifecycleDefinition = (string | {
default?: ScriptEntry
unix?: ScriptEntry
windows?: ScriptEntry
linux?: ScriptEntry
darwin?: ScriptEntry
win32?: ScriptEntry
})

export interface PluginManifestSourceV1 {
schemaVersion?: 1
name: string
version: Semver
description: string
/**
 * @maxItems 64
 */
dependencies?: string[]
compatibility?: Compatibility
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
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "compatibility".
 */
export interface Compatibility {
aw: {
minVersion: Semver
}
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "distributions".
 */
export interface Distributions {
agentSkills?: {
skills?: PluginPath
}
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "marketplace".
 */
export interface Marketplace {
category: string
tags?: string[]
strict: boolean
policy: {
installation: "AVAILABLE"
authentication: ("ON_INSTALL" | "ON_USE")
products?: string[]
}
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "interface".
 */
export interface Interface {
displayName?: string
shortDescription?: string
capabilities?: string[]
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "hook".
 */
export interface Hook {
event: string
matcher?: string
command: string
agentOverrides?: PlatformOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "nativeHook".
 */
export interface NativeHook {
event: string
matcher?: string
command: string
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "artifacts".
 */
export interface Artifacts {
targets?: ArtifactTarget[]
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
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
}
}[]
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
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
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "platformTemplateValue".
 */
export interface PlatformTemplateValue {
claude: (string | boolean)
codex: (string | boolean)
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "fileRules".
 */
export interface FileRules {
include: StringArray
exclude: StringArray
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "importReference".
 */
export interface ImportReference {
plugin: string
export: string
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "scripts".
 */
export interface Scripts {
timeoutMs?: number
lifecycle?: {
install?: LifecycleDefinition
upgrade?: LifecycleDefinition
uninstall?: LifecycleDefinition
}
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
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "scriptEntry".
 */
export interface ScriptEntry {
runner: ("node" | "sh" | "bash" | "pwsh" | "powershell" | "cmd" | "auto")
path: string
args?: StringArray
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "config".
 */
export interface Config {
schema: {
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
fields?: {
[k: string]: {
valueLabels?: {
[k: string]: string | undefined
}
recommendedValue?: (string | number | boolean)
placeholder?: string
unit?: string
advanced?: boolean
} | undefined
}
presets?: {
id: string
title: string
description?: string
values: {
[k: string]: (string | number | boolean) | undefined
}
}[]
}
}
/**
 * This interface was referenced by `PluginManifestSourceV1`'s JSON-Schema
 * via the `definition` "configField".
 */
export interface ConfigField {
type: ("string" | "number" | "boolean" | "enum" | "file" | "directory")
title?: string
description?: string
default?: (string | number | boolean)
required?: boolean
sensitive?: boolean
values?: StringArray
min?: number
max?: number
}
