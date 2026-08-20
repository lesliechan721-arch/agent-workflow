import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import {
  assertProcessTreeInspectionAvailable,
  observeProcessTree,
  terminateProcessTree,
  type ProcessTreeDependencies,
  type ProcessTreeObservation,
} from './process-tree.js'
import type {
  ProcessLifecycleHooks,
  ProcessRequest,
  ProcessResult,
  ProcessTerminationReason,
} from './types.js'

const PROVIDER_PROCESS_MARKER_ENV = 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER'
const REDACTED_PROCESS_MARKER = '[redacted provider process marker]'

export interface ProviderProcessDependencies {
  containment?: 'managed' | 'unmanaged-confirmed'
  processTree?: ProcessTreeDependencies
}

export class ProviderProcessCleanupError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'ProviderProcessCleanupError'
  }
}

function scrubProcessMarker(value: string, marker: string, truncated: boolean = false): string {
  if (marker === '') return value
  const scrubbed = value.replaceAll(marker, REDACTED_PROCESS_MARKER)
  if (
    truncated &&
    scrubbed.length > 0 &&
    scrubbed.length < marker.length &&
    marker.startsWith(scrubbed)
  ) {
    return REDACTED_PROCESS_MARKER
  }
  if (!truncated) return scrubbed
  for (let length = marker.length - 1; length >= 8; length -= 1) {
    if (scrubbed.endsWith(marker.slice(0, length))) {
      return `${scrubbed.slice(0, -length)}${REDACTED_PROCESS_MARKER}`
    }
  }
  return scrubbed
}

function errorMessage(error: unknown, marker: string): string {
  return scrubProcessMarker(error instanceof Error ? error.message : String(error), marker)
}

function safeErrorCause(error: unknown, marker: string): Error {
  return new Error(errorMessage(error, marker))
}

