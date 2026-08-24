import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import {
  observeProcessTree,
  ProviderProcessCleanupError,
  runProviderProcess,
  terminateProcessTree,
  type ProcessLifecycleHooks,
} from '../../dist/index.js'

const PROVIDER_PROCESS_MARKER_ENV = 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER'

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

describe('managed provider containment gate', () => {
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
  it('kills identities frozen from the last trusted POSIX marker snapshot when refresh fails', async () => {
    const marker = 'marker-value'
    const processes = new Map([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'descendant-start' }],
    ])
    const renderTable = () => [...processes].map(([pid, entry]) =>
      `${pid} ${entry.ppid} ${entry.state} ${entry.startTime}`
    ).join('\n')
    let markerLookup = 0
    const execFile = (
      _command: string,
      args: string[],
      _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
      callback: (error: Error | null, stdout: string) => void,
    ): void => {
      if (args.includes('pid=,command=')) {
        markerLookup += 1
        callback(
          markerLookup === 3 ? new Error('marker refresh failed') : null,
          markerLookup === 3
            ? ''
            : [...processes.keys()].map((pid) =>
              `${pid} node ${PROVIDER_PROCESS_MARKER_ENV}=${marker}`
            ).join('\n'),
        )
        return
      }
      callback(null, renderTable())
    }
    const kill = (pid: number, signal: string): void => {
      const entry = processes.get(pid)
      if (entry && signal === 'SIGSTOP') processes.set(pid, { ...entry, state: 'T' })
      if (signal === 'SIGKILL') processes.delete(pid)
    }
    const dependencies = {
      platform: 'linux' as const,
      markerEnvironmentVariable: PROVIDER_PROCESS_MARKER_ENV,
      execFile,
      kill,
    }
    const observation = observeProcessTree(100, marker, dependencies)

    await expect(terminateProcessTree(
      100,
      () => undefined,
      dependencies,
      { observation },
    )).rejects.toThrow('POSIX process marker lookup failed')

    expect(processes.has(101)).toBe(false)
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
          ? ['-e', 'process.stdout.write("overflow"); setInterval(() => {}, 1000)']
          : ['-e', 'setInterval(() => {}, 1000)'],
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
        args: ['-e', 'setInterval(() => {}, 1000)'],
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
        args: ['-e', 'setInterval(() => {}, 1000)'],
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
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
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
        args: ['-e', 'setInterval(() => {}, 1000)'],
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
