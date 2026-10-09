import crypto from 'node:crypto'
import path from 'node:path'

import {
  canonicalJson,
  computeCanonicalDirectoryDigest,
  computeEvalFileDigest,
  computeEvalProviderDigest,
  computeSkillDigest,
} from '@lesliechan721/agent-skill-eval'
import {
  calculateCatalogWorkspaceSourceIdentity,
  GENERATED_OUTPUT_MARKER_FILENAME,
  readCatalogWorkspace,
  formatPluginConfigIssue,
  validatePluginConfigCandidate,
  type CatalogWorkspace,
} from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'

import type { AwSkillEvalMaterializationProfile } from '../../scripts/aw-skill-eval-materializer.js'
import {
  assertNoSensitiveProfileConfig,
  readAwSkillEvalManifest,
  type AwSkillEvalManifestV1Profile,
} from '../eval/manifest-v1.js'
import type { CatalogSourceResolution, PluginMeta, Scope } from '../types.js'
import { resolveArtifactRenderConfig, type ResolvedArtifactRenderConfig } from '../utils/artifact-renderer.js'
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js'
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js'
import {
  parseAwSourceBindingEvalInput,
  resolveAwSourceBindingEvalProvider,
  resolveEvalSourceBindingInput,
  type AwSourceBindingEvalInput,
} from './eval-source-input.js'
import { normalizeReviewProfileConfig, parseReviewProfile } from './review-profile.js'
import { resolveReviewSelection } from './review-selection.js'
import type { ReviewProfile, ReviewProfileConfig } from './review-types.js'

export {
  computeAwSourceBindingSelectedCasesDigest,
  computeAwSourceBindingSuiteDefaultsDigest,
  resolveAwSourceBindingEvalProvider,
  resolveEvalSourceBindingInput,
  selectAwSourceBindingEvalCases,
  type AwSourceBindingEvalCaseSelection,
  type AwSourceBindingEvalInput,
  type ResolvedEvalSourceBindingInput,
} from './eval-source-input.js'

export const AW_SOURCE_BINDING_FILENAME = 'aw-source-binding.json'

const digestPattern = /^sha256:[0-9a-f]{64}$/u
const safeIdPattern = /^[a-z0-9][a-z0-9-]*$/u
const unsupportedV1Message =
  'AW source binding schema version 1 is unsupported. Run "aw skill eval prepare" or "aw skill materialize" again.'

export interface AwWorkspaceBindingSource {
  kind: 'workspace'
  workspaceIdentity: string
  sourceIdentity: string
}

export interface AwCatalogSnapshotBindingSource {
  kind: 'catalog-snapshot'
  sourceId: string
  catalogSourceIdentity: string
  logicalIdentity: string
  snapshotDigest: string
  workspaceIdentity: string
  workspaceSourceIdentity: string
}

export type AwSourceBindingSource = AwWorkspaceBindingSource | AwCatalogSnapshotBindingSource

export interface AwSourceBindingSubject {
  plugin: string
  skill?: string
  suite?: string
}

export type AwSourceBindingProfile =
  | { kind: 'eval'; id: string; scope: Scope; inputDigest: string; config?: ReviewProfileConfig }
  | { kind: 'portable'; id: `agent-skills-${Scope}`; scope: Scope; inputDigest: string }
  | ReviewProfile

export type AwSourceBindingArtifact =
  | { kind: 'eval-target'; skill: string; path: string; digest: string }
  | { kind: 'eval-workspace'; path: string; digest: string }
  | { kind: 'eval-cases'; path: string; digest: string }
  | { kind: 'portable-skill'; plugin: string; skill: string; path: string; digest: string }
  | { kind: 'review-skill'; plugin: string; skill: string; path: string; digest: string }

export type AwSourceBindingArtifactInput =
  | { kind: 'eval-target'; skill: string; path: string }
  | { kind: 'eval-workspace'; path: string }
  | { kind: 'eval-cases'; path: string }
  | { kind: 'portable-skill'; plugin: string; skill: string; path: string }
  | { kind: 'review-skill'; plugin: string; skill: string; path: string }

export type AwSourceBindingVerifiedOutput = AwSourceBindingArtifact

export interface AwSourceBindingV2 {
  schemaVersion: 2
  kind: 'aw-source-binding'
  source: AwSourceBindingSource
  subject: AwSourceBindingSubject
  profile: AwSourceBindingProfile
  evalInput?: AwSourceBindingEvalInput
  artifacts: AwSourceBindingArtifact[]
  finalDigest: string
}

