import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import {
  refreshWindowsJobArtifacts,
  verifyWindowsJobArtifacts,
  verifyWindowsJobReproducibility,
  windowsJobArtifactContract,
} from './windows-job-helper-artifacts.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-artifact-contract-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const nativeRoot = path.join(root, 'native')
  const helperSourceRoot = path.join(nativeRoot, 'job-helper')
  await mkdir(helperSourceRoot, { recursive: true })
  await writeFile(path.join(helperSourceRoot, 'go.mod'), 'module fixture\ngo 1.25\n')
  await writeFile(path.join(helperSourceRoot, 'main_windows.go'), 'package main\nfunc main() {}\n')
  const runGo = async (args, options) => {
    if (args[0] === 'version') return { stdout: 'go version go1.25.7 darwin/arm64\n' }
    const bytes = Buffer.alloc(256)
    bytes.write('MZ')
    bytes.writeUInt32LE(0x80, 0x3c)
    bytes.write('PE\0\0', 0x80)
    bytes.writeUInt16LE(options.env.GOARCH === 'amd64' ? 0x8664 : 0xaa64, 0x84)
    await writeFile(args[args.indexOf('-o') + 1], bytes)
    return { stdout: '' }
  }
  const options = { nativeRoot, helperSourceRoot, runGo }
  await refreshWindowsJobArtifacts(options)
  return options
}

// Test Value Gate: newly added production source and module changes must make
// previously built artifacts stale; tests must not require an artifact refresh.
test('binds every production Go file and module to the artifact digest', async (t) => {
  const options = await fixture(t)
  await writeFile(path.join(options.helperSourceRoot, 'main_test.go'), 'package main\n')
  await verifyWindowsJobArtifacts(options)
  await mkdir(path.join(options.helperSourceRoot, 'internal'), { recursive: true })
  const added = path.join(options.helperSourceRoot, 'internal', 'operation_windows.go')
  await writeFile(added, 'package internal\n')
  await assert.rejects(verifyWindowsJobArtifacts(options), /does not match its source/)
  await refreshWindowsJobArtifacts(options)
  await verifyWindowsJobArtifacts(options)
  await writeFile(added, 'package internal\nconst changed = true\n')
  await assert.rejects(verifyWindowsJobArtifacts(options), /does not match its source/)
  await rm(added)
  await refreshWindowsJobArtifacts(options)
  await writeFile(path.join(options.helperSourceRoot, 'go.mod'), 'module changed\ngo 1.25\n')
  await assert.rejects(verifyWindowsJobArtifacts(options), /does not match its source/)
})

// Test Value Gate: fixed-toolchain builds must reject a different toolchain before writing artifacts.
test('requires the pinned Go version before producing candidates', async (t) => {
  const options = await fixture(t)
  await assert.rejects(refreshWindowsJobArtifacts({ ...options, goVersion: 'go1.99.0' }), /requires Go/)
  await verifyWindowsJobArtifacts(options)
})

// Test Value Gate: a source-matching manifest cannot authorize the wrong PE
// architecture or modified bytes, including the strong release path.
test('rejects damaged binary bytes and accepts a matching isolated rebuild', async (t) => {
  const options = await fixture(t)
  await verifyWindowsJobReproducibility(options)
  await writeFile(path.join(options.nativeRoot, 'x64/aw-windows-job.exe'), 'damaged')
  await assert.rejects(verifyWindowsJobArtifacts(options), /binary does not match/)
})

