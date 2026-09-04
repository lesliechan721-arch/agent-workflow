import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import type { CodexEvalProcessManagementEvidence } from './codex-eval-app-server.js'
import {
  applyCodexEvalProviderEnvironment,
  materializeCodexEvalRuntimeHome,
  type CodexEvalRuntimeConfig,
} from './codex-eval-runtime-config.js'
import { applyCodexEvalGitIsolation } from './codex-eval-isolation.js'
import { credentialValues, redactSecrets, secretVariants } from './credentials.js'
import type { ProcessTreeDependencies } from './process-tree.js'
import { ProviderProcessCleanupError, runProviderProcess } from './process.js'
import { assertProviderRunPaths } from './run-paths.js'

export type EvalProviderVariant = 'current' | 'without-skill' | 'previous-version'

export interface EvalProviderUsage {
  inputTokens: number
  outputTokens: number
}

export interface EvalProviderGrade {
  passed: boolean
  score: number | null
  details?: Record<string, unknown>
}

export interface EvalProviderRunInput {
  case: Record<string, unknown>
  variant: EvalProviderVariant
  attempt: number
  workspacePath: string
  fixturesPath: string
  outputDir: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface EvalProviderRunResult {
  usage: EvalProviderUsage | null
  grade: EvalProviderGrade
  diagnostics?: string[]
  artifacts?: Array<{ path: string; role: string }>
}

export interface CustomProcessInput {
  version: 1
  case: Record<string, unknown>
  variant: EvalProviderVariant
  attempt: number
  workspacePath: string
  fixturesPath: string
  outputDir: string
}

export interface CustomProcessOutput {
  version: 1
  usage: EvalProviderUsage | null
  grade: EvalProviderGrade
}

export const CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST = [
  'ALL_PROXY',
  'AW_SKILL_EVAL_CODEX_BIN',
  'AW_SKILL_EVAL_CODEX_MODEL',
  'CODEX_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
] as const

const CLEAN_ENVIRONMENT_ALLOWLIST = [
  'LANG',
  'LC_ALL',
  'PATH',
  ...CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST,
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain only ${expected.join(', ')}.`)
  }
}

function optionalExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} is missing ${key}.`)
    }
  }
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`${label} has unknown field ${unknown}.`)
}

function parseUsage(value: unknown): EvalProviderUsage | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('custom process usage must be null or an object.')
  exactKeys(value, ['inputTokens', 'outputTokens'], 'custom process usage')
  if (
    !Number.isSafeInteger(value.inputTokens) || (value.inputTokens as number) < 0 ||
    !Number.isSafeInteger(value.outputTokens) || (value.outputTokens as number) < 0
  ) {
    throw new Error('custom process token counts must be non-negative safe integers.')
  }
  return {
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
  }
}

export function parseEvalProviderGrade(value: unknown, label = 'provider grade'): EvalProviderGrade {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  optionalExactKeys(value, ['passed', 'score'], ['details'], label)
  if (typeof value.passed !== 'boolean') throw new Error(`${label}.passed must be boolean.`)
  if (
    value.score !== null &&
    (typeof value.score !== 'number' || !Number.isFinite(value.score))
  ) throw new Error(`${label}.score must be a finite number or null.`)
  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Error(`${label}.details must be an object when present.`)
  }
  return {
    passed: value.passed,
    score: value.score as number | null,
    ...(value.details === undefined
      ? {}
      : { details: value.details as Record<string, unknown> }),
  }
}

export function parseCustomProcessOutput(stdout: string): CustomProcessOutput {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`custom process stdout must be one JSON object: ${(error as Error).message}`)
  }
  if (!isRecord(value)) throw new Error('custom process stdout must be one JSON object.')
  exactKeys(value, ['grade', 'usage', 'version'], 'custom process stdout')
  if (value.version !== 1) throw new Error('custom process stdout version must be 1.')
  return {
    version: 1,
    usage: parseUsage(value.usage),
    grade: parseEvalProviderGrade(value.grade, 'custom process grade'),
  }
}

