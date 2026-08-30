import path from 'node:path'

import type { EvalCase, RuntimeCapabilities } from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'

import manifestSchema from '../../schemas/aw-skill-eval-manifest.schema.json' with { type: 'json' }
import {
  validateAwSkillEvalConversationCaseDocument,
  validateAwSkillEvalTriggerCaseDocument,
  type AwSkillEvalTriggerSuiteCaseContract,
} from '../../scripts/aw-skill-eval-cases.js'
import type { PluginMeta, Scope } from '../types.js'
import {
  isAwSkillEvalManifestV1,
  readAwSkillEvalManifestV1,
  type AwSkillEvalManifestV1,
} from './manifest-v1.js'

export const AW_SKILL_EVAL_MANIFEST_SCHEMA_VERSION = 1 as const
export const AW_SKILL_EVAL_MANIFEST_SCHEMA = manifestSchema as Record<string, unknown>

export type AwSkillEvalSplit = 'train' | 'validation' | 'sanity' | 'all'
export type AwSkillEvalIsolation = 'standard' | 'strict'

export interface AwSkillEvalProfile {
  id: string
  scope: Scope
  plugins: Array<{ name: string; config: Record<string, unknown> }>
  requiredForRelease: boolean
}

interface AwSkillEvalSuiteBase {
  id: string
  skills: string[]
  cases?: string
  profiles: string[]
  defaultRuns: number
  releaseSplits: AwSkillEvalSplit[]
  requiredForRelease: boolean
  perRunTimeoutMs: number
}

export interface AwSkillEvalTriggerSuite extends AwSkillEvalSuiteBase {
  kind: 'trigger'
  cases: string
  fixtureModule?: string
  observeSpawnAgent: boolean
  isolation: AwSkillEvalIsolation
  strictNegativeSplits: Array<Exclude<AwSkillEvalSplit, 'all'>>
  minimumPassRate?: number
  forbidMultipleSkillLoads: boolean
}

export interface AwSkillEvalConversationSuite extends AwSkillEvalSuiteBase {
  kind: 'conversation'
  cases: string
  isolation: AwSkillEvalIsolation
  environment?: { pathPrepend: string[] }
}

export interface AwSkillEvalProviderSuite extends AwSkillEvalSuiteBase {
  kind: 'provider'
  cases: string
  provider: {
    id: string
    entry: string
    assets: string[]
    credentialEnvironment: string[]
    capabilities: RuntimeCapabilities['capabilities']
  }
}

export interface AwSkillEvalCheckSuite extends AwSkillEvalSuiteBase {
  kind: 'check'
  checker: 'json-schema'
  document: string
  schema: string
}

export type AwSkillEvalSuite =
  | AwSkillEvalTriggerSuite
  | AwSkillEvalConversationSuite
  | AwSkillEvalProviderSuite
  | AwSkillEvalCheckSuite

export interface AwSkillEvalManifest {
  schemaVersion: typeof AW_SKILL_EVAL_MANIFEST_SCHEMA_VERSION
  plugin: string
  skill: string
  profiles: AwSkillEvalProfile[]
  suites: AwSkillEvalSuite[]
}

const safeIdPattern = /^[a-z0-9][a-z0-9-]*$/u
const splits = new Set<AwSkillEvalSplit>(['train', 'validation', 'sanity', 'all'])
const capabilityKeys: Array<keyof RuntimeCapabilities['capabilities']> = [
  'triggerDiscovery',
  'conversation',
  'skillPathExecution',
  'previousVersionBaseline',
  'withoutSkillBaseline',
  'cleanContext',
  'parallelRuns',
  'toolTrace',
  'tokenUsage',
  'duration',
  'sandbox',
  'materialization',
]

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`${label} has unknown field "${unknown}".`)
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string.`)
  return value
}

function safeId(value: unknown, label: string): string {
  const id = string(value, label)
  if (!safeIdPattern.test(id)) throw new Error(`${label} must use lowercase kebab-case.`)
  return id
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer.`)
  return value as number
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`)
  const result = value.map((entry, index) => string(entry, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`)
  return result
}

