import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { sha256, toPosixRelative } from './common.js'
import { credentialValues, redactSecrets } from './credentials.js'
import {
  CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST,
  executeCustomProcessProvider,
  type CustomProcessExecutorOptions,
  type EvalProviderRunInput,
  type EvalProviderRunResult,
  type EvalProviderVariant,
} from './custom-process.js'
import { validateEvalAuditFile } from './eval-audit.js'
import {
  computeEvalResultSummary,
  createEvalResultBinding,
  validateEvalResult,
  type EvalResultBinding,
  type EvalResult,
  type EvalResultProcessManagement,
  type EvalResultRun,
} from './eval-result.js'
import {
  resolveEvalProcessManagement,
  type EvalProcessManagementDependencies,
} from './eval-process-management.js'
import { resolveCodexEvalExecutable } from './codex-eval-isolation.js'
import { validateEvalSpecFile, type EvalSpecCalculated } from './eval-spec.js'
import { assertEvalProviderSuiteKind } from './eval-suite-binding.js'
import {
  runBuiltinEvalProvider,
  type BuiltinEvalProviderDependencies,
  type BuiltinEvalProviderRunInput,
} from './providers.js'
import { resolveCodexEvalRuntimeConfig } from './codex-eval-runtime-config.js'
import { ProviderProcessCleanupError } from './process.js'
import {
  executeCodexWorkflowProvider,
  type CodexWorkflowExecutorOptions,
} from './codex-workflow.js'
import { computeCanonicalDirectoryDigest, computeSkillDigest } from './runtime-skill.js'
import {
  parseSelectedCases,
  type SelectedCasesDocument,
  type SelectedEvalCase,
} from './selected-cases.js'
import type { Digest } from './types.js'

export interface RunEvalSpecOptions {
  auditPath: string
  allowUnmanagedProcesses?: boolean
  processManagementDependencies?: EvalProcessManagementDependencies
  onProcessManagementResolved?: (evidence: EvalResultProcessManagement) => void
  signal?: AbortSignal
  sourceEnv?: NodeJS.ProcessEnv
  builtinProviderDependencies?: BuiltinEvalProviderDependencies
  runBuiltinProvider?: (
    id: string,
    input: BuiltinEvalProviderRunInput,
    dependencies?: BuiltinEvalProviderDependencies,
  ) => Promise<EvalProviderRunResult>
  executeCustomProvider?: (options: CustomProcessExecutorOptions) => Promise<EvalProviderRunResult>
  executeCodexWorkflowProvider?: (
    options: CodexWorkflowExecutorOptions,
  ) => Promise<EvalProviderRunResult>
}

export interface RunEvalSpecResult {
  valid: true
  resultPath: string
  resultDigest: Digest
  result: EvalResult
}

interface BoundInputDigests {
  workspace: Digest
  target: Digest
  cases: Digest
  previousTarget: Digest | null
}

interface RunInputSnapshot {
  root: string
  workspace: string
  currentTarget: string
  previousTarget: string | null
  cases: string
}

class BoundInputChangedError extends Error {}

function secretValues(sourceEnv: NodeJS.ProcessEnv): string[] {
  return credentialValues(sourceEnv, CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST)
}

function redactText(value: string, secrets: readonly string[]): string {
  return redactSecrets(value, secrets)
}

function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactText(value, secrets) as T
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactText(key, secrets),
      redactValue(entry, secrets),
    ])) as T
  }
  return value
}

async function inputDigests(calculated: EvalSpecCalculated): Promise<BoundInputDigests> {
  return {
    workspace: await computeCanonicalDirectoryDigest(calculated.paths.workspace),
    target: await computeSkillDigest(calculated.paths.target),
    cases: sha256(await readFile(calculated.paths.cases)),
    previousTarget: calculated.paths.previousTarget
      ? await computeSkillDigest(calculated.paths.previousTarget)
      : null,
  }
}

function sameDigests(left: BoundInputDigests, right: BoundInputDigests): boolean {
  return left.workspace === right.workspace &&
    left.target === right.target &&
    left.cases === right.cases &&
    left.previousTarget === right.previousTarget
}

