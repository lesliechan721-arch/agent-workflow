import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { validateExecutionAudits } from './audit.js'
import { isPathInside, sha256, stable, toPosixRelative } from './common.js'
import { getRuntimeCapabilities } from './capabilities.js'
import { comparisonAggregate, validateRunBundle } from './bundle.js'
import { captureAndValidateExecutionPlan, promptOf } from './plan.js'
import type {
  AwSkillEvalExecutionPlan,
  CapturedPlanFile,
  EvalCase,
  EvalConfiguration,
} from './plan.js'
import { hasCoreProcessReceipt, ProviderProcessCleanupError, runProviderProcess } from './process.js'
import {
  assertProcessTreeInspectionAvailable,
  observeProcessTree,
  terminateProcessTree,
  type ProcessTreeDependencies,
  type ProcessTreeObservation,
} from './process-tree.js'
import { assertSafeOutputPath } from './output-path.js'
import {
  computeCanonicalDirectoryDigest,
  computeSkillDigest,
  materializeCapturedCanonicalDirectory,
  materializeCapturedRuntimeSkill,
  type CapturedRuntimeSkill,
} from './runtime-skill.js'
import { validateProviderCapabilities, validateProviderOutput } from './schemas.js'
import type {
  Digest,
  EvalProviderCapabilities,
  EvalProviderOutput,
  ProcessResult,
  RunExecutionPlanOptions,
  RunExecutionResult,
} from './types.js'

const OBSERVED_PROCESS_LIMITATION =
  'Portable process observation does not guarantee descendant cleanup; comparative evidence is disabled.'
const VERIFIED_OBSERVED_PROCESS_LIMITATION =
  'Verified process observation is not OS-enforced containment and does not guarantee descendant cleanup.'
const CLEANUP_FAILURE_LIMITATION = 'Provider process cleanup could not be verified.'
const RESTRICTED_PERMISSION_PROFILES = new Set(['workspace', 'read-only'])
const FULL_ACCESS_PERMISSION_PROFILE = 'danger-full-access'
const PROVIDER_PROCESS_MARKER_ENV = 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER'

interface ProcessExecutionContext {
  containment: 'managed' | 'verified-observed' | 'observed'
  hooks: NonNullable<RunExecutionPlanOptions['processHooks']>
  processTree?: ProcessTreeDependencies
  limitation?: string
}

function hasConfirmedExternalContainment(options: RunExecutionPlanOptions): boolean {
  const containment = options.processHooks?.externalContainment
  return containment?.confirmed === true &&
    containment.descendantCleanupGuaranteed === true &&
    containment.readOnlySkillSnapshotGuaranteed === true &&
    options.processHooks?.terminateProcessTree !== undefined
}

function createObservedProcessHooks(
  processTree?: ProcessTreeDependencies,
): NonNullable<RunExecutionPlanOptions['processHooks']> {
  let observation: ProcessTreeObservation | undefined
  return {
    onSpawn: ({ pid }) => {
      observation = observeProcessTree(pid, undefined, processTree)
    },
    terminateProcessTree: async ({ pid }) => {
      await terminateProcessTree(
        pid,
        (signal) => {
          try {
            process.kill(pid, signal)
          } catch {
            // The direct child can already be closed.
          }
        },
        processTree,
        {
          observation,
          allowInspectionUnavailable: true,
        },
      )
      return { confirmed: true }
    },
  }
}

function normalizedPermissionProfile(sourceEnv: NodeJS.ProcessEnv): string | null {
  const value = sourceEnv.CODEX_PERMISSION_PROFILE?.trim()
  return value ? value.replace(/^:/u, '') : null
}

