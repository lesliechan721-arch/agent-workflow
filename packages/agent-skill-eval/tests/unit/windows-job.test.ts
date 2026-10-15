import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  buildWindowsCommandLine,
  createWindowsJobInvocation,
  encodeWindowsJobHelperConfig,
  quoteWindowsCommandLineArgument,
  resolveWindowsJobHelperPath,
  WINDOWS_JOB_HELPER_CONFIG_SCHEMA_VERSION,
} from '../../src/windows-job.js'
import {
  verifyWindowsJobArtifacts,
  verifyWindowsJobReproducibility,
  windowsJobArtifactContract,
} from '../../scripts/windows-job-helper-artifacts.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const nativeRoot = path.join(packageRoot, 'native', 'windows')
const repositoryRoot = path.resolve(packageRoot, '..', '..')
const execFileAsync = promisify(execFile)

type GitAttributes = Map<string, Map<string, string>>

function parseGitAttributes(output: string): GitAttributes {
  const attributes: GitAttributes = new Map()
  for (const line of output.trim().split('\n')) {
    const match = /^(.*): ([^:]+): (.*)$/u.exec(line)
    if (!match) continue
    const [, file, attribute, value] = match
    const fileAttributes = attributes.get(file) ?? new Map<string, string>()
    fileAttributes.set(attribute, value)
    attributes.set(file, fileAttributes)
  }
  return attributes
}

async function findExecutable(name: string): Promise<string> {
  const names = process.platform === 'win32'
    ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name]
    : [name]
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const candidateName of names) {
      const candidate = path.join(directory, candidateName)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`Could not find ${name} on PATH.`)
}

async function runPnpm(
  pnpmPath: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd = repositoryRoot,
): Promise<void> {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(pnpmPath)) {
    await execFileAsync(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `call "${pnpmPath}" ${args.join(' ')}`,
    ], { cwd, env: environment })
    return
  }
  await execFileAsync(pnpmPath, args, { cwd, env: environment })
}

async function writePnpmProbe(directory: string, logPath: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(path.join(directory, 'pnpm.cmd'), [
      '@echo off',
      `echo %*>> "${logPath}"`,
    ].join('\r\n'))
    return
  }
  const probePath = path.join(directory, 'pnpm')
  await writeFile(probePath, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$AW_WINDOWS_JOB_PNPM_LOG"',
  ].join('\n'))
  await chmod(probePath, 0o755)
}

async function writeFailingGoProbe(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(path.join(directory, 'go.cmd'), '@echo Go must not run.\r\n@exit /b 41\r\n')
    return
  }
  const probePath = path.join(directory, 'go')
  await writeFile(probePath, '#!/bin/sh\necho "Go must not run." >&2\nexit 41\n')
  await chmod(probePath, 0o755)
}

