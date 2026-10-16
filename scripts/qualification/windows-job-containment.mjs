#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ProcessTreeTimeoutError,
  runProcessTree,
} from '../perf/process-tree.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const helperArch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null
const defaultHelperPath = helperArch
  ? path.join(
      repoRoot,
      'packages',
      'agent-skill-eval',
      'native',
      'windows',
      helperArch,
      'aw-windows-job.exe',
    )
  : null
const checkTimeoutMs = 10_000

function encodeConfig(executable, args, parentPid = process.pid) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    executable,
    args,
    parentPid,
  }), 'utf8').toString('base64url')
}

function startHelper(executable, args, options = {}) {
  const { helperPath = defaultHelperPath, ...spawnOptions } = options
  const child = spawn(helperPath, ['--config', encodeConfig(executable, args)], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...spawnOptions,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('helperCloseTimeout')), checkTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  return { child, closed, output: () => ({ stdout, stderr }) }
}

async function waitForOutput(started, pattern) {
  const deadline = Date.now() + checkTimeoutMs
  while (Date.now() < deadline) {
    const match = pattern.exec(started.output().stdout)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('targetOutputTimeout')
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + checkTimeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('containedProcessStillRunning')
}

async function waitForRecordedPids(pidPath) {
  const deadline = Date.now() + checkTimeoutMs
  while (Date.now() < deadline) {
    try {
      const pids = (await readFile(pidPath, 'utf8')).split(',').map(Number)
      if (pids.length === 2 && pids.every(Number.isInteger)) return pids
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('targetPidRecordTimeout')
}

function managedCleanupFixture(pidPath) {
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid) + ',' + String(child.pid));`,
    'child.unref();',
    'setInterval(() => {}, 1000);',
  ].join('')
}

function observeOutcome(run) {
  return Promise.resolve().then(run).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
}

async function checkStdioAndExitCode(options) {
  const started = startHelper(process.execPath, ['-e', [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => { process.stdout.write(`out:${input}`); process.stderr.write('err:ok'); process.exitCode = 7; });",
  ].join('')], options)
  started.child.stdin.end('input')
  const close = await started.closed
  const output = started.output()
  if (close.code !== 7 || output.stdout !== 'out:input' || output.stderr !== 'err:ok') {
    throw new Error('stdioOrExitCodeMismatch')
  }
}

async function checkFastSuccess(options) {
  const started = startHelper(process.execPath, ['-e', 'process.exit(0)'], options)
  const close = await started.closed
  if (close.code !== 0 || close.signal !== null) throw new Error('fastSuccessMismatch')
}

async function checkSuccessfulRootCleansChild(options) {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    'process.stdout.write(`pid:${child.pid}\\n`);',
    'child.unref();',
  ].join('')
  const started = startHelper(process.execPath, ['-e', script], options)
  const match = await waitForOutput(started, /pid:(\d+)/u)
  const close = await started.closed
  if (close.code !== 0) throw new Error('successfulRootExitMismatch')
  await waitForProcessExit(Number(match[1]))
}

export function nestedCleanupFixture() {
  // Insurance must outlast the helper startup and descendant cleanup deadlines.
  const watchdog = `setTimeout(() => process.exit(124), ${checkTimeoutMs * 3}).unref();`
  const grandchild = `${watchdog} process.send(process.pid); setInterval(() => {}, 1000);`
  const intermediate = [
    watchdog,
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });`,
    "child.once('message', (pid) => { process.send(pid); child.disconnect(); child.unref(); });",
    'setInterval(() => {}, 1000);',
  ].join('')
  return [
    watchdog,
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(intermediate)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });`,
    "child.once('message', (pid) => { process.stdout.write(`pids:${child.pid},${pid}\\n`); child.disconnect(); child.unref(); });",
  ].join('')
}

export async function checkNestedChildCleanup({ startHelper: start = startHelper, ...options } = {}) {
  const started = start(process.execPath, ['-e', nestedCleanupFixture()], options)
  const match = await waitForOutput(started, /pids:(\d+),(\d+)/u)
  const close = await started.closed
  if (close.code !== 0) throw new Error('nestedRootExitMismatch')
  await Promise.all([waitForProcessExit(Number(match[1])), waitForProcessExit(Number(match[2]))])
}

async function checkForcedHelperExit(options) {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    'process.stdout.write(`pids:${process.pid},${child.pid}\\n`);',
    'child.unref();',
    'setInterval(() => {}, 1000);',
  ].join('')
  const started = startHelper(process.execPath, ['-e', script], options)
  const match = await waitForOutput(started, /pids:(\d+),(\d+)/u)
  if (!started.child.kill('SIGKILL')) throw new Error('forcedHelperExitKillRejected')
  await started.closed
  await Promise.all([waitForProcessExit(Number(match[1])), waitForProcessExit(Number(match[2]))])
}

export async function checkProductionTimeoutCleanup(tempRoot, dependencies = {}) {
  const pidPath = path.join(tempRoot, 'timeout-cleanup-pids.txt')
  const timeoutMs = dependencies.timeoutMs ?? 3_000
  const runManagedProcess = dependencies.runProviderProcess
    ? candidateProcessRunner(dependencies)
    : dependencies.runProcessTree ?? runProcessTree
  const readPids = dependencies.waitForRecordedPids ?? waitForRecordedPids
  const waitForExit = dependencies.waitForProcessExit ?? waitForProcessExit
  const outcome = observeOutcome(() => runManagedProcess({
    label: 'Windows Job timeout qualification',
    command: process.execPath,
    args: ['-e', managedCleanupFixture(pidPath)],
    timeoutMs,
  }))
  const pids = await readPids(pidPath)
  const result = await outcome
  if (result.ok || !(result.error instanceof ProcessTreeTimeoutError)) {
    throw new Error('productionTimeoutResultMismatch')
  }
  await Promise.all(pids.map(waitForExit))
}

export async function checkProductionAbortCleanup(tempRoot, dependencies = {}) {
  const pidPath = path.join(tempRoot, 'abort-cleanup-pids.txt')
  const runManagedProcess = dependencies.runProviderProcess
    ? candidateProcessRunner(dependencies)
    : dependencies.runProcessTree ?? runProcessTree
  const readPids = dependencies.waitForRecordedPids ?? waitForRecordedPids
  const waitForExit = dependencies.waitForProcessExit ?? waitForProcessExit
  const controller = new AbortController()
  const abortReason = new Error('qualificationAbort')
  const outcome = observeOutcome(() => runManagedProcess({
    label: 'Windows Job abort qualification',
    command: process.execPath,
    args: ['-e', managedCleanupFixture(pidPath)],
    signal: controller.signal,
  }))
  const pids = await readPids(pidPath)
  controller.abort(abortReason)
  const result = await outcome
  if (result.ok || result.error !== abortReason) {
    throw new Error('productionAbortResultMismatch')
  }
  await Promise.all(pids.map(waitForExit))
}

async function checkParentCrash(tempRoot, { helperPath = defaultHelperPath } = {}) {
  const pidPath = path.join(tempRoot, 'parent-crash-pids.txt')
  const target = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid) + ',' + String(child.pid));`,
    'child.unref();',
    'setInterval(() => {}, 1000);',
  ].join('')
  const controllerPath = path.join(tempRoot, 'parent-crash-controller.mjs')
  const controller = [
    "import { spawn } from 'node:child_process';",
    "import { access } from 'node:fs/promises';",
    `const config = { schemaVersion: 1, executable: process.execPath, args: ['-e', ${JSON.stringify(target)}], parentPid: process.pid };`,
    `spawn(${JSON.stringify(helperPath)}, ['--config', Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')], { stdio: 'ignore', windowsHide: true });`,
    `for (let attempt = 0; attempt < 500; attempt += 1) { try { await access(${JSON.stringify(pidPath)}); process.exit(0); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }`,
    "throw new Error('targetDidNotStart');",
  ].join('\n')
  await writeFile(controllerPath, controller, 'utf8')
  const parent = spawn(process.execPath, [controllerPath], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('parentCrashTimeout')), checkTimeoutMs)
    parent.once('error', reject)
    parent.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('parentCrashControllerFailed'))
    })
  })
  const pids = (await readFile(pidPath, 'utf8')).split(',').map(Number)
  await Promise.all(pids.map(waitForProcessExit))
}