async function resolveProcessExecutionContext(
  plan: AwSkillEvalExecutionPlan,
  options: RunExecutionPlanOptions,
): Promise<ProcessExecutionContext> {
  if (options.processHooks) {
    if (!hasConfirmedExternalContainment(options)) {
      throw new Error(
        'Portable Eval execution requires explicitly confirmed external containment with descendant cleanup and read-only Skill snapshots.',
      )
    }
    return { containment: 'managed', hooks: options.processHooks }
  }
  if ((plan.minimumEvidenceLevel ?? 'executed') === 'executed') {
    return {
      containment: 'observed',
      hooks: createObservedProcessHooks(options.processTree),
      processTree: options.processTree,
      limitation: OBSERVED_PROCESS_LIMITATION,
    }
  }
  const platform = options.platform ?? options.processTree?.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(
      `minimumEvidenceLevel comparative requires Full Access verified process observation; ${platform} is not supported. No provider process was started.`,
    )
  }
  const profile = normalizedPermissionProfile(options.sourceEnv ?? process.env)
  if (profile && profile !== FULL_ACCESS_PERMISSION_PROFILE) {
    const known = RESTRICTED_PERMISSION_PROFILES.has(profile) ? 'restricted' : 'unknown'
    throw new Error(
      `minimumEvidenceLevel comparative is blocked because CODEX_PERMISSION_PROFILE=${profile} is ${known}. ` +
        'A one-off sandbox_permissions=require_escalated request is not Full Access. No provider process was started.',
    )
  }
  const processTree = {
    ...options.processTree,
    platform,
    markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
  }
  await assertProcessTreeInspectionAvailable(processTree)
  return {
    containment: 'verified-observed',
    hooks: {},
    processTree,
    limitation: VERIFIED_OBSERVED_PROCESS_LIMITATION,
  }
}

interface SkillSource {
  captured: CapturedRuntimeSkill | null
  digest: Digest | null
}

const artifactRoles = new Set(['trace', 'report', 'output', 'grading', 'other'])
const SECRET_REDACTION = '[REDACTED]'

class RunnerOwnedOutputError extends Error {}

async function assertBoundInputsUnchanged(
  files: CapturedPlanFile[],
  skills: Map<string, SkillSource>,
  runtimeInputs: Map<string, CapturedRuntimeSkill> = new Map(),
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
    if (!source.captured) continue
    try {
      if (await computeSkillDigest(source.captured.sourceRoot) !== source.digest) throw new Error('digest changed')
    } catch (error) {
      throw new Error(
        `Bound Eval input changed during execution: ${configurationId} Skill: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
  for (const [runtimeInputId, captured] of runtimeInputs) {
    try {
      if (await computeCanonicalDirectoryDigest(captured.sourceRoot) !== captured.digest)
        throw new Error('digest changed')
    } catch (error) {
      throw new Error(
        `Bound Eval input changed during execution: runtime input ${runtimeInputId}: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
}

function assertBoundInputsOutsideOutputRoot(
  outputRoot: string,
  files: CapturedPlanFile[],
  skills: Map<string, SkillSource>,
  runtimeInputs: Map<string, CapturedRuntimeSkill> = new Map(),
): void {
  for (const file of files) {
    if (isPathInside(outputRoot, file.canonicalPath))
      throw new Error(`Bound Eval input must not be inside outputRoot: ${file.label}`)
  }
  for (const [configurationId, source] of skills) {
    if (source.captured && isPathInside(outputRoot, source.captured.sourceRoot))
      throw new Error(`Bound Eval input must not be inside outputRoot: ${configurationId} Skill`)
  }
  for (const [runtimeInputId, captured] of runtimeInputs) {
    if (isPathInside(outputRoot, captured.sourceRoot))
      throw new Error(`Bound Eval input must not be inside outputRoot: runtime input ${runtimeInputId}`)
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

function allowlistedSecretValues(
  allowlist: readonly string[] | undefined,
  source: NodeJS.ProcessEnv,
): string[] {
  return [...new Set((allowlist ?? []).flatMap((name) => {
    const value = source[name]
    return value ? [value] : []
  }))].sort((left, right) => right.length - left.length)
}

function secretVariants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((secret) => {
    const jsonEncoded = JSON.stringify(secret).slice(1, -1)
    return jsonEncoded === secret ? [secret] : [secret, jsonEncoded]
  }))].sort((left, right) => right.length - left.length)
}

function redactText(value: string, secrets: readonly string[]): string {
  return secretVariants(secrets).reduce(
    (current, secret) => current.split(secret).join(SECRET_REDACTION),
    value,
  )
}

function redactJsonValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    redactText(key, secrets),
    redactJsonValue(entry, secrets),
  ]))
}

function redactBuffer(value: Buffer, secrets: readonly string[]): Buffer {
  let result = value
  for (const variant of secretVariants(secrets)) {
    const secret = Buffer.from(variant)
    if (secret.length === 0) continue
    const chunks: Buffer[] = []
    let offset = 0
    let match = result.indexOf(secret, offset)
    if (match < 0) continue
    while (match >= 0) {
      chunks.push(result.subarray(offset, match), Buffer.from(SECRET_REDACTION))
      offset = match + secret.length
      match = result.indexOf(secret, offset)
    }
    chunks.push(result.subarray(offset))
    result = Buffer.concat(chunks)
  }
  return result
}

