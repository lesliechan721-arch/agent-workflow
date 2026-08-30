import path from 'node:path'

import {
  parseSelectedCases,
  type SelectedCasesDocument,
  type SelectedCaseSuiteKind,
} from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'

import type { PluginMeta, Scope } from '../types.js'

export interface AwSkillEvalManifestV1Defaults {
  profile?: string
  runs?: number
  timeoutMs?: number
}

export interface AwSkillEvalManifestV1Profile {
  id: string
  scope: Scope
  plugins: Array<{ name: string; config: Record<string, unknown> }>
}

export interface AwSkillEvalManifestV1Suite {
  id: string
  kind: SelectedCaseSuiteKind
  cases: string
  profiles?: string[]
  runs?: number
  timeoutMs?: number
  requiredForRelease?: boolean
  releaseSplits?: string[]
  provider?: { type: 'custom-process'; command: [string, ...string[]] }
}

export interface AwSkillEvalManifestV1 {
  version: 1
  defaults: AwSkillEvalManifestV1Defaults
  profiles: AwSkillEvalManifestV1Profile[]
  suites: AwSkillEvalManifestV1Suite[]
}

export interface LoadedAwSkillEvalManifestV1 {
  manifest: AwSkillEvalManifestV1
  skillRoot: string
  evalRoot: string
  manifestPath: string
  casesBySuite: ReadonlyMap<string, SelectedCasesDocument>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !keys.has(key))
  if (unknown) throw new Error(`${label} has unknown field ${JSON.stringify(unknown)}.`)
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new Error(`${label} must use lowercase kebab-case.`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer.`)
  }
  return value as number
}

function relativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string.`)
  if (
    value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) || path.posix.normalize(value) !== value ||
    value.split('/').includes('..')
  ) throw new Error(`${label} must be a normalized path inside the Skill eval directory.`)
  return value
}

function safeIdArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an array' : 'a non-empty array'}.`)
  }
  const result = value.map((entry, index) => safeId(entry, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique values.`)
  return result
}

async function assertSafeFile(root: string, relative: string, label: string): Promise<string> {
  const target = path.resolve(root, relative)
  const relation = path.relative(root, target)
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} must stay inside the Skill eval directory.`)
  }
  let current = path.resolve(root)
  for (const segment of relation.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const info = await fs.lstat(current).catch(() => null)
    if (!info) throw new Error(`${label} does not exist.`)
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links.`)
  }
  if (!(await fs.lstat(target)).isFile()) throw new Error(`${label} must be a regular file.`)
  return target
}

function parseDefaults(value: unknown): AwSkillEvalManifestV1Defaults {
  const row = record(value, 'eval manifest.defaults')
  onlyKeys(row, ['profile', 'runs', 'timeoutMs'], 'eval manifest.defaults')
  return {
    ...(row.profile === undefined ? {} : { profile: safeId(row.profile, 'eval manifest.defaults.profile') }),
    ...(row.runs === undefined ? {} : { runs: positiveInteger(row.runs, 'eval manifest.defaults.runs') }),
    ...(row.timeoutMs === undefined
      ? {}
      : { timeoutMs: positiveInteger(row.timeoutMs, 'eval manifest.defaults.timeoutMs') }),
  }
}

function parseProfiles(value: unknown, ownerPlugin: string): AwSkillEvalManifestV1Profile[] {
  const profiles = record(value, 'eval manifest.profiles')
  if (Object.keys(profiles).length === 0) throw new Error('eval manifest.profiles must not be empty.')
  return Object.entries(profiles).map(([idValue, entry]) => {
    const id = safeId(idValue, 'eval manifest profile id')
    const row = record(entry, `eval manifest.profiles.${id}`)
    onlyKeys(row, ['scope', 'plugins'], `eval manifest.profiles.${id}`)
    if (row.scope !== 'project' && row.scope !== 'user') {
      throw new Error(`eval manifest.profiles.${id}.scope must be project or user.`)
    }
    const plugins = record(row.plugins, `eval manifest.profiles.${id}.plugins`)
    if (Object.keys(plugins).length === 0) {
      throw new Error(`eval manifest.profiles.${id}.plugins must not be empty.`)
    }
    const result: AwSkillEvalManifestV1Profile = {
      id,
      scope: row.scope,
      plugins: Object.entries(plugins).map(([nameValue, config]) => ({
        name: safeId(nameValue, `eval manifest.profiles.${id}.plugins name`),
        config: record(config, `eval manifest.profiles.${id}.plugins.${nameValue}`),
      })),
    }
    if (!result.plugins.some((plugin) => plugin.name === ownerPlugin)) {
      throw new Error(`eval manifest.profiles.${id} must include owner plugin ${JSON.stringify(ownerPlugin)}.`)
    }
    return result
  })
}

function parseProvider(value: unknown, label: string): AwSkillEvalManifestV1Suite['provider'] {
  const row = record(value, label)
  onlyKeys(row, ['type', 'command'], label)
  if (row.type !== 'custom-process') throw new Error(`${label}.type must be custom-process.`)
  if (
    !Array.isArray(row.command) || row.command.length === 0 ||
    row.command.some((entry) => typeof entry !== 'string' || entry.trim() === '' || entry.includes('\0'))
  ) throw new Error(`${label}.command must be a non-empty array of non-empty strings.`)
  const executable = row.command[0] as string
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(executable)) {
    throw new Error(`${label}.command[0] must be a bare system executable name.`)
  }
  for (const [index, argument] of (row.command as string[]).entries()) {
    if (index === 0) continue
    if (
      argument.includes('\\')
      || path.posix.isAbsolute(argument)
      || path.win32.isAbsolute(argument)
      || /(?:^|[=/])\.\.(?:[=/]|$)/u.test(argument)
      || /(?:^|=)(?:\/|[A-Za-z]:\/)/u.test(argument)
    ) throw new Error(`${label}.command[${index}] must not escape the Skill eval directory.`)
  }
  return { type: 'custom-process', command: row.command as [string, ...string[]] }
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith('./')
    || value.includes('/')
    || /\.(?:cjs|js|json|mjs|py|sh|ts)$/u.test(value)
}

async function assertSafeAsset(root: string, relative: string, label: string): Promise<void> {
  const target = path.resolve(root, relative)
  const relation = path.relative(root, target)
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} must stay inside the Skill eval directory.`)
  }
  let current = path.resolve(root)
  for (const segment of relation.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const info = await fs.lstat(current).catch(() => null)
    if (!info) throw new Error(`${label} does not exist.`)
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links.`)
  }
  const info = await fs.lstat(target)
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error(`${label} must be a regular file or directory.`)
  }
}

export async function resolveAwSkillEvalCustomCommand(
  evalRoot: string,
  provider: NonNullable<AwSkillEvalManifestV1Suite['provider']>,
): Promise<{
  command: [string, ...string[]]
  localArguments: ReadonlyMap<number, { prefix: string; relative: string }>
}> {
  const command = [...provider.command] as [string, ...string[]]
  const localArguments = new Map<number, { prefix: string; relative: string }>()
  for (let index = 1; index < command.length; index += 1) {
    const value = command[index]!
    const assignment = value.indexOf('=')
    const prefix = assignment === -1 ? '' : value.slice(0, assignment + 1)
    const candidate = assignment === -1 ? value : value.slice(assignment + 1)
    const normalized = candidate.replace(/^\.\//u, '')
    const exists = await fs.pathExists(path.join(evalRoot, normalized))
    if (!looksLikeLocalPath(candidate) && !exists) continue
    if (
      normalized === ''
      || normalized.includes('\\')
      || path.posix.isAbsolute(normalized)
      || path.win32.isAbsolute(normalized)
      || path.posix.normalize(normalized) !== normalized
      || normalized.split('/').includes('..')
    ) throw new Error(`custom provider command[${index}] must be a normalized Eval-local path.`)
    await assertSafeAsset(evalRoot, normalized, `custom provider command[${index}]`)
    localArguments.set(index, { prefix, relative: normalized })
  }
  return { command, localArguments }
}

function parseSuites(value: unknown, profileIds: ReadonlySet<string>): AwSkillEvalManifestV1Suite[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('eval manifest.suites must be a non-empty array.')
  const suites = value.map((entry, index) => {
    const label = `eval manifest.suites[${index}]`
    const row = record(entry, label)
    onlyKeys(row, [
      'id', 'kind', 'cases', 'profiles', 'runs', 'timeoutMs', 'requiredForRelease',
      'releaseSplits', 'provider',
    ], label)
    const id = safeId(row.id, `${label}.id`)
    if (row.kind !== 'trigger' && row.kind !== 'conversation' && row.kind !== 'custom-process') {
      throw new Error(`${label}.kind must be trigger, conversation, or custom-process.`)
    }
    const profiles = row.profiles === undefined ? undefined : safeIdArray(row.profiles, `${label}.profiles`)
    const unknownProfile = profiles?.find((profile) => !profileIds.has(profile))
    if (unknownProfile) throw new Error(`${label} references unknown profile ${JSON.stringify(unknownProfile)}.`)
    if (row.requiredForRelease !== undefined && typeof row.requiredForRelease !== 'boolean') {
      throw new Error(`${label}.requiredForRelease must be boolean.`)
    }
    const releaseSplits = row.releaseSplits === undefined
      ? undefined
      : safeIdArray(row.releaseSplits, `${label}.releaseSplits`, true)
    const provider = row.provider === undefined ? undefined : parseProvider(row.provider, `${label}.provider`)
    if (row.kind === 'custom-process' && !provider) throw new Error(`${label} custom-process requires provider.`)
    if (row.kind !== 'custom-process' && provider) throw new Error(`${label} built-in kind must not declare provider.`)
    return {
      id,
      kind: row.kind,
      cases: relativePath(row.cases, `${label}.cases`),
      ...(profiles ? { profiles } : {}),
      ...(row.runs === undefined ? {} : { runs: positiveInteger(row.runs, `${label}.runs`) }),
      ...(row.timeoutMs === undefined
        ? {}
        : { timeoutMs: positiveInteger(row.timeoutMs, `${label}.timeoutMs`) }),
      ...(row.requiredForRelease === undefined ? {} : { requiredForRelease: row.requiredForRelease }),
      ...(releaseSplits ? { releaseSplits } : {}),
      ...(provider ? { provider } : {}),
    } as AwSkillEvalManifestV1Suite
  })
  if (new Set(suites.map((suite) => suite.id)).size !== suites.length) {
    throw new Error('eval manifest.suites must contain unique ids.')
  }
  return suites
}

export async function isAwSkillEvalManifestV1(plugin: PluginMeta, skill: string): Promise<boolean> {
  const selectedSkill = safeId(skill, 'selected Skill')
  const manifestPath = path.join(plugin.rootDir, 'skills', selectedSkill, 'evals', 'manifest.json')
  const value = await fs.readJson(manifestPath) as Record<string, unknown>
  return value.version === 1
}

export async function readAwSkillEvalManifestV1(options: {
  plugin: PluginMeta
  skill: string
}): Promise<LoadedAwSkillEvalManifestV1> {
  const skill = safeId(options.skill, 'selected Skill')
  const skillRoot = path.join(options.plugin.rootDir, 'skills', skill)
  const evalRoot = path.join(skillRoot, 'evals')
  const manifestPath = await assertSafeFile(evalRoot, 'manifest.json', 'eval manifest')
  const raw = record(await fs.readJson(manifestPath), 'eval manifest')
  onlyKeys(raw, ['version', 'defaults', 'profiles', 'suites'], 'eval manifest')
  if (raw.version !== 1) throw new Error('eval manifest.version must be 1.')
  const defaults = parseDefaults(raw.defaults)
  const profiles = parseProfiles(raw.profiles, options.plugin.manifest.name)
  if (defaults.profile && !profiles.some((profile) => profile.id === defaults.profile)) {
    throw new Error('eval manifest.defaults.profile references an unknown profile.')
  }
  const suites = parseSuites(raw.suites, new Set(profiles.map((profile) => profile.id)))
  const ownsDynamicSkill = (options.plugin.manifest.artifacts?.targets ?? []).some((target) =>
    (target.target === 'codex.skill' || target.target === 'claude.skill')
    && target.skillKey === skill)
  if (ownsDynamicSkill && !suites.some((suite) => suite.requiredForRelease)) {
    throw new Error(
      `eval manifest.suites must include at least one release-required suite for dynamic Skill "${skill}".`,
    )
  }
  const casesBySuite = new Map<string, SelectedCasesDocument>()
  for (const suite of suites) {
    if (suite.provider) await resolveAwSkillEvalCustomCommand(evalRoot, suite.provider)
    const casesPath = await assertSafeFile(evalRoot, suite.cases, `eval suite ${JSON.stringify(suite.id)} cases`)
    const document = parseSelectedCases(await fs.readJson(casesPath))
    if (document.suite.kind !== suite.kind) {
      throw new Error(`eval suite ${JSON.stringify(suite.id)} kind does not match its case corpus.`)
    }
    if (document.suite.unitUnderTest !== skill) {
      throw new Error(`eval suite ${JSON.stringify(suite.id)} unitUnderTest must match selected Skill ${JSON.stringify(skill)}.`)
    }
    casesBySuite.set(suite.id, document)
  }
  return {
    manifest: { version: 1, defaults, profiles, suites },
    skillRoot,
    evalRoot,
    manifestPath,
    casesBySuite,
  }
}
