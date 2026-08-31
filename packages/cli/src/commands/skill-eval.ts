import os from 'node:os'
import path from 'node:path'

import {
  assertEvalProviderSuiteKind,
  computeCanonicalDirectoryDigest,
  computeEvalFileDigest,
  createRuntimeSkillSnapshot,
  validateEvalSpecFile,
  validateSelectedCasesFile,
  type EvalProvider,
  type EvalSpec,
  type SelectedCasesDocument,
} from '@lesliechan721/agent-skill-eval'
import { readCatalogWorkspace } from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'

import {
  materializeAwSkillEvalSubject,
  resolveMaterializedSubjectRoot,
  type AwSkillEvalMaterializationProfile,
} from '../../scripts/aw-skill-eval-materializer.js'
import type { CatalogWorkspaceResolvedFrom } from './catalog-workspace-resolution.js'
import {
  assertNoSensitiveProfileConfig,
  readAwSkillEvalManifest,
  resolveAwSkillEvalCustomCommand,
  type AwSkillEvalManifestV1Profile,
  type AwSkillEvalManifestV1Suite,
} from '../eval/manifest-v1.js'
import type { PluginMeta } from '../types.js'
import { validateSkillDirectory } from '../utils/dynamic-skill-tree.js'
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js'
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js'

const safeSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export interface SkillEvalSelection {
  workspaceRoot: string
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom
  pluginName: string
  skillName: string
  suiteId?: string
  profileId?: string
}

export interface PrepareSkillEvalOptions extends SkillEvalSelection {
  output: string
  cwd: string
  env?: NodeJS.ProcessEnv
  split?: string
  caseId?: string
  runs?: number
  baseline?: 'without-skill'
  previousVersion?: string
  timeoutMs?: number
  keepWorkspace?: boolean
}

export interface PrepareSkillEvalReceipt {
  schemaVersion: 1
  command: 'skill:eval:prepare'
  ok: true
  suite: string
  profile: string
  specPath: string
  targetDigest: string
  corpusDigest: string
  workspacePath?: string
}

interface ResolvedSelection {
  workspaceRoot: string
  plugin: PluginMeta
  plugins: PluginMeta[]
  evalRoot: string
  suite: AwSkillEvalManifestV1Suite
  profile: AwSkillEvalManifestV1Profile
  cases: SelectedCasesDocument
  defaults: { runs?: number; timeoutMs?: number }
  corpusPaths: string[]
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function isStrictPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left)
}

async function assertNoSymlinkOutputPath(target: string): Promise<string> {
  const resolved = path.resolve(target)
  const parsed = path.parse(resolved)
  let current = parsed.root
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) break
    if (info.isSymbolicLink()) throw new Error('Output path must not contain symbolic links.')
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error('Output parent must be a regular directory.')
    }
  }
  return resolved
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
      if (!info.isDirectory()) throw new Error('Output parent must be a regular directory.')
      return path.join(await fs.realpath(current), ...suffix)
    }
    const parent = path.dirname(current)
    if (parent === current) throw new Error('Output path has no existing directory ancestor.')
    suffix.unshift(path.basename(current))
    current = parent
  }
}

async function resolvePhysicalOutputPath(target: string): Promise<string> {
  await assertNoSymlinkOutputPath(target)
  return resolvePhysicalPath(target)
}

async function assertAbsentSafeOutputDirectory(options: {
  target: string
  cwd: string
  workspaceRoot: string
  pluginRoots: string[]
}): Promise<string> {
  const target = await resolvePhysicalOutputPath(options.target)
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('EvalSpec output already exists; refusing to replace foreign or existing content.')
  const [workspaceRoot, cwd, home, ...pluginRoots] = await Promise.all([
    fs.realpath(options.workspaceRoot),
    fs.realpath(options.cwd),
    resolvePhysicalPath(os.homedir()),
    ...options.pluginRoots.map((root) => fs.realpath(root)),
  ])
  const workspaceEvalRoot = path.join(workspaceRoot, '.aw', 'evals')
  const allowedWorkspaceOutput = isStrictPathInside(workspaceEvalRoot, target)
  const blocked = [
    path.parse(target).root,
    cwd,
    workspaceRoot,
    ...pluginRoots,
    home,
  ]
  if (
    blocked.some((entry) => isPathInsideOrEqual(target, entry))
    || (!allowedWorkspaceOutput && isPathInsideOrEqual(workspaceRoot, target))
    || pluginRoots.some((root) => isPathInsideOrEqual(root, target))
  ) {
    throw new Error('EvalSpec output target is too broad or overlaps source content.')
  }
  await fs.ensureDir(path.dirname(target))
  const rechecked = await resolvePhysicalOutputPath(target)
  if (rechecked !== target) throw new Error('EvalSpec output path changed while it was being prepared.')
  return rechecked
}