async function providerArtifacts(
  parsed: EvalProviderOutput,
  runDirectory: string,
  outputRoot: string,
  secrets: readonly string[],
): Promise<Array<{ role: 'trace' | 'report' | 'output' | 'grading' | 'other'; path: string; digest: Digest }>> {
  const artifacts = []
  for (const entry of parsed.artifacts) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string')
      throw new Error('provider artifact requires path')
    const role = typeof entry.role === 'string' ? entry.role : 'other'
    if (!artifactRoles.has(role)) throw new Error(`unsupported provider artifact role: ${role}`)
    const candidate = path.resolve(runDirectory, entry.path)
    if (!isPathInside(runDirectory, candidate)) throw new Error('provider artifact leaves the run directory')
    const candidateInfo = await lstat(candidate)
    if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) {
      throw new Error('provider artifact must be a regular run file')
    }
    const actual = await realpath(candidate)
    if (!isPathInside(runDirectory, actual) || !(await stat(actual)).isFile())
      throw new Error('provider artifact is not a regular run file')
    const handle = await open(actual, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW)
    let artifactBytes: Buffer
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error('provider artifact must be one canonical regular run file')
      }
      const original = await handle.readFile()
      artifactBytes = redactBuffer(original, secrets)
      if (!artifactBytes.equals(original)) {
        if (artifactBytes.length > 0) {
          await handle.write(artifactBytes, 0, artifactBytes.length, 0)
        }
        await handle.truncate(artifactBytes.length)
        await handle.sync()
      }
    } finally {
      await handle.close()
    }
    if (await realpath(candidate) !== actual) throw new Error('provider artifact identity changed')
    artifacts.push({
      role: role as 'trace' | 'report' | 'output' | 'grading' | 'other',
      path: toPosixRelative(outputRoot, actual),
      digest: sha256(artifactBytes),
    })
  }
  return artifacts
}

function inheritedEnvironment(
  inherit: boolean,
  source: NodeJS.ProcessEnv = process.env,
  allowlist: string[] = [],
): NodeJS.ProcessEnv {
  if (inherit) return source
  return Object.fromEntries([...new Set([
    'PATH',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'WINDIR',
    ...allowlist,
  ])].flatMap((name) =>
    source[name] === undefined ? [] : [[name, source[name]]]))
}

