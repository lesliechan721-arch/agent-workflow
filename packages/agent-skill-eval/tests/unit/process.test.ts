import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { candidateProcessRunner } from '../../../../scripts/qualification/windows-job-containment.mjs'
import { ProcessTreeTimeoutError } from '../../../../scripts/perf/process-tree.mjs'
import {
  assertProcessTreeInspectionAvailable,
  observeProcessTree,
  ProviderProcessCleanupError,
  runProviderProcess,
  terminateProcessTree,
  type ProcessLifecycleHooks,
} from '../../src/index.js'

const PROVIDER_PROCESS_MARKER_ENV = 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER'
const syntheticProcessPath = fileURLToPath(
  new URL('../../../../scripts/test/synthetic-process.mjs', import.meta.url),
)

function baseRequest(root: string) {
  return {
    executable: process.execPath,
    args: [] as string[],
    cwd: root,
    env: { ...process.env },
    timeoutMs: 2_000,
    maxBufferBytes: 1024,
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcess(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The process is already closed.
  }
}

async function expectProcessDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(processIsAlive(pid)).toBe(false)
}

const externalContainment = {
  confirmed: true,
  descendantCleanupGuaranteed: true,
  readOnlySkillSnapshotGuaranteed: true,
} as const

function managedHooks(overrides: ProcessLifecycleHooks = {}): ProcessLifecycleHooks {
  return {
    externalContainment,
    terminateProcessTree: async () => ({ confirmed: true }),
    ...overrides,
  }
}

async function waitForPid(pidPath: string): Promise<number> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(pidPath, 'utf8'), 10)
      if (pid > 0) return pid
    } catch {
      // The provider can still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('provider did not record its detached descendant PID')
}

function renderMarkerScan(
  processes: Iterable<readonly [number, {
    ppid: number
    pgid?: number
    state: string
    startTime: string
    marked?: boolean
  }]>,
  marker: string,
  isMarked: (pid: number, entry: { marked?: boolean }) => boolean =
    (_pid, entry) => entry.marked !== false,
): string {
  return [...processes].map(([pid, entry]) => [
    pid,
    entry.ppid,
    entry.pgid ?? 100,
    entry.state,
    entry.startTime,
    'node',
    ...(isMarked(pid, entry) ? [`${PROVIDER_PROCESS_MARKER_ENV}=${marker}`] : []),
  ].join(' ')).join('\n')
}

