/* This file is generated. Run `pnpm generate` in packages/plugin-core to update it. */

/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "pluginPath".
 */
export type PluginPath = string
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "stringArray".
 */
export type StringArray = string[]
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "commandName".
 */
export type CommandName = string
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "permissionCommands".
 */
export type PermissionCommands = (string | ManagedCommandPermission)[]
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "featureRequirement".
 */
export type FeatureRequirement = ({
feature: "component.kind.instruction"
} | {
feature: "component.kind.hook"
} | {
feature: "component.kind.agent"
} | {
feature: "component.kind.mcp"
} | {
feature: "component.kind.skill"
} | {
feature: "skill.invocation.manual"
values?: ("true" | "false")[]
} | {
feature: "skill.invocation.model"
values?: ("true" | "false")[]
} | {
feature: "skill.visibility"
values?: ("visible" | "hidden")[]
} | {
feature: "skill.runtime-config"
values?: ("aw.installed-runtime-config.v2")[]
} | {
feature: "mcp.transport"
values?: ("stdio" | "http" | "sse")[]
} | {
feature: "agent.execution"
values?: ("isolated-context")[]
} | {
feature: "agent.model"
} | {
feature: "agent.tools"
values?: ("allowlist" | "none")[]
} | {
feature: "agent.prompt-mode"
values?: ("host-default" | "append" | "replace")[]
} | {
feature: "agent.declaration-protocol"
values?: ("aw.pi.agents.v1")[]
} | {
feature: "instruction.coverage"
values?: ("main" | "plugin-agents" | "other-agents")[]
} | {
feature: "instruction.paths"
} | {
feature: "instruction.after-compaction"
} | {
feature: "hook.matcher"
values: ("common.after_tool" | "common.before_tool" | "common.session_start" | "native.AfterAgent" | "native.AfterTool" | "native.BeforeAgent" | "native.BeforeTool" | "native.ConfigChange" | "native.CwdChanged" | "native.Elicitation" | "native.ElicitationResult" | "native.FileChanged" | "native.InstructionsLoaded" | "native.Notification" | "native.PermissionDenied" | "native.PermissionRequest" | "native.PostCompact" | "native.PostInvocation" | "native.PostToolUse" | "native.PostToolUseFailure" | "native.PreCompact" | "native.PreInvocation" | "native.PreToolUse" | "native.SessionEnd" | "native.SessionStart" | "native.Setup" | "native.Stop" | "native.StopFailure" | "native.SubagentStart" | "native.SubagentStop" | "native.TaskCompleted" | "native.TaskCreated" | "native.TeammateIdle" | "native.UserPromptSubmit" | "native.WorktreeCreate" | "native.WorktreeRemove" | "native.after" | "native.afterFileEdit" | "native.afterMCPExecution" | "native.afterShellExecution" | "native.before" | "native.beforeMCPExecution" | "native.beforeReadFile" | "native.beforeShellExecution" | "native.beforeSubmitPrompt" | "native.before_agent_start" | "native.errorOccurred" | "native.postToolUse" | "native.preToolUse" | "native.sessionEnd" | "native.sessionStart" | "native.session_start" | "native.stop" | "native.subagentStart" | "native.subagentStop" | "native.tool_call" | "native.tool_result" | "native.userPromptSubmitted" | "native.workspaceOpen")[]
} | {
feature: "hook.common.before_tool"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.common.after_tool"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.common.session_start"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.AfterAgent"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.AfterTool"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.BeforeAgent"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.BeforeTool"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.ConfigChange"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.CwdChanged"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.Elicitation"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.ElicitationResult"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.FileChanged"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.InstructionsLoaded"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.Notification"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PermissionDenied"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PermissionRequest"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PostCompact"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PostToolUse"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PostToolUseFailure"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PreCompact"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PreToolUse"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.SessionEnd"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.SessionStart"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.Setup"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.Stop"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.StopFailure"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.SubagentStart"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.SubagentStop"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.TaskCompleted"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.TaskCreated"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.TeammateIdle"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.UserPromptSubmit"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.WorktreeCreate"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.WorktreeRemove"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.afterFileEdit"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.afterMCPExecution"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.afterShellExecution"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.beforeMCPExecution"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.beforeReadFile"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.beforeShellExecution"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.beforeSubmitPrompt"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.before_agent_start"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.errorOccurred"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.postToolUse"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.preToolUse"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.sessionEnd"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.sessionStart"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.session_start"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.stop"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.subagentStart"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.subagentStop"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.tool_result"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.userPromptSubmitted"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.workspaceOpen"
values?: ("notify" | "context" | "block")[]
} | {
feature: "skill.tools"
values?: ("allowlist" | "denylist" | "none")[]
} | {
feature: "skill.model"
} | {
feature: "skill.effort"
values?: ("low" | "medium" | "high" | "xhigh" | "max")[]
} | {
feature: "skill.execution"
values?: ("isolated-context")[]
} | {
feature: "skill.agent"
} | {
feature: "skill.background"
values?: ("true" | "false")[]
} | {
feature: "skill.hooks"
} | {
feature: "skill.paths"
} | {
feature: "skill.shell"
values?: ("bash" | "powershell")[]
} | {
feature: "skill.invocation.hint"
} | {
feature: "skill.arguments"
} | {
feature: "hook.native.PostInvocation"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.PreInvocation"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.tool_call"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.after"
values?: ("notify" | "context" | "block")[]
} | {
feature: "hook.native.before"
values?: ("notify" | "context" | "block")[]
})
export type Capabilities = string[]
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "managedCommandSet".
 */
