import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CODEX_CONTRACT_VERSIONS,
  runCodexNativePerformanceQualification,
} from './codex-native-performance-lib.mjs'

const fakeCodexSource = String.raw`
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const worktreeCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
})
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME,
  home: process.env.HOME,
  awHome: process.env.AW_HOME,
  proxy: process.env.HTTPS_PROXY,
  gitWorktree: worktreeCheck.status === 0 && worktreeCheck.stdout.trim() === 'true',
}) + '\n')
if (args[0] === '--version') process.stdout.write('codex-cli ' + process.env.FAKE_CODEX_VERSION + '\n')
else if (args.includes('list')) process.stdout.write((process.env.FAKE_CODEX_LIST_OUTPUT || '{"installed":[],"available":[]}') + '\n')
else process.stdout.write('{}\n')
`

test('covers the scoped-list and local-install contract for all qualified Codex versions', async () => {
  for (const version of CODEX_CONTRACT_VERSIONS) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aw-codex-performance-contract-'))
    try {
      const executable = path.join(root, 'fake-codex.mjs')
      const logPath = path.join(root, 'calls.jsonl')
      await writeFile(executable, fakeCodexSource, 'utf8')
      const report = await runCodexNativePerformanceQualification({
        requiredVersion: version,
        codexCommand: process.execPath,
        codexArgsPrefix: [executable],
        samples: 3,
        tempParent: root,
        baseEnv: { ...process.env, FAKE_CODEX_VERSION: version, FAKE_CODEX_LOG: logPath },
      })
      assert.equal(report.result, 'passed')
      assert.equal(report.actualVersion, version)
      assert.equal(report.contracts.marketplaceScopedJsonList, true)
      assert.equal(report.contracts.installationMedianMs < 15_000, true)
      assert.equal(
        report.contracts.localScopedListWithoutRemote,
        version === '0.153.0' ? true : 'not-required',
      )
      const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
      const lists = calls.filter((call) => call.args.includes('list'))
      assert.equal(lists.length, 3)
      assert.equal(lists.every((call) => call.args.slice(-5).join(' ')
        === 'plugin list --marketplace aw-native-performance --json'), true)
      assert.equal(calls.every((call) => call.proxy === 'http://127.0.0.1:1'), true)
      assert.equal(new Set(calls.map((call) => call.codexHome)).size, 3)
      assert.equal(calls.every((call) => path.basename(call.cwd) === 'project'), true)
      assert.equal(calls.every((call) => call.cwd !== process.cwd()), true)
      assert.equal(calls.every((call) => call.gitWorktree === true), true)
      assert.equal(calls.every((call) => call.home.startsWith(path.dirname(call.codexHome))), true)
      assert.equal(calls.every((call) => call.awHome.startsWith(path.dirname(call.codexHome))), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('fails closed when a scoped list is not the required JSON shape', async () => {
  for (const listOutput of [
    'NOT_JSON',
    '{"installed":[]}',
    '{"installed":[],"available":{}}',
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aw-codex-performance-invalid-list-'))
    try {
      const executable = path.join(root, 'fake-codex.mjs')
      const logPath = path.join(root, 'calls.jsonl')
      await writeFile(executable, fakeCodexSource, 'utf8')
      const report = await runCodexNativePerformanceQualification({
        requiredVersion: '0.153.0',
        codexCommand: process.execPath,
        codexArgsPrefix: [executable],
        samples: 1,
        tempParent: root,
        baseEnv: {
          ...process.env,
          FAKE_CODEX_VERSION: '0.153.0',
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_LIST_OUTPUT: listOutput,
        },
      })
      assert.equal(report.result, 'failed')
      assert.equal(report.errorCode, 'invalidScopedListOutput')
      assert.equal(report.contracts.marketplaceScopedJsonList, false)
      const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(calls.every((call) => call.gitWorktree === true), true)
      assert.equal(calls.some((call) => call.args.slice(0, 2).join(' ') === 'plugin add'), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('reports a missing exact binary without downloading it', async () => {
  const report = await runCodexNativePerformanceQualification({ requiredVersion: '0.151.0' })
  assert.equal(report.result, 'missing')
  assert.equal(report.errorCode, 'exactCodexBinaryMissing')
})
