import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readWindowsNativeProcessStart,
  readWindowsNativeProcessTable,
  type WindowsNativeOptions,
} from '../../src/windows-native.js'

const helperPath = 'C:\\fixture\\native.exe'

afterEach(() => {
  vi.useRealTimers()
})

function nativeFixture(response: unknown, options: {
  raw?: Buffer
  exitCode?: number
  neverClose?: boolean
} = {}): { options: WindowsNativeOptions; kill: ReturnType<typeof vi.fn>; request: () => unknown; invoke: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  const kill = vi.fn(() => true)
  child.kill = kill
  const input: Buffer[] = []
  child.stdin.on('data', (chunk: Buffer) => input.push(chunk))
  child.stdin.on('finish', () => {
    if (options.neverClose) return
    queueMicrotask(() => {
      child.stdout!.emit('data', options.raw ?? Buffer.from(JSON.stringify(response)))
      child.emit('close', options.exitCode ?? 0, null)
    })
  })
  const invoke = vi.fn(() => child)
  return {
    options: {
      helperPath,
      spawn: invoke as unknown as typeof spawn,
    },
    kill,
    request: () => JSON.parse(Buffer.concat(input).toString('utf8')),
    invoke,
  }
}

describe('Windows native process operations', () => {
  it('keeps full lock ticks and sends bounded fixed-operation JSON', async () => {
    const fixture = nativeFixture({ schemaVersion: 1, result: '638000000000000019' })
    await expect(readWindowsNativeProcessStart(42, fixture.options)).resolves.toBe('638000000000000019')
    expect(fixture.request()).toEqual({ schemaVersion: 1, operation: 'processStart', input: { pid: 42 } })
    expect(fixture.invoke).toHaveBeenCalledWith(helperPath, ['--operation'], expect.objectContaining({
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    }))
  })

  it('preserves CIM ticks and required live process checks without losing integer precision', async () => {
    const rows = [{ pid: 42, ppid: 1, pgid: null, started: '638000000000000010' }]
    const fixture = nativeFixture({ schemaVersion: 1, result: rows })
    await expect(readWindowsNativeProcessTable([42, 99, 42], fixture.options)).resolves.toEqual(rows)
    expect(fixture.request()).toEqual({
      schemaVersion: 1, operation: 'processTable', input: { requiredPids: [42, 99] },
    })
  })

  it('accepts only an explicit null as a confirmed process exit', async () => {
    const fixture = nativeFixture({ schemaVersion: 1, result: null })
    await expect(readWindowsNativeProcessStart(42, fixture.options)).resolves.toBeNull()
    const failed = nativeFixture({ schemaVersion: 1, result: null }, { exitCode: 1 })
    await expect(readWindowsNativeProcessStart(42, failed.options)).rejects.toThrow('operation failed')
  })

  it.each([
    { schemaVersion: 2, result: null },
    { schemaVersion: 1, result: null, extra: true },
    { schemaVersion: 1, result: 638000000000000000 },
    { schemaVersion: 1, result: '3155378976000000000' },
  ])('rejects an invalid start response %#', async (response) => {
    const fixture = nativeFixture(response)
    await expect(readWindowsNativeProcessStart(42, fixture.options)).rejects.toThrow('invalid response')
  })

  it.each([
    [{ pid: 42, ppid: 1, pgid: null, started: '638000000000000011' }],
    [{ pid: 42, ppid: 1, pgid: null, started: '638000000000000010', sid: 'private' }],
    [{ pid: 42, ppid: 1, pgid: 42, started: '638000000000000010' }],
    [
      { pid: 42, ppid: 1, pgid: null, started: '638000000000000010' },
      { pid: 42, ppid: 1, pgid: null, started: '638000000000000010' },
    ],
  ])('rejects an invalid process-table row set %#', async (...rows) => {
    const fixture = nativeFixture({ schemaVersion: 1, result: rows })
    await expect(readWindowsNativeProcessTable([42], fixture.options)).rejects.toThrow('invalid response')
  })

  it.each([
    Buffer.from('{"schemaVersion":1,"result":null} {}'),
    Buffer.from([0xff]),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  ])('rejects extra JSON, invalid UTF-8, and oversized output %#', async (raw) => {
    const fixture = nativeFixture(null, { raw })
    await expect(readWindowsNativeProcessStart(42, fixture.options)).rejects.toThrow(/invalid response|output exceeded/u)
  })

  it('kills a helper that exceeds the operation deadline', async () => {
    vi.useFakeTimers()
    const fixture = nativeFixture(null, { neverClose: true })
    const result = readWindowsNativeProcessStart(42, { ...fixture.options, timeoutMs: 5 })
    const assertion = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(5)
    await assertion
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it('rejects invalid PID and oversized requests before starting a helper', async () => {
    const fixture = nativeFixture(null)
    await expect(readWindowsNativeProcessStart(-1, fixture.options)).rejects.toThrow('identifier')
    await expect(readWindowsNativeProcessTable(Array.from({ length: 50_000 }, (_, index) => index + 1), fixture.options))
      .rejects.toThrow('input')
    expect(fixture.invoke).not.toHaveBeenCalled()
  })

  it('requires a prepared path and does not resolve or fetch tools during an operation', async () => {
    const fixture = nativeFixture(null)
    await expect(readWindowsNativeProcessStart(42, { spawn: fixture.options.spawn }))
      .rejects.toThrow('requires a prepared helper')
    expect(fixture.invoke).not.toHaveBeenCalled()
  })
})