export interface AwSourceBindingIssue {
  code:
    | 'sourceBindingMissing'
    | 'sourceBindingInvalid'
    | 'sourceBindingSubjectDrift'
    | 'sourceBindingSourceDrift'
    | 'sourceBindingProfileDrift'
    | 'sourceBindingEvalInputDrift'
    | 'sourceBindingArtifactDrift'
  message: string
}

export type AwSourceBindingValidation =
  | {
      state: 'verified'
      binding: AwSourceBindingV2
      outputs: AwSourceBindingVerifiedOutput[]
      issues: []
    }
  | {
      state: 'incomplete' | 'invalid' | 'drifted'
      binding: AwSourceBindingV2 | null
      outputs: []
      issues: AwSourceBindingIssue[]
    }

export interface WriteAwSourceBindingOptions {
  rootDir: string
  source: AwSourceBindingSource
  subject: AwSourceBindingSubject
  profile: AwSourceBindingProfile
  evalInput?: AwSourceBindingEvalInput
  artifacts: AwSourceBindingArtifactInput[]
}

export interface AwSourceBindingWorkspaceValidationContext {
  workspace: CatalogWorkspace
  source: AwWorkspaceBindingSource
}

export interface EvalProfileBindingInput {
  profile: AwSourceBindingProfile & { kind: 'eval' }
  materializationProfile: AwSkillEvalMaterializationProfile
}

export interface PortablePluginProfileConfig {
  config: ResolvedArtifactRenderConfig
  digest: string
}

function digestCanonical(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function strictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim()
}

function digestString(value: unknown): value is string {
  return typeof value === 'string' && digestPattern.test(value)
}

function scopeValue(value: unknown): value is Scope {
  return value === 'project' || value === 'user'
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && safeIdPattern.test(value)
}

function normalizeRelativePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === '..'
    || value.startsWith('../')
  ) {
    throw new Error('Source binding artifact path must be a safe relative POSIX path.')
  }
  return value
}

function normalizeSource(value: unknown): AwSourceBindingSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Source binding source must be an object.')
  }
  const row = value as Record<string, unknown>
  if (row.kind === 'workspace') {
    if (
      !strictRecord(row, ['kind', 'workspaceIdentity', 'sourceIdentity'])
      || !nonEmptyString(row.workspaceIdentity)
      || !digestString(row.sourceIdentity)
    ) throw new Error('Source binding Workspace identity is invalid.')
    return {
      kind: 'workspace',
      workspaceIdentity: row.workspaceIdentity,
      sourceIdentity: row.sourceIdentity,
    }
  }
  if (
    row.kind !== 'catalog-snapshot'
    || !strictRecord(row, [
      'kind',
      'sourceId',
      'catalogSourceIdentity',
      'logicalIdentity',
      'snapshotDigest',
      'workspaceIdentity',
      'workspaceSourceIdentity',
    ])
    || !safeId(row.sourceId)
    || !digestString(row.catalogSourceIdentity)
    || !nonEmptyString(row.logicalIdentity)
    || !digestString(row.snapshotDigest)
    || !nonEmptyString(row.workspaceIdentity)
    || !digestString(row.workspaceSourceIdentity)
  ) throw new Error('Source binding Catalog snapshot identity is invalid.')
  return {
    kind: 'catalog-snapshot',
    sourceId: row.sourceId,
    catalogSourceIdentity: row.catalogSourceIdentity,
    logicalIdentity: row.logicalIdentity,
    snapshotDigest: row.snapshotDigest,
    workspaceIdentity: row.workspaceIdentity,
    workspaceSourceIdentity: row.workspaceSourceIdentity,
  }
}

function normalizeSubject(value: unknown): AwSourceBindingSubject {
  const row = value as Record<string, unknown>
  if (
    !strictRecord(row, ['plugin', ...(row?.skill === undefined ? [] : ['skill']), ...(row?.suite === undefined ? [] : ['suite'])])
    || !safeId(row.plugin)
    || (row.skill !== undefined && !safeId(row.skill))
    || (row.suite !== undefined && !safeId(row.suite))
  ) throw new Error('Source binding subject is invalid.')
  if (row.suite !== undefined && row.skill === undefined) {
    throw new Error('Source binding suite requires a Skill subject.')
  }
  return {
    plugin: row.plugin,
    ...(row.skill === undefined ? {} : { skill: row.skill }),
    ...(row.suite === undefined ? {} : { suite: row.suite }),
  }
}

