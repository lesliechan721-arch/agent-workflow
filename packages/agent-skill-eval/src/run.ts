import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isPathInside, sha256, stable, toPosixRelative } from './common.js'
import { comparisonAggregate, validateRunBundle } from './bundle.js'
import { casesFrom, promptOf, validateExecutionPlan } from './plan.js'
import type { EvalCase, EvalConfiguration, EvalExecutionPlan } from './plan.js'
import { ProviderProcessCleanupError, runProviderProcess } from './process.js'
import { assertSafeOutputPath } from './output-path.js'
import { computeSkillDigest, createRuntimeSkillSnapshot } from './runtime-skill.js'
import type {
  Digest,
  ProcessResult,
  RunExecutionPlanOptions,
  RunExecutionResult,
  RuntimeCapabilities,
} from './types.js'

interface SkillSource {
  root: string | null
  digest: Digest | null
}

interface ProviderArtifactOutput {
  path: string
  role?: string
}

interface ProviderOutput {
  usage?: Record<string, unknown> | null
  grading?: unknown
  artifacts?: ProviderArtifactOutput[]
}

interface BoundFileFingerprint {
  label: string
  requestedPath: string
  canonicalPath: string
  digest: Digest
  bytes: Buffer
}

const artifactRoles = new Set(['trace', 'report', 'output', 'grading', 'other'])

class RunnerOwnedOutputError extends Error {}