// Test Value Gate: the two npm packages must use the selected CLI version,
// expose npm platform metadata, and contain the exact candidate helper bytes.
// These synthetic PE files prove packaging and injection, not Windows qualification.
test('packs deterministic CLI-version platform archives and extracts the selected helper', async (t) => {
  const { packWindowsJobCandidate } = await import('./pack.mjs')
  const { extractCandidateHelper, readCandidate, readCandidatePackage } = await import('./candidate.mjs')
  const options = { ...await fixture(t), version: '2.3.4-beta.7' }
  const first = await packWindowsJobCandidate(options)
  assert.equal(first.candidate.version, options.version)
  const archives = await Promise.all(first.tarballPaths.map((target) => readFile(target)))
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    assert.equal(archives[index][9], 255)
    const unpacked = readCandidatePackage(archives[index], { arch, version: options.version })
    assert.equal(unpacked.metadata.name, `@lesliechan721/aw-windows-job-win32-${arch}`)
    assert.deepEqual(unpacked.metadata.os, ['win32'])
    assert.deepEqual(unpacked.metadata.cpu, [arch])
    assert.deepEqual(unpacked.executable, await readFile(path.join(options.nativeRoot, arch, 'aw-windows-job.exe')))
    const ready = await extractCandidateHelper(first, { arch, destination: path.join(options.nativeRoot, `installed-${arch}`) })
    assert.deepEqual(Object.keys(ready).sort(), ['executable', 'protocol', 'state'])
    assert.equal(ready.state, 'ready')
    assert.deepEqual(await readFile(ready.executable), unpacked.executable)
  }
  const second = await packWindowsJobCandidate(options)
  assert.equal(second.candidateDigest, first.candidateDigest)
  assert.deepEqual(await Promise.all(second.tarballPaths.map((target) => readFile(target))), archives)
  await readCandidate(first.root, options)
  await assert.rejects(readCandidate(first.root, { ...options, version: '2.3.5' }), /CLI version or tool source/)
  await writeFile(first.tarballPaths[0], 'damaged candidate archive')
  await assert.rejects(readCandidate(first.root, options), /archive changed/)
})

// Test Value Gate: fixture reports can test the evidence gate, but only reports
// for both real Windows architectures and this exact candidate pass that gate.
test('requires both Windows qualification reports bound to this candidate', async (t) => {
  const { buildWindowsJobCandidate } = await import('./pack.mjs')
  const { writeAtomicJson } = await import('./candidate.mjs')
  const { assertWindowsJobCandidateEvidence } = await import('./evidence.mjs')
  const { WINDOWS_JOB_REQUIRED_CHECKS } = await import('../../scripts/qualification/windows-job-containment.mjs')
  const options = { ...await fixture(t), version: '2.3.4' }
  const selected = await buildWindowsJobCandidate(options)
  await assert.rejects(assertWindowsJobCandidateEvidence(selected), /Real Windows x64 and arm64 qualification/)
  const report = (arch) => ({
    schemaVersion: 1, kind: 'windows-job-qualification', mode: 'source-candidate',
    platform: 'win32', arch, status: 'passed', candidateDigest: selected.candidateDigest,
    sourceDigest: selected.candidate.sourceDigest,
    checks: [...WINDOWS_JOB_REQUIRED_CHECKS, 'plugin-files-acl-cross-volume', 'go-native-tests'].map((id) => ({ id, passed: true })),
  })
  for (const arch of ['x64', 'arm64']) await writeAtomicJson(path.join(selected.root, `qualification-${arch}.json`), report(arch))
  assert.equal((await assertWindowsJobCandidateEvidence(selected)).length, 4)
  await writeFile(path.join(selected.root, 'qualification-x64.json'), '{invalid JSON')
  await assert.rejects(assertWindowsJobCandidateEvidence(selected), /Real Windows x64 and arm64 qualification/)
  await writeAtomicJson(path.join(selected.root, 'qualification-x64.json'), report('x64'))
  await writeAtomicJson(path.join(selected.root, 'qualification-arm64.json'), { ...report('arm64'), checks: [null] })
  await assert.rejects(assertWindowsJobCandidateEvidence(selected), /Real Windows x64 and arm64 qualification/)
  await writeAtomicJson(path.join(selected.root, 'qualification-arm64.json'), { ...report('arm64'), candidateDigest: 'other-candidate' })
  await assert.rejects(assertWindowsJobCandidateEvidence(selected), /exact candidate/)
  await rm(path.join(selected.root, 'reproducibility.json'))
  await assert.rejects(assertWindowsJobCandidateEvidence(selected), /x64 and arm64 reproducibility evidence/)
  await writeFile(path.join(selected.root, 'reproducibility.json'), 'null')
  await assert.rejects(assertWindowsJobCandidateEvidence(selected), /x64 and arm64 reproducibility evidence/)
})

