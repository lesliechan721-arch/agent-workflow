import path from 'node:path'

import { calculateCatalogWorkspaceSourceIdentity } from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'

import { materializeReviewNativeSkills } from './rebuild-integration.js'
import { resolveReviewSelection } from '../review/review-selection.js'
import {
  ReviewSelectionError,
  type ReviewPlatform,
  type ReviewResolvedProfile,
  type ReviewSelection,
} from '../review/review-types.js'
import {
  createIsolatedSkillEnv,
  prepareSkillPluginBundle,
  type PreparedSkillPluginBundle,
} from '../review/skill-materialization.js'
import {
  AW_SOURCE_BINDING_FILENAME,
  writeAwSourceBinding,
} from '../review/source-binding.js'
import type { PluginMeta, Scope } from '../types.js'
import { materializePortableSkills } from '../portable/materializer.js'
import { writePluginConfigStore } from '../utils/plugin-config.js'
import {
  getCodexHome,
  resolveAwHome,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveRepoRoot,
} from '../utils/paths.js'

export interface ReviewPreparationIssue {
  code: string
  path: string | null
  message: string
}

export interface ReviewPreparationSkill {
  skill: string
  sourcePath: string
  profile: {
    platform: ReviewPlatform
    scope: Scope
    inputDigest: string | null
  }
  finalPath: string | null
  digest: string | null
  state: 'ready' | 'missing' | 'stale' | 'invalid' | 'unsupported'
  evidencePath: string | null
}

export interface ReviewPreparationV1 {
  schemaVersion: 1
  command: 'review:prepare'
  ok: boolean
  target: { kind: 'skill' | 'plugin'; path: string } | null
  sourceBindingPath: string | null
  skills: ReviewPreparationSkill[]
  issues: ReviewPreparationIssue[]
}

export interface PrepareReviewTargetOptions {
  cwd: string
  target: string
  workspaceRoot?: string
  skills?: string[]
  platform: ReviewPlatform
  scope: Scope
  configFile?: string
  out: string
  env?: NodeJS.ProcessEnv
  scriptTimeoutMs?: number
}

export interface ReviewPreparationResult {
  receipt: ReviewPreparationV1
  exitCode: 0 | 1 | 2 | 3
}

class ReviewPreparationError extends Error {
  readonly code: string
  readonly exitCode: 1 | 2 | 3
  readonly issuePath: string | null

  constructor(code: string, message: string, exitCode: 1 | 2 | 3, issuePath: string | null = null) {
    super(message)
    this.name = 'ReviewPreparationError'
    this.code = code
    this.exitCode = exitCode
    this.issuePath = issuePath
  }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left)
}

async function resolvePhysicalPath(target: string): Promise<string> {
  let current = path.resolve(target)
  const suffix: string[] = []
  while (true) {
    const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info) {
      if (info.isSymbolicLink()) {
        throw new ReviewPreparationError(
          'unsafeOutput',
          `Output path contains a symbolic link: ${current}.`,
          2,
          current,
        )
      }
      if (!info.isDirectory()) {
        throw new ReviewPreparationError(
          'unsafeOutput',
          `Output parent is not a regular directory: ${current}.`,
          2,
          current,
        )
      }
      return path.join(await fs.realpath(current), ...suffix)
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new ReviewPreparationError(
        'unsafeOutput',
        'Output path has no existing directory ancestor.',
        2,
        path.resolve(target),
      )
    }
    suffix.unshift(path.basename(current))
    current = parent
  }
}

async function installationRoots(options: {
  cwd: string
  env: NodeJS.ProcessEnv
}): Promise<string[]> {
  const repoRoot = await resolveRepoRoot(options.cwd)
  const roots = [
    resolveAwHome(options.env),
    getCodexHome(options.env),
    path.join(repoRoot, '.agents'),
    resolveCodexPaths(options.cwd, 'project', options.env).configDir,
    resolveCodexPaths(options.cwd, 'user', options.env).configDir,
    resolveClaudePaths(options.cwd, 'project', options.env).configDir,
    resolveClaudePaths(options.cwd, 'user', options.env).configDir,
  ]
  return [...new Set(roots.map((root) => path.resolve(root)))]
}

