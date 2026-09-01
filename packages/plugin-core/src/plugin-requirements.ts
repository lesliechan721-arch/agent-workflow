import path from 'node:path'

import fs from 'fs-extra'

import {
  computeAwCapabilitySetDigest,
  normalizeAwCapabilities,
  type AwCapabilityId,
  type RegisteredAwCapabilityId,
} from './aw-capabilities.js'
import { resolvePlatformHookDefinitions } from './hooks-contract.js'
import { resolveSupportedPlatforms } from './platform-support.js'
import type { NormalizedPluginManifest, PluginManifestSource } from './types.js'

export interface PluginRequirementObservation {
  code: 'aw-command-detected' | 'aw-command-unmapped' | 'aw-command-dynamic'
  blocking: false
  path: string
  provenance: 'shell-fence' | 'manifest-executable'
  command?: string
  capability?: AwCapabilityId
  message: string
}

export interface PluginRequirementsResolution {
  schemaVersion: 1
  declared: AwCapabilityId[]
  derived: AwCapabilityId[]
  detected: AwCapabilityId[]
  effective: AwCapabilityId[]
  capabilitySetDigest: string
  unsupportedByCurrentAw: AwCapabilityId[]
  observations: PluginRequirementObservation[]
}

function hasRuntimeImports(manifest: PluginManifestSource | NormalizedPluginManifest): boolean {
  return (manifest.buildConfig?.runtimeExports?.length ?? 0) > 0
    || (manifest.buildConfig?.buildImports?.length ?? 0) > 0
    || (manifest.buildConfig?.skillRuntimeFiles ?? []).some((entry) => entry.import !== undefined)
    || (manifest.artifacts?.targets ?? []).some((target) => (target.runtimeImports?.length ?? 0) > 0)
}

export function deriveAwCapabilitiesFromManifest(
  manifest: PluginManifestSource | NormalizedPluginManifest,
): AwCapabilityId[] {
  const capabilities: RegisteredAwCapabilityId[] = []
  if ((manifest as { schemaVersion?: number }).schemaVersion === 3) capabilities.push('aw.plugin-manifest.v3')
  if (manifest.skills) capabilities.push('aw.plugin-skills.v1')
  if (manifest.buildConfig) capabilities.push('aw.plugin-build-config.v1')
  if (manifest.config) capabilities.push('aw.plugin-config.v2')
  if (manifest.scripts?.lifecycle) capabilities.push('aw.plugin-lifecycle.v1')
  if ((manifest.artifacts?.targets?.length ?? 0) > 0) capabilities.push('aw.dynamic-artifacts.v2')
  if (manifest.distributions?.agentSkills) capabilities.push('aw.portable-skills.v1')
  if (hasRuntimeImports(manifest)) capabilities.push('aw.runtime-imports.v1')
  return normalizeAwCapabilities(capabilities)
}

const COMMAND_CAPABILITIES: Readonly<Record<string, RegisteredAwCapabilityId>> = {
  'self describe': 'aw.self-check.v1',
  'self check': 'aw.self-check.v1',
  'skill validate': 'aw.skill-validation.v1',
  'skill eval': 'aw.skill-eval.v2',
  'plugin capabilities': 'aw.plugin-authoring.v1',
  'plugin init': 'aw.plugin-authoring.v1',
  'plugin add-skill': 'aw.plugin-authoring.v1',
  'plugin remove': 'aw.plugin-authoring.v1',
  'plugin validate': 'aw.plugin-authoring.v1',
  'plugin test': 'aw.plugin-authoring.v1',
  'plugin build': 'aw.plugin-authoring.v1',
  'plugin status': 'aw.plugin-authoring.v1',
  'plugin requirements': 'aw.plugin-authoring.v1',
  'catalog init': 'aw.catalog-authoring.v1',
  'catalog status': 'aw.catalog-authoring.v1',
  'catalog version': 'aw.catalog-authoring.v1',
  'catalog build': 'aw.catalog-authoring.v1',
  'catalog validate': 'aw.catalog-authoring.v1',
  'catalog publish': 'aw.catalog-publication.v1',
  'review publish': 'aw.review-publication.v1',
  'review digest': 'aw.review-publication.v1',
  'review verify': 'aw.review-publication.v1',
  'review list': 'aw.review-publication.v1',
  'review show': 'aw.review-publication.v1',
}