// Test Value Gate: source Windows integration uses Eval's real dependency
// context. An environment-only helper must not hide an empty workspace package.
// Synthetic bytes prove this preparation wiring, not native Windows behavior.
test('prepares a clean workspace optional dependency from the current architecture candidate', async (t) => {
  const { packWindowsJobCandidate } = await import('./pack.mjs')
  const { prepareWindowsJobSourceTestEnvironment } = await import('./test-environment.mjs')
  const options = await fixture(t)
  const repoRoot = path.join(options.nativeRoot, 'workspace')
  const evalRoot = path.join(repoRoot, 'packages/agent-skill-eval')
  await mkdir(path.join(evalRoot, 'node_modules/@lesliechan721'), { recursive: true })
  await writeFile(path.join(evalRoot, 'package.json'), JSON.stringify({ name: '@lesliechan721/agent-skill-eval', version: '2.3.4' }))
  for (const arch of ['x64', 'arm64']) {
    const packageRoot = path.join(repoRoot, `packages/aw-windows-job-win32-${arch}`)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), await readFile(new URL(`../../packages/aw-windows-job-win32-${arch}/package.json`, import.meta.url)))
    await symlink(packageRoot, path.join(evalRoot, `node_modules/@lesliechan721/aw-windows-job-win32-${arch}`), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const selected = await packWindowsJobCandidate({ ...options, repoRoot, version: '2.3.4' })
  const x64Path = path.join(repoRoot, 'packages/aw-windows-job-win32-x64/dist/aw-windows-job.exe')
  const arm64Path = path.join(repoRoot, 'packages/aw-windows-job-win32-arm64/dist/aw-windows-job.exe')
  await assert.rejects(readFile(x64Path), { code: 'ENOENT' })
  await assert.rejects(readFile(arm64Path), { code: 'ENOENT' })
  const ready = await prepareWindowsJobSourceTestEnvironment({ ...options, repoRoot, root: selected.root, platform: 'win32', arch: 'x64' })
  assert.equal(await realpath(ready.executable), await realpath(x64Path))
  assert.deepEqual(await readFile(ready.executable), await readFile(path.join(options.nativeRoot, 'x64/aw-windows-job.exe')))
  await assert.rejects(readFile(arm64Path), { code: 'ENOENT' })
  await writeFile(x64Path, 'stale workspace helper')
  const refreshed = await prepareWindowsJobSourceTestEnvironment({ ...options, repoRoot, root: selected.root, platform: 'win32', arch: 'x64' })
  assert.deepEqual(await readFile(refreshed.executable), await readFile(path.join(options.nativeRoot, 'x64/aw-windows-job.exe')))
  const foreignRoot = path.join(repoRoot, 'foreign-platform-package')
  await mkdir(path.join(foreignRoot, 'dist'), { recursive: true })
  await writeFile(path.join(foreignRoot, 'package.json'), JSON.stringify({ name: '@lesliechan721/aw-windows-job-win32-arm64', exports: { './aw-windows-job.exe': './dist/aw-windows-job.exe' } }))
  const foreignExecutable = path.join(foreignRoot, 'dist/aw-windows-job.exe')
  await writeFile(foreignExecutable, 'foreign helper must remain unchanged')
  const dependencyLink = path.join(evalRoot, 'node_modules/@lesliechan721/aw-windows-job-win32-arm64')
  await rm(dependencyLink)
  await symlink(foreignRoot, dependencyLink, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareWindowsJobSourceTestEnvironment({ ...options, repoRoot, root: selected.root, platform: 'win32', arch: 'arm64' }), /Eval must resolve the workspace platform package/)
  assert.equal(await readFile(foreignExecutable, 'utf8'), 'foreign helper must remain unchanged')
})

