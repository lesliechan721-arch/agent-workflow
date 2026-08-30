import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateLifecycleTimeline } from '../skills/codex-subagent-guide/evals/run-lifecycle-evals.mjs';

const expected = {
  spawn_count: 1,
  minimum_initial_wait_timeout_ms: 600_000,
  require_timeout: true,
};

function call(tool, argumentsValue = null, output = null) {
  return { tool, arguments: argumentsValue, output };
}

test('accepts timeout, re-wait, terminal result, and later conditional cleanup', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent', { task_name: 'evidence' }),
    call('wait_agent', { timeout_ms: 600_000 }, { timed_out: true }),
    call('wait_agent', { timeout_ms: 600_000 }, { status: { evidence: { completed: 'done' } } }),
    call('agent_message', null, { message_type: 'FINAL_ANSWER' }),
    call('close_agent', { target: 'evidence' }),
  ], expected);

  assert.equal(result.passed, true);
});

test('rejects cleanup before a terminal result', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent'),
    call('wait_agent', { timeout_ms: 600_000 }, { timed_out: true }),
    call('close_agent'),
    call('wait_agent', { timeout_ms: 600_000 }, { status: { evidence: { completed: 'done' } } }),
  ], expected);

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.passed,
    false,
  );
});

test('rejects an initial wait shorter than the configured minimum', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent'),
    call('wait_agent', { timeout_ms: 30_000 }, { status: { evidence: { completed: 'done' } } }),
  ], expected);

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'minimum_initial_wait')?.passed,
    false,
  );
});

test('rejects a timed-out wait without another wait', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent'),
    call('wait_agent', { timeout_ms: 600_000 }, { timed_out: true }),
  ], expected);

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'timeout_followed_by_wait')?.passed,
    false,
  );
});

test('rejects a required timeout that was not observed', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent'),
    call('wait_agent', { timeout_ms: 600_000 }, { status: { evidence: { completed: 'done' } } }),
  ], expected);

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'timeout_observed')?.passed,
    false,
  );
  assert.equal(
    result.assertions.find((entry) => entry.name === 'timeout_followed_by_wait')?.passed,
    false,
  );
});

test('accepts a normal terminal path when timeout coverage is not required', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent'),
    call('wait_agent', { timeout_ms: 600_000 }, { status: { evidence: { completed: 'done' } } }),
    call('agent_message', null, { message_type: 'FINAL_ANSWER' }),
  ], { ...expected, require_timeout: false });

  assert.equal(result.passed, true);
});