async function assertInputsUnchanged(
  calculated: EvalSpecCalculated,
  captured: BoundInputDigests,
): Promise<void> {
  let current: BoundInputDigests
  try {
    current = await inputDigests(calculated)
  } catch (error) {
    throw new BoundInputChangedError(`Prepared Eval input changed: ${(error as Error).message}`)
  }
  if (!sameDigests(captured, current) || !digestsMatchSpec(calculated, current)) {
    throw new BoundInputChangedError(
      'Prepared Eval input digest changed or no longer matches EvalSpec digests.',
    )
  }
}

function digestsMatchSpec(
  calculated: EvalSpecCalculated,
  digests: BoundInputDigests,
): boolean {
  return digests.workspace === calculated.workspaceDigest
    && digests.workspace === calculated.spec.workspace.digest
    && digests.target === calculated.targetDigest
    && digests.cases === calculated.caseDigest
    && digests.previousTarget === calculated.previousTargetDigest
}

function assertDigestsMatchSpec(
  calculated: EvalSpecCalculated,
  digests: BoundInputDigests,
): void {
  if (!digestsMatchSpec(calculated, digests)) {
    throw new BoundInputChangedError('Prepared Eval input no longer matches EvalSpec digests.')
  }
}

function triggerProviderCase(
  document: SelectedCasesDocument,
  evalCase: SelectedEvalCase,
): Record<string, unknown> {
  if (!document.suite.providerSuite || !evalCase.providerCase) {
    throw new Error('Selected trigger case has no canonical provider form.')
  }
  return {
    suite: document.suite.providerSuite,
    value: evalCase.providerCase,
  }
}