async function resolveSelection(options: SkillEvalSelection): Promise<ResolvedSelection> {
  const workspace = await readCatalogWorkspace(options.workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS })
  const plugin = workspace.plugins.find((entry) => entry.manifest.name === options.pluginName)
  if (!plugin) throw new Error(`Plugin "${options.pluginName}" is not a canonical plugin in this Catalog Workspace.`)
  const loaded = await readAwSkillEvalManifest({ plugin, skill: options.skillName })
  const suite = options.suiteId
    ? loaded.manifest.suites.find((entry) => entry.id === options.suiteId)
    : loaded.manifest.suites.length === 1
      ? loaded.manifest.suites[0]
      : undefined
  if (!suite) {
    throw new Error(options.suiteId
      ? `Eval suite "${options.suiteId}" does not exist.`
      : 'Eval manifest has multiple suites; --suite is required.')
  }
  const profileId = options.profileId ?? loaded.manifest.defaults.profile ?? (
    loaded.manifest.profiles.length === 1 ? loaded.manifest.profiles[0]!.id : undefined
  )
  if (!profileId) throw new Error('Eval profile is ambiguous; use --profile or defaults.profile.')
  const profile = loaded.manifest.profiles.find((entry) => entry.id === profileId)
  if (!profile) throw new Error(`Eval profile "${profileId}" does not exist.`)
  if (suite.profiles && !suite.profiles.includes(profile.id)) {
    throw new Error(`Eval suite "${suite.id}" does not support profile "${profile.id}".`)
  }
  assertNoSensitiveProfileConfig(profile, workspace.plugins)
  return {
    workspaceRoot: workspace.workspaceRoot,
    plugin,
    plugins: workspace.plugins,
    evalRoot: loaded.evalRoot,
    suite,
    profile,
    cases: loaded.casesBySuite.get(suite.id)!,
    defaults: loaded.manifest.defaults,
    corpusPaths: loaded.manifest.suites.map((entry) => entry.cases),
  }
}

function materializationProfile(selection: ResolvedSelection): AwSkillEvalMaterializationProfile {
  const explicitConfig = new Map(selection.profile.plugins.map((entry) => [entry.name, entry.config]))
  const closure = resolvePluginMetaDependencyClosure(
    selection.plugins,
    selection.profile.plugins.map((entry) => entry.name),
  )
  const plugins = closure.map((plugin) => ({
    name: plugin.manifest.name,
    config: explicitConfig.get(plugin.manifest.name) ?? {},
  }))
  for (const plugin of closure) {
    const config = explicitConfig.get(plugin.manifest.name) ?? {}
    for (const [key, field] of Object.entries(plugin.manifest.config?.schema ?? {})) {
      if (field.required === true && field.default === undefined && !Object.hasOwn(config, key)) {
        throw new Error(
          `Eval profile "${selection.profile.id}" is missing required config "${key}" `
          + `for plugin "${plugin.manifest.name}".`,
        )
      }
    }
  }
  return { id: selection.profile.id, scope: selection.profile.scope, plugins }
}

function selectedCases(
  document: SelectedCasesDocument,
  split?: string,
  caseId?: string,
): SelectedCasesDocument {
  if (split !== undefined && split !== 'all' && !safeSegmentPattern.test(split)) {
    throw new Error('Eval split must be a safe path segment or all.')
  }
  if (caseId !== undefined && !safeSegmentPattern.test(caseId)) {
    throw new Error('Eval case id must be a safe path segment.')
  }
  const splitCases = split === undefined || split === 'all'
    ? document.cases
    : document.cases.filter((entry) => entry.split === split)
  const cases = caseId === undefined
    ? splitCases
    : splitCases.filter((entry) => entry.id === caseId)
  if (cases.length === 0) throw new Error('Eval case selection matched no cases.')
  return { ...document, cases }
}

