import assert from 'node:assert/strict';
import test from 'node:test';

import { evidenceRun } from '../skills/codex-subagent-guide/evals/codex-workflow-adapter.mjs';
import { evaluateLifecycleTimeline, evaluateContinuation } from '../skills/codex-subagent-guide/evals/run-lifecycle-evals.mjs';

const expected = {
  spawn_count: 1,
  minimum_initial_wait_timeout_ms: 600_000,
  require_timeout: true,
};

function call(tool, argumentsValue = null, output = null, details = {}) {
  return { ...details, tool, arguments: argumentsValue, output };
}

function normalizedTimeline(calls) {
  const evidence = {
    rootThreadId: 'root',
    threadGraph: [{ threadId: 'root' }],
    collaborationCalls: calls.map((entry, index) => ({
      ordinal: index + 1,
      threadId: 'root',
      parentThreadId: null,
      callId: `call-${index + 1}`,
      namespace: 'collaboration',
      status: 'completed',
      ...entry,
    })),
    leafCalls: [],
    skillLoads: [],
    termination: { reason: 'completed', appServerProcessTreeCleanupConfirmed: true },
    cleanup: { isolatedCodexHomeRemoved: true },
    finalMessage: 'done',
    workspaceDiff: { added: [], removed: [], modified: [] },
    completion: { durationMs: 1 },
    usage: {},
  };
  return evidenceRun(evidence, { input: { prompt: '' } }, 'current').collaboration_timeline;
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
    call('spawn_agent', { task_name: 'evidence' }),
    call('wait_agent', { timeout_ms: 600_000 }, { timed_out: true }),
    call('close_agent', { target: 'evidence' }),
    call('wait_agent', { timeout_ms: 600_000 }, { status: { evidence: { completed: 'done' } } }),
  ], expected);

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.passed,
    false,
  );
});

test('accepts cleanup of each completed target before a later delivery starts', () => {
  const result = evaluateLifecycleTimeline(normalizedTimeline([
    call('spawn_agent', { task_name: 'first' }, { agent_id: 'thread-first' }),
    call('wait_agent', { timeout_ms: 600_000, receiver_thread_ids: ['thread-first'] }, {
      status: { 'thread-first': { completed: 'done' } },
    }, { linkedThreadId: 'thread-first' }),
    call('close_agent', { receiver_thread_ids: ['thread-first'] }),
    call('spawn_agent', { task_name: 'second' }, { agent_id: 'thread-second' }),
    call('wait_agent', { timeout_ms: 600_000, receiver_thread_ids: ['thread-second'] }, {
      status: { 'thread-second': { completed: 'done' } },
    }, { linkedThreadId: 'thread-second' }),
    call('close_agent', { receiver_thread_ids: ['thread-second'] }),
  ]), { ...expected, spawn_count: 2, require_timeout: false });

  assert.equal(result.passed, true);
});

test('rejects cleanup when only another target has completed', () => {
  const result = evaluateLifecycleTimeline(normalizedTimeline([
    call('spawn_agent', { task_name: 'first' }, { agent_id: 'thread-first' }),
    call('spawn_agent', { task_name: 'second' }, { agent_id: 'thread-second' }),
    call('wait_agent', { timeout_ms: 600_000, receiver_thread_ids: ['thread-first'] }, {
      status: { 'thread-first': { completed: 'done' } },
    }, { linkedThreadId: 'thread-first' }),
    call('close_agent', { receiver_thread_ids: ['thread-second'] }),
  ]), { ...expected, spawn_count: 2, require_timeout: false });

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.passed,
    false,
  );
});

test('rejects cleanup with missing or unknown target evidence', () => {
  for (const argumentsValue of [null, { target: 'unknown' }]) {
    const result = evaluateLifecycleTimeline([
      call('spawn_agent', { task_name: 'evidence' }),
      call('wait_agent', { timeout_ms: 600_000 }, { status: { evidence: { completed: 'done' } } }),
      call('close_agent', argumentsValue),
    ], { ...expected, require_timeout: false });

    assert.equal(result.passed, false);
    assert.equal(
      result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.passed,
      false,
    );
    assert.match(
      result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.evidence ?? '',
      argumentsValue ? /cleanup_target_not_spawned/u : /cleanup_target_missing/u,
    );
  }
});

