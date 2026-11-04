import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  computeEvalResultSummary,
  getSchema,
  getSchemaDigest,
  parseInstructionV2Receipt,
} from '@lesliechan721/agent-skill-eval'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await readFile(filePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

describe('published Eval package contract', () => {
  it('loads the public export, embedded canonical schema bytes, summary, and CLI', async () => {
    const embeddedDigests = JSON.parse(
      await readFile(path.resolve('dist', 'schemas', 'digests.json'), 'utf8'),
    ) as Record<string, string>
    for (const name of ['eval-spec', 'eval-audit', 'eval-result', 'instruction-v2-request', 'instruction-v2-receipt', 'workflow-fixture-action', 'workflow-evaluation'] as const) {
      const canonical = await readFile(path.resolve('schemas', `${name}.schema.json`))
      const embedded = await readFile(path.resolve('dist', 'schemas', `${name}.schema.json`))
      expect(embedded).toEqual(canonical)
      const schema = await getSchema(name)
      const digest = createHash('sha256').update(JSON.stringify(schema)).digest('hex')
      expect(await getSchemaDigest(name)).toBe(`sha256:${digest}`)
      expect(embeddedDigests[name]).toBe(`sha256:${digest}`)
    }
    expect(parseInstructionV2Receipt({
      protocolVersion: 2, outcome: 'unknown', instructionChannel: 'developer', instructionsRevision: 'runtime-revision',
    })).toEqual({ protocolVersion: 2, outcome: 'unknown', instructionChannel: 'developer', instructionsRevision: 'runtime-revision' })

    expect(computeEvalResultSummary([])).toEqual({ passed: 0, failed: 0, timeout: 0, error: 0 })
    const help = await execFileAsync(process.execPath, [path.resolve('dist/bin.js'), '--help'])
    expect(help.stdout).toContain('spec validate <spec.json>')
    expect(help.stdout).toContain('run <spec.json> --audit <audit.json>')
    expect(help.stdout).toContain('doctor --json')
  })

  it('resolves each isolated Eval installation from its own dependency context without a CLI', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eval-dist-native-')))
    roots.push(root)
    const entryPaths: string[] = []
    const executables: string[] = []
    for (const index of [0, 1]) {
      const dependencyRoot = path.join(root, `installation-${index}`, 'node_modules', '.pnpm', 'eval', 'node_modules')
      const evalRoot = path.join(dependencyRoot, '@lesliechan721', 'agent-skill-eval')
      await mkdir(path.join(evalRoot, 'dist'), { recursive: true })
      await writeFile(path.join(evalRoot, 'package.json'), JSON.stringify({ type: 'module' }))
      const entryPath = path.join(evalRoot, 'dist', 'windows-job.js')
      await copyFile(path.resolve('dist', 'windows-job.js'), entryPath)
      entryPaths.push(entryPath)
      for (const arch of ['x64', 'arm64']) {
        const packageRoot = path.join(dependencyRoot, '@lesliechan721', `aw-windows-job-win32-${arch}`)
        await mkdir(packageRoot, { recursive: true })
        await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: `@lesliechan721/aw-windows-job-win32-${arch}` }))
        const executable = path.join(packageRoot, 'aw-windows-job.exe')
        await writeFile(executable, `helper-${index}-${arch}`)
        executables.push(executable)
      }
    }
    const script = `
      const results = [];
      for (const entry of ${JSON.stringify(entryPaths.map((entry) => pathToFileURL(entry).href))}) {
        const helper = await import(entry);
        for (const arch of ['x64', 'arm64']) {
          results.push(await helper.prepareWindowsJobHelper({ platform: 'win32', arch }));
          results.push(await helper.resolveWindowsJobHelperPath({ platform: 'win32', arch }));
        }
      }
      console.log(JSON.stringify(results));
    `
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: { ...process.env, PATH: '', NODE_PATH: '' },
      timeout: 10_000,
    })
    expect(JSON.parse(result.stdout)).toEqual(executables.flatMap((executable) => [executable, executable]))
    const names = await readdir(path.resolve('dist'), { recursive: true })
    expect(names.filter((name) => /\.exe$/iu.test(name))).toEqual([])
  })

  it('rejects missing optional dependencies even when NODE_PATH has an external helper', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eval-dist-missing-native-')))
    roots.push(root)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await copyFile(path.resolve('dist', 'windows-job.js'), path.join(root, 'windows-job.js'))
    const externalRoot = path.join(root, 'foreign-node-path')
    const externalPackage = path.join(externalRoot, '@lesliechan721', 'aw-windows-job-win32-x64')
    await mkdir(externalPackage, { recursive: true })
    await writeFile(path.join(externalPackage, 'package.json'), JSON.stringify({ name: '@lesliechan721/aw-windows-job-win32-x64' }))
    await writeFile(path.join(externalPackage, 'aw-windows-job.exe'), 'external helper')
    const script = `
      const helper = await import(${JSON.stringify(pathToFileURL(path.join(root, 'windows-job.js')).href)});
      try {
        const executable = await helper.prepareWindowsJobHelper({ platform: 'win32', arch: 'x64' });
        console.log(JSON.stringify({ state: 'ready', executable }));
      } catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
    `
    for (const nodePath of ['', externalRoot]) {
      const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        env: { ...process.env, PATH: '', NODE_PATH: nodePath },
        timeout: 10_000,
      })
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: 'nativePackageUnavailable',
        message: expect.stringContaining('Reinstall the current AW CLI or Eval package with optional dependencies included.'),
      })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'runs signal cleanup from the published export before terminating',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'eval-dist-signal-'))
      roots.push(root)
      const readyPath = path.join(root, 'ready')
      const cleanedPath = path.join(root, 'cleaned')
      const fixturePath = path.join(root, 'fixture.mjs')
      const publishedEntry = pathToFileURL(path.resolve('dist/index.js')).href
      await writeFile(fixturePath, [
        "import { writeFile } from 'node:fs/promises'",
        `import { registerCodexEvalSignalCleanup } from ${JSON.stringify(publishedEntry)}`,
        `registerCodexEvalSignalCleanup(() => writeFile(${JSON.stringify(cleanedPath)}, 'cleaned'))`,
        `await writeFile(${JSON.stringify(readyPath)}, 'ready')`,
        'setTimeout(() => process.exit(124), 10_000)',
      ].join('\n'))

      const child = spawn(process.execPath, [fixturePath], {
        cwd: path.resolve('.'),
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        },
      )
      try {
        await waitForFile(readyPath)
        expect(child.kill('SIGTERM')).toBe(true)
        await expect(closed).resolves.toEqual({ code: null, signal: 'SIGTERM' })
        await expect(readFile(cleanedPath, 'utf8')).resolves.toBe('cleaned')
        expect(stderr).toBe('')
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    },
  )
})
