import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  computeCanonicalDirectoryDigest,
  computeCaseCorpusDigest,
  computeSkillDigest,
  createRuntimeSkillSnapshot,
  validateExecutionPlan,
  type AwSkillEvalExecutionPlan,
  type EvalCase,
  type RuntimeCapabilities,
} from '@lesliechan721/agent-skill-eval'
import { readCatalogWorkspace } from '@lesliechan721/aw-plugin-core'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
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
  type AwSkillEvalCheckSuite,
  type AwSkillEvalManifest,
  type AwSkillEvalProfile,
  type AwSkillEvalSuite,
} from '../eval/manifest.js'
import {
  validateAwSkillEvalCheckResult,
  type AwSkillEvalCheckResult,
} from '../eval/check-result.js'
import {
  builtInEvalProviderCapabilities,
  CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST,
  CUSTOM_EVAL_PROVIDER_VERSION,
  encodeCustomProviderCapabilities,
} from '../eval/provider.js'
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
  suiteId: string
  profileId: string
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
}

export interface PrepareSkillEvalReceipt {
  schemaVersion: 1
  command: 'skill:eval:prepare'
  ok: true
  plans: Array<{
    suite: string
    profile: string
    planPath: string
    targetDigest: string
    corpusDigest: string
  }>
}

export interface CheckSkillEvalOptions extends SkillEvalSelection {
  output: string
  cwd: string
  env?: NodeJS.ProcessEnv
}

interface ResolvedSelection {
  workspaceRoot: string
  plugin: PluginMeta
  plugins: PluginMeta[]
  manifest: AwSkillEvalManifest
  evalRoot: string
  cases: EvalCase[]
  suite: AwSkillEvalSuite
  profile: AwSkillEvalProfile
}

interface MaterializedInputs {
  targetRoot: string
  targetDigest: string
  subjectBaseRoot: string
  subjectBaseDigest: string
}

interface MaterializedSuiteInput {
  root: string
  digest: string
}

function sha256(content: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
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

async function assertAbsentSafeOutputDirectory(options: {
  target: string
  cwd: string
  workspaceRoot: string
  pluginRoots: string[]
}): Promise<string> {
  const target = await assertNoSymlinkOutputPath(options.target)
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('Eval Plan output already exists; refusing to replace foreign or existing content.')
  const blocked = [
    path.parse(target).root,
    path.resolve(options.cwd),
    path.resolve(options.workspaceRoot),
    ...options.pluginRoots.map((root) => path.resolve(root)),
    path.resolve(os.homedir()),
  ]
  if (
    blocked.some((entry) => isPathInsideOrEqual(target, entry))
    || options.pluginRoots.some((root) => isPathInsideOrEqual(path.resolve(root), target))
  ) {
    throw new Error('Eval Plan output target is too broad or overlaps source content.')
  }
  await fs.ensureDir(path.dirname(target))
  await assertNoSymlinkOutputPath(target)
  return target
}

async function assertAbsentSafeOutputFile(options: {
  target: string
  cwd: string
  workspaceRoot: string
  pluginRoots: string[]
}): Promise<string> {
  const target = await assertNoSymlinkOutputPath(options.target)
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('Eval check output already exists; refusing to replace foreign or existing content.')
  const blocked = [
    path.parse(target).root,
    path.resolve(options.workspaceRoot),
    ...options.pluginRoots.map((root) => path.resolve(root)),
  ]
  if (blocked.includes(target)) throw new Error('Eval check output target is too broad.')
  if (options.pluginRoots.some((root) => isPathInsideOrEqual(path.resolve(root), target))) {
    throw new Error('Eval check output must not modify plugin source.')
  }
  await fs.ensureDir(path.dirname(target))
  await assertNoSymlinkOutputPath(target)
  return target
}

async function resolveSelection(options: SkillEvalSelection): Promise<ResolvedSelection> {
  const workspace = await readCatalogWorkspace(options.workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS })
  const plugin = workspace.plugins.find((entry) => entry.manifest.name === options.pluginName)
  if (!plugin) throw new Error(`Plugin "${options.pluginName}" is not a canonical plugin in this Catalog Workspace.`)
  const loaded = await readAwSkillEvalManifest({ plugin, skill: options.skillName })
  const suite = loaded.manifest.suites.find((entry) => entry.id === options.suiteId)
  if (!suite) throw new Error(`Eval suite "${options.suiteId}" does not exist.`)
  const profile = loaded.manifest.profiles.find((entry) => entry.id === options.profileId)
  if (!profile) throw new Error(`Eval profile "${options.profileId}" does not exist.`)
  if (!suite.profiles.includes(profile.id)) {
    throw new Error(`Eval suite "${suite.id}" does not support profile "${profile.id}".`)
  }
  assertNoSensitiveProfileConfig(profile, workspace.plugins)
  return {
    workspaceRoot: workspace.workspaceRoot,
    plugin,
    plugins: workspace.plugins,
    manifest: loaded.manifest,
    evalRoot: loaded.evalRoot,
    cases: loaded.casesBySuite.get(suite.id) ?? [],
    suite,
    profile,
  }
}