function normalizeProfile(value: unknown): AwSourceBindingProfile {
  const row = value as Record<string, unknown>
  if (row?.kind === 'review') return parseReviewProfile(value)
  if (
    !strictRecord(row, ['kind', 'id', 'scope', 'inputDigest',
      ...(row?.kind === 'eval' && row.config !== undefined ? ['config'] : [])])
    || !scopeValue(row.scope)
    || !digestString(row.inputDigest)
  ) throw new Error('Source binding profile is invalid.')
  if (row.kind === 'eval' && safeId(row.id)) {
    return {
      kind: 'eval', id: row.id, scope: row.scope, inputDigest: row.inputDigest,
      ...(row.config === undefined ? {} : { config: normalizeReviewProfileConfig(row.config) }),
    }
  }
  if (row.kind === 'portable' && row.id === `agent-skills-${row.scope}`) {
    return {
      kind: 'portable',
      id: `agent-skills-${row.scope}`,
      scope: row.scope,
      inputDigest: row.inputDigest,
    }
  }
  throw new Error('Source binding profile kind or id is invalid.')
}

function normalizeArtifact(value: unknown): AwSourceBindingArtifact {
  const row = value as Record<string, unknown>
  if (!row || typeof row !== 'object' || Array.isArray(row) || !digestString(row.digest)) {
    throw new Error('Source binding artifact is invalid.')
  }
  const relativePath = normalizeRelativePath(row.path)
  if (row.kind === 'eval-target') {
    if (!strictRecord(row, ['kind', 'skill', 'path', 'digest']) || !safeId(row.skill)) {
      throw new Error('Source binding Eval Skill artifact is invalid.')
    }
    return { kind: row.kind, skill: row.skill, path: relativePath, digest: row.digest }
  }
  if (row.kind === 'portable-skill' || row.kind === 'review-skill') {
    if (
      !strictRecord(row, ['kind', 'plugin', 'skill', 'path', 'digest'])
      || !safeId(row.plugin)
      || !safeId(row.skill)
    ) throw new Error('Source binding materialized Skill artifact is invalid.')
    return {
      kind: row.kind,
      plugin: row.plugin,
      skill: row.skill,
      path: relativePath,
      digest: row.digest,
    }
  }
  if (row.kind === 'eval-workspace' || row.kind === 'eval-cases') {
    if (!strictRecord(row, ['kind', 'path', 'digest'])) {
      throw new Error('Source binding Eval artifact is invalid.')
    }
    return { kind: row.kind, path: relativePath, digest: row.digest }
  }
  throw new Error('Source binding artifact kind is invalid.')
}

export function parseAwSourceBinding(value: unknown): AwSourceBindingV2 {
  const row = value as Record<string, unknown>
  if (row?.schemaVersion === 1 && row.kind === 'aw-source-binding') {
    throw new Error(unsupportedV1Message)
  }
  if (
    !strictRecord(row, [
      'schemaVersion',
      'kind',
      'source',
      'subject',
      'profile',
      ...(row?.evalInput === undefined ? [] : ['evalInput']),
      'artifacts',
      'finalDigest',
    ])
    || row.schemaVersion !== 2
    || row.kind !== 'aw-source-binding'
    || !Array.isArray(row.artifacts)
    || row.artifacts.length === 0
    || !digestString(row.finalDigest)
  ) throw new Error('Source binding receipt is invalid.')
  const binding: AwSourceBindingV2 = {
    schemaVersion: 2,
    kind: 'aw-source-binding',
    source: normalizeSource(row.source),
    subject: normalizeSubject(row.subject),
    profile: normalizeProfile(row.profile),
    ...(row.evalInput === undefined ? {} : { evalInput: parseAwSourceBindingEvalInput(row.evalInput) }),
    artifacts: row.artifacts.map(normalizeArtifact),
    finalDigest: row.finalDigest,
  }
  const paths = binding.artifacts.map((artifact) => artifact.path)
  if (new Set(paths).size !== paths.length || paths.includes(AW_SOURCE_BINDING_FILENAME)) {
    throw new Error('Source binding artifact paths must be unique and exclude the receipt.')
  }
  if (binding.profile.kind === 'eval') {
    const expectedKinds = ['eval-cases', 'eval-target', 'eval-workspace']
    if (
      binding.artifacts.length !== 3
      || [...binding.artifacts.map((artifact) => artifact.kind)].sort().join(',') !== expectedKinds.join(',')
      || binding.subject.skill === undefined
      || binding.subject.suite === undefined
      || binding.evalInput === undefined
      || binding.artifacts.some((artifact) =>
        artifact.kind === 'eval-target' && artifact.skill !== binding.subject.skill)
    ) throw new Error('Source binding artifacts do not match the Eval profile.')
  } else if (binding.profile.kind === 'portable') {
    if (
      binding.subject.skill !== undefined
      || binding.subject.suite !== undefined
      || binding.evalInput !== undefined
      || binding.artifacts.some((artifact) => artifact.kind !== 'portable-skill')
      || new Set(binding.artifacts.map((artifact) =>
        artifact.kind === 'portable-skill' ? artifact.skill : '')).size !== binding.artifacts.length
    ) throw new Error('Source binding artifacts do not match the portable profile.')
  } else {
    const reviewArtifacts = binding.artifacts.filter((artifact) => artifact.kind === 'review-skill')
    if (
      binding.subject.suite !== undefined
      || binding.evalInput !== undefined
      || reviewArtifacts.length !== binding.artifacts.length
      || reviewArtifacts.some((artifact) => artifact.plugin !== binding.subject.plugin)
      || new Set(reviewArtifacts.map((artifact) => artifact.skill)).size !== reviewArtifacts.length
      || (binding.subject.skill !== undefined
        && (reviewArtifacts.length !== 1 || reviewArtifacts[0]!.skill !== binding.subject.skill))
    ) throw new Error('Source binding artifacts do not match the Review profile.')
  }
  return binding
}