async function assertSafeOutput(options: {
  target: string
  selection: ReviewSelection
  cwd: string
  env: NodeJS.ProcessEnv
}): Promise<string> {
  const target = await resolvePhysicalPath(options.target)
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    throw new ReviewPreparationError(
      'unsafeOutput',
      `Review output already exists: ${target}.`,
      2,
      target,
    )
  }
  const sourceRoots = await Promise.all(options.selection.workspace.plugins.map((plugin) =>
    fs.realpath(plugin.rootDir)))
  const blockedRoots = [
    ...sourceRoots,
    ...await installationRoots(options),
  ]
  if (target === path.parse(target).root
    || blockedRoots.some((root) => pathsOverlap(root, target))) {
    throw new ReviewPreparationError(
      'unsafeOutput',
      'Review output is too broad or overlaps source or installation content.',
      2,
      target,
    )
  }
  await fs.ensureDir(path.dirname(target))
  const rechecked = await resolvePhysicalPath(target)
  if (rechecked !== target) {
    throw new ReviewPreparationError(
      'unsafeOutput',
      'Review output path changed during validation.',
      2,
      target,
    )
  }
  return target
}

function preparedPluginIdentity(options: {
  plugin: PluginMeta
  sourceIdentity: string
  workspaceIdentity: string
}): PluginMeta {
  const sourceId = options.plugin.sourceId ?? 'review-source'
  return {
    ...options.plugin,
    sourceId,
    sourceIdentity: options.plugin.sourceIdentity ?? options.sourceIdentity,
    catalogLogicalIdentity: options.plugin.catalogLogicalIdentity ?? options.workspaceIdentity,
    pluginId: options.plugin.pluginId ?? `${sourceId}/${options.plugin.manifest.name}`,
  }
}

function selectedProfile(selection: ReviewSelection): ReviewResolvedProfile {
  if (selection.profiles.length !== 1) {
    throw new ReviewPreparationError(
      'unsupportedProfile',
      'Review preparation requires exactly one resolved platform and scope profile.',
      2,
      selection.target.path,
    )
  }
  return selection.profiles[0]!
}

function targetReceipt(selection: ReviewSelection): ReviewPreparationV1['target'] {
  return selection.target.kind === 'catalog'
    ? null
    : { kind: selection.target.kind, path: selection.target.path }
}

function failedReceipt(options: {
  target: ReviewPreparationV1['target']
  issues: ReviewPreparationIssue[]
}): ReviewPreparationV1 {
  return {
    schemaVersion: 1,
    command: 'review:prepare',
    ok: false,
    target: options.target,
    sourceBindingPath: null,
    skills: [],
    issues: options.issues,
  }
}

function sameResolvedInput(
  before: ReviewSelection,
  beforeProfile: ReviewResolvedProfile,
  after: ReviewSelection,
): boolean {
  if (
    after.sourceIdentity !== before.sourceIdentity
    || after.target.kind !== before.target.kind
    || after.target.path !== before.target.path
    || after.profiles.length !== 1
  ) return false
  const afterProfile = after.profiles[0]!
  const skillIdentity = (profile: ReviewResolvedProfile): string => JSON.stringify(
    profile.skills.map((skill) => [
      skill.pluginName,
      skill.name,
      skill.targetId,
      skill.delivery,
      skill.configScope,
    ]).sort(),
  )
  return JSON.stringify(afterProfile.profile) === JSON.stringify(beforeProfile.profile)
    && skillIdentity(afterProfile) === skillIdentity(beforeProfile)
}

async function resolveSelection(options: PrepareReviewTargetOptions): Promise<ReviewSelection> {
  return resolveReviewSelection({
    cwd: options.cwd,
    target: options.target,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    platform: options.platform,
    scope: options.scope,
    ...(options.configFile ? { configFile: options.configFile } : {}),
    env: options.env,
  })
}

async function writeIsolatedConfig(options: {
  profile: ReviewResolvedProfile
  plugins: ReadonlyMap<string, PluginMeta>
  cwd: string
  env: NodeJS.ProcessEnv
}): Promise<void> {
  for (const config of options.profile.pluginConfigs) {
    const plugin = options.plugins.get(config.pluginName)
    if (!plugin) {
      throw new Error(`Review config references unresolved plugin "${config.pluginName}".`)
    }
    await writePluginConfigStore({
      sourceId: plugin.sourceId,
      sourceIdentity: plugin.sourceIdentity,
      logicalIdentity: plugin.catalogLogicalIdentity,
      pluginName: config.pluginName,
      scope: config.scope,
      cwd: options.cwd,
      values: config.overrides,
      env: options.env,
    })
  }
}

