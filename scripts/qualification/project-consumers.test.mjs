import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runQualification } from './project-consumers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeProvider = String.raw`#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG || path.join(path.dirname(process.argv[1]), 'calls.jsonl'), JSON.stringify({
  args, cwd: process.cwd(), home: process.env.HOME, claude: process.env.CLAUDE_CONFIG_DIR,
  proxy: process.env.HTTPS_PROXY, secret: process.env.QUALIFICATION_TEST_SECRET || null,
}) + '\n')
if (args[0] === '--version') { console.log('1.5.23'); process.exit(0) }
if (args[0] === 'add') {
  if (process.argv[1].endsWith('slow-provider.mjs')) await new Promise(resolve => setTimeout(resolve, 2000))
  const source = args[1]
  for (const base of ['.agents', '.claude']) {
    const target = path.join(process.cwd(), base, 'skills', 'aw-consumer-qualification')
    fs.mkdirSync(target, { recursive: true })
    fs.cpSync(source, target, { recursive: true })
  }
  process.exit(0)
}
if (args[0] === 'list') {
  console.log(JSON.stringify([{ name: 'aw-consumer-qualification', scope: 'project', path: path.join(process.cwd(), '.agents', 'skills', 'aw-consumer-qualification'), agents: ['Claude Code', 'Codex', 'Cursor'] }]))
  process.exit(0)
}
process.exit(2)
`
const fakeClaude = `#!/usr/bin/env node\nconsole.log('2.1.119 (Claude Code)')\n`
const fakeCursor = `#!/usr/bin/env node\nconsole.log('agent 1.2.3')\n`

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-consumer-harness-'))
  const provider = path.join(root, 'provider.mjs')
  const claude = path.join(root, 'claude.mjs')
  const cursor = path.join(root, 'cursor.mjs')
  await Promise.all([
    fs.writeFile(provider, fakeProvider, { mode: 0o755 }),
    fs.writeFile(claude, fakeClaude, { mode: 0o755 }),
    fs.writeFile(cursor, fakeCursor, { mode: 0o755 }),
  ])
  return { root, provider, claude, cursor }
}

test('fake provider proves isolated delivery and reports consumer load as unverified', async () => {
  const fixture = await harness()
  const oldSecret = process.env.QUALIFICATION_TEST_SECRET
  process.env.QUALIFICATION_TEST_SECRET = 'qualification-secret-value'
  try {
    const report = await runQualification({
      providerCommand: fixture.provider,
      claudeCommand: fixture.claude,
      cursorCommand: fixture.cursor,
      tempParent: fixture.root,
    })
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.provider.delivery, 'verified')
    assert.equal(report.provider.projectAssociationVerified, true)
    assert.deepEqual(report.provider.targets.map(target => target.complete), [true, true])
    assert.equal(report.consumers.claudeCode.version, '2.1.119')
    assert.equal(report.consumers.cursor.version, '1.2.3')
    assert.equal(report.consumers.claudeCode.status, 'unverified')
    assert.equal(report.consumers.cursor.status, 'unverified')
    assert.equal(report.status, 'unverified')
    assert.equal(report.isolation.cleanup, 'completed')
    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes(fixture.root), false)
    assert.equal(serialized.includes('qualification-secret-value'), false)
    const calls = (await fs.readFile(path.join(fixture.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls.map(call => call.args[0]), ['--version', 'add', 'list'])
    const realRoot = await fs.realpath(fixture.root)
    for (const call of calls) {
      assert.equal(call.cwd.startsWith(realRoot), true)
      assert.equal(call.home.startsWith(fixture.root), true)
      assert.equal(call.claude.startsWith(fixture.root), true)
      assert.equal(call.proxy, 'http://127.0.0.1:1')
      assert.equal(call.secret, null)
    }
    const remaining = await fs.readdir(fixture.root)
    assert.equal(remaining.some(name => name.startsWith('aw-project-consumers-')), false)
  } finally {
    if (oldSecret === undefined) delete process.env.QUALIFICATION_TEST_SECRET
    else process.env.QUALIFICATION_TEST_SECRET = oldSecret
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('provider timeout fails closed and removes its temporary project', async () => {
  const fixture = await harness()
  try {
    const slowProvider = path.join(fixture.root, 'slow-provider.mjs')
    await fs.copyFile(fixture.provider, slowProvider)
    await fs.chmod(slowProvider, 0o755)
    const report = await runQualification({ providerCommand: slowProvider, tempParent: fixture.root, timeoutMs: 150 })
    assert.equal(report.provider.delivery, 'unverified')
    assert.equal(report.provider.reason, 'providerAddTimeout')
    assert.equal(report.status, 'blocked')
    assert.equal(report.consumers.claudeCode.reason, 'providerDeliveryUnavailable')
    assert.equal(report.isolation.cleanup, 'completed')
    assert.equal((await fs.readdir(fixture.root)).some(name => name.startsWith('aw-project-consumers-')), false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('public entry writes one redacted JSON report', async () => {
  const fixture = await harness()
  try {
    const destination = path.join(fixture.root, 'report.json')
    const execution = spawnSync(process.execPath, [path.join(here, 'project-consumers.mjs')], {
      cwd: fixture.root,
      env: {
        ...process.env,
        PROJECT_CONSUMERS_QUALIFICATION_PROVIDER: fixture.provider,
        CLAUDE_QUALIFICATION_CLI: fixture.claude,
        CURSOR_QUALIFICATION_CLI: fixture.cursor,
        PROJECT_CONSUMERS_QUALIFICATION_REPORT: destination,
        QUALIFICATION_TEST_SECRET: 'qualification-secret-value',
      },
      encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(execution.status, 1)
    assert.equal(execution.stderr, '')
    const stdout = JSON.parse(execution.stdout)
    const written = JSON.parse(await fs.readFile(destination, 'utf8'))
    assert.deepEqual(stdout, written)
    assert.equal(execution.stdout.trim().split('\n').length, 1)
    assert.equal(execution.stdout.includes(fixture.root), false)
    assert.equal(execution.stdout.includes('qualification-secret-value'), false)
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }) }
})