async function copyEvalWorkspace(
  selection: ResolvedSelection,
  destination: string,
): Promise<void> {
  const excluded = new Set([
    'manifest.json',
    ...selection.corpusPaths,
  ])
  await fs.copy(selection.evalRoot, destination, {
    dereference: false,
    overwrite: false,
    errorOnExist: true,
    filter: (source) => {
      const relative = path.relative(selection.evalRoot, source).split(path.sep).join('/')
      return relative === '' || !excluded.has(relative)
    },
  })
  await fs.ensureDir(destination)
  await computeCanonicalDirectoryDigest(destination)
}

async function resolveProvider(
  selection: ResolvedSelection,
  preparedEvalRoot: string,
): Promise<EvalProvider> {
  if (selection.suite.kind === 'trigger') return 'codex-trigger'
  if (selection.suite.kind === 'conversation') return 'codex-conversation'
  const resolved = await resolveAwSkillEvalCustomCommand(selection.evalRoot, selection.suite.provider!)
  const command = [...resolved.command]
  for (const [index, { prefix, relative }] of resolved.localArguments) {
    if (!await fs.pathExists(path.join(preparedEvalRoot, relative))) {
      throw new Error(`Prepared custom provider asset is missing: ${relative}`)
    }
    command[index] = `${prefix}workspace/eval/${relative}`
  }
  return selection.suite.provider!.type === 'custom-process'
    ? { type: 'custom-process', command }
    : {
        type: 'codex-workflow',
        command,
        allowedModels: selection.suite.provider!.allowedModels,
      }
}