async function writePassingTscProbe(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path.join(directory, 'tsc.cmd'), '@exit /b 0\r\n')
    return
  }
  const probePath = path.join(directory, 'tsc')
  await writeFile(probePath, '#!/bin/sh\nexit 0\n')
  await chmod(probePath, 0o755)
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

  it.each([
    ['x64', 0x8664],
    ['arm64', 0xaa64],
  ] as const)('resolves a regular %s PE helper with the expected machine', async (arch, machine) => {
    const expectedSpecifier = `@lesliechan721/aw-windows-job-win32-${arch}/aw-windows-job.exe`
    const helperPath = resolveWindowsJobHelperPath({
      arch,
      resolvePackage: (specifier) => {
        expect(specifier).toBe(expectedSpecifier)
        return path.join(nativeRoot, arch, 'aw-windows-job.exe')
      },
    })
    const bytes = await readFile(helperPath)
    const peOffset = bytes.readUInt32LE(0x3c)

    expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ')
    expect(bytes.subarray(peOffset, peOffset + 4).toString('ascii')).toBe('PE\0\0')
    expect(bytes.readUInt16LE(peOffset + 4)).toBe(machine)
  })

  it('keeps helper source checkouts LF-only and PE artifacts binary', async () => {
    const helperSources = [
      'packages/agent-skill-eval/native/windows/job-helper/config.go',
      'packages/agent-skill-eval/native/windows/job-helper/config_test.go',
      'packages/agent-skill-eval/native/windows/job-helper/go.mod',
      'packages/agent-skill-eval/native/windows/job-helper/main_windows.go',
    ]
    const binaries = [
      'packages/agent-skill-eval/native/windows/x64/aw-windows-job.exe',
      'packages/agent-skill-eval/native/windows/arm64/aw-windows-job.exe',
    ]
    const unrelatedSource = 'packages/agent-skill-eval/src/windows-job.ts'
    const { stdout } = await execFileAsync('git', [
      'check-attr',
      'text',
      'eol',
      'diff',
      '--',
      ...helperSources,
      ...binaries,
      unrelatedSource,
    ], { cwd: repositoryRoot })
    const attributes = parseGitAttributes(stdout)

    for (const helperSource of helperSources) {
      expect(attributes.get(helperSource)?.get('text')).toBe('set')
      expect(attributes.get(helperSource)?.get('eol')).toBe('lf')
    }
    for (const binary of binaries) {
      expect(attributes.get(binary)?.get('text')).toBe('unset')
      expect(attributes.get(binary)?.get('diff')).toBe('unset')
    }
    expect(attributes.get(unrelatedSource)?.get('text')).toBe('auto')
    expect(attributes.get(unrelatedSource)?.get('eol')).toBe('lf')
    expect(attributes.get(unrelatedSource)?.get('diff')).toBe('unspecified')
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

  it('verifies source, toolchain flags, binary digests, and PE architectures', async () => {
    await expect(verifyWindowsJobArtifacts()).resolves.toMatchObject({
      schemaVersion: 1,
      build: {
        goVersion: expect.stringMatching(/^go\d+\./u),
        cgoEnabled: false,
        environment: windowsJobArtifactContract.fixedEnvironment,
        cacheMode: 'isolated-temporary',
        temporaryEnvironment: windowsJobArtifactContract.temporaryEnvironment,
        hostEnvironmentKeys: windowsJobArtifactContract.hostEnvironmentKeys,
        flags: ['-trimpath', '-buildvcs=false', '-ldflags=-buildid='],
      },
      binaries: {
        x64: { peMachine: '0x8664' },
        arm64: { peMachine: '0xaa64' },
      },
    })
  })

  it('stages platform package helpers and verifies ordinary artifacts without Go', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-build-test-'))
    const fixtureRepositoryRoot = path.join(temporaryRoot, 'repo')
    const fixturePackageRoot = path.join(
      fixtureRepositoryRoot,
      'packages',
      'agent-skill-eval',
    )
    const fixtureX64PackageRoot = path.join(
      fixtureRepositoryRoot,
      'packages',
      'aw-windows-job-win32-x64',
    )
    const fixtureArm64PackageRoot = path.join(
      fixtureRepositoryRoot,
      'packages',
      'aw-windows-job-win32-arm64',
    )
    const probeDirectory = path.join(temporaryRoot, 'bin')
    try {
      await mkdir(fixturePackageRoot, { recursive: true })
      await copyFile(
        path.join(packageRoot, 'package.json'),
        path.join(fixturePackageRoot, 'package.json'),
      )
      await mkdir(fixtureX64PackageRoot, { recursive: true })
      await mkdir(fixtureArm64PackageRoot, { recursive: true })
      await copyFile(
        path.join(repositoryRoot, 'packages', 'aw-windows-job-win32-x64', 'package.json'),
        path.join(fixtureX64PackageRoot, 'package.json'),
      )
      await copyFile(
        path.join(repositoryRoot, 'packages', 'aw-windows-job-win32-arm64', 'package.json'),
        path.join(fixtureArm64PackageRoot, 'package.json'),
      )
      await cp(nativeRoot, path.join(fixturePackageRoot, 'native', 'windows'), { recursive: true })
      await cp(path.join(packageRoot, 'scripts'), path.join(fixturePackageRoot, 'scripts'), {
        recursive: true,
      })
      await cp(path.join(packageRoot, 'schemas'), path.join(fixturePackageRoot, 'schemas'), {
        recursive: true,
      })
      await writeFailingGoProbe(probeDirectory)
      await writePassingTscProbe(probeDirectory)
      const environment = {
        ...process.env,
        PATH: `${probeDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      }
      const pnpmPath = await findExecutable('pnpm')

      await runPnpm(pnpmPath, ['run', 'build'], environment, fixturePackageRoot)
      await runPnpm(pnpmPath, ['run', 'build'], environment, fixtureX64PackageRoot)
      await runPnpm(pnpmPath, ['run', 'build'], environment, fixtureArm64PackageRoot)
      await runPnpm(pnpmPath, ['run', 'windows-job:verify'], environment, fixturePackageRoot)

      await expect(readFile(path.join(
        fixtureX64PackageRoot,
        'dist',
        'aw-windows-job.exe',
      ))).resolves.toEqual(await readFile(path.join(
        fixturePackageRoot,
        'native',
        'windows',
        'x64',
        'aw-windows-job.exe',
      )))
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('runs the reproducibility gate before smoke build in release delivery', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-delivery-test-'))
    const probeDirectory = path.join(temporaryRoot, 'bin')
    const logPath = path.join(temporaryRoot, 'pnpm.log')
    try {
      const pnpmPath = await findExecutable('pnpm')
      await writePnpmProbe(probeDirectory, logPath)
      await runPnpm(pnpmPath, ['run', 'release:verify:delivery'], {
        ...process.env,
        AW_WINDOWS_JOB_PNPM_LOG: logPath,
        PATH: `${probeDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      })

      expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
        'windows-job:reproducibility',
        'test:smoke:build',
      ])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rebuilds with fixed Go settings when the caller environment is polluted', async () => {
    const manifest = await verifyWindowsJobArtifacts()
    const buildEnvironments: NodeJS.ProcessEnv[] = []
    const runGo = async (args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === 'version') {
        return { stdout: `go version ${manifest.build.goVersion} darwin/arm64\n`, stderr: '' }
      }
      buildEnvironments.push(options.env)
      const outputPath = args[args.indexOf('-o') + 1]
      const arch = options.env.GOARCH === 'amd64' ? 'x64' : 'arm64'
      await copyFile(
        path.join(nativeRoot, arch, 'aw-windows-job.exe'),
        outputPath,
      )
      return { stdout: '', stderr: '' }
    }

    await verifyWindowsJobReproducibility({
      inheritedEnvironment: {
        ...process.env,
        FOREIGN_GO_SETTING: 'must-not-pass',
        GOAMD64: 'v3',
        GOARM64: 'v9.9',
        GOENV: '/tmp/foreign-go-env',
        GOEXPERIMENT: 'foreign-experiment',
        GOFLAGS: '-x',
        GOTOOLCHAIN: 'auto',
        GOWORK: '/tmp/foreign-go.work',
      },
      runGo,
    })

    expect(buildEnvironments).toHaveLength(2)
    for (const environment of buildEnvironments) {
      expect(environment).toMatchObject(windowsJobArtifactContract.fixedEnvironment)
      expect(environment.GOCACHE).toContain('aw-windows-job-reproduce-')
      expect(environment.GOMODCACHE).toContain('aw-windows-job-reproduce-')
    }
    expect(buildEnvironments.map((environment) => environment.GOARCH))
      .toEqual(['amd64', 'arm64'])
    expect(buildEnvironments[0]).not.toHaveProperty('FOREIGN_GO_SETTING')
  })

  it('rejects a local Go version that differs from the manifest toolchain', async () => {
    const manifest = await verifyWindowsJobArtifacts()
    await expect(verifyWindowsJobReproducibility({
      runGo: async () => ({ stdout: 'go version go9.9.9 darwin/arm64\n', stderr: '' }),
    })).rejects.toThrow(`requires Go ${manifest.build.goVersion}; found go9.9.9`)
  })

  it('rejects a re-hashed PE that does not match a source rebuild', async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-test-'))
    const copiedNativeRoot = path.join(temporaryRoot, 'windows')
    try {
      await cp(nativeRoot, copiedNativeRoot, { recursive: true })
      const copiedBinaryPath = path.join(copiedNativeRoot, 'x64', 'aw-windows-job.exe')
      const changed = Buffer.from(await readFile(copiedBinaryPath))
      changed[changed.length - 1] ^= 1
      await writeFile(copiedBinaryPath, changed)
      const copiedManifestPath = path.join(copiedNativeRoot, 'manifest.json')
      const copiedManifest = JSON.parse(await readFile(copiedManifestPath, 'utf8'))
      copiedManifest.binaries.x64.sha256 = `sha256:${createHash('sha256')
        .update(changed).digest('hex')}`
      await writeFile(copiedManifestPath, `${JSON.stringify(copiedManifest, null, 2)}\n`)

      await expect(verifyWindowsJobArtifacts({ nativeRoot: copiedNativeRoot }))
        .resolves.toBeTruthy()
      const runGo = async (args: string[], options: { env: NodeJS.ProcessEnv }) => {
        if (args[0] === 'version') {
          return {
            stdout: `go version ${copiedManifest.build.goVersion} darwin/arm64\n`,
            stderr: '',
          }
        }
        const outputPath = args[args.indexOf('-o') + 1]
        const arch = options.env.GOARCH === 'amd64' ? 'x64' : 'arm64'
        await copyFile(path.join(nativeRoot, arch, 'aw-windows-job.exe'), outputPath)
        return { stdout: '', stderr: '' }
      }
      await expect(verifyWindowsJobReproducibility({
        nativeRoot: copiedNativeRoot,
        runGo,
      })).rejects.toThrow('not reproducible for x64')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