function ids(value: unknown, label: string): string[] {
  return strings(value, label).map((entry, index) => safeId(entry, `${label}[${index}]`))
}

function environmentNames(value: unknown, label: string): string[] {
  if (value === undefined) return []
  const names = strings(value, label)
  for (const [index, name] of names.entries()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`${label}[${index}] must be an environment variable name.`)
    }
  }
  return names
}

function isolation(value: unknown, label: string): AwSkillEvalIsolation {
  if (value !== 'standard' && value !== 'strict') throw new Error(`${label} must be standard or strict.`)
  return value
}

function relativePath(value: unknown, label: string): string {
  const raw = string(value, label)
  const normalized = raw.replace(/^\.\//u, '')
  if (
    normalized === ''
    || normalized.includes('\0')
    || normalized.includes('\\')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || path.posix.normalize(normalized) !== normalized
    || normalized.split('/').includes('..')
  ) throw new Error(`${label} must be a normalized path inside the Skill eval directory.`)
  return normalized
}

async function assertSafeEvalNode(
  evalRoot: string,
  relative: string,
  label: string,
  expected: 'file' | 'file-or-directory',
): Promise<void> {
  const requestedBoundary = path.resolve(evalRoot)
  const target = path.resolve(requestedBoundary, ...relative.split('/'))
  const relation = path.relative(requestedBoundary, target)
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} must stay inside the Skill eval directory.`)
  }
  const boundary = await fs.realpath(requestedBoundary)
  let current = boundary
  for (const segment of relation.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const info = await fs.lstat(current).catch(() => null)
    if (!info) throw new Error(`${label} does not exist.`)
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links.`)
  }
  const info = await fs.lstat(target)
  if (expected === 'file' && !info.isFile()) throw new Error(`${label} must be a regular file.`)
  if (expected === 'file-or-directory' && !info.isFile() && !info.isDirectory()) {
    throw new Error(`${label} must be a regular file or directory.`)
  }
  if (info.isDirectory()) {
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      await assertSafeEvalNode(
        evalRoot,
        path.posix.join(relative, entry.name),
        label,
        'file-or-directory',
      )
    }
  }
}

function parseProfiles(value: unknown, ownerPlugin: string): AwSkillEvalProfile[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('eval manifest.profiles must be a non-empty array.')
  const profiles = value.map((entry, index) => {
    const label = `profiles[${index}]`
    const row = record(entry, label)
    onlyKeys(row, ['id', 'scope', 'plugins', 'requiredForRelease'], label)
    const id = safeId(row.id, `${label}.id`)
    if (row.scope !== 'project' && row.scope !== 'user') throw new Error(`${label}.scope must be project or user.`)
    const scope: Scope = row.scope
    if (!Array.isArray(row.plugins) || row.plugins.length === 0) throw new Error(`${label}.plugins must be a non-empty array.`)
    const plugins = row.plugins.map((pluginEntry, pluginIndex) => {
      const pluginLabel = `${label}.plugins[${pluginIndex}]`
      const plugin = record(pluginEntry, pluginLabel)
      onlyKeys(plugin, ['name', 'config'], pluginLabel)
      if (!Object.hasOwn(plugin, 'config')) throw new Error(`${pluginLabel}.config is required.`)
      return {
        name: safeId(plugin.name, `${pluginLabel}.name`),
        config: record(plugin.config, `${pluginLabel}.config`),
      }
    })
    if (new Set(plugins.map((plugin) => plugin.name)).size !== plugins.length) {
      throw new Error(`${label}.plugins must not contain duplicates.`)
    }
    if (!plugins.some((plugin) => plugin.name === ownerPlugin)) {
      throw new Error(`${label}.plugins must include owner plugin "${ownerPlugin}".`)
    }
    return {
      id,
      scope,
      plugins,
      requiredForRelease: boolean(row.requiredForRelease, `${label}.requiredForRelease`),
    }
  })
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error('eval manifest.profiles contains duplicate ids.')
  }
  return profiles
}