function materializationProfile(selection: ResolvedSelection): AwSkillEvalMaterializationProfile {
  const explicitConfig = new Map(selection.profile.plugins.map((plugin) => [plugin.name, plugin.config]))
  const closure = resolvePluginMetaDependencyClosure(
    selection.plugins,
    selection.profile.plugins.map((plugin) => plugin.name),
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
  return { ...selection.profile, plugins }
}

async function materializeInputs(options: {
  selection: ResolvedSelection
  operationRoot: string
  destinationRoot: string
  env?: NodeJS.ProcessEnv
}): Promise<MaterializedInputs> {
  const materializedRoot = path.join(options.operationRoot, 'materialized')
  const workRoot = path.join(options.operationRoot, 'work')
  await fs.ensureDir(materializedRoot)
  await fs.ensureDir(workRoot)
  const subject = await materializeAwSkillEvalSubject({
    plugin: options.selection.plugin,
    plugins: options.selection.plugins,
    profile: materializationProfile(options.selection),
    requiredSkills: new Set(options.selection.suite.skills),
    initializeGitRepository: options.selection.suite.kind === 'conversation',
    outputRoot: materializedRoot,
    workRoot,
    env: options.env,
  })
  const subjectRoot = resolveMaterializedSubjectRoot(materializedRoot, subject)
  const runtimeTarget = path.join(subjectRoot, '.agents', 'skills', options.selection.manifest.skill)
  await validateSkillDirectory(runtimeTarget, 'codex.skill', {
    ownerMarkerPolicy: 'ignore',
    requirementsReceiptPolicy: 'allow',
  })
  const targetRoot = path.join(options.destinationRoot, 'targets', 'current')
  const subjectBaseRoot = path.join(options.destinationRoot, 'runtime', 'aw-subject-base')
  await createRuntimeSkillSnapshot(runtimeTarget, targetRoot)
  await fs.copy(subjectRoot, subjectBaseRoot, { dereference: false, errorOnExist: true })
  await fs.remove(path.join(subjectBaseRoot, '.agents', 'skills', options.selection.manifest.skill))
  for (const participant of options.selection.suite.skills) {
    if (participant === options.selection.manifest.skill) continue
    const participantRoot = path.join(subjectBaseRoot, '.agents', 'skills', participant)
    const info = await fs.lstat(participantRoot).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Materialized subject lost participant Skill "${participant}".`)
    }
  }
  return {
    targetRoot,
    targetDigest: await computeSkillDigest(targetRoot),
    subjectBaseRoot,
    subjectBaseDigest: await computeCanonicalDirectoryDigest(subjectBaseRoot),
  }
}

async function materializeSuiteInput(options: {
  selection: ResolvedSelection
  destinationRoot: string
  selectedCases: EvalCase[]
}): Promise<MaterializedSuiteInput> {
  if (options.selection.suite.kind === 'check') throw new Error('Check suites do not have provider suite inputs.')
  const root = path.join(options.destinationRoot, 'runtime', 'eval-suite')
  const evalAssetsRoot = path.join(root, 'eval-root')
  await fs.ensureDir(evalAssetsRoot)
  const assets: string[] = []
  if (options.selection.suite.kind === 'trigger' && options.selection.suite.fixtureModule) {
    assets.push(options.selection.suite.fixtureModule)
  }
  if (options.selection.suite.kind === 'conversation') {
    assets.push(...(options.selection.suite.environment?.pathPrepend ?? []))
    for (const [index, evalCase] of options.selectedCases.entries()) {
      const environment = evalCase.environment
      if (!environment || typeof environment !== 'object' || Array.isArray(environment)) continue
      const pathPrepend = (environment as { pathPrepend?: unknown }).pathPrepend
      if (!Array.isArray(pathPrepend) || pathPrepend.some((entry) => typeof entry !== 'string')) {
        throw new Error(`Selected conversation case ${index + 1} has invalid environment.pathPrepend.`)
      }
      assets.push(...pathPrepend as string[])
    }
  }
  if (options.selection.suite.kind === 'provider') {
    assets.push(
      options.selection.suite.provider.entry,
      ...options.selection.suite.provider.assets,
    )
  }
  const normalizedAssets = [...new Set(assets.map((relative) => {
    const normalized = relative.replace(/^\.\//u, '')
    if (
      normalized === ''
      || normalized.includes('\0')
      || normalized.includes('\\')
      || path.posix.isAbsolute(normalized)
      || path.win32.isAbsolute(normalized)
      || path.posix.normalize(normalized) !== normalized
      || normalized.split('/').includes('..')
    ) throw new Error(`Eval runtime asset must stay inside the Eval root: ${relative}`)
    return normalized
  }))].filter((relative, _index, all) =>
    !all.some((other) => relative !== other && relative.startsWith(`${other}/`)))
  for (const relative of normalizedAssets) {
    await fs.copy(
      path.join(options.selection.evalRoot, ...relative.split('/')),
      path.join(evalAssetsRoot, ...relative.split('/')),
      { dereference: false, errorOnExist: true },
    )
  }
  const suite = {
    ...options.selection.suite,
    skill: options.selection.manifest.skill,
    cases: 'AGENT_EVAL_CASE_PATH',
    ...(options.selection.suite.kind === 'trigger' && options.selection.suite.fixtureModule
      ? { fixtureModule: `eval-root/${options.selection.suite.fixtureModule}` }
      : {}),
    ...(options.selection.suite.kind === 'conversation' && options.selection.suite.environment
      ? {
          environment: {
            pathPrepend: options.selection.suite.environment.pathPrepend
              .map((entry) => `eval-root/${entry}`),
          },
        }
      : {}),
    ...(options.selection.suite.kind === 'provider'
      ? {
          provider: {
            ...options.selection.suite.provider,
            entry: `eval-root/${options.selection.suite.provider.entry}`,
            assets: options.selection.suite.provider.assets.map((entry) => `eval-root/${entry}`),
          },
        }
      : {}),
  }
  await fs.writeFile(path.join(root, 'suite.json'), prettyJson(suite), { flag: 'wx' })
  return { root, digest: await computeCanonicalDirectoryDigest(root) }
}

function casesFrom(value: unknown): EvalCase[] {
  if (Array.isArray(value)) return value as EvalCase[]
  if (value && typeof value === 'object') {
    const row = value as { cases?: unknown; evals?: unknown }
    if (Array.isArray(row.cases)) return row.cases as EvalCase[]
    if (Array.isArray(row.evals)) return row.evals as EvalCase[]
  }
  throw new Error('Case document must be an array or contain cases/evals.')
}

function selectCases(value: unknown, split?: string, caseId?: string): EvalCase[] {
  if (split !== undefined && split !== 'all' && !safeSegmentPattern.test(split)) {
    throw new Error('Eval split must be a safe path segment or all.')
  }
  if (caseId !== undefined && !safeSegmentPattern.test(caseId)) {
    throw new Error('Eval case id must be a safe path segment.')
  }
  const cases = casesFrom(value)
  const seen = new Set<string>()
  for (const entry of cases) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!safeSegmentPattern.test(id)) throw new Error('Eval case ids must be safe path segments.')
    if (seen.has(id)) throw new Error(`Eval case document contains duplicate id "${id}".`)
    seen.add(id)
  }
  const splitCases = split === undefined || split === 'all'
    ? cases
    : cases.filter((entry) => entry.split === split)
  const selected = caseId === undefined
    ? splitCases
    : splitCases.filter((entry) => entry.id === caseId)
  if (selected.length === 0) throw new Error('Eval case selection matched no cases.')
  return selected
}

function builtInProvider(kind: 'trigger' | 'conversation'): {
  id: string
  command: string[]
  describeCommand: string[]
  runtimeCapabilities: RuntimeCapabilities
  environmentAllowlist: string[]
} {
  const name = kind === 'trigger' ? 'codex-trigger' : 'codex-conversation'
  const base = ['aw', 'skill', 'eval', 'provider', name]
  return {
    id: name,
    command: base,
    describeCommand: [...base, '--describe'],
    runtimeCapabilities: builtInEvalProviderCapabilities(name),
    environmentAllowlist: [...CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST],
  }
}

function suiteProvider(suite: Exclude<AwSkillEvalSuite, AwSkillEvalCheckSuite>): {
  id: string
  command: string[]
  describeCommand: string[]
  runtimeCapabilities: RuntimeCapabilities
  environmentAllowlist: string[]
} {
  if (suite.kind === 'provider') {
    const runtimeCapabilities: RuntimeCapabilities = {
      schemaVersion: 2,
      provider: suite.provider.id,
      providerVersion: CUSTOM_EVAL_PROVIDER_VERSION,
      capabilities: suite.provider.capabilities,
      limitations: [],
    }
    const base = ['aw', 'skill', 'eval', 'provider', 'custom']
    return {
      id: suite.provider.id,
      command: base,
      describeCommand: [
        ...base,
        '--describe',
        '--capabilities',
        encodeCustomProviderCapabilities(runtimeCapabilities),
      ],
      runtimeCapabilities,
      environmentAllowlist: suite.provider.credentialEnvironment,
    }
  }
  return builtInProvider(suite.kind)
}

async function copyPreviousVersion(options: {
  previousVersion: string
  finalOutput: string
  staging: string
}): Promise<{ id: string; root: string; digest: string }> {
  const requested = path.resolve(options.previousVersion)
  const info = await fs.lstat(requested).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Previous version must be a regular non-symbolic-link runtime Skill directory.')
  }
  const actual = await fs.realpath(requested)
  if (pathsOverlap(actual, options.finalOutput) || pathsOverlap(actual, path.join(options.staging, 'output'))) {
    throw new Error('Previous version must be outside the Plan and output directories.')
  }
  await validateSkillDirectory(actual, 'codex.skill', {
    ownerMarkerPolicy: 'ignore',
    requirementsReceiptPolicy: 'allow',
  })
  const id = 'previous-version'
  const root = path.join(options.staging, 'targets', 'previous', id)
  const snapshot = await createRuntimeSkillSnapshot(actual, root)
  return { id, root, digest: snapshot.digest }
}

async function writeExclusiveValidatedResult(target: string, result: AwSkillEvalCheckResult): Promise<void> {
  const errors = validateAwSkillEvalCheckResult(result)
  if (errors.length > 0) throw new Error(`AwSkillEvalCheckResult is invalid: ${errors.join('; ')}`)
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.aw-eval-${randomBytes(8).toString('hex')}.tmp`,
  )
  let linked = false
  try {
    await fs.writeFile(temporary, prettyJson(result), { flag: 'wx' })
    if (await fs.pathExists(target)) throw new Error('Eval check output appeared before commit.')
    await fs.link(temporary, target)
    linked = true
  } finally {
    if (linked) await fs.remove(temporary).catch(() => undefined)
    else await fs.remove(temporary)
  }
}

export async function prepareSkillEval(options: PrepareSkillEvalOptions): Promise<PrepareSkillEvalReceipt> {
  if (options.runs !== undefined && (!Number.isInteger(options.runs) || options.runs <= 0)) {
    throw new Error('--runs must be a positive integer.')
  }
  if (options.baseline !== undefined && options.baseline !== 'without-skill') {
    throw new Error('--baseline only accepts without-skill.')
  }
  const selection = await resolveSelection(options)
  if (selection.suite.kind === 'check') throw new Error('Check suites must use aw skill eval check.')
  const finalOutput = await assertAbsentSafeOutputDirectory({
    target: path.resolve(options.cwd, options.output),
    cwd: options.cwd,
    workspaceRoot: selection.workspaceRoot,
    pluginRoots: selection.plugins.map((plugin) => plugin.rootDir),
  })
  const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-eval-prepare-'))
  const staging = await fs.mkdtemp(path.join(path.dirname(finalOutput), `.${path.basename(finalOutput)}.aw-eval-stage-`))
  let committed = false
  let operationCleaned = false
  try {
    const selectedCases = selectCases(selection.cases, options.split, options.caseId)
    await fs.ensureDir(path.join(staging, 'cases'))
    const selectedCasesPath = path.join(staging, 'cases', 'selected-cases.json')
    await fs.writeFile(selectedCasesPath, prettyJson(selectedCases), { flag: 'wx' })
    const corpusDigest = await computeCaseCorpusDigest([selectedCasesPath])
    const inputs = await materializeInputs({
      selection,
      operationRoot,
      destinationRoot: staging,
      env: options.env,
    })
    const suiteInput = await materializeSuiteInput({
      selection,
      destinationRoot: staging,
      selectedCases,
    })
    const provider = suiteProvider(selection.suite)
    const capabilities = provider.runtimeCapabilities
    await fs.ensureDir(path.join(staging, 'provider', 'work'))
    const capabilitiesPath = path.join(staging, 'provider', 'capabilities.json')
    await fs.writeFile(capabilitiesPath, prettyJson(capabilities), { flag: 'wx' })
    const capabilitiesDigest = sha256(await fs.readFile(capabilitiesPath))

    const comparison = options.baseline || options.previousVersion ? 'comparison' : null
    const configurations: AwSkillEvalExecutionPlan['configurations'] = [{
      id: 'with-skill',
      skillMode: 'with-skill',
      comparisonId: comparison,
    }]
    if (options.baseline) configurations.push({
      id: 'without-skill',
      skillMode: 'without-skill',
      comparisonId: comparison,
    })
    if (options.previousVersion) {
      const previous = await copyPreviousVersion({
        previousVersion: path.resolve(options.cwd, options.previousVersion),
        finalOutput,
        staging,
      })
      configurations.push({
        id: previous.id,
        skillMode: 'previous-version',
        comparisonId: comparison,
        skillPath: `targets/previous/${previous.id}`,
        skillDigest: previous.digest as `sha256:${string}`,
      })
    }
    const plan: AwSkillEvalExecutionPlan = {
      schemaVersion: 4,
      planId: `${selection.manifest.plugin}-${selection.manifest.skill}-${selection.suite.id}-${selection.profile.id}`,
      target: {
        name: selection.manifest.skill,
        path: 'targets/current',
        digest: inputs.targetDigest as `sha256:${string}`,
      },
      cases: {
        paths: ['cases/selected-cases.json'],
        corpusDigest,
      },
      provider: {
        id: provider.id,
        command: provider.command,
        describeCommand: provider.describeCommand,
        cwd: 'provider/work',
        capabilitiesPath: 'provider/capabilities.json',
        capabilitiesDigest,
        inheritEnvironment: false,
        environmentAllowlist: provider.environmentAllowlist,
      },
      runtimeInputs: [{
        id: 'aw-subject-base',
        kind: 'directory',
        path: 'runtime/aw-subject-base',
        digest: inputs.subjectBaseDigest as `sha256:${string}`,
      }, {
        id: 'eval-suite',
        kind: 'directory',
        path: 'runtime/eval-suite',
        digest: suiteInput.digest as `sha256:${string}`,
      }],
      configurations,
      runsPerCase: options.runs ?? selection.suite.defaultRuns,
      timeoutMs: selection.suite.perRunTimeoutMs,
      outputRoot: 'output',
      capture: {
        outputs: true,
        trace: capabilities.capabilities.toolTrace,
        timing: true,
        usage: capabilities.capabilities.tokenUsage,
      },
    }
    const planPath = path.join(staging, 'plan.json')
    await fs.writeFile(planPath, prettyJson(plan), { flag: 'wx' })
    const preparation = {
      schemaVersion: 1,
      command: 'skill:eval:prepare',
      plugin: selection.manifest.plugin,
      skill: selection.manifest.skill,
      suite: selection.suite.id,
      profile: selection.profile.id,
      planPath: 'plan.json',
      targetDigest: inputs.targetDigest,
      corpusDigest,
      runtimeInputs: [
        { id: 'aw-subject-base', digest: inputs.subjectBaseDigest },
        { id: 'eval-suite', digest: suiteInput.digest },
      ],
    }
    await fs.writeFile(path.join(staging, 'preparation.json'), prettyJson(preparation), { flag: 'wx' })
    const validation = await validateExecutionPlan(planPath)
    if (!validation.valid) throw new Error(`Prepared Eval Plan is invalid: ${validation.errors.join('; ')}`)
    if (!validation.calculated) throw new Error('Prepared Eval Plan did not return calculated digests.')
    if (validation.calculated.targetSkillDigest !== inputs.targetDigest) throw new Error('Prepared target digest changed during validation.')
    if (validation.calculated.caseCorpusDigest !== corpusDigest) throw new Error('Prepared case digest changed during validation.')
    await fs.remove(operationRoot)
    operationCleaned = true
    if (await fs.pathExists(finalOutput)) throw new Error('Eval Plan output appeared before commit.')
    await fs.rename(staging, finalOutput)
    committed = true
    return {
      schemaVersion: 1,
      command: 'skill:eval:prepare',
      ok: true,
      plans: [{
        suite: selection.suite.id,
        profile: selection.profile.id,
        planPath: path.join(finalOutput, 'plan.json'),
        targetDigest: inputs.targetDigest,
        corpusDigest,
      }],
    }
  } finally {
    if (!committed) {
      await Promise.allSettled([
        ...(operationCleaned ? [] : [fs.remove(operationRoot)]),
        fs.remove(staging),
      ])
    }
  }
}

export async function checkSkillEval(options: CheckSkillEvalOptions): Promise<AwSkillEvalCheckResult> {
  const selection = await resolveSelection(options)
  if (selection.suite.kind !== 'check') throw new Error('aw skill eval check only accepts check suites.')
  const suite = selection.suite as AwSkillEvalCheckSuite
  const finalOutput = await assertAbsentSafeOutputFile({
    target: path.resolve(options.cwd, options.output),
    cwd: options.cwd,
    workspaceRoot: selection.workspaceRoot,
    pluginRoots: selection.plugins.map((plugin) => plugin.rootDir),
  })
  const documentPath = path.join(selection.evalRoot, suite.document)
  const schemaPath = path.join(selection.evalRoot, suite.schema)
  const [documentBytes, schemaBytes] = await Promise.all([
    fs.readFile(documentPath),
    fs.readFile(schemaPath),
  ])
  const schema = JSON.parse(schemaBytes.toString('utf8')) as Record<string, unknown>
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  let validate: ValidateFunction<unknown>
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    throw new Error(`Eval json-schema checker could not compile schema: ${error instanceof Error ? error.message : String(error)}`)
  }
  const document = JSON.parse(documentBytes.toString('utf8')) as unknown
  const passed = validate(document)
  const errors = passed
    ? []
    : (validate.errors ?? []).map((error: ErrorObject) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
  const result: AwSkillEvalCheckResult = {
    schemaVersion: 1,
    checker: { id: 'json-schema', version: '1' },
    plugin: selection.manifest.plugin,
    skill: selection.manifest.skill,
    suite: suite.id,
    profile: selection.profile.id,
    document: { path: suite.document, digest: sha256(documentBytes) },
    schema: { path: suite.schema, digest: sha256(schemaBytes) },
    passed,
    errors,
  }
  await writeExclusiveValidatedResult(finalOutput, result)
  return result
}