// Test Value Gate: a new repair run has only the original verified prepared
// archive. Native source manifests, bare binaries, a current-run native artifact
// and rebuilding must not be necessary to prepare its plugin test dependency.
test('prepares the original helper from a recovered prepared archive without source build artifacts', async (t) => {
  const { packWindowsJobCandidate } = await import('./pack.mjs')
  const { bytesDigest, writeAtomicJson } = await import('./candidate.mjs')
  const { prepareWindowsJobSourceTestEnvironment } = await import('./test-environment.mjs')
  const { WINDOWS_JOB_REQUIRED_CHECKS } = await import('../../scripts/qualification/windows-job-containment.mjs')
  const { archiveCandidate, extractCandidate, sealCandidateDirectory } = await import('../../scripts/release/candidate-archive.mjs')
  const { CLI_RELEASE_PACKAGES, computePackageTarballTreeDigest } = await import('../../scripts/release/common.mjs')
  const { calculateCanonicalDigest } = await import('../../scripts/release/release-model.mjs')
  const options = await fixture(t)
  const repoRoot = path.join(options.nativeRoot, 'workspace')
  const evalRoot = path.join(repoRoot, 'packages/agent-skill-eval')
  await mkdir(path.join(evalRoot, 'node_modules/@lesliechan721'), { recursive: true })
  await writeFile(path.join(evalRoot, 'package.json'), JSON.stringify({ name: '@lesliechan721/agent-skill-eval', version: '2.3.4' }))
  for (const arch of ['x64', 'arm64']) {
    const packageRoot = path.join(repoRoot, `packages/aw-windows-job-win32-${arch}`)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), await readFile(new URL(`../../packages/aw-windows-job-win32-${arch}/package.json`, import.meta.url)))
    await symlink(packageRoot, path.join(evalRoot, `node_modules/@lesliechan721/aw-windows-job-win32-${arch}`), process.platform === 'win32' ? 'junction' : 'dir')
  }
  await execFileAsync('git', ['init', '--quiet'], { cwd: repoRoot })
  await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'source candidate'], { cwd: repoRoot })
  const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
  const selected = await packWindowsJobCandidate({ ...options, repoRoot, version: '2.3.4' })
  const helperBytes = await readFile(path.join(options.nativeRoot, 'x64/aw-windows-job.exe'))
  await writeAtomicJson(path.join(selected.root, 'reproducibility.json'), {
    schemaVersion: 1, kind: 'windows-job-reproducibility', status: 'passed', candidateDigest: selected.candidateDigest,
    sourceDigest: selected.candidate.sourceDigest, goVersion: selected.candidate.goVersion, architectures: ['x64', 'arm64'],
  })
  for (const arch of ['x64', 'arm64']) await writeAtomicJson(path.join(selected.root, `qualification-${arch}.json`), {
    schemaVersion: 1, kind: 'windows-job-qualification', mode: 'source-candidate', platform: 'win32', arch, status: 'passed',
    candidateDigest: selected.candidateDigest, sourceDigest: selected.candidate.sourceDigest,
    checks: [...WINDOWS_JOB_REQUIRED_CHECKS, 'plugin-files-acl-cross-volume', 'go-native-tests'].map((id) => ({ id, passed: true })),
  })
  const originalRoot = path.join(options.nativeRoot, 'original-run')
  const preparedRoot = path.join(originalRoot, 'cli/prepared')
  const artifacts = path.join(preparedRoot, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  const nativeEvidence = []
  for (const name of ['candidate.json', 'reproducibility.json', 'qualification-x64.json', 'qualification-arm64.json']) {
    const bytes = await readFile(path.join(selected.root, name))
    await writeFile(path.join(artifacts, name), bytes)
    nativeEvidence.push({ name, path: `artifacts/${name}`, contentDigest: bytesDigest(bytes) })
  }
  const packages = []
  const treeDigests = {}
  for (const [index, { name }] of CLI_RELEASE_PACKAGES.entries()) {
    const native = selected.candidate.packages.find((entry) => entry.name === name)
    const fileName = native?.path ?? `generic-${index}.tgz`
    const target = path.join(artifacts, fileName)
    if (native) await writeFile(target, await readFile(path.join(selected.root, native.path)))
    else {
      const packageParent = path.join(options.nativeRoot, `generic-${index}`)
      await mkdir(path.join(packageParent, 'package'), { recursive: true })
      const metadata = { name, version: selected.candidate.version }
      if (name === '@lesliechan721/agent-skill-eval') metadata.optionalDependencies = Object.fromEntries(selected.candidate.packages.map((entry) => [entry.name, selected.candidate.version]))
      if (name === '@lesliechan721/aw') metadata.dependencies = { '@lesliechan721/agent-skill-eval': selected.candidate.version, '@lesliechan721/aw-plugin-core': selected.candidate.version }
      await writeFile(path.join(packageParent, 'package/package.json'), JSON.stringify(metadata))
      await execFileAsync('tar', ['-czf', target, '-C', packageParent, 'package'])
    }
    packages.push({ name, path: `artifacts/${fileName}`, contentDigest: bytesDigest(await readFile(target)) })
    treeDigests[name] = await computePackageTarballTreeDigest(target, { normalizeReleaseMetadata: true, expectedPackageName: name, expectedVersion: selected.candidate.version })
  }
  const descriptor = {
    schemaVersion: 1, channel: 'stable', axes: { cli: true, catalog: false }, source: { head }, build: {},
    candidates: { cli: selected.candidate.version, catalog: null }, catalog: null,
    npm: { version: selected.candidate.version, packages, nativeEvidence, treeDigests },
  }
  await writeAtomicJson(path.join(preparedRoot, 'descriptor.json'), descriptor)
  await writeAtomicJson(path.join(originalRoot, 'cli/attempted.json'), { fixture: 'unchanged original attempt' })
  const metadata = { product: 'cli', channel: 'stable', version: selected.candidate.version, sourceHead: head, candidateHead: head, descriptorDigest: calculateCanonicalDigest(descriptor) }
  await sealCandidateDirectory(originalRoot, metadata)
  const archivePath = path.join(options.nativeRoot, 'original-candidate.tar')
  const archiveDigest = await archiveCandidate(originalRoot, archivePath)
  const recoveryRoot = path.join(options.nativeRoot, 'recovery-run')
  await extractCandidate(archivePath, recoveryRoot, archiveDigest)
  for (const relative of ['manifest.json', 'x64', 'arm64', 'candidate.json', 'reproducibility.json', 'qualification-x64.json', 'qualification-arm64.json']) await rm(path.join(options.nativeRoot, relative), { recursive: true, force: true })
  for (const file of selected.tarballPaths) await rm(file)
  await rm(originalRoot, { recursive: true, force: true })
  const ready = await prepareWindowsJobSourceTestEnvironment({ repoRoot, preparedCandidateRoot: recoveryRoot, platform: 'win32', arch: 'x64' })
  assert.deepEqual(await readFile(ready.executable), helperBytes)
  assert.equal(await realpath(ready.executable), await realpath(path.join(repoRoot, 'packages/aw-windows-job-win32-x64/dist/aw-windows-job.exe')))
  await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'unrelated source'], { cwd: repoRoot })
  await assert.rejects(prepareWindowsJobSourceTestEnvironment({ repoRoot, preparedCandidateRoot: recoveryRoot, platform: 'win32', arch: 'x64' }), /candidateHead/)
  await execFileAsync('git', ['checkout', '--quiet', '--detach', head], { cwd: repoRoot })
  await writeFile(path.join(recoveryRoot, 'cli/prepared', packages[0].path), 'changed saved native archive')
  await assert.rejects(prepareWindowsJobSourceTestEnvironment({ repoRoot, preparedCandidateRoot: recoveryRoot, platform: 'win32', arch: 'x64' }), /files changed|missing/)
})