export async function runProviderProcess(
  request: ProcessRequest,
  hooks: ProcessLifecycleHooks = {},
  dependencies: ProviderProcessDependencies = {},
): Promise<ProcessResult> {
  const platform = dependencies.processTree?.platform ?? process.platform
  const containment = dependencies.containment ?? 'managed'
  const descendantCleanupGuaranteed = containment === 'managed'
  if (descendantCleanupGuaranteed) assertProviderProcessSupported(platform, hooks)
  if (request.signal?.aborted) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      terminationReason: 'abort',
      maxBufferExceeded: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      descendantCleanupGuaranteed,
    }
  }

  const marker = descendantCleanupGuaranteed ? randomUUID() : ''
  const processTreeDependencies: ProcessTreeDependencies = {
    ...dependencies.processTree,
    platform,
    markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
  }
  if (descendantCleanupGuaranteed && platform !== 'win32') {
    await assertProcessTreeInspectionAvailable(processTreeDependencies)
  }
  const childEnvironment = { ...request.env }
  if (descendantCleanupGuaranteed) childEnvironment[PROVIDER_PROCESS_MARKER_ENV] = marker
  else delete childEnvironment[PROVIDER_PROCESS_MARKER_ENV]

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: childEnvironment,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const handle = child.pid === undefined ? null : { pid: child.pid }
    const observation: ProcessTreeObservation | undefined =
      descendantCleanupGuaranteed && platform !== 'win32' && handle
        ? observeProcessTree(handle.pid, marker, processTreeDependencies)
        : undefined
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let terminationReason: ProcessTerminationReason | null = null
    let settled = false
    let cleanupStarted: Promise<void> | null = null
    let cleanupFailure: unknown = null
    let timer: NodeJS.Timeout | null = null
    let stdoutTruncated = false
    let stderrTruncated = false

    const performCleanup = async (reason: ProcessTerminationReason): Promise<void> => {
      if (!handle) return
      if (!descendantCleanupGuaranteed) {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          child.kill('SIGTERM')
        } catch {
          return
        }
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (child.exitCode !== null || child.signalCode !== null) return
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // The direct child can exit between the status check and signal.
        }
        return
      }
      let hookFailure: unknown = null
      let hookConfirmed = false
      if (hooks.terminateProcessTree) {
        try {
          const confirmation = await hooks.terminateProcessTree(handle, reason)
          hookConfirmed = confirmation?.confirmed === true
        } catch (error) {
          hookFailure = error
        }
      }

      if (platform === 'win32') {
        if (hookFailure) {
          throw new ProviderProcessCleanupError(
            `Provider process tree cleanup could not be proven for pid ${handle.pid}: ${errorMessage(hookFailure, marker)}`,
            safeErrorCause(hookFailure, marker),
          )
        }
        if (!hookConfirmed) {
          throw new ProviderProcessCleanupError(
            `Provider process tree cleanup could not be proven for pid ${handle.pid}: ` +
              'the Windows terminateProcessTree hook did not return confirmed evidence.',
            undefined,
          )
        }
        return
      }

      try {
        await terminateProcessTree(
          handle.pid,
          (signal) => { child.kill(signal) },
          processTreeDependencies,
          { observation, requireConfirmedCleanup: true },
        )
      } catch (error) {
        throw new ProviderProcessCleanupError(
          `Provider process tree cleanup could not be proven for pid ${handle.pid}: ${errorMessage(error, marker)}`,
          safeErrorCause(error, marker),
        )
      }
      if (hookFailure) {
        throw new ProviderProcessCleanupError(
          `Provider process tree cleanup could not be proven for pid ${handle.pid}: ${errorMessage(hookFailure, marker)}`,
          safeErrorCause(hookFailure, marker),
        )
      }
    }

    const startCleanup = (reason: ProcessTerminationReason): Promise<void> => {
      terminationReason ??= reason
      if (!cleanupStarted) {
        cleanupStarted = performCleanup(reason).then(undefined, (error: unknown) => {
          cleanupFailure = error
        })
      }
      return cleanupStarted
    }
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const current = target === 'stdout' ? stdout : stderr
      const next = Buffer.concat([current, chunk])
      if (next.length > request.maxBufferBytes) {
        if (target === 'stdout') {
          stdout = next.subarray(0, request.maxBufferBytes)
          stdoutTruncated = true
        } else {
          stderr = next.subarray(0, request.maxBufferBytes)
          stderrTruncated = true
        }
        void startCleanup('max-buffer')
      } else if (target === 'stdout') stdout = next
      else stderr = next
    }
    const abort = (): void => { void startCleanup('abort') }
    const clearObservation = (): void => {
      if (timer) clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
    }
    const output = (buffer: Buffer, truncated: boolean): string =>
      scrubProcessMarker(buffer.toString('utf8'), marker, truncated)

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))

    let spawnHookError: unknown = null
    let spawnReady = Promise.resolve()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearObservation()
      stderr = Buffer.concat([stderr, Buffer.from(errorMessage(error, marker))])
      void (async () => {
        if (handle) await startCleanup('abort')
        else observation?.dispose()
        if (cleanupFailure) throw cleanupFailure
        resolve({
          stdout: output(stdout, stdoutTruncated),
          stderr: output(stderr, stderrTruncated),
          exitCode: null,
          signal: null,
          timedOut: false,
          cancelled: false,
          terminationReason: handle ? 'abort' : null,
          maxBufferExceeded: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          descendantCleanupGuaranteed,
        })
      })().catch(reject)
    })
    child.once('exit', () => {
      // Close remains authoritative because it follows stdio capture.
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearObservation()
      void (async () => {
        await spawnReady
        await (cleanupStarted ?? startCleanup('complete'))
        if (cleanupFailure) throw cleanupFailure
        if (spawnHookError) {
          throw safeErrorCause(spawnHookError, marker)
        }
        resolve({
          stdout: output(stdout, stdoutTruncated),
          stderr: output(stderr, stderrTruncated),
          exitCode,
          signal,
          timedOut: terminationReason === 'timeout',
          cancelled: terminationReason === 'abort',
          terminationReason,
          maxBufferExceeded: terminationReason === 'max-buffer',
          stdoutTruncated,
          stderrTruncated,
          descendantCleanupGuaranteed,
        })
      })().catch(reject)
    })

    if (!handle) return
    request.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { void startCleanup('timeout') }, request.timeoutMs)
    if (request.signal?.aborted) abort()
    spawnReady = Promise.resolve().then(() => hooks.onSpawn?.(handle)).catch(async (error: unknown) => {
      spawnHookError = error
      await startCleanup('abort')
    })
  })
}

export function assertProviderProcessSupported(
  platform: NodeJS.Platform,
  hooks: ProcessLifecycleHooks = {},
): void {
  if (platform === 'win32' && !hooks.terminateProcessTree) {
    throw new Error(
      'Default provider execution on Windows requires a terminateProcessTree hook that returns confirmed descendant-cleanup evidence; the shared monitor cannot independently verify Windows Job Object membership.',
    )
  }
}
