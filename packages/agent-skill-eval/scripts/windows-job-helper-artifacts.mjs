import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultNativeRoot = path.join(packageRoot, 'native', 'windows')
const sourceFiles = ['config.go', 'go.mod', 'main_windows.go']
const buildFlags = ['-trimpath', '-buildvcs=false', '-ldflags=-buildid=']
const fixedEnvironment = {
  CGO_ENABLED: '0',
  GO111MODULE: 'on',
  GOAMD64: 'v1',
  GOARM64: 'v8.0',
  GOENV: 'off',
  GOEXPERIMENT: '',
  GOFLAGS: '',
  GOOS: 'windows',
  GOPROXY: 'off',
  GOSUMDB: 'off',
  GOTOOLCHAIN: 'local',
  GOWORK: 'off',
}
const cacheMode = 'isolated-temporary'
const temporaryEnvironment = {
  GOCACHE: 'go-build-cache',
  GOMODCACHE: 'go-module-cache',
  TEMP: 'go-temp',
  TMP: 'go-temp',
  TMPDIR: 'go-temp',
}
const hostEnvironmentKeys = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
]
const binaries = {
  x64: { goarch: 'amd64', machine: 0x8664 },
  arm64: { goarch: 'arm64', machine: 0xaa64 },
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function artifactPaths(options = {}) {
  const nativeRoot = options.nativeRoot ?? defaultNativeRoot
  return {
    nativeRoot,
    helperSourceRoot: options.helperSourceRoot ?? path.join(nativeRoot, 'job-helper'),
    manifestPath: options.manifestPath ?? path.join(nativeRoot, 'manifest.json'),
  }
}

async function sourceDigest(helperSourceRoot) {
  const hash = createHash('sha256')
  for (const name of sourceFiles) {
    const bytes = await readFile(path.join(helperSourceRoot, name))
    hash.update(`${name}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

function buildEnvironment(goarch, temporaryRoot, inheritedEnvironment = process.env) {
  const hostEnvironment = Object.fromEntries(hostEnvironmentKeys
    .filter((name) => inheritedEnvironment[name] !== undefined)
    .map((name) => [name, inheritedEnvironment[name]]))
  return {
    ...hostEnvironment,
    ...fixedEnvironment,
    GOARCH: goarch,
    ...Object.fromEntries(Object.entries(temporaryEnvironment)
      .map(([name, relativePath]) => [name, path.join(temporaryRoot, relativePath)])),
  }
}

async function prepareTemporaryEnvironment(temporaryRoot) {
  await mkdir(path.join(temporaryRoot, temporaryEnvironment.TMPDIR), { recursive: true })
}

async function runGoDefault(args, options) {
  return execFileAsync('go', args, options)
}

async function identifyGoVersion(runGo, helperSourceRoot, temporaryRoot, inheritedEnvironment) {
  const { stdout } = await runGo(['version'], {
    cwd: helperSourceRoot,
    env: buildEnvironment('amd64', temporaryRoot, inheritedEnvironment),
  })
  const match = /^go version (go\S+) /u.exec(stdout.trim())
  if (!match) throw new Error('Could not identify the Go toolchain version.')
  return match[1]
}

async function buildBinaries(options) {
  const outputPaths = {}
  for (const [arch, expected] of Object.entries(binaries)) {
    const outputPath = path.join(options.temporaryRoot, `${arch}.exe`)
    await options.runGo(['build', ...buildFlags, '-o', outputPath, '.'], {
      cwd: options.helperSourceRoot,
      env: buildEnvironment(
        expected.goarch,
        options.temporaryRoot,
        options.inheritedEnvironment,
      ),
    })
    const bytes = await readFile(outputPath)
    if (peMachine(bytes, `${arch} helper`) !== expected.machine) {
      throw new Error(`Go produced the wrong PE architecture for ${arch}.`)
    }
    outputPaths[arch] = { bytes, outputPath }
  }
  return outputPaths
}

function peMachine(bytes, label) {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`${label} is not a PE executable.`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (
    peOffset + 6 > bytes.length ||
    bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error(`${label} has an invalid PE header.`)
  }
  return bytes.readUInt16LE(peOffset + 4)
}

export async function verifyWindowsJobArtifacts(options = {}) {
  const { nativeRoot, helperSourceRoot, manifestPath } = artifactPaths(options)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.sourceDigest !== await sourceDigest(helperSourceRoot) ||
    !Array.isArray(manifest.build?.flags) ||
    JSON.stringify(manifest.build.flags) !== JSON.stringify(buildFlags) ||
    manifest.build.cgoEnabled !== false ||
    !/^go\d+\.\d+(?:\.\d+)?(?:[a-z0-9.-]+)?$/u.test(manifest.build.goVersion) ||
    manifest.build.cacheMode !== cacheMode ||
    JSON.stringify(manifest.build.temporaryEnvironment) !==
      JSON.stringify(temporaryEnvironment) ||
    JSON.stringify(manifest.build.hostEnvironmentKeys) !==
      JSON.stringify(hostEnvironmentKeys) ||
    JSON.stringify(manifest.build.environment) !== JSON.stringify(fixedEnvironment)
  ) {
    throw new Error('Windows Job helper manifest does not match its source or build contract.')
  }
  for (const [arch, expected] of Object.entries(binaries)) {
    const entry = manifest.binaries?.[arch]
    const relativePath = `${arch}/aw-windows-job.exe`
    if (
      entry?.goarch !== expected.goarch ||
      entry.path !== relativePath ||
      entry.peMachine !== `0x${expected.machine.toString(16)}` ||
      typeof entry.sha256 !== 'string'
    ) {
      throw new Error(`Windows Job helper manifest is invalid for ${arch}.`)
    }
    const bytes = await readFile(path.join(nativeRoot, relativePath))
    if (sha256(bytes) !== entry.sha256 || peMachine(bytes, relativePath) !== expected.machine) {
      throw new Error(`Windows Job helper binary does not match its manifest for ${arch}.`)
    }
  }
  return manifest
}

export async function refreshWindowsJobArtifacts(options = {}) {
  const { nativeRoot, helperSourceRoot, manifestPath } = artifactPaths(options)
  const runGo = options.runGo ?? runGoDefault
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-build-'))
  try {
    await prepareTemporaryEnvironment(temporaryRoot)
    const goVersion = await identifyGoVersion(
      runGo,
      helperSourceRoot,
      temporaryRoot,
      options.inheritedEnvironment,
    )
    const built = await buildBinaries({
      helperSourceRoot,
      inheritedEnvironment: options.inheritedEnvironment,
      runGo,
      temporaryRoot,
    })
    const manifestBinaries = {}
    for (const [arch, expected] of Object.entries(binaries)) {
      const { bytes, outputPath } = built[arch]
      const relativePath = `${arch}/aw-windows-job.exe`
      await mkdir(path.join(nativeRoot, arch), { recursive: true })
      await copyFile(outputPath, path.join(nativeRoot, relativePath))
      manifestBinaries[arch] = {
        goarch: expected.goarch,
        path: relativePath,
        peMachine: `0x${expected.machine.toString(16)}`,
        sha256: sha256(bytes),
      }
    }
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      sourceDigest: await sourceDigest(helperSourceRoot),
      build: {
        goVersion,
        cgoEnabled: false,
        environment: fixedEnvironment,
        cacheMode,
        temporaryEnvironment,
        hostEnvironmentKeys,
        flags: buildFlags,
      },
      binaries: manifestBinaries,
    }, null, 2)}\n`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  await verifyWindowsJobArtifacts(options)
}

export async function verifyWindowsJobReproducibility(options = {}) {
  const { nativeRoot, helperSourceRoot } = artifactPaths(options)
  const manifest = await verifyWindowsJobArtifacts(options)
  const runGo = options.runGo ?? runGoDefault
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-reproduce-'))
  try {
    await prepareTemporaryEnvironment(temporaryRoot)
    const goVersion = await identifyGoVersion(
      runGo,
      helperSourceRoot,
      temporaryRoot,
      options.inheritedEnvironment,
    )
    if (goVersion !== manifest.build.goVersion) {
      throw new Error(
        `Windows Job helper requires Go ${manifest.build.goVersion}; found ${goVersion}.`,
      )
    }
    const rebuilt = await buildBinaries({
      helperSourceRoot,
      inheritedEnvironment: options.inheritedEnvironment,
      runGo,
      temporaryRoot,
    })
    for (const [arch, { bytes }] of Object.entries(rebuilt)) {
      const committed = await readFile(path.join(nativeRoot, manifest.binaries[arch].path))
      if (!bytes.equals(committed)) {
        throw new Error(`Windows Job helper binary is not reproducible for ${arch}.`)
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  return manifest
}

export const windowsJobArtifactContract = {
  buildFlags,
  cacheMode,
  fixedEnvironment,
  hostEnvironmentKeys,
  temporaryEnvironment,
  sourceFiles,
  binaries,
}
