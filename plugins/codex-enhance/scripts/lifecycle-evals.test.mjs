import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateLifecycleTimeline,
  parseLifecycleArgs,
  selectLifecycleCases,
} from '../skills/codex-subagent-guide/evals/run-lifecycle-evals.mjs';

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

test('selects lifecycle cases for the active materialization profile', () => {
  const document = {
    skill_name: 'codex-subagent-guide',
    evals: [
      { id: 'normal', profiles: ['project-default'] },
      { id: 'timeout', profiles: ['project-timeout'] },
    ],
  };

  assert.deepEqual(
    selectLifecycleCases(document, { profile: 'project-default' }).map((entry) => entry.id),
    ['normal'],
  );
  assert.deepEqual(
    selectLifecycleCases(document, { profile: 'project-timeout' }).map((entry) => entry.id),
    ['timeout'],
  );
  assert.throws(
    () => selectLifecycleCases(document, {
      caseId: 'normal',
      profile: 'project-timeout',
    }),
    /Unknown lifecycle case for profile project-timeout: normal/,
  );
});

test('parses central command-suite arguments', () => {
  assert.deepEqual(
    parseLifecycleArgs([
      '--runs', '2',
      '--case', 'wait_for_terminal_result',
      '--model', 'gpt-test',
      '--codex-bin', '/tmp/codex',
      '--timeout-ms', '120000',
      '--output', './result.json',
    ]),
    {
      runs: 2,
      timeoutMs: 120_000,
      codexBin: '/tmp/codex',
      model: 'gpt-test',
      caseId: 'wait_for_terminal_result',
      output: path.resolve('./result.json'),
      help: false,
    },
  );
});