const CONFIG_CAPABILITY = 'aw.plugin-config.v2' satisfies RegisteredAwCapabilityId
const CATALOG_SOURCE_CAPABILITY = 'aw.catalog-source.v2' satisfies RegisteredAwCapabilityId
const CATALOG_DEV_SOURCE_CAPABILITY = 'aw.catalog-dev-source.v1' satisfies RegisteredAwCapabilityId

function commandCapabilities(group: string, command: string | undefined, tail: string): AwCapabilityId[] {
  if (command === undefined) return []
  if (group === 'config') return [CONFIG_CAPABILITY]
  if (group === 'catalog' && command === 'source') return [CATALOG_SOURCE_CAPABILITY]
  if (group === 'catalog' && command === 'dev') return [CATALOG_DEV_SOURCE_CAPABILITY]
  if (group === 'catalog' && command === 'status' && /(?:^|\s)--preflight(?:\s|$)/u.test(tail)) {
    return []
  }
  const capability = COMMAND_CAPABILITIES[`${group} ${command}`]
  return capability ? [capability] : []
}

interface AwCommandLiteral {
  group: string
  command?: string
  tail: string
}

interface ScannedAwCommand {
  command: string
  literal?: AwCommandLiteral
}

const AW_COMMAND_AT_START = /^aw[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?(.*)$/u
const AW_SHELL_SEGMENT = /(?:^|&&|\|\||[;|&])\s*((?:\$\s+)?aw(?:[ \t]+.*?))(?=\s*(?:&&|\|\||[;|&]|$))/gu
const SHELL_FENCE_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh'])

function scanAwCommand(value: string): ScannedAwCommand {
  const command = value.trim().replace(/^\$\s+/u, '')
  const match = AW_COMMAND_AT_START.exec(command)
  if (!match) return { command }
  return {
    command,
    literal: {
      group: match[1]!,
      ...(match[2] === undefined ? {} : { command: match[2] }),
      tail: match[3] ?? '',
    },
  }
}

function shellFenceCommands(content: string): ScannedAwCommand[] {
  const commands: ScannedAwCommand[] = []
  let fence: { marker: '`' | '~'; length: number; shell: boolean } | null = null
  for (const line of content.split(/\r?\n/u)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?\s*$/u.exec(line)
    if (fenceMatch) {
      const delimiter = fenceMatch[1]!
      if (fence === null) {
        fence = {
          marker: delimiter[0] as '`' | '~',
          length: delimiter.length,
          shell: SHELL_FENCE_LANGUAGES.has(fenceMatch[2] ?? ''),
        }
        continue
      }
      if (delimiter[0] === fence.marker && delimiter.length >= fence.length) {
        fence = null
        continue
      }
    }
    if (!fence?.shell) continue
    for (const match of line.matchAll(AW_SHELL_SEGMENT)) {
      commands.push(scanAwCommand(match[1] ?? ''))
    }
  }
  return commands
}

function skillCollectionRoot(pluginRoot: string, value: string): string | null {
  const root = path.resolve(pluginRoot, value)
  const relative = path.relative(pluginRoot, root)
  return relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? null
    : root
}

async function actualSkillMainFiles(pluginRoot: string, value: string): Promise<string[]> {
  const collectionRoot = skillCollectionRoot(pluginRoot, value)
  if (!collectionRoot) return []
  const entries = await fs.readdir(collectionRoot, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const skillMain = path.join(collectionRoot, entry.name, 'SKILL.md')
    const stat = await fs.lstat(skillMain).catch(() => null)
    if (stat?.isFile() && !stat.isSymbolicLink()) files.push(skillMain)
  }
  return files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function manifestExecutableCommands(
  manifest: PluginManifestSource | NormalizedPluginManifest,
): ScannedAwCommand[] {
  const commands = new Set<string>()
  for (const platform of resolveSupportedPlatforms(manifest)) {
    for (const hook of resolvePlatformHookDefinitions(
      manifest as NormalizedPluginManifest,
      platform,
    )) {
      const command = hook.command.trim()
      if (/^(?:\$\s+)?aw(?:\s|$)/u.test(command)) commands.add(command)
    }
  }
  return [...commands].sort().map(scanAwCommand)
}

export async function scanPluginAwCliRequirements(options: {
  pluginRoot: string
  manifest: PluginManifestSource | NormalizedPluginManifest
}): Promise<{ detected: AwCapabilityId[]; observations: PluginRequirementObservation[] }> {
  const observations: PluginRequirementObservation[] = []
  const observationKeys = new Set<string>()
  const detected: AwCapabilityId[] = []
  const observe = (observation: PluginRequirementObservation): void => {
    const key = JSON.stringify([
      observation.code,
      observation.path,
      observation.provenance,
      observation.command,
      observation.capability,
    ])
    if (observationKeys.has(key)) return
    observationKeys.add(key)
    observations.push(observation)
  }
  const record = (
    observationPath: string,
    provenance: PluginRequirementObservation['provenance'],
    scanned: ScannedAwCommand,
  ): void => {
    if (!scanned.literal) {
      observe({
        code: 'aw-command-dynamic',
        blocking: false,
        path: observationPath,
        provenance,
        command: scanned.command,
        message: `AW CLI command cannot be mapped statically: ${scanned.command}.`,
      })
      return
    }
    const command = [scanned.literal.group, scanned.literal.command].filter(Boolean).join(' ')
    const capabilities = commandCapabilities(
      scanned.literal.group,
      scanned.literal.command,
      scanned.literal.tail,
    )
    if (capabilities.length === 0) {
      observe({
        code: 'aw-command-unmapped',
        blocking: false,
        path: observationPath,
        provenance,
        command: `aw ${command}`,
        message: `AW CLI command has no capability mapping: aw ${command}.`,
      })
      return
    }
    for (const capability of capabilities) {
      detected.push(capability)
      observe({
        code: 'aw-command-detected',
        blocking: false,
        path: observationPath,
        provenance,
        command: `aw ${command}`,
        capability,
        message: `Detected AW CLI command capability ${capability}: aw ${command}.`,
      })
    }
  }

  for (const scanned of manifestExecutableCommands(options.manifest)) {
    record('.agents-plugin/plugin.json', 'manifest-executable', scanned)
  }
  const skillCollections = new Set([
    options.manifest.skills,
    options.manifest.distributions?.agentSkills?.skills,
  ].filter((value): value is string => value !== undefined))
  const skillFiles = (await Promise.all(
    [...skillCollections].map((value) => actualSkillMainFiles(options.pluginRoot, value)),
  )).flat()
  for (const file of [...new Set(skillFiles)].sort()) {
    const relativePath = path.relative(options.pluginRoot, file).split(path.sep).join('/')
    for (const scanned of shellFenceCommands(await fs.readFile(file, 'utf8'))) {
      record(relativePath, 'shell-fence', scanned)
    }
  }

  observations.sort((left, right) => {
    const leftKey = JSON.stringify([left.path, left.code, left.command, left.capability, left.provenance])
    const rightKey = JSON.stringify([right.path, right.code, right.command, right.capability, right.provenance])
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  return { detected: normalizeAwCapabilities(detected), observations }
}

export async function resolvePluginRequirements(options: {
  pluginRoot: string
  manifest: PluginManifestSource | NormalizedPluginManifest
  implementedCapabilities: readonly string[]
}): Promise<PluginRequirementsResolution> {
  const declared = normalizeAwCapabilities(
    options.manifest.requires?.aw.capabilities ?? [],
    'requires.aw.capabilities',
  )
  const derived = deriveAwCapabilitiesFromManifest(options.manifest)
  const scan = await scanPluginAwCliRequirements(options)
  const effective = normalizeAwCapabilities([...declared, ...derived])
  const implemented = new Set(normalizeAwCapabilities(options.implementedCapabilities))
  return {
    schemaVersion: 1,
    declared,
    derived,
    detected: scan.detected,
    effective,
    capabilitySetDigest: computeAwCapabilitySetDigest(effective),
    unsupportedByCurrentAw: effective.filter((capability) => !implemented.has(capability)),
    observations: scan.observations,
  }
}