function bindingDigest(binding: Omit<AwSourceBindingV2, 'finalDigest'>): string {
  return digestCanonical(binding)
}

async function artifactDigest(
  rootDir: string,
  artifact: AwSourceBindingArtifact | AwSourceBindingArtifactInput,
): Promise<string> {
  const relativePath = normalizeRelativePath(artifact.path)
  const absolutePath = path.resolve(rootDir, ...relativePath.split('/'))
  const relative = path.relative(rootDir, absolutePath)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Source binding artifact escapes its materialization root.')
  }
  let current = rootDir
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error('Source binding artifact path contains a symbolic link.')
  }
  if (artifact.kind === 'eval-workspace') return computeCanonicalDirectoryDigest(absolutePath)
  if (artifact.kind === 'eval-cases') return computeEvalFileDigest(absolutePath)
  return computeSkillDigest(absolutePath)
}

export async function writeAwSourceBinding(
  options: WriteAwSourceBindingOptions,
): Promise<{ bindingPath: string; binding: AwSourceBindingV2 }> {
  const rootDir = await fs.realpath(options.rootDir)
  const artifacts: AwSourceBindingArtifact[] = []
  for (const artifact of options.artifacts) {
    artifacts.push({ ...artifact, digest: await artifactDigest(rootDir, artifact) } as AwSourceBindingArtifact)
  }
  const unsigned = {
    schemaVersion: 2 as const,
    kind: 'aw-source-binding' as const,
    source: options.source,
    subject: options.subject,
    profile: options.profile,
    ...(options.evalInput === undefined ? {} : { evalInput: options.evalInput }),
    artifacts,
  }
  const binding = parseAwSourceBinding({ ...unsigned, finalDigest: bindingDigest(unsigned) })
  const bindingPath = path.join(rootDir, AW_SOURCE_BINDING_FILENAME)
  await fs.writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx' })
  return { bindingPath, binding }
}

export async function resolveWorkspaceBindingSource(
  workspace: Pick<CatalogWorkspace, 'workspaceRoot' | 'workspaceIdentity' | 'metadataPath' | 'plugins'>,
): Promise<AwWorkspaceBindingSource> {
  return {
    kind: 'workspace',
    workspaceIdentity: workspace.workspaceIdentity,
    sourceIdentity: await calculateCatalogWorkspaceSourceIdentity(workspace),
  }
}

export async function resolveCatalogSnapshotBindingSource(
  source: Pick<
    CatalogSourceResolution,
    'sourceId' | 'sourceIdentity' | 'logicalIdentity' | 'snapshotDigest' | 'rootDir'
  >,
): Promise<AwCatalogSnapshotBindingSource> {
  const markerPath = path.join(source.rootDir, GENERATED_OUTPUT_MARKER_FILENAME)
  const markerInfo = await fs.lstat(markerPath)
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new Error('Validated Catalog snapshot marker is unsafe.')
  }
  const marker = await fs.readJson(markerPath) as unknown
  if (
    !strictRecord(marker, ['schemaVersion', 'kind', 'workspaceIdentity', 'sourceIdentity'])
    || marker.schemaVersion !== 1
    || marker.kind !== 'catalog'
    || !nonEmptyString(marker.workspaceIdentity)
    || !digestString(marker.sourceIdentity)
  ) throw new Error('Validated Catalog snapshot marker is invalid.')
  return {
    kind: 'catalog-snapshot',
    sourceId: source.sourceId,
    catalogSourceIdentity: source.sourceIdentity,
    logicalIdentity: source.logicalIdentity,
    snapshotDigest: source.snapshotDigest,
    workspaceIdentity: marker.workspaceIdentity,
    workspaceSourceIdentity: marker.sourceIdentity,
  }
}

