import path from 'node:path'

import {
  canonicalJson,
  computeCaseCorpusDigest,
  computeSkillDigest,
  type SelectedCasesDocument,
} from '@lesliechan721/agent-skill-eval'
import {
  calculateCatalogWorkspaceSourceIdentity,
  DEFAULT_CATALOG_OUTPUT_PATH,
  GENERATED_OUTPUT_MARKER_FILENAME,
  readCatalogWorkspace,
  resolveSupportedPlatforms,
  validateCatalogSnapshotComplete,
  type CatalogManifestV7Entry,
  type CatalogWorkspace,
  type PluginMeta,
  type Scope,
} from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'

import {
  readAwSkillEvalManifest,
  type AwSkillEvalManifestV1Suite,
} from '../eval/manifest-v1.js'
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js'
import {
  resolveCatalogWorkspaceRoot,
  type CatalogWorkspaceResolvedFrom,
} from './catalog-workspace-resolution.js'
import { computeReviewComponentDigest } from './review-publication.js'
import {
  computeAwSourceBindingSelectedCasesDigest,
  computeAwSourceBindingSuiteDefaultsDigest,
  readAwSourceBinding,
  resolvePortablePluginProfileConfig,
  resolveEvalProfileBindingInput,
  selectAwSourceBindingEvalCases,
  validateAwSourceBindingForWorkspace,
  type AwSourceBindingProfile,
  type AwSourceBindingEvalInput,
  type AwSourceBindingSource,
  type AwSourceBindingSubject,
  type AwSourceBindingVerifiedOutput,
  type AwSourceBindingWorkspaceValidationContext,
} from '../review/source-binding.js'
import {
  resolveReviewDynamicSkillSource,
  resolveReviewSelection,
  reviewBindingMatchesSelection,
} from '../review/review-selection.js'
import type {
  ReviewResolvedProfile,
  ReviewProfileConfig,
  ReviewSelection,
  ReviewSelectedSkill,
} from '../review/review-types.js'
import {
  resolveEffectivePluginConfigFromStores,
  type PluginConfigStore,
} from '../utils/plugin-config.js'

export type ReviewInspectionIssueCategory = 'missing' | 'invalid' | 'unsupported' | 'unknown'
export type ReviewInspectionFinalProfile =
  | 'codex-user'
  | 'codex-project'
  | 'claude-user'
  | 'claude-project'
  | 'agent-skills-user'
  | 'agent-skills-project'

export type ReviewInspectionView = 'review' | 'release'
export type ReviewInspectionPlatform = 'codex' | 'claude' | 'agent-skills'

export interface ReviewInspectionOptions {
  cwd: string
  target: string
  workspaceRoot?: string
  skills?: readonly string[]
  platform?: ReviewInspectionPlatform
  scope?: Scope
  configFile?: string
  materializations?: readonly string[]
  view?: ReviewInspectionView
  env?: NodeJS.ProcessEnv
}

export interface ReviewInspectionNavigationIssue {
  code: string
  path: string | null
  message: string
}

export interface ReviewInspectionNavigationReceipt {
  schemaVersion: 2
  command: 'review:inspect'
  view: 'review'
  ok: boolean
  target: {
    kind: 'skill' | 'plugin' | 'catalog'
    path: string
  } | null
  sources: string[]
  snapshot?: {
    path: string
    state: 'absent' | 'current' | 'stale' | 'invalid'
  }
  skills: Array<{
    skill: string
    sourcePath: string
    profile: {
      platform: ReviewInspectionPlatform
      scope: Scope
      inputDigest: string | null
    }
    finalPath: string | null
    digest: string | null
    state: 'ready' | 'missing' | 'stale' | 'invalid' | 'unsupported'
    evidencePath: string | null
  }>
  issues: ReviewInspectionNavigationIssue[]
}

export type ReviewInspectionReceipt =
  | ReviewInspectionNavigationReceipt
  | ReviewInspectionReleaseReceipt

export class ReviewInspectionInputError extends Error {
  readonly code: string
  readonly exitCode = 2 as const

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ReviewInspectionInputError'
    this.code = code
  }
}

class ReviewInspectionResolvedTargetError extends Error {
  readonly code: string
  readonly exitCode: 1 | 2 | 3
  readonly reviewTarget: NonNullable<ReviewInspectionNavigationReceipt['target']>

  constructor(
    error: unknown,
    target: NonNullable<ReviewInspectionNavigationReceipt['target']>,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'ReviewInspectionResolvedTargetError'
    this.code = getReviewInspectionErrorCode(error)
    this.exitCode = getReviewInspectionExitCode(error)
    this.reviewTarget = target
  }
}

export interface ReviewInspectionIssue {
  category: ReviewInspectionIssueCategory
  code: string
  message: string
  blocking: boolean
  subjectKey?: string
  path?: string
}

export interface ReviewInspectionSubject {
  key: string
  kind:
    | 'catalog-source'
    | 'catalog-snapshot'
    | 'aw-plugin-source'
    | 'aw-plugin'
    | 'source-skill'
    | 'portable-source-skill'
    | 'artifact-source'
    | 'materialized-skill'
  plugin: string | null
  skill: string | null
  path: string
  profile: ReviewInspectionFinalProfile | null
  digest: string
  origin: 'workspace' | 'catalog-snapshot' | 'source-binding'
  targetId?: string
  materializationProfile?: {
    kind: 'eval' | 'portable' | 'review'
    id: string
    scope: Scope
    inputDigest: string
  }
}

export interface ReviewInspectionRequiredFinal {
  key: string
  kind: 'materialized-skill'
  plugin: string
  skill: string
  path: string | null
  profile: ReviewInspectionFinalProfile
  digest: string | null
  targetId: string | null
  sourceSubjectKey: string
  status: 'resolved' | 'missing' | 'invalid' | 'unknown'
  matchedFinalKeys: string[]
}

export interface ReviewInspectionRequiredEval {
  key: string
  plugin: string
  skill: string
  finalProfile: ReviewInspectionFinalProfile
  requiredFinalKey: string
  evalProfile: {
    id: string
    scope: Scope
    inputDigest: string
    plugins: string[]
  }
  suite: {
    id: string
    kind: AwSkillEvalManifestV1Suite['kind']
    provider: AwSkillEvalManifestV1Suite['provider'] | null
    suiteDefaultsDigest: string
  }
  cases: {
    sourcePath: string
    sourceCorpusDigest: string
    selectedCasesDigest: string
    selected: Array<{ id: string; split: string; minimumRuns: number }>
  }
  runs: number
  timeoutMs: number | null
  minimumPassRate: number
  processManagement: 'managed-only' | 'allow-unmanaged-confirmed'
  materializedFinalKeys: string[]
  verifiedBindingPaths: string[]
}

export interface ReviewInspectionPlugin {
  id: string
  name: string
  version: string
  path: string
  sourceContainerKey: string
  finalContainerKey: string | null
  dependencies: string[]
  supportedPlatforms: Array<'claude' | 'codex'>
  finalProfiles: ReviewInspectionFinalProfile[]
  imports: Array<{
    purpose: 'build' | 'skill-runtime-file' | 'artifact-runtime'
    provider: string
    export: string
    consumer: string
  }>
  snapshotEntry: Pick<
    CatalogManifestV7Entry,
    'artifactDigest' | 'manifestDigest' | 'contentDigest'
  > | null
  sourceSubjectKeys: string[]
  requiredFinalKeys: string[]
  requiredEvalKeys: string[]
}

export interface ReviewInspectionMaterialization {
  path: string
  state: 'verified' | 'incomplete' | 'invalid' | 'drifted' | 'unsupported'
  plugin: string | null
  skill: string | null
  profile: ReviewInspectionFinalProfile | null
  finalKeys: string[]
  verifiedBinding: {
    source: AwSourceBindingSource
    subject: AwSourceBindingSubject
    profile: AwSourceBindingProfile
    evalInput: AwSourceBindingEvalInput | null
    finalDigest: string
    artifacts: AwSourceBindingVerifiedOutput[]
  } | null
  issues: string[]
}

