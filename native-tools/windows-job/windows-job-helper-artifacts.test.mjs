import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  refreshWindowsJobArtifacts,
  verifyWindowsJobArtifacts,
  verifyWindowsJobReproducibility,
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

// Test Value Gate: the text lock must bind the actual deterministic tarball,
// and the public resolver must accept that archive without a registry call.
test('packs deterministic platform archives accepted by the shared resolver', async (t) => {
  const { packWindowsJobCandidate } = await import('./pack.mjs')
  const { resolveNativeTool } = await import('../../packages/native-runtime/src/index.mjs')
  const options = await fixture(t)
  const first = await packWindowsJobCandidate({ ...options, writeLock: false })
  const archivePath = path.join(first.root, first.candidate.packages[0].path)
  const bytes = await readFile(archivePath)
  // The immutable archive lock must not change with the producing host OS.
  assert.equal(bytes[9], 255)
  const second = await packWindowsJobCandidate({ ...options, writeLock: false })
  assert.deepEqual(await readFile(archivePath), bytes)
  assert.deepEqual(second.descriptor, first.descriptor)
  const ready = await resolveNativeTool({ descriptor: first.descriptor, platform: 'win32', arch: 'x64', cacheRoot: path.join(options.nativeRoot, 'cache'), mode: 'source-candidate', archivePath })
  assert.equal(ready.state, 'ready')
  assert.equal(ready.sha256, first.descriptor.variants.find((variant) => variant.arch === 'x64').file.sha256)
})