async function describeProvider(input: {
  plan: AwSkillEvalExecutionPlan
  base: string
  providerCwd: string | null
  capabilities: EvalProviderCapabilities
  processExecution: ProcessExecutionContext
  sourceEnv: NodeJS.ProcessEnv
}): Promise<void> {
  const argv = [...input.plan.provider.describeCommand]
  const executable = argv.shift()
  if (!executable) throw new Error('provider describeCommand has no executable')
  const result = await runProviderProcess({
    executable,
    args: argv,
    cwd: input.providerCwd ?? input.base,
    env: inheritedEnvironment(false, input.sourceEnv),
    timeoutMs: input.plan.timeoutMs,
    maxBufferBytes: 20 * 1024 * 1024,
  }, input.processExecution.hooks, {
    containment: input.processExecution.containment,
    processTree: input.processExecution.processTree,
  })
  if (result.exitCode !== 0 || result.timedOut || result.maxBufferExceeded) {
    throw new Error(
      `Provider describe failed with exit code ${String(result.exitCode)}${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(result.stdout.trim())
  } catch (error) {
    throw new Error(`Provider describe output must be JSON: ${(error as Error).message}`)
  }
  const validation = await validateProviderCapabilities(value)
  if (!validation.valid || !validation.calculated) {
    throw new Error(`Provider describe output is invalid:\n${validation.errors.join('\n')}`)
  }
  if (validation.calculated.provider !== input.plan.provider.id) {
    throw new Error('Provider describe output id does not match the execution Plan')
  }
  if (stable(validation.calculated) !== stable(input.capabilities)) {
    throw new Error('Provider describe output does not match the bound provider capabilities document')
  }
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
  plan: AwSkillEvalExecutionPlan
  base: string
  providerCwd: string | null
  skillSource: SkillSource
  evalCase: EvalCase
  configuration: EvalConfiguration
  runIndex: number
  processExecution: ProcessExecutionContext
  executionLimitations: string[]
  providerCapabilities: EvalProviderCapabilities
  runtimeInputs: Map<string, CapturedRuntimeSkill>
  sourceEnv: NodeJS.ProcessEnv
  beforeRunDirectoryReset: () => Promise<void>
}): Promise<{ run: import('./bundle.js').EvalRun; cleanupFailed: boolean }> {
  const { plan, base, skillSource, evalCase, configuration, runIndex, executionLimitations } = input
  const caseId = String(evalCase.id)
  const outputRoot = path.resolve(base, plan.outputRoot)
  const runDirectory = path.resolve(outputRoot, caseId, configuration.id, String(runIndex))
  if (!isPathInside(outputRoot, runDirectory)) throw new Error('run directory leaves outputRoot')
  await assertSafeOutputPath(base, outputRoot)
  await assertSafeOutputPath(base, runDirectory)
  await input.beforeRunDirectoryReset()
  await rm(runDirectory, { recursive: true, force: true })
  await mkdir(runDirectory, { recursive: true })
  await assertSafeOutputPath(base, runDirectory)
  let skillSnapshot: string | null = null
  if (skillSource.captured) {
    const snapshot = await materializeCapturedRuntimeSkill(
      skillSource.captured,
      path.join(runDirectory, 'skill'),
    )
    if (snapshot.digest !== skillSource.digest) {
      throw new Error('Runtime Skill snapshot digest does not match the bound Skill digest')
    }
    skillSnapshot = snapshot.root
  }
  const runtimeInputSnapshots: Record<string, string> = {}
  for (const [id, captured] of input.runtimeInputs) {
    const snapshot = await materializeCapturedCanonicalDirectory(
      captured,
      path.join(runDirectory, 'runtime-inputs', id),
    )
    if (snapshot.digest !== captured.digest)
      throw new Error(`Runtime input snapshot ${id} does not match the bound digest`)
    runtimeInputSnapshots[id] = snapshot.root
  }
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
  const secrets = allowlistedSecretValues(
    plan.provider.environmentAllowlist,
    input.sourceEnv,
  )
  const env = {
    ...inheritedEnvironment(
      plan.provider.inheritEnvironment,
      input.sourceEnv,
      plan.provider.environmentAllowlist,
    ),
    ...plan.provider.env,
    ...configuration.env,
    AGENT_EVAL_CASE_ID: caseId,
    AGENT_EVAL_CONFIGURATION: configuration.id,
    AGENT_EVAL_SKILL_MODE: configuration.skillMode,
    AGENT_EVAL_OUTPUT_DIR: runDirectory,
    AGENT_EVAL_CASE_PATH: casePath,
    AGENT_EVAL_RUNTIME_INPUTS_JSON: stable(runtimeInputSnapshots),
    ...(skillSnapshot ? { AGENT_EVAL_SKILL_PATH: skillSnapshot } : {}),
  }
  const started = Date.now()
  let result: ProcessResult
  const snapshotDigestBefore = skillSnapshot === null ? null : await computeSkillDigest(skillSnapshot)
  let cleanupFailed = false
  try {
    result = await runProviderProcess({
      executable,
      args: argv,
      cwd: input.providerCwd ?? runDirectory,
      env,
      timeoutMs: plan.timeoutMs,
      maxBufferBytes: 20 * 1024 * 1024,
    }, input.processExecution.hooks, {
      containment: input.processExecution.containment,
      processTree: input.processExecution.processTree,
    })
  } catch (error) {
    if (error instanceof ProviderProcessCleanupError && error.result) {
      result = error.result
      cleanupFailed = true
    } else {
      throw new Error(redactText(error instanceof Error ? error.message : String(error), secrets))
    }
  }
  if (skillSnapshot !== null && await computeSkillDigest(skillSnapshot) !== snapshotDigestBefore) {
    throw new Error('Provider modified the captured Runtime Skill snapshot')
  }
  for (const [id, captured] of input.runtimeInputs) {
    if (await computeCanonicalDirectoryDigest(runtimeInputSnapshots[id]!) !== captured.digest)
      throw new Error(`Provider modified runtime input snapshot ${id}`)
  }
  if (!hasCoreProcessReceipt(result)) {
    throw new Error('Provider result does not contain a core-issued process receipt')
  }
  if (!result.descendantCleanupGuaranteed) {
    executionLimitations.push(result.containmentLimitation ?? OBSERVED_PROCESS_LIMITATION)
  }
  let status: import('./bundle.js').EvalRun['status'] = cleanupFailed
    ? 'error'
    : result.timedOut
    ? 'timeout'
    : result.maxBufferExceeded
      ? 'process-failed'
      : result.exitCode === 0
        ? 'completed'
        : 'process-failed'
  let stdoutEvidence = redactText(result.stdout, secrets)
  let stderr = redactText(result.stderr, secrets)
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
    const value = redactJsonValue(JSON.parse(result.stdout.trim()) as unknown, secrets)
    stdoutEvidence = `${JSON.stringify(value, null, 2)}\n`
    const validation = await validateProviderOutput(value)
    if (!validation.valid || !validation.calculated)
      throw new Error(`provider stdout does not match EvalProviderOutput v1: ${validation.errors.join('; ')}`)
    const parsed = validation.calculated
    if (
      parsed.provider.id !== plan.provider.id ||
      parsed.provider.version !== input.providerCapabilities.providerVersion
    ) throw new Error('provider stdout identity does not match describe/capabilities')
    usage = parsed.usage
    grading = result.gradingEvidenceAccepted ? gradingOf(parsed.grading) : null
    if (!result.gradingEvidenceAccepted && parsed.grading !== null) {
      executionLimitations.push(
        `Run ${caseId}/${configuration.id}/${runIndex}: provider grading was not accepted because descendant cleanup is not guaranteed.`,
      )
    }
    artifacts = await providerArtifacts(parsed, runDirectory, outputRoot, secrets)
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
    if (error instanceof RunnerOwnedOutputError) {
      throw new RunnerOwnedOutputError(redactText(error.message, secrets))
    }
    usage = null
    grading = null
    artifacts = []
    if (status === 'completed') {
      status = 'error'
      stderr += `${stderr ? '\n' : ''}Provider JSON/artifact error: ${redactText((error as Error).message, secrets)}`
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
      Buffer.from(stdoutEvidence),
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
  return { run: {
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
  }, cleanupFailed }
}

export async function runExecutionPlan(
  planPath: string,
  options: RunExecutionPlanOptions,
): Promise<RunExecutionResult> {
  const validation = await captureAndValidateExecutionPlan(planPath)
  if (!validation.valid) throw new Error(`AwSkillEvalExecutionPlan is invalid:\n${validation.errors.join('\n')}`)
  if (!validation.captured) throw new Error('AwSkillEvalExecutionPlan capture is unavailable')
  const captured = validation.captured
  const { plan, base, outputRoot } = captured
  const planRaw = captured.planFile.raw
  const sources = new Map<string, SkillSource>()
  for (const configuration of plan.configurations) {
    const skill = captured.skills.get(configuration.id)
    if (skill === undefined) throw new Error(`Missing captured Skill source for ${configuration.id}`)
    sources.set(configuration.id, { captured: skill, digest: skill?.digest ?? null })
  }
  const boundSkills = new Map<string, SkillSource>(
    [...captured.boundSkills].map(([id, skill]) => [id, { captured: skill, digest: skill.digest }]),
  )
  const capabilities = captured.capabilities
  const runtimeCapabilities = getRuntimeCapabilities()
  const boundFiles = [
    captured.planFile,
    ...captured.caseFiles,
    captured.capabilitiesFile,
  ]
  assertBoundInputsOutsideOutputRoot(outputRoot, boundFiles, boundSkills, captured.runtimeInputs)
  await assertBoundInputsUnchanged(boundFiles, boundSkills, captured.runtimeInputs)
  const cases = new Map<string, EvalCase>()
  for (const evalCase of captured.cases) cases.set(String(evalCase.id), evalCase)
  if (!options || !Array.isArray(options.auditPaths))
    throw new Error('Eval execution requires auditPaths with at least one preflight Audit')
  await validateExecutionAudits(captured, options.auditPaths)
  const processExecution = await resolveProcessExecutionContext(plan, options)
  await assertBoundInputsUnchanged(boundFiles, boundSkills, captured.runtimeInputs)
  await describeProvider({
    plan,
    base,
    providerCwd: captured.providerCwd,
    capabilities,
    processExecution,
    sourceEnv: options.sourceEnv ?? process.env,
  })
  await assertBoundInputsUnchanged(boundFiles, boundSkills, captured.runtimeInputs)
  try {
    await prepareOutputRoot(base, outputRoot)
  } catch (error) {
    throw new Error(
      `Cannot safely clear a prior EvalRunBundle because outputRoot is not trustworthy: ${(error as Error).message}`,
      { cause: error },
    )
  }
  const runs: import('./bundle.js').EvalRun[] = []
  const executionLimitations: string[] = []
  let executionCleanupFailed = false
  execution: for (const evalCase of cases.values()) {
    for (const configuration of plan.configurations) {
      const skillSource = sources.get(configuration.id)
      if (!skillSource) throw new Error(`Missing Skill source for ${configuration.id}`)
      for (let runIndex = 1; runIndex <= plan.runsPerCase; runIndex += 1) {
        const result = await runOne({
          plan,
          base,
          providerCwd: captured.providerCwd,
          skillSource,
          evalCase,
          configuration,
          runIndex,
          processExecution,
          executionLimitations,
          providerCapabilities: capabilities,
          runtimeInputs: captured.runtimeInputs,
          sourceEnv: options.sourceEnv ?? process.env,
          beforeRunDirectoryReset: async () => {
            assertBoundInputsOutsideOutputRoot(outputRoot, boundFiles, boundSkills, captured.runtimeInputs)
            await assertBoundInputsUnchanged(boundFiles, boundSkills, captured.runtimeInputs)
          },
        })
        runs.push(result.run)
        await assertBoundInputsUnchanged(boundFiles, boundSkills, captured.runtimeInputs)
        if (result.cleanupFailed) {
          executionCleanupFailed = true
          executionLimitations.push(CLEANUP_FAILURE_LIMITATION)
          break execution
        }
      }
    }
  }
  await assertBoundInputsUnchanged(boundFiles, boundSkills, captured.runtimeInputs)
  await assertSafeOutputPath(base, outputRoot)
  const comparisons = comparisonAggregate(runs)
  const evidenceLevel = comparisons.some((entry) => entry.comparable) ? 'comparative' : 'executed'
  const minimumEvidenceLevel = plan.minimumEvidenceLevel ?? 'executed'
  const plannedComparisons = cases.size * new Set(
    plan.configurations.flatMap((entry) => entry.comparisonId === null ? [] : [entry.comparisonId]),
  ).size * plan.runsPerCase
  const comparableComparisons = comparisons.filter((entry) => entry.comparable).length
  const requirementsMet = !executionCleanupFailed && (
    minimumEvidenceLevel === 'executed' || (
      plannedComparisons > 0 && comparableComparisons === plannedComparisons
    )
  )
  const limitations = [...capabilities.limitations]
  limitations.push(...executionLimitations)
  if (processExecution.limitation) limitations.push(processExecution.limitation)
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
    schemaVersion: 4,
    runner: { id: 'aw-skill-eval', version: runtimeCapabilities.providerVersion },
    independentContext: capabilities.capabilities.cleanContext === true,
    provider: { id: plan.provider.id, version: capabilities.providerVersion },
    providerCapabilitiesDigest: plan.provider.capabilitiesDigest,
    planDigest: sha256(planRaw),
    targetSkillDigest: plan.target.digest,
    caseCorpusDigest: plan.cases.corpusDigest,
    runtimeInputs: plan.runtimeInputs.map((entry) => ({ id: entry.id, digest: entry.digest })),
    comparisonPlanned: comparisons.length > 0,
    evidenceLevel,
    evidenceRequirement: {
      minimumEvidenceLevel,
      plannedComparisons,
      comparableComparisons,
      satisfied: requirementsMet,
    },
    processManagement: {
      mode: executionCleanupFailed ? 'observed' : processExecution.containment,
      descendantCleanupGuaranteed: !executionCleanupFailed && processExecution.containment === 'managed',
      ...(executionCleanupFailed
        ? { limitation: CLEANUP_FAILURE_LIMITATION }
        : processExecution.limitation
          ? { limitation: processExecution.limitation }
          : {}),
    },
    runs,
    aggregate: {
      cases: new Set(runs.map((entry) => entry.caseId)).size,
      configurations: new Set(runs.map((entry) => entry.configuration)).size,
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
        await assertBoundInputsUnchanged(boundFiles, boundSkills, captured.runtimeInputs)
        await assertSafeOutputPath(base, outputRoot)
      },
    )
    const bundleValidation = await validateRunBundle(bundlePath, {
      providerCapabilitiesPath: captured.capabilitiesFile.canonicalPath,
    })
    if (!bundleValidation.valid || bundleValidation.calculated?.bundleDigest !== bundleDigest) {
      throw new Error(`Generated EvalRunBundle is invalid:\n${bundleValidation.errors.join('\n')}`)
    }
    return { valid: true, bundlePath, bundleDigest, evidenceLevel, requirementsMet }
  } catch (error) {
    await unlink(bundleTemp).catch(() => undefined)
    await unlink(bundlePath).catch(() => undefined)
    throw error
  }
}
