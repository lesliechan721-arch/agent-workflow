import assert from 'node:assert/strict'
import test from 'node:test'

import { ProcessTreeTimeoutError } from '../perf/process-tree.mjs'
import {
  checkProductionAbortCleanup,
  checkProductionTimeoutCleanup,
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