test('rejects ambiguous cleanup target evidence', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent', { task_name: 'shared' }, { agent_id: 'thread-first' }),
    call('spawn_agent', { task_name: 'shared' }, { agent_id: 'thread-second' }),
    call('wait_agent', { timeout_ms: 600_000 }, {
      status: {
        'thread-first': { completed: 'done' },
        'thread-second': { completed: 'done' },
      },
    }),
    call('close_agent', { target: 'shared' }),
  ], { ...expected, spawn_count: 2, require_timeout: false });

  assert.equal(result.passed, false);
  assert.match(
    result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.evidence ?? '',
    /cleanup_target_ambiguous/u,
  );
});

test('does not match a terminal result by basename from another parent path', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent', { task_name: 'evidence' }, { task_name: '/root/evidence' }),
    call('wait_agent', { timeout_ms: 600_000 }, {
      status: { '/root/other/evidence': { completed: 'done' } },
    }),
    call('close_agent', { target: '/root/evidence' }),
  ], { ...expected, require_timeout: false });

  assert.equal(result.passed, false);
  assert.match(
    result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.evidence ?? '',
    /target_terminal_result_missing/u,
  );
});

test('does not match a cleanup target by basename from another parent path', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent', { task_name: 'evidence' }, { task_name: '/root/evidence' }),
    call('wait_agent', { timeout_ms: 600_000 }, {
      status: { '/root/evidence': { completed: 'done' } },
    }),
    call('close_agent', { target: '/root/other/evidence' }),
  ], { ...expected, require_timeout: false });

  assert.equal(result.passed, false);
  assert.match(
    result.assertions.find((entry) => entry.name === 'cleanup_after_result')?.evidence ?? '',
    /cleanup_target_not_spawned/u,
  );
});

test('rejects an initial wait shorter than the required minimum', () => {
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

test('rejects a timed-out wait without later progress', () => {
  const result = evaluateLifecycleTimeline([
    call('spawn_agent'),
    call('wait_agent', { timeout_ms: 600_000 }, { timed_out: true }),
  ], expected);

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'timeout_followed_by_progress')?.passed,
    false,
  );
});

test('accepts a terminal notification after timeout without another wait', () => {
  const result = evaluateLifecycleTimeline(normalizedTimeline([
    call('spawn_agent', { task_name: 'evidence' }, { agent_id: 'thread-evidence' }),
    call('wait_agent', { timeout_ms: 600_000, receiver_thread_ids: ['thread-evidence'] }, {
      timed_out: true,
      status: { 'thread-evidence': 'running' },
    }, { linkedThreadId: 'thread-evidence' }),
    call('agent_message', null, {
      messageType: 'FINAL_ANSWER',
      taskName: '/root',
    }, { linkedThreadId: 'thread-evidence' }),
    call('close_agent', { receiver_thread_ids: ['thread-evidence'] }),
  ]), expected);

  assert.equal(result.passed, true);
});