export function resolveEvalProfileBindingInput(
  profile: AwSkillEvalManifestV1Profile,
  plugins: readonly PluginMeta[],
  configOverrides: ReviewProfileConfig = {},
): EvalProfileBindingInput {
  assertNoSensitiveProfileConfig(profile, plugins)
  const normalizedConfig = normalizeReviewProfileConfig(configOverrides)
  const selectedPlugins = new Set(profile.plugins.map((entry) => entry.name))
  if (Object.keys(normalizedConfig).some((name) => !selectedPlugins.has(name))) {
    throw new Error('Eval config overrides must name plugins in the selected profile.')
  }
  assertNoSensitiveProfileConfig({
    ...profile,
    plugins: profile.plugins.map((entry) => ({
      ...entry,
      config: { ...entry.config, ...(normalizedConfig[entry.name] ?? {}) },
    })),
  }, plugins)
  const explicitConfig = new Map(profile.plugins.map((entry) => [entry.name, entry.config]))
  const overrides = new Map(Object.entries(profile.configByScope ?? {}).map(([scope, entries]) => [
    scope as Scope,
    new Map(entries?.map((entry) => [entry.name, entry.config]) ?? []),
  ]))
  const closure = resolvePluginMetaDependencyClosure(
    plugins,
    profile.plugins.map((entry) => entry.name),
  )
  const materializationProfile: AwSkillEvalMaterializationProfile = {
    id: profile.id,
    scope: profile.scope,
    plugins: closure.map((plugin) => ({
      name: plugin.manifest.name,
      configByScope: Object.fromEntries([
        profile.scope,
        ...((plugin.manifest.artifacts?.targets ?? []).some((target) =>
          target.platform === 'codex'
          && target.target === 'codex.skill'
          && target.scopes.includes(profile.scope)
          && target.delivery?.mode === 'codex-native')
          ? ['user' as const]
          : []),
      ].sort().map((scope) => [
        scope,
        {
          ...(explicitConfig.get(plugin.manifest.name) ?? {}),
          ...(overrides.get(scope)?.get(plugin.manifest.name) ?? {}),
          ...(normalizedConfig[plugin.manifest.name] ?? {}),
        },
      ])),
    })),
  }
  for (const plugin of closure) {
    const installation = materializationProfile.plugins.find((entry) => entry.name === plugin.manifest.name)!
    for (const [scope, config] of Object.entries(installation.configByScope)) {
      for (const [key, field] of Object.entries(plugin.manifest.config?.fields ?? {})) {
        if (field.required === true && field.default === undefined && !Object.hasOwn(config!, key)) {
          throw new Error(
            `Eval profile "${profile.id}" is missing required config "${key}" `
            + `for plugin "${plugin.manifest.name}" in ${scope} scope.`,
          )
        }
      }
      if (plugin.manifest.config) {
        const defaults = Object.fromEntries(Object.entries(plugin.manifest.config.fields)
          .flatMap(([key, field]) => field.default === undefined ? [] : [[key, field.default]]))
        const issues = validatePluginConfigCandidate(plugin.manifest.config, { ...defaults, ...config })
        if (issues.length > 0) {
          throw new Error(`Eval profile "${profile.id}" has invalid config for plugin "${plugin.manifest.name}" in ${scope} scope: ${formatPluginConfigIssue(issues[0]!)}`)
        }
      }
    }
  }
  return {
    materializationProfile,
    profile: {
      kind: 'eval',
      id: profile.id,
      scope: profile.scope,
      inputDigest: digestCanonical(materializationProfile),
      ...(Object.keys(normalizedConfig).length === 0 ? {} : { config: normalizedConfig }),
    },
  }
}

export async function resolvePortablePluginProfileConfig(options: {
  plugin: PluginMeta
  scope: Scope
  cwd: string
  env?: NodeJS.ProcessEnv
  sourceId?: string
  catalogSourceIdentity?: string
  logicalIdentity?: string
}): Promise<PortablePluginProfileConfig> {
  const config = await resolveArtifactRenderConfig({
    sourceId: options.sourceId ?? options.plugin.sourceId,
    sourceIdentity: options.catalogSourceIdentity ?? options.plugin.sourceIdentity,
    logicalIdentity: options.logicalIdentity ?? options.plugin.catalogLogicalIdentity,
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  })
  if (config.issues.length > 0) {
    throw new Error(`Portable materialization config is invalid: ${config.issues.map((issue) => issue.message).join('; ')}`)
  }
  return {
    config,
    digest: digestCanonical({ values: config.values, sources: config.sources }),
  }
}

