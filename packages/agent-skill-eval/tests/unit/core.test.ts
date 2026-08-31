import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertProviderProcessSupported,
  canonicalJson,
  computeCanonicalDirectoryDigest,
  computeCaseCorpusDigest,
  computeSkillDigest,
  createRuntimeSkillSnapshot,
  getSchema,
  getSchemaDigest,
  runProviderProcess as runProviderProcessWithoutContainment,
} from '../../dist/index.js'

const containedProcessHooks = {
  externalContainment: {
    confirmed: true,
    descendantCleanupGuaranteed: true,
    readOnlySkillSnapshotGuaranteed: true,
  } as const,
  terminateProcessTree: async ({ pid }: { pid: number }) => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
    } catch {
      // The provider can already be closed.
    }
    return { confirmed: true as const }
  },
}

function runProviderProcess(
  ...args: Parameters<typeof runProviderProcessWithoutContainment>
) {
  const [request, hooks = {}, dependencies] = args
  return runProviderProcessWithoutContainment(
    request,
    { ...containedProcessHooks, ...hooks },
    dependencies,
  )
}

const execFileAsync = promisify(execFile)

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

describe('public Eval execution contracts', () => {
  it('uses code-unit key ordering for the canonical case corpus digest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-corpus-'))
    const casePath = path.join(root, 'cases.json')
    try {
      const document = { path: { 'a/b': 1, 'A.b': 2, _key: 3 }, cases: [] }
      await writeFile(casePath, JSON.stringify(document))
      expect(canonicalJson(document)).toBe('{"cases":[],"path":{"A.b":2,"_key":3,"a/b":1}}')
      expect(await computeCaseCorpusDigest([casePath])).toBe(digest(canonicalJson(document)))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints only the v1 command surface and embeds the three v1 schemas', async () => {
    const bin = path.resolve('dist/bin.js')
    const help = await execFileAsync(process.execPath, [bin, '--help'], { cwd: path.resolve('.') })
    expect(help.stdout).toContain('spec validate <spec.json>')
    expect(help.stdout).toContain('run <spec.json> --audit <audit.json>')
    expect(help.stdout).toContain('doctor --json')

    for (const name of ['eval-spec', 'eval-audit', 'eval-result'] as const) {
      const schema = await getSchema(name)
      expect(await getSchemaDigest(name)).toBe(digest(JSON.stringify(schema)))
    }
  })

  it('copies only runtime Skill content without changing the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-snapshot-'))
    const source = path.join(root, 'source')
    const destination = path.join(root, 'snapshot')
    try {
      await mkdir(path.join(source, 'references'), { recursive: true })
      await mkdir(path.join(source, 'evals'), { recursive: true })
      await writeFile(path.join(source, 'SKILL.md'), 'runtime\n')
      await writeFile(path.join(source, 'references', 'guide.md'), 'guide\n')
      await writeFile(path.join(source, '.DS_Store'), 'finder metadata\n')
      await mkdir(path.join(source, 'references', '.DS_Store'))
      await writeFile(path.join(source, 'references', '.DS_Store', 'nested'), 'finder metadata\n')
      await writeFile(path.join(source, '.runtime-hidden'), 'production hidden file\n')
      await writeFile(path.join(source, 'evals', 'case.json'), '{}\n')
      const before = await computeSkillDigest(source)
      const executablePath = path.join(source, 'references', 'guide.md')
      const windowsModeBefore = await computeSkillDigest(source, { platform: 'win32' })
      if (process.platform !== 'win32') {
        await chmod(executablePath, 0o755)
        expect(await computeSkillDigest(source)).not.toBe(before)
        expect(await computeSkillDigest(source, { platform: 'win32' })).toBe(windowsModeBefore)
      }
      const sourceDigest = await computeSkillDigest(source)
      const snapshot = await createRuntimeSkillSnapshot(source, destination)
      expect(snapshot.digest).toBe(sourceDigest)
      await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8')).resolves.toBe('runtime\n')
      await expect(readFile(path.join(destination, '.runtime-hidden'), 'utf8')).resolves.toBe(
        'production hidden file\n',
      )
      await expect(readFile(path.join(destination, '.DS_Store'), 'utf8')).rejects.toThrow()
      await expect(readFile(path.join(destination, 'references', '.DS_Store', 'nested'), 'utf8'))
        .rejects.toThrow()
      await expect(readFile(path.join(destination, 'evals', 'case.json'), 'utf8')).rejects.toThrow()
      expect(await computeSkillDigest(source)).toBe(sourceDigest)
      if (process.platform !== 'win32') {
        expect((await stat(path.join(destination, 'references', 'guide.md'))).mode & 0o777).toBe(0o755)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not collide when binary content encodes a following legacy digest record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-digest-record-'))
    const singleRecord = path.join(root, 'single')
    const twoRecords = path.join(root, 'two')
    await Promise.all([mkdir(singleRecord), mkdir(twoRecords)])
    await writeFile(
      path.join(singleRecord, 'a'),
      Buffer.concat([
        Buffer.from('payload'),
        Buffer.from([0]),
        Buffer.from('b'),
        Buffer.from([0]),
        Buffer.from('100644'),
        Buffer.from([0]),
        Buffer.from('tail'),
      ]),
    )
    await writeFile(path.join(twoRecords, 'a'), 'payload')
    await writeFile(path.join(twoRecords, 'b'), 'tail')

    try {
      expect(await computeSkillDigest(singleRecord)).not.toBe(
        await computeSkillDigest(twoRecords),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects unsupported workspace nodes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-special-node-'))
    try {
      const fifo = path.join(root, 'unsupported-fifo')
      await execFileAsync('mkfifo', [fifo])
      await expect(computeCanonicalDirectoryDigest(root)).rejects.toThrow('unsupported node')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('captures successful, failed, timed-out, and bounded provider processes', async () => {
    const request = {
      executable: process.execPath,
      cwd: path.resolve('.'),
      env: process.env,
      timeoutMs: 2_000,
      maxBufferBytes: 1024,
    }
    const completed = await runProviderProcess({
      ...request,
      args: ['-e', 'process.stdout.write("ok")'],
    })
    expect(completed).toMatchObject({
      stdout: 'ok',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      descendantCleanupGuaranteed: true,
    })

    const failed = await runProviderProcess({
      ...request,
      args: ['-e', 'process.stderr.write("failed");process.exit(7)'],
    })
    expect(failed).toMatchObject({ stderr: 'failed', exitCode: 7, timedOut: false })

    const timedOut = await runProviderProcess({
      ...request,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50,
    })
    expect(timedOut).toMatchObject({ exitCode: null, timedOut: true, cancelled: false })

    const limited = await runProviderProcess({
      ...request,
      args: ['-e', 'process.stdout.write("abcdefghij")'],
      maxBufferBytes: 4,
    })
    expect(limited).toMatchObject({
      stdout: 'abcd',
      terminationReason: 'max-buffer',
      maxBufferExceeded: true,
      stdoutTruncated: true,
    })

    expect(() => assertProviderProcessSupported('linux')).toThrow(
      'explicitly confirmed external containment',
    )
  })
})
