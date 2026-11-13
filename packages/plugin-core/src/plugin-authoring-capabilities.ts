import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLUGIN_SCRIPT_TIMEOUT_MAX_MS,
  PLUGIN_SCRIPT_TIMEOUT_MIN_MS,
} from './plugin-script-contract.js'
import { PLATFORM_TARGETS, NATIVE_PLATFORM_TARGETS } from './platform-support.js'
import { PUBLIC_HOOK_EVENTS } from './hooks-contract.js'
import { getPlatformHookHandlerRegistry, type PlatformHookHandlerContract } from './hook-handlers.js'
import { COMPONENT_KINDS, PLATFORM_FEATURE_REGISTRY, CAPABILITY_REASON_CODES } from './plugin-components.js'

export const PLUGIN_AUTHORING_CAPABILITY_SURFACES = [
  'manifest',
  'build-config',
  'extensions',
  'mcp',
  'config',
  'pre-apply',
  'managed-commands',
  'native-tools',
  'artifacts',
  'platform-components',
  'hook-handlers',
  'platform-capabilities',
] as const

export type PluginAuthoringCapabilitySurfaceName =
  (typeof PLUGIN_AUTHORING_CAPABILITY_SURFACES)[number]

export type PluginAuthoringAcceptedValue = string | number | boolean

export interface PluginAuthoringCapabilityEntry {
  field: string
  type: string
  required: boolean | string
  acceptedValues?: readonly PluginAuthoringAcceptedValue[] | string
  hookHandler?: PlatformHookHandlerContract
}

export interface PluginAuthoringCapabilitySurface {
  surface: PluginAuthoringCapabilitySurfaceName
  entries: readonly PluginAuthoringCapabilityEntry[]
}

export interface PluginAuthoringCapabilityRegistry {
  schemaVersion: 1
  surfaces: Readonly<Record<PluginAuthoringCapabilitySurfaceName, PluginAuthoringCapabilitySurface>>
}