export async function resolvePortableProfileBindingInput(options: {
  plugins: readonly PluginMeta[]
  pluginName: string
  scope: Scope
  cwd: string
  env?: NodeJS.ProcessEnv
  sourceId?: string
  catalogSourceIdentity?: string
  logicalIdentity?: string
}): Promise<AwSourceBindingProfile & { kind: 'portable' }> {
  const closure = resolvePluginMetaDependencyClosure(options.plugins, [options.pluginName])
  const configDigests: Array<[string, string]> = []
  for (const plugin of closure) {
    if (!plugin.manifest.distributions?.agentSkills) continue
    const resolved = await resolvePortablePluginProfileConfig({ ...options, plugin })
    const id = options.sourceId ? `${options.sourceId}/${plugin.manifest.name}` : plugin.manifest.name
    configDigests.push([id, resolved.digest])
  }
  return {
    kind: 'portable',
    id: `agent-skills-${options.scope}`,
    scope: options.scope,
    inputDigest: `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(configDigests))
      .digest('hex')}`,
  }
}

function sameSubject(left: AwSourceBindingSubject, right: AwSourceBindingSubject): boolean {
  return left.plugin === right.plugin && left.skill === right.skill && left.suite === right.suite
}

async function currentWorkspaceProfile(options: {
  workspace: CatalogWorkspace
  binding: AwSourceBindingV2
  cwd: string
  env?: NodeJS.ProcessEnv
}): Promise<AwSourceBindingProfile> {
  const plugin = options.workspace.plugins.find((entry) =>
    entry.manifest.name === options.binding.subject.plugin)
  if (!plugin) throw new Error('The bound plugin is not present in the current Workspace.')
  if (options.binding.profile.kind === 'eval') {
    const loaded = await readAwSkillEvalManifest({ plugin, skill: options.binding.subject.skill! })
    const suite = loaded.manifest.suites.find((entry) => entry.id === options.binding.subject.suite)
    const profile = loaded.manifest.profiles.find((entry) => entry.id === options.binding.profile.id)
    if (!suite || !profile || suite.profiles && !suite.profiles.includes(profile.id)) {
      throw new Error('The bound Eval suite or profile is not present in the current Workspace.')
    }
    return resolveEvalProfileBindingInput(
      profile, options.workspace.plugins, options.binding.profile.config,
    ).profile
  }
  if (options.binding.profile.kind === 'review') {
    const skills = options.binding.artifacts.flatMap((artifact) =>
      artifact.kind === 'review-skill' ? [artifact.skill] : [])
    const selection = await resolveReviewSelection({
      cwd: options.workspace.workspaceRoot,
      workspaceRoot: options.workspace.workspaceRoot,
      target: options.binding.subject.plugin,
      skills,
      platform: options.binding.profile.platform,
      scope: options.binding.profile.scope,
      config: options.binding.profile.config,
      env: options.env,
    })
    const profile = selection.profiles[0]?.profile
    if (!profile) throw new Error('The bound Review profile is not present in the current Workspace.')
    return profile
  }
  const source = options.binding.source
  return resolvePortableProfileBindingInput({
    plugins: options.workspace.plugins,
    pluginName: options.binding.subject.plugin,
    scope: options.binding.profile.scope,
    cwd: options.cwd,
    env: options.env,
    ...(source.kind === 'catalog-snapshot'
      ? {
          sourceId: source.sourceId,
          catalogSourceIdentity: source.catalogSourceIdentity,
          logicalIdentity: source.logicalIdentity,
        }
      : {}),
  })
}

export async function resolveCurrentWorkspaceAwSourceBinding(options: {
  context: AwSourceBindingWorkspaceValidationContext
  binding: AwSourceBindingV2
  cwd?: string
  env?: NodeJS.ProcessEnv
}): Promise<{ source: AwWorkspaceBindingSource; profile: AwSourceBindingProfile }> {
  return {
    source: options.context.source,
    profile: await currentWorkspaceProfile({
      workspace: options.context.workspace,
      binding: options.binding,
      cwd: options.cwd ?? options.context.workspace.workspaceRoot,
      env: options.env,
    }),
  }
}

export async function createAwSourceBindingWorkspaceValidationContext(
  workspaceRoot: string,
): Promise<AwSourceBindingWorkspaceValidationContext> {
  const workspace = await readCatalogWorkspace(workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS })
  return { workspace, source: await resolveWorkspaceBindingSource(workspace) }
}

