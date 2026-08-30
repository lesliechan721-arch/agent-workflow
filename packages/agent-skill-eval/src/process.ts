import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import {
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
const WINDOWS_HOOK_CONFIRMATION_TIMEOUT_MS = 150
const WINDOWS_CLEANUP_DEADLINE_MS = 750
const OBSERVED_HOOK_CONFIRMATION_TIMEOUT_MS = 4_000
const DIRECT_CHILD_CLOSE_TIMEOUT_MS = 750
const OBSERVED_CONTAINMENT_LIMITATION =
  'Observed process management is non-portable and does not guarantee descendant cleanup.'
const VERIFIED_OBSERVED_CONTAINMENT_LIMITATION =
  'Verified process observation is not OS-enforced containment and does not guarantee descendant cleanup.'

export interface ProviderProcessDependencies {
  containment?: 'managed' | 'verified-observed' | 'observed' | 'unmanaged-confirmed'
  processTree?: ProcessTreeDependencies
}

export class ProviderProcessCleanupError extends Error {
  constructor(message: string, cause: unknown, readonly result?: ProcessResult) {
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

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('terminateProcessTree hook timed out')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runProviderProcess(
  request: ProcessRequest,
  hooks: ProcessLifecycleHooks = {},
  dependencies: ProviderProcessDependencies = {},
): Promise<ProcessResult> {
  const platform = dependencies.processTree?.platform ?? process.platform
  const containment = dependencies.containment ?? 'managed'
  const descendantCleanupGuaranteed = containment === 'managed'
  const gradingEvidenceAccepted = descendantCleanupGuaranteed || containment === 'verified-observed'
  if (descendantCleanupGuaranteed) assertProviderProcessSupported(platform, hooks)
  if (containment === 'observed' && !hooks.terminateProcessTree) {
    throw new Error('Observed provider execution requires a process cleanup hook.')
  }
  const containmentLimitation = containment === 'observed'
    ? OBSERVED_CONTAINMENT_LIMITATION
    : containment === 'verified-observed'
      ? VERIFIED_OBSERVED_CONTAINMENT_LIMITATION
      : undefined
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
      gradingEvidenceAccepted,
      containmentMode: containment,
      ...(containmentLimitation ? { containmentLimitation } : {}),
    }
  }

  const marker = containment === 'unmanaged-confirmed' ? '' : randomUUID()
  const childEnvironment = { ...request.env }
  if (marker) childEnvironment[PROVIDER_PROCESS_MARKER_ENV] = marker
  else delete childEnvironment[PROVIDER_PROCESS_MARKER_ENV]

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: childEnvironment,
      shell: false,
      detached: platform !== 'win32',
      stdio: [request.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const handle = child.pid === undefined ? null : { pid: child.pid }
    const verifiedObservation: ProcessTreeObservation | undefined =
      containment === 'verified-observed' && handle
        ? observeProcessTree(handle.pid, marker, dependencies.processTree)
        : undefined
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let terminationReason: ProcessTerminationReason | null = null
    let settled = false
    let cleanupStarted: Promise<void> | null = null
    let cleanupFailure: unknown = null
    let timer: NodeJS.Timeout | null = null
    let cleanupCloseTimer: NodeJS.Timeout | null = null
    let stdoutTruncated = false
    let stderrTruncated = false

    const killDirectChild = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill('SIGKILL')
      } catch {
        // The direct child can exit between the status check and signal.
      }
    }

    const performCleanup = async (reason: ProcessTerminationReason): Promise<void> => {
      if (!handle) return
      if (containment === 'unmanaged-confirmed') {
        if (reason !== 'complete') killDirectChild()
        return
      }
      try {
        const timeoutMs = containment === 'observed' || containment === 'verified-observed'
          ? OBSERVED_HOOK_CONFIRMATION_TIMEOUT_MS
          : platform === 'win32'
            ? WINDOWS_HOOK_CONFIRMATION_TIMEOUT_MS
            : WINDOWS_CLEANUP_DEADLINE_MS
        const confirmation = await withDeadline(
          containment === 'verified-observed'
            ? terminateProcessTree(
                handle.pid,
                (signal) => {
                  try {
                    child.kill(signal)
                  } catch {
                    // The direct child can already be closed.
                  }
                },
                dependencies.processTree,
                { observation: verifiedObservation, requireConfirmedCleanup: true },
              ).then(() => ({ confirmed: true as const }))
            : hooks.terminateProcessTree!(handle, reason),
          timeoutMs,
        )
        if (confirmation?.confirmed !== true) {
          throw new Error('the external containment hook did not return confirmed cleanup evidence')
        }
      } catch (error) {
        killDirectChild()
        throw new ProviderProcessCleanupError(
          `Provider process tree cleanup could not be proven for pid ${handle.pid}: ${errorMessage(error, marker)}`,
          safeErrorCause(error, marker),
        )
      }
      if (reason !== 'complete') killDirectChild()
    }

    const startCleanup = (reason: ProcessTerminationReason): Promise<void> => {
      terminationReason ??= reason
      if (!cleanupStarted) {
        cleanupStarted = performCleanup(reason).then(undefined, (error: unknown) => {
          cleanupFailure = error
        })
        if (!settled) {
          const hookTimeoutMs = containment === 'observed' || containment === 'verified-observed'
            ? OBSERVED_HOOK_CONFIRMATION_TIMEOUT_MS
            : platform === 'win32'
              ? WINDOWS_HOOK_CONFIRMATION_TIMEOUT_MS
              : WINDOWS_CLEANUP_DEADLINE_MS
          cleanupCloseTimer = setTimeout(() => {
            if (settled) return
            killDirectChild()
            settled = true
            clearObservation()
            reject(cleanupFailure ?? new ProviderProcessCleanupError(
              `Provider direct child termination could not be confirmed for pid ${handle?.pid ?? 'unknown'}.`,
              new Error('direct child close event timed out'),
            ))
          }, hookTimeoutMs + DIRECT_CHILD_CLOSE_TIMEOUT_MS)
        }
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
      if (cleanupCloseTimer) clearTimeout(cleanupCloseTimer)
      request.signal?.removeEventListener('abort', abort)
    }
    const output = (buffer: Buffer, truncated: boolean): string =>
      scrubProcessMarker(buffer.toString('utf8'), marker, truncated)

    child.stdout!.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr!.on('data', (chunk: Buffer) => append('stderr', chunk))
    if (request.stdin !== undefined) {
      child.stdin?.on('error', () => {
        // Process exit remains authoritative for a closed stdin pipe.
      })
      child.stdin?.end(request.stdin)
    }

    let spawnHookError: unknown = null
    let spawnError: unknown = null
    let spawnReady = Promise.resolve()
    child.once('error', (error) => {
      spawnError = error
      stderr = Buffer.concat([stderr, Buffer.from(errorMessage(error, marker))])
      if (handle) void startCleanup('abort')
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
        const result: ProcessResult = {
          stdout: output(stdout, stdoutTruncated),
          stderr: output(stderr, stderrTruncated),
          exitCode: spawnError ? null : exitCode,
          signal: spawnError ? null : signal,
          timedOut: terminationReason === 'timeout',
          cancelled: terminationReason === 'abort',
          terminationReason: spawnError && !handle ? null : terminationReason,
          maxBufferExceeded: terminationReason === 'max-buffer',
          stdoutTruncated,
          stderrTruncated,
          descendantCleanupGuaranteed,
          gradingEvidenceAccepted,
          containmentMode: containment,
          ...(containmentLimitation ? { containmentLimitation } : {}),
        }
        if (cleanupFailure) {
          throw new ProviderProcessCleanupError(
            errorMessage(cleanupFailure, marker),
            safeErrorCause(cleanupFailure, marker),
            {
              ...result,
              stderr: `${result.stderr}${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}${errorMessage(cleanupFailure, marker)}\n`,
              descendantCleanupGuaranteed: false,
              gradingEvidenceAccepted: false,
            },
          )
        }
        if (spawnHookError) {
          throw safeErrorCause(spawnHookError, marker)
        }
        resolve(result)
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
  if (
    hooks.externalContainment?.confirmed !== true ||
    hooks.externalContainment.descendantCleanupGuaranteed !== true ||
    hooks.externalContainment.readOnlySkillSnapshotGuaranteed !== true ||
    !hooks.terminateProcessTree
  ) {
    throw new Error(
      `Managed provider execution on ${platform} requires an explicitly confirmed external containment hook that guarantees read-only Skill snapshots and descendant cleanup.`,
    )
  }
}
