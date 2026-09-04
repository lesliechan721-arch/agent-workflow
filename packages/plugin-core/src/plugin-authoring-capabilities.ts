import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLUGIN_SCRIPT_TIMEOUT_MAX_MS,
  PLUGIN_SCRIPT_TIMEOUT_MIN_MS,
} from './plugin-script-contract.js'
import { PUBLIC_HOOK_EVENTS } from './hooks-contract.js'

export const PLUGIN_AUTHORING_CAPABILITY_SURFACES = [
  'manifest',
  'build-config',
  'extensions',
  'slash-commands',
  'mcp-apps',
  'config',
  'post-apply',
  'artifacts',
] as const

export type PluginAuthoringCapabilitySurfaceName =
  (typeof PLUGIN_AUTHORING_CAPABILITY_SURFACES)[number]

export type PluginAuthoringAcceptedValue = string | number | boolean

export interface PluginAuthoringCapabilityEntry {
  field: string
  type: string
  required: boolean | string
  acceptedValues?: readonly PluginAuthoringAcceptedValue[] | string
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
        { field: 'schemaVersion', type: 'literal 3', required: true, acceptedValues: [3] },
        { field: 'name', type: 'kebab-case string', required: true },
        { field: 'version', type: 'stable strict SemVer', required: true },
        { field: 'description', type: 'non-empty string', required: true },
        { field: 'requires.aw.capabilities', type: 'unique AW capability ID[]', required: false },
        { field: 'dependencies', type: 'unique plugin-name[]', required: false },
        { field: 'skills', type: './ plugin-relative path', required: false },
        { field: 'slashCommands', type: './ plugin-relative path', required: false },
        { field: 'mcpServers', type: './ plugin-relative path', required: false },
        { field: 'apps', type: './ plugin-relative path', required: false },
        { field: 'distributions.agentSkills', type: '{skills?}', required: false },
        { field: 'distributions.agentSkills.skills', type: './ plugin-relative path', required: false },
        { field: 'marketplace.category', type: 'non-empty string', required: true },
        { field: 'marketplace.tags', type: 'string[]', required: false },
        { field: 'marketplace.strict', type: 'boolean', required: true },
        { field: 'marketplace.policy.installation', type: 'enum', required: true, acceptedValues: ['AVAILABLE', 'NOT_AVAILABLE', 'INSTALLED_BY_DEFAULT'] },
        { field: 'marketplace.policy.authentication', type: 'enum', required: true, acceptedValues: ['ON_INSTALL', 'ON_USE'] },
        { field: 'marketplace.policy.products', type: 'unique enum[]', required: false, acceptedValues: ['CODEX', 'CLAUDE'] },
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
        { field: 'buildConfig.templates.vars.<key>', type: '{claude:string|boolean,codex:string|boolean}', required: 'with buildConfig.templates' },
        { field: 'buildConfig.templates.include', type: 'string[]', required: 'with buildConfig.templates' },
        { field: 'buildConfig.fileRules', type: 'platform include/exclude object', required: false },
        { field: 'buildConfig.fileRules.<platform>', type: '{include,exclude}', required: false, acceptedValues: ['claude', 'codex'] },
        { field: 'buildConfig.manifestOverrides.claude', type: 'object', required: false, acceptedValues: ['outputStyles', 'lspServers', 'userConfig', 'channels'] },
        { field: 'buildConfig.runtimeExports', type: '{name,source,requires}[]', required: false },
        { field: 'buildConfig.runtimeExports[].requires.aw.capabilities', type: 'unique AW capability ID[]', required: true },
        { field: 'buildConfig.buildImports', type: '{plugin,export,env}[]', required: false },
        { field: 'buildConfig.skillRuntimeFiles', type: '{skill,target,platforms?,distributions?,source|import}[]', required: false },
        { field: 'buildConfig.skillRuntimeFiles[].platforms', type: 'unique enum[]', required: false, acceptedValues: ['codex', 'claude'] },
        { field: 'buildConfig.skillRuntimeFiles[].distributions', type: 'unique enum[]', required: false, acceptedValues: ['agent-skills'] },
        { field: 'buildConfig.generatedSkillRuntimeFiles', type: '{skill,target,distributions?}[]', required: false },
        { field: 'buildConfig.generatedSkillRuntimeFiles[].distributions', type: 'unique enum[]', required: false, acceptedValues: ['agent-skills'] },
      ],
    },
    extensions: {
      surface: 'extensions',
      entries: [
        { field: 'extensions.instructions', type: '{name,title,content,paths?,agentOverrides?}[]', required: false },
        { field: 'extensions.permissions', type: '{name,allow?,ask?,deny?,agentOverrides?}[]', required: false },
        { field: 'extensions.hooks', type: '{event,matcher?,command,agentOverrides?}[]', required: false },
        { field: 'extensions.hooks[].event', type: 'enum', required: true, acceptedValues: PUBLIC_HOOK_EVENTS },
        { field: 'extensions.nativeHooks.claude', type: 'native hook[]', required: false },
        { field: 'extensions.nativeHooks.codex', type: 'native hook[]', required: false },
        { field: 'extensions.agents', type: '{name,description,prompt,tools?,agentOverrides?}[]', required: false },
      ],
    },
    'slash-commands': {
      surface: 'slash-commands',
      entries: [
        { field: 'description', type: 'string', required: true },
        { field: 'claude', type: 'frontmatter object', required: false, acceptedValues: ['description', 'allowed-tools', 'model', 'argument-hint', 'shell'] },
        { field: 'claude.shell', type: 'enum', required: false, acceptedValues: ['bash', 'powershell'] },
        { field: 'codex.description', type: 'string', required: false },
        { field: 'codex.interface', type: 'display metadata object', required: false, acceptedValues: ['display_name', 'short_description', 'icon_small', 'icon_large', 'brand_color', 'default_prompt'] },
        { field: 'codex.generated.policy.allow_implicit_invocation', type: 'literal false', required: true, acceptedValues: [false] },
      ],
    },
    'mcp-apps': {
      surface: 'mcp-apps',
      entries: [
        { field: 'mcpServers.<key>.command', type: 'string', required: 'stdio transport' },
        { field: 'mcpServers.<key>.args', type: 'string[]', required: false },
        { field: 'mcpServers.<key>.env', type: 'string map', required: false },
        { field: 'mcpServers.<key>.headers', type: 'string map', required: false },
        { field: 'mcpServers.<key>.url', type: 'URL string', required: 'HTTP transport' },
        { field: 'apps.<key>.id', type: 'non-empty string', required: true },
      ],
    },
    config: {
      surface: 'config',
      entries: [
        { field: 'config.fields', type: 'field map', required: 'with config' },
        { field: 'config.fields.<key>.type', type: 'enum', required: true, acceptedValues: ['string', 'number', 'boolean', 'object'] },
        { field: 'config.fields.<key>.title', type: 'string', required: false },
        { field: 'config.fields.<key>.description', type: 'string', required: false },
        { field: 'config.fields.<key>.default', type: 'string|number|boolean|object', required: false },
        { field: 'config.fields.<key>.required', type: 'boolean', required: false },
        { field: 'config.fields.<key>.sensitive', type: 'literal true; top-level string fields only; incompatible with default or choices', required: false, acceptedValues: [true] },
        { field: 'config.fields.<key>.choices', type: '{allowCustom,presets}', required: false },
        { field: 'config.fields.<key>.choices.allowCustom', type: 'boolean', required: 'with choices' },
        { field: 'config.fields.<key>.choices.presets', type: '{id,title,description?,value,recommended?}[]', required: 'with choices' },
        { field: 'config.fields.<key>.validation', type: 'type-specific validation object', required: false },
        { field: 'config.fields.<key>.validation.maxLength', type: 'integer 0..4096', required: 'with pattern' },
        { field: 'config.fields.<key>.validation.pattern', type: 'RE2 Unicode pattern up to 512 code points', required: false },
        { field: 'config.fields.<key>.validation.format', type: 'enum', required: false, acceptedValues: ['identifier', 'slug', 'semver', 'url', 'hostname', 'email'] },
        { field: 'config.fields.<key>.validation.key.maxLength', type: 'integer 0..4096', required: 'with key.pattern' },
        { field: 'config.fields.<key>.validation.key.pattern', type: 'RE2 Unicode pattern up to 512 code points', required: false },
        { field: 'config.fields.<key>.properties', type: 'scalar child field map', required: 'for fixed object properties' },
        { field: 'config.fields.<key>.additionalProperties', type: 'false | scalar child field', required: 'false for fixed objects; scalar child field for key-value objects' },
        { field: 'config.presentation.groups', type: 'group[]', required: false },
      ],
    },
    'post-apply': {
      surface: 'post-apply',
      entries: [
        { field: 'scripts.postApply', type: '{path,timeoutMs?}', required: false },
        { field: 'scripts.postApply.path', type: './ Node path', required: true },
        { field: 'scripts.postApply.timeoutMs', type: 'integer', required: false, acceptedValues: `${PLUGIN_SCRIPT_TIMEOUT_MIN_MS}..${PLUGIN_SCRIPT_TIMEOUT_MAX_MS}` },
        { field: 'scripts.helpers.config', type: './ Node path', required: false },
        { field: 'scripts.node.packageRoot', type: './ package directory path', required: false },
        { field: 'scripts.node.build', type: '{runner,path,args?}', required: false },
        { field: 'scripts.node.build.runner', type: 'literal node', required: true, acceptedValues: ['node'] },
        { field: 'scripts.tests.node', type: './ Node path[]', required: false },
      ],
    },
    artifacts: {
      surface: 'artifacts',
      entries: [
        { field: 'scripts.artifacts.render', type: '{runner,path,args?}', required: 'with artifacts.targets' },
        { field: 'scripts.artifacts.render.runner', type: 'literal node', required: true, acceptedValues: ['node'] },
        { field: 'rendererContext.requestedArtifactIds', type: 'non-empty unique artifact id[]', required: true },
        { field: 'artifacts.targets', type: 'artifact target[]', required: false },
        { field: 'artifacts.targets[].id', type: 'surface/scope-unique stable identifier; globally unique for codex-native', required: true },
        { field: 'artifacts.targets[].platform', type: 'enum', required: 'for native targets', acceptedValues: ['codex', 'claude'] },
        { field: 'artifacts.targets[].distribution', type: 'enum', required: 'for portable targets', acceptedValues: ['agent-skills'] },
        { field: 'artifacts.targets[].target', type: 'enum', required: true, acceptedValues: ['codex.developerInstructionsBlock', 'codex.agentRole', 'codex.skill', 'claude.skill', 'agent-skills.skill'] },
        { field: 'artifacts.targets[].kind', type: 'enum', required: false, acceptedValues: ['instruction', 'codexRole', 'skill'] },
        { field: 'artifacts.targets[].projectManagedKind', type: 'enum', required: false, acceptedValues: ['skill', 'mcpServer', 'instruction', 'permission', 'hook', 'agent'] },
        { field: 'artifacts.targets[].scopes', type: 'unique enum[]', required: true, acceptedValues: ['user', 'project'] },
        { field: 'artifacts.targets[].states', type: 'unique enum[]', required: true, acceptedValues: ['present', 'disabled'] },
        { field: 'artifacts.targets[].refreshKeys', type: 'unique config key[]', required: true },
        { field: 'artifacts.targets[].delivery', type: 'codex.skill delivery union', required: 'for codex.skill' },
        { field: 'artifacts.targets[].delivery.mode', type: 'enum', required: 'with delivery', acceptedValues: ['codex-native', 'aw-extension'] },
        { field: 'artifacts.targets[].delivery.identity', type: 'literal shared', required: 'when delivery.mode is codex-native', acceptedValues: ['shared'] },
        { field: 'artifacts.targets[].delivery.renderProfile', type: 'literal user', required: 'when delivery.mode is codex-native', acceptedValues: ['user'] },
        { field: 'artifacts.targets[].requiresCodexProjectConfig', type: 'boolean', required: false },
        { field: 'artifacts.targets[].roleKey', type: 'stable role key', required: 'for codex.agentRole' },
        { field: 'artifacts.targets[].skillKey', type: 'stable Skill key; globally unique for codex-native', required: 'for Skill targets' },
        { field: 'artifacts.targets[].sourceDirs', type: './ plugin-relative path[]', required: false },
        { field: 'artifacts.targets[].runtimeImports', type: '{name,plugin,export}[]', required: false },
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