export async function readAwSourceBinding(bindingPath: string): Promise<AwSourceBindingV2> {
  const resolved = path.resolve(bindingPath)
  const info = await fs.lstat(resolved)
  if (!info.isFile() || info.isSymbolicLink() || path.basename(resolved) !== AW_SOURCE_BINDING_FILENAME) {
    throw new Error('AW source binding receipt path is invalid.')
  }
  const binding = parseAwSourceBinding(await fs.readJson(resolved))
  const unsigned = {
    schemaVersion: binding.schemaVersion,
    kind: binding.kind,
    source: binding.source,
    subject: binding.subject,
    profile: binding.profile,
    ...(binding.evalInput === undefined ? {} : { evalInput: binding.evalInput }),
    artifacts: binding.artifacts,
  }
  if (binding.finalDigest !== bindingDigest(unsigned)) {
    throw new Error('AW source binding receipt digest is invalid.')
  }
  return binding
}

function bindingMatchesWorkspaceSource(
  binding: AwSourceBindingSource,
  current: AwWorkspaceBindingSource,
): boolean {
  return binding.kind === 'workspace'
    ? binding.workspaceIdentity === current.workspaceIdentity
      && binding.sourceIdentity === current.sourceIdentity
    : binding.workspaceIdentity === current.workspaceIdentity
      && binding.workspaceSourceIdentity === current.sourceIdentity
}

async function currentPortableArtifactOwners(options: {
  workspace: CatalogWorkspace
  binding: AwSourceBindingV2
}): Promise<Map<string, string | null>> {
  const closure = resolvePluginMetaDependencyClosure(
    options.workspace.plugins,
    [options.binding.subject.plugin],
  )
  const owners = new Map<string, string | null>()
  const record = (skill: string, plugin: string): void => {
    owners.set(skill, owners.has(skill) ? null : plugin)
  }
  for (const plugin of closure) {
    const distribution = plugin.manifest.distributions?.agentSkills
    if (!distribution) continue
    const dynamicKeys = new Set((plugin.manifest.artifacts?.targets ?? [])
      .filter((target) => target.target === 'agent-skills.skill')
      .map((target) => target.skillKey!))
    for (const target of plugin.manifest.artifacts?.targets ?? []) {
      if (
        target.target === 'agent-skills.skill'
        && target.scopes.includes(options.binding.profile.scope)
      ) record(target.skillKey!, plugin.manifest.name)
    }
    if (!distribution.skills) continue
    const root = path.join(plugin.rootDir, distribution.skills.replace(/^\.\//u, ''))
    const rootInfo = await fs.lstat(root).catch(() => null)
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) continue
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (dynamicKeys.has(entry.name)) continue
      const info = await fs.lstat(path.join(root, entry.name)).catch(() => null)
      if (entry.isDirectory() && info?.isDirectory() && !info.isSymbolicLink()) {
        record(entry.name, plugin.manifest.name)
      }
    }
  }
  return owners
}

async function currentEvalInput(options: {
  workspace: CatalogWorkspace
  binding: AwSourceBindingV2
  preparedRoot: string
}): Promise<AwSourceBindingEvalInput> {
  const evalInput = options.binding.evalInput
  if (options.binding.profile.kind !== 'eval' || !evalInput) {
    throw new Error('The source binding does not contain Eval input.')
  }
  const plugin = options.workspace.plugins.find((entry) =>
    entry.manifest.name === options.binding.subject.plugin)
  if (!plugin) throw new Error('The bound plugin is not present in the current Workspace.')
  const loaded = await readAwSkillEvalManifest({ plugin, skill: options.binding.subject.skill! })
  const suite = loaded.manifest.suites.find((entry) => entry.id === options.binding.subject.suite)
  if (!suite) throw new Error('The bound Eval suite is not present in the current Workspace.')
  const preparedEvalRoot = path.join(options.preparedRoot, 'workspace', 'eval')
  const provider = await resolveAwSourceBindingEvalProvider({
    evalRoot: loaded.evalRoot,
    preparedEvalRoot,
    suite,
  })
  const resolved = await resolveEvalSourceBindingInput({
    workspaceRoot: options.workspace.workspaceRoot,
    evalRoot: loaded.evalRoot,
    manifestPath: loaded.manifestPath,
    suite,
    defaults: loaded.manifest.defaults,
    cases: loaded.casesBySuite.get(suite.id)!,
    corpusPaths: loaded.manifest.suites.map((entry) => entry.cases),
    selection: { caseIds: evalInput.selectedCaseIds },
    providerDigest: computeEvalProviderDigest(provider),
    preparedEvalRoot,
  })
  const casesArtifact = options.binding.artifacts.find((artifact) => artifact.kind === 'eval-cases')
  if (!casesArtifact) throw new Error('The source binding does not contain prepared Eval cases.')
  const preparedCases = await fs.readJson(path.join(
    options.preparedRoot,
    ...casesArtifact.path.split('/'),
  )) as unknown
  if (digestCanonical(preparedCases) !== resolved.input.selectedCasesDigest) {
    throw new Error('Prepared Eval cases do not match the current selected source cases.')
  }
  return resolved.input
}

