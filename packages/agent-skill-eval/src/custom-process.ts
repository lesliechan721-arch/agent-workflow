import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { observeProcessTree, terminateProcessTree, type ProcessTreeDependencies } from './process-tree.js'
import { runProviderProcess } from './process.js'
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

function credentialValues(sourceEnv: NodeJS.ProcessEnv): string[] {
  return [...new Set(CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST.flatMap((name) => {
    const value = sourceEnv[name]
    return value ? [value] : []
  }))].sort((left, right) => right.length - left.length)
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => current.replaceAll(secret, '[redacted]'), value)
}

function secretVariants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((secret) => {
    const encoded = JSON.stringify(secret).slice(1, -1)
    return encoded === secret ? [secret] : [secret, encoded]
  }))].sort((left, right) => right.length - left.length)
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
      chunks.push(result.subarray(offset, match), Buffer.from('[redacted]'))
      offset = match + secret.length
      match = result.indexOf(secret, offset)
    }
    chunks.push(result.subarray(offset))
    result = Buffer.concat(chunks)
  }
  return result
}

async function redactOutputTree(root: string, secrets: readonly string[]): Promise<void> {
  if (secrets.length === 0) return
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    const info = await lstat(target)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      await redactOutputTree(target, secrets)
      continue
    }
    if (!info.isFile()) continue
    const content = await readFile(target)
    const redacted = redactBuffer(content, secrets)
    if (!redacted.equals(content)) await writeFile(target, redacted)
  }
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
  return {
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
  }
}

export interface CustomProcessExecutorOptions {
  command: readonly [string, ...string[]]
  evalRoot: string
  input: EvalProviderRunInput
  sourceEnv?: NodeJS.ProcessEnv
  maxBufferBytes?: number
  processTree?: ProcessTreeDependencies
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
  const secrets = credentialValues(sourceEnv)
  const stdin = JSON.stringify(input)
  if (secrets.some((secret) => stdin.includes(secret))) {
    throw new Error('custom process input contains an allowlisted credential value.')
  }
  const env = cleanEnvironment(sourceEnv, evalRoot)
  await Promise.all([
    mkdir(env.HOME!, { recursive: true, mode: 0o700 }),
    mkdir(env.TMPDIR!, { recursive: true, mode: 0o700 }),
  ])
  let observation: ReturnType<typeof observeProcessTree> | undefined
  let result: Awaited<ReturnType<typeof runProviderProcess>>
  try {
    result = await runProviderProcess({
      executable: options.command[0],
      args: [...options.command.slice(1)],
      cwd: evalRoot,
      env,
      stdin,
      timeoutMs: options.input.timeoutMs,
      maxBufferBytes: options.maxBufferBytes ?? 4 * 1024 * 1024,
      ...(options.input.signal ? { signal: options.input.signal } : {}),
    }, {
      onSpawn: ({ pid }) => {
        observation = observeProcessTree(pid, undefined, options.processTree)
      },
      terminateProcessTree: async ({ pid }, reason) => {
        await terminateProcessTree(
          pid,
          (signal) => {
            try {
              if ((options.processTree?.platform ?? process.platform) === 'win32') {
                process.kill(pid, signal)
              } else {
                process.kill(-pid, signal)
              }
            } catch {
              // The direct child or process group can already be closed.
            }
          },
          options.processTree,
          {
            observation,
            requireConfirmedCleanup: reason !== 'complete',
            allowInspectionUnavailable: reason === 'complete',
          },
        )
        return { confirmed: true }
      },
    }, {
      containment: 'observed',
      processTree: options.processTree,
    })
  } finally {
    await redactOutputTree(options.input.outputDir, secrets)
  }
  if (result.timedOut) throw new Error(`custom process timed out after ${options.input.timeoutMs}ms.`)
  if (result.cancelled) throw new Error('custom process was aborted.')
  if (result.maxBufferExceeded) throw new Error('custom process output exceeded the buffer limit.')
  if (result.exitCode !== 0) {
    const stderr = redact(result.stderr.trim(), secrets)
    throw new Error(
      `custom process failed with exit code ${String(result.exitCode)}${stderr ? `: ${stderr}` : '.'}`,
    )
  }
  if (secrets.some((secret) => result.stdout.includes(secret))) {
    throw new Error('custom process stdout contains an allowlisted credential value.')
  }
  const parsed = parseCustomProcessOutput(redact(result.stdout, secrets))
  return { usage: parsed.usage, grade: parsed.grade }
}