function parseCapabilities(value: unknown, label: string): RuntimeCapabilities['capabilities'] {
  const row = record(value, label)
  onlyKeys(row, capabilityKeys, label)
  const result = {} as RuntimeCapabilities['capabilities']
  for (const key of capabilityKeys) result[key] = boolean(row[key], `${label}.${key}`)
  return result
}

function parseCommon(
  row: Record<string, unknown>,
  index: number,
  profileIds: ReadonlySet<string>,
  ownerSkill: string,
): AwSkillEvalSuiteBase {
  const label = `suites[${index}]`
  const suiteProfiles = ids(row.profiles, `${label}.profiles`)
  for (const profile of suiteProfiles) {
    if (!profileIds.has(profile)) throw new Error(`${label} references unknown profile "${profile}".`)
  }
  const skills = ids(row.skills, `${label}.skills`)
  if (!skills.includes(ownerSkill)) throw new Error(`${label}.skills must include owner Skill "${ownerSkill}".`)
  const releaseSplits = (Array.isArray(row.releaseSplits)
    ? row.releaseSplits
    : (() => { throw new Error(`${label}.releaseSplits must be an array.`) })())
      .map((entry, splitIndex) => {
        const split = string(entry, `${label}.releaseSplits[${splitIndex}]`)
        if (!splits.has(split as AwSkillEvalSplit)) throw new Error(`${label}.releaseSplits has unsupported split "${split}".`)
        return split as AwSkillEvalSplit
      })
  if (new Set(releaseSplits).size !== releaseSplits.length) throw new Error(`${label}.releaseSplits must not contain duplicates.`)
  const perRunTimeoutMs = positiveInteger(row.perRunTimeoutMs, `${label}.perRunTimeoutMs`)
  if (perRunTimeoutMs < 1000) throw new Error(`${label}.perRunTimeoutMs must be at least 1000.`)
  return {
    id: safeId(row.id, `${label}.id`),
    skills,
    profiles: suiteProfiles,
    defaultRuns: positiveInteger(row.defaultRuns, `${label}.defaultRuns`),
    releaseSplits,
    requiredForRelease: boolean(row.requiredForRelease, `${label}.requiredForRelease`),
    perRunTimeoutMs,
  }
}

