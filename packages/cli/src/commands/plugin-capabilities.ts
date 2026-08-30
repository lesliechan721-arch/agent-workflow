import {
  getPluginCoreVersion,
  getPluginAuthoringCapabilities,
  PLUGIN_AUTHORING_CAPABILITY_SURFACES,
  type PluginAuthoringCapabilityEntry,
  type PluginAuthoringCapabilitySurfaceName,
} from '@lesliechan721/aw-plugin-core/manifest'

interface AdapterCapabilityFacts {
  requires?: string
  conflicts?: string
  profiles?: string
  provenance?: readonly string[]
}

const CORE_REGISTRY_PROVENANCE = '@lesliechan721/aw-plugin-core manifest structure registry'
const CLI_ADAPTER_PROVENANCE = '@lesliechan721/aw CLI authoring adapter'

const adapterFacts: Readonly<Partial<Record<
  PluginAuthoringCapabilitySurfaceName,
  Readonly<Record<string, AdapterCapabilityFacts>>
>>> = {
  manifest: {
    dependencies: {
      requires: 'Each dependency is an available plugin in the same Catalog source.',
      conflicts: 'The plugin itself, missing providers, and dependency cycles.',
    },
    'distributions.agentSkills': {
      profiles: 'agent-skills',
      requires: 'At least one non-empty native capability; portable-only plugins are not supported.',
      conflicts: 'Portable-only plugins and implicit promotion of native skills.',
      provenance: ['CLI source plugin validator'],
    },
    'distributions.agentSkills.skills': {
      profiles: 'agent-skills static',
      requires: 'Each direct child is a valid portable-agent-skills Skill with a production README.md.',
      conflicts: 'Inferring the portable root from the native skills root.',
      provenance: ['CLI source plugin validator'],
    },
    'marketplace.policy.products': {
      profiles: 'Omitted means CODEX and CLAUDE.',
      provenance: ['CLI author validator'],
    },
  },
  'build-config': {
    'buildConfig.cacheable': { requires: 'A deterministic scripts.node.build.' },
    'buildConfig.runtimeExports': { conflicts: 'Skill, report, eval, generated, and dependency roots.' },
    'buildConfig.runtimeExports[].requires.aw.capabilities': {
      requires: 'The provider-owned complete capability set for this export; an empty set is valid.',
      provenance: ['CLI runtime import resolver'],
    },
    'buildConfig.buildImports': { requires: 'scripts.node.build and a unique AW_PLUGIN_IMPORT_* environment variable.' },
    'buildConfig.manifestOverrides.claude': { profiles: 'CLAUDE', requires: 'CLAUDE product support.' },
    'buildConfig.skillRuntimeFiles': { requires: 'A declared static Skill and a target below references/, assets/, or scripts/.' },
    'buildConfig.skillRuntimeFiles[].distributions': {
      profiles: 'agent-skills projection',
      requires: 'distributions.agentSkills and a declared portable Skill key.',
      conflicts: 'Omission selects native surfaces; platforms plus distributions selects both explicit surface groups.',
    },
    'buildConfig.generatedSkillRuntimeFiles': {
      requires: 'scripts.node.build creates each declared final target; omitted distributions apply to supported native platforms.',
      provenance: ['CLI bundle validator'],
    },
    'buildConfig.generatedSkillRuntimeFiles[].distributions': {
      profiles: 'agent-skills projection',
      requires: 'distributions.agentSkills and a declared portable Skill key.',
      conflicts: 'Omission selects native surfaces; explicit agent-skills selects only the portable surface.',
      provenance: ['CLI bundle validator'],
    },
  },
  extensions: {
    'extensions.nativeHooks.claude': { profiles: 'CLAUDE', requires: 'CLAUDE product support.' },
    'extensions.nativeHooks.codex': { profiles: 'CODEX', requires: 'CODEX product support.' },
  },
  'slash-commands': {
    claude: { profiles: 'CLAUDE' },
    'codex.description': { profiles: 'CODEX' },
    'codex.interface': { profiles: 'CODEX', requires: 'default_prompt invokes $command-name.' },
  },
  'mcp-apps': {
    'mcpServers.<key>.command': { conflicts: 'url' },
    'mcpServers.<key>.url': { conflicts: 'command' },
    'apps.<key>.id': {
      profiles: 'CODEX user scope',
      conflicts: 'CLAUDE-only plugins and Codex project scope.',
    },
  },
  config: {
    'config.presentation': { conflicts: 'Schema mutation and sensitive or path values in presets.' },
  },
  lifecycle: {
    'scripts.lifecycle': { requires: 'An executable entry inside the plugin root.' },
  },
  artifacts: {
    'scripts.artifacts.render': { requires: 'artifacts.targets.' },
    'artifacts.targets': { requires: 'scripts.artifacts.render and complete static target identity.' },
    'artifacts.targets[].runtimeImports': {
      requires: 'A provider runtimeExports entry resolved into the consumer bundle.',
      conflicts: 'Using the reuse edge as an installation dependency.',
      provenance: ['CLI runtime import resolver'],
    },
  },
}

