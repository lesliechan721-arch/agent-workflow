import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertQualificationReport,
  parseCodexVersion,
  runQualification,
} from './codex-project-native-lib.mjs'

const fakeCodexSource = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const args = process.argv.slice(2)
const logPath = process.env.FAKE_CODEX_LOG
fs.appendFileSync(logPath, JSON.stringify({
  args,
  launcher: process.argv[1],
  cwd: process.cwd(),
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    AW_HOME: process.env.AW_HOME,
    AW_CODEX_HOME: process.env.AW_CODEX_HOME,
    AW_CLAUDE_HOME: process.env.AW_CLAUDE_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HTTP_PROXY: process.env.HTTP_PROXY,
  },
}) + '\n')
process.stderr.write('fake secret=' + process.env.FAKE_SECRET + ' path=' + process.env.CODEX_HOME + '\n')

const marketplaceName = 'aw-native-qualification'
const pluginName = 'aw-native-qualification'
const pluginId = pluginName + '@' + marketplaceName
const skillName = 'aw-native-qualification-skill'

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli ' + (process.env.FAKE_CODEX_VERSION || '0.151.0') + '\n')
  process.exit(0)
}

const configPath = path.join(process.env.CODEX_HOME, 'config.toml')
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const source = args[3]
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true })
  fs.writeFileSync(
    configPath,
    '[marketplaces.' + marketplaceName + ']\nsource_type = "local"\nsource = ' + JSON.stringify(source) + '\n',
  )
  process.stdout.write(JSON.stringify({ marketplaceName }) + '\n')
  process.exit(0)
}

if (args[0] === 'plugin' && args[1] === 'add') {
  fs.appendFileSync(configPath, '\n[plugins."' + pluginId + '"]\nenabled = true\n')
  process.stdout.write(JSON.stringify({ name: pluginName, marketplaceName, pluginId }) + '\n')
  process.exit(0)
}

if (args[0] === 'plugin' && args[1] === 'list') {
  const userConfig = fs.readFileSync(configPath, 'utf8')
  const userEnabled = /\[plugins\."aw-native-qualification@aw-native-qualification"\]\s*enabled\s*=\s*true/u.test(userConfig)
  process.stdout.write(JSON.stringify({
    installed: [{ pluginId, installed: true, enabled: userEnabled }],
    available: [],
  }) + '\n')
  process.exit(0)
}

if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    name: 'aw_native_qualification',
    enabled: true,
    pluginId,
  }]) + '\n')
  process.exit(0)
}

function activeFor(cwd) {
  const userConfig = fs.readFileSync(configPath, 'utf8')
  const userMatch = userConfig.match(/\[plugins\."aw-native-qualification@aw-native-qualification"\]\s*enabled\s*=\s*(true|false)/u)
  const userEnabled = userMatch?.[1] === 'true'
  const projectConfigPath = path.join(cwd, '.codex', 'config.toml')
  const projectEnabled = fs.existsSync(projectConfigPath)
    && /enabled\s*=\s*true/u.test(fs.readFileSync(projectConfigPath, 'utf8'))
  const trustBlock = '[projects.' + JSON.stringify(cwd) + ']'
  const trusted = userConfig.includes(trustBlock) && /trust_level\s*=\s*"trusted"/u.test(
    userConfig.slice(userConfig.indexOf(trustBlock)),
  )
  return userEnabled || (projectEnabled && trusted)
}

if (args[0] === 'app-server') {
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const request = JSON.parse(line)
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: request.id, result: {
        codexHome: process.env.CODEX_HOME,
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform,
        userAgent: 'fake-codex',
      } }) + '\n')
      return
    }
    if (!request.id) return
    if (request.method === 'skills/list') {
      const cwd = request.params.cwds[0]
      const skills = activeFor(cwd) ? [{
        name: pluginName + ':' + skillName,
        description: 'fake',
        enabled: true,
        path: path.join(process.env.CODEX_HOME, 'plugins', 'skill', 'SKILL.md'),
        pluginId,
        scope: 'user',
      }] : []
      process.stdout.write(JSON.stringify({ id: request.id, result: {
        data: [{ cwd, skills, errors: [] }],
      } }) + '\n')
      return
    }
    if (request.method === 'hooks/list') {
      const cwd = request.params.cwds[0]
      const hooks = activeFor(cwd) ? [{
        pluginId,
        enabled: true,
        eventName: 'sessionStart',
        trustStatus: 'untrusted',
      }] : []
      process.stdout.write(JSON.stringify({ id: request.id, result: {
        data: [{ cwd, hooks, warnings: [], errors: [] }],
      } }) + '\n')
      return
    }
    if (request.method === 'plugin/read') {
      process.stdout.write(JSON.stringify({ id: request.id, result: { plugin: {
        skills: [{ name: pluginName + ':' + skillName }],
        mcpServers: ['aw_native_qualification'],
        hooks: [{ key: 'fake', eventName: 'sessionStart' }],
        apps: [{ id: 'aw-native-qualification-app', name: 'aw-native-qualification-app' }],
      } } }) + '\n')
      return
    }
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: 'unknown' } }) + '\n')
  })
  await new Promise((resolve) => lines.on('close', resolve))
  process.exit(0)
}

