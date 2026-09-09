import path from 'node:path'

import {
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

export type ReviewInspectionIssueCategory = 'missing' | 'invalid' | 'unsupported' | 'unknown'
export type ReviewInspectionFinalProfile =
  | 'codex-user'
  | 'codex-project'
  | 'claude-user'
  | 'claude-project'
  | 'agent-skills-user'
  | 'agent-skills-project'

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
    kind: 'eval' | 'portable'
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

export interface ReviewInspectionReceipt {
  schemaVersion: 1
  command: 'review:inspect'
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
  receipt: ReviewInspectionReceipt['snapshot']
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
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value
}

function relativeWorkspacePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join('/') || '.'
}

function sourceKey(plugin: string, skill: string, kind: ReviewInspectionSubject['kind']): string {
  return `source:${plugin}:${skill}:${kind}`
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

async function directSkillDirectories(root: string): Promise<Array<{ name: string; root: string }>> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const result: Array<{ name: string; root: string }> = []
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const entryPath = path.join(root, entry.name)
    const stat = await fs.lstat(entryPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Skill collection direct child must be a regular directory: ${entryPath}`)
    }
    result.push({ name: entry.name, root: entryPath })
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
  kind: 'source-skill' | 'portable-source-skill' | 'artifact-source'
}): Promise<string> {
  const key = sourceKey(options.plugin.manifest.name, options.skill, options.kind)
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
  const nativeByName = new Map(nativeSkills.map((entry) => [entry.name, entry]))
  const portableByName = new Map(portableSkills.map((entry) => [entry.name, entry]))
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
          sourceSubjectKey: sourceKey(plugin.manifest.name, skill.name, 'source-skill'),
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
          sourceSubjectKey: sourceKey(plugin.manifest.name, skill.name, 'portable-source-skill'),
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
    const sourceEntry = target.target === 'agent-skills.skill'
      ? portableByName.get(skill) ?? nativeByName.get(skill)
      : nativeByName.get(skill)
    let sourceSubjectKey = target.target === 'agent-skills.skill' && portableByName.has(skill)
      ? sourceKey(plugin.manifest.name, skill, 'portable-source-skill')
      : sourceKey(plugin.manifest.name, skill, 'source-skill')
    if (!sourceEntry) {
      const declaredSource = target.sourceDirs?.[0]
      const sourceRoot = declaredSource
        ? path.join(plugin.rootDir, stripDotSlash(declaredSource))
        : path.join(plugin.rootDir, stripDotSlash(plugin.manifest.scripts?.artifacts?.render?.path ?? '.agents-plugin'))
      sourceSubjectKey = await addSourceSubject({
        workspace,
        subjects,
        plugin,
        skill,
        root: sourceRoot,
        kind: 'artifact-source',
      })
      sourceSubjectKeys.push(sourceSubjectKey)
    }
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
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Review inspection target must be a canonical Plugin or Catalog Workspace directory.')
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
    throw new Error('Review inspection target is not a canonical Plugin in the selected Catalog Workspace.')
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
  for (const bindingPath of options.paths) {
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
        profile: validation.binding
          ? validation.binding.profile.kind === 'eval'
            ? `codex-${validation.binding.profile.scope}`
            : `agent-skills-${validation.binding.profile.scope}`
          : null,
        finalKeys: [],
        verifiedBinding: null,
        issues: validation.issues.map((issue) => issue.message),
      })
      continue
    }
    const profile: ReviewInspectionFinalProfile = validation.binding.profile.kind === 'eval'
      ? `codex-${validation.binding.profile.scope}`
      : `agent-skills-${validation.binding.profile.scope}`
    const finalKeys: string[] = []
    for (const output of validation.outputs) {
      if (output.kind !== 'eval-target' && output.kind !== 'portable-skill') continue
      const outputPlugin = output.kind === 'portable-skill'
        ? output.plugin
        : validation.binding.subject.plugin
      if (!targetPluginNames.has(outputPlugin)) continue
      const belongsToSelectedPlugin = options.requiredFinals.some((required) =>
        required.plugin === outputPlugin
        && required.skill === output.skill
        && required.profile === profile)
      if (!belongsToSelectedPlugin) {
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

export async function inspectReviewTarget(options: {
  cwd: string
  target: string
  workspaceRoot?: string
  materializations?: readonly string[]
  env?: NodeJS.ProcessEnv
}): Promise<ReviewInspectionReceipt> {
  const targetCandidate = options.target === 'catalog' ? null : path.resolve(options.cwd, options.target)
  const targetCandidateStat = targetCandidate
    ? await fs.lstat(targetCandidate).catch(() => null)
    : null
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
      && required.profile === final.profile)
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
      const snapshotFinal = requiredByKey.get(required.requiredFinalKey)?.matchedFinalKeys ?? []
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
    schemaVersion: 1,
    command: 'review:inspect',
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

export function createReviewInspectionFailure(
  error: unknown,
  code = 'reviewInspectionFailed',
): {
  schemaVersion: 1
  command: 'review:inspect'
  ok: false
  completeness: 'incomplete'
  issues: ReviewInspectionIssue[]
} {
  return {
    schemaVersion: 1,
    command: 'review:inspect',
    ok: false,
    completeness: 'incomplete',
    issues: [{
      category: 'invalid',
      code,
      message: error instanceof Error ? error.message : String(error),
      blocking: true,
    }],
  }
}
