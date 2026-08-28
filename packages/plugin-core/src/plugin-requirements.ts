import path from 'node:path'

import fs from 'fs-extra'

import {
  computeAwCapabilitySetDigest,
  normalizeAwCapabilities,
  type AwCapabilityId,
} from './aw-capabilities.js'
import type { NormalizedPluginManifest, PluginManifestSource } from './types.js'

export interface PluginRequirementObservation {
  code: 'aw-command-detected' | 'aw-command-unmapped' | 'aw-command-dynamic'
  blocking: boolean
  path: string
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
  const capabilities: string[] = []
  if ((manifest as { schemaVersion?: number }).schemaVersion === 2) capabilities.push('aw.plugin-manifest.v2')
  if (manifest.skills) capabilities.push('aw.plugin-skills.v1')
  if (manifest.buildConfig) capabilities.push('aw.plugin-build-config.v1')
  if (manifest.config) capabilities.push('aw.plugin-config.v1')
  if (manifest.scripts?.lifecycle) capabilities.push('aw.plugin-lifecycle.v1')
  if ((manifest.artifacts?.targets?.length ?? 0) > 0) capabilities.push('aw.dynamic-artifacts.v2')
  if (manifest.distributions?.agentSkills) capabilities.push('aw.portable-skills.v1')
  if (hasRuntimeImports(manifest)) capabilities.push('aw.runtime-imports.v1')
  return normalizeAwCapabilities(capabilities)
}

const COMMAND_CAPABILITIES: Readonly<Record<string, AwCapabilityId>> = {
  'self describe': 'aw.self-check.v1',
  'self check': 'aw.self-check.v1',
  'skill validate': 'aw.skill-validation.v1',
  'plugin capabilities': 'aw.plugin-authoring.v1',
  'plugin init': 'aw.plugin-authoring.v1',
  'plugin add-skill': 'aw.plugin-authoring.v1',
  'plugin remove': 'aw.plugin-authoring.v1',
  'plugin validate': 'aw.plugin-authoring.v1',
  'plugin test': 'aw.plugin-authoring.v1',
  'plugin build': 'aw.plugin-authoring.v1',
  'plugin status': 'aw.plugin-authoring.v1',
  'plugin requirements': 'aw.plugin-authoring.v1',
  'catalog context': 'aw.catalog-context.v1',
  'catalog init': 'aw.catalog-authoring.v1',
  'catalog status': 'aw.catalog-authoring.v1',
  'catalog version': 'aw.catalog-authoring.v1',
  'catalog build': 'aw.catalog-authoring.v1',
  'catalog validate': 'aw.catalog-authoring.v1',
  'catalog publish': 'aw.catalog-publication.v1',
}

function commandCapabilities(group: string, command: string, tail: string): AwCapabilityId[] {
  if (group === 'config') return ['aw.plugin-config.v1']
  if (group === 'catalog' && command === 'source') return ['aw.catalog-source.v2']
  if (group === 'catalog' && command === 'dev') return ['aw.catalog-dev-source.v1']
  if (group === 'catalog' && command === 'status' && /(?:^|\s)--preflight(?:\s|$)/u.test(tail)) {
    return ['aw.catalog-authoring.v1', 'aw.catalog-publication.v1']
  }
  const capability = COMMAND_CAPABILITIES[`${group} ${command}`]
  return capability ? [capability] : []
}

interface AwCommandLiteral {
  group: string
  command: string
  tail: string
}

const AW_COMMAND_AT_START = /^\s*(?:\$\s+)?aw[ \t]+([a-z][a-z0-9-]*)[ \t]+([a-z][a-z0-9-]*)(.*)$/u

function parseAwCommandAtStart(value: string): AwCommandLiteral | null {
  const match = AW_COMMAND_AT_START.exec(value)
  if (!match) return null
  return { group: match[1]!, command: match[2]!, tail: match[3] ?? '' }
}

function parseStaticStringArray(value: string): string[] | null {
  const source = value.trim()
  if (!source.startsWith('[') || !source.endsWith(']')) return null
  const values: string[] = []
  let index = 1
  while (index < source.length - 1) {
    while (/\s/u.test(source[index] ?? '')) index += 1
    if (source[index] === ']') break
    const quote = source[index]
    if (quote !== '"' && quote !== "'") return null
    index += 1
    let token = ''
    let closed = false
    while (index < source.length - 1) {
      const character = source[index]!
      if (character === '\\') {
        index += 1
        if (index >= source.length - 1) return null
        token += source[index]!
        index += 1
      } else if (character === quote) {
        index += 1
        closed = true
        break
      } else {
        token += character
        index += 1
      }
    }
    if (!closed) return null
    values.push(token)
    while (/\s/u.test(source[index] ?? '')) index += 1
    if (source[index] === ',') {
      index += 1
      continue
    }
    if (source[index] !== ']') return null
  }
  return values
}