async function captureBoundFile(label: string, requestedPath: string): Promise<BoundFileFingerprint> {
  const info = await lstat(requestedPath)
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Bound Eval input must be a regular non-symlink file: ${label}`)
  const canonicalPath = await realpath(requestedPath)
  const bytes = await readFile(canonicalPath)
  return {
    label,
    requestedPath,
    canonicalPath,
    digest: sha256(bytes),
    bytes,
  }
}

async function assertBoundInputsUnchanged(
  files: BoundFileFingerprint[],
  skills: Map<string, SkillSource>,
): Promise<void> {
  for (const file of files) {
    try {
      const info = await lstat(file.requestedPath)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('file type changed')
      const actual = await realpath(file.requestedPath)
      if (actual !== file.canonicalPath || sha256(await readFile(actual)) !== file.digest)
        throw new Error('identity or bytes changed')
    } catch (error) {
      throw new Error(
        `Bound Eval input changed during execution: ${file.label}: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
  for (const [configurationId, source] of skills) {
    if (!source.root) continue
    try {
      if (await computeSkillDigest(source.root) !== source.digest) throw new Error('digest changed')
    } catch (error) {
      throw new Error(
        `Bound Eval input changed during execution: ${configurationId} Skill: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
}

async function prepareOutputRoot(base: string, outputRoot: string): Promise<void> {
  await assertSafeOutputPath(base, outputRoot)
  await mkdir(outputRoot, { recursive: true })
  await assertSafeOutputPath(base, outputRoot)
  const oldBundle = path.join(outputRoot, 'eval-run-bundle.json')
  try {
    const info = await lstat(oldBundle)
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error('existing EvalRunBundle output must be a regular file')
    const actual = await realpath(oldBundle)
    if (!isPathInside(outputRoot, actual)) throw new Error('existing EvalRunBundle leaves outputRoot')
    await rm(oldBundle)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function replacePlaceholders(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{(prompt|caseId|configuration|skillPath|outputDir)\}/gu, (_, key: string) => replacements[key])
}

function gradingOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const grader = record.grader
  if (!grader || typeof grader !== 'object' || Array.isArray(grader)) return null
  const identity = grader as Record<string, unknown>
  if (typeof identity.id !== 'string' || !identity.id || typeof identity.version !== 'string' || !identity.version) return null
  if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) return null
  return record
}

async function providerArtifacts(
  parsed: ProviderOutput,
  runDirectory: string,
  outputRoot: string,
): Promise<Array<{ role: 'trace' | 'report' | 'output' | 'grading' | 'other'; path: string; digest: Digest }>> {
  if (!Array.isArray(parsed.artifacts)) return []
  const artifacts = []
  for (const entry of parsed.artifacts) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string')
      throw new Error('provider artifact requires path')
    const role = typeof entry.role === 'string' ? entry.role : 'other'
    if (!artifactRoles.has(role)) throw new Error(`unsupported provider artifact role: ${role}`)
    const candidate = path.resolve(runDirectory, entry.path)
    if (!isPathInside(runDirectory, candidate)) throw new Error('provider artifact leaves the run directory')
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error('provider artifact cannot be a symlink')
    const actual = await realpath(candidate)
    if (!isPathInside(runDirectory, actual) || !(await stat(actual)).isFile())
      throw new Error('provider artifact is not a regular run file')
    artifacts.push({
      role: role as 'trace' | 'report' | 'output' | 'grading' | 'other',
      path: toPosixRelative(outputRoot, actual),
      digest: sha256(await readFile(actual)),
    })
  }
  return artifacts
}

async function createRunnerOwnedTemp(
  base: string,
  outputRoot: string,
  directory: string,
  label: string,
  bytes: Buffer,
): Promise<string> {
  await assertSafeOutputPath(base, outputRoot)
  await assertSafeOutputPath(base, directory)
  const [actualOutputRoot, actualDirectory] = await Promise.all([
    realpath(outputRoot),
    realpath(directory),
  ])
  if (!isPathInside(actualOutputRoot, actualDirectory)) throw new Error(`${label} directory leaves outputRoot`)
  const temporaryPath = path.join(directory, `.${label}.${randomUUID()}.tmp`)
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${label} temporary file is not an owned regular file`)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  await handle.close()
  const actualTemporaryPath = await realpath(temporaryPath)
  if (!isPathInside(actualDirectory, actualTemporaryPath)) {
    await unlink(temporaryPath).catch(() => undefined)
    throw new Error(`${label} temporary file leaves its runner-owned directory`)
  }
  return temporaryPath
}

async function commitRunnerOwnedFile(
  base: string,
  outputRoot: string,
  directory: string,
  temporaryPath: string,
  finalPath: string,
  label: string,
  expectedDigest: Digest,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  let renamed = false
  try {
    await assertSafeOutputPath(base, outputRoot)
    await assertSafeOutputPath(base, directory)
    const temporaryInfo = await lstat(temporaryPath)
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() || temporaryInfo.nlink !== 1)
      throw new Error(`${label} temporary file identity changed`)
    await beforeRename?.()
    try {
      await lstat(finalPath)
      throw new Error(`${label} path already exists`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(temporaryPath, finalPath)
    renamed = true
    const finalInfo = await lstat(finalPath)
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink() || finalInfo.nlink !== 1)
      throw new Error(`${label} is not an owned regular file after commit`)
    const [actualDirectory, actualFinalPath] = await Promise.all([realpath(directory), realpath(finalPath)])
    if (!isPathInside(actualDirectory, actualFinalPath)) throw new Error(`${label} leaves its runner-owned directory`)
    if (sha256(await readFile(actualFinalPath)) !== expectedDigest) throw new Error(`${label} bytes changed during commit`)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    if (renamed) await unlink(finalPath).catch(() => undefined)
    throw error
  }
}

async function writeRunnerOwnedEvidence(
  base: string,
  outputRoot: string,
  directory: string,
  finalPath: string,
  label: string,
  bytes: Buffer,
): Promise<Digest> {
  const digest = sha256(bytes)
  const temporaryPath = await createRunnerOwnedTemp(
    base,
    outputRoot,
    directory,
    label,
    bytes,
  )
  await commitRunnerOwnedFile(
    base,
    outputRoot,
    directory,
    temporaryPath,
    finalPath,
    label,
    digest,
  )
  return digest
}

async function runOne(input: {
  plan: EvalExecutionPlan
  base: string
  skillSource: SkillSource
  evalCase: EvalCase
  configuration: EvalConfiguration
  runIndex: number
  options: RunExecutionPlanOptions
  executionLimitations: string[]
}): Promise<import('./bundle.js').EvalRun> {
  const { plan, base, skillSource, evalCase, configuration, runIndex, options, executionLimitations } = input
  const caseId = String(evalCase.id)
  const outputRoot = path.resolve(base, plan.outputRoot)
  const runDirectory = path.resolve(outputRoot, caseId, configuration.id, String(runIndex))
  if (!isPathInside(outputRoot, runDirectory)) throw new Error('run directory leaves outputRoot')
  await assertSafeOutputPath(base, outputRoot)
  await assertSafeOutputPath(base, runDirectory)
  await rm(runDirectory, { recursive: true, force: true })
  await mkdir(runDirectory, { recursive: true })
  await assertSafeOutputPath(base, runDirectory)
  const skillRoot = skillSource.root
  const skillSnapshot = skillRoot ? path.join(runDirectory, 'skill') : null
  if (skillRoot && skillSnapshot) await createRuntimeSkillSnapshot(skillRoot, skillSnapshot)
  const casePath = path.join(runDirectory, 'case.json')
  await writeFile(casePath, `${JSON.stringify(evalCase, null, 2)}\n`, 'utf8')
  const replacements = {
    prompt: promptOf(evalCase),
    caseId,
    configuration: configuration.id,
    skillPath: skillSnapshot ?? '',
    outputDir: runDirectory,
  }
  const argv = plan.provider.command.map((value) => replacePlaceholders(value, replacements))
  const executable = argv.shift()
  if (!executable) throw new Error('provider command has no executable')
  const inheritedEnvironment = plan.provider.inheritEnvironment
    ? process.env
    : Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  const env = {
    ...inheritedEnvironment,
    ...plan.provider.env,
    ...configuration.env,
    AGENT_EVAL_CASE_ID: caseId,
    AGENT_EVAL_CONFIGURATION: configuration.id,
    AGENT_EVAL_SKILL_MODE: configuration.skillMode,
    AGENT_EVAL_OUTPUT_DIR: runDirectory,
    AGENT_EVAL_CASE_PATH: casePath,
    ...(skillSnapshot ? { AGENT_EVAL_SKILL_PATH: skillSnapshot } : {}),
  }
  const started = Date.now()
  let result: ProcessResult
  try {
    result = await (options.processRunner ?? runProviderProcess)({
      executable,
      args: argv,
      cwd: plan.provider.cwd ? path.resolve(base, plan.provider.cwd) : runDirectory,
      env,
      timeoutMs: plan.timeoutMs,
      maxBufferBytes: 20 * 1024 * 1024,
    }, options.processHooks)
  } catch (error) {
    if (error instanceof ProviderProcessCleanupError) throw error
    result = {
      stdout: '',
      stderr: (error as Error).message,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      terminationReason: null,
      maxBufferExceeded: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      descendantCleanupGuaranteed: true,
    }
  }
  let status: import('./bundle.js').EvalRun['status'] = result.timedOut
    ? 'timeout'
    : result.maxBufferExceeded
      ? 'process-failed'
      : result.exitCode === 0
        ? 'completed'
        : 'process-failed'
  let stderr = result.stderr
  if (result.maxBufferExceeded) {
    const streams = [
      ...(result.stdoutTruncated ? ['stdout'] : []),
      ...(result.stderrTruncated ? ['stderr'] : []),
    ].join(' and ') || 'provider output'
    const diagnostic = `Provider ${streams} exceeded the capture maxBuffer and was truncated.`
    stderr += `${stderr && !stderr.endsWith('\n') ? '\n' : ''}${diagnostic}\n`
    executionLimitations.push(`Run ${caseId}/${configuration.id}/${runIndex}: ${diagnostic}`)
  }
  let usage: Record<string, unknown> | null = null
  let grading: Record<string, unknown> | null = null
  let artifacts: Awaited<ReturnType<typeof providerArtifacts>> = []
  try {
    const parsed = JSON.parse(result.stdout.trim()) as ProviderOutput
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('provider stdout must be a JSON object')
    usage = parsed.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage) ? parsed.usage : null
    grading = gradingOf(parsed.grading)
    artifacts = await providerArtifacts(parsed, runDirectory, outputRoot)
    if (artifacts.some((entry) => entry.role === 'grading'))
      throw new Error('provider artifacts must not declare the runner-owned grading role')
    if (grading) {
      const gradingPath = path.join(runDirectory, 'grading.json')
      const gradingBytes = Buffer.from(`${JSON.stringify(grading, null, 2)}\n`)
      let gradingDigest: Digest
      try {
        gradingDigest = await writeRunnerOwnedEvidence(
          base,
          outputRoot,
          runDirectory,
          gradingPath,
          'grading artifact',
          gradingBytes,
        )
      } catch (error) {
        throw new RunnerOwnedOutputError(`Cannot commit runner-owned grading evidence: ${(error as Error).message}`)
      }
      artifacts.push({
        role: 'grading',
        path: toPosixRelative(outputRoot, gradingPath),
        digest: gradingDigest,
      })
    }
  } catch (error) {
    if (error instanceof RunnerOwnedOutputError) throw error
    usage = null
    grading = null
    artifacts = []
    if (status === 'completed') {
      status = 'error'
      stderr += `${stderr ? '\n' : ''}Provider JSON/artifact error: ${(error as Error).message}`
    }
  }
  const stdoutPath = path.join(runDirectory, 'stdout.txt')
  const stderrPath = path.join(runDirectory, 'stderr.txt')
  let stdoutDigest: Digest
  let stderrDigest: Digest
  try {
    stdoutDigest = await writeRunnerOwnedEvidence(
      base,
      outputRoot,
      runDirectory,
      stdoutPath,
      'stdout evidence',
      Buffer.from(result.stdout),
    )
    stderrDigest = await writeRunnerOwnedEvidence(
      base,
      outputRoot,
      runDirectory,
      stderrPath,
      'stderr evidence',
      Buffer.from(stderr),
    )
  } catch (error) {
    throw new RunnerOwnedOutputError(`Cannot commit runner-owned process evidence: ${(error as Error).message}`)
  }
  return {
    caseId,
    configuration: configuration.id,
    comparisonId: configuration.comparisonId,
    skillMode: configuration.skillMode,
    skillDigest: skillSource.digest,
    runIndex,
    status,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    stdoutPath: toPosixRelative(outputRoot, stdoutPath),
    stdoutDigest,
    stderrPath: toPosixRelative(outputRoot, stderrPath),
    stderrDigest,
    usage,
    grading: grading as import('./bundle.js').EvalGrading | null,
    artifacts,
  }
}

export function getRuntimeCapabilities(platform: NodeJS.Platform = process.platform): RuntimeCapabilities {
  const require = createRequire(import.meta.url)
  const packageJson = require('../package.json') as { version: string }
  return {
    schemaVersion: 1,
    provider: 'aw-skill-eval-process',
    providerVersion: packageJson.version,
    capabilities: {
      triggerDiscovery: false,
      skillPathExecution: platform !== 'win32',
      previousVersionBaseline: platform !== 'win32',
      withoutSkillBaseline: platform !== 'win32',
      cleanContext: false,
      parallelRuns: false,
      toolTrace: false,
      tokenUsage: true,
      duration: true,
      sandbox: false,
      materialization: true,
    },
    limitations: [
      'The process provider does not prove a clean model context.',
      'The process provider does not supply a tool trace or sandbox.',
      ...(platform === 'win32'
        ? ['Standalone Windows execution is disabled because the shared monitor cannot independently verify Windows Job Object membership. JavaScript callers can supply a terminateProcessTree hook that returns confirmed descendant-cleanup evidence.']
        : []),
    ],
  }
}

export async function runExecutionPlan(
  planPath: string,
  options: RunExecutionPlanOptions = {},
): Promise<RunExecutionResult> {
  const planBinding = await captureBoundFile('execution plan', path.resolve(planPath))
  let plan: EvalExecutionPlan
  try {
    const preview = JSON.parse(planBinding.bytes.toString('utf8')) as Record<string, unknown>
    if (typeof preview.outputRoot !== 'string' || preview.outputRoot.length === 0)
      throw new Error('outputRoot must be a non-empty string')
    plan = preview as unknown as EvalExecutionPlan
  } catch (error) {
    throw new Error(
      `Cannot safely clear a prior EvalRunBundle because the plan outputRoot is not trustworthy: ${(error as Error).message}`,
      { cause: error },
    )
  }
  const base = await realpath(path.dirname(path.resolve(planPath)))
  const outputRoot = path.resolve(base, plan.outputRoot)
  try {
    await prepareOutputRoot(base, outputRoot)
  } catch (error) {
    throw new Error(
      `Cannot safely clear a prior EvalRunBundle because outputRoot is not trustworthy: ${(error as Error).message}`,
      { cause: error },
    )
  }
  const validation = await validateExecutionPlan(planPath)
  if (!validation.valid) throw new Error(`EvalExecutionPlan is invalid:\n${validation.errors.join('\n')}`)
  await assertBoundInputsUnchanged([planBinding], new Map())
  const planRaw = planBinding.bytes
  const sourceTarget = await realpath(path.resolve(base, plan.target.path))
  const targetDigestBefore = await computeSkillDigest(sourceTarget)
  if (targetDigestBefore !== plan.target.digest) throw new Error('target Skill changed after plan validation')
  const sources = new Map<string, SkillSource>()
  const boundSkills = new Map<string, SkillSource>([
    ['target', { root: sourceTarget, digest: targetDigestBefore }],
  ])
  for (const configuration of plan.configurations) {
    if (configuration.skillMode === 'with-skill') sources.set(configuration.id, { root: sourceTarget, digest: targetDigestBefore })
    else if (configuration.skillMode === 'without-skill') sources.set(configuration.id, { root: null, digest: null })
    else {
      const previousRoot = await realpath(path.resolve(base, configuration.skillPath!))
      const digest = await computeSkillDigest(previousRoot)
      if (digest !== configuration.skillDigest)
        throw new Error(`${configuration.id} previous-version Skill changed after plan validation`)
      sources.set(configuration.id, { root: previousRoot, digest })
      boundSkills.set(configuration.id, { root: previousRoot, digest })
    }
  }
  const additionalBindings = await Promise.all([
    ...plan.cases.paths.map((entry, index) =>
      captureBoundFile(`case corpus file ${index + 1}`, path.resolve(base, entry))),
    captureBoundFile('preflight audit', path.resolve(base, plan.audit.path)),
    captureBoundFile('provider capabilities', path.resolve(base, plan.provider.capabilitiesPath)),
  ])
  const caseBindings = additionalBindings.slice(0, plan.cases.paths.length)
  const auditBinding = additionalBindings[plan.cases.paths.length]
  const capabilitiesBinding = additionalBindings[plan.cases.paths.length + 1]
  if (!auditBinding || !capabilitiesBinding) throw new Error('Eval input fingerprint is incomplete')
  const canonicalCases = caseBindings
    .map((entry) => stable(JSON.parse(entry.bytes.toString('utf8'))))
    .sort()
  if (sha256(canonicalCases.join('\n')) !== plan.cases.corpusDigest)
    throw new Error('Bound Eval input changed before execution: case corpus digest does not match plan')
  if (auditBinding.digest !== plan.audit.digest)
    throw new Error('Bound Eval input changed before execution: preflight audit digest does not match plan')
  if (capabilitiesBinding.digest !== plan.provider.capabilitiesDigest)
    throw new Error('Bound Eval input changed before execution: provider capabilities digest does not match plan')
  const capabilities = JSON.parse(capabilitiesBinding.bytes.toString('utf8')) as RuntimeCapabilities
  const boundFiles = [planBinding, ...additionalBindings]
  const cases = new Map<string, EvalCase>()
  for (const entry of caseBindings) {
    const document = JSON.parse(entry.bytes.toString('utf8')) as unknown
    for (const evalCase of casesFrom(document)) cases.set(String(evalCase.id), evalCase)
  }
  const runs: import('./bundle.js').EvalRun[] = []
  const executionLimitations: string[] = []
  for (const evalCase of cases.values()) {
    for (const configuration of plan.configurations) {
      const skillSource = sources.get(configuration.id)
      if (!skillSource) throw new Error(`Missing Skill source for ${configuration.id}`)
      for (let runIndex = 1; runIndex <= plan.runsPerCase; runIndex += 1) {
        runs.push(await runOne({
          plan,
          base,
          skillSource,
          evalCase,
          configuration,
          runIndex,
          options,
          executionLimitations,
        }))
        await assertBoundInputsUnchanged(boundFiles, boundSkills)
      }
    }
  }
  await assertBoundInputsUnchanged(boundFiles, boundSkills)
  await assertSafeOutputPath(base, outputRoot)
  const comparisons = comparisonAggregate(runs)
  const evidenceLevel = comparisons.some((entry) => entry.comparable) ? 'comparative' : 'executed'
  const limitations = [...capabilities.limitations]
  limitations.push(...executionLimitations)
  if (!capabilities.capabilities.cleanContext) limitations.push('Provider does not prove a clean model context.')
  if (!capabilities.capabilities.toolTrace) limitations.push('Provider does not capture a tool trace.')
  if (!capabilities.capabilities.tokenUsage) limitations.push('Provider does not capture token usage.')
  limitations.push('A completed provider process is not an Eval pass; grading and Skill-defect attribution remain separate.')
  for (const comparison of comparisons) {
    if (comparison.comparable) continue
    const identity = `${comparison.comparisonId}/${comparison.caseId}/${comparison.runIndex}`
    limitations.push(comparison.paired
      ? `Planned comparison ${identity} has no comparable grading.`
      : `Planned comparison ${identity} has no completed with-skill and baseline pair.`)
  }
  const bundle: import('./bundle.js').EvalRunBundle = {
    schemaVersion: 2,
    producer: 'run-agent-skill-evals',
    independentContext: capabilities.capabilities.cleanContext === true,
    provider: { id: plan.provider.id, version: capabilities.providerVersion },
    planDigest: sha256(planRaw),
    targetSkillDigest: plan.target.digest,
    caseCorpusDigest: plan.cases.corpusDigest,
    preflightAuditDigest: plan.audit.digest,
    comparisonPlanned: comparisons.length > 0,
    evidenceLevel,
    runs,
    aggregate: {
      cases: cases.size,
      configurations: plan.configurations.length,
      runs: runs.length,
      completed: runs.filter((entry) => entry.status === 'completed').length,
      processFailed: runs.filter((entry) => entry.status === 'process-failed' || entry.status === 'error').length,
      timedOut: runs.filter((entry) => entry.status === 'timeout').length,
      comparisons,
    },
    limitations: [...new Set(limitations)],
  }
  const bundlePath = path.join(outputRoot, 'eval-run-bundle.json')
  const bundleBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`)
  const bundleDigest = sha256(bundleBytes)
  const bundleTemp = await createRunnerOwnedTemp(
    base,
    outputRoot,
    outputRoot,
    'eval-run-bundle',
    bundleBytes,
  )
  try {
    await options.beforeBundleCommit?.()
    await commitRunnerOwnedFile(
      base,
      outputRoot,
      outputRoot,
      bundleTemp,
      bundlePath,
      'EvalRunBundle',
      bundleDigest,
      async () => {
        await assertBoundInputsUnchanged(boundFiles, boundSkills)
        await assertSafeOutputPath(base, outputRoot)
      },
    )
    const bundleValidation = await validateRunBundle(bundlePath)
    if (!bundleValidation.valid || bundleValidation.calculated?.bundleDigest !== bundleDigest) {
      throw new Error(`Generated EvalRunBundle is invalid:\n${bundleValidation.errors.join('\n')}`)
    }
    return { valid: true, bundlePath, bundleDigest, evidenceLevel }
  } catch (error) {
    await unlink(bundleTemp).catch(() => undefined)
    await unlink(bundlePath).catch(() => undefined)
    throw error
  }
}
