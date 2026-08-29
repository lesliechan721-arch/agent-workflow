import path from 'node:path'

import fs from 'fs-extra'

import {
  computeAwCapabilitySetDigest,
  normalizeAwCapabilities,
  type AwCapabilityId,
} from './aw-capabilities.js'
import {
  matchesPluginTestEntryGlob,
  scanNodeImportContract,
  tokenizeJavaScriptImports,
} from './plugin-script-contract.js'
import { isSkillCollectionAuthorOnlyPath } from './skill-authoring.js'
import type { NormalizedPluginManifest, PluginManifestSource } from './types.js'

export interface PluginRequirementObservation {
  code: 'aw-command-detected' | 'aw-command-unmapped' | 'aw-command-dynamic'
  blocking: boolean
  path: string
  provenance?: 'shell-fence' | 'direct-command-line' | 'inline-code'
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
  'review publish': 'aw.review-publication.v1',
  'review digest': 'aw.review-publication.v1',
  'review verify': 'aw.review-publication.v1',
  'review list': 'aw.review-publication.v1',
  'review show': 'aw.review-publication.v1',
}

function commandCapabilities(group: string, command: string | undefined, tail: string): AwCapabilityId[] {
  if (command === undefined) return []
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
  command?: string
  tail: string
}

const AW_COMMAND_AT_START = /^\s*(?:\$\s+)?aw[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?(.*)$/u

function parseAwCommandAtStart(value: string): AwCommandLiteral | null {
  const match = AW_COMMAND_AT_START.exec(value)
  if (!match) return null
  return {
    group: match[1]!,
    ...(match[2] === undefined ? {} : { command: match[2] }),
    tail: match[3] ?? '',
  }
}

interface MarkdownAwCommandLiteral {
  literal: AwCommandLiteral
  provenance: 'shell-fence' | 'direct-command-line' | 'inline-code'
}

function markdownCommandLiterals(content: string): MarkdownAwCommandLiteral[] {
  const literals: MarkdownAwCommandLiteral[] = []
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (const line of content.split(/\r?\n/u)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)
    if (fenceMatch) {
      const delimiter = fenceMatch[1]!
      if (fence === null) {
        fence = { marker: delimiter[0] as '`' | '~', length: delimiter.length }
        continue
      }
      if (delimiter[0] === fence.marker && delimiter.length >= fence.length) {
        fence = null
        continue
      }
    }
    const direct = parseAwCommandAtStart(line)
    if (direct) {
      literals.push({
        literal: direct,
        provenance: fence === null ? 'direct-command-line' : 'shell-fence',
      })
    }
    if (fence !== null) continue
    for (const match of line.matchAll(/`([^`\r\n]+)`/gu)) {
      const inline = parseAwCommandAtStart(match[1] ?? '')
      if (inline) literals.push({ literal: inline, provenance: 'inline-code' })
    }
  }
  return literals
}

function shellCommandLiterals(content: string): AwCommandLiteral[] {
  const literals: AwCommandLiteral[] = []
  for (const line of content.split(/\r?\n/u)) {
    const pattern = /(?:^|&&|\|\||[;|&])\s*(aw[ \t]+[a-z][a-z0-9-]*(?:[ \t]+[a-z][a-z0-9-]*)?.*?)(?=\s*(?:&&|\|\||[;|&]|$))/gu
    for (const match of line.matchAll(pattern)) {
      const literal = parseAwCommandAtStart(match[1] ?? '')
      if (literal) literals.push(literal)
    }
  }
  return literals
}

function nodeProcessCalls(content: string): Array<AwCommandLiteral | 'dynamic'> {
  const calls: Array<AwCommandLiteral | 'dynamic'> = []
  const tokens = tokenizeJavaScriptImports(content)
  const processFunctions = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execFileAsync'])
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (
      token.kind !== 'identifier'
      || !processFunctions.has(token.value)
      || tokens[index + 1]?.value !== '('
      || tokens[index + 2]?.kind !== 'string'
      || tokens[index + 2]?.value !== 'aw'
    ) continue
    if (tokens[index + 3]?.value !== ',' || tokens[index + 4]?.value !== '[') {
      calls.push('dynamic')
      continue
    }
    const argv: string[] = []
    let cursor = index + 5
    let staticArray = true
    while (tokens[cursor]?.value !== ']') {
      const argument = tokens[cursor]
      if (argument?.kind !== 'string') {
        staticArray = false
        break
      }
      argv.push(argument.value)
      cursor += 1
      if (tokens[cursor]?.value === ',') cursor += 1
      else if (tokens[cursor]?.value !== ']') {
        staticArray = false
        break
      }
    }
    if (!staticArray || tokens[cursor]?.value !== ']' || argv.length === 0) {
      calls.push('dynamic')
      continue
    }
    calls.push({
      group: argv[0]!,
      ...(argv[1] === undefined ? {} : { command: argv[1] }),
      tail: argv.slice(2).join(' '),
    })
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
      if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules')) continue
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

function pluginRelativePath(value: string | undefined): string | null {
  if (value === undefined) return null
  const normalized = path.posix.normalize(value.replace(/^\.\//u, ''))
  return normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    ? null
    : normalized
}

type ScriptScanMode = 'node' | 'shell'

function inferredScriptScanMode(value: string): ScriptScanMode {
  return /\.(?:js|mjs|cjs)$/u.test(value) ? 'node' : 'shell'
}

function declaredPluginScriptPaths(
  manifest: PluginManifestSource | NormalizedPluginManifest,
): { productionModes: Map<string, Set<ScriptScanMode>>; productionNodeEntries: Set<string>; testGlobs: string[] } {
  const productionModes = new Map<string, Set<ScriptScanMode>>()
  const productionNodeEntries = new Set<string>()
  const addProduction = (value: string | undefined, mode?: ScriptScanMode): void => {
    const relative = pluginRelativePath(value)
    if (!relative) return
    const resolvedMode = mode ?? inferredScriptScanMode(relative)
    const modes = productionModes.get(relative) ?? new Set<ScriptScanMode>()
    modes.add(resolvedMode)
    productionModes.set(relative, modes)
    if (resolvedMode === 'node') productionNodeEntries.add(relative)
  }
  for (const definition of Object.values(manifest.scripts?.lifecycle ?? {})) {
    if (typeof definition === 'string') {
      addProduction(definition)
    } else {
      for (const entry of Object.values(definition ?? {})) {
        addProduction(
          entry?.path,
          entry?.runner === 'auto' || entry === undefined
            ? undefined
            : entry.runner === 'node' ? 'node' : 'shell',
        )
      }
    }
  }
  addProduction(manifest.scripts?.helpers?.config, 'node')
  addProduction(manifest.scripts?.node?.build?.path, 'node')
  addProduction(manifest.scripts?.artifacts?.render?.path, 'node')
  for (const entry of manifest.buildConfig?.skillRuntimeFiles ?? []) {
    if (entry.source !== undefined && entry.target.startsWith('scripts/')) {
      addProduction(entry.source)
    }
  }
  return {
    productionModes,
    productionNodeEntries,
    testGlobs: [...(manifest.scripts?.tests?.node ?? [])],
  }
}

async function productionNodeImportClosure(
  pluginRoot: string,
  entryFiles: ReadonlySet<string>,
): Promise<Set<string>> {
  if (entryFiles.size === 0) return new Set()
  const absoluteFiles = await listFiles(pluginRoot, () => true)
  const filePaths = absoluteFiles.map((file) => path.relative(pluginRoot, file).split(path.sep).join('/'))
  const files: Record<string, string> = {}
  await Promise.all(absoluteFiles.map(async (file, index) => {
    const relative = filePaths[index]!
    if (
      entryFiles.has(relative)
      || /\.(?:js|mjs|cjs)$/u.test(relative)
      || path.posix.basename(relative) === 'package.json'
    ) {
      files[relative] = await fs.readFile(file, 'utf8')
    }
  }))
  const scan = scanNodeImportContract({
    files,
    filePaths,
    entryFiles: [...entryFiles],
  })
  return new Set(scan.files.filter((file) => (
    entryFiles.has(file) || /\.(?:js|mjs|cjs)$/u.test(file)
  )))
}

function skillSourceRoot(pluginRoot: string, value: string): string | null {
  const root = path.resolve(pluginRoot, value)
  const relative = path.relative(pluginRoot, root)
  return relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? null
    : root
}

function isScannableSkillFile(relativePath: string): boolean {
  if (isSkillCollectionAuthorOnlyPath(relativePath)) return false
  const segments = relativePath.split('/')
  if (segments.at(-1) === 'SKILL.md') return true
  return segments[1] === 'scripts' && /\.(?:js|mjs|cjs|sh|bash|ps1|cmd|bat)$/u.test(relativePath)
}

export async function scanPluginAwCliRequirements(options: {
  pluginRoot: string
  manifest: PluginManifestSource | NormalizedPluginManifest
}): Promise<{ detected: AwCapabilityId[]; observations: PluginRequirementObservation[] }> {
  const roots: Array<{ root: string; predicate: (relativePath: string) => boolean }> = []
  const staticSkillRoots = new Set([
    options.manifest.skills,
    options.manifest.distributions?.agentSkills?.skills,
  ].filter((value): value is string => value !== undefined))
  for (const value of staticSkillRoots) {
    const root = skillSourceRoot(options.pluginRoot, value)
    if (root) roots.push({ root, predicate: isScannableSkillFile })
  }
  const pluginScripts = declaredPluginScriptPaths(options.manifest)
  const productionNodeFiles = await productionNodeImportClosure(
    options.pluginRoot,
    pluginScripts.productionNodeEntries,
  )
  for (const relativePath of productionNodeFiles) {
    const modes = pluginScripts.productionModes.get(relativePath) ?? new Set<ScriptScanMode>()
    modes.add('node')
    pluginScripts.productionModes.set(relativePath, modes)
  }
  roots.push({
    root: path.join(options.pluginRoot, 'scripts'),
    predicate: (relativePath) => /\.(?:js|mjs|cjs|sh|bash|ps1|cmd|bat)$/u.test(relativePath)
      && !pluginScripts.testGlobs.some((glob) => (
        matchesPluginTestEntryGlob(`scripts/${relativePath}`, glob)
      )),
  })
  if (options.manifest.slashCommands) {
    roots.push({
      root: path.join(options.pluginRoot, options.manifest.slashCommands.replace(/^\.\//u, '')),
      predicate: (relativePath) => relativePath.endsWith('.md'),
    })
  }

  const files = (await Promise.all(roots.map(({ root, predicate }) => listFiles(root, predicate)))).flat()
  for (const relativePath of pluginScripts.productionModes.keys()) {
    const file = path.join(options.pluginRoot, relativePath)
    if ((await fs.stat(file).catch(() => null))?.isFile()) files.push(file)
  }
  const observations: PluginRequirementObservation[] = []
  const observationKeys = new Set<string>()
  const detected: string[] = []
  const observe = (observation: PluginRequirementObservation): void => {
    const key = JSON.stringify([
      observation.code, observation.path, observation.provenance,
      observation.command, observation.capability,
    ])
    if (observationKeys.has(key)) return
    observationKeys.add(key)
    observations.push(observation)
  }
  const recordLiteral = (
    relativePath: string,
    literal: AwCommandLiteral,
    provenance?: PluginRequirementObservation['provenance'],
  ): void => {
    const command = [literal.group, literal.command].filter(Boolean).join(' ')
    const capabilities = commandCapabilities(literal.group, literal.command, literal.tail)
    if (capabilities.length > 0) {
      for (const capability of capabilities) {
        if (provenance !== 'inline-code') detected.push(capability)
        observe({
          code: 'aw-command-detected', blocking: false, path: relativePath,
          ...(provenance === undefined ? {} : { provenance }),
          command: `aw ${command}`, capability,
          message: provenance === 'inline-code'
            ? `Inline AW CLI command reference is advisory: aw ${command}.`
            : `Detected AW CLI command literal: aw ${command}.`,
        })
      }
      return
    }
    observe({
      code: 'aw-command-unmapped', blocking: provenance !== 'inline-code', path: relativePath,
      ...(provenance === undefined ? {} : { provenance }),
      command: `aw ${command}`,
      message: provenance === 'inline-code'
        ? `Inline AW CLI command reference has no capability mapping and is advisory: aw ${command}.`
        : `AW CLI command literal has no capability mapping: aw ${command}.`,
    })
  }
  for (const file of [...new Set(files)].sort()) {
    const relativePath = path.relative(options.pluginRoot, file).split(path.sep).join('/')
    const content = await fs.readFile(file, 'utf8')
    const extension = path.extname(file).toLowerCase()
    const declaredModes = pluginScripts.productionModes.get(relativePath)
    const nodeMode = declaredModes?.has('node') ?? ['.js', '.mjs', '.cjs'].includes(extension)
    const shellMode = declaredModes?.has('shell') ?? (
      extension !== '.md' && !['.js', '.mjs', '.cjs'].includes(extension)
    )
    if (extension === '.md' && declaredModes === undefined) {
      for (const entry of markdownCommandLiterals(content)) {
        recordLiteral(relativePath, entry.literal, entry.provenance)
      }
    }
    if (nodeMode) {
      for (const call of nodeProcessCalls(content)) {
        if (call === 'dynamic') {
          observe({
            code: 'aw-command-dynamic', blocking: false, path: relativePath,
            message: 'Dynamic AW CLI command construction cannot be mapped; declare its capability in requires.aw.capabilities.',
          })
        } else {
          recordLiteral(relativePath, call)
        }
      }
    }
    if (shellMode) {
      for (const literal of shellCommandLiterals(content)) recordLiteral(relativePath, literal)
      if (containsDynamicAwCommand(content)) {
        observe({
          code: 'aw-command-dynamic', blocking: false, path: relativePath,
          message: 'Dynamic AW CLI command construction cannot be mapped; declare its capability in requires.aw.capabilities.',
        })
      }
    }
  }
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