describe('managed provider containment gate', () => {
  it.each(['timeout', 'abort'] as const)('admits candidate Windows %s qualification through the real provider runner', async (mode) => {
    const controller = new AbortController()
    const abortReason = new Error('qualification abort fixture')
    let started = false
    let helperInvocations = 0
    const run = candidateProcessRunner({
      helperPath: process.execPath,
      runProviderProcess: (
        request: Parameters<typeof runProviderProcess>[0],
        hooks: Parameters<typeof runProviderProcess>[1],
        dependencies: NonNullable<Parameters<typeof runProviderProcess>[2]>,
      ) => runProviderProcess(request, { ...hooks, onSpawn: () => { started = true } }, {
        ...dependencies,
        processTree: { platform: 'win32' },
        createWindowsJobInvocation(executable, args) {
          helperInvocations += 1
          const invocation = dependencies.createWindowsJobInvocation!(executable, args)
          // Substitute only the native helper. The real runner still enforces admission and termination.
          return { ...invocation, command: executable, args: [...args] as ['--config', string] }
        },
      }),
    })
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(abortReason), 100) : undefined
    try {
      const outcome = run({
        label: 'candidate admission fixture',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: mode === 'timeout' ? 100 : 3_000,
        ...(mode === 'abort' ? { signal: controller.signal } : {}),
      })
      if (mode === 'timeout') await expect(outcome).rejects.toBeInstanceOf(ProcessTreeTimeoutError)
      else await expect(outcome).rejects.toBe(abortReason)
      expect(started).toBe(true)
      expect(helperInvocations).toBe(1)
    } finally {
      if (timer) clearTimeout(timer)
    }
  })

  it('routes a Windows provider through the Job helper before spawn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-windows-job-'))
    const createWindowsJobInvocation = vi.fn(() => ({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("job-helper")'] as ['--config', string],
      config: {
        schemaVersion: 1 as const,
        executable: 'provider.exe',
        args: ['--flag'],
        parentPid: 42,
      },
    }))
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        executable: 'provider.exe',
        args: ['--flag'],
      }, {}, {
        containment: 'unmanaged-confirmed',
        processTree: { platform: 'win32' },
        createWindowsJobInvocation,
      })

      expect(createWindowsJobInvocation).toHaveBeenCalledWith('provider.exe', ['--flag'])
      expect(result).toMatchObject({
        stdout: 'job-helper',
        exitCode: 0,
        descendantCleanupGuaranteed: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed before spawn without confirmed external containment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-contained-'))
    const startedPath = path.join(root, 'started')
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'yes')`],
      })).rejects.toThrow('requires an explicitly confirmed external containment hook')
      await expect(stat(startedPath)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a caller-confirmed external containment contract', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-contained-'))
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', 'process.stdout.write("ok")'],
      }, managedHooks())
      expect(result).toMatchObject({
        stdout: 'ok',
        exitCode: 0,
        descendantCleanupGuaranteed: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('shared provider process behavior', () => {
  it('shares layered POSIX scans across observers and stops with no subscribers', async () => {
    vi.useFakeTimers()
    try {
      let identityScans = 0
      let markerScans = 0
      const execFile = (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => {
        if (args.some((arg) => arg.includes('command='))) {
          markerScans += 1
          callback(null, [
            `100 1 100 S first-start node ${PROVIDER_PROCESS_MARKER_ENV}=first`,
            `200 1 200 S second-start node ${PROVIDER_PROCESS_MARKER_ENV}=second`,
          ].join('\n'))
          return
        }
        identityScans += 1
        callback(null, [
          '100 1 100 S first-start',
          '200 1 200 S second-start',
        ].join('\n'))
      }
      const dependencies = {
        platform: 'linux' as const,
        markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
        enforceCooperativeProcessGroup: true,
        execFile,
      }
      const first = observeProcessTree(100, 'first', dependencies)
      const second = observeProcessTree(200, 'second', dependencies)
      await Promise.resolve()
      await Promise.resolve()

      expect(identityScans).toBe(1)
      expect(markerScans).toBe(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(identityScans).toBe(4)
      expect(markerScans).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(identityScans).toBe(5)
      expect(markerScans).toBe(2)

      first.dispose()
      second.dispose()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(identityScans).toBe(5)
      expect(markerScans).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not throttle or periodically scan sequential general observers', async () => {
    vi.useFakeTimers()
    try {
      let markerScans = 0
      const execFile = (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => {
        if (args.some((arg) => arg.includes('command='))) {
          markerScans += 1
          callback(null, [
            `100 1 100 S first-start node ${PROVIDER_PROCESS_MARKER_ENV}=first`,
            `200 1 200 S second-start node ${PROVIDER_PROCESS_MARKER_ENV}=second`,
          ].join('\n'))
          return
        }
        callback(null, '')
      }

      const first = observeProcessTree(100, 'first', { platform: 'linux', execFile })
      await vi.advanceTimersByTimeAsync(0)
      expect(markerScans).toBe(1)
      first.dispose()
      vi.setSystemTime(100)
      const second = observeProcessTree(200, 'second', { platform: 'linux', execFile })
      await vi.advanceTimersByTimeAsync(0)

      expect(markerScans).toBe(2)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(markerScans).toBe(2)
      expect(vi.getTimerCount()).toBe(0)
      second.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not signal a reused PID or process group from interleaved scan generations', async () => {
    vi.useFakeTimers()
    try {
      type ScanCallback = (error: Error | null, stdout: string) => void
      let identityCallback: ScanCallback | undefined
      let markerCallback: ScanCallback | undefined
      let cleanup = false
      const execFile = (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: ScanCallback,
      ): void => {
        if (!cleanup) {
          if (args.some((arg) => arg.includes('command='))) markerCallback = callback
          else identityCallback = callback
          return
        }
        callback(null, args.some((arg) => arg.includes('command='))
          ? [
              '100 1 100 S foreign-root-start node',
              '101 100 100 S foreign-child-start node',
            ].join('\n')
          : [
              '100 1 100 S foreign-root-start',
              '101 100 100 S foreign-child-start',
            ].join('\n'))
      }
      const kill = vi.fn()
      const dependencies = {
        platform: 'linux' as const,
        markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
        enforceCooperativeProcessGroup: true,
        execFile,
        kill,
      }
      const observation = observeProcessTree(100, 'tree', dependencies)
      markerCallback!(null, [
        `100 1 100 S root-start node ${PROVIDER_PROCESS_MARKER_ENV}=tree`,
        `101 100 100 S old-start node ${PROVIDER_PROCESS_MARKER_ENV}=tree`,
      ].join('\n'))
      identityCallback!(null, [
        '100 1 100 S foreign-root-start',
        '101 100 100 S foreign-child-start',
      ].join('\n'))
      await Promise.resolve()
      await Promise.resolve()
      cleanup = true

      const termination = terminateProcessTree(
        100,
        vi.fn(),
        dependencies,
        { observation, requireConfirmedCleanup: true },
      )
      await vi.runAllTimersAsync()
      await expect(termination).resolves.toBeUndefined()

      expect(kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient POSIX marker lookup inside the original deadline', async () => {
    let marker = ''
    let markerLookups = 0
    await expect(assertProcessTreeInspectionAvailable({
      platform: 'linux',
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      createSentinel: async (_markerEnvironmentVariable, value) => {
        marker = value
        return { pid: 900_011, stop: async () => undefined }
      },
      execFile: (_command, args, _options, callback) => {
        if (!args.some((arg) => arg.includes('command='))) {
          callback(null, '900011 1 900011 S Mon Aug 24 12:00:00 2026')
          return
        }
        markerLookups += 1
        callback(
          markerLookups === 1 ? Object.assign(new Error('transient'), { code: 'EAGAIN' }) : null,
          markerLookups === 1
            ? ''
            : `900011 1 900011 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`,
        )
      },
    })).resolves.toBeUndefined()
    expect(markerLookups).toBe(2)
  })

  it('accepts an atomic marker row in the macOS ps format', async () => {
    let marker = ''
    let stopped = false
    const execFile = vi.fn((_command, args, _options, callback) => {
      if (args.some((arg: string) => arg.includes('command='))) {
        expect(args).toEqual([
          'eww',
          '-A',
          '-o',
          'pid=,ppid=,pgid=,state=,lstart=,command=',
        ])
        callback(
          null,
          `900012 1 900012 R    Fri Sep  4 21:06:32 2026     /usr/local/bin/node -e setInterval AW_AGENT_SKILL_EVAL_PROCESS_MARKER=${marker}`,
        )
        return
      }
      callback(null, '900012 1 900012 R Fri Sep  4 21:06:32 2026')
    })

    await expect(assertProcessTreeInspectionAvailable({
      platform: 'darwin',
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      createSentinel: async (_markerEnvironmentVariable, value) => {
        marker = value
        return {
          pid: 900_012,
          stop: async () => { stopped = true },
        }
      },
      execFile,
    })).resolves.toBeUndefined()

    expect(stopped).toBe(true)
  })

  it('keeps the provider exit and stderr when inspection lease release fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-release-'))
    let marker = ''
    try {
      let error: unknown
      try {
        await runProviderProcess({
          ...baseRequest(root),
          args: ['-e', 'process.stderr.write("provider stderr"); process.exitCode = 7'],
        }, {}, {
          containment: 'verified-observed',
          processTree: {
            platform: 'linux',
            createSentinel: async (_markerEnvironmentVariable, value) => {
              marker = value
              return {
                pid: 900_010,
                stop: async () => { throw new Error('inspection release failed') },
              }
            },
            execFile: (_command, args, _options, callback) => callback(
              null,
              args.some((arg) => arg.includes('command='))
                ? `900010 1 900010 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`
                : '900010 1 900010 S Mon Aug 24 12:00:00 2026',
            ),
          },
        })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({
        name: 'ProviderProcessCleanupError',
        message: expect.stringContaining('inspection lease release failed'),
        result: {
          exitCode: 7,
          stderr: 'provider stderr',
          timedOut: false,
          cancelled: false,
          gradingEvidenceAccepted: false,
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not signal identities after the final POSIX marker audit fails', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'descendant-start' }],
    ])
    const renderTable = () => [...processes].map(([pid, entry]) =>
      `${pid} ${entry.ppid} 100 ${entry.state} ${entry.startTime}`
    ).join('\n')
    let markerLookup = 0
    const execFile = (
      _command: string,
      args: string[],
      _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
      callback: (error: Error | null, stdout: string) => void,
    ): void => {
      if (args.some((arg) => arg.includes('command='))) {
        markerLookup += 1
        const failed = markerLookup === 3 || markerLookup === 4
        callback(
          failed
            ? Object.assign(new Error(`marker refresh failed ${marker}`), {
                code: 'ETIMEDOUT',
                signal: 'SIGTERM',
                killed: true,
              })
            : null,
          failed
            ? ''
            : renderMarkerScan(processes, marker),
        )
        return
      }
      callback(null, renderTable())
    }
    const kill = (pid: number, signal: string): void => {
      const entry = processes.get(pid)
      if (entry && signal === 'SIGTERM') processes.set(pid, { ...entry, state: 'T' })
      if (signal === 'SIGKILL') processes.delete(pid)
    }
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile,
      kill,
    }
    const observation = observeProcessTree(100, marker, dependencies)

    let error: unknown
    try {
      await terminateProcessTree(
        100,
        () => undefined,
        dependencies,
        { observation },
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      'POSIX process marker lookup failed (stage=termination-kill, attempts=1, reason=callback-error, code=ETIMEDOUT, signal=SIGTERM, killed=true)',
    )
    expect((error as Error).message).not.toContain(marker)

    expect(processes.has(101)).toBe(true)
  })

  it('uses a verified ordinary-child process group fallback and preserves a foreign process', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [100, { ppid: 1, pgid: 100, state: 'S', startTime: 'root-start', marked: true }],
      [101, { ppid: 100, pgid: 100, state: 'S', startTime: 'child-start', marked: true }],
      [200, { ppid: 1, pgid: 200, state: 'S', startTime: 'foreign-start', marked: false }],
    ])
    const signals: Array<[number, string]> = []
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, args.some((arg) => arg.includes('command='))
        ? renderMarkerScan(processes, marker)
        : [...processes]
            .map(([pid, entry]) =>
              `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}`)
            .join('\n')),
      kill: (pid: number, signal: string): void => {
        signals.push([pid, signal])
        if (pid === -100 && signal === 'SIGTERM') {
          for (const [candidatePid, entry] of processes) {
            if (entry.pgid === 100) processes.set(candidatePid, { ...entry, state: 'T' })
          }
        }
        if (pid === -100 && signal === 'SIGKILL') {
          for (const [candidatePid, entry] of processes) {
            if (entry.pgid === 100) processes.delete(candidatePid)
          }
        }
        if (pid > 0 && signal === 'SIGKILL') processes.delete(pid)
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)

    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      { observation, requireConfirmedCleanup: true },
    )).resolves.toBeUndefined()

    expect(signals).toContainEqual([-100, 'SIGKILL'])
    expect(processes.has(200)).toBe(true)
  })

  it('rejects completion with a live marked child after cleaning it and preserving foreign state', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [101, { ppid: 1, pgid: 100, state: 'S', startTime: 'child-start', marked: true }],
      [200, { ppid: 1, pgid: 200, state: 'S', startTime: 'foreign-start', marked: false }],
    ])
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, args.some((arg) => arg.includes('command='))
        ? renderMarkerScan(processes, marker)
        : [...processes]
            .map(([pid, entry]) =>
              `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}`)
            .join('\n')),
      kill: (pid: number, signal: string): void => {
        const entry = processes.get(pid)
        if (entry && signal === 'SIGTERM') processes.set(pid, { ...entry, state: 'T' })
        if (pid > 0 && signal === 'SIGKILL') processes.delete(pid)
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)

    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      {
        observation,
        requireConfirmedCleanup: true,
        requireDescendantsExitedBeforeCompletion: true,
      },
    )).rejects.toThrow('all provider descendants must exit before completion')

    expect(processes.has(101)).toBe(false)
    expect(processes.has(200)).toBe(true)
  })

  it('does not treat the provider root or a zombie child as a live completion descendant', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [100, { ppid: 1, pgid: 100, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, pgid: 100, state: 'Z', startTime: 'child-start' }],
    ])
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, args.some((arg) => arg.includes('command='))
        ? renderMarkerScan(processes, marker)
        : [...processes]
            .map(([pid, entry]) =>
              `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}`)
            .join('\n')),
      kill: (pid: number, signal: string): void => {
        const entry = processes.get(pid)
        if (entry && signal === 'SIGTERM') processes.set(pid, { ...entry, state: 'T' })
        if (pid > 0 && signal === 'SIGKILL') processes.delete(pid)
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)

    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      {
        observation,
        requireConfirmedCleanup: true,
        requireDescendantsExitedBeforeCompletion: true,
      },
    )).resolves.toBeUndefined()
  })

  it('rejects but does not signal a shared process group owned by the parent runner', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [50, { ppid: 1, pgid: 50, state: 'S', startTime: 'runner-start', marked: false }],
      [100, { ppid: 50, pgid: 50, state: 'S', startTime: 'root-start', marked: true }],
      [101, { ppid: 100, pgid: 50, state: 'S', startTime: 'child-start', marked: true }],
      [200, { ppid: 50, pgid: 50, state: 'S', startTime: 'sibling-start', marked: false }],
    ])
    const signals: Array<[number, string]> = []
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, args.some((arg) => arg.includes('command='))
        ? renderMarkerScan(processes, marker)
        : [...processes]
            .map(([pid, entry]) =>
              `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}`)
            .join('\n')),
      kill: (pid: number, signal: string): void => {
        signals.push([pid, signal])
        const entry = processes.get(pid)
        if (entry && signal === 'SIGTERM') processes.set(pid, { ...entry, state: 'T' })
        if (pid > 0 && signal === 'SIGKILL') processes.delete(pid)
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)

    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      { observation, requireConfirmedCleanup: true },
    )).rejects.toThrow('provider root left its initial process group')

    expect(signals.some(([pid]) => pid < 0)).toBe(false)
    expect(signals.some(([pid]) => pid === 50 || pid === 200)).toBe(false)
    expect(processes.has(50)).toBe(true)
    expect(processes.has(200)).toBe(true)
  })

  it('rejects a marked child group change when the root exits before the first snapshot', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [101, { ppid: 1, pgid: 101, state: 'S', startTime: 'child-start', marked: true }],
      [200, { ppid: 1, pgid: 200, state: 'S', startTime: 'foreign-start', marked: false }],
    ])
    const signals: Array<[number, string]> = []
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, args.some((arg) => arg.includes('command='))
        ? renderMarkerScan(processes, marker)
        : [...processes]
            .map(([pid, entry]) =>
              `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}`)
            .join('\n')),
      kill: (pid: number, signal: string): void => {
        signals.push([pid, signal])
        const entry = processes.get(pid)
        if (entry && signal === 'SIGTERM') processes.set(pid, { ...entry, state: 'T' })
        if (pid > 0 && signal === 'SIGKILL') processes.delete(pid)
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)

    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      { observation, requireConfirmedCleanup: true },
    )).rejects.toThrow('left its initial process group')

    expect(signals.some(([pid]) => pid < 0)).toBe(false)
    expect(processes.has(101)).toBe(false)
    expect(processes.has(200)).toBe(true)
  })

  it.each([
    { outcome: 'exited', known: false },
    { outcome: 'exited', known: true },
    { outcome: 'zombie', known: false },
    { outcome: 'marked', known: false },
    { outcome: 'reused', known: true },
    { outcome: 'unmarked', known: false, failure: 'lost its process marker' },
    { outcome: 'unreadable', known: false, failure: 'process marker could not be read' },
    { outcome: 'scan-error', known: false, failure: 'marker lookup failed' },
    { outcome: 'exited', known: false, duringCleanup: true },
    { outcome: 'unreadable', known: false, duringCleanup: true, failure: 'process marker could not be read' },
  ])('confirms unreadable ps data: $outcome (known=$known, cleanup=$duringCleanup)', async ({ outcome, known, failure, duringCleanup }) => {
    vi.useFakeTimers()
    const marker = 'marker-value'
    const processes = new Map([
      [100, { ppid: 1, pgid: 100, state: 'S', startTime: 'root-start', command: `node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}` }],
      [200, { ppid: 1, pgid: 200, state: 'R', startTime: 'foreign-start', command: '(foreign)' }],
    ])
    const child = { ppid: 100, pgid: 100, state: 'R', startTime: 'child-start', command: `git ${PROVIDER_PROCESS_MARKER_ENV}=${marker}` }
    if (known) processes.set(101, { ...child })
    let phase: 'normal' | 'unreadable' | 'confirmation' = 'normal'
    let confirmed = false
    const signals: number[] = []
    const dependencies = {
      platform: 'darwin' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceProcessMarker: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => {
        const markerScan = args.some((arg) => arg.includes('command='))
        if (markerScan && phase === 'unreadable') {
          processes.set(101, { ...child, command: '(git)' })
          phase = 'confirmation'
        } else if (markerScan && phase === 'confirmation') {
          confirmed = true
          if (outcome === 'scan-error') {
            callback(new Error('synthetic ps failure'), '')
            return
          }
          if (outcome === 'exited') processes.delete(101)
          if (outcome === 'zombie') processes.set(101, { ...child, state: 'Z', command: '<defunct>' })
          if (outcome === 'marked') processes.set(101, { ...child })
          if (outcome === 'unmarked') processes.set(101, { ...child, command: 'git PATH=/usr/bin' })
          if (outcome === 'reused') processes.set(101, {
            ppid: 1, pgid: 200, state: 'S', startTime: 'replacement-start', command: '(unrelated)',
          })
        }
        callback(null, [...processes].map(([pid, entry]) =>
          `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}${markerScan ? ` ${entry.command}` : ''}`,
        ).join('\n'))
      },
      kill: (pid: number, signal: string): void => {
        signals.push(pid)
        if (signal !== 'SIGKILL') return
        for (const [candidate, entry] of processes) {
          if (candidate === pid || pid < 0 && entry.pgid === -pid) processes.delete(candidate)
        }
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)
    const onFailure = vi.fn()
    observation.onFailure(onFailure)
    try {
      await vi.advanceTimersByTimeAsync(0)
      phase = 'unreadable'
      if (!duringCleanup) {
        await vi.advanceTimersByTimeAsync(1_000)
        expect(confirmed).toBe(true)
        if (failure) expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(failure) }))
        else expect(onFailure).not.toHaveBeenCalled()
        // Inspection recovery must not erase a previously confirmed failure.
        phase = 'normal'
        if (failure) processes.set(101, { ...child })
      }
      const termination = terminateProcessTree(100, () => undefined, dependencies, {
        observation, requireConfirmedCleanup: true,
      }).then(() => null, (error: Error) => error)
      await vi.runAllTimersAsync()
      const error = await termination
      expect(confirmed).toBe(true)
      if (failure) expect(error?.message).toContain(failure)
      else expect(error).toBeNull()
      if (outcome === 'unreadable') expect(observation.diagnostics[0]?.processes).toContainEqual(
        expect.objectContaining({ pid: 101, markerMatches: null }),
      )
      expect(signals).not.toContain(200)
      expect(signals).not.toContain(-200)
      if (outcome === 'reused') {
        expect(signals).not.toContain(101)
        expect(processes.get(101)?.startTime).toBe('replacement-start')
      }
      expect(processes.has(200)).toBe(true)
    } finally {
      observation.dispose()
      vi.useRealTimers()
    }
  })

  it('confirms unreadable data for each observer sharing an initial scan', async () => {
    vi.useFakeTimers()
    let markerScans = 0
    const processes = new Map([[100, 'marker-a'], [200, 'marker-b']])
    const dependencies = {
      platform: 'darwin' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => {
        const markerScan = args.some((arg) => arg.includes('command='))
        if (markerScan) markerScans += 1
        const output = [...processes].map(([pid, marker]) => {
          const command = pid === 200 && markerScans === 1
            ? '(node)'
            : `node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`
          return `${pid} 1 ${pid} S start-${pid}${markerScan ? ` ${command}` : ''}`
        }).join('\n')
        // Both independent observations join the same pending initial scan.
        Promise.resolve().then(() => callback(null, output))
      },
      kill: (pid: number, signal: string): void => {
        if (signal === 'SIGKILL') processes.delete(Math.abs(pid))
      },
    }
    const first = observeProcessTree(100, 'marker-a', dependencies)
    const second = observeProcessTree(200, 'marker-b', dependencies)
    const onFailure = vi.fn()
    first.onFailure(onFailure)
    second.onFailure(onFailure)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(onFailure).not.toHaveBeenCalled()
      const termination = Promise.all([first, second].map((observation) => terminateProcessTree(
        observation.pid, () => undefined, dependencies, { observation, requireConfirmedCleanup: true },
      ))).then(() => null, (error: Error) => error)
      await vi.runAllTimersAsync()
      expect(await termination).toBeNull()
      expect(processes.size).toBe(0)
    } finally {
      first.dispose()
      second.dispose()
      vi.useRealTimers()
    }
  })

  it.each([
    ['before the first observation', 0],
    ['after it was observed', 1],
  ])('latches marker loss %s and cleans the known process identities', async (_label, markedRounds) => {
    const marker = 'marker-value'
    const processes = new Map([
      [100, { ppid: 1, pgid: 100, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, pgid: 100, state: 'S', startTime: 'child-start' }],
      [200, { ppid: 1, pgid: 200, state: 'S', startTime: 'foreign-start' }],
    ])
    let markerLookups = 0
    const signals: Array<[number, string]> = []
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => {
        if (args.some((arg) => arg.includes('command='))) {
          markerLookups += 1
          callback(null, renderMarkerScan(
            processes,
            marker,
            (pid) => pid === 100 || pid === 101 && markerLookups <= markedRounds,
          ))
          return
        }
        callback(null, [...processes].map(([pid, entry]) =>
          `${pid} ${entry.ppid} ${entry.pgid} ${entry.state} ${entry.startTime}`
        ).join('\n'))
      },
      kill: (pid: number, signal: string): void => {
        signals.push([pid, signal])
        if (pid === -100 && signal === 'SIGTERM') {
          for (const [candidatePid, entry] of processes) {
            if (entry.pgid === 100) processes.set(candidatePid, { ...entry, state: 'T' })
          }
        }
        if (pid === -100 && signal === 'SIGKILL') {
          for (const [candidatePid, entry] of processes) {
            if (entry.pgid === 100) processes.delete(candidatePid)
          }
        }
        if (pid > 0 && signal === 'SIGKILL') processes.delete(pid)
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)
    const failure = new Promise<Error>((resolve) => observation.onFailure(resolve))

    await expect(failure).resolves.toMatchObject({
      message: expect.stringContaining('lost its process marker'),
    })
    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      { observation, requireConfirmedCleanup: true },
    )).rejects.toThrow('lost its process marker')

    expect(processes.has(101)).toBe(false)
    expect(processes.has(200)).toBe(true)
    expect(signals).not.toContainEqual([-200, 'SIGKILL'])
  })

  it('uses the atomic marker snapshot for identity cleanup', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'child-start' }],
    ])
    const signals: Array<[number, string]> = []
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      enforceCooperativeProcessGroup: true,
      execFile: (
        _command: string,
        args: string[],
        _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, args.some((arg) => arg.includes('command='))
        ? renderMarkerScan(processes, marker)
        : [...processes].map(([pid, entry]) =>
            `${pid} ${entry.ppid} ${entry.state} ${entry.startTime}`
          ).join('\n')),
      kill: (pid: number, signal: string): void => {
        signals.push([pid, signal])
        const entry = processes.get(pid)
        if (entry && signal === 'SIGTERM') processes.set(pid, { ...entry, state: 'T' })
        if (pid > 0 && signal === 'SIGKILL') processes.delete(pid)
      },
    }
    const observation = observeProcessTree(100, marker, dependencies)

    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      { observation, requireConfirmedCleanup: true },
    )).resolves.toBeUndefined()

    expect(processes.size).toBe(0)
  })

  it('falls back to direct-child cleanup when optional POSIX inspection is unavailable', async () => {
    let directChildKilled = false
    const execFile = (
      _command: string,
      _args: string[],
      _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
      callback: (error: Error | null, stdout: string) => void,
    ): void => callback(new Error('inspection unavailable'), '')
    const dependencies = { platform: 'linux' as const, execFile }
    const observation = observeProcessTree(999_999, undefined, dependencies)

    await expect(terminateProcessTree(
      999_999,
      () => { directChildKilled = true },
      dependencies,
      { observation, allowInspectionUnavailable: true },
    )).resolves.toBeUndefined()
    expect(directChildKilled).toBe(true)
  })

  it('keeps POSIX inspection failure closed when confirmed cleanup is required', async () => {
    const execFile = (
      _command: string,
      _args: string[],
      _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
      callback: (error: Error | null, stdout: string) => void,
    ): void => callback(new Error('inspection unavailable'), '')
    const dependencies = { platform: 'linux' as const, execFile }
    const observation = observeProcessTree(999_999, undefined, dependencies)

    await expect(terminateProcessTree(
      999_999,
      () => undefined,
      dependencies,
      { observation, requireConfirmedCleanup: true },
    )).rejects.toThrow('POSIX process identity lookup failed')
  })

  it('reports spawn errors without claiming a successful process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-spawn-'))
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        executable: path.join(root, 'missing-provider'),
      }, managedHooks())
      expect(result).toMatchObject({ exitCode: null, terminationReason: null })
      expect(result.stderr).toContain('ENOENT')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'success', script: 'process.stdout.write("ok")', exitCode: 0, stdout: 'ok', stderr: '' },
    { name: 'failure', script: 'process.stderr.write("bad"); process.exit(7)', exitCode: 7, stdout: '', stderr: 'bad' },
  ])('captures $name', async ({ script, exitCode, stdout, stderr }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-capture-'))
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', script],
      }, managedHooks())
      expect(result.exitCode).toBe(exitCode)
      expect(result.stdout).toBe(stdout)
      expect(result.stderr).toBe(stderr)
      expect(result.descendantCleanupGuaranteed).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { reason: 'timeout', expected: { timedOut: true }, configure: (request: ReturnType<typeof baseRequest>) => ({ ...request, timeoutMs: 25 }) },
    { reason: 'abort', expected: { cancelled: true }, configure: (request: ReturnType<typeof baseRequest>, signal: AbortSignal) => ({ ...request, signal }) },
    { reason: 'max-buffer', expected: { maxBufferExceeded: true, stdoutTruncated: true }, configure: (request: ReturnType<typeof baseRequest>) => ({ ...request, maxBufferBytes: 4 }) },
  ])('kills the direct child after $reason', async ({ reason, expected, configure }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-stop-'))
    const controller = new AbortController()
    let providerPid = 0
    try {
      const request = configure({
        ...baseRequest(root),
        args: reason === 'max-buffer'
          ? [syntheticProcessPath, '--stdout', 'overflow']
          : [syntheticProcessPath],
      }, controller.signal)
      const running = runProviderProcess(request, managedHooks({
        onSpawn: ({ pid }) => {
          providerPid = pid
          if (reason === 'abort') controller.abort()
        },
      }))
      const result = await running
      expect(result.terminationReason).toBe(reason)
      expect(result).toMatchObject(expected)
      await expectProcessDead(providerPid)
    } finally {
      killProcess(providerPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'rejects', terminate: async () => { throw new Error('cleanup rejected') } },
    { name: 'does not settle', terminate: async () => await new Promise<never>(() => undefined) },
  ])('kills the direct child before returning when cleanup $name', async ({ terminate }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-cleanup-'))
    let providerPid = 0
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: [syntheticProcessPath],
        timeoutMs: 25,
      }, managedHooks({
        onSpawn: ({ pid }) => { providerPid = pid },
        terminateProcessTree: terminate,
      }))).rejects.toBeInstanceOf(ProviderProcessCleanupError)
      await expectProcessDead(providerPid)
    } finally {
      killProcess(providerPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('kills the direct child before returning an onSpawn failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-spawn-hook-'))
    let providerPid = 0
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: [syntheticProcessPath],
      }, managedHooks({
        onSpawn: ({ pid }) => {
          providerPid = pid
          throw new Error('onSpawn failed')
        },
      }))).rejects.toThrow('onSpawn failed')
      await expectProcessDead(providerPid)
    } finally {
      killProcess(providerPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs an observed AW-native command without portable containment evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-observed-'))
    let observedPid = 0
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', 'process.stdout.write("native")'],
      }, {
        onSpawn: ({ pid }) => { observedPid = pid },
        terminateProcessTree: async () => ({ confirmed: true }),
      }, { containment: 'observed' })
      expect(observedPid).toBeGreaterThan(0)
      expect(result).toMatchObject({
        stdout: 'native',
        exitCode: 0,
        descendantCleanupGuaranteed: false,
        containmentLimitation: expect.stringContaining('non-portable'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['empty process output', '', ''],
    ['unparseable process output', 'not a process row', 'not a marker row'],
    [
      'missing sentinel marker',
      '900003 1 900003 S Mon Aug 24 12:00:00 2026',
      '',
    ],
    [
      'marker on the wrong PID',
      '900003 1 900003 S Mon Aug 24 12:00:00 2026',
      '900003 1 900003 S sentinel-start node\n900004 1 900004 S wrong-start node AW_AGENT_SKILL_EVAL_PROCESS_MARKER=MARKER',
    ],
    [
      'wrong marker value',
      '900003 1 900003 S Mon Aug 24 12:00:00 2026',
      '900003 1 900003 S sentinel-start node AW_AGENT_SKILL_EVAL_PROCESS_MARKER=MARKER-wrong',
    ],
  ])('rejects before provider spawn for %s', async (_name, identityOutput, markerOutput) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-verified-'))
    const startedPath = path.join(root, 'started')
    let marker = ''
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'yes')`],
      }, {}, {
        containment: 'verified-observed',
        processTree: {
          platform: 'linux',
          markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
          createSentinel: async (_markerEnvironmentVariable, value) => {
            marker = value
            return { pid: 900_003, stop: async () => undefined }
          },
          execFile: (_command, args, _options, callback) => callback(
            null,
            args.some((arg) => arg.includes('command='))
              ? markerOutput.replace('MARKER', marker)
              : identityOutput,
          ),
        },
      })).rejects.toThrow(/identity lookup failed|sentinel could not be verified/u)
      await expect(stat(startedPath)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a fast provider exit while the inspection sentinel remains healthy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-verified-'))
    let marker = ''
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: ['-e', `process.stdout.write(process.env.${PROVIDER_PROCESS_MARKER_ENV})`],
      }, {}, {
        containment: 'verified-observed',
        processTree: {
          platform: 'linux',
          markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
          createSentinel: async (_markerEnvironmentVariable, value) => {
            marker = value
            return { pid: 900_004, stop: async () => undefined }
          },
          execFile: (_command, args, _options, callback) => callback(
            null,
            args.some((arg) => arg.includes('command='))
              ? `900004 1 900004 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`
              : '900004 1 900004 S Mon Aug 24 12:00:00 2026',
          ),
        },
      })).resolves.toMatchObject({
        stdout: '[redacted provider process marker]',
        exitCode: 0,
        gradingEvidenceAccepted: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['before the first observation', 0],
    ['after it was observed', 1],
  ])('rejects grading when the live provider root loses its marker %s', async (_label, markedRounds) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-verified-'))
    let marker = ''
    let providerPid = 0
    let providerMarkerLookups = 0
    let live = true
    let stopped = false
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: [syntheticProcessPath],
      }, {
        onSpawn: ({ pid }) => { providerPid = pid },
      }, {
        containment: 'verified-observed',
        processTree: {
          platform: 'linux',
          markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
          createSentinel: async (_markerEnvironmentVariable, value) => {
            marker = value
            return { pid: 900_008, stop: async () => undefined }
          },
          execFile: (_command, args, _options, callback) => {
            if (args.some((arg) => arg.includes('command=')) && providerPid > 0 && live) {
              providerMarkerLookups += 1
            }
            callback(null, args.some((arg) => arg.includes('command='))
              ? [
                  `900008 1 900008 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`,
                  ...(providerPid > 0 && live
                    ? [`${providerPid} 1 ${providerPid} ${stopped ? 'T' : 'S'} provider-start node${
                      providerMarkerLookups <= markedRounds
                        ? ` ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`
                        : ''
                    }`]
                    : []),
                ].join('\n')
              : [
                  '900008 1 900008 S Mon Aug 24 12:00:00 2026',
                  ...(providerPid > 0 && live
                    ? [`${providerPid} 1 ${providerPid} ${stopped ? 'T' : 'S'} Mon Aug 24 12:00:00 2026`]
                    : []),
                ].join('\n'))
          },
          kill: (pid, signal) => {
            if (pid !== providerPid) return
            if (signal === 'SIGTERM') stopped = true
            if (signal === 'SIGKILL') {
              live = false
              killProcess(providerPid)
            }
          },
        },
      })).rejects.toMatchObject({
        name: 'ProviderProcessCleanupError',
        message: expect.stringContaining('lost its process marker'),
        result: { gradingEvidenceAccepted: false },
      })
      await expectProcessDead(providerPid)
    } finally {
      killProcess(providerPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects grading when only the final sentinel inspection becomes blind', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-verified-'))
    let marker = ''
    let identityInspections = 0
    let sentinelStopped = false
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: ['-e', 'process.stdout.write("candidate-grade")'],
      }, {}, {
        containment: 'verified-observed',
        processTree: {
          platform: 'linux',
          markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
          createSentinel: async (_markerEnvironmentVariable, value) => {
            marker = value
            return {
              pid: 900_006,
              stop: async () => { sentinelStopped = true },
            }
          },
          execFile: (_command, args, _options, callback) => {
            if (!args.some((arg) => arg.includes('command='))) identityInspections += 1
            const blind = identityInspections >= 2
            callback(null, blind
              ? ''
              : args.some((arg) => arg.includes('command='))
                ? `900006 1 900006 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`
                : '900006 1 900006 S Mon Aug 24 12:00:00 2026')
          },
        },
      })).rejects.toMatchObject({
        name: 'ProviderProcessCleanupError',
        result: { gradingEvidenceAccepted: false },
      })
      expect(sentinelStopped).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('latches a marked PGID change and rejects grading after best-effort cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-verified-'))
    let marker = ''
    let providerPid = 0
    let providerInspections = 0
    let live = true
    let stopped = false
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: [syntheticProcessPath],
      }, {
        onSpawn: ({ pid }) => { providerPid = pid },
      }, {
        containment: 'verified-observed',
        processTree: {
          platform: 'linux',
          markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
          createSentinel: async (_markerEnvironmentVariable, value) => {
            marker = value
            return { pid: 900_007, stop: async () => undefined }
          },
          execFile: (_command, args, _options, callback) => {
            if (!args.some((arg) => arg.includes('command=')) && providerPid > 0 && live) {
              providerInspections += 1
            }
            const providerPgid = providerInspections <= 1 ? providerPid : providerPid + 1
            callback(null, args.some((arg) => arg.includes('command='))
              ? [
                  `900007 1 900007 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`,
                  ...(providerPid > 0 && live
                    ? [`${providerPid} 1 ${providerPgid} ${stopped ? 'T' : 'S'} provider-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`]
                    : []),
                ].join('\n')
              : [
                  '900007 1 900007 S Mon Aug 24 12:00:00 2026',
                  ...(providerPid > 0 && live
                    ? [`${providerPid} 1 ${providerPgid} ${stopped ? 'T' : 'S'} Mon Aug 24 12:00:00 2026`]
                    : []),
                ].join('\n'))
          },
          kill: (pid, signal) => {
            if (pid !== providerPid) return
            if (signal === 'SIGTERM') stopped = true
            if (signal === 'SIGKILL') {
              live = false
              killProcess(providerPid)
            }
          },
        },
      })).rejects.toThrow('contract violation')
      await expectProcessDead(providerPid)
    } finally {
      killProcess(providerPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts grading after verified observation without claiming OS containment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-verified-'))
    const identityPath = path.join(root, 'identity.json')
    let live = true
    let stopped = false
    let marker = ''
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', [
          `require('node:fs').writeFileSync(${JSON.stringify(identityPath)}, JSON.stringify({pid:process.pid,marker:process.env.${PROVIDER_PROCESS_MARKER_ENV}}))`,
          `setTimeout(() => process.stdout.write(process.env.${PROVIDER_PROCESS_MARKER_ENV}), 100)`,
        ].join(';')],
      }, {}, {
        containment: 'verified-observed',
        processTree: {
          platform: 'linux',
          markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
          createSentinel: async (_markerEnvironmentVariable, value) => {
            marker = value
            return { pid: 900_002, stop: async () => undefined }
          },
          execFile: (_command, args, _options, callback) => {
            void readFile(identityPath, 'utf8').then((raw) => {
              const identity = JSON.parse(raw) as { pid: number; marker: string }
              callback(null, args.some((arg) => arg.includes('command='))
                ? [
                    `900002 1 900002 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`,
                    ...(live
                      ? [`${identity.pid} 1 ${identity.pid} ${stopped ? 'T' : 'S'} provider-start node ${PROVIDER_PROCESS_MARKER_ENV}=${identity.marker}`]
                      : []),
                  ].join('\n')
                : [
                    '900002 1 900002 S Mon Aug 24 12:00:00 2026',
                    ...(live
                      ? [`${identity.pid} 1 ${identity.pid} ${stopped ? 'T' : 'S'} Mon Aug 24 12:00:00 2026`]
                      : []),
                  ].join('\n'))
            }, () => callback(null, args.some((arg) => arg.includes('command='))
              ? `900002 1 900002 S sentinel-start node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`
              : '900002 1 900002 S Mon Aug 24 12:00:00 2026'))
          },
          kill: (pid, signal) => {
            if (signal === 'SIGTERM') stopped = true
            if (signal === 'SIGKILL' && pid !== -900_002) live = false
          },
        },
      })
      expect(result).toMatchObject({
        stdout: '[redacted provider process marker]',
        exitCode: 0,
        containmentMode: 'verified-observed',
        gradingEvidenceAccepted: true,
        descendantCleanupGuaranteed: false,
        containmentLimitation: expect.stringContaining('not OS-enforced'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('explicit unmanaged-confirmed provider mode', () => {
  it('does not claim descendant cleanup and does not run process inspection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-unmanaged-'))
    const pidPath = path.join(root, 'pid')
    let descendantPid: number | undefined
    let inspectionAttempted = false
    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        "const fs = require('node:fs')",
        `const child = spawn(process.execPath, [${JSON.stringify(syntheticProcessPath)}], { detached: true, stdio: 'ignore' })`,
        'child.unref()',
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
        `process.stdout.write(String(process.env.${PROVIDER_PROCESS_MARKER_ENV}))`,
      ].join('\n')
      const result = await runProviderProcess({
        ...baseRequest(root),
        env: { ...process.env, [PROVIDER_PROCESS_MARKER_ENV]: 'caller-marker' },
        args: ['-e', script],
      }, {}, {
        containment: 'unmanaged-confirmed',
        processTree: {
          platform: process.platform,
          execFile: () => {
            inspectionAttempted = true
            throw new Error('process inspection must not run')
          },
        },
      })
      descendantPid = await waitForPid(pidPath)
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: 'undefined',
        descendantCleanupGuaranteed: false,
      })
      expect(inspectionAttempted).toBe(false)
      expect(processIsAlive(descendantPid)).toBe(true)
    } finally {
      killProcess(descendantPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminates the direct child on timeout without claiming descendant cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-unmanaged-'))
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: [syntheticProcessPath],
        timeoutMs: 50,
      }, {}, { containment: 'unmanaged-confirmed' })
      expect(result).toMatchObject({
        timedOut: true,
        descendantCleanupGuaranteed: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
