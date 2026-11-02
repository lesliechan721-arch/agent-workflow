import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildWindowsCommandLine,
  createWindowsJobInvocation,
  encodeWindowsJobHelperConfig,
  prepareWindowsJobHelper,
  quoteWindowsCommandLineArgument,
  resolveWindowsJobHelperPath,
  WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION,
} from '../../src/windows-job.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// Small npm archive fixture. It cannot execute a process.
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-job-resolver-')))
  roots.push(root)
  const bytes = Buffer.alloc(128)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x40, 0x3c)
  bytes.write('PE\0\0', 0x40)
  bytes.writeUInt16LE(0x8664, 0x44)
  const packageName = '@fixture/windows-job-x64'
  const entries = [
    ['package/package.json', Buffer.from(JSON.stringify({ name: packageName, version: '1.0.0' }))],
    ['package/dist/aw-windows-job.exe', bytes],
  ] as const
  const blocks: Buffer[] = []
  for (const [name, body] of entries) {
    const header = Buffer.alloc(512)
    header.write(name)
    header.write('0000700\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
  const descriptor = {
    schemaVersion: 1,
    tool: { id: '@fixture/windows-job', version: '1.0.0', protocol: 'aw.windows-job.v1' },
    variants: [{
      platform: 'win32', arch: 'x64',
      transport: {
        kind: 'npm', package: packageName, version: '1.0.0',
        archiveIntegrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
        entry: 'package/dist/aw-windows-job.exe',
      },
      file: { sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length, format: 'pe', machine: '0x8664' },
      limits: { archiveBytes: 8192, expandedBytes: 8192, entries: 4 },
    }],
  }
  const descriptorPath = path.join(root, 'lock.json')
  const archivePath = path.join(root, 'fixture.tgz')
  await writeFile(descriptorPath, JSON.stringify(descriptor))
  await writeFile(archivePath, archive)
  return { root, bytes, descriptorPath, archivePath, cacheRoot: path.join(root, 'cache'), arch: 'x64' }
}

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

  it('prepares the declared fixture and reuses its cache without the archive or network', async () => {
    const input = await fixture()
    const helperPath = await prepareWindowsJobHelper({ ...input, mode: 'fixture' })
    expect(await readFile(helperPath)).toEqual(input.bytes)
    await rm(input.archivePath)
    await expect(resolveWindowsJobHelperPath(input)).resolves.toBe(helperPath)
  })

  it('does not create a cache on a low-level lookup miss and does not use checkout binaries', async () => {
    const input = await fixture()
    await expect(resolveWindowsJobHelperPath(input)).rejects.toMatchObject({ code: 'nativeCacheMiss' })
    await expect(stat(input.cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires an explicit cache root and a prepared path', async () => {
    await expect(prepareWindowsJobHelper({ cacheRoot: '' })).rejects.toThrow('explicit native cache root')
    expect(() => createWindowsJobInvocation('agent.exe', [], { helperPath: '' }))
      .toThrow('prepared native helper')
  })
})