test('does not accept another target progress after a timeout', () => {
  const result = evaluateLifecycleTimeline(normalizedTimeline([
    call('spawn_agent', { task_name: 'first' }, { agent_id: 'thread-first' }),
    call('spawn_agent', { task_name: 'second' }, { agent_id: 'thread-second' }),
    call('wait_agent', { timeout_ms: 600_000, receiver_thread_ids: ['thread-first'] }, {
      timed_out: true,
      status: { 'thread-first': 'running' },
    }, { linkedThreadId: 'thread-first' }),
    call('wait_agent', { timeout_ms: 600_000, receiver_thread_ids: ['thread-second'] }, {
      status: { 'thread-second': { completed: 'done' } },
    }, { linkedThreadId: 'thread-second' }),
    call('agent_message', null, {
      messageType: 'FINAL_ANSWER',
      taskName: '/root',
    }, { linkedThreadId: 'thread-second' }),
  ]), { ...expected, spawn_count: 2 });

  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find((entry) => entry.name === 'timeout_followed_by_progress')?.passed,
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
    result.assertions.find((entry) => entry.name === 'timeout_followed_by_progress')?.passed,
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

function continuationEvidence() {
  return {
    rootThreadId: 'root',
    collaborationCalls: [
      { ordinal: 1, threadId: 'root', tool: 'spawn_agent', arguments: { task_name: 'first', fork_turns: 'none' } },
      { ordinal: 2, threadId: 'root', tool: 'agent_message', output: { messageType: 'FINAL_ANSWER' } },
      { ordinal: 3, threadId: 'root', tool: 'spawn_agent', linkedThreadId: 'second', arguments: { task_name: 'second', fork_turns: 'none' } },
    ],
    threadGraph: [{ threadId: 'second', initialMessage: { kind: 'plaintext', text: 'Read src/new-task.ts and report maxRetries.' } }],
    leafCalls: [{ threadId: 'second', tool: 'exec_command', arguments: { cmd: 'cat src/new-task.ts' } }],
    finalMessage: '{"maxRetries":7}',
    workspaceDiff: { added: [], modified: [], removed: [] },
  };
}

test('new delivery requires a fresh scope, actual source reading, and the current result', () => {
  const expected = { followup: false, answer: { maxRetries: 7 } };
  assert.ok(evaluateContinuation(continuationEvidence(), expected).every((check) => check.passed));
  for (const mutate of [
    (evidence) => { evidence.collaborationCalls[2].arguments.fork_turns = 'all'; },
    (evidence) => { evidence.threadGraph[0].initialMessage.text += ' Previously src/simple.ts had retryLimit=3.'; },
    (evidence) => { evidence.leafCalls = []; },
    (evidence) => { evidence.finalMessage = '{"maxRetries":3}'; },
    (evidence) => { evidence.collaborationCalls[1].ordinal = 4; },
  ]) {
    const evidence = continuationEvidence();
    mutate(evidence);
    assert.ok(evaluateContinuation(evidence, expected).some((check) => !check.passed));
  }
});

test('recovery requires the original target and exactly one saved operation', () => {
  const evidence = continuationEvidence();
  evidence.collaborationCalls[0].linkedThreadId = 'first';
  evidence.collaborationCalls[1].ordinal = 3;
  evidence.collaborationCalls[2] = { ordinal: 4, threadId: 'root', tool: 'followup_task', arguments: { target: '/root/first' } };
  evidence.leafCalls = [
    { ordinal: 2, threadId: 'first', arguments: { cmd: 'node scripts/recoverable.mjs start' }, output: { exitCode: 1 } },
    { ordinal: 5, threadId: 'first', arguments: { cmd: 'node scripts/recoverable.mjs finish' }, output: { exitCode: 0 } },
  ];
  const expected = { followup: true, artifact: 'results/progress.json', value: { applied: 1, finished: true } };
  const progress = { applied: 1, finished: true };
  assert.ok(evaluateContinuation(evidence, expected, progress).every((check) => check.passed));
  assert.ok(evaluateContinuation(evidence, expected, { ...progress, applied: 2 }).some((check) => !check.passed));
  for (const mutate of [
    (value) => { value.leafCalls[0].output.exitCode = 0; },
    (value) => { value.leafCalls[1].threadId = 'replacement'; },
    (value) => { value.leafCalls[1].ordinal = 3; },
    (value) => { value.collaborationCalls[1].output.messageType = 'MESSAGE'; },
  ]) {
    const invalid = structuredClone(evidence);
    mutate(invalid);
    assert.ok(evaluateContinuation(invalid, expected, progress).some((check) => !check.passed));
  }
  evidence.collaborationCalls[2].arguments.target = '/root/unrelated';
  assert.ok(evaluateContinuation(evidence, expected, progress).some((check) => !check.passed));
});

test('independent review checks current defects and effective runtime instead of the old finding alone', () => {
  const evidence = continuationEvidence();
  const runtime = { model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
  const answer = { missingRepoDefect: false, uncertainRetryDefect: true, publishedTagReuseDefect: true };
  const expected = { ...runtime, followup: false, answer };
  for (const call of evidence.collaborationCalls.filter((call) => call.tool === 'spawn_agent')) call.effectiveRuntime = runtime;
  evidence.threadGraph[0].initialMessage.text = 'Independently review all of src/publish-v2.mjs against docs/publication-contract.md.';
  evidence.leafCalls[0].arguments.cmd = 'cat src/publish-v2.mjs docs/publication-contract.md';
  evidence.finalMessage = JSON.stringify(answer);
  assert.ok(evaluateContinuation(evidence, expected).every((check) => check.passed));
  evidence.finalMessage = JSON.stringify({ ...answer, uncertainRetryDefect: false });
  assert.ok(evaluateContinuation(evidence, expected).some((check) => !check.passed));
  evidence.finalMessage = JSON.stringify(answer);
  delete evidence.collaborationCalls[2].effectiveRuntime;
  assert.ok(evaluateContinuation(evidence, expected).some((check) => !check.passed));
});