export async function prepareSkillEval(options: PrepareSkillEvalOptions): Promise<PrepareSkillEvalReceipt> {
  if (options.runs !== undefined && (!Number.isSafeInteger(options.runs) || options.runs < 1)) {
    throw new Error('--runs must be a positive safe integer.')
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error('--timeout-ms must be a positive safe integer.')
  }
  if (options.baseline !== undefined && options.baseline !== 'without-skill') {
    throw new Error('--baseline only accepts without-skill.')
  }
  if (options.baseline && options.previousVersion) {
    throw new Error('--baseline and --previous-version are mutually exclusive.')
  }
  const selection = await resolveSelection(options)
  const outputBoundary = {
    target: path.resolve(options.cwd, options.output),
    cwd: options.cwd,
    workspaceRoot: selection.workspaceRoot,
    pluginRoots: selection.plugins.map((plugin) => plugin.rootDir),
  }
  const finalOutput = await assertAbsentSafeOutputDirectory(outputBoundary)
  const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-eval-prepare-v1-'))
  const staging = await fs.mkdtemp(path.join(path.dirname(finalOutput), `.${path.basename(finalOutput)}.aw-eval-stage-`))
  let committed = false
  let keepOperationRoot = false
  try {
    const selected = selectedCases(selection.cases, options.split, options.caseId)
    const selectedCasesPath = path.join(staging, 'cases.json')
    await fs.writeFile(selectedCasesPath, prettyJson(selected), { flag: 'wx' })
    const targetSourceRoot = path.join(operationRoot, 'materialized')
    const workRoot = path.join(operationRoot, 'work')
    await Promise.all([fs.ensureDir(targetSourceRoot), fs.ensureDir(workRoot)])
    const requiredSkills = new Set([
      selection.cases.suite.unitUnderTest,
      ...(selection.cases.suite.participants ?? []),
    ])
    const materialized = await materializeAwSkillEvalSubject({
      plugin: selection.plugin,
      plugins: selection.plugins,
      profile: materializationProfile(selection),
      requiredSkills,
      initializeGitRepository: selection.suite.kind === 'conversation',
      outputRoot: targetSourceRoot,
      workRoot,
      env: options.env,
    })
    const subjectSource = resolveMaterializedSubjectRoot(targetSourceRoot, materialized)
    const runtimeTarget = path.join(subjectSource, '.agents', 'skills', options.skillName)
    await validateSkillDirectory(runtimeTarget, 'codex.skill', {
      ownerMarkerPolicy: 'ignore',
      requirementsReceiptPolicy: 'allow',
    })
    const targetRoot = path.join(staging, 'targets', 'current')
    const target = await createRuntimeSkillSnapshot(runtimeTarget, targetRoot)
    const subjectRoot = path.join(staging, 'workspace', 'subject')
    await fs.copy(subjectSource, subjectRoot, { dereference: false, errorOnExist: true })
    await fs.remove(path.join(subjectRoot, '.agents', 'skills', options.skillName))
    await computeCanonicalDirectoryDigest(subjectRoot)
    await copyEvalWorkspace(selection, path.join(staging, 'workspace', 'eval'))
    const workspaceDigest = await computeCanonicalDirectoryDigest(path.join(staging, 'workspace'))
    let baseline: EvalSpec['baseline'] = options.baseline
      ? { type: 'without-skill' }
      : { type: 'none' }
    if (options.previousVersion) {
      const source = path.resolve(options.cwd, options.previousVersion)
      const info = await fs.lstat(source).catch(() => null)
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Previous version must be a regular non-symbolic-link runtime Skill directory.')
      }
      const actualSource = await fs.realpath(source)
      if (pathsOverlap(actualSource, finalOutput)) throw new Error('Previous version must not overlap prepared output.')
      await validateSkillDirectory(actualSource, 'codex.skill', {
        ownerMarkerPolicy: 'ignore',
        requirementsReceiptPolicy: 'allow',
      })
      const previous = await createRuntimeSkillSnapshot(actualSource, path.join(staging, 'targets', 'previous'))
      baseline = {
        type: 'previous-version',
        target: { path: 'targets/previous', digest: previous.digest },
      }
    }
    const runs = options.runs ?? selection.suite.runs ?? selection.defaults.runs ?? 1
    const timeoutMs = options.timeoutMs ?? selection.suite.timeoutMs ?? selection.defaults.timeoutMs ?? 120_000
    const provider = await resolveProvider(selection, path.join(staging, 'workspace', 'eval'))
    assertEvalProviderSuiteKind(provider, selected.suite.kind)
    const spec: EvalSpec = {
      version: 1,
      source: {
        plugin: selection.plugin.manifest.name,
        skill: options.skillName,
        suite: selection.suite.id,
        profile: selection.profile.id,
      },
      workspace: { path: 'workspace', digest: workspaceDigest },
      target: { path: 'targets/current', digest: target.digest },
      cases: { path: 'cases.json', digest: await computeEvalFileDigest(selectedCasesPath) },
      provider,
      runs,
      timeoutMs,
      baseline,
      outputDir: 'output',
    }
    const specPath = path.join(staging, 'spec.json')
    await fs.writeFile(specPath, prettyJson(spec), { flag: 'wx' })
    const [specValidation, caseValidation] = await Promise.all([
      validateEvalSpecFile(specPath),
      validateSelectedCasesFile(selectedCasesPath),
    ])
    if (!specValidation.valid || !specValidation.calculated) {
      throw new Error(`Prepared EvalSpec is invalid: ${specValidation.errors.join('; ')}`)
    }
    if (!caseValidation.valid) {
      throw new Error(`Prepared selected cases are invalid: ${caseValidation.errors.join('; ')}`)
    }
    const recheckedOutput = await assertAbsentSafeOutputDirectory(outputBoundary)
    if (recheckedOutput !== finalOutput) {
      throw new Error('EvalSpec output path changed before commit.')
    }
    await fs.rename(staging, finalOutput)
    committed = true
    keepOperationRoot = options.keepWorkspace === true
    if (!keepOperationRoot) await fs.remove(operationRoot)
    return {
      schemaVersion: 1,
      command: 'skill:eval:prepare',
      ok: true,
      suite: selection.suite.id,
      profile: selection.profile.id,
      specPath: path.join(finalOutput, 'spec.json'),
      targetDigest: target.digest,
      corpusDigest: spec.cases.digest,
      ...(keepOperationRoot ? { workspacePath: operationRoot } : {}),
    }
  } finally {
    if (!committed) await Promise.allSettled([fs.remove(operationRoot), fs.remove(staging)])
  }
}
