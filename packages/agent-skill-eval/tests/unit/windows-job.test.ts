import { describe, expect, it } from 'vitest'

import {
  buildWindowsCommandLine,
  createWindowsJobInvocation,
  encodeWindowsJobHelperConfig,
  prepareWindowsJobHelper,
  quoteWindowsCommandLineArgument,
  resolveWindowsJobHelperPath,
  WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION,
} from '../../src/windows-job.js'

function decodeConfig(encoded: string): unknown {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
}

describe('Windows Job helper contract', () => {
  it('encodes the target command as base64url JSON without shell text', () => {
    const encoded = encodeWindowsJobHelperConfig({
      schemaVersion: WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION,
      executable: 'C:\\Program Files\\agent.exe',
      args: ['two words', 'quote"value', 'tail\\'],
      parentPid: 42,
    })

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(decodeConfig(encoded)).toEqual({
      schemaVersion: 1,
      executable: 'C:\\Program Files\\agent.exe',
      args: ['two words', 'quote"value', 'tail\\'],
      parentPid: 42,
    })
  })

  it('uses Windows argv quoting for empty, quoted, spaced, and trailing-slash values', () => {
    expect(quoteWindowsCommandLineArgument('')).toBe('""')
    expect(quoteWindowsCommandLineArgument('two words')).toBe('"two words"')
    expect(quoteWindowsCommandLineArgument('quote"value')).toBe('"quote\\"value"')
    expect(quoteWindowsCommandLineArgument('tail\\')).toBe('"tail\\\\"')
    expect(buildWindowsCommandLine('C:\\Program Files\\agent.exe', ['', 'a b']))
      .toBe('"C:\\Program Files\\agent.exe" "" "a b"')
  })

  it('builds a helper invocation and rejects implicit Windows shell scripts', () => {
    const invocation = createWindowsJobInvocation('agent.exe', ['--flag'], {
      helperPath: 'C:\\aw\\aw-windows-job.exe',
      parentPid: 42,
    })
    expect(invocation.command).toBe('C:\\aw\\aw-windows-job.exe')
    expect(invocation.args[0]).toBe('--config')
    expect(decodeConfig(invocation.args[1])).toEqual(invocation.config)
    expect(() => createWindowsJobInvocation('agent.cmd', [], {
      helperPath: 'C:\\aw\\aw-windows-job.exe',
      parentPid: 42,
    })).toThrow('.cmd and .bat targets are unsupported')
  })

  it('rejects unsupported platforms and architectures before dependency resolution', async () => {
    await expect(prepareWindowsJobHelper({ platform: 'linux', arch: 'x64' }))
      .rejects.toMatchObject({ code: 'nativePlatformUnsupported' })
    await expect(resolveWindowsJobHelperPath({ platform: 'win32', arch: 'ia32' }))
      .rejects.toMatchObject({ code: 'nativePlatformUnsupported' })
  })

  it('requires a prepared path for process launch', () => {
    expect(() => createWindowsJobInvocation('agent.exe', [], { helperPath: '' }))
      .toThrow('prepared native helper')
  })
})