export const WINDOWS_JOB_REQUIRED_CHECKS = [
  'stdio-exit-code',
  'fast-success',
  'successful-root-child-cleanup',
  'nested-child-cleanup',
  'forced-helper-exit-cleanup',
  'production-timeout-cleanup',
  'production-abort-cleanup',
  'parent-crash-cleanup',
]

// Keep the existing local perf-runner contract while using the installed Eval
// runner for candidate qualification. Both timeout and abort reach that runner.
export function candidateProcessRunner({ runProviderProcess, helperPath, env = process.env }) {
  if (typeof runProviderProcess !== 'function' || !path.isAbsolute(helperPath ?? '')) {
    throw new Error('candidateRunnerAndHelperRequired')
  }
  return async (options) => {
    const result = await runProviderProcess({
      executable: options.command,
      args: options.args,
      cwd: os.tmpdir(),
      env,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBufferBytes: 1024 * 1024,
      signal: options.signal,
    }, {}, {
      containment: 'verified-observed',
      createWindowsJobInvocation(executable, args) {
        const config = { schemaVersion: 1, executable, args: [...args], parentPid: process.pid }
        return { command: helperPath, args: ['--config', encodeConfig(executable, args)], config }
      },
    })
    if (!result.descendantCleanupGuaranteed || result.containmentMode !== 'verified-observed') {
      throw new Error('candidateManagedContainmentRequired')
    }
    if (result.cancelled && result.terminationReason === 'abort') throw options.signal.reason
    if (result.timedOut && result.terminationReason === 'timeout') {
      throw new ProcessTreeTimeoutError(options.label, options.timeoutMs, result.stdout, result.stderr)
    }
    throw new Error('candidateProductionTerminationMismatch')
  }
}