async function prepareSelectedSkills(options: {
  selection: ReviewSelection
  profile: ReviewResolvedProfile
  outputRoot: string
  workRoot: string
  env: NodeJS.ProcessEnv
  cwd: string
  scriptTimeoutMs?: number
}): Promise<void> {
  const pluginNames = new Set(options.profile.skills.map((skill) => skill.pluginName))
  if (pluginNames.size !== 1) {
    throw new Error('One review preparation output must contain Skills from exactly one plugin.')
  }
  const pluginName = [...pluginNames][0]!
  const sourcePlugin = options.selection.workspace.plugins.find((plugin) =>
    plugin.manifest.name === pluginName)
  if (!sourcePlugin) throw new Error(`Selected plugin "${pluginName}" is unresolved.`)

  let prepared: PreparedSkillPluginBundle | undefined
  let portable: Awaited<ReturnType<typeof materializePortableSkills>> | undefined
  try {
    prepared = await prepareSkillPluginBundle({
      plugin: sourcePlugin,
      plugins: options.selection.workspace.plugins,
      workRoot: path.join(options.workRoot, 'bundle'),
      env: options.env,
    })
    const bundlePlugin = preparedPluginIdentity({
      plugin: prepared.bundlePlugin,
      sourceIdentity: options.selection.sourceIdentity,
      workspaceIdentity: options.selection.workspace.workspaceIdentity,
    })
    const plugins = new Map(options.selection.workspace.plugins.map((plugin) => [
      plugin.manifest.name,
      preparedPluginIdentity({
        plugin,
        sourceIdentity: options.selection.sourceIdentity,
        workspaceIdentity: options.selection.workspace.workspaceIdentity,
      }),
    ]))
    plugins.set(pluginName, bundlePlugin)
    await writeIsolatedConfig({
      profile: options.profile,
      plugins,
      cwd: options.cwd,
      env: options.env,
    })

    if (options.profile.platform === 'agent-skills') {
      const portableRoot = path.join(options.workRoot, 'portable')
      portable = await materializePortableSkills({
        plugins: [...plugins.values()],
        pluginId: bundlePlugin.pluginId!,
        scope: options.profile.scope,
        cwd: options.cwd,
        env: options.env,
        outputRoot: portableRoot,
        inputMode: 'bundle',
        selectedSkills: options.profile.skills.map((skill) => skill.name),
      })
      await fs.copy(path.join(portable.rootDir, 'skills'), path.join(options.outputRoot, 'skills'), {
        overwrite: false,
        errorOnExist: true,
        dereference: false,
      })
      return
    }

    await materializeReviewNativeSkills({
      plugin: bundlePlugin,
      platform: options.profile.platform,
      scope: options.profile.scope,
      cwd: options.cwd,
      env: options.env,
      outputRoot: options.outputRoot,
      skills: options.profile.skills.map((skill) => ({
        skill: skill.name,
        targetId: skill.targetId,
      })),
      scriptTimeoutMs: options.scriptTimeoutMs,
    })
  } finally {
    await portable?.cleanup()
    await prepared?.cleanup()
  }
}

function normalizeError(error: unknown): ReviewPreparationError {
  if (error instanceof ReviewPreparationError) return error
  if (error instanceof ReviewSelectionError) {
    return new ReviewPreparationError(error.code, error.message, error.exitCode)
  }
  return new ReviewPreparationError(
    'materializationFailed',
    error instanceof Error ? error.message : String(error),
    1,
  )
}