async function parseSuites(
  value: unknown,
  evalRoot: string,
  profileIds: ReadonlySet<string>,
  ownerSkill: string,
): Promise<AwSkillEvalSuite[]> {
  if (!Array.isArray(value) || value.length === 0) throw new Error('eval manifest.suites must be a non-empty array.')
  const suites: AwSkillEvalSuite[] = []
  for (const [index, entry] of value.entries()) {
    const label = `suites[${index}]`
    const row = record(entry, label)
    const common = parseCommon(row, index, profileIds, ownerSkill)
    if (row.kind === 'trigger') {
      onlyKeys(row, [
        'id', 'kind', 'skills', 'cases', 'profiles', 'defaultRuns', 'releaseSplits',
        'requiredForRelease', 'perRunTimeoutMs', 'fixtureModule', 'observeSpawnAgent',
        'isolation', 'strictNegativeSplits', 'minimumPassRate', 'forbidMultipleSkillLoads',
      ], label)
      const cases = relativePath(row.cases, `${label}.cases`)
      await assertSafeEvalNode(evalRoot, cases, `${label}.cases`, 'file')
      const fixtureModule = row.fixtureModule === undefined
        ? undefined
        : relativePath(row.fixtureModule, `${label}.fixtureModule`)
      if (fixtureModule) await assertSafeEvalNode(evalRoot, fixtureModule, `${label}.fixtureModule`, 'file')
      const strictNegativeSplits = row.strictNegativeSplits === undefined
        ? []
        : (Array.isArray(row.strictNegativeSplits)
          ? row.strictNegativeSplits
          : (() => { throw new Error(`${label}.strictNegativeSplits must be an array.`) })())
          .map((entry, splitIndex) => string(entry, `${label}.strictNegativeSplits[${splitIndex}]`))
          .map((split) => {
          if (split === 'all' || !splits.has(split as AwSkillEvalSplit)) {
            throw new Error(`${label}.strictNegativeSplits has unsupported split "${split}".`)
          }
          return split as Exclude<AwSkillEvalSplit, 'all'>
        })
      if (new Set(strictNegativeSplits).size !== strictNegativeSplits.length) {
        throw new Error(`${label}.strictNegativeSplits must not contain duplicates.`)
      }
      const minimumPassRate = row.minimumPassRate
      if (minimumPassRate !== undefined && (
        typeof minimumPassRate !== 'number'
        || !Number.isFinite(minimumPassRate)
        || minimumPassRate <= 0
        || minimumPassRate > 1
      )) throw new Error(`${label}.minimumPassRate must be greater than 0 and at most 1.`)
      suites.push({
        ...common,
        kind: 'trigger',
        cases,
        ...(fixtureModule ? { fixtureModule } : {}),
        observeSpawnAgent: boolean(row.observeSpawnAgent, `${label}.observeSpawnAgent`),
        isolation: isolation(row.isolation, `${label}.isolation`),
        strictNegativeSplits,
        ...(minimumPassRate === undefined ? {} : { minimumPassRate }),
        forbidMultipleSkillLoads: row.forbidMultipleSkillLoads === undefined
          ? false
          : boolean(row.forbidMultipleSkillLoads, `${label}.forbidMultipleSkillLoads`),
      })
      continue
    }
    if (row.kind === 'conversation') {
      onlyKeys(row, [
        'id', 'kind', 'skills', 'cases', 'profiles', 'defaultRuns', 'releaseSplits',
        'requiredForRelease', 'perRunTimeoutMs', 'isolation', 'environment',
      ], label)
      const cases = relativePath(row.cases, `${label}.cases`)
      await assertSafeEvalNode(evalRoot, cases, `${label}.cases`, 'file')
      let environment: { pathPrepend: string[] } | undefined
      if (row.environment !== undefined) {
        const environmentRow = record(row.environment, `${label}.environment`)
        onlyKeys(environmentRow, ['pathPrepend'], `${label}.environment`)
        const pathPrepend = strings(environmentRow.pathPrepend, `${label}.environment.pathPrepend`)
          .map((entry, pathIndex) => relativePath(entry, `${label}.environment.pathPrepend[${pathIndex}]`))
        for (const [pathIndex, fixture] of pathPrepend.entries()) {
          if (pathPrepend.some((other, otherIndex) => otherIndex !== pathIndex && (
            fixture.startsWith(`${other}/`) || other.startsWith(`${fixture}/`)
          ))) throw new Error(`${label}.environment.pathPrepend entries must not overlap.`)
        }
        for (const [pathIndex, fixture] of pathPrepend.entries()) {
          await assertSafeEvalNode(evalRoot, fixture, `${label}.environment.pathPrepend[${pathIndex}]`, 'file-or-directory')
        }
        environment = { pathPrepend }
      }
      suites.push({
        ...common,
        kind: 'conversation',
        cases,
        isolation: isolation(row.isolation, `${label}.isolation`),
        ...(environment ? { environment } : {}),
      })
      continue
    }
    if (row.kind === 'provider') {
      onlyKeys(row, [
        'id', 'kind', 'skills', 'cases', 'profiles', 'defaultRuns', 'releaseSplits',
        'requiredForRelease', 'perRunTimeoutMs', 'provider',
      ], label)
      const cases = relativePath(row.cases, `${label}.cases`)
      await assertSafeEvalNode(evalRoot, cases, `${label}.cases`, 'file')
      const provider = record(row.provider, `${label}.provider`)
      onlyKeys(provider, [
        'id', 'entry', 'assets', 'credentialEnvironment', 'capabilities',
      ], `${label}.provider`)
      const entry = relativePath(provider.entry, `${label}.provider.entry`)
      if (!entry.endsWith('.mjs')) throw new Error(`${label}.provider.entry must be an .mjs file.`)
      await assertSafeEvalNode(evalRoot, entry, `${label}.provider.entry`, 'file')
      const assets = provider.assets === undefined
        ? []
        : strings(provider.assets, `${label}.provider.assets`)
          .map((asset, assetIndex) => relativePath(asset, `${label}.provider.assets[${assetIndex}]`))
      for (const [assetIndex, asset] of assets.entries()) {
        if (asset === entry || asset.startsWith(`${entry}/`) || entry.startsWith(`${asset}/`)) {
          throw new Error(`${label}.provider.assets[${assetIndex}] must not overlap provider.entry.`)
        }
        if (assets.some((other, otherIndex) => otherIndex !== assetIndex && (
          asset.startsWith(`${other}/`) || other.startsWith(`${asset}/`)
        ))) throw new Error(`${label}.provider.assets entries must not overlap.`)
        await assertSafeEvalNode(evalRoot, asset, `${label}.provider.assets[${assetIndex}]`, 'file-or-directory')
      }
      suites.push({
        ...common,
        kind: 'provider',
        cases,
        provider: {
          id: safeId(provider.id, `${label}.provider.id`),
          entry,
          assets,
          credentialEnvironment: environmentNames(
            provider.credentialEnvironment,
            `${label}.provider.credentialEnvironment`,
          ),
          capabilities: parseCapabilities(provider.capabilities, `${label}.provider.capabilities`),
        },
      })
      continue
    }
    if (row.kind === 'check') {
      onlyKeys(row, [
        'id', 'kind', 'skills', 'profiles', 'defaultRuns', 'releaseSplits',
        'requiredForRelease', 'perRunTimeoutMs', 'checker', 'document', 'schema',
      ], label)
      if (row.checker !== 'json-schema') throw new Error(`${label}.checker must be json-schema.`)
      const document = relativePath(row.document, `${label}.document`)
      const schema = relativePath(row.schema, `${label}.schema`)
      await assertSafeEvalNode(evalRoot, document, `${label}.document`, 'file')
      await assertSafeEvalNode(evalRoot, schema, `${label}.schema`, 'file')
      suites.push({ ...common, kind: 'check', checker: 'json-schema', document, schema })
      continue
    }
    throw new Error(`${label}.kind must be trigger, conversation, provider, or check.`)
  }
  if (new Set(suites.map((suite) => suite.id)).size !== suites.length) {
    throw new Error('eval manifest.suites contains duplicate ids.')
  }
  return suites
}