export interface ReviewInspectionReleaseReceipt {
  schemaVersion: 2
  command: 'review:inspect'
  view: 'release'
  ok: boolean
  completeness: 'complete' | 'incomplete'
  target: {
    kind: 'catalog' | 'plugin'
    id: string
    path: string
  }
  workspace: {
    root: string
    resolvedFrom: CatalogWorkspaceResolvedFrom
    identity: string
    sourceIdentity: string
    catalogVersion: string
  }
  snapshot: {
    path: string
    state: 'absent' | 'current' | 'stale' | 'invalid'
    catalogVersion: string | null
    snapshotDigest: string | null
    workspaceIdentity: string | null
    sourceIdentity: string | null
  }
  plugins: ReviewInspectionPlugin[]
  subjects: ReviewInspectionSubject[]
  requiredFinals: ReviewInspectionRequiredFinal[]
  finalMappings: Array<{
    requiredFinalKey: string
    sourceSubjectKey: string
    finalSubjectKeys: string[]
    status: ReviewInspectionRequiredFinal['status']
  }>
  requiredEvals: ReviewInspectionRequiredEval[]
  materializations: ReviewInspectionMaterialization[]
  issues: ReviewInspectionIssue[]
}

interface RequiredFinalSeed {
  plugin: PluginMeta
  skill: string
  profile: ReviewInspectionFinalProfile
  targetId: string | null
  sourceSubjectKey: string
  dynamic: boolean
}

interface SnapshotInspection {
  receipt: ReviewInspectionReleaseReceipt['snapshot']
  entries: ReadonlyMap<string, CatalogManifestV7Entry>
  root: string | null
}

interface VerifiedBindingFinal {
  key: string
  plugin: string
  skill: string
  profile: ReviewInspectionFinalProfile
  materializationProfile: AwSourceBindingProfile
  identityKey: string
  path: string
  digest: string
  requiredKeys: string[]
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value
}

function relativeWorkspacePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join('/') || '.'
}

function sourceKey(options: {
  workspaceRoot: string
  plugin: string
  skill: string
  kind: ReviewInspectionSubject['kind']
  roots: readonly string[]
}): string {
  const sourcePaths = options.roots.map((root) => relativeWorkspacePath(options.workspaceRoot, root))
  const sourceIdentity = encodeURIComponent(JSON.stringify({
    primary: sourcePaths[0],
    sources: [...sourcePaths].sort(compareText),
  }))
  return `source:${options.plugin}:${options.skill}:${options.kind}:${sourceIdentity}`
}

function requiredFinalKey(seed: Pick<RequiredFinalSeed, 'plugin' | 'skill' | 'profile' | 'targetId'>): string {
  return [
    'final',
    seed.plugin.manifest.name,
    seed.skill,
    seed.profile,
    seed.targetId ?? 'static',
  ].join(':')
}

function materializationIdentityKey(options: {
  plugin: string
  skill: string
  profile: ReviewInspectionFinalProfile
  materializationProfile: AwSourceBindingProfile
}): string {
  return [
    options.plugin,
    options.skill,
    options.profile,
    options.materializationProfile.kind,
    options.materializationProfile.id,
    options.materializationProfile.inputDigest,
  ].join(':')
}

function scopeFromProfile(profile: ReviewInspectionFinalProfile): Scope {
  return profile.endsWith('-project') ? 'project' : 'user'
}

function finalProfileFromBinding(profile: AwSourceBindingProfile): ReviewInspectionFinalProfile {
  if (profile.kind === 'eval') return `codex-${profile.scope}`
  if (profile.kind === 'portable') return `agent-skills-${profile.scope}`
  return `${profile.platform}-${profile.scope}`
}

