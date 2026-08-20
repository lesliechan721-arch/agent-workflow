import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import {
  ProviderProcessCleanupError,
  runProviderProcess,
} from '../../dist/index.js'

const PROVIDER_PROCESS_MARKER_ENV = 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER'

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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function expectProcessDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && processIsAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(processIsAlive(pid)).toBe(false)
}

function cleanupProcess(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The production cleanup normally removed the process already.
  }
}

function detachedDescendantScript(pidPath: string, behavior: 'complete' | 'wait' | 'max-buffer'): string {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {`,
    '  detached: true,',
    "  stdio: 'ignore',",
    '  env: process.env,',
    '})',
    'child.unref()',
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
    ...(behavior === 'max-buffer'
      ? ["process.stdout.write('x'.repeat(16 * 1024))"]
      : []),
    ...(behavior === 'complete'
      ? []
      : ['setInterval(() => {}, 1000)']),
  ].join('\n')
}

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

describe.skipIf(process.platform === 'win32')('provider process-tree cleanup', () => {
  it('cleans a detached setsid descendant after normal completion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    const pidPath = path.join(root, 'pid')
    let descendantPid: number | undefined
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', detachedDescendantScript(pidPath, 'complete')],
      })
      descendantPid = await waitForPid(pidPath)
      expect(result).toMatchObject({ exitCode: 0, terminationReason: 'complete' })
      await expectProcessDead(descendantPid)
    } finally {
      cleanupProcess(descendantPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans a detached setsid descendant after timeout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    const pidPath = path.join(root, 'pid')
    let descendantPid: number | undefined
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', detachedDescendantScript(pidPath, 'wait')],
        timeoutMs: 200,
      })
      descendantPid = await waitForPid(pidPath)
      expect(result).toMatchObject({ timedOut: true, terminationReason: 'timeout' })
      await expectProcessDead(descendantPid)
    } finally {
      cleanupProcess(descendantPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans a detached setsid descendant after abort', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    const pidPath = path.join(root, 'pid')
    const controller = new AbortController()
    let descendantPid: number | undefined
    try {
      const run = runProviderProcess({
        ...baseRequest(root),
        args: ['-e', detachedDescendantScript(pidPath, 'wait')],
        signal: controller.signal,
      })
      descendantPid = await waitForPid(pidPath)
      controller.abort()
      const result = await run
      expect(result).toMatchObject({ cancelled: true, terminationReason: 'abort' })
      await expectProcessDead(descendantPid)
    } finally {
      controller.abort()
      cleanupProcess(descendantPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans a detached setsid descendant after max-buffer termination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    const pidPath = path.join(root, 'pid')
    let descendantPid: number | undefined
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', detachedDescendantScript(pidPath, 'max-buffer')],
      })
      descendantPid = await waitForPid(pidPath)
      expect(result).toMatchObject({ maxBufferExceeded: true, terminationReason: 'max-buffer' })
      await expectProcessDead(descendantPid)
    } finally {
      cleanupProcess(descendantPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans a detached setsid descendant before reporting an external hook failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    const pidPath = path.join(root, 'pid')
    let descendantPid: number | undefined
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: ['-e', detachedDescendantScript(pidPath, 'complete')],
      }, {
        terminateProcessTree: async () => { throw new Error('external hook failed') },
      })).rejects.toBeInstanceOf(ProviderProcessCleanupError)
      descendantPid = await waitForPid(pidPath)
      await expectProcessDead(descendantPid)
    } finally {
      cleanupProcess(descendantPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('overwrites and scrubs the internal process marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        env: {
          ...process.env,
          [PROVIDER_PROCESS_MARKER_ENV]: 'caller-controlled-marker',
        },
        args: [
          '-e',
          `process.stdout.write(process.env.${PROVIDER_PROCESS_MARKER_ENV});` +
            `process.stderr.write(process.env.${PROVIDER_PROCESS_MARKER_ENV})`,
        ],
      })
      expect(result.stdout).toBe('[redacted provider process marker]')
      expect(result.stderr).toBe('[redacted provider process marker]')
      expect(JSON.stringify(result)).not.toContain('caller-controlled-marker')

      const truncated = await runProviderProcess({
        ...baseRequest(root),
        maxBufferBytes: 8,
        args: ['-e', `process.stdout.write(process.env.${PROVIDER_PROCESS_MARKER_ENV})`],
      })
      expect(truncated.stdout).toBe('[redacted provider process marker]')
      expect(truncated).toMatchObject({
        maxBufferExceeded: true,
        stdoutTruncated: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('scrubs the internal process marker from cleanup errors and their causes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    const markerPath = path.join(root, 'marker')
    try {
      let thrown: unknown
      try {
        await runProviderProcess({
          ...baseRequest(root),
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, ` +
              `process.env.${PROVIDER_PROCESS_MARKER_ENV})`,
          ],
        }, {
          terminateProcessTree: async () => {
            throw new Error(await readFile(markerPath, 'utf8'))
          },
        })
      } catch (error) {
        thrown = error
      }
      const marker = await readFile(markerPath, 'utf8')
      expect(thrown).toBeInstanceOf(ProviderProcessCleanupError)
      expect((thrown as Error).message).not.toContain(marker)
      expect(((thrown as Error).cause as Error).message).not.toContain(marker)
      expect((thrown as Error).message).toContain('[redacted provider process marker]')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed before starting the provider when POSIX inspection is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-process-'))
    const startedPath = path.join(root, 'started')
    try {
      await expect(runProviderProcess({
        ...baseRequest(root),
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'yes')`],
      }, {}, {
        processTree: {
          platform: 'linux',
          execFile: (_command, _args, _options, callback) => {
            callback(new Error('ps unavailable'), '')
          },
        },
      })).rejects.toThrow('POSIX process identity lookup failed')
      await expect(stat(startedPath)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Windows provider cleanup hook contract', () => {
  it('keeps the JavaScript API available only with confirmed external evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-windows-hook-'))
    try {
      const request = {
        ...baseRequest(root),
        args: ['-e', 'process.exit(0)'],
      }
      await expect(runProviderProcess(request, {
        terminateProcessTree: async () => ({ confirmed: true }),
      }, {
        processTree: { platform: 'win32' },
      })).resolves.toMatchObject({ exitCode: 0, terminationReason: 'complete' })

      await expect(runProviderProcess(request, {
        terminateProcessTree: async () => undefined,
      }, {
        processTree: { platform: 'win32' },
      })).rejects.toThrow('did not return confirmed evidence')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('explicit unmanaged provider containment', () => {
  it('runs without process inspection and reports that descendant cleanup is not guaranteed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-unmanaged-'))
    const pidPath = path.join(root, 'pid')
    let descendantPid: number | undefined
    let inspectionAttempted = false
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        env: {
          ...process.env,
          [PROVIDER_PROCESS_MARKER_ENV]: 'caller-controlled-marker',
        },
        args: [
          '-e',
          `${detachedDescendantScript(pidPath, 'complete')}\n` +
            `process.stdout.write(String(process.env.${PROVIDER_PROCESS_MARKER_ENV}))`,
        ],
      }, {}, {
        containment: 'unmanaged-confirmed',
        processTree: {
          platform: 'linux',
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
      cleanupProcess(descendantPid)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminates only the direct child on timeout without requiring a Windows hook', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-unmanaged-'))
    try {
      const result = await runProviderProcess({
        ...baseRequest(root),
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 50,
      }, {}, {
        containment: 'unmanaged-confirmed',
        processTree: { platform: 'win32' },
      })
      expect(result).toMatchObject({
        timedOut: true,
        descendantCleanupGuaranteed: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
