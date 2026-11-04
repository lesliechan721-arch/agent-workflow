import { spawn } from 'node:child_process'

const MAX_INPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const OPERATION_TIMEOUT_MS = 30_000
const MAX_DOTNET_TICKS = 3155378975999999999n

export interface WindowsNativeProcessRow {
  pid: number
  ppid: number
  pgid: null
  /** .NET UTC ticks at CIM microsecond precision. */
  started: string
}

export interface WindowsNativeOptions {
  helperPath?: string
  spawn?: typeof spawn
  /** A caller can reduce the fixed protocol deadline. */
  timeoutMs?: number
}

function validPid(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) && value <= 0xffffffff
}

function validTicks(value: unknown, cimPrecision = false): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= MAX_DOTNET_TICKS && (!cimPrecision || value.endsWith('0'))
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function invalidResponse(): Error {
  return new Error('Windows native helper returned an invalid response.')
}

async function runOperation(
  operation: 'processStart' | 'processTable',
  input: { pid: number } | { requiredPids: number[] },
  options: WindowsNativeOptions,
): Promise<unknown> {
  const request = Buffer.from(JSON.stringify({ schemaVersion: 1, operation, input }), 'utf8')
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS
  if (request.length > MAX_INPUT_BYTES || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 || timeoutMs > OPERATION_TIMEOUT_MS) {
    throw new Error('Invalid Windows native helper input.')
  }
  const helperPath = options.helperPath
  if (!helperPath) throw new Error('Windows native operation requires a prepared helper.')
  return new Promise((resolve, reject) => {
    let settled = false
    let outputBytes = 0
    const chunks: Buffer[] = []
    let child: ReturnType<typeof spawn>
    try {
      child = (options.spawn ?? spawn)(helperPath, ['--operation'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: process.env,
      })
    } catch {
      reject(new Error('Windows native helper could not start.'))
      return
    }
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        try { child.kill() } catch { /* The helper can exit before cancellation. */ }
        reject(error)
      } else {
        resolve(result)
      }
    }
    const timer = setTimeout(() => {
      finish(new Error('Windows native helper operation timed out.'))
    }, timeoutMs)
    child.on('error', () => finish(new Error('Windows native helper could not start.')))
    child.stdin!.on('error', () => finish(new Error('Windows native helper input failed.')))
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finish(new Error('Windows native helper output exceeded its limit.'))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0 || signal !== null) {
        finish(new Error('Windows native helper operation failed.'))
        return
      }
      try {
        const response: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.concat(chunks)))
        if (!hasKeys(response, ['schemaVersion', 'result']) || response.schemaVersion !== 1) {
          throw invalidResponse()
        }
        finish(undefined, response.result)
      } catch {
        finish(invalidResponse())
      }
    })
    try {
      child.stdin!.end(request)
    } catch {
      finish(new Error('Windows native helper input failed.'))
    }
  })
}

/** Full 100 ns identity for compatibility with existing CLI win32:<ticks> locks. */
export async function readWindowsNativeProcessStart(
  pid: number,
  options: WindowsNativeOptions = {},
): Promise<string | null> {
  if (!validPid(pid)) throw new Error('Invalid Windows process identifier.')
  const result = await runOperation('processStart', { pid }, options)
  if (result !== null && !validTicks(result)) throw invalidResponse()
  return result as string | null
}

/** Required live PIDs must be readable; only confirmed exits can be omitted. */
export async function readWindowsNativeProcessTable(
  requiredPids: readonly number[] = [],
  options: WindowsNativeOptions = {},
): Promise<WindowsNativeProcessRow[]> {
  if (!Array.isArray(requiredPids) || ![...requiredPids].every((pid) => validPid(pid))) {
    throw new Error('Invalid Windows process identifiers.')
  }
  const result = await runOperation('processTable', { requiredPids: [...new Set(requiredPids)] }, options)
  if (!Array.isArray(result)) throw invalidResponse()
  const seenPids = new Set<number>()
  for (const row of result) {
    if (!hasKeys(row, ['pid', 'ppid', 'pgid', 'started']) || !validPid(row.pid) ||
      !validPid(row.ppid, true) || row.pgid !== null || !validTicks(row.started, true) ||
      seenPids.has(row.pid)) throw invalidResponse()
    seenPids.add(row.pid)
  }
  return result as WindowsNativeProcessRow[]
}