async function directSkillDirectories(root: string): Promise<Array<{ name: string; root: string }>> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const result: Array<{ name: string; root: string }> = []
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const entryPath = path.join(root, entry.name)
    const stat = await fs.lstat(entryPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Skill collection direct child must be a regular directory: ${entryPath}`)
    }
    result.push({ name: entry.name, root: await fs.realpath(entryPath) })
  }
  return result
}

function pluginImports(plugin: PluginMeta): ReviewInspectionPlugin['imports'] {
  return [
    ...(plugin.manifest.buildConfig?.buildImports ?? []).map((entry) => ({
      purpose: 'build' as const,
      provider: entry.plugin,
      export: entry.export,
      consumer: entry.env,
    })),
    ...(plugin.manifest.buildConfig?.skillRuntimeFiles ?? []).flatMap((entry) => entry.import ? [{
      purpose: 'skill-runtime-file' as const,
      provider: entry.import.plugin,
      export: entry.import.export,
      consumer: `${entry.skill}/${entry.target}`,
    }] : []),
    ...(plugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
      (target.runtimeImports ?? []).map((entry) => ({
        purpose: 'artifact-runtime' as const,
        provider: entry.plugin,
        export: entry.export,
        consumer: `${target.id}/${entry.name}`,
      }))),
  ].sort((left, right) => compareText(
    `${left.purpose}\0${left.consumer}\0${left.provider}\0${left.export}`,
    `${right.purpose}\0${right.consumer}\0${right.provider}\0${right.export}`,
  ))
}

async function inspectSnapshot(
  workspace: CatalogWorkspace,
  workspaceSourceIdentity: string,
): Promise<SnapshotInspection> {
  const snapshotPath = path.join(workspace.workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH)
  if (!await fs.pathExists(snapshotPath)) {
    return {
      receipt: {
        path: snapshotPath,
        state: 'absent',
        catalogVersion: null,
        snapshotDigest: null,
        workspaceIdentity: null,
        sourceIdentity: null,
      },
      entries: new Map(),
      root: null,
    }
  }
  try {
    const [validation, marker] = await Promise.all([
      validateCatalogSnapshotComplete(snapshotPath),
      fs.readJson(path.join(snapshotPath, GENERATED_OUTPUT_MARKER_FILENAME)) as Promise<{
        workspaceIdentity: string
        sourceIdentity: string
      }>,
    ])
    const current = marker.workspaceIdentity === workspace.workspaceIdentity
      && marker.sourceIdentity === workspaceSourceIdentity
    return {
      receipt: {
        path: snapshotPath,
        state: current ? 'current' : 'stale',
        catalogVersion: validation.manifest.catalogVersion,
        snapshotDigest: validation.snapshotDigest,
        workspaceIdentity: marker.workspaceIdentity,
        sourceIdentity: marker.sourceIdentity,
      },
      entries: new Map(validation.manifest.entries.map((entry) => [entry.name, entry])),
      root: current ? validation.rootDir : null,
    }
  } catch {
    return {
      receipt: {
        path: snapshotPath,
        state: 'invalid',
        catalogVersion: null,
        snapshotDigest: null,
        workspaceIdentity: null,
        sourceIdentity: null,
      },
      entries: new Map(),
      root: null,
    }
  }
}

async function addSourceSubject(options: {
  workspace: CatalogWorkspace
  subjects: ReviewInspectionSubject[]
  plugin: PluginMeta
  skill: string
  root: string
  sourceRoots?: readonly string[]
  kind: 'source-skill' | 'portable-source-skill' | 'artifact-source'
}): Promise<string> {
  const key = sourceKey({
    workspaceRoot: options.workspace.workspaceRoot,
    plugin: options.plugin.manifest.name,
    skill: options.skill,
    kind: options.kind,
    roots: options.sourceRoots ?? [options.root],
  })
  if (options.subjects.some((subject) => subject.key === key)) return key
  const digest = options.kind === 'artifact-source'
    ? (await computeReviewComponentDigest({
        repoRoot: options.workspace.workspaceRoot,
        path: options.root,
      })).digest
    : await computeSkillDigest(options.root)
  options.subjects.push({
    key,
    kind: options.kind,
    plugin: options.plugin.manifest.name,
    skill: options.skill,
    path: options.root,
    profile: null,
    digest,
    origin: 'workspace',
  })
  return key
}

async function inventoryPluginSource(options: {
  workspace: CatalogWorkspace
  plugin: PluginMeta
  subjects: ReviewInspectionSubject[]
}): Promise<{
  seeds: RequiredFinalSeed[]
  sourceSubjectKeys: string[]
}> {
  const { workspace, plugin, subjects } = options
  const nativeSkills = plugin.manifest.skills
    ? await directSkillDirectories(path.join(plugin.rootDir, stripDotSlash(plugin.manifest.skills)))
    : []
  const portableSkills = plugin.manifest.distributions?.agentSkills?.skills
    ? await directSkillDirectories(path.join(
        plugin.rootDir,
        stripDotSlash(plugin.manifest.distributions.agentSkills.skills),
      ))
    : []
  const nativeDynamicByPlatform = new Map<'claude' | 'codex', Set<string>>([
    ['claude', new Set()],
    ['codex', new Set()],
  ])
  const portableDynamic = new Set<string>()
  const sourceSubjectKeys: string[] = []
  const seeds: RequiredFinalSeed[] = []

  for (const target of plugin.manifest.artifacts?.targets ?? []) {
    if (!['codex.skill', 'claude.skill', 'agent-skills.skill'].includes(target.target)) continue
    const skill = target.skillKey!
    if (target.target === 'agent-skills.skill') portableDynamic.add(skill)
    else nativeDynamicByPlatform.get(target.target === 'codex.skill' ? 'codex' : 'claude')!.add(skill)
  }

  for (const skill of nativeSkills) {
    sourceSubjectKeys.push(await addSourceSubject({
      workspace,
      subjects,
      plugin,
      skill: skill.name,
      root: skill.root,
      kind: 'source-skill',
    }))
  }
  for (const skill of portableSkills) {
    sourceSubjectKeys.push(await addSourceSubject({
      workspace,
      subjects,
      plugin,
      skill: skill.name,
      root: skill.root,
      kind: 'portable-source-skill',
    }))
  }

  for (const platform of [...resolveSupportedPlatforms(plugin.manifest)].sort(compareText)) {
    for (const skill of nativeSkills) {
      if (nativeDynamicByPlatform.get(platform)!.has(skill.name)) continue
      for (const scope of ['project', 'user'] as const) {
        seeds.push({
          plugin,
          skill: skill.name,
          profile: `${platform}-${scope}`,
          targetId: null,
          sourceSubjectKey: sourceKey({
            workspaceRoot: workspace.workspaceRoot,
            plugin: plugin.manifest.name,
            skill: skill.name,
            kind: 'source-skill',
            roots: [skill.root],
          }),
          dynamic: false,
        })
      }
    }
  }

  if (plugin.manifest.distributions?.agentSkills) {
    for (const skill of portableSkills) {
      if (portableDynamic.has(skill.name)) continue
      for (const scope of ['project', 'user'] as const) {
        seeds.push({
          plugin,
          skill: skill.name,
          profile: `agent-skills-${scope}`,
          targetId: null,
          sourceSubjectKey: sourceKey({
            workspaceRoot: workspace.workspaceRoot,
            plugin: plugin.manifest.name,
            skill: skill.name,
            kind: 'portable-source-skill',
            roots: [skill.root],
          }),
          dynamic: false,
        })
      }
    }
  }

  for (const target of plugin.manifest.artifacts?.targets ?? []) {
    if (!['codex.skill', 'claude.skill', 'agent-skills.skill'].includes(target.target)) continue
    const skill = target.skillKey!
    const platform = target.target === 'agent-skills.skill'
      ? 'agent-skills'
      : target.target === 'codex.skill' ? 'codex' : 'claude'
    const source = await resolveReviewDynamicSkillSource({
      plugin,
      target,
      nativeSkillPaths: nativeSkills.map((entry) => entry.root),
      portableSkillPaths: portableSkills.map((entry) => entry.root),
    })
    const sourceSubjectKey = await addSourceSubject({
      workspace,
      subjects,
      plugin,
      skill,
      root: source.sourcePath,
      sourceRoots: source.sourcePaths,
      kind: source.sourceKind,
    })
    sourceSubjectKeys.push(sourceSubjectKey)
    for (const scope of target.scopes) {
      seeds.push({
        plugin,
        skill,
        profile: `${platform}-${scope}`,
        targetId: target.id,
        sourceSubjectKey,
        dynamic: true,
      })
    }
  }

  return {
    seeds: seeds.sort((left, right) => compareText(requiredFinalKey(left), requiredFinalKey(right))),
    sourceSubjectKeys: [...new Set(sourceSubjectKeys)].sort(compareText),
  }
}

function releaseCases(
  suite: AwSkillEvalManifestV1Suite,
  document: SelectedCasesDocument,
  runs: number,
): Array<{ id: string; split: string; minimumRuns: number }> {
  const splits = new Set(suite.releaseSplits ?? [])
  return document.cases
    .filter((entry) => splits.size === 0 || splits.has('all') || splits.has(entry.split))
    .map((entry) => ({ id: entry.id, split: entry.split, minimumRuns: runs }))
    .sort((left, right) => compareText(left.id, right.id))
}

async function inventoryRequiredEvals(options: {
  workspace: CatalogWorkspace
  seeds: readonly RequiredFinalSeed[]
  issues: ReviewInspectionIssue[]
}): Promise<ReviewInspectionRequiredEval[]> {
  const required: ReviewInspectionRequiredEval[] = []
  const caseDigests = new Map<string, string>()
  const bySkill = new Map<string, RequiredFinalSeed[]>()
  for (const seed of options.seeds) {
    const key = `${seed.plugin.manifest.name}\0${seed.skill}`
    bySkill.set(key, [...(bySkill.get(key) ?? []), seed])
  }
  for (const seeds of bySkill.values()) {
    const first = seeds[0]!
    const manifestPath = path.join(first.plugin.rootDir, 'skills', first.skill, 'evals', 'manifest.json')
    if (!await fs.pathExists(manifestPath)) continue
    let loaded: Awaited<ReturnType<typeof readAwSkillEvalManifest>>
    try {
      loaded = await readAwSkillEvalManifest({ plugin: first.plugin, skill: first.skill })
    } catch (error) {
      options.issues.push({
        category: 'invalid',
        code: 'evalManifestInvalid',
        message: error instanceof Error ? error.message : String(error),
        blocking: true,
        path: relativeWorkspacePath(options.workspace.workspaceRoot, manifestPath),
      })
      continue
    }
    const requiredSuites = loaded.manifest.suites.filter((suite) => suite.requiredForRelease === true)
    const profileBindings = new Map<string, ReturnType<typeof resolveEvalProfileBindingInput>>()
    const invalidProfileIds = new Set<string>()
    const codexSeeds = seeds.filter((seed) => seed.profile.startsWith('codex-'))
    for (const suite of requiredSuites) {
      const accepted = suite.profiles ? new Set(suite.profiles) : null
      const suiteProfiles = loaded.manifest.profiles.filter((profile) =>
        !accepted || accepted.has(profile.id))
      for (const profile of suiteProfiles) {
        if (!profileBindings.has(profile.id) && !invalidProfileIds.has(profile.id)) {
          try {
            profileBindings.set(
              profile.id,
              resolveEvalProfileBindingInput(profile, options.workspace.plugins),
            )
          } catch (error) {
            invalidProfileIds.add(profile.id)
            options.issues.push({
              category: 'invalid',
              code: 'evalProfileInvalid',
              message: error instanceof Error ? error.message : String(error),
              blocking: true,
              path: relativeWorkspacePath(options.workspace.workspaceRoot, manifestPath),
            })
          }
        }
        const profileBinding = profileBindings.get(profile.id)
        if (!profileBinding) continue
        const matchingSeeds = codexSeeds.filter((seed) => scopeFromProfile(seed.profile) === profile.scope)
        if (matchingSeeds.length === 0) {
          options.issues.push({
            category: 'unsupported',
            code: 'requiredEvalTargetUnsupported',
            message: `Required Eval ${first.plugin.manifest.name}/${first.skill}/${suite.id}/${profile.id} has no declared Codex ${profile.scope} final.`,
            blocking: true,
            path: relativeWorkspacePath(options.workspace.workspaceRoot, manifestPath),
          })
          continue
        }
        const document = loaded.casesBySuite.get(suite.id)!
        const casesPath = path.join(loaded.evalRoot, suite.cases)
        const runs = suite.runs ?? loaded.manifest.defaults.runs ?? 1
        const timeoutMs = suite.timeoutMs ?? loaded.manifest.defaults.timeoutMs ?? null
        let casesDigest = caseDigests.get(casesPath)
        if (!casesDigest) {
          casesDigest = await computeCaseCorpusDigest([casesPath])
          caseDigests.set(casesPath, casesDigest)
        }
        const minimumPassRate = typeof document.suite.runtime?.minimumPassRate === 'number'
          ? document.suite.runtime.minimumPassRate
          : 1
        const selected = releaseCases(suite, document, runs)
        const selectedDocument = selected.length === 0
          ? { ...document, cases: [] }
          : selectAwSourceBindingEvalCases(document, {
              caseIds: selected.map((entry) => entry.id),
            })
        for (const seed of matchingSeeds) {
          const finalKey = requiredFinalKey(seed)
          required.push({
            key: `eval:${finalKey}:${profile.id}:${suite.id}`,
            plugin: first.plugin.manifest.name,
            skill: first.skill,
            finalProfile: seed.profile,
            requiredFinalKey: finalKey,
            evalProfile: {
              id: profile.id,
              scope: profile.scope,
              inputDigest: profileBinding.profile.inputDigest,
              plugins: profileBinding.materializationProfile.plugins
                .map((entry) => entry.name)
                .sort(compareText),
            },
            suite: {
              id: suite.id,
              kind: suite.kind,
              provider: suite.provider ?? null,
              suiteDefaultsDigest: computeAwSourceBindingSuiteDefaultsDigest(
                suite,
                loaded.manifest.defaults,
              ),
            },
            cases: {
              sourcePath: relativeWorkspacePath(options.workspace.workspaceRoot, casesPath),
              sourceCorpusDigest: casesDigest,
              selectedCasesDigest: computeAwSourceBindingSelectedCasesDigest(selectedDocument),
              selected,
            },
            runs,
            timeoutMs,
            minimumPassRate,
            processManagement: suite.releaseProcessManagement ?? 'managed-only',
            materializedFinalKeys: [],
            verifiedBindingPaths: [],
          })
        }
      }
    }
  }
  return required.sort((left, right) => compareText(left.key, right.key))
}

async function resolveTarget(options: {
  cwd: string
  target: string
  workspace: CatalogWorkspace
}): Promise<{ kind: 'catalog' | 'plugin'; id: string; path: string; plugins: PluginMeta[] }> {
  if (options.target === 'catalog') {
    return {
      kind: 'catalog',
      id: options.workspace.workspaceIdentity,
      path: options.workspace.workspaceRoot,
      plugins: options.workspace.plugins,
    }
  }
  const named = options.workspace.plugins.find((plugin) => plugin.manifest.name === options.target)
  if (named) {
    return { kind: 'plugin', id: named.manifest.name, path: named.rootDir, plugins: [named] }
  }
  const candidate = path.resolve(options.cwd, options.target)
  const stat = await fs.lstat(candidate).catch(() => null)
  if (!stat) {
    throw new ReviewInspectionInputError('targetNotFound', `Review target was not found: ${candidate}`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ReviewInspectionInputError(
      'invalidArguments',
      'The release view requires a canonical Plugin or Catalog Workspace directory.',
    )
  }
  const real = await fs.realpath(candidate)
  if (real === options.workspace.workspaceRoot) {
    return {
      kind: 'catalog',
      id: options.workspace.workspaceIdentity,
      path: real,
      plugins: options.workspace.plugins,
    }
  }
  const plugin = options.workspace.plugins.find((entry) => entry.rootDir === real)
  if (!plugin) {
    throw new ReviewInspectionInputError(
      'invalidArguments',
      'The release view requires the complete Plugin or Catalog target.',
    )
  }
  return { kind: 'plugin', id: plugin.manifest.name, path: real, plugins: [plugin] }
}

async function inspectMaterializations(options: {
  paths: readonly string[]
  workspace: CatalogWorkspace
  workspaceSourceIdentity: string
  targetPlugins: readonly PluginMeta[]
  requiredFinals: readonly ReviewInspectionRequiredFinal[]
  subjects: ReviewInspectionSubject[]
  issues: ReviewInspectionIssue[]
  env?: NodeJS.ProcessEnv
}): Promise<{
  materializations: ReviewInspectionMaterialization[]
  finals: VerifiedBindingFinal[]
}> {
  const materializations: ReviewInspectionMaterialization[] = []
  const finals = new Map<string, VerifiedBindingFinal>()
  const targetPluginNames = new Set(options.targetPlugins.map((plugin) => plugin.manifest.name))
  const context: AwSourceBindingWorkspaceValidationContext = {
    workspace: options.workspace,
    source: {
      kind: 'workspace',
      workspaceIdentity: options.workspace.workspaceIdentity,
      sourceIdentity: options.workspaceSourceIdentity,
    },
  }
  const bindingPaths = [...new Set(options.paths.map((entry) => path.resolve(entry)))].sort(compareText)
  for (const bindingPath of bindingPaths) {
    let parsed: Awaited<ReturnType<typeof readAwSourceBinding>> | null = null
    try {
      parsed = await readAwSourceBinding(bindingPath)
    } catch {
      // The validator returns the public typed state and safe issue below.
    }
    const expectedSubject = parsed?.subject ?? {
      plugin: options.targetPlugins[0]?.manifest.name ?? 'unknown',
    }
    const validation = await validateAwSourceBindingForWorkspace({
      bindingPath,
      context,
      expectedSubject,
      cwd: options.workspace.workspaceRoot,
      env: options.env,
    })
    if (validation.state !== 'verified') {
      materializations.push({
        path: bindingPath,
        state: validation.state,
        plugin: validation.binding?.subject.plugin ?? null,
        skill: validation.binding?.subject.skill ?? null,
        profile: validation.binding ? finalProfileFromBinding(validation.binding.profile) : null,
        finalKeys: [],
        verifiedBinding: null,
        issues: validation.issues.map((issue) => issue.message),
      })
      continue
    }
    const profile = finalProfileFromBinding(validation.binding.profile)
    const finalKeys: string[] = []
    for (const output of validation.outputs) {
      if (
        output.kind !== 'eval-target'
        && output.kind !== 'portable-skill'
        && output.kind !== 'review-skill'
      ) continue
      const outputPlugin = output.kind === 'portable-skill' || output.kind === 'review-skill'
        ? output.plugin
        : validation.binding.subject.plugin
      if (!targetPluginNames.has(outputPlugin)) continue
      const compatibleRequired = options.requiredFinals.filter((required) =>
        required.plugin === outputPlugin
        && required.skill === output.skill
        && required.profile === profile
        && (
          validation.binding.profile.kind !== 'eval'
          || required.targetId === null
          || options.targetPlugins
            .find((plugin) => plugin.manifest.name === required.plugin)
            ?.manifest.artifacts?.targets
            ?.find((target) => target.id === required.targetId)
            ?.delivery?.mode !== 'codex-native'
        ))
      if (compatibleRequired.length === 0) {
        options.issues.push({
          category: 'unknown',
          code: 'materializedOutputOwnerUnknown',
          message: `The verified source binding does not contain a selected leaf for ${outputPlugin}/${output.skill}/${profile}.`,
          blocking: false,
          path: output.path,
        })
        continue
      }
      const identityKey = materializationIdentityKey({
        plugin: outputPlugin,
        skill: output.skill,
        profile,
        materializationProfile: validation.binding.profile,
      })
      const key = [
        'materialized',
        identityKey,
        output.digest,
      ].join(':')
      const existingSubject = options.subjects.find((subject) => subject.key === key)
      if (existingSubject) {
        if (compareText(output.path, existingSubject.path) < 0) existingSubject.path = output.path
      } else {
        options.subjects.push({
          key,
          kind: 'materialized-skill',
          plugin: outputPlugin,
          skill: output.skill,
          path: output.path,
          profile,
          digest: output.digest,
          origin: 'source-binding',
          materializationProfile: validation.binding.profile,
        })
      }
      finalKeys.push(key)
      const existingFinal = finals.get(key)
      if (existingFinal) {
        if (compareText(output.path, existingFinal.path) < 0) existingFinal.path = output.path
      } else {
        finals.set(key, {
          key,
          plugin: outputPlugin,
          skill: output.skill,
          profile,
          materializationProfile: validation.binding.profile,
          identityKey,
          path: output.path,
          digest: output.digest,
          requiredKeys: compatibleRequired.map((required) => required.key).sort(compareText),
        })
      }
    }
    const materializationIssues: string[] = []
    if (finalKeys.length === 0) {
      const message = 'The verified source binding does not contribute a final to the selected inspection target.'
      materializationIssues.push(message)
      options.issues.push({
        category: 'unknown',
        code: 'sourceBindingUnused',
        message,
        blocking: false,
        path: bindingPath,
      })
    }
    materializations.push({
      path: bindingPath,
      state: 'verified',
      plugin: validation.binding.subject.plugin,
      skill: validation.binding.subject.skill ?? null,
      profile,
      finalKeys: [...new Set(finalKeys)].sort(compareText),
      verifiedBinding: {
        source: validation.binding.source,
        subject: validation.binding.subject,
        profile: validation.binding.profile,
        evalInput: validation.binding.evalInput ?? null,
        finalDigest: validation.binding.finalDigest,
        artifacts: [...validation.outputs].sort((left, right) => compareText(
          `${left.kind}\0${'plugin' in left ? left.plugin : ''}\0${'skill' in left ? left.skill : ''}\0${left.path}`,
          `${right.kind}\0${'plugin' in right ? right.plugin : ''}\0${'skill' in right ? right.skill : ''}\0${right.path}`,
        )),
      },
      issues: materializationIssues,
    })
  }
  return {
    materializations,
    finals: [...finals.values()].sort((left, right) => compareText(left.key, right.key)),
  }
}

interface NavigationFinalCandidate {
  path: string
  digest: string
  evidencePath: string
  state: 'ready' | 'stale'
}

function sameResolvedConfig(
  left: Pick<ReviewResolvedProfile['pluginConfigs'][number], 'values' | 'sources'>,
  right: Pick<ReviewResolvedProfile['pluginConfigs'][number], 'values' | 'sources'>,
): boolean {
  return canonicalJson({ values: left.values, sources: left.sources })
    === canonicalJson({ values: right.values, sources: right.sources })
}

function selectResolvedConfig(
  config: Pick<ReviewResolvedProfile['pluginConfigs'][number], 'values' | 'sources'>,
  keys: readonly string[],
): Pick<ReviewResolvedProfile['pluginConfigs'][number], 'values' | 'sources'> {
  return {
    values: Object.fromEntries(keys.flatMap((key) =>
      Object.hasOwn(config.values, key) ? [[key, config.values[key]!]] : [])),
    sources: Object.fromEntries(keys.flatMap((key) =>
      Object.hasOwn(config.sources, key) ? [[key, config.sources[key]!]] : [])),
  }
}

function selectedSkillConfig(
  profile: ReviewResolvedProfile,
  skill: ReviewSelectedSkill,
): Pick<ReviewResolvedProfile['pluginConfigs'][number], 'values' | 'sources'> | null {
  const entries = profile.pluginConfigs.filter((entry) => entry.pluginName === skill.pluginName)
  if (entries.length === 0) return skill.refreshKeys.length === 0 ? { values: {}, sources: {} } : null
  const values = Object.assign({}, ...entries.map((entry) => entry.values))
  const sources = Object.assign({}, ...entries.map((entry) => entry.sources))
  return selectResolvedConfig({ values, sources }, skill.refreshKeys)
}

function legacyProfileStore(
  scope: Scope,
  values: ReviewProfileConfig[string],
): PluginConfigStore {
  return {
    path: `<legacy-${scope}-profile>`,
    exists: Object.keys(values).length > 0,
    state: 'ready',
    values,
    issues: [],
  }
}

async function legacyBindingMatchesSelection(options: {
  selection: ReviewSelection
  requestedProfile: ReviewResolvedProfile
  skill: ReviewSelectedSkill
  binding: Awaited<ReturnType<typeof readAwSourceBinding>>
  env?: NodeJS.ProcessEnv
}): Promise<boolean> {
  const { binding, requestedProfile, skill } = options
  if (binding.profile.scope !== requestedProfile.scope) return false
  if (binding.profile.kind === 'eval') {
    if (
      requestedProfile.platform !== 'codex'
      || !binding.subject.skill
      || skill.delivery === 'codex-native'
    ) return false
    const plugin = options.selection.workspace.plugins.find((entry) =>
      entry.manifest.name === binding.subject.plugin)
    if (!plugin) return false
    const loaded = await readAwSkillEvalManifest({ plugin, skill: binding.subject.skill })
    const evalProfile = loaded.manifest.profiles.find((entry) => entry.id === binding.profile.id)
    if (!evalProfile) return false
    const config = Object.fromEntries(
      evalProfile.plugins.map((entry) => [entry.name, entry.config]),
    ) as ReviewProfileConfig
    try {
      const requested = selectedSkillConfig(requestedProfile, skill)
      if (!requested) return false
      const overrides = config[skill.pluginName] ?? {}
      const userValues = binding.profile.scope === 'user' ? overrides : {}
      const effective = await resolveEffectivePluginConfigFromStores({
        pluginName: skill.pluginName,
        manifest: skill.plugin.manifest,
        targetScope: binding.profile.scope,
        projectRoot: options.selection.workspace.workspaceRoot,
        stores: {
          user: legacyProfileStore('user', userValues),
          ...(binding.profile.scope === 'project'
            ? { project: legacyProfileStore('project', overrides) }
            : {}),
        },
      })
      return sameResolvedConfig(
        requested,
        selectResolvedConfig(effective, skill.refreshKeys),
      )
    } catch {
      return false
    }
  }
  if (binding.profile.kind !== 'portable' || requestedProfile.platform !== 'agent-skills') {
    return false
  }
  try {
    const requested = selectedSkillConfig(requestedProfile, skill)
    if (!requested) return false
    const current = await resolvePortablePluginProfileConfig({
      plugin: skill.plugin,
      scope: skill.configScope,
      cwd: options.selection.workspace.workspaceRoot,
      env: options.env,
    })
    return sameResolvedConfig(
      requested,
      selectResolvedConfig(current.config, skill.refreshKeys),
    )
  } catch {
    return false
  }
}

function bindingOutputIdentity(
  binding: Awaited<ReturnType<typeof readAwSourceBinding>>,
  artifact: Awaited<ReturnType<typeof readAwSourceBinding>>['artifacts'][number],
): { plugin: string; skill: string } | null {
  if (artifact.kind === 'eval-target') {
    return { plugin: binding.subject.plugin, skill: artifact.skill }
  }
  if (artifact.kind === 'portable-skill' || artifact.kind === 'review-skill') {
    return { plugin: artifact.plugin, skill: artifact.skill }
  }
  return null
}

async function inspectNavigationBindings(options: {
  selection: ReviewSelection
  materializations: readonly string[]
  env?: NodeJS.ProcessEnv
}): Promise<{
  candidates: Map<string, NavigationFinalCandidate[]>
  issues: ReviewInspectionNavigationIssue[]
}> {
  const candidates = new Map<string, NavigationFinalCandidate[]>()
  const issues: ReviewInspectionNavigationIssue[] = []
  const context: AwSourceBindingWorkspaceValidationContext = {
    workspace: options.selection.workspace,
    source: {
      kind: 'workspace',
      workspaceIdentity: options.selection.workspace.workspaceIdentity,
      sourceIdentity: options.selection.sourceIdentity,
    },
  }
  const bindingPaths = [...new Set(options.materializations.map((entry) => path.resolve(entry)))]
    .sort(compareText)
  for (const bindingPath of bindingPaths) {
    let binding: Awaited<ReturnType<typeof readAwSourceBinding>>
    try {
      binding = await readAwSourceBinding(bindingPath)
    } catch (error) {
      throw new ReviewInspectionInputError(
        'sourceBindingInvalid',
        error instanceof Error ? error.message : String(error),
      )
    }
    const validation = await validateAwSourceBindingForWorkspace({
      bindingPath,
      context,
      expectedSubject: binding.subject,
      cwd: options.selection.workspace.workspaceRoot,
      env: options.env,
    })
    if (validation.state === 'invalid' || validation.state === 'incomplete') {
      throw new ReviewInspectionInputError(
        'sourceBindingInvalid',
        validation.issues.map((entry) => entry.message).join('; '),
      )
    }
    let selected = false
    for (const requestedProfile of options.selection.profiles) {
      const profileMatches = binding.profile.kind === 'review'
        ? binding.profile.platform === requestedProfile.platform
          && binding.profile.scope === requestedProfile.scope
        : binding.profile.kind === 'eval'
          ? requestedProfile.platform === 'codex'
          : requestedProfile.platform === 'agent-skills'
      if (!profileMatches) continue
      for (const artifact of binding.artifacts) {
        const identity = bindingOutputIdentity(binding, artifact)
        if (!identity) continue
        const skill = requestedProfile.skills.find((entry) =>
          entry.pluginName === identity.plugin && entry.name === identity.skill)
        if (!skill) continue
        if (
          binding.profile.kind === 'review'
          && !await reviewBindingMatchesSelection({
            workspace: options.selection.workspace,
            bindingProfile: binding.profile,
            requestedProfile,
            pluginName: identity.plugin,
            skill: identity.skill,
          })
        ) continue
        if (
          binding.profile.kind !== 'review'
          && !await legacyBindingMatchesSelection({
            selection: options.selection,
            requestedProfile,
            skill,
            binding,
            env: options.env,
          })
        ) continue
        selected = true
        const key = `${identity.plugin}\0${identity.skill}\0${requestedProfile.platform}\0${requestedProfile.scope}`
        const candidate: NavigationFinalCandidate = {
          path: path.resolve(path.dirname(bindingPath), ...artifact.path.split('/')),
          digest: artifact.digest,
          evidencePath: bindingPath,
          state: validation.state === 'verified' ? 'ready' : 'stale',
        }
        candidates.set(key, [...(candidates.get(key) ?? []), candidate])
      }
    }
    if (!selected) {
      issues.push({
        code: 'materializationNotSelected',
        path: bindingPath,
        message: 'The source binding does not match the selected Skill, profile, and config input.',
      })
    } else if (validation.state === 'drifted') {
      issues.push({
        code: 'sourceBindingDrifted',
        path: bindingPath,
        message: validation.issues.map((entry) => entry.message).join('; '),
      })
    }
  }
  return { candidates, issues }
}

function navigationSkillKey(
  skill: ReviewSelectedSkill,
  profile: ReviewResolvedProfile,
): string {
  return `${skill.pluginName}\0${skill.name}\0${profile.platform}\0${profile.scope}`
}

async function inspectNavigationTarget(options: ReviewInspectionOptions): Promise<ReviewInspectionNavigationReceipt> {
  const selection = await resolveReviewSelection({
    cwd: options.cwd,
    target: options.target,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  try {
  const snapshot = await inspectSnapshot(selection.workspace, selection.sourceIdentity)
  const binding = await inspectNavigationBindings({
    selection,
    materializations: options.materializations ?? [],
    env: options.env,
  })
  const skills: ReviewInspectionNavigationReceipt['skills'] = []
  const issues = [...binding.issues]
  if (snapshot.receipt.state === 'invalid' || snapshot.receipt.state === 'stale') {
    issues.push({
      code: snapshot.receipt.state === 'invalid' ? 'snapshotInvalid' : 'snapshotStale',
      path: snapshot.receipt.path,
      message: snapshot.receipt.state === 'invalid'
        ? 'The existing Catalog snapshot is invalid.'
        : 'The existing Catalog snapshot is not bound to the current Workspace source.',
    })
  }
  for (const profile of selection.profiles) {
    for (const skill of profile.skills) {
      const key = navigationSkillKey(skill, profile)
      const candidates = [...(binding.candidates.get(key) ?? [])]
      if (
        snapshot.root
        && !skill.dynamic
        && profile.platform !== 'agent-skills'
      ) {
        const finalPath = path.join(
          snapshot.root,
          'plugins',
          skill.pluginName,
          profile.platform,
          'skills',
          skill.name,
        )
        try {
          candidates.push({
            path: finalPath,
            digest: await computeSkillDigest(finalPath),
            evidencePath: snapshot.receipt.path,
            state: 'ready',
          })
        } catch {
          // Complete snapshot validation reports invalid final content through its own state.
        }
      }
      const ready = candidates.filter((entry) => entry.state === 'ready')
      const readyDigests = new Set(ready.map((entry) => entry.digest))
      let state: ReviewInspectionNavigationReceipt['skills'][number]['state'] = 'missing'
      let chosen: NavigationFinalCandidate | null = null
      if (readyDigests.size > 1) {
        state = 'invalid'
        issues.push({
          code: 'materializationAmbiguous',
          path: null,
          message: `Current materializations have different digests for ${skill.pluginName}/${skill.name}/${profile.profile.id}.`,
        })
      } else if (ready.length > 0) {
        state = 'ready'
        chosen = ready.sort((left, right) => compareText(
          `${left.evidencePath}\0${left.path}`,
          `${right.evidencePath}\0${right.path}`,
        ))[0]!
      } else {
        const stale = candidates.filter((entry) => entry.state === 'stale')
          .sort((left, right) => compareText(left.evidencePath, right.evidencePath))
        if (stale.length > 0) {
          state = 'stale'
          chosen = stale[0]!
        }
      }
      if (state === 'missing') {
        issues.push({
          code: 'requiredFinalMissing',
          path: skill.sourcePath,
          message: `No current final is available for ${skill.pluginName}/${skill.name}/${profile.profile.id}.`,
        })
      }
      skills.push({
        skill: skill.name,
        sourcePath: skill.sourcePath,
        profile: {
          platform: profile.platform,
          scope: profile.scope,
          inputDigest: profile.profile.inputDigest,
        },
        finalPath: chosen?.path ?? null,
        digest: chosen?.digest ?? null,
        state,
        evidencePath: chosen?.evidencePath ?? null,
      })
    }
  }
  skills.sort((left, right) => compareText(
    `${left.skill}\0${left.profile.platform}\0${left.profile.scope}\0${left.sourcePath}`,
    `${right.skill}\0${right.profile.platform}\0${right.profile.scope}\0${right.sourcePath}`,
  ))
  issues.sort((left, right) => compareText(
    `${left.code}\0${left.path ?? ''}\0${left.message}`,
    `${right.code}\0${right.path ?? ''}\0${right.message}`,
  ))
  return {
    schemaVersion: 2,
    command: 'review:inspect',
    view: 'review',
    ok: true,
    target: { kind: selection.target.kind, path: selection.target.path },
    sources: [...new Set(selection.sources.map((entry) => path.resolve(entry)))].sort(compareText),
    ...(selection.target.kind === 'catalog'
      ? { snapshot: { path: snapshot.receipt.path, state: snapshot.receipt.state } }
      : {}),
    skills,
    issues,
  }
  } catch (error) {
    throw new ReviewInspectionResolvedTargetError(error, {
      kind: selection.target.kind,
      path: selection.target.path,
    })
  }
}

async function inspectReleaseTarget(options: {
  cwd: string
  target: string
  workspaceRoot?: string
  materializations?: readonly string[]
  env?: NodeJS.ProcessEnv
}): Promise<ReviewInspectionReleaseReceipt> {
  const targetCandidate = options.target === 'catalog' ? null : path.resolve(options.cwd, options.target)
  const targetCandidateStat = targetCandidate
    ? await fs.lstat(targetCandidate).catch(() => null)
    : null
  if (targetCandidateStat && (!targetCandidateStat.isDirectory() || targetCandidateStat.isSymbolicLink())) {
    throw new ReviewInspectionInputError(
      'invalidArguments',
      'The release view requires a canonical Plugin or Catalog Workspace directory.',
    )
  }
  const resolution = await resolveCatalogWorkspaceRoot({
    cwd: options.workspaceRoot === undefined && targetCandidateStat?.isDirectory()
      ? targetCandidate!
      : options.cwd,
    ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
    mode: 'existing',
  })
  const workspace = await readCatalogWorkspace(resolution.workspaceRoot, {
    reservedImports: CLI_RESERVED_IMPORTS,
  })
  const workspaceSourceIdentity = await calculateCatalogWorkspaceSourceIdentity(workspace)
  const [target, snapshot] = await Promise.all([
    resolveTarget({ cwd: options.cwd, target: options.target, workspace }),
    inspectSnapshot(workspace, workspaceSourceIdentity),
  ])
  const issues: ReviewInspectionIssue[] = []
  const subjects: ReviewInspectionSubject[] = [{
    key: 'catalog:source',
    kind: 'catalog-source',
    plugin: null,
    skill: null,
    path: workspace.workspaceRoot,
    profile: null,
    digest: workspaceSourceIdentity,
    origin: 'workspace',
  }]
  if (snapshot.receipt.state === 'current') {
    subjects.push({
      key: 'catalog:snapshot',
      kind: 'catalog-snapshot',
      plugin: null,
      skill: null,
      path: snapshot.receipt.path,
      profile: null,
      digest: snapshot.receipt.snapshotDigest!,
      origin: 'catalog-snapshot',
    })
  } else if (snapshot.receipt.state !== 'absent') {
    issues.push({
      category: snapshot.receipt.state === 'invalid' ? 'invalid' : 'unknown',
      code: snapshot.receipt.state === 'invalid' ? 'snapshotInvalid' : 'snapshotStale',
      message: snapshot.receipt.state === 'invalid'
        ? 'The existing Catalog snapshot is invalid.'
        : 'The existing Catalog snapshot is not bound to the current Workspace source.',
      blocking: false,
      path: relativeWorkspacePath(workspace.workspaceRoot, snapshot.receipt.path),
    })
  }

  const seeds: RequiredFinalSeed[] = []
  const pluginInputs: Array<{
    plugin: PluginMeta
    sourceContainerKey: string
    sourceSubjectKeys: string[]
  }> = []
  for (const plugin of target.plugins) {
    const sourceContainerKey = `plugin:${plugin.manifest.name}:source`
    const component = await computeReviewComponentDigest({
      repoRoot: workspace.workspaceRoot,
      path: plugin.rootDir,
    })
    subjects.push({
      key: sourceContainerKey,
      kind: 'aw-plugin-source',
      plugin: plugin.manifest.name,
      skill: null,
      path: plugin.rootDir,
      profile: null,
      digest: component.digest,
      origin: 'workspace',
    })
    const source = await inventoryPluginSource({ workspace, plugin, subjects })
    seeds.push(...source.seeds)
    pluginInputs.push({ plugin, sourceContainerKey, sourceSubjectKeys: source.sourceSubjectKeys })
  }

  const requiredFinals: ReviewInspectionRequiredFinal[] = seeds.map((seed) => ({
    key: requiredFinalKey(seed),
    kind: 'materialized-skill',
    plugin: seed.plugin.manifest.name,
    skill: seed.skill,
    path: null,
    profile: seed.profile,
    digest: null,
    targetId: seed.targetId,
    sourceSubjectKey: seed.sourceSubjectKey,
    status: 'missing',
    matchedFinalKeys: [],
  }))
  const requiredByKey = new Map(requiredFinals.map((entry) => [entry.key, entry]))

  if (snapshot.root) {
    for (const seed of seeds.filter((entry) => !entry.dynamic && !entry.profile.startsWith('agent-skills-'))) {
      const platform = seed.profile.startsWith('codex-') ? 'codex' : 'claude'
      const finalPath = path.join(snapshot.root, 'plugins', seed.plugin.manifest.name, platform, 'skills', seed.skill)
      try {
        const digest = await computeSkillDigest(finalPath)
        const key = `${requiredFinalKey(seed)}:snapshot`
        subjects.push({
          key,
          kind: 'materialized-skill',
          plugin: seed.plugin.manifest.name,
          skill: seed.skill,
          path: finalPath,
          profile: seed.profile,
          digest,
          origin: 'catalog-snapshot',
        })
        const required = requiredByKey.get(requiredFinalKey(seed))!
        required.path = finalPath
        required.digest = digest
        required.status = 'resolved'
        required.matchedFinalKeys.push(key)
      } catch (error) {
        const required = requiredByKey.get(requiredFinalKey(seed))!
        required.status = 'invalid'
        issues.push({
          category: 'invalid',
          code: 'snapshotFinalInvalid',
          message: error instanceof Error ? error.message : String(error),
          blocking: true,
          subjectKey: required.key,
          path: relativeWorkspacePath(workspace.workspaceRoot, finalPath),
        })
      }
    }
  }

  const binding = await inspectMaterializations({
    paths: options.materializations ?? [],
    workspace,
    workspaceSourceIdentity,
    targetPlugins: target.plugins,
    requiredFinals,
    subjects,
    issues,
    env: options.env,
  })
  const bindingFinalsByRequiredKey = new Map<string, VerifiedBindingFinal[]>()
  for (const final of binding.finals) {
    const candidates = requiredFinals.filter((required) =>
      required.plugin === final.plugin
      && required.skill === final.skill
      && required.profile === final.profile
      && final.requiredKeys.includes(required.key))
    if (candidates.length === 1) {
      const required = candidates[0]!
      bindingFinalsByRequiredKey.set(
        required.key,
        [...(bindingFinalsByRequiredKey.get(required.key) ?? []), final],
      )
    } else if (candidates.length > 1) {
      issues.push({
        category: 'unknown',
        code: 'materializedFinalAmbiguous',
        message: `Materialized final ${final.plugin}/${final.skill}/${final.profile} matches multiple declarations.`,
        blocking: true,
        subjectKey: final.key,
      })
    }
  }

  for (const required of requiredFinals) {
    const finals = bindingFinalsByRequiredKey.get(required.key) ?? []
    const byIdentity = new Map<string, VerifiedBindingFinal[]>()
    for (const final of finals) {
      byIdentity.set(final.identityKey, [...(byIdentity.get(final.identityKey) ?? []), final])
    }
    const ambiguous = [...byIdentity.entries()]
      .filter(([, entries]) => new Set(entries.map((entry) => entry.digest)).size > 1)
      .sort(([left], [right]) => compareText(left, right))
    required.matchedFinalKeys = [...new Set([
      ...required.matchedFinalKeys,
      ...finals.map((final) => final.key),
    ])].sort(compareText)
    if (ambiguous.length > 0) {
      required.status = 'unknown'
      required.path = null
      required.digest = null
      for (const [identity] of ambiguous) {
        issues.push({
          category: 'unknown',
          code: 'materializedFinalDigestAmbiguous',
          message: `One materialization identity produced different target digests for ${required.plugin}/${required.skill}/${required.profile}: ${identity}.`,
          blocking: true,
          subjectKey: required.key,
        })
      }
      continue
    }
    if (finals.length > 0) required.status = 'resolved'
    if (required.matchedFinalKeys.length === 1) {
      const subject = subjects.find((entry) => entry.key === required.matchedFinalKeys[0])!
      required.path = subject.path
      required.digest = subject.digest
    } else if (required.matchedFinalKeys.length > 1) {
      required.path = null
      required.digest = null
    }
  }

  for (const required of requiredFinals.filter((entry) => entry.status === 'missing')) {
    issues.push({
      category: 'missing',
      code: 'requiredFinalMissing',
      message: `No current final is available for ${required.plugin}/${required.skill}/${required.profile}.`,
      blocking: false,
      subjectKey: required.key,
    })
  }

  const requiredEvals = await inventoryRequiredEvals({ workspace, seeds, issues })
  for (const required of requiredEvals) {
    required.materializedFinalKeys = binding.finals
      .filter((final) => final.plugin === required.plugin
        && final.skill === required.skill
        && final.profile === required.finalProfile
        && final.materializationProfile.kind === 'eval'
        && final.materializationProfile.id === required.evalProfile.id
        && final.materializationProfile.inputDigest === required.evalProfile.inputDigest)
      .map((final) => final.key)
      .sort(compareText)
    required.verifiedBindingPaths = [...new Set(binding.materializations
      .filter((materialization) =>
        materialization.state === 'verified'
        && materialization.verifiedBinding?.subject.plugin === required.plugin
        && materialization.verifiedBinding.subject.skill === required.skill
        && materialization.verifiedBinding.subject.suite === required.suite.id
        && materialization.verifiedBinding.profile.kind === 'eval'
        && materialization.verifiedBinding.profile.id === required.evalProfile.id
        && materialization.verifiedBinding.profile.inputDigest === required.evalProfile.inputDigest)
      .map((materialization) => materialization.path))]
      .sort(compareText)
    if (required.materializedFinalKeys.length === 0) {
      const snapshotFinal = (requiredByKey.get(required.requiredFinalKey)?.matchedFinalKeys ?? [])
        .filter((key) => subjects.some((subject) =>
          subject.key === key && subject.origin === 'catalog-snapshot'))
      required.materializedFinalKeys = [...snapshotFinal]
    }
  }

  const plugins: ReviewInspectionPlugin[] = pluginInputs.map(({ plugin, sourceContainerKey, sourceSubjectKeys }) => {
    const entry = snapshot.receipt.state === 'current' ? snapshot.entries.get(plugin.manifest.name) : undefined
    let finalContainerKey: string | null = null
    if (entry && snapshot.root) {
      finalContainerKey = `plugin:${plugin.manifest.name}:snapshot`
      subjects.push({
        key: finalContainerKey,
        kind: 'aw-plugin',
        plugin: plugin.manifest.name,
        skill: null,
        path: path.join(snapshot.root, 'plugins', plugin.manifest.name),
        profile: null,
        digest: entry.artifactDigest,
        origin: 'catalog-snapshot',
      })
    }
    const pluginFinals = requiredFinals.filter((required) => required.plugin === plugin.manifest.name)
    const pluginEvals = requiredEvals.filter((required) => required.plugin === plugin.manifest.name)
    return {
      id: plugin.manifest.name,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      path: plugin.rootDir,
      sourceContainerKey,
      finalContainerKey,
      dependencies: [...(plugin.manifest.dependencies ?? [])].sort(compareText),
      supportedPlatforms: [...resolveSupportedPlatforms(plugin.manifest)].sort(compareText),
      finalProfiles: [...new Set(pluginFinals.map((entry) => entry.profile))].sort(compareText),
      imports: pluginImports(plugin),
      snapshotEntry: entry ? {
        artifactDigest: entry.artifactDigest,
        manifestDigest: entry.manifestDigest,
        contentDigest: entry.contentDigest,
      } : null,
      sourceSubjectKeys,
      requiredFinalKeys: pluginFinals.map((entry) => entry.key).sort(compareText),
      requiredEvalKeys: pluginEvals.map((entry) => entry.key).sort(compareText),
    }
  })

  issues.push(...binding.materializations
    .filter((entry) => entry.state !== 'verified')
    .map((entry): ReviewInspectionIssue => ({
      category: entry.state === 'incomplete'
        ? 'missing'
        : entry.state === 'unsupported' ? 'unsupported' : entry.state === 'drifted' ? 'unknown' : 'invalid',
      code: `sourceBinding${entry.state[0]!.toUpperCase()}${entry.state.slice(1)}`,
      message: entry.issues.join('; ') || `Source binding is ${entry.state}.`,
      blocking: true,
      path: entry.path,
    })))
  issues.sort((left, right) => compareText(
    `${left.code}\0${left.subjectKey ?? ''}\0${left.path ?? ''}`,
    `${right.code}\0${right.subjectKey ?? ''}\0${right.path ?? ''}`,
  ))
  subjects.sort((left, right) => compareText(left.key, right.key))
  const ok = !issues.some((issue) => issue.blocking)
  return {
    schemaVersion: 2,
    command: 'review:inspect',
    view: 'release',
    ok,
    completeness: ok && requiredFinals.every((entry) => entry.status === 'resolved')
      ? 'complete' : 'incomplete',
    target: { kind: target.kind, id: target.id, path: target.path },
    workspace: {
      root: workspace.workspaceRoot,
      resolvedFrom: resolution.workspaceRootResolvedFrom,
      identity: workspace.workspaceIdentity,
      sourceIdentity: workspaceSourceIdentity,
      catalogVersion: workspace.metadata.catalog.version,
    },
    snapshot: snapshot.receipt,
    plugins,
    subjects,
    requiredFinals,
    finalMappings: requiredFinals.map((required) => ({
      requiredFinalKey: required.key,
      sourceSubjectKey: required.sourceSubjectKey,
      finalSubjectKeys: [...required.matchedFinalKeys].sort(compareText),
      status: required.status,
    })),
    requiredEvals,
    materializations: binding.materializations,
    issues,
  }
}

export function inspectReviewTarget(
  options: ReviewInspectionOptions & { view: 'release' },
): Promise<ReviewInspectionReleaseReceipt>
export function inspectReviewTarget(
  options: ReviewInspectionOptions & { view?: 'review' },
): Promise<ReviewInspectionNavigationReceipt>
export function inspectReviewTarget(
  options: ReviewInspectionOptions,
): Promise<ReviewInspectionReceipt>
export async function inspectReviewTarget(
  options: ReviewInspectionOptions,
): Promise<ReviewInspectionReceipt> {
  const view = options.view ?? 'review'
  if (view === 'release') {
    if (
      (options.skills !== undefined && options.skills.length > 0)
      || options.platform !== undefined
      || options.scope !== undefined
      || options.configFile !== undefined
    ) {
      throw new ReviewInspectionInputError(
        'invalidArguments',
        'The release view requires the complete Plugin or Catalog target and does not accept selection options.',
      )
    }
    return await inspectReleaseTarget(options)
  }
  return await inspectNavigationTarget(options)
}

export type ReviewInspectionFailureReceipt =
  | Omit<ReviewInspectionNavigationReceipt, 'snapshot'>
  | {
      schemaVersion: 2
      command: 'review:inspect'
      view: 'release'
      ok: false
      completeness: 'incomplete'
      issues: ReviewInspectionIssue[]
    }

export function getReviewInspectionErrorCode(
  error: unknown,
  fallback = 'reviewInspectionFailed',
): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return fallback
}

export function getReviewInspectionExitCode(error: unknown): 1 | 2 | 3 {
  if (error && typeof error === 'object' && 'exitCode' in error) {
    const exitCode = (error as { exitCode?: unknown }).exitCode
    if (exitCode === 2 || exitCode === 3) return exitCode
  }
  return 1
}

function getReviewInspectionResolvedTarget(
  error: unknown,
): ReviewInspectionNavigationReceipt['target'] {
  if (!error || typeof error !== 'object' || !('reviewTarget' in error)) return null
  const target = (error as { reviewTarget?: unknown }).reviewTarget
  if (!target || typeof target !== 'object') return null
  const kind = (target as { kind?: unknown }).kind
  const targetPath = (target as { path?: unknown }).path
  if (
    (kind !== 'skill' && kind !== 'plugin' && kind !== 'catalog')
    || typeof targetPath !== 'string'
    || targetPath === ''
  ) return null
  return { kind, path: targetPath }
}

export function createReviewInspectionFailure(
  error: unknown,
  view: ReviewInspectionView = 'review',
  fallbackCode = 'reviewInspectionFailed',
): ReviewInspectionFailureReceipt {
  const code = getReviewInspectionErrorCode(error, fallbackCode)
  const message = error instanceof Error ? error.message : String(error)
  if (view === 'release') {
    return {
      schemaVersion: 2,
      command: 'review:inspect',
      view,
      ok: false,
      completeness: 'incomplete',
      issues: [{ category: 'invalid', code, message, blocking: true }],
    }
  }
  return {
    schemaVersion: 2,
    command: 'review:inspect',
    view,
    ok: false,
    target: getReviewInspectionResolvedTarget(error),
    sources: [],
    skills: [],
    issues: [{ code, path: null, message }],
  }
}