process.exit(2)
`

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-codex-qualification-test-'))
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  const logPath = path.join(root, 'fake-codex.log')
  await writeFile(fakeCodex, fakeCodexSource, 'utf8')
  return { root, fakeCodex, logPath }
}

async function createWindowsNpmHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-codex-qualification-windows-test-'))
  const binRoot = path.join(root, 'npm prefix with spaces & %value%')
  const packageRoot = path.join(binRoot, 'node_modules', '@openai', 'codex')
  const launcher = path.join(packageRoot, 'bin', 'codex.js')
  const logPath = path.join(root, 'fake-codex.log')
  await mkdir(path.dirname(launcher), { recursive: true })
  await Promise.all([
    writeFile(path.join(binRoot, 'codex.CMD'), '@echo off\r\nexit /b 99\r\n', 'utf8'),
    writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@openai/codex',
      version: '0.151.0',
      bin: { codex: 'bin/codex.js' },
    }, null, 2)}\n`, 'utf8'),
    writeFile(launcher, fakeCodexSource, 'utf8'),
  ])
  return { root, binRoot, launcher, logPath }
}

async function pathExists(candidate) {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

test('parses only the exact Codex CLI version output shape', () => {
  assert.equal(parseCodexVersion('codex-cli 0.151.0\n'), '0.151.0')
  assert.equal(parseCodexVersion('codex 0.151.0\n'), null)
  assert.equal(parseCodexVersion('codex-cli 0.151.0 extra\n'), null)
})

test('isolates fake Codex execution and emits a redacted schema-1 report', async () => {
  const harness = await createHarness()
  try {
    const report = await runQualification({
      codexCommand: process.execPath,
      codexArgsPrefix: [harness.fakeCodex],
      tempParent: harness.root,
      baseEnv: {
        ...process.env,
        FAKE_CODEX_LOG: harness.logPath,
        FAKE_SECRET: 'qualification-secret-value',
        CODEX_HOME: path.join(harness.root, 'real-codex-home'),
        HOME: path.join(harness.root, 'real-home'),
        USERPROFILE: path.join(harness.root, 'real-profile'),
        AW_HOME: path.join(harness.root, 'real-aw-home'),
      },
    })

    assertQualificationReport(report)
    assert.equal(report.minimumContractPassed, true)
    assert.equal(report.scenarios.find((scenario) => scenario.id === 'neutral-cwd-repo-free')?.result, 'passed')
    assert.equal(report.scenarios.find((scenario) => scenario.id === 'user-true-project-false')?.result, 'passed')
    assert.equal(report.scenarios.find((scenario) => scenario.id === 'both-disabled-shared-package-retained')?.result, 'passed')
    assert.equal(report.isolation.cleanup, 'completed')
    assert.deepEqual(
      Object.fromEntries(Object.entries(report.nativeKinds).map(([id, value]) => [id, value.result])),
      {
        skill: 'supported',
        mcp: 'supported',
        hook: 'supported',
        app: 'supported',
        slashCommand: 'unsupported',
      },
    )
    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes(harness.root), false)
    assert.equal(serialized.includes('qualification-secret-value'), false)

    const invocations = (await readFile(harness.logPath, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line))
    assert.ok(invocations.length > 4)
    const isolatedRoot = path.dirname(invocations[0].env.CODEX_HOME)
    for (const invocation of invocations) {
      assert.equal(invocation.env.CODEX_HOME.startsWith(isolatedRoot), true)
      assert.equal(invocation.env.HOME.startsWith(isolatedRoot), true)
      assert.equal(invocation.env.USERPROFILE.startsWith(isolatedRoot), true)
      assert.equal(invocation.env.AW_HOME.startsWith(isolatedRoot), true)
      assert.equal(invocation.env.AW_CODEX_HOME, invocation.env.CODEX_HOME)
      assert.equal(invocation.env.AW_CLAUDE_HOME, invocation.env.CLAUDE_CONFIG_DIR)
      assert.equal(invocation.env.XDG_STATE_HOME.startsWith(isolatedRoot), true)
      assert.equal(invocation.env.HTTP_PROXY, 'http://127.0.0.1:1')
      assert.equal(invocation.cwd.includes(path.basename(isolatedRoot)), true)
    }
    assert.equal(await pathExists(path.join(isolatedRoot, 'neutral', '.git')), false)
    assert.equal(await pathExists(isolatedRoot), false)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('stops at the exact-version gate for another fake Codex version', async () => {
  const harness = await createHarness()
  try {
    const report = await runQualification({
      codexCommand: process.execPath,
      codexArgsPrefix: [harness.fakeCodex],
      tempParent: harness.root,
      baseEnv: {
        ...process.env,
        FAKE_CODEX_LOG: harness.logPath,
        FAKE_SECRET: 'must-not-appear',
        FAKE_CODEX_VERSION: '0.150.9',
      },
    })
    assertQualificationReport(report)
    assert.equal(report.minimumContractPassed, false)
    assert.equal(report.environment.codexCli.actualVersion, '0.150.9')
    assert.equal(report.scenarios.find((scenario) => scenario.id === 'marketplace-add')?.result, 'unsupported')
    const invocations = (await readFile(harness.logPath, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line))
    assert.equal(invocations.length, 1)
    assert.equal(await pathExists(path.dirname(invocations[0].env.CODEX_HOME)), false)
    assert.equal(JSON.stringify(report).includes('must-not-appear'), false)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('rejects a neutral cwd under a project marker before starting Codex', async () => {
  const harness = await createHarness()
  try {
    await mkdir(path.join(harness.root, '.agent-workflows'))
    const report = await runQualification({
      codexCommand: process.execPath,
      codexArgsPrefix: [harness.fakeCodex],
      tempParent: harness.root,
      baseEnv: { ...process.env, FAKE_CODEX_LOG: harness.logPath },
    })

    assertQualificationReport(report)
    assert.equal(report.minimumContractPassed, false)
    assert.equal(report.scenarios.find((scenario) => scenario.id === 'neutral-cwd-repo-free')?.result, 'failed')
    assert.equal(await pathExists(harness.logPath), false)
    assert.equal(JSON.stringify(report).includes(harness.root), false)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('uses the canonical Windows npm launcher for commands and app-server', async () => {
  const harness = await createWindowsNpmHarness()
  try {
    const report = await runQualification({
      codexCommand: 'codex',
      platform: 'win32',
      tempParent: harness.root,
      baseEnv: {
        ...process.env,
        PATH: harness.binRoot,
        PATHEXT: '.CMD',
        FAKE_CODEX_LOG: harness.logPath,
        FAKE_SECRET: 'windows-launcher-secret',
      },
    })

    assertQualificationReport(report)
    assert.equal(report.minimumContractPassed, true)
    assert.equal(report.environment.os, 'win32')
    const canonicalLauncher = await realpath(harness.launcher)
    const invocations = (await readFile(harness.logPath, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line))
    assert.ok(invocations.some((invocation) => invocation.args[0] === 'plugin'))
    assert.ok(invocations.some((invocation) => invocation.args[0] === 'app-server'))
    assert.ok(invocations.every((invocation) => invocation.launcher === canonicalLauncher))
    assert.equal(JSON.stringify(report).includes(harness.root), false)
    assert.equal(JSON.stringify(report).includes('windows-launcher-secret'), false)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('public entry emits one redacted schema-1 JSON report when temp initialization fails', async () => {
  const harnessRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-codex-qualification-entry-test-'))
  try {
    const blockedTempParent = path.join(harnessRoot, 'not-a-directory')
    await writeFile(blockedTempParent, 'fixture', 'utf8')
    const entry = fileURLToPath(new URL('./codex-project-native.mjs', import.meta.url))
    const repositoryRoot = path.resolve(path.dirname(entry), '..', '..')
    const child = spawnSync(process.execPath, [entry], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TMPDIR: blockedTempParent,
        TMP: blockedTempParent,
        TEMP: blockedTempParent,
      },
    })

    assert.equal(child.status, 1)
    assert.equal(child.signal, null)
    assert.equal(child.stderr, '')
    const report = JSON.parse(child.stdout)
    assertQualificationReport(report)
    assert.equal(report.minimumContractPassed, false)
    assert.equal(report.scenarios.find((scenario) => scenario.id === 'exact-version-gate')?.evidence[0]?.code, 'qualificationInitializationFailed')
    for (const forbidden of [repositoryRoot, harnessRoot, blockedTempParent, os.tmpdir()]) {
      assert.equal(child.stdout.includes(forbidden), false)
      assert.equal(child.stderr.includes(forbidden), false)
    }
  } finally {
    await rm(harnessRoot, { recursive: true, force: true })
  }
})
