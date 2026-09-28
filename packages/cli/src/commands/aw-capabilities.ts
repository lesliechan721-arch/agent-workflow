import crypto from 'node:crypto'
import path from 'node:path'

import {
  readCatalogWorkspace,
  type PluginMeta,
} from '@lesliechan721/aw-plugin-core'
import {
  checkAwCapabilitySupport,
  createAwPluginRequirementsReceipt,
  computeAwCapabilitySetDigest,
  getPluginCoreVersion,
  parseAwPluginRequirementsReceipt,
  resolvePluginRequirements,
  normalizeAwCapabilities,
  type AwPluginRequirementsReceiptV1,
  type PluginRequirementsResolution,
  type RegisteredAwCapabilityId,
} from '@lesliechan721/aw-plugin-core/manifest'
import fs from 'fs-extra'

import { CLI_RESERVED_IMPORTS, readPluginManifest } from '../utils/manifest.js'
import {
  resolveCatalogWorkspaceRoot,
  type CatalogWorkspaceResolvedFrom,
} from './catalog-workspace-resolution.js'

export const IMPLEMENTED_AW_CAPABILITIES = [
  'aw.plugin-manifest.v3',
  'aw.plugin-skills.v1',
  'aw.plugin-build-config.v1',
  'aw.plugin-config.v2',
  'aw.plugin-config.v3',
  'aw.plugin-config-array.v1',
  'aw.plugin-config-summary.v1',
  'aw.plugin-pre-apply.v1',
  'aw.dynamic-artifacts.v2',
  'aw.portable-skills.v1',
  'aw.runtime-imports.v1',
  'aw.skill-validation.v1',
  'aw.skill-eval.v2',
  'aw.plugin-authoring.v1',
  'aw.catalog-authoring.v1',
  'aw.catalog-source.v2',
  'aw.catalog-dev-source.v1',
  'aw.catalog-publication.v1',
  'aw.review-preparation.v1',
  'aw.review-inspection.v2',
  'aw.review-publication.v1',
  'aw.catalog-snapshot.v7',
  'aw.self-check.v1',
  'aw.plugin-recovery.v1',
] as const satisfies readonly RegisteredAwCapabilityId[]

export class AwCapabilityUnsupportedError extends Error {
  readonly code = 'awCapabilityUnsupported'
  readonly plugin: string
  readonly missingCapabilities: string[]
  readonly availableCapabilities: string[]

  constructor(plugin: string, missingCapabilities: readonly string[]) {
    const missing = [...missingCapabilities]
    super(`Plugin "${plugin}" requires unsupported AW capabilities: ${missing.join(', ')}.`)
    this.name = 'AwCapabilityUnsupportedError'
    this.plugin = plugin
    this.missingCapabilities = missing
    this.availableCapabilities = [...IMPLEMENTED_AW_CAPABILITIES].sort()
  }
}

export interface AwSelfDescribeResult {
  schemaVersion: 1
  command: 'self:describe'
  awVersion: string
  coreVersion: string
  capabilities: string[]
  capabilitySetDigest: string
}

export function describeCurrentAw(awVersion: string): AwSelfDescribeResult {
  const capabilities = [...IMPLEMENTED_AW_CAPABILITIES].sort()
  return {
    schemaVersion: 1,
    command: 'self:describe',
    awVersion,
    coreVersion: getPluginCoreVersion(),
    capabilities,
    capabilitySetDigest: computeAwCapabilitySetDigest(capabilities),
  }
}

interface DiscoveredRequirements {
  source: { kind: 'receipt' | 'manifest'; path: string }
  plugin: { name: string; version: string }
  requiredCapabilities: string[]
  capabilitySetDigest: string
  resolution?: PluginRequirementsResolution
}

async function startDirectory(from: string): Promise<string> {
  const resolved = path.resolve(from)
  const stats = await fs.stat(resolved)
  return stats.isDirectory() ? resolved : path.dirname(resolved)
}