function genericCases(value: unknown, label: string): EvalCase[] {
  const rows = Array.isArray(value)
    ? value
    : (() => {
        const document = record(value, label)
        if (Array.isArray(document.cases)) return document.cases
        if (Array.isArray(document.evals)) return document.evals
        throw new Error(`${label} must be an array or contain cases/evals.`)
      })()
  if (rows.length === 0) throw new Error(`${label} must contain at least one case.`)
  const cases = rows.map((entry, index) => ({ ...record(entry, `${label}[${index}]`) })) as EvalCase[]
  const ids = cases.map((entry, index) => {
    const id = string(entry.id, `${label}[${index}].id`)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
      throw new Error(`${label}[${index}].id must be a safe path segment.`)
    }
    return id
  })
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids.`)
  return cases
}

async function readNormalizedCaseCorpora(
  suites: AwSkillEvalSuite[],
  evalRoot: string,
  ownerSkill: string,
): Promise<ReadonlyMap<string, EvalCase[]>> {
  const corpora = new Map<string, EvalCase[]>()
  for (const suite of suites) {
    if (suite.kind === 'check') continue
    const value = await fs.readJson(path.join(evalRoot, suite.cases))
    if (suite.kind === 'trigger') {
      const normalized = validateAwSkillEvalTriggerCaseDocument(value, {
        ...suite,
        skill: ownerSkill,
      } as AwSkillEvalTriggerSuiteCaseContract)
      corpora.set(suite.id, normalized.cases as unknown as EvalCase[])
      continue
    }
    if (suite.kind === 'conversation') {
      corpora.set(suite.id, validateAwSkillEvalConversationCaseDocument(
        value,
        ownerSkill,
        `conversation cases for suite "${suite.id}"`,
        evalRoot,
        suite.environment?.pathPrepend,
      ) as EvalCase[])
      continue
    }
    corpora.set(suite.id, genericCases(value, `provider cases for suite "${suite.id}"`))
  }
  return corpora
}

export async function readAwSkillEvalManifest(options: {
  plugin: PluginMeta
  skill: string
}): Promise<{
  manifest: AwSkillEvalManifest
  skillRoot: string
  evalRoot: string
  manifestPath: string
  casesBySuite: ReadonlyMap<string, EvalCase[]>
}> {
  const skill = safeId(options.skill, 'selected Skill')
  const skillRoot = path.join(options.plugin.rootDir, 'skills', skill)
  const evalRoot = path.join(skillRoot, 'evals')
  const manifestPath = path.join(evalRoot, 'manifest.json')
  await assertSafeEvalNode(evalRoot, 'manifest.json', 'eval manifest', 'file')
  const raw = record(await fs.readJson(manifestPath), 'eval manifest')
  onlyKeys(raw, ['schemaVersion', 'plugin', 'skill', 'profiles', 'suites'], 'eval manifest')
  if (raw.schemaVersion !== AW_SKILL_EVAL_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`eval manifest schemaVersion must be ${AW_SKILL_EVAL_MANIFEST_SCHEMA_VERSION}.`)
  }
  const plugin = safeId(raw.plugin, 'eval manifest.plugin')
  if (plugin !== options.plugin.manifest.name) {
    throw new Error(`eval manifest.plugin must match selected plugin "${options.plugin.manifest.name}".`)
  }
  const manifestSkill = safeId(raw.skill, 'eval manifest.skill')
  if (manifestSkill !== skill) throw new Error(`eval manifest.skill must match selected Skill "${skill}".`)
  const profiles = parseProfiles(raw.profiles, plugin)
  const suites = await parseSuites(raw.suites, evalRoot, new Set(profiles.map((profile) => profile.id)), skill)
  const ownsDynamicSkill = (options.plugin.manifest.artifacts?.targets ?? []).some((target) =>
    (target.target === 'codex.skill' || target.target === 'claude.skill')
    && target.skillKey === skill)
  if (ownsDynamicSkill && !suites.some((suite) => suite.requiredForRelease)) {
    throw new Error(
      `eval manifest.suites must include at least one release-required suite for dynamic Skill "${skill}".`,
    )
  }
  const casesBySuite = await readNormalizedCaseCorpora(suites, evalRoot, skill)
  return {
    manifest: {
      schemaVersion: AW_SKILL_EVAL_MANIFEST_SCHEMA_VERSION,
      plugin,
      skill,
      profiles,
      suites,
    },
    skillRoot,
    evalRoot,
    manifestPath,
    casesBySuite,
  }
}

export async function validateAwSkillEvalManifest(options: {
  plugin: PluginMeta
  skill: string
}): Promise<{
  valid: boolean
  errors: string[]
  manifest: AwSkillEvalManifest | AwSkillEvalManifestV1 | null
}> {
  try {
    if (await isAwSkillEvalManifestV1(options.plugin, options.skill)) {
      const result = await readAwSkillEvalManifestV1(options)
      return { valid: true, errors: [], manifest: result.manifest }
    }
    const result = await readAwSkillEvalManifest(options)
    return { valid: true, errors: [], manifest: result.manifest }
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      manifest: null,
    }
  }
}

export function assertNoSensitiveProfileConfig(
  profile: AwSkillEvalProfile,
  plugins: readonly PluginMeta[],
): void {
  const byName = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]))
  for (const installation of profile.plugins) {
    const plugin = byName.get(installation.name)
    if (!plugin) throw new Error(`Eval profile "${profile.id}" references unknown plugin "${installation.name}".`)
    for (const [key, field] of Object.entries(plugin.manifest.config?.schema ?? {})) {
      if (field.sensitive === true && Object.hasOwn(installation.config, key)) {
        throw new Error(`Eval profile "${profile.id}" provides a sensitive config field for plugin "${installation.name}".`)
      }
    }
  }
}