const registry = {
  schemaVersion: 1,
  surfaces: {
    manifest: {
      surface: 'manifest',
      entries: [
        { field: 'schemaVersion', type: 'literal 4', required: true, acceptedValues: [4] },
        { field: 'name', type: 'kebab-case string', required: true },
        { field: 'version', type: 'stable strict SemVer', required: true },
        { field: 'description', type: 'non-empty string', required: true },
        { field: 'requires.aw.capabilities', type: 'unique AW capability ID[]', required: false },
        { field: 'dependencies', type: 'unique plugin-name[]; each dependency covers all consumer platforms', required: false },
        { field: 'platforms', type: 'unique canonical target[]; omitted or [] means all ten targets', required: false, acceptedValues: PLATFORM_TARGETS },
        { field: 'skills', type: 'literal ./skills', required: false },
        { field: 'mcpServers', type: './ plugin-relative path', required: false },
        { field: 'marketplace.category', type: 'non-empty string', required: true },
        { field: 'marketplace.tags', type: 'string[]', required: false },
        { field: 'marketplace.strict', type: 'boolean', required: true },
        { field: 'marketplace.policy.installation', type: 'enum', required: true, acceptedValues: ['AVAILABLE', 'NOT_AVAILABLE', 'INSTALLED_BY_DEFAULT'] },
        { field: 'marketplace.policy.authentication', type: 'enum', required: true, acceptedValues: ['ON_INSTALL', 'ON_USE'] },
        { field: 'managedCommands', type: '{packages?,sets?}', required: false },
        { field: 'nativeTools', type: '{reader?,definitions,consumers}; requires aw.native-tools.v2', required: false },
        { field: 'interface.displayName', type: 'non-empty string', required: false },
        { field: 'interface.shortDescription', type: 'non-empty string', required: false },
        { field: 'interface.capabilities', type: 'string[]', required: false },
      ],
    },
    'build-config': {
      surface: 'build-config',
      entries: [
        { field: 'buildConfig.cacheable', type: 'literal true', required: false, acceptedValues: [true] },
        { field: 'buildConfig.templates', type: '{vars,include}', required: false },
        { field: 'buildConfig.templates.vars.<key>', type: 'canonical target to string|boolean map', required: 'with buildConfig.templates' },
        { field: 'buildConfig.templates.include', type: 'string[]', required: 'with buildConfig.templates' },
        { field: 'buildConfig.fileRules', type: 'platform include/exclude object', required: false },
        { field: 'buildConfig.fileRules.<platform>', type: '{include,exclude}', required: false, acceptedValues: PLATFORM_TARGETS },
        { field: 'buildConfig.runtimeExports', type: '{name,source,requires}[]', required: false },
        { field: 'buildConfig.runtimeExports[].requires.aw.capabilities', type: 'unique AW capability ID[]', required: true },
        { field: 'buildConfig.buildImports', type: '{plugin,export,env}[]', required: false },
        { field: 'buildConfig.skillRuntimeFiles', type: '{skill,target,platforms?,source|import}[]', required: false },
        { field: 'buildConfig.skillRuntimeFiles[].platforms', type: 'unique canonical target[]; omitted or [] selects supported targets', required: false, acceptedValues: PLATFORM_TARGETS },
        { field: 'buildConfig.generatedSkillRuntimeFiles', type: '{skill,target,platforms?}[]', required: false },
        { field: 'buildConfig.generatedSkillRuntimeFiles[].platforms', type: 'unique canonical target[]; omitted or [] selects supported targets', required: false, acceptedValues: PLATFORM_TARGETS },
      ],
    },
    extensions: {
      surface: 'extensions',
      entries: [
        { field: 'extensions.instructions', type: '{name,title,content,paths?,coverage,agentOverrides?}[]', required: false },
        { field: 'extensions.instructions[].coverage', type: 'non-empty unique audience[]', required: true, acceptedValues: ['main', 'plugin-agents', 'other-agents'] },
        { field: 'extensions.permissions', type: '{name,allow?,ask?,deny?,agentOverrides?}[]', required: false },
        { field: 'extensions.permissions[].allow|ask|deny', type: '(string | {command:{set,key,variant?},argsPrefix?})[]; safe prefix tokens only', required: false },
        { field: 'extensions.permissions[].agentOverrides.claude.sandbox.excludedCommands', type: 'structured command permission[]; independent of allow; requires aw.claude.sandbox-exclusions.v1', required: false },
        { field: 'extensions.hooks', type: '{id,event,feedback,matcher?,command?,requires?,agentOverrides?}[]; resolved command required', required: false },
        { field: 'extensions.hooks[].id', type: 'stable component identity without path separators', required: true },
        { field: 'extensions.hooks[].event', type: 'enum', required: true, acceptedValues: PUBLIC_HOOK_EVENTS },
        { field: 'extensions.hooks[].feedback', type: 'enum', required: true, acceptedValues: ['notify', 'context', 'block'] },
        { field: 'extensions.nativeHooks.<platform>', type: '{id,event,feedback,matcher?,command,requires?}[]; fixed platform event registry', required: false, acceptedValues: NATIVE_PLATFORM_TARGETS },
        { field: 'extensions.agents', type: '{name,description,prompt,model?,tools?,promptMode?,agentOverrides?}[]', required: false },
        { field: 'extensions.agents[].tools', type: 'tool allowlist; [] requires no-tools enforcement; omitted uses host default', required: false },
        { field: 'extensions.agents[].promptMode', type: 'enum; omitted means host-default', required: false, acceptedValues: ['host-default', 'append', 'replace'] },
        { field: 'extensions.<entry>.agentOverrides.<platform>', type: 'field-level override or null; arrays replace; stable identity cannot be overridden', required: false, acceptedValues: PLATFORM_TARGETS },
      ],
    },
    mcp: {
      surface: 'mcp',
      entries: [
        { field: 'mcpServers', type: './ JSON file containing only {mcpServers:{name:definition}}', required: false },
        { field: 'mcpServers.<key>.type', type: 'enum', required: true, acceptedValues: ['stdio', 'http', 'sse'] },
        { field: 'mcpServers.<key>.command', type: 'string; forbidden for remote transports', required: 'stdio transport' },
        { field: 'mcpServers.<key>.args', type: 'string[]; stdio only', required: false },
        { field: 'mcpServers.<key>.env', type: 'string map; stdio only', required: false },
        { field: 'mcpServers.<key>.headers', type: 'string map; remote only', required: false },
        { field: 'mcpServers.<key>.url', type: 'URL string; forbidden for stdio', required: 'http or sse transport' },
      ],
    },
    config: {
      surface: 'config',
      entries: [
        { field: 'config.schemaVersion', type: 'literal 3, 4 or 5; omitted for Config v2', required: false, acceptedValues: [3, 4, 5] },
        { field: 'config.platforms.<platform>', type: 'Config v5 complete definition/field replacement and optional presentation', required: false, acceptedValues: PLATFORM_TARGETS },
        { field: 'config.definitions', type: 'local field definition map; at most 64 entries', required: false },
        { field: 'config.fields.<key>.$ref', type: '#/config/definitions/Name; at most 8 reference edges, including child references; only title/description/default/required overrides', required: false },
        { field: 'config.fields', type: 'field map; at most 256 entries for v3/v4/v5', required: 'with config' },
        { field: 'config.fields.<key>.type', type: 'enum', required: 'unless $ref', acceptedValues: ['string', 'number', 'boolean', 'object', 'array'] },
        { field: 'config.fields.<key>.title', type: 'string', required: false },
        { field: 'config.fields.<key>.description', type: 'string', required: false },
        { field: 'config.fields.<key>.default', type: 'string|number|boolean|object|homogeneous array', required: false },
        { field: 'config.fields.<key>.required', type: 'boolean', required: false },
        { field: 'config.fields.<key>.sensitive', type: 'literal true; top-level string fields only; incompatible with default or choices', required: false, acceptedValues: [true] },
        { field: 'config.fields.<key>.choices', type: '{allowCustom,presets}', required: false },
        { field: 'config.fields.<key>.choices.allowCustom', type: 'boolean', required: 'with choices' },
        { field: 'config.fields.<key>.choices.presets', type: '{id,title,description?,value,recommended?}[]', required: 'with choices' },
        { field: 'config.fields.<key>.validation', type: 'type-specific validation object', required: false },
        { field: 'config.fields.<key>.validation.minItems', type: 'integer 0..128', required: false },
        { field: 'config.fields.<key>.validation.maxItems', type: 'integer 0..128', required: false },
        { field: 'config.fields.<key>.validation.uniqueItems', type: 'boolean; default false', required: false },
        { field: 'config.fields.<key>.validation.uniqueBy', type: 'own fixed scalar property; Config v3/v4/v5 object arrays only', required: false },
        { field: 'config.fields.<key>.valueRef', type: '{plugin?,field,key,label?,include?}; non-sensitive scalar; local Config v3/v4/v5, cross-plugin Config v4/v5 and explicit same-source direct dependency; source is a fixed-object array with matching uniqueBy and key type; included values are reserved', required: false },
        { field: 'config.fields.<key>.properties.<property>.valueRef', type: '{plugin?,field,key,label?,include?}; shallow scalar reference; complete candidate and source dependency validation', required: false },
        { field: 'config.fields.<key>.items', type: 'one homogeneous scalar or shallow object schema; arrays only in Config v3/v4/v5', required: 'for array field' },
        { field: 'config.fields.<key>.validation.maxLength', type: 'integer 0..4096', required: 'with pattern' },
        { field: 'config.fields.<key>.validation.pattern', type: 'RE2 Unicode pattern up to 512 code points', required: false },
        { field: 'config.fields.<key>.validation.format', type: 'enum', required: false, acceptedValues: ['identifier', 'slug', 'semver', 'url', 'hostname', 'email'] },
        { field: 'config.fields.<key>.validation.key.maxLength', type: 'integer 0..4096', required: 'with key.pattern' },
        { field: 'config.fields.<key>.validation.key.pattern', type: 'RE2 Unicode pattern up to 512 code points', required: false },
        { field: 'config.fields.<key>.properties', type: 'scalar child field map; v4/v5 also permit leaf scalar arrays and scalar key-value objects', required: 'for fixed object properties' },
        { field: 'config.fields.<key>.const', type: 'typed non-sensitive scalar constant; Config v4/v5; no implicit default or required relaxation', required: false },
        { field: 'config.fields.<key>.variants', type: 'finite fixed-object branch map; Config v4/v5; common plus selected branch properties; at most 32 combined properties', required: false },
        { field: 'config.fields.<key>.variants.discriminator', type: 'own common string property; validated before case selection', required: 'with variants' },
        { field: 'config.fields.<key>.variants.cases', type: '1..32 named {properties} branches; cannot override common properties', required: 'with variants' },
        { field: 'config.fields.<key>.variants.missing', type: 'declared case name; used only when discriminator is absent', required: false },
        { field: 'config.fields.<key>.variants.otherwise', type: '{properties}; used for other valid discriminator values', required: false },
        { field: 'config.fields.<key>.additionalProperties', type: 'false | scalar child field', required: 'false for fixed objects; scalar child field for key-value objects' },
        { field: 'config.presentation.summaries', type: 'named join summaries; v3/v4/v5; at most 4 parts, 8 separator code points, 128 path characters, 256 output code points', required: false },
        { field: 'config.presentation.summaries.<name>.parts[].path', type: 'single own fixed scalar property JSON Pointer; ~0 and ~1 decoding', required: true },
        { field: 'config.presentation.summaries.<name>.parts[].format', type: 'enum', required: false, acceptedValues: ['raw', 'choiceTitle'] },
        { field: 'config.presentation.fieldViews.<key>.summary', type: 'local summary name for a fixed object field; v3/v4/v5', required: false },
        { field: 'config.presentation.fieldViews.<key>.itemSummary', type: 'local summary name for fixed object array items; v3/v4/v5', required: false },
        { field: 'config.presentation.groups', type: 'group[]', required: false },
      ],
    },
    'pre-apply': {
      surface: 'pre-apply',
      entries: [
        { field: 'scripts.preApply', type: '{path,timeoutMs?}', required: false },
        { field: 'scripts.preApply.path', type: './ Node path', required: true },
        { field: 'scripts.preApply.timeoutMs', type: 'integer', required: false, acceptedValues: `${PLUGIN_SCRIPT_TIMEOUT_MIN_MS}..${PLUGIN_SCRIPT_TIMEOUT_MAX_MS}` },
        { field: 'scripts.helpers.config', type: './ Node path', required: false },
        { field: 'scripts.node.packageRoot', type: './ package directory path', required: false },
        { field: 'scripts.node.build', type: '{runner,path,args?}', required: false },
        { field: 'scripts.node.build.runner', type: 'literal node', required: true, acceptedValues: ['node'] },
        { field: 'scripts.tests.node', type: './ Node path[]', required: false },
      ],
    },
    'managed-commands': {
      surface: 'managed-commands',
      entries: [
        { field: 'managedCommands', type: '{packages?,sets?}; requires aw.managed-commands.v1; exact objects, no unknown fields or null', required: false },
        { field: 'managedCommands.packages', type: 'ManagedPackage[]; default []; unique key', required: false },
        { field: 'managedCommands.packages[].key', type: 'Name: [A-Za-z][A-Za-z0-9_.-]{0,63}; case sensitive', required: true },
        { field: 'managedCommands.packages[].scope', type: 'enum', required: true, acceptedValues: ['user', 'project'] },
        { field: 'managedCommands.packages[].platforms', type: 'non-empty unique enum[]', required: true, acceptedValues: NATIVE_PLATFORM_TARGETS },
        { field: 'managedCommands.packages[].sourceDir', type: './ plugin-relative ordinary directory; bundle closure, no links or protected/author-only paths', required: true },
        { field: 'managedCommands.packages[].render', type: 'literal true; omitted means static', required: false, acceptedValues: [true] },
        { field: 'managedCommands.packages[].refreshKeys', type: 'unique Config v4 top-level key[]; non-sensitive dependency closure; default []; non-empty requires render:true', required: false },
        { field: 'managedCommands.sets', type: 'CommandSet[]; default []; unique set', required: false },
        { field: 'managedCommands.sets[].set', type: 'Name', required: true },
        { field: 'managedCommands.sets[].producer.kind', type: 'enum', required: true, acceptedValues: ['artifact', 'static-skill', 'package'] },
        { field: 'managedCommands.sets[].producer.artifactId', type: 'dynamic Skill component ID on the declared platform and actual render scope; checked after the complete component set', required: 'kind artifact' },
        { field: 'managedCommands.sets[].producer.platform', type: 'enum', required: 'kind artifact or static-skill', acceptedValues: NATIVE_PLATFORM_TARGETS },
        { field: 'managedCommands.sets[].producer.skillKey', type: 'declared static Skill key on selected platform', required: 'kind static-skill' },
        { field: 'managedCommands.sets[].producer.packageKey', type: 'declared package Name; package controls scope/platform eligibility', required: 'kind package' },
        { field: 'managedCommands.sets[].producer', type: '{kind:artifact,platform,artifactId} | {kind:static-skill,platform,skillKey} | {kind:package,packageKey}; same plugin, unique declared Skill/package', required: true },
        { field: 'managedCommands.sets[].mode', type: 'enum', required: true, acceptedValues: ['static', 'dynamic'] },
        { field: 'managedCommands.sets[].refreshKeys', type: 'unique Config v4 top-level key[]; non-sensitive dependency closure', required: 'dynamic; explicit [] permitted' },
        { field: 'managedCommands.sets[].entries', type: 'CommandDefinition[]; empty allowed; unique normalized key/variant; forbidden for dynamic', required: 'static' },
        { field: 'CommandDefinition.key', type: 'Name', required: true },
        { field: 'CommandDefinition.variant', type: 'Name; default default', required: false },
        { field: 'CommandDefinition.runner', type: 'enum', required: true, acceptedValues: ['node', 'executable'] },
        { field: 'CommandDefinition.entry', type: 'RelativeFile; ordinary file inside producer; no links, controls, dot or empty segments', required: true },
        { field: 'CommandDefinition.args', type: 'string[]; default []; at most 128 values of at most 4096 Unicode code points; empty strings preserved', required: false },
        { field: 'CommandDefinition.env', type: 'environment-name to literal string map; default {}; values at most 4096 code points; protected names forbidden', required: false },
        { field: 'CommandDefinition.envFrom', type: 'environment-name to source environment-name map; default {}; protected names and overlapping env targets forbidden', required: false },
        { field: 'CommandDefinition.cwd', type: 'enum; default caller', required: false, acceptedValues: ['caller', 'resource'] },
        { field: 'CommandPermission.command', type: '{set:Name,key:Name,variant?:Name}; variant default default', required: true },
        { field: 'CommandPermission.argsPrefix', type: 'safe token[] matching [A-Za-z0-9_./:@%+=,-]+; default []', required: false },
        { field: 'Skill Markdown placeholder', type: '{{aw.command:set/key}} or {{aw.command:set/key/variant}}; final .md only; invalid forms rejected; requires qualified Native Skill runtime', required: false },
        { field: 'commandScope', type: 'inherit actual producer scope; codex shared native is user; user consumer cannot use project package; package must include consumer platform', required: true },
        { field: 'CommandSetArtifact', type: '{id,target:aw.command-set,kind:commandSet,state,refreshKeys,entries,platform?,disabledReason?}; exact requested ID and declaration keys; platform required only for platform producer; no distribution/scope/owner/producer overrides', required: 'dynamic set response' },
        { field: 'CommandSetArtifact.state', type: 'enum; disabled requires empty entries, present may be empty', required: true, acceptedValues: ['present', 'disabled'] },
        { field: 'CommandSetArtifact.disabledReason', type: 'non-empty Unicode string', required: 'optional only when disabled' },
        { field: 'CommandPackageArtifact', type: '{id,target:aw.command-package,kind:commandPackage,state:present,refreshKeys,files}; no platform/distribution/scope/owner/producer overrides; files explicit and complete, may be {}', required: 'rendered package response' },
        { field: 'ArtifactPlan.commandOutputs', type: 'version:2; each requested ID exactly once; no extra or missing IDs; existing limits and sensitive scans apply', required: 'command renderer response' },
        { field: 'commandIdentity', type: 'schemaVersion:2; complete verified producer including placementKey + set/key/variant; cmdp_ + first 16 lowercase hex characters of SHA256 of canonical sorted-key UTF-8 JSON; excludes version/config/resource path', required: true },
        { field: 'normalizedTarget', type: 'dynamic set command-set.<set>:aw.command-set/commandSet; rendered package command-package.<key>:aw.command-package/commandPackage; reserved artifact ID prefixes', required: false },
        { field: 'scripts.artifacts.render', type: 'existing renderer declaration', required: 'any dynamic set or render:true package' },
      ],
    },
    'native-tools': {
      surface: 'native-tools',
      entries: [
        { field: 'nativeTools', type: 'host protocol definitions and controlled consumer bindings; requires aw.native-tools.v2', required: false },
        { field: 'nativeTools.reader', type: './ plugin-relative .mjs file; default ./.aw/native-tool-reader.mjs; AW generates an offline reader before build', required: false },
        { field: 'nativeTools.definitions', type: '1..32 definitions; unique case-sensitive key; every definition must be consumed', required: true },
        { field: 'nativeTools.definitions[].key', type: 'Name: [A-Za-z][A-Za-z0-9_.-]{0,63}', required: true },
        { field: 'nativeTools.definitions[].protocol', type: 'host protocol ID; current host supports aw.windows-job.v1', required: true },
        { field: 'nativeTools.consumers', type: '1..128 consumers; unique kind/key', required: true },
        { field: 'nativeTools.consumers[].kind', type: 'enum; only AW controlled launch boundaries', required: true, acceptedValues: ['managed-command-set', 'plugin-test'] },
        { field: 'nativeTools.consumers[].key', type: 'declared managed command set; plugin-test supports node with declared tests', required: true },
        { field: 'nativeTools.consumers[].tools', type: '1..32 bindings; unique referenced definition key', required: true },
        { field: 'nativeTools.consumers[].tools[].key', type: 'declared nativeTools definition key', required: true },
        { field: 'nativeTools.consumers[].tools[].platforms', type: 'non-empty unique enum[]; only win32 is supported', required: true, acceptedValues: ['win32'] },
        { field: 'nativeTools.consumers[].tools[].policy', type: 'enum', required: true, acceptedValues: ['required', 'preferred'] },
        { field: 'nativeTools.consumers[].tools[].fallback', type: 'portable backend Name; forbidden for required; same protocol contract tested by runner', required: 'preferred' },
      ],
    },
    artifacts: {
      surface: 'artifacts',
      entries: [
        { field: 'scripts.artifacts.render', type: '{runner:node,path,args?}', required: 'with artifacts or dynamic managed commands' },
        { field: 'artifacts.configKeys', type: 'unique platform-compiled config key[]; complete collection refresh', required: true },
        { field: 'artifacts.sourceDirs', type: 'verified bundle-relative directory[]', required: false },
        { field: 'artifacts.runtimeImports', type: '{name,plugin,export}[]; verified named resource closure', required: false },
        { field: 'artifacts.scopes', type: 'non-empty unique render scope[]; omitted means both', required: false, acceptedValues: ['user', 'project'] },
        { field: 'rendererContext', type: 'PlatformRenderContext v1; surface agent-plugin; schemaVersion 1', required: true },
        { field: 'rendererContext.allowedOutputKinds', type: 'render-unit kinds intersect batch permissions; Skills separate from non-Skills', required: true, acceptedValues: COMPONENT_KINDS },
        { field: 'rendererContext.config', type: 'schema/values/sources/issues restricted to the batch whitelist; missing values omitted', required: true },
        { field: 'rendererContext.platformCapabilities', type: 'PlatformCapabilities v1; immutable platform/scope/profile facts', required: true },
        { field: 'rendererContext.resources', type: '{kind,name,root,digest}[]; verified read-only inputs', required: true },
        { field: 'rendererContext.previousComponents', type: '{id,kind,name}[]; same batch only; no content/config/host paths', required: true },
        { field: 'agentCommandContext', type: 'schemaVersion 1; surface agent-commands; exact requested command-set IDs; producer render scope', required: 'Skill dynamic command sets' },
      ],
    },
    'platform-components': {
      surface: 'platform-components',
      entries: [
        { field: 'version', type: 'literal 3', required: true, acceptedValues: [3] },
        { field: 'components', type: 'complete PluginComponent[]; no fixed targets, host paths or disable states', required: true },
        { field: 'components[].kind', type: 'enum', required: true, acceptedValues: COMPONENT_KINDS },
        { field: 'components[].id', type: 'stable cross-kind unique ID; no path separators or command-set./command-package. prefixes', required: true },
        { field: 'components[].name', type: 'logical host name; adapter validates mapped name and collisions', required: true },
        { field: 'components[].requires', type: 'FeatureRequirement[]; cannot remove requirements inferred from content', required: false },
        { field: 'components[].content', type: 'kind-specific exact object; Skill files use {text} or {source:{kind,path,name?}}', required: true },
        { field: 'components[].runtimeConfig.keys', type: 'non-empty unique non-sensitive artifacts.configKeys subset; requires aw.installed-runtime-config.v2', required: false },
        { field: 'omitted', type: '{id,kind,reason}[]; source-local intentional omission', required: true },
        { field: 'omitted[].reason', type: 'enum', required: true, acceptedValues: ['not-offered', 'config-disabled'] },
        { field: 'unmet', type: '{id,kind,name?,componentId?,requiredFeatures,reasonCode}[]; preserves concrete missing values', required: true },
        { field: 'unmet[].componentId', type: 'successful Instruction component ID; separable coverage only', required: false },
        { field: 'unmet[].requiredFeatures', type: '{feature,values?}[]; capability gaps require exact missing semantics', required: true },
      ],
    },
    'hook-handlers': {
      surface: 'hook-handlers',
      entries: Object.values(getPlatformHookHandlerRegistry()).flatMap((platform) => [...Object.values(platform.common), ...Object.values(platform.native)].map((handler) => ({
        field: `${handler.platform}.${handler.dialect}.${handler.event}`, type: 'fixed handler protocol; null protocol remains unverified; qualification required', required: false, hookHandler: handler,
      }))),
    },
    'platform-capabilities': {
      surface: 'platform-capabilities',
      entries: [
        { field: 'schemaVersion', type: 'literal 1', required: true, acceptedValues: [1] },
        { field: 'platform', type: 'enum', required: true, acceptedValues: PLATFORM_TARGETS },
        { field: 'scope', type: 'render scope enum', required: true, acceptedValues: ['user', 'project'] },
        { field: 'basis', type: 'enum', required: true, acceptedValues: ['local', 'profile'] },
        { field: 'profileId', type: 'fixed qualified version/OS/route capability mapping identity', required: true },
        { field: 'consumers', type: '{id,product,version,agentConsumers?}[]; non-sensitive identities', required: true },
        { field: 'kinds.<kind>', type: '{status,reasonCodes,delivery}; all five kinds required', required: true, acceptedValues: COMPONENT_KINDS },
        { field: 'status', type: 'enum; missing feature defaults to unsupported', required: true, acceptedValues: ['supported', 'unsupported', 'unverified'] },
        { field: 'reasonCodes', type: 'registered machine reason code[]', required: true, acceptedValues: CAPABILITY_REASON_CODES },
        ...Object.values(PLATFORM_FEATURE_REGISTRY).map((feature) => ({ field: `features.${feature.id}`, type: `{status,reasonCodes,values?,maxBytes?}; ${feature.evidence}`, required: false, ...(feature.values ? { acceptedValues: feature.values } : {}) })),
      ],
    },
  },
} as const satisfies PluginAuthoringCapabilityRegistry

export function getPluginAuthoringCapabilities(): PluginAuthoringCapabilityRegistry {
  return registry
}

export function getPluginAuthoringCapabilitySurface(
  surface: PluginAuthoringCapabilitySurfaceName,
): PluginAuthoringCapabilitySurface {
  return registry.surfaces[surface]
}

export function getPluginAuthoringAcceptedValues(
  surface: PluginAuthoringCapabilitySurfaceName,
  field: string,
): readonly PluginAuthoringAcceptedValue[] {
  const entries: readonly PluginAuthoringCapabilityEntry[] = registry.surfaces[surface].entries
  const entry = entries.find((candidate) => candidate.field === field)
  if (!entry || !Array.isArray(entry.acceptedValues)) {
    throw new Error(`Plugin authoring capability ${surface}.${field} has no accepted values.`)
  }
  return entry.acceptedValues
}

export function getPluginCoreVersion(): string {
  const packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'package.json',
  )
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
  if (typeof packageJson.version !== 'string') {
    throw new Error('Cannot read @lesliechan721/aw-plugin-core package version.')
  }
  return packageJson.version
}