export type ManagedCommandSet = ({
set: CommandName
producer: ManagedCommandProducer
mode: "static"
entries: CommandDefinition[]
} | {
set: CommandName
producer: ManagedCommandProducer
mode: "dynamic"
refreshKeys: string[]
})
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "managedCommandProducer".
 */
export type ManagedCommandProducer = ({
kind: "artifact"
artifactId: string
platform: ("codex" | "claude" | "antigravity" | "cursor" | "opencode" | "pi" | "gemini" | "copilot" | "grok")
} | {
kind: "static-skill"
platform: ("codex" | "claude" | "antigravity" | "cursor" | "opencode" | "pi" | "gemini" | "copilot" | "grok")
skillKey: string
} | {
kind: "package"
packageKey: CommandName
})
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "commandRelativeFile".
 */
export type CommandRelativeFile = string
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "nativeToolBinding".
 */
export type NativeToolBinding = ({
key: CommandName
platforms: ("win32")[]
policy: "required"
} | {
key: CommandName
platforms: ("win32")[]
policy: "preferred"
fallback: CommandName
})
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "config".
 */
export type Config = (ConfigV2 | ConfigV3 | ConfigV4 | ConfigV5)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configField".
 */
export type ConfigField = (ConfigStringField | ConfigNumberField | ConfigBooleanField | ConfigObjectField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configStringField".
 */
export type ConfigStringField = (ConfigPlainStringField | ConfigSensitiveStringField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configScalar".
 */
export type ConfigScalar = (string | number | boolean)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configObjectField".
 */
export type ConfigObjectField = (ConfigFixedObjectField | ConfigKeyValueObjectField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configScalarChildField".
 */
export type ConfigScalarChildField = (ConfigStringChildField | ConfigNumberChildField | ConfigBooleanChildField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configScalarDynamicField".
 */
export type ConfigScalarDynamicField = (ConfigStringDynamicField | ConfigNumberDynamicField | ConfigBooleanDynamicField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV3Field".
 */
export type ConfigV3Field = (ConfigScalarField | ConfigV3FixedObjectField | ConfigV3KeyValueObjectField | ConfigArrayField | ConfigReference)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configScalarField".
 */
export type ConfigScalarField = (ConfigStringField | ConfigNumberField | ConfigBooleanField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configArrayValue".
 */
export type ConfigArrayValue = (string[] | number[] | boolean[] | ConfigArrayObjectValue[])
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configArrayItem".
 */
export type ConfigArrayItem = (ConfigScalarDynamicField | ConfigArrayFixedObjectItem | ConfigArrayKeyValueObjectItem | ConfigArrayItemReference)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4Field".
 */
export type ConfigV4Field = (ConfigV4ScalarField | ConfigV4FixedObjectField | ConfigV4KeyValueObjectField | ConfigV4ArrayField | ConfigV4Reference)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ScalarField".
 */
export type ConfigV4ScalarField = (ConfigV4StringField | ConfigV4NumberField | ConfigV4BooleanField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4StringField".
 */
export type ConfigV4StringField = (ConfigV4PlainStringField | ConfigSensitiveStringField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configScalarArrayValue".
 */
export type ConfigScalarArrayValue = (string[] | number[] | boolean[])
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4PropertyField".
 */
export type ConfigV4PropertyField = (ConfigV4ScalarChildField | ConfigV4LeafArrayField | ConfigV4LeafObjectField | ConfigChildReference)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ScalarChildField".
 */
export type ConfigV4ScalarChildField = (ConfigV4StringChildField | ConfigV4NumberChildField | ConfigV4BooleanChildField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ScalarDynamicField".
 */
export type ConfigV4ScalarDynamicField = (ConfigV4StringDynamicField | ConfigV4NumberDynamicField | ConfigV4BooleanDynamicField)
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ArrayValue".
 */
export type ConfigV4ArrayValue = (string[] | number[] | boolean[] | ConfigV4ObjectValue[])
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ArrayItem".
 */
export type ConfigV4ArrayItem = (ConfigV4ScalarDynamicField | ConfigV4ArrayFixedObjectItem | ConfigV4ArrayKeyValueObjectItem | ConfigArrayItemReference)

export interface PluginManifestSourceV4 {
schemaVersion: 4
name: string
version: Semver
description: string
platforms?: ("codex" | "claude" | "antigravity" | "cursor" | "opencode" | "pi" | "gemini" | "copilot" | "grok" | "generic")[]
dependencies?: string[]
requires?: Requires
skills?: "./skills"
mcpServers?: PluginPath
marketplace: Marketplace
interface?: Interface
extensions?: Extensions
artifacts?: Artifacts
managedCommands?: ManagedCommands
nativeTools?: NativeTools
buildConfig?: BuildConfig
scripts?: Scripts
config?: Config
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "requires".
 */
export interface Requires {
aw: {
capabilities?: string[]
}
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "marketplace".
 */
export interface Marketplace {
category: string
tags?: string[]
strict: boolean
policy: {
installation: ("AVAILABLE" | "NOT_AVAILABLE" | "INSTALLED_BY_DEFAULT")
authentication: ("ON_INSTALL" | "ON_USE")
}
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "interface".
 */
export interface Interface {
displayName?: string
shortDescription?: string
capabilities?: string[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "extensions".
 */
export interface Extensions {
instructions?: Instruction[]
permissions?: Permission[]
hooks?: Hook[]
nativeHooks?: {
codex?: {
event: ("PreToolUse" | "PermissionRequest" | "PostToolUse" | "SessionStart" | "SubagentStart" | "UserPromptSubmit" | "Stop")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
claude?: {
event: ("PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Notification" | "UserPromptSubmit" | "SessionStart" | "SessionEnd" | "Stop" | "StopFailure" | "SubagentStart" | "SubagentStop" | "PreCompact" | "PostCompact" | "PermissionRequest" | "PermissionDenied" | "Setup" | "TeammateIdle" | "TaskCreated" | "TaskCompleted" | "Elicitation" | "ElicitationResult" | "ConfigChange" | "WorktreeCreate" | "WorktreeRemove" | "InstructionsLoaded" | "CwdChanged" | "FileChanged")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
antigravity?: {
event: ("PreToolUse" | "PostToolUse" | "SessionStart" | "PreInvocation" | "PostInvocation" | "Stop")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
cursor?: {
event: ("beforeShellExecution" | "afterShellExecution" | "beforeMCPExecution" | "afterMCPExecution" | "beforeReadFile" | "afterFileEdit" | "beforeSubmitPrompt" | "sessionStart" | "sessionEnd" | "subagentStart" | "subagentStop" | "stop" | "workspaceOpen")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
opencode?: {
event: ("before" | "after")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
pi?: {
event: ("tool_call" | "tool_result" | "session_start" | "before_agent_start")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
gemini?: {
event: ("BeforeTool" | "AfterTool" | "SessionStart" | "SessionEnd" | "BeforeAgent" | "AfterAgent")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
copilot?: {
event: ("preToolUse" | "postToolUse" | "sessionStart" | "sessionEnd" | "userPromptSubmitted" | "errorOccurred")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
grok?: {
event: ("PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd" | "SubagentStart" | "Stop")
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}[]
}
agents?: Agent[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "instruction".
 */
export interface Instruction {
name: string
title: string
content: string
paths?: StringArray
coverage: ("main" | "plugin-agents" | "other-agents")[]
agentOverrides?: InstructionOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "instructionOverrides".
 */
export interface InstructionOverrides {
codex?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
claude?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
antigravity?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
cursor?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
opencode?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
pi?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
gemini?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
copilot?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
grok?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
generic?: (null | {
name?: string
title?: string
content?: string
paths?: StringArray
coverage?: ("main" | "plugin-agents" | "other-agents")[]
})
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "permission".
 */
export interface Permission {
name: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
agentOverrides?: PermissionOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "managedCommandPermission".
 */
export interface ManagedCommandPermission {
command: ManagedCommandReference
argsPrefix?: string[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "managedCommandReference".
 */
export interface ManagedCommandReference {
set: CommandName
key: CommandName
variant?: CommandName
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "permissionOverrides".
 */
export interface PermissionOverrides {
codex?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
claude?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
sandbox?: {
excludedCommands: ManagedCommandPermission[]
}
})
antigravity?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
cursor?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
opencode?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
pi?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
gemini?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
copilot?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
grok?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
generic?: (null | {
name?: string
allow?: PermissionCommands
ask?: PermissionCommands
deny?: PermissionCommands
})
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "hook".
 */
export interface Hook {
event: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
agentOverrides?: HookOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "hookOverrides".
 */
export interface HookOverrides {
codex?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
claude?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
antigravity?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
cursor?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
opencode?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
pi?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
gemini?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
copilot?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
grok?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
generic?: (null | {
event?: ("before_tool" | "after_tool" | "session_start")
matcher?: string
command?: string
feedback?: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
})
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "agent".
 */
export interface Agent {
name: string
description: string
prompt: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
agentOverrides?: AgentOverrides
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "agentOverrides".
 */
export interface AgentOverrides {
codex?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
claude?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
antigravity?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
cursor?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
opencode?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
pi?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
gemini?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
copilot?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
grok?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
generic?: (null | {
name?: string
description?: string
prompt?: string
tools?: StringArray
model?: string
promptMode?: ("host-default" | "append" | "replace")
})
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "artifacts".
 */
export interface Artifacts {
configKeys: string[]
sourceDirs?: PluginPath[]
runtimeImports?: ArtifactRuntimeImports
scopes?: ("user" | "project")[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "managedCommands".
 */
export interface ManagedCommands {
packages?: ManagedCommandPackage[]
sets?: ManagedCommandSet[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "managedCommandPackage".
 */
export interface ManagedCommandPackage {
key: CommandName
scope: ("user" | "project")
platforms: ("codex" | "claude" | "antigravity" | "cursor" | "opencode" | "pi" | "gemini" | "copilot" | "grok")[]
sourceDir: PluginPath
render?: true
refreshKeys?: string[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "commandDefinition".
 */
export interface CommandDefinition {
key: CommandName
variant?: CommandName
runner: ("node" | "executable")
entry: CommandRelativeFile
args?: string[]
env?: CommandEnvironment
envFrom?: CommandEnvironmentSource
cwd?: ("caller" | "resource")
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "commandEnvironment".
 */
export interface CommandEnvironment {
[k: string]: string
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "commandEnvironmentSource".
 */
export interface CommandEnvironmentSource {
[k: string]: string
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "nativeTools".
 */
export interface NativeTools {
reader?: PluginPath
definitions: {
key: CommandName
protocol: string
}[]
consumers: NativeToolConsumer[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "nativeToolConsumer".
 */
export interface NativeToolConsumer {
kind: ("managed-command-set" | "plugin-test")
key: CommandName
tools: NativeToolBinding[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
codex?: FileRules
claude?: FileRules
antigravity?: FileRules
cursor?: FileRules
opencode?: FileRules
pi?: FileRules
generic?: FileRules
gemini?: FileRules
copilot?: FileRules
grok?: FileRules
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
platforms?: ("codex" | "claude" | "antigravity" | "cursor" | "opencode" | "pi" | "gemini" | "copilot" | "grok" | "generic")[]
source?: string
import?: ImportReference
}[]
generatedSkillRuntimeFiles?: {
skill: string
target: string
platforms?: ("codex" | "claude" | "antigravity" | "cursor" | "opencode" | "pi" | "gemini" | "copilot" | "grok" | "generic")[]
}[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "platformTemplateValue".
 */
export interface PlatformTemplateValue {
codex?: (string | boolean)
claude?: (string | boolean)
antigravity?: (string | boolean)
cursor?: (string | boolean)
opencode?: (string | boolean)
pi?: (string | boolean)
generic?: (string | boolean)
gemini?: (string | boolean)
copilot?: (string | boolean)
grok?: (string | boolean)
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "fileRules".
 */
export interface FileRules {
include: StringArray
exclude: StringArray
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "runtimeExportRequires".
 */
export interface RuntimeExportRequires {
aw: {
capabilities: Capabilities
}
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "importReference".
 */
export interface ImportReference {
plugin: string
export: string
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "preApply".
 */
export interface PreApply {
path: PluginPath
timeoutMs?: number
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "scriptEntry".
 */
export interface ScriptEntry {
runner: "node"
path: string
args?: StringArray
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configPlainStringField".
 */
export interface ConfigPlainStringField {
valueRef?: ConfigLocalValueReference
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configLocalValueReference".
 */
export interface ConfigLocalValueReference {
field: string
key: string
label?: string
include?: ConfigScalar[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configStringChoices".
 */
export interface ConfigStringChoices {
allowCustom: boolean
presets: ConfigStringPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configStringValidation".
 */
export interface ConfigStringValidation {
minLength?: number
maxLength?: number
pattern?: string
format?: ("identifier" | "slug" | "semver" | "url" | "hostname" | "email")
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configNumberField".
 */
export interface ConfigNumberField {
valueRef?: ConfigLocalValueReference
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configNumberChoices".
 */
export interface ConfigNumberChoices {
allowCustom: boolean
presets: ConfigNumberPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configNumberValidation".
 */
export interface ConfigNumberValidation {
integer?: boolean
minimum?: number
maximum?: number
multipleOf?: number
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configBooleanField".
 */
export interface ConfigBooleanField {
valueRef?: ConfigLocalValueReference
type: "boolean"
title?: string
description?: string
default?: boolean
required?: boolean
sensitive?: never
choices?: ConfigBooleanChoices
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configBooleanChoices".
 */
export interface ConfigBooleanChoices {
allowCustom: boolean
presets: ConfigBooleanPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configObjectChoices".
 */
export interface ConfigObjectChoices {
allowCustom: boolean
presets: ConfigObjectPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configStringChildField".
 */
export interface ConfigStringChildField {
valueRef?: ConfigLocalValueReference
type: "string"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigStringChoices
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configNumberChildField".
 */
export interface ConfigNumberChildField {
valueRef?: ConfigLocalValueReference
type: "number"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configBooleanChildField".
 */
export interface ConfigBooleanChildField {
valueRef?: ConfigLocalValueReference
type: "boolean"
title?: string
description?: string
required?: boolean
sensitive?: never
choices?: ConfigBooleanChoices
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configObjectValidation".
 */
export interface ConfigObjectValidation {
minProperties?: number
maxProperties?: number
key?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configStringDynamicField".
 */
export interface ConfigStringDynamicField {
valueRef?: ConfigLocalValueReference
type: "string"
title?: string
description?: string
sensitive?: never
choices?: ConfigStringChoices
validation?: ConfigStringValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configNumberDynamicField".
 */
export interface ConfigNumberDynamicField {
valueRef?: ConfigLocalValueReference
type: "number"
title?: string
description?: string
sensitive?: never
choices?: ConfigNumberChoices
validation?: ConfigNumberValidation
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configBooleanDynamicField".
 */
export interface ConfigBooleanDynamicField {
valueRef?: ConfigLocalValueReference
type: "boolean"
title?: string
description?: string
sensitive?: never
choices?: ConfigBooleanChoices
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configChildReference".
 */
export interface ConfigChildReference {
$ref: string
title?: string
description?: string
required?: boolean
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configDynamicReference".
 */
export interface ConfigDynamicReference {
$ref: string
title?: string
description?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configArrayObjectValue".
 */
export interface ConfigArrayObjectValue {
[k: string]: ConfigScalar
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configArrayItemReference".
 */
export interface ConfigArrayItemReference {
$ref: string
title?: string
description?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configArrayChoices".
 */
export interface ConfigArrayChoices {
allowCustom: boolean
presets: ConfigArrayPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configArrayValidation".
 */
export interface ConfigArrayValidation {
minItems?: number
maxItems?: number
uniqueItems?: boolean
uniqueBy?: string
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4".
 */
export interface ConfigV4 {
fields: Fields
presentation?: Presentation
schemaVersion: 4
definitions?: {
[k: string]: ConfigV4Field
}
}
export interface Fields {
[k: string]: ConfigV4Field
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configValueReference".
 */
export interface ConfigValueReference {
plugin?: string
field: string
key: string
label?: string
include?: ConfigScalar[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ObjectValue".
 */
export interface ConfigV4ObjectValue {
[k: string]: (ConfigScalar | ConfigScalarArrayValue | ConfigArrayObjectValue)
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ObjectChoices".
 */
export interface ConfigV4ObjectChoices {
allowCustom: boolean
presets: ConfigV4ObjectPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configScalarArrayChoices".
 */
export interface ConfigScalarArrayChoices {
allowCustom: boolean
presets: ConfigScalarArrayPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ObjectVariant".
 */
export interface ConfigV4ObjectVariant {
properties: {
[k: string]: ConfigV4PropertyField
}
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4ArrayChoices".
 */
export interface ConfigV4ArrayChoices {
allowCustom: boolean
presets: ConfigV4ArrayPreset[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
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
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV4Reference".
 */
export interface ConfigV4Reference {
$ref: string
title?: string
description?: string
default?: (ConfigScalar | ConfigV4ArrayValue | ConfigV4ObjectValue)
required?: boolean
}
export interface Presentation {
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
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configV5".
 */
export interface ConfigV5 {
fields: Fields
presentation?: Presentation
schemaVersion: 5
definitions?: {
[k: string]: ConfigV4Field
}
platforms?: {
codex?: ConfigPlatformProfile
claude?: ConfigPlatformProfile
antigravity?: ConfigPlatformProfile
cursor?: ConfigPlatformProfile
opencode?: ConfigPlatformProfile
pi?: ConfigPlatformProfile
generic?: ConfigPlatformProfile
gemini?: ConfigPlatformProfile
copilot?: ConfigPlatformProfile
grok?: ConfigPlatformProfile
}
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "configPlatformProfile".
 */
export interface ConfigPlatformProfile {
definitions?: {
[k: string]: ConfigV4Field
}
fields?: Fields
presentation?: Presentation
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "nativeHook".
 */
export interface NativeHook {
event: string
matcher?: string
command: string
id: string
feedback: ("notify" | "context" | "block")
requires?: FeatureRequirement[]
}
/**
 * This interface was referenced by `PluginManifestSourceV4`'s JSON-Schema
 * via the `definition` "runtimeConfig".
 */
export interface RuntimeConfig {
keys: string[]
}