export function adaptConversationProviderCase(
  document: SelectedCasesDocument,
  evalCase: SelectedEvalCase,
): Record<string, unknown> {
  const participants = [...new Set([
    document.suite.unitUnderTest,
    ...(document.suite.participants ?? []),
  ])]
  const assertions = evalCase.assertions as unknown[]
  const input = evalCase.input && typeof evalCase.input === 'object' && !Array.isArray(evalCase.input)
    ? evalCase.input as Record<string, unknown>
    : {}
  const expected = evalCase.expected && typeof evalCase.expected === 'object' && !Array.isArray(evalCase.expected)
    ? evalCase.expected as Record<string, unknown>
    : {}
  const audit = evalCase.audit && typeof evalCase.audit === 'object' && !Array.isArray(evalCase.audit)
    ? evalCase.audit as Record<string, unknown>
    : null
  const workspaceUnchanged = expected.workspaceUnchanged === undefined
    ? true
    : expected.workspaceUnchanged
  const scriptedReplies = Array.isArray(input.scriptedReplies)
    ? input.scriptedReplies.map((reply) => {
        if (typeof reply === 'string') return reply
        const row = reply as Record<string, unknown>
        return {
          answers_by_index: row.answersByIndex,
          ...(row.expectedQuestionCount === undefined
            ? {}
            : { expected_question_count: row.expectedQuestionCount }),
          unexpected_question_answer: row.unexpectedQuestionAnswer,
        }
      })
    : []
  const workspaceFiles = input.workspaceFiles && typeof input.workspaceFiles === 'object'
    && !Array.isArray(input.workspaceFiles)
    ? input.workspaceFiles as Record<string, unknown>
    : {}
  const allowedWorkspaceChanges = Array.isArray(expected.allowedWorkspaceChanges)
    ? expected.allowedWorkspaceChanges
    : []
  const artifacts = Array.isArray(expected.artifacts)
    ? expected.artifacts.map((artifact) => {
        const row = artifact as Record<string, unknown>
        const { notContains, ...providerArtifact } = row
        return {
          ...providerArtifact,
          ...(Object.hasOwn(row, 'notContains') ? { not_contains: notContains } : {}),
        }
      })
    : []
  return {
    value: {
      id: evalCase.id,
      prompt: evalCase.prompt,
      scripted_replies: scriptedReplies,
      expected_output: expected.output ?? 'Evaluate the response against the approved assertions.',
      ...(Object.keys(workspaceFiles).length > 0 ? { workspace_files: workspaceFiles } : {}),
      ...(Array.isArray(input.pathPrepend) && input.pathPrepend.length > 0
        ? { environment: { pathPrepend: input.pathPrepend } }
        : {}),
      sandbox: workspaceUnchanged === false ? 'workspace-write' : 'read-only',
      review: {
        checks: assertions,
        workspace_unchanged: workspaceUnchanged,
        ...(allowedWorkspaceChanges.length > 0
          ? { allowed_workspace_changes: allowedWorkspaceChanges }
          : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      },
    },
    skillName: document.suite.unitUnderTest,
    skillNames: participants,
    isolation: document.suite.runtime?.isolation === 'strict' ? 'strict' : 'standard',
    suitePathPrepend: document.suite.runtime?.pathPrepend ?? [],
    assertions,
    ...(audit && Object.hasOwn(audit, 'allowedVariance')
      ? { allowedVariance: audit.allowedVariance }
      : {}),
  }
}

function providerCase(document: SelectedCasesDocument, evalCase: SelectedEvalCase): Record<string, unknown> {
  if (document.suite.kind === 'trigger') return triggerProviderCase(document, evalCase)
  if (document.suite.kind === 'conversation') return adaptConversationProviderCase(document, evalCase)
  return evalCase
}

async function prepareAttempt(options: {
  calculated: EvalSpecCalculated
  snapshot: RunInputSnapshot
  document: SelectedCasesDocument
  caseId: string
  variant: EvalProviderVariant
  attempt: number
}): Promise<{
  attemptRoot: string
  workspacePath: string
  fixturesPath: string
  runOutput: string
}> {
  const attemptRoot = path.join(
    options.calculated.paths.outputDir,
    'runs',
    options.caseId,
    options.variant,
    `attempt-${options.attempt}`,
  )
  const workspacePath = path.join(attemptRoot, 'workspace', 'subject')
  const fixturesPath = path.join(attemptRoot, 'workspace', 'eval')
  const runOutput = path.join(attemptRoot, 'output')
  await fs.ensureDir(path.dirname(attemptRoot))
  await mkdir(attemptRoot)
  try {
    await mkdir(path.join(attemptRoot, 'workspace'))
    await fs.copy(path.join(options.snapshot.workspace, 'subject'), workspacePath, {
      dereference: false,
      overwrite: false,
      errorOnExist: true,
    })
    await fs.copy(path.join(options.snapshot.workspace, 'eval'), fixturesPath, {
      dereference: false,
      overwrite: false,
      errorOnExist: true,
    })
    await mkdir(runOutput)
  } catch (error) {
    await fs.remove(attemptRoot)
    throw error
  }
  const target = options.variant === 'current'
    ? options.snapshot.currentTarget
    : options.variant === 'previous-version'
      ? options.snapshot.previousTarget
      : null
  if (target) {
    try {
      const destination = path.join(
        workspacePath,
        '.agents',
        'skills',
        options.document.suite.unitUnderTest,
      )
      if (await fs.pathExists(destination)) {
        throw new Error('Prepared subject unexpectedly contains the unit-under-test Skill.')
      }
      await fs.ensureDir(path.dirname(destination))
      await fs.copy(target, destination, {
        dereference: false,
        overwrite: false,
        errorOnExist: true,
      })
    } catch (error) {
      await fs.remove(attemptRoot)
      throw error
    }
  }
  return { attemptRoot, workspacePath, fixturesPath, runOutput }
}

async function createRunInputSnapshot(
  calculated: EvalSpecCalculated,
  captured: BoundInputDigests,
  casesBytes: Buffer,
): Promise<RunInputSnapshot> {
  const root = path.join(calculated.paths.outputDir, '.run-input')
  const workspace = path.join(root, 'workspace')
  const currentTarget = path.join(root, 'targets', 'current')
  const previousTarget = calculated.paths.previousTarget
    ? path.join(root, 'targets', 'previous')
    : null
  const cases = path.join(root, 'cases.json')
  await mkdir(root)
  try {
    await mkdir(workspace)
    await mkdir(path.join(root, 'targets'))
    await fs.copy(path.join(calculated.paths.workspace, 'subject'), path.join(workspace, 'subject'), {
      dereference: false,
      overwrite: false,
      errorOnExist: true,
    })
    await fs.copy(path.join(calculated.paths.workspace, 'eval'), path.join(workspace, 'eval'), {
      dereference: false,
      overwrite: false,
      errorOnExist: true,
    })
    await fs.copy(calculated.paths.target, currentTarget, {
      dereference: false,
      overwrite: false,
      errorOnExist: true,
    })
    await writeFile(cases, casesBytes, { flag: 'wx', mode: 0o600 })
    if (calculated.paths.previousTarget && previousTarget) {
      await fs.copy(calculated.paths.previousTarget, previousTarget, {
        dereference: false,
        overwrite: false,
        errorOnExist: true,
      })
    }
    const snapshotDigests: BoundInputDigests = {
      workspace: await computeCanonicalDirectoryDigest(workspace),
      target: await computeSkillDigest(currentTarget),
      cases: sha256(await readFile(cases)),
      previousTarget: previousTarget ? await computeSkillDigest(previousTarget) : null,
    }
    if (!sameDigests(captured, snapshotDigests)) {
      throw new BoundInputChangedError('Run input snapshot does not match the prepared Eval input.')
    }
    assertDigestsMatchSpec(calculated, snapshotDigests)
    return { root, workspace, currentTarget, previousTarget, cases }
  } catch (error) {
    await fs.remove(root)
    throw error
  }
}

async function assertSnapshotUnchanged(
  calculated: EvalSpecCalculated,
  snapshot: RunInputSnapshot,
  captured: BoundInputDigests,
): Promise<void> {
  const current: BoundInputDigests = {
    workspace: await computeCanonicalDirectoryDigest(snapshot.workspace),
    target: await computeSkillDigest(snapshot.currentTarget),
    cases: sha256(await readFile(snapshot.cases)),
    previousTarget: snapshot.previousTarget
      ? await computeSkillDigest(snapshot.previousTarget)
      : null,
  }
  if (!sameDigests(captured, current) || !digestsMatchSpec(calculated, current)) {
    throw new BoundInputChangedError(
      'Run input snapshot digest changed or no longer matches EvalSpec digests.',
    )
  }
}

function isTimeout(error: unknown): boolean {
  return /timed out|timeout/u.test(error instanceof Error ? error.message : String(error))
}

function isCleanupFailure(error: unknown): boolean {
  return error instanceof ProviderProcessCleanupError ||
    /cleanup|termination|process-tree/u.test(error instanceof Error ? error.message : String(error))
}

function abortError(): Error {
  return new Error('Eval execution was aborted.')
}

async function writeResultSafely(
  resultPath: string,
  result: EvalResult,
  binding: EvalResultBinding,
): Promise<Digest> {
  const validation = await validateEvalResult(result, binding)
  if (!validation.valid) throw new Error(`Generated EvalResult is invalid: ${validation.errors.join('; ')}`)
  if (await fs.pathExists(resultPath)) throw new Error('Eval result.json already exists.')
  const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`)
  const temporary = path.join(path.dirname(resultPath), `.result.${randomUUID()}.tmp`)
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  try {
    if (await fs.pathExists(resultPath)) throw new Error('Eval result.json appeared before commit.')
    await rename(temporary, resultPath)
  } catch (error) {
    await fs.remove(temporary).catch(() => undefined)
    throw error
  }
  return sha256(bytes)
}

export async function runEvalSpec(
  specPath: string,
  options: RunEvalSpecOptions,
): Promise<RunEvalSpecResult> {
  if (!options?.auditPath) throw new Error('Eval execution requires auditPath.')
  const specValidation = await validateEvalSpecFile(specPath)
  if (!specValidation.valid || !specValidation.calculated) {
    throw new Error(`EvalSpec is invalid: ${specValidation.errors.join('; ')}`)
  }
  const calculated = specValidation.calculated
  const specRoot = await fs.realpath(path.dirname(path.resolve(specPath)))
  const casesBytes = await readFile(calculated.paths.cases)
  if (sha256(casesBytes) !== calculated.caseDigest) {
    throw new BoundInputChangedError('Selected cases changed after EvalSpec validation.')
  }
  const document = parseSelectedCases(JSON.parse(casesBytes.toString('utf8')))
  if (document.suite.unitUnderTest !== calculated.spec.source.skill) {
    throw new Error('Selected cases unitUnderTest does not match EvalSpec source.skill.')
  }
  assertEvalProviderSuiteKind(calculated.spec.provider, document.suite.kind)
  const selectedCaseIds = document.cases.map((entry) => entry.id)
  const auditValidation = await validateEvalAuditFile(options.auditPath, {
    spec: calculated.spec,
    selectedCaseIds,
  })
  if (!auditValidation.valid || !auditValidation.calculated) {
    throw new Error(`EvalAudit does not admit execution: ${auditValidation.errors.join('; ')}`)
  }
  const resultBinding = createEvalResultBinding(
    calculated,
    auditValidation.calculated.auditDigest,
    document,
  )
  const captured = await inputDigests(calculated)
  assertDigestsMatchSpec(calculated, captured)
  await assertInputsUnchanged(calculated, captured)
  const sourceEnv = options.sourceEnv
    ?? options.builtinProviderDependencies?.sourceEnv
    ?? process.env
  const requestedCodexBin = options.builtinProviderDependencies?.codexBin
    ?? sourceEnv.AW_SKILL_EVAL_CODEX_BIN
    ?? 'codex'
  const processPlatform = options.processManagementDependencies?.platform
    ?? options.processManagementDependencies?.processTree?.platform
    ?? process.platform
  const resolvedCodexBin = await resolveCodexEvalExecutable(
    { executable: requestedCodexBin, sourceEnv, platform: processPlatform },
    options.processManagementDependencies?.resolveCodexExecutable,
  )
  const codexBin = resolvedCodexBin ?? requestedCodexBin
  const processManagement = await resolveEvalProcessManagement({
    allowUnmanaged: options.allowUnmanagedProcesses ?? false,
    codexBin,
    sourceEnv,
    dependencies: {
      ...options.processManagementDependencies,
      resolveCodexExecutable: async () => resolvedCodexBin,
    },
  })
  options.onProcessManagementResolved?.(processManagement)
  const runtime = await resolveCodexEvalRuntimeConfig({
    sourceEnv,
    inheritUserConfig: true,
    modelOverride: options.builtinProviderDependencies?.model
      ?? sourceEnv.AW_SKILL_EVAL_CODEX_MODEL,
  })
  const secrets = (): string[] => [
    ...secretValues(sourceEnv),
    ...runtime.sensitiveValues,
  ]
  const builtinProviderDependencies: BuiltinEvalProviderDependencies = {
    ...options.builtinProviderDependencies,
    sourceEnv,
    codexBin,
    model: runtime.model ?? undefined,
    codexRuntime: runtime,
    processManagement,
  }
  const startedAt = new Date().toISOString()
  const runs: EvalResultRun[] = []
  let stop = false
  await assertInputsUnchanged(calculated, captured)
  await fs.ensureDir(path.dirname(calculated.paths.outputDir))
  await mkdir(calculated.paths.outputDir)
  let snapshot: RunInputSnapshot
  try {
    snapshot = await createRunInputSnapshot(calculated, captured, casesBytes)
  } catch (error) {
    await fs.remove(calculated.paths.outputDir)
    throw error
  }
  for (const evalCase of document.cases) {
    if (stop) break
    for (const variant of resultBinding.allowedVariants) {
      if (stop) break
      for (let attempt = 1; attempt <= calculated.spec.runs; attempt += 1) {
        const attemptStarted = Date.now()
        let status: EvalResultRun['status'] = 'failed'
        let usage: EvalResultRun['usage'] = null
        let grade: EvalResultRun['grade'] = null
        let error: EvalResultRun['error'] = null
        let artifacts: EvalResultRun['artifacts']
        let runOutput = path.join(
          calculated.paths.outputDir,
          'runs',
          evalCase.id,
          variant,
          `attempt-${attempt}`,
          'output',
        )
        try {
          if (options.signal?.aborted) throw abortError()
          await assertInputsUnchanged(calculated, captured)
          await assertSnapshotUnchanged(calculated, snapshot, captured)
          const prepared = await prepareAttempt({
            calculated,
            snapshot,
            document,
            caseId: evalCase.id,
            variant,
            attempt,
          })
          runOutput = prepared.runOutput
          const input: EvalProviderRunInput = {
            case: providerCase(document, evalCase),
            variant,
            attempt,
            workspacePath: prepared.workspacePath,
            fixturesPath: prepared.fixturesPath,
            outputDir: prepared.runOutput,
            timeoutMs: calculated.spec.timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
          }
          const providerResult = typeof calculated.spec.provider === 'string'
            ? await (options.runBuiltinProvider ?? runBuiltinEvalProvider)(
                calculated.spec.provider,
                { ...input, evalRoot: prepared.attemptRoot },
                builtinProviderDependencies,
              )
            : calculated.spec.provider.type === 'custom-process'
              ? await (options.executeCustomProvider ?? executeCustomProcessProvider)({
                  command: calculated.spec.provider.command as [string, ...string[]],
                  evalRoot: prepared.attemptRoot,
                  input,
                  sourceEnv,
                  codexRuntime: runtime,
                  processManagement,
                })
              : await (options.executeCodexWorkflowProvider ?? executeCodexWorkflowProvider)({
                  provider: {
                    ...calculated.spec.provider,
                    command: calculated.spec.provider.command as [string, ...string[]],
                  },
                  evalRoot: prepared.attemptRoot,
                  input,
                  sourceEnv,
                  codexRuntime: runtime,
                  codexBin: builtinProviderDependencies.codexBin,
                  processManagement,
                })
          if (options.signal?.aborted) throw abortError()
          const sanitized = redactValue(providerResult, secrets())
          usage = sanitized.usage === null ? null : { ...sanitized.usage }
          grade = sanitized.grade
          artifacts = typeof calculated.spec.provider === 'object'
            && calculated.spec.provider.type === 'codex-workflow'
            && sanitized.artifacts
            ? [
                ...sanitized.artifacts.map((artifact) => ({ ...artifact })),
                { path: 'provider-result.json', role: 'result' },
              ]
            : undefined
          await writeFile(
            path.join(prepared.runOutput, 'provider-result.json'),
            `${JSON.stringify(sanitized, null, 2)}\n`,
            { flag: 'wx' },
          )
          status = 'completed'
        } catch (caught) {
          status = isTimeout(caught) ? 'timeout' : 'failed'
          usage = null
          grade = null
          artifacts = undefined
          error = { message: redactText(caught instanceof Error ? caught.message : String(caught), secrets()) || 'Provider failed.' }
          if (
            options.signal?.aborted
            || caught instanceof BoundInputChangedError
            || isCleanupFailure(caught)
            || status === 'timeout'
            || (
              typeof calculated.spec.provider === 'object'
              && calculated.spec.provider.type === 'codex-workflow'
            )
          ) stop = true
        }
        try {
          await assertInputsUnchanged(calculated, captured)
          await assertSnapshotUnchanged(calculated, snapshot, captured)
        } catch (changed) {
          status = 'failed'
          usage = null
          grade = null
          artifacts = undefined
          error = { message: redactText((changed as Error).message, secrets()) }
          stop = true
        }
        runs.push({
          caseId: evalCase.id,
          variant,
          attempt,
          status,
          durationMs: Math.max(0, Date.now() - attemptStarted),
          outputDir: toPosixRelative(specRoot, runOutput),
          usage,
          grade,
          error,
          ...(artifacts ? { artifacts } : {}),
        })
        if (stop) break
      }
    }
  }
  try {
    await assertInputsUnchanged(calculated, captured)
    await assertSnapshotUnchanged(calculated, snapshot, captured)
  } catch (changed) {
    if (runs.length === 0) throw changed
    const last = runs[runs.length - 1]!
    last.status = 'failed'
    last.usage = null
    last.grade = null
    delete last.artifacts
    last.error = { message: redactText((changed as Error).message, secrets()) }
  }
  if (options.signal?.aborted && runs.length > 0) {
    const last = runs[runs.length - 1]!
    last.status = 'failed'
    last.usage = null
    last.grade = null
    delete last.artifacts
    last.error = { message: abortError().message }
  }
  const result: EvalResult = {
    version: 2,
    specDigest: calculated.specDigest,
    auditDigest: auditValidation.calculated.auditDigest,
    targetDigest: calculated.targetDigest,
    caseDigest: calculated.caseDigest,
    provider: calculated.spec.provider,
    processManagement: redactValue(processManagement, secrets()),
    startedAt,
    finishedAt: new Date().toISOString(),
    runs,
    summary: computeEvalResultSummary(runs),
  }
  const resultPath = path.join(calculated.paths.outputDir, 'result.json')
  const resultDigest = await writeResultSafely(resultPath, result, resultBinding)
  return { valid: true, resultPath, resultDigest, result }
}