export async function validateAwSourceBindingForWorkspace(options: {
  bindingPath: string
  context: AwSourceBindingWorkspaceValidationContext
  expectedSubject: AwSourceBindingSubject
  cwd?: string
  env?: NodeJS.ProcessEnv
}): Promise<AwSourceBindingValidation> {
  const bindingPath = path.resolve(options.bindingPath)
  const info = await fs.lstat(bindingPath).catch(() => null)
  if (!info) {
    return {
      state: 'incomplete',
      binding: null,
      outputs: [],
      issues: [{ code: 'sourceBindingMissing', message: 'AW source binding receipt is missing.' }],
    }
  }
  if (!info.isFile() || info.isSymbolicLink() || path.basename(bindingPath) !== AW_SOURCE_BINDING_FILENAME) {
    return {
      state: 'invalid',
      binding: null,
      outputs: [],
      issues: [{ code: 'sourceBindingInvalid', message: 'AW source binding receipt path is invalid.' }],
    }
  }
  let binding: AwSourceBindingV2
  try {
    binding = await readAwSourceBinding(bindingPath)
  } catch (error) {
    const message = error instanceof Error && error.message === unsupportedV1Message
      ? unsupportedV1Message
      : 'AW source binding receipt is invalid.'
    return {
      state: 'invalid',
      binding: null,
      outputs: [],
      issues: [{ code: 'sourceBindingInvalid', message }],
    }
  }
  const issues: AwSourceBindingIssue[] = []
  if (!sameSubject(binding.subject, options.expectedSubject)) {
    issues.push({ code: 'sourceBindingSubjectDrift', message: 'The bound subject does not match the requested source subject.' })
  }
  if (!bindingMatchesWorkspaceSource(binding.source, options.context.source)) {
    issues.push({ code: 'sourceBindingSourceDrift', message: 'The current Workspace source identity differs from the bound source.' })
  }
  try {
    const current = await resolveCurrentWorkspaceAwSourceBinding({
      context: options.context,
      binding,
      cwd: options.cwd,
      env: options.env,
    })
    if (
      binding.profile.kind !== current.profile.kind
      || binding.profile.id !== current.profile.id
      || binding.profile.scope !== current.profile.scope
      || binding.profile.inputDigest !== current.profile.inputDigest
    ) {
      issues.push({ code: 'sourceBindingProfileDrift', message: 'The current profile input differs from the bound profile.' })
    }
  } catch {
    issues.push({ code: 'sourceBindingProfileDrift', message: 'The current profile input cannot be validated.' })
  }
  const rootDir = path.dirname(bindingPath)
  if (binding.profile.kind === 'eval') {
    try {
      const current = await currentEvalInput({
        workspace: options.context.workspace,
        binding,
        preparedRoot: rootDir,
      })
      if (canonicalJson(current) !== canonicalJson(binding.evalInput)) {
        issues.push({
          code: 'sourceBindingEvalInputDrift',
          message: 'The current Eval source input differs from the bound source input.',
        })
      }
    } catch {
      issues.push({
        code: 'sourceBindingEvalInputDrift',
        message: 'The current Eval source input cannot be validated against the prepared input.',
      })
    }
  }
  let portableOwners: Map<string, string | null> | null = null
  if (binding.profile.kind === 'portable') {
    try {
      portableOwners = await currentPortableArtifactOwners({
        workspace: options.context.workspace,
        binding,
      })
    } catch {
      portableOwners = new Map()
    }
  }
  for (const artifact of binding.artifacts) {
    if (
      artifact.kind === 'portable-skill'
      && portableOwners?.get(artifact.skill) !== artifact.plugin
    ) {
      issues.push({
        code: 'sourceBindingArtifactDrift',
        message: `The current source does not declare ${artifact.plugin}/${artifact.skill} in the bound dependency closure.`,
      })
    }
    try {
      const actual = await artifactDigest(rootDir, artifact)
      if (actual !== artifact.digest) {
        issues.push({ code: 'sourceBindingArtifactDrift', message: `The materialized artifact differs from its binding: ${artifact.path}` })
      }
    } catch {
      issues.push({ code: 'sourceBindingArtifactDrift', message: `The materialized artifact is missing or invalid: ${artifact.path}` })
    }
  }
  return issues.length === 0
    ? {
        state: 'verified',
        binding,
        outputs: binding.artifacts.map((artifact) => ({
          ...artifact,
          path: path.resolve(rootDir, ...artifact.path.split('/')),
        })),
        issues: [],
      }
    : { state: 'drifted', binding, outputs: [], issues }
}