function redactBuffer(value: Buffer, variants: readonly string[]): Buffer {
  let result = value
  for (const variant of variants) {
    const secret = Buffer.from(variant)
    if (secret.length === 0) continue
    const chunks: Buffer[] = []
    let offset = 0
    let match = result.indexOf(secret, offset)
    if (match < 0) continue
    while (match >= 0) {
      chunks.push(result.subarray(offset, match), Buffer.from('[redacted]'))
      offset = match + secret.length
      match = result.indexOf(secret, offset)
    }
    chunks.push(result.subarray(offset))
    result = Buffer.concat(chunks)
  }
  return result
}

async function removeSensitiveFile(target: string, parentMode: number): Promise<void> {
  if ((parentMode & 0o222) === 0) {
    throw new Error('credential artifact parent directory is not writable.')
  }
  await rm(target)
}

const REMOVED_SENSITIVE_ARTIFACT_DIAGNOSTIC =
  'custom process credential cleanup removed an unredactable artifact.'

function containsSecret(value: string, variants: readonly string[]): boolean {
  return variants.some((secret) => value.includes(secret))
}

async function redactOutputTree(root: string, variants: readonly string[]): Promise<string[]> {
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('custom process credential cleanup requires an ordinary owned directory.')
  }
  const diagnostics: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    const info = await lstat(target)
    const sensitiveName = containsSecret(entry.name, variants)
    if (info.isSymbolicLink()) {
      await removeSensitiveFile(target, rootInfo.mode)
      diagnostics.push(REMOVED_SENSITIVE_ARTIFACT_DIAGNOSTIC)
      continue
    }
    if (info.isDirectory()) {
      if (sensitiveName) {
        if ((rootInfo.mode & 0o222) === 0) {
          throw new Error('credential artifact parent directory is not writable.')
        }
        await rm(target, { recursive: true })
        diagnostics.push(REMOVED_SENSITIVE_ARTIFACT_DIAGNOSTIC)
        continue
      }
      diagnostics.push(...await redactOutputTree(target, variants))
      continue
    }
    if (!info.isFile()) {
      if (sensitiveName) {
        await removeSensitiveFile(target, rootInfo.mode)
        diagnostics.push(REMOVED_SENSITIVE_ARTIFACT_DIAGNOSTIC)
      }
      continue
    }
    if (sensitiveName) {
      await removeSensitiveFile(target, rootInfo.mode)
      diagnostics.push(REMOVED_SENSITIVE_ARTIFACT_DIAGNOSTIC)
      continue
    }
    const content = await readFile(target)
    const redacted = redactBuffer(content, variants)
    if (redacted.equals(content)) continue
    if (info.nlink > 1 || (info.mode & 0o222) === 0) {
      await removeSensitiveFile(target, rootInfo.mode)
      diagnostics.push(REMOVED_SENSITIVE_ARTIFACT_DIAGNOSTIC)
      continue
    }
    try {
      await writeFile(target, redacted)
    } catch {
      await removeSensitiveFile(target, rootInfo.mode)
      diagnostics.push(REMOVED_SENSITIVE_ARTIFACT_DIAGNOSTIC)
    }
  }
  return diagnostics
}

async function makeOwnedTreeRemovable(root: string): Promise<void> {
  const info = await lstat(root)
  if (info.isSymbolicLink()) return
  if (!info.isDirectory()) {
    if (info.isFile() && info.nlink === 1) await chmod(root, 0o600)
    return
  }
  await chmod(root, 0o700)
  for (const entry of await readdir(root)) {
    await makeOwnedTreeRemovable(path.join(root, entry))
  }
}

async function cleanupCustomProcessAttempt(
  outputDir: string,
  temporaryRoots: readonly string[],
  variants: readonly string[],
): Promise<string[]> {
  const temporaryResults = await Promise.allSettled(
    temporaryRoots.map(async (root) => {
      try {
        await rm(root, { recursive: true, force: true })
      } catch {
        await makeOwnedTreeRemovable(root)
        await rm(root, { recursive: true, force: true })
      }
    }),
  )
  const redactionResult = await Promise.allSettled([redactOutputTree(outputDir, variants)])
  if (redactionResult[0]!.status === 'rejected') {
    let removalError: unknown
    try {
      await makeOwnedTreeRemovable(outputDir)
      await rm(outputDir, { recursive: true, force: true })
    } catch (error) {
      removalError = error
    }
    if (removalError) {
      throw new Error('custom process credential cleanup could not clear the output directory after an artifact cleanup failure.')
    }
    throw new Error('custom process credential cleanup removed the output directory after an artifact cleanup failure.')
  }
  if (temporaryResults.some((result) => result.status === 'rejected')) {
    throw new Error('custom process credential cleanup could not remove temporary provider state.')
  }
  return redactionResult[0].value
}

function cleanEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  evalRoot: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of CLEAN_ENVIRONMENT_ALLOWLIST) {
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name]
  }
  const home = path.join(evalRoot, '.custom-provider-home')
  const temp = path.join(evalRoot, '.custom-provider-tmp')
  return applyCodexEvalGitIsolation({
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    NO_COLOR: '1',
  })
}

export interface CustomProcessExecutorOptions {
  command: readonly [string, ...string[]]
  evalRoot: string
  input: EvalProviderRunInput
  sourceEnv?: NodeJS.ProcessEnv
  codexRuntime?: CodexEvalRuntimeConfig
  maxBufferBytes?: number
  processTree?: ProcessTreeDependencies
  processManagement?: CodexEvalProcessManagementEvidence
}

export async function executeCustomProcessProvider(
  options: CustomProcessExecutorOptions,
): Promise<EvalProviderRunResult> {
  if (!path.isAbsolute(options.evalRoot)) throw new Error('evalRoot must be absolute.')
  const evalRoot = await realpath(options.evalRoot)
  if (!Number.isSafeInteger(options.input.attempt) || options.input.attempt < 1) {
    throw new Error('provider attempt must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(options.input.timeoutMs) || options.input.timeoutMs < 1) {
    throw new Error('provider timeoutMs must be a positive safe integer.')
  }
  await assertProviderRunPaths({
    evalRoot: options.evalRoot,
    workspacePath: options.input.workspacePath,
    fixturesPath: options.input.fixturesPath,
    outputDir: options.input.outputDir,
  })
  const input: CustomProcessInput = {
    version: 1,
    case: options.input.case,
    variant: options.input.variant,
    attempt: options.input.attempt,
    workspacePath: options.input.workspacePath,
    fixturesPath: options.input.fixturesPath,
    outputDir: options.input.outputDir,
  }
  const sourceEnv = options.sourceEnv ?? process.env
  const runtimeHome = path.join(evalRoot, '.custom-provider-runtime')
  const stdin = JSON.stringify(input)
  let secrets = credentialValues(sourceEnv, CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST)
  let variants = secretVariants(secrets)
  if (containsSecret(stdin, variants)) {
    throw new Error('custom process input contains an allowlisted credential value.')
  }
  const cleanupPlatform = options.processTree?.platform ?? process.platform
  const processManagement = options.processManagement ?? {
    mode: 'managed',
    inspectionAvailable: true,
    userAcknowledged: false,
    descendantCleanupGuaranteed: false,
    limitation:
      'Process-tree inspection verifies cooperative descendants, but it is not OS-enforced containment and does not guarantee descendant cleanup.',
  } as const
  if (
    processManagement.mode !== 'unmanaged-confirmed'
    && cleanupPlatform !== 'darwin'
    && cleanupPlatform !== 'linux'
    && !(cleanupPlatform === 'win32' && process.platform === 'win32')
  ) {
    throw new Error(`custom process cleanup is unsupported on ${cleanupPlatform}.`)
  }
  if (options.codexRuntime) {
    try {
      await materializeCodexEvalRuntimeHome(options.codexRuntime, runtimeHome)
      secrets = [...secrets, ...options.codexRuntime.sensitiveValues]
      variants = secretVariants(secrets)
      if (containsSecret(stdin, variants)) {
        throw new Error('custom process input contains a runtime credential value.')
      }
    } catch (error) {
      await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
  let env = cleanEnvironment(sourceEnv, evalRoot)
  if (options.codexRuntime) {
    env = applyCodexEvalProviderEnvironment({
      ...env,
      CODEX_HOME: runtimeHome,
      AW_SKILL_EVAL_CODEX_MODEL: options.codexRuntime.model ?? undefined,
      AW_CODEX_EVAL_RUNTIME_HOME: runtimeHome,
      AW_CODEX_EVAL_MODEL_PROVIDER: options.codexRuntime.modelProvider,
      AW_CODEX_EVAL_SENSITIVE_ENV_NAMES: JSON.stringify(
        options.codexRuntime.sensitiveEnvironmentNames,
      ),
    }, options.codexRuntime)
  }
  const temporaryRoots: string[] = options.codexRuntime ? [runtimeHome] : []
  let processResult: Awaited<ReturnType<typeof runProviderProcess>> | undefined
  let processCleanupError: unknown
  let providerResult: EvalProviderRunResult | undefined
  let providerError: unknown
  try {
    await mkdir(env.HOME!, { mode: 0o700 })
    temporaryRoots.push(env.HOME!)
    await mkdir(env.TMPDIR!, { mode: 0o700 })
    temporaryRoots.push(env.TMPDIR!)
    processResult = await runProviderProcess({
      executable: options.command[0],
      args: [...options.command.slice(1)],
      cwd: evalRoot,
      env,
      stdin,
      timeoutMs: options.input.timeoutMs,
      maxBufferBytes: options.maxBufferBytes ?? 4 * 1024 * 1024,
      ...(options.input.signal ? { signal: options.input.signal } : {}),
    }, {}, {
      containment: processManagement.mode === 'unmanaged-confirmed'
        ? 'unmanaged-confirmed'
        : 'verified-observed',
      ...(processManagement.mode === 'unmanaged-confirmed'
        ? {}
        : { processTree: options.processTree }),
    })
  } catch (error) {
    if (error instanceof ProviderProcessCleanupError) {
      processResult = error.result
      processCleanupError = error
    } else {
      providerError = error
    }
  }
  if (processResult) {
    try {
      if (processResult.timedOut) {
        throw new Error(`custom process timed out after ${options.input.timeoutMs}ms.`)
      }
      if (processResult.cancelled) throw new Error('custom process was aborted.')
      if (processResult.maxBufferExceeded) {
        throw new Error('custom process output exceeded the buffer limit.')
      }
      const stderr = redactSecrets(processResult.stderr.trim(), secrets)
      if (processResult.signal) {
        throw new Error(
          `custom process terminated by signal ${processResult.signal}${stderr ? `: ${stderr}` : '.'}`,
        )
      }
      if (processResult.exitCode !== 0) {
        throw new Error(
          `custom process failed with exit code ${String(processResult.exitCode)}${stderr ? `: ${stderr}` : '.'}`,
        )
      }
      if (containsSecret(processResult.stdout, variants)) {
        throw new Error('custom process stdout contains an allowlisted credential value.')
      }
      const parsed = parseCustomProcessOutput(redactSecrets(processResult.stdout, secrets))
      providerResult = { usage: parsed.usage, grade: parsed.grade }
    } catch (error) {
      providerError = error
    }
  }
  let cleanupDiagnostics: string[] = []
  let cleanupError: unknown
  try {
    cleanupDiagnostics = await cleanupCustomProcessAttempt(
      options.input.outputDir,
      temporaryRoots,
      variants,
    )
  } catch (error) {
    cleanupError = error
  }
  if (providerError || processCleanupError || cleanupError || cleanupDiagnostics.length > 0) {
    const messages = [
      ...(providerError ? [providerError instanceof Error ? providerError.message : String(providerError)] : []),
      ...(processCleanupError
        ? [`Process cleanup: ${processCleanupError instanceof Error ? processCleanupError.message : String(processCleanupError)}`]
        : []),
      ...cleanupDiagnostics.map((diagnostic) => `Credential cleanup: ${diagnostic}`),
      ...(cleanupError
        ? [`Credential cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`]
        : []),
    ]
    if (providerError || processCleanupError || cleanupError) {
      throw new Error(redactSecrets(messages.join(' '), secrets))
    }
  }
  if (!providerResult) throw new Error('custom process did not return a result.')
  return cleanupDiagnostics.length > 0
    ? { ...providerResult, diagnostics: cleanupDiagnostics }
    : providerResult
}