export async function runWindowsJobQualification(options = {}) {
  const report = {
    schemaVersion: 1,
    kind: 'windows-job-containment',
    platform: process.platform,
    arch: process.arch,
    runner: options.runProviderProcess ? 'candidate-eval' : 'local-perf',
    status: 'failed',
    checks: [],
  }
  let tempRoot
  try {
    const helperPath = options.helperPath ?? defaultHelperPath
    if (process.platform !== 'win32' || !helperArch) throw new Error('requiresSupportedWindowsHost')
    if (!path.isAbsolute(helperPath ?? '')) throw new Error('absoluteHelperPathRequired')
    const helper = { ...options, helperPath }
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-windows-job-qualification-'))
    const checks = [
      ['stdio-exit-code', () => checkStdioAndExitCode(helper)],
      ['fast-success', () => checkFastSuccess(helper)],
      ['successful-root-child-cleanup', () => checkSuccessfulRootCleansChild(helper)],
      ['nested-child-cleanup', () => checkNestedChildCleanup(helper)],
      ['forced-helper-exit-cleanup', () => checkForcedHelperExit(helper)],
      ['production-timeout-cleanup', () => checkProductionTimeoutCleanup(tempRoot, helper)],
      ['production-abort-cleanup', () => checkProductionAbortCleanup(tempRoot, helper)],
      ['parent-crash-cleanup', () => checkParentCrash(tempRoot, helper)],
    ]
    for (const [id, check] of checks) {
      try {
        await check()
        report.checks.push({ id, passed: true })
      } catch (error) {
        report.checks.push({ id, passed: false, code: error instanceof Error ? error.message : 'unknownFailure' })
      }
    }
    if (report.checks.every((check) => check.passed)) report.status = 'passed'
  } catch (error) {
    for (const id of WINDOWS_JOB_REQUIRED_CHECKS) {
      report.checks.push({ id, passed: false, code: error instanceof Error ? error.message : 'unknownFailure' })
    }
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runWindowsJobQualification()
  if (report.status !== 'passed') process.exitCode = 1
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