function markdownCommandLiterals(content: string): AwCommandLiteral[] {
  const literals: AwCommandLiteral[] = []
  for (const line of content.split(/\r?\n/u)) {
    const direct = parseAwCommandAtStart(line)
    if (direct) literals.push(direct)
    for (const match of line.matchAll(/`([^`\r\n]+)`/gu)) {
      const inline = parseAwCommandAtStart(match[1] ?? '')
      if (inline) literals.push(inline)
    }
  }
  return literals
}

function shellCommandLiterals(content: string): AwCommandLiteral[] {
  const literals: AwCommandLiteral[] = []
  for (const line of content.split(/\r?\n/u)) {
    const pattern = /(?:^|&&|\|\||[;|&])\s*(aw[ \t]+[a-z][a-z0-9-]*[ \t]+[a-z][a-z0-9-]*.*?)(?=\s*(?:&&|\|\||[;|&]|$))/gu
    for (const match of line.matchAll(pattern)) {
      const literal = parseAwCommandAtStart(match[1] ?? '')
      if (literal) literals.push(literal)
    }
  }
  return literals
}

function nodeProcessCalls(content: string): Array<AwCommandLiteral | 'dynamic'> {
  const calls: Array<AwCommandLiteral | 'dynamic'> = []
  const pattern = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(["'])aw\1\s*(?:,\s*(\[[^\]]*\]|[^)\r\n]*))?/gu
  for (const match of content.matchAll(pattern)) {
    const argv = match[2] ? parseStaticStringArray(match[2]) : null
    if (!argv || argv.length < 2) {
      calls.push('dynamic')
      continue
    }
    calls.push({ group: argv[0]!, command: argv[1]!, tail: argv.slice(2).join(' ') })
  }
  return calls
}

function containsDynamicAwCommand(content: string): boolean {
  return /\baw\s+(?:["']?\$(?:\{|[A-Za-z_])|\$\{)/u.test(content)
    || /["'`]aw\s*["'`]\s*\+/u.test(content)
    || /["'`]aw["'`]\s*,\s*[A-Za-z_$]/u.test(content)
}

async function listFiles(root: string, predicate: (relativePath: string) => boolean): Promise<string[]> {
  if (!(await fs.pathExists(root))) return []
  const result: string[] = []
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join('/')
        if (predicate(relative)) result.push(absolute)
      }
    }
  }
  await visit(root)
  return result.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

export async function scanPluginAwCliRequirements(options: {
  pluginRoot: string
  manifest: PluginManifestSource | NormalizedPluginManifest
}): Promise<{ detected: AwCapabilityId[]; observations: PluginRequirementObservation[] }> {
  const roots: Array<{ root: string; predicate: (relativePath: string) => boolean }> = [
    {
      root: path.join(options.pluginRoot, 'skills'),
      predicate: (relativePath) => relativePath.endsWith('/SKILL.md') || relativePath === 'SKILL.md',
    },
    {
      root: path.join(options.pluginRoot, 'scripts'),
      predicate: (relativePath) => /\.(?:js|mjs|cjs|sh|bash|ps1)$/u.test(relativePath),
    },
  ]
  if (options.manifest.slashCommands) {
    roots.push({
      root: path.join(options.pluginRoot, options.manifest.slashCommands.replace(/^\.\//u, '')),
      predicate: (relativePath) => relativePath.endsWith('.md'),
    })
  }

  const files = (await Promise.all(roots.map(({ root, predicate }) => listFiles(root, predicate)))).flat()
  const observations: PluginRequirementObservation[] = []
  const observationKeys = new Set<string>()
  const detected: string[] = []
  const observe = (observation: PluginRequirementObservation): void => {
    const key = JSON.stringify([
      observation.code, observation.path, observation.command, observation.capability,
    ])
    if (observationKeys.has(key)) return
    observationKeys.add(key)
    observations.push(observation)
  }
  const recordLiteral = (relativePath: string, literal: AwCommandLiteral): void => {
    const command = `${literal.group} ${literal.command}`
    const capabilities = commandCapabilities(literal.group, literal.command, literal.tail)
    if (capabilities.length > 0) {
      for (const capability of capabilities) {
        detected.push(capability)
        observe({
          code: 'aw-command-detected', blocking: false, path: relativePath,
          command: `aw ${command}`, capability,
          message: `Detected AW CLI command literal: aw ${command}.`,
        })
      }
      return
    }
    observe({
      code: 'aw-command-unmapped', blocking: true, path: relativePath,
      command: `aw ${command}`,
      message: `AW CLI command literal has no capability mapping: aw ${command}.`,
    })
  }
  for (const file of [...new Set(files)].sort()) {
    const relativePath = path.relative(options.pluginRoot, file).split(path.sep).join('/')
    const content = await fs.readFile(file, 'utf8')
    const extension = path.extname(file).toLowerCase()
    if (extension === '.md') {
      for (const literal of markdownCommandLiterals(content)) recordLiteral(relativePath, literal)
    } else if (['.js', '.mjs', '.cjs'].includes(extension)) {
      for (const call of nodeProcessCalls(content)) {
        if (call === 'dynamic') {
          observe({
            code: 'aw-command-dynamic', blocking: false, path: relativePath,
            message: 'Dynamic AW CLI command construction cannot be mapped; declare its capability in a future manifest schema.',
          })
        } else {
          recordLiteral(relativePath, call)
        }
      }
    } else {
      for (const literal of shellCommandLiterals(content)) recordLiteral(relativePath, literal)
    }
    if (containsDynamicAwCommand(content)) {
      observe({
        code: 'aw-command-dynamic', blocking: false, path: relativePath,
        message: 'Dynamic AW CLI command construction cannot be mapped; declare its capability in a future manifest schema.',
      })
    }
  }
  return { detected: normalizeAwCapabilities(detected), observations }
}

export async function resolvePluginRequirements(options: {
  pluginRoot: string
  manifest: PluginManifestSource | NormalizedPluginManifest
  implementedCapabilities: readonly string[]
}): Promise<PluginRequirementsResolution> {
  const declared: AwCapabilityId[] = []
  const derived = deriveAwCapabilitiesFromManifest(options.manifest)
  const scan = await scanPluginAwCliRequirements(options)
  const effective = normalizeAwCapabilities([...declared, ...derived, ...scan.detected])
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
