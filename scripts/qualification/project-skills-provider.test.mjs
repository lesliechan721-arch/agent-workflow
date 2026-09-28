import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { boundedCommand, isolatedEnvironment, runQualification } from './project-skills-provider.mjs'

test('qualification child environment contains only isolated homes and no inherited token', () => {
  const env = isolatedEnvironment('/tmp/qualification-root')
  assert.equal(env.HOME, '/tmp/qualification-root/home')
  assert.equal(env.CODEX_HOME, '/tmp/qualification-root/codex-home')
  assert.equal(env.AW_HOME, '/tmp/qualification-root/aw-home')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.npm_config_ignore_scripts, 'true')
})

test('qualification command aborts a hung child at its deadline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-provider-harness-test-'))
  try {
    const result = await boundedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root, env: isolatedEnvironment(root), timeoutMs: 100,
    })
    assert.equal(result.timedOut, true)
    assert.notEqual(result.code, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('fake provider cannot pass an inexact version and leaves a bounded report', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-provider-harness-test-'))
  try {
    const cli = path.join(root, 'fake.mjs')
    const reportPath = path.join(root, 'report.json')
    await fs.writeFile(cli, "process.stdout.write('1.5.24\\n')\n")
    const report = await runQualification({ cli, reportPath, fake: true })
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.blockers, ['exactVersionMismatch'])
    assert.equal(report.cleanup.completed, true)
    assert.equal((await fs.readFile(reportPath, 'utf8')).includes('1.5.24'), true)
    assert.equal(report.officialProvider, false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('fake provider partial and unsafe behavior is recorded as blockers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-provider-harness-test-'))
  try {
    const cli = path.join(root, 'fake.mjs')
    const reportPath = path.join(root, 'report.json')
    await fs.writeFile(cli, String.raw`
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('1.5.23\n'); process.exit(0) }
if (args[0] === 'list') { process.stdout.write('[]\n'); process.exit(0) }
if (args[0] === 'add') {
  const skill = path.basename(args[1])
  const global = args.includes('--global')
  const base = global ? process.env.HOME : process.cwd()
  const target = path.join(base, '.agents/skills', skill)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(args[1], target, { recursive: true, force: true })
  fs.rmSync(path.join(target, 'metadata.json'), { force: true })
  const lock = path.join(process.cwd(), 'skills-lock.json')
  fs.writeFileSync(lock, JSON.stringify({ version: 1, skills: {} }))
  process.exit(0)
}
process.exit(2)
`)
    const report = await runQualification({ cli, reportPath, fake: true })
    assert.equal(report.status, 'blocked')
    assert.equal(report.blockers.includes('incompleteCopyTree'), true)
    assert.equal(report.blockers.includes('unrelatedLockLost'), true)
    assert.equal(report.requiredGuards.includes('rejectMalformedLockBeforeAdd'), true)
    assert.equal(report.requiredGuards.includes('verifyEveryPhysicalTargetAfterAddEvenOnZeroExit'), true)
    assert.equal(report.qualifiedContent.validMetadataJsonDropped, true)
    assert.equal(report.requiredGuards.includes('rejectProviderExcludedSkillTreeEntriesBeforeAdd'), true)
    assert.equal(report.cleanup.completed, true)
    assert.equal(report.cases.projectAdd.args.includes('--copy'), true)
    assert.equal(report.cases.projectAdd.args.includes('--agent'), true)
    assert.equal(report.cases.projectAdd.args.includes('--global'), false)
    assert.deepEqual(report.cases.repeatAdd.args, report.cases.projectAdd.args)
    assert.equal(report.cases.repeatAdd.exitCode, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
