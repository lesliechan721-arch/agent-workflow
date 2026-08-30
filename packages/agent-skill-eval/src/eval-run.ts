import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { sha256, toPosixRelative } from './common.js'
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
  type EvalResultRun,
} from './eval-result.js'
import { validateEvalSpecFile, type EvalSpecCalculated } from './eval-spec.js'
import {
  runBuiltinEvalProvider,
  type BuiltinEvalProviderDependencies,
  type BuiltinEvalProviderRunInput,
} from './providers.js'
import { ProviderProcessCleanupError } from './process.js'
import { computeCanonicalDirectoryDigest, computeSkillDigest } from './runtime-skill.js'
import {
  parseSelectedCases,
  type SelectedCasesDocument,
  type SelectedEvalCase,
} from './selected-cases.js'
import type { Digest } from './types.js'

export interface RunEvalSpecOptions {
  auditPath: string
  sourceEnv?: NodeJS.ProcessEnv
  builtinProviderDependencies?: BuiltinEvalProviderDependencies
  runBuiltinProvider?: (
    id: string,
    input: BuiltinEvalProviderRunInput,
    dependencies?: BuiltinEvalProviderDependencies,
  ) => Promise<EvalProviderRunResult>
  executeCustomProvider?: (options: CustomProcessExecutorOptions) => Promise<EvalProviderRunResult>
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
  return [...new Set(CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST.flatMap((name) => {
    const value = sourceEnv[name]
    return value ? [value, JSON.stringify(value).slice(1, -1)] : []
  }))].filter(Boolean).sort((left, right) => right.length - left.length)
}

function redactText(value: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => current.replaceAll(secret, '[redacted]'), value)
}

function redactValue<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactText(value, secrets) as T
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
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
  if (!sameDigests(captured, current)) throw new BoundInputChangedError('Prepared Eval input digest changed.')
}

function assertDigestsMatchSpec(
  calculated: EvalSpecCalculated,
  digests: BoundInputDigests,
): void {
  if (
    digests.target !== calculated.targetDigest
    || digests.cases !== calculated.caseDigest
    || digests.previousTarget !== calculated.previousTargetDigest
  ) throw new BoundInputChangedError('Prepared Eval input no longer matches EvalSpec digests.')
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
  if (!sameDigests(captured, current)) {
    throw new BoundInputChangedError('Run input snapshot digest changed.')
  }
}

function isTimeout(error: unknown): boolean {
  return /timed out|timeout/u.test(error instanceof Error ? error.message : String(error))
}

function isCleanupFailure(error: unknown): boolean {
  return error instanceof ProviderProcessCleanupError ||
    /cleanup|termination|process-tree/u.test(error instanceof Error ? error.message : String(error))
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
  const sourceEnv = options.sourceEnv ?? process.env
  const secrets = secretValues(sourceEnv)
  const startedAt = new Date().toISOString()
  const runs: EvalResultRun[] = []
  let stop = false
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
        let runOutput = path.join(
          calculated.paths.outputDir,
          'runs',
          evalCase.id,
          variant,
          `attempt-${attempt}`,
          'output',
        )
        try {
          await assertInputsUnchanged(calculated, captured)
          await assertSnapshotUnchanged(snapshot, captured)
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
          }
          const providerResult = typeof calculated.spec.provider === 'string'
            ? await (options.runBuiltinProvider ?? runBuiltinEvalProvider)(
                calculated.spec.provider,
                { ...input, evalRoot: prepared.attemptRoot },
                options.builtinProviderDependencies,
              )
            : await (options.executeCustomProvider ?? executeCustomProcessProvider)({
                command: calculated.spec.provider.command as [string, ...string[]],
                evalRoot: prepared.attemptRoot,
                input,
                sourceEnv,
              })
          const sanitized = redactValue(providerResult, secrets)
          usage = sanitized.usage === null ? null : { ...sanitized.usage }
          grade = sanitized.grade
          await writeFile(
            path.join(prepared.runOutput, 'provider-result.json'),
            `${JSON.stringify(sanitized, null, 2)}\n`,
            { flag: 'wx' },
          )
          status = 'completed'
        } catch (caught) {
          status = isTimeout(caught) ? 'timeout' : 'failed'
          error = { message: redactText(caught instanceof Error ? caught.message : String(caught), secrets) || 'Provider failed.' }
          if (caught instanceof BoundInputChangedError || isCleanupFailure(caught) || status === 'timeout') stop = true
        }
        try {
          await assertInputsUnchanged(calculated, captured)
          await assertSnapshotUnchanged(snapshot, captured)
        } catch (changed) {
          status = 'failed'
          usage = null
          grade = null
          error = { message: redactText((changed as Error).message, secrets) }
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
        })
        if (stop) break
      }
    }
  }
  try {
    await assertInputsUnchanged(calculated, captured)
    await assertSnapshotUnchanged(snapshot, captured)
  } catch (changed) {
    if (runs.length === 0) throw changed
    const last = runs[runs.length - 1]!
    last.status = 'failed'
    last.usage = null
    last.grade = null
    last.error = { message: redactText((changed as Error).message, secrets) }
  }
  const result: EvalResult = {
    version: 1,
    specDigest: calculated.specDigest,
    auditDigest: auditValidation.calculated.auditDigest,
    targetDigest: calculated.targetDigest,
    caseDigest: calculated.caseDigest,
    provider: calculated.spec.provider,
    startedAt,
    finishedAt: new Date().toISOString(),
    runs,
    summary: computeEvalResultSummary(runs),
  }
  const resultPath = path.join(calculated.paths.outputDir, 'result.json')
  const resultDigest = await writeResultSafely(resultPath, result, resultBinding)
  return { valid: true, resultPath, resultDigest, result }
}
