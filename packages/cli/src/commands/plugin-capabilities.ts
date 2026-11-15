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
      requires: 'Each same-source dependency covers every supported consumer platform, including transitive edges.',
      conflicts: 'The plugin itself, missing providers, and dependency cycles.',
    },
    platforms: {
      profiles: 'codex, claude, antigravity, cursor, opencode, pi, gemini, copilot, grok, generic',
      requires: 'Omitted or empty platforms support all ten canonical targets; each selected projection must be valid.',
      conflicts: 'Unknown or duplicate target IDs, distributions.agentSkills, and marketplace.policy.products.',
      provenance: ['CLI source and bundle validators'],
    },
    skills: {
      profiles: 'Native platform packages and explicit-profile Agent Skills exports from one ./skills source root',
      requires: 'Each final Skill has a production README.md and valid target metadata and resource closure.',
      provenance: ['CLI target projection and Skill validators'],
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
    'buildConfig.skillRuntimeFiles': { requires: 'A declared static Skill and a target below references/, assets/, or scripts/.' },
    'buildConfig.skillRuntimeFiles[].platforms': {
      profiles: 'canonical target projection',
      requires: 'A declared static Skill key and targets within plugin platforms.',
      conflicts: 'Overlapping target selections for the same Skill runtime path; omitted or empty selection covers supported targets.',
    },
    'buildConfig.generatedSkillRuntimeFiles': {
      requires: 'scripts.node.build creates each declared final target; omitted or empty platforms cover supported targets.',
      provenance: ['CLI bundle validator'],
    },
    'buildConfig.generatedSkillRuntimeFiles[].platforms': {
      profiles: 'canonical target projection',
      requires: 'A declared static Skill key and targets within plugin platforms.',
      provenance: ['CLI bundle validator'],
    },
  },
  extensions: {
    'extensions.permissions[].agentOverrides.claude.sandbox.excludedCommands': {
      profiles: 'CLAUDE',
      requires: 'aw.claude.sandbox-exclusions.v1; a validated command reference. Independent of allow.',
      conflicts: 'Plain strings, Codex overrides, and widening to all aw commands.',
      provenance: ['CLI managed command reference resolver and Claude permission writer'],
    },
    'extensions.nativeHooks.claude': { profiles: 'CLAUDE', requires: 'claude target support.' },
    'extensions.nativeHooks.codex': { profiles: 'CODEX', requires: 'codex target support.' },
  },
  mcp: {
    'mcpServers.<key>.command': { conflicts: 'url' },
    'mcpServers.<key>.url': { conflicts: 'command' },
  },
  config: {
    'config.presentation': { conflicts: 'Schema mutation and sensitive or path values in presets.' },
  },
  'pre-apply': {
    'scripts.preApply': { requires: 'A Node entry inside the plugin root.' },
  },
  artifacts: {
    'scripts.artifacts.render': {
      requires: 'artifacts input permissions, dynamic command sets, or render:true command packages.',
    },
    'artifacts.configKeys': {
      requires: 'Fields exist in the selected platform Config v5 profile; Skill batches contain only the non-sensitive dependency closure.',
    },
    'artifacts.sourceDirs': {
      requires: 'Verified bundle-relative input directories; these do not declare final component identities.',
    },
    'artifacts.runtimeImports': {
      requires: 'Provider-owned runtime exports resolved into the consumer bundle and bound by digest.',
    },
    'artifacts.scopes': {
      requires: 'The physical resource render scope; an excluded scope intentionally offers no dynamic components.',
    },
    'rendererContext.platformCapabilities': {
      requires: 'The qualified capability input for the exact render unit; offline preparation uses basis=profile.',
    },
  },
  'platform-components': {
    components: { requires: 'The complete v3 component set for the allowed output kinds; omitted and unmet are explicit arrays.' },
    'components[].runtimeConfig.keys': { requires: 'aw.installed-runtime-config.v2 and a qualified native profile; a non-sensitive artifacts.configKeys subset.' },
  },
  'platform-capabilities': {
    basis: { requires: 'Author preparation uses profile; local is reserved for actual consumer observations.' },
  },
  'native-tools': {
    nativeTools: {
      requires: 'aw.native-tools.v2. Installed protocol requirements and consumer bindings are reviewed before producer publication.',
      provenance: ['CLI installed producer evidence and managed command host'],
    },
    'nativeTools.consumers[].kind': {
      requires: 'Managed command sets prepare the installed host tool before spawn; plugin tests use the installed host tool or an explicit test fixture.',
      conflicts: 'Uncontrolled hooks, MCP entry paths, implicit package discovery, or source sync changing installed command evidence.',
    },
    'nativeTools.consumers[].tools[].fallback': {
      requires: 'Preferred consumers use the same protocol contract for native and portable backends; backend selection remains fixed after launch.',
    },
  },
  'managed-commands': {
    managedCommands: {
      requires: 'aw.managed-commands.v1. Bindings publish only after the producer succeeds.',
      provenance: ['CLI managed command materialization and resolver'],
    },
    'managedCommands.packages[].sourceDir': {
      requires: 'A complete runnable directory in the fixed bundle; only ordinary files and directories.',
      conflicts: 'Links, protected trees, executable entry replacement by generated files.',
    },
    'managedCommands.packages[].scope': {
      requires: 'One fixed effective configuration per producer; project producers bind the canonical project location.',
      conflicts: 'User/shared-user consumers referring to project packages.',
    },
    'Skill Markdown placeholder': {
      requires: 'A validated candidate or healthy installed producer in the same source/plugin and legal scope.',
      conflicts: 'Generic export profiles and unresolved, disabled, foreign, or other-placement commands.',
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