export interface PluginCapabilityResultEntry extends PluginAuthoringCapabilityEntry {
  owner: 'core'
  provenance: readonly string[]
  requires?: string
  conflicts?: string
  profiles?: string
}

export interface PluginCapabilitiesResult {
  command: 'plugin:capabilities'
  schemaVersion: 1
  awVersion: string
  coreVersion: string
  surface: PluginAuthoringCapabilitySurfaceName | null
  capabilities: Partial<Record<PluginAuthoringCapabilitySurfaceName, readonly PluginCapabilityResultEntry[]>>
}

export function parsePluginCapabilitySurface(
  value: string,
): PluginAuthoringCapabilitySurfaceName {
  if (!(PLUGIN_AUTHORING_CAPABILITY_SURFACES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown plugin capability surface ${JSON.stringify(value)}. Expected one of: ${PLUGIN_AUTHORING_CAPABILITY_SURFACES.join(', ')}.`,
    )
  }
  return value as PluginAuthoringCapabilitySurfaceName
}

function combineEntry(
  surface: PluginAuthoringCapabilitySurfaceName,
  entry: PluginAuthoringCapabilityEntry,
): PluginCapabilityResultEntry {
  const facts = adapterFacts[surface]?.[entry.field]
  return {
    ...entry,
    owner: 'core',
    provenance: [
      CORE_REGISTRY_PROVENANCE,
      ...(facts ? [CLI_ADAPTER_PROVENANCE] : []),
      ...(facts?.provenance ?? []),
    ],
    ...(facts?.requires ? { requires: facts.requires } : {}),
    ...(facts?.conflicts ? { conflicts: facts.conflicts } : {}),
    ...(facts?.profiles ? { profiles: facts.profiles } : {}),
  }
}

export function getPluginCapabilitiesResult(options: {
  awVersion: string
  surface?: PluginAuthoringCapabilitySurfaceName
}): PluginCapabilitiesResult {
  const registry = getPluginAuthoringCapabilities()
  const surfaces = options.surface
    ? [options.surface]
    : PLUGIN_AUTHORING_CAPABILITY_SURFACES
  return {
    command: 'plugin:capabilities',
    schemaVersion: 1,
    awVersion: options.awVersion,
    coreVersion: getPluginCoreVersion(),
    surface: options.surface ?? null,
    capabilities: Object.fromEntries(surfaces.map((surface) => [
      surface,
      registry.surfaces[surface].entries.map((entry) => combineEntry(surface, entry)),
    ])),
  }
}

export function renderPluginCapabilities(result: PluginCapabilitiesResult): string[] {
  const lines = [
    `Plugin authoring capabilities (aw ${result.awVersion}, core ${result.coreVersion})`,
  ]
  for (const [surface, entries] of Object.entries(result.capabilities)) {
    lines.push(`${surface}:`)
    for (const entry of entries ?? []) {
      const required = typeof entry.required === 'boolean'
        ? (entry.required ? 'required' : 'optional')
        : `required: ${entry.required}`
      const values = Array.isArray(entry.acceptedValues)
        ? `; values=${entry.acceptedValues.join(',')}`
        : entry.acceptedValues
          ? `; values=${entry.acceptedValues}`
          : ''
      const profiles = entry.profiles ? `; profiles=${entry.profiles}` : ''
      const requires = entry.requires ? `; requires=${entry.requires}` : ''
      const conflicts = entry.conflicts ? `; conflicts=${entry.conflicts}` : ''
      lines.push(`  ${entry.field} — ${entry.type}; ${required}${values}${profiles}${requires}${conflicts}`)
    }
  }
  return lines
}