export async function prepareReviewTarget(
  options: PrepareReviewTargetOptions,
): Promise<ReviewPreparationResult> {
  let selection: ReviewSelection | undefined
  let profile: ReviewResolvedProfile | undefined
  let stagingRoot: string | undefined
  let finalOutput: string | undefined
  let committed = false
  try {
    selection = await resolveSelection(options)
    if (selection.target.kind === 'catalog') {
      throw new ReviewPreparationError(
        'invalidArguments',
        'Review preparation accepts a plugin or source Skill target.',
        2,
        selection.target.path,
      )
    }
    profile = selectedProfile(selection)
    if (profile.skills.length === 0) {
      throw new ReviewPreparationError(
        'unsupportedProfile',
        'The selected profile does not contain a Skill to prepare.',
        2,
        selection.target.path,
      )
    }

    const baseEnv = options.env ?? process.env
    finalOutput = await assertSafeOutput({
      target: path.resolve(options.cwd, options.out),
      selection,
      cwd: options.cwd,
      env: baseEnv,
    })
    stagingRoot = await fs.mkdtemp(path.join(
      path.dirname(finalOutput),
      `.aw-review-${path.basename(finalOutput)}-`,
    ))
    const stagedOutput = path.join(stagingRoot, 'output')
    const workRoot = path.join(stagingRoot, 'work')
    const materializationCwd = path.join(stagingRoot, 'project')
    const env = await createIsolatedSkillEnv(baseEnv, path.join(stagingRoot, 'environment'))
    await fs.ensureDir(path.join(materializationCwd, '.git'))
    await fs.ensureDir(stagedOutput)

    await prepareSelectedSkills({
      selection,
      profile,
      outputRoot: stagedOutput,
      workRoot,
      env,
      cwd: materializationCwd,
      scriptTimeoutMs: options.scriptTimeoutMs,
    })

    const artifacts = profile.skills.map((skill) => ({
      kind: 'review-skill' as const,
      plugin: skill.pluginName,
      skill: skill.name,
      path: `skills/${skill.name}`,
    }))
    const writtenBinding = await writeAwSourceBinding({
      rootDir: stagedOutput,
      source: {
        kind: 'workspace',
        workspaceIdentity: selection.workspace.workspaceIdentity,
        sourceIdentity: selection.sourceIdentity,
      },
      subject: {
        plugin: profile.skills[0]!.pluginName,
        ...(selection.target.kind === 'skill'
          ? { skill: selection.target.skill ?? profile.skills[0]!.name }
          : {}),
      },
      profile: profile.profile,
      artifacts,
    })

    const rechecked = await resolveSelection(options).catch(() => {
      throw new ReviewPreparationError(
        'sourceChanged',
        'Review source or config changed while output was staged.',
        3,
        selection!.target.path,
      )
    })
    if (!sameResolvedInput(selection, profile, rechecked)) {
      throw new ReviewPreparationError(
        'sourceChanged',
        'Review source or config changed while output was staged.',
        3,
        selection.target.path,
      )
    }
    const recheckedOutput = await assertSafeOutput({
      target: finalOutput,
      selection: rechecked,
      cwd: options.cwd,
      env: baseEnv,
    })
    if (recheckedOutput !== finalOutput) {
      throw new ReviewPreparationError(
        'unsafeOutput',
        'Review output path changed while output was staged.',
        2,
        finalOutput,
      )
    }

    await fs.remove(workRoot)
    await fs.remove(path.join(stagingRoot, 'environment'))
    await fs.remove(materializationCwd)
    await fs.rename(stagedOutput, finalOutput)
    committed = true
    const successIssues: ReviewPreparationIssue[] = []
    await fs.remove(stagingRoot).catch((cleanupError) => {
      successIssues.push({
        code: 'cleanupResidue',
        path: stagingRoot!,
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    })
    stagingRoot = undefined

    const sourceBindingPath = path.join(finalOutput, AW_SOURCE_BINDING_FILENAME)
    const digests = new Map(writtenBinding.binding.artifacts
      .filter((artifact) => artifact.kind === 'review-skill')
      .map((artifact) => [`${artifact.plugin}\0${artifact.skill}`, artifact.digest]))
    return {
      exitCode: 0,
      receipt: {
        schemaVersion: 1,
        command: 'review:prepare',
        ok: true,
        target: targetReceipt(selection),
        sourceBindingPath,
        skills: profile.skills.map((skill) => ({
          skill: skill.name,
          sourcePath: skill.sourcePath,
          profile: {
            platform: profile!.platform,
            scope: profile!.scope,
            inputDigest: profile!.profile.inputDigest,
          },
          finalPath: path.join(finalOutput!, 'skills', skill.name),
          digest: digests.get(`${skill.pluginName}\0${skill.name}`) ?? null,
          state: 'ready',
          evidencePath: sourceBindingPath,
        })),
        issues: successIssues,
      },
    }
  } catch (caught) {
    let error = normalizeError(caught)
    if (selection && profile && stagingRoot && error.code !== 'sourceChanged') {
      try {
        const current = await resolveSelection(options)
        if (!sameResolvedInput(selection, profile, current)) {
          error = new ReviewPreparationError(
            'sourceChanged',
            'Review source or config changed while output was staged.',
            3,
            selection.target.path,
          )
        }
      } catch {
        const currentIdentity = await calculateCatalogWorkspaceSourceIdentity(selection.workspace)
          .catch(() => selection!.sourceIdentity)
        if (currentIdentity !== selection.sourceIdentity) {
          error = new ReviewPreparationError(
            'sourceChanged',
            'Review source changed while output was staged.',
            3,
            selection.target.path,
          )
        }
      }
    }
    const issues: ReviewPreparationIssue[] = [{
      code: error.code,
      path: error.issuePath,
      message: error.message,
    }]
    if (!committed && finalOutput && await fs.pathExists(finalOutput)) {
      issues.push({
        code: 'unsafeOutput',
        path: finalOutput,
        message: 'Review output appeared while preparation was running; it was not modified.',
      })
    }
    if (stagingRoot) {
      try {
        await fs.remove(stagingRoot)
      } catch (cleanupError) {
        issues.push({
          code: 'cleanupResidue',
          path: stagingRoot,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        })
      }
    }
    return {
      exitCode: error.exitCode,
      receipt: failedReceipt({
        target: selection ? targetReceipt(selection) : null,
        issues,
      }),
    }
  }
}
