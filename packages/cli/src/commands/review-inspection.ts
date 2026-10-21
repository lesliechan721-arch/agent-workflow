import path from 'node:path'

import { canonicalJson, computeSkillDigest } from '@lesliechan721/agent-skill-eval'
import {
  DEFAULT_CATALOG_OUTPUT_PATH,
  GENERATED_OUTPUT_MARKER_FILENAME,
  validateCatalogSnapshotComplete,
  type CatalogWorkspace,
  type Scope,
} from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'

import { readAwSkillEvalManifest } from '../eval/manifest-v1.js'
import {
  readAwSourceBinding,
  resolvePortablePluginProfileConfig,
  validateAwSourceBindingForWorkspace,
  type AwSourceBindingWorkspaceValidationContext,
} from '../review/source-binding.js'
import {
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

export type ReviewInspectionView = 'review'
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

export type ReviewInspectionReceipt = ReviewInspectionNavigationReceipt

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

interface SnapshotInspection {
  receipt: NonNullable<ReviewInspectionNavigationReceipt['snapshot']>
  root: string | null
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

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
      },
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
      },
      root: current ? validation.rootDir : null,
    }
  } catch {
    return {
      receipt: {
        path: snapshotPath,
        state: 'invalid',
      },
      root: null,
    }
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

export async function inspectReviewTarget(
  options: ReviewInspectionOptions,
): Promise<ReviewInspectionReceipt> {
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

export type ReviewInspectionFailureReceipt = Omit<ReviewInspectionNavigationReceipt, 'snapshot'>

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
  fallbackCode = 'reviewInspectionFailed',
): ReviewInspectionFailureReceipt {
  const code = getReviewInspectionErrorCode(error, fallbackCode)
  const message = error instanceof Error ? error.message : String(error)
  return {
    schemaVersion: 2,
    command: 'review:inspect',
    view: 'review',
    ok: false,
    target: getReviewInspectionResolvedTarget(error),
    sources: [],
    skills: [],
    issues: [{ code, path: null, message }],
  }
}
