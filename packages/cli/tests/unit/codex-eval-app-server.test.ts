import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  inspectAppServerConfigWarning,
  settleAppServerProcessCleanup,
} from '../../scripts/codex-eval-app-server.js'
import { createDirectChildProcessMonitor } from '../../scripts/codex-eval-process-tree.js'

describe('Codex provider app-server process boundary', () => {
  it('detects app-server config warnings for strict provider runs', () => {
    expect(inspectAppServerConfigWarning({
      method: 'configWarning',
      params: { summary: 'Project-local config is disabled.' },
    })).toBe('Project-local config is disabled.')
    expect(inspectAppServerConfigWarning({ method: 'turn/started', params: {} })).toBeNull()
  })

  it('releases open handles before reporting unconfirmed cleanup', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const unref = vi.fn()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      unref,
    }) as unknown as ChildProcess
    const waitForClose = vi.fn(async () => false)

    await expect(settleAppServerProcessCleanup({
      child,
      processTreeMonitor: {
        terminate: async () => [
          'Could not confirm process-tree cleanup: token scan unavailable.',
        ],
      },
      waitForClose,
    })).rejects.toThrow('token scan unavailable')

    expect(waitForClose).toHaveBeenCalledWith(1_000)
    expect(stdin.destroyed).toBe(true)
    expect(stdout.destroyed).toBe(true)
    expect(stderr.destroyed).toBe(true)
    expect(unref).toHaveBeenCalledOnce()
  })

  it('settles direct child cleanup as soon as the child closes', async () => {
    vi.useFakeTimers()
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => true),
      }) as unknown as ChildProcess

      const termination = createDirectChildProcessMonitor(child).terminate()
      child.emit('close', 0, null)

      await expect(termination).resolves.toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
