import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { ProcessTreeTimeoutError } from '../perf/process-tree.mjs'
import {
  checkProductionAbortCleanup,
  checkNestedChildCleanup,
  checkProductionTimeoutCleanup,
  nestedCleanupFixture,
} from './windows-job-containment.mjs'

test('timeout qualification uses the production timeout option', async () => {
  const exits = []
  let observed
  await checkProductionTimeoutCleanup('/qualification', {
    timeoutMs: 37,
    runProcessTree: async (options) => {
      observed = options
      throw new ProcessTreeTimeoutError(options.label, options.timeoutMs, '', '')
    },
    waitForRecordedPids: async () => [101, 102],
    waitForProcessExit: async (pid) => { exits.push(pid) },
  })

  assert.equal(observed.timeoutMs, 37)
  assert.equal(observed.signal, undefined)
  assert.match(observed.args[1], /writeFileSync/u)
  assert.deepEqual(exits, [101, 102])
})

test('abort qualification passes an AbortSignal to the production entry', async () => {
  const exits = []
  let observedSignal
  await checkProductionAbortCleanup('/qualification', {
    runProcessTree: (options) => {
      observedSignal = options.signal
      assert.equal(observedSignal.aborted, false)
      return new Promise((resolve, reject) => {
        observedSignal.addEventListener(
          'abort',
          () => reject(observedSignal.reason),
          { once: true },
        )
      })
    },
    waitForRecordedPids: async () => [201, 202],
    waitForProcessExit: async (pid) => { exits.push(pid) },
  })

  assert.ok(observedSignal instanceof AbortSignal)
  assert.equal(observedSignal.aborted, true)
  assert.equal(observedSignal.reason.message, 'qualificationAbort')
  assert.deepEqual(exits, [201, 202])
})

test('candidate qualification sends timeout and abort to the candidate Eval runner and helper', async () => {
  const helperPath = process.platform === 'win32' ? 'C:\\candidate\\aw-windows-job.exe' : '/candidate/aw-windows-job.exe'
  const calls = []
  const dependencies = {
    helperPath,
    runProviderProcess: async (request, hooks, options) => {
      const invocation = options.createWindowsJobInvocation(request.executable, request.args)
      calls.push({ request, invocation })
      assert.equal(invocation.command, helperPath)
      assert.deepEqual(JSON.parse(Buffer.from(invocation.args[1], 'base64url').toString('utf8')), invocation.config)
      if (request.signal) await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
      return {
        descendantCleanupGuaranteed: true, containmentMode: options.containment,
        cancelled: Boolean(request.signal), timedOut: !request.signal,
        terminationReason: request.signal ? 'abort' : 'timeout', stdout: '', stderr: '',
      }
    },
    waitForRecordedPids: async () => [301, 302],
    waitForProcessExit: async () => {},
  }
  await checkProductionTimeoutCleanup('/qualification', { ...dependencies, timeoutMs: 71 })
  await checkProductionAbortCleanup('/qualification', dependencies)
  assert.equal(calls[0].request.timeoutMs, 71)
  assert.equal(calls[0].request.signal, undefined)
  assert.ok(calls[1].request.signal instanceof AbortSignal)
  assert.equal(calls[1].request.signal.aborted, true)
})

test('unsupported hosts report every mandatory scenario as failed without skips', async (t) => {
  if (process.platform === 'win32') { t.skip('Non-Windows failure boundary only'); return }
  const { runWindowsJobQualification, WINDOWS_JOB_REQUIRED_CHECKS } = await import('./windows-job-containment.mjs')
  const report = await runWindowsJobQualification()
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.checks.map((check) => check.id), WINDOWS_JOB_REQUIRED_CHECKS)
  assert.ok(report.checks.every((check) => check.passed === false && !check.skipped))
})


test('nested cleanup fixture waits for both live descendants before root exit', { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ['-e', nestedCleanupFixture()], { stdio: ['ignore', 'pipe', 'pipe'] })
  const pids = []
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const stdoutEnded = new Promise((resolve) => child.stdout.once('end', resolve))
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4_000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    await stdoutEnded
    assert.equal(code, 0, stderr)
    const match = /pids:(\d+),(\d+)/u.exec(stdout)
    assert.ok(match, stdout)
    pids.push(Number(match[1]), Number(match[2]))
    assert.notEqual(pids[0], pids[1])
    for (const pid of pids) process.kill(pid, 0)
  } finally {
    clearTimeout(deadline)
    child.kill('SIGKILL')
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
})


test('nested qualification rejects a helper that leaves real descendants running', { timeout: 20_000 }, async () => {
  const pids = []
  let child
  try {
    await assert.rejects(checkNestedChildCleanup({
      startHelper(executable, args) {
        child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'] })
        let stdout = ''
        child.stdout.on('data', (chunk) => {
          stdout += chunk
          const match = /pids:(\d+),(\d+)/u.exec(stdout)
          if (match && pids.length === 0) pids.push(Number(match[1]), Number(match[2]))
        })
        const closed = new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        })
        return { child, closed, output: () => ({ stdout, stderr: '' }) }
      },
    }), /containedProcessStillRunning/u)
    assert.equal(pids.length, 2)
    for (const pid of pids) process.kill(pid, 0)
  } finally {
    child?.kill('SIGKILL')
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
})