async function candidateExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(filePath)
    if (!stats.isFile()) throw new Error(`Invalid AW plugin requirements candidate: expected a regular file at ${filePath}.`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function requirementsFromManifest(pluginRoot: string): Promise<DiscoveredRequirements> {
  let plugin: Awaited<ReturnType<typeof readPluginManifest>>
  try {
    plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' })
  } catch (bundleError) {
    try {
      plugin = await readPluginManifest(pluginRoot, { mode: 'source' })
    } catch {
      throw bundleError
    }
  }
  const resolution = await resolvePluginRequirements({
    pluginRoot,
    manifest: plugin.manifest,
    implementedCapabilities: IMPLEMENTED_AW_CAPABILITIES,
  })
  return {
    source: { kind: 'manifest', path: plugin.manifestPath },
    plugin: { name: plugin.manifest.name, version: plugin.manifest.version },
    requiredCapabilities: resolution.effective,
    capabilitySetDigest: resolution.capabilitySetDigest,
    resolution,
  }
}

export async function discoverAwPluginRequirements(from: string): Promise<DiscoveredRequirements> {
  let current = await startDirectory(from)
  while (true) {
    const receiptPath = path.join(current, 'aw-plugin-requirements.json')
    if (await candidateExists(receiptPath)) {
      const receipt = parseAwPluginRequirementsReceipt(await fs.readJson(receiptPath) as unknown)
      return {
        source: { kind: 'receipt', path: receiptPath },
        plugin: receipt.plugin,
        requiredCapabilities: receipt.requiredCapabilities,
        capabilitySetDigest: receipt.digest,
      }
    }
    const manifestPath = path.join(current, '.agents-plugin', 'plugin.json')
    if (await candidateExists(manifestPath)) return requirementsFromManifest(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('No aw-plugin-requirements.json or .agents-plugin/plugin.json was found.')
}

export interface AwSelfCheckResult {
  schemaVersion: 1
  command: 'self:check'
  ok: boolean
  awVersion: string
  coreVersion: string
  source: DiscoveredRequirements['source'] | null
  plugin: DiscoveredRequirements['plugin'] | null
  requiredCapabilities: string[]
  capabilitySetDigest: string | null
  missingCapabilities: string[]
  observations: PluginRequirementsResolution['observations']
  error?: string
}

export async function checkCurrentAw(options: {
  awVersion: string
  from: string
}): Promise<AwSelfCheckResult> {
  try {
    const discovered = await discoverAwPluginRequirements(options.from)
    const support = checkAwCapabilitySupport(
      discovered.requiredCapabilities,
      IMPLEMENTED_AW_CAPABILITIES,
    )
    const observations = discovered.resolution?.observations ?? []
    return {
      schemaVersion: 1,
      command: 'self:check',
      ok: support.supported,
      awVersion: options.awVersion,
      coreVersion: getPluginCoreVersion(),
      source: discovered.source,
      plugin: discovered.plugin,
      requiredCapabilities: discovered.requiredCapabilities,
      capabilitySetDigest: discovered.capabilitySetDigest,
      missingCapabilities: support.missing,
      observations,
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      command: 'self:check',
      ok: false,
      awVersion: options.awVersion,
      coreVersion: getPluginCoreVersion(),
      source: null,
      plugin: null,
      requiredCapabilities: [],
      capabilitySetDigest: null,
      missingCapabilities: [],
      observations: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface PluginRequirementsResult extends PluginRequirementsResolution {
  command: 'plugin:requirements'
  plugin: { name: string; version: string }
  pluginDirectory: string
  workspaceRoot: string
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom
  mutation?: {
    action: 'add' | 'remove'
    capability: string
    changed: boolean
  }
}

async function resolveCanonicalPluginRequirementsTarget(options: {
  pluginDirectory: string
  workspaceRoot?: string
  cwd: string
}): Promise<{
  plugin: PluginMeta
  workspaceRoot: string
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom
}> {
  const requestedPluginRoot = path.resolve(options.cwd, options.pluginDirectory)
  const workspaceResolution = await resolveCatalogWorkspaceRoot({
    cwd: requestedPluginRoot,
    ...(options.workspaceRoot === undefined
      ? {}
      : { explicitRoot: path.resolve(options.cwd, options.workspaceRoot) }),
    mode: 'existing',
  })
  const workspace = await readCatalogWorkspace(workspaceResolution.workspaceRoot, {
    reservedImports: CLI_RESERVED_IMPORTS,
  })
  const stat = await fs.lstat(requestedPluginRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Plugin directory must be a regular non-symbolic-link directory: ${requestedPluginRoot}`)
  }
  const canonicalPluginRoot = await fs.realpath(requestedPluginRoot)
  const plugin = workspace.plugins.find((entry) => entry.rootDir === canonicalPluginRoot)
  const expectedPluginRoot = plugin
    ? path.join(workspace.workspaceRoot, 'plugins', plugin.manifest.name)
    : null
  if (
    !plugin
    || expectedPluginRoot !== canonicalPluginRoot
  ) {
    throw new Error(`Plugin directory is not a canonical plugin in this Catalog Workspace: ${requestedPluginRoot}`)
  }
  return {
    plugin,
    workspaceRoot: workspace.workspaceRoot,
    workspaceRootResolvedFrom: workspaceResolution.workspaceRootResolvedFrom,
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  )
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  try {
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.remove(temporaryPath)
    throw error
  }
}

export async function inspectPluginRequirements(options: {
  pluginDirectory: string
  workspaceRoot?: string
  cwd: string
  add?: string
  remove?: string
}): Promise<PluginRequirementsResult> {
  if (options.add !== undefined && options.remove !== undefined) {
    throw new Error('Use exactly one of --add or --remove.')
  }
  const target = await resolveCanonicalPluginRequirementsTarget(options)
  const pluginRoot = target.plugin.rootDir
  let plugin = target.plugin
  let mutation: PluginRequirementsResult['mutation']
  const action = options.add === undefined
    ? (options.remove === undefined ? undefined : 'remove')
    : 'add'
  const capability = options.add ?? options.remove
  const initialResolution = await resolvePluginRequirements({
    pluginRoot,
    manifest: plugin.manifest,
    implementedCapabilities: IMPLEMENTED_AW_CAPABILITIES,
  })
  if (action && capability) {
    const normalizedCapability = normalizeAwCapabilities([capability], `--${action}`)[0]!
    const before = normalizeAwCapabilities(plugin.manifest.requires?.aw.capabilities ?? [])
    const after = action === 'add'
      ? normalizeAwCapabilities([...before, normalizedCapability])
      : before.filter((value) => value !== normalizedCapability)
    const changed = before.length !== after.length
    if (changed) {
      const raw = await fs.readJson(plugin.manifestPath) as Record<string, unknown>
      raw.requires = { aw: { capabilities: after } }
      await writeJsonAtomic(plugin.manifestPath, raw)
      plugin = await readPluginManifest(pluginRoot, { mode: 'source' })
    }
    mutation = { action, capability: normalizedCapability, changed }
  }
  const resolution = mutation?.changed
    ? await resolvePluginRequirements({
        pluginRoot,
        manifest: plugin.manifest,
        implementedCapabilities: IMPLEMENTED_AW_CAPABILITIES,
      })
    : initialResolution
  return {
    command: 'plugin:requirements',
    plugin: { name: plugin.manifest.name, version: plugin.manifest.version },
    pluginDirectory: pluginRoot,
    workspaceRoot: target.workspaceRoot,
    workspaceRootResolvedFrom: target.workspaceRootResolvedFrom,
    ...(mutation ? { mutation } : {}),
    ...resolution,
  }
}

export function createRequirementsReceipt(
  plugin: { name: string; version: string },
  requiredCapabilities: string[],
): AwPluginRequirementsReceiptV1 {
  return createAwPluginRequirementsReceipt(plugin, requiredCapabilities)
}
