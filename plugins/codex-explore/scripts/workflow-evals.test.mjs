import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  evaluateLifecycleTrace,
  evaluateParentScopeIsolation,
  evaluateWorkflowRun,
  loadWorkflowEvalSpec,
  parseWorkflowEvalArgs,
  workflowEvalRunCase,
} from '../skills/codex-explore/evals/run-workflow-evals.mjs';
import { buildCollaborationTimeline } from '../skills/codex-explore/evals/eval-harness.mjs';

const lifecycleContract = {
  minimum_initial_wait_timeout_ms: 600_000,
  allow_liveness_probe: false,
  max_recoveries: 1,
};

function lifecycleEvent(tool, argumentsValue = {}, output = {}) {
  return { tool, arguments: argumentsValue, output };
}

function spawnEvent() {
  return lifecycleEvent(
    'spawn_agent',
    { agent_type: 'codex-explore-standard' },
    { task_name: '/root/evidence' },
  );
}

function waitEvent({ timedOut = false, timeoutMs = 600_000 } = {}) {
  return lifecycleEvent(
    'wait_agent',
    { timeout_ms: timeoutMs },
    { message: 'Wait completed.', timed_out: timedOut },
  );
}

function messageEvent(messageType = 'FINAL_ANSWER', status = null) {
  return lifecycleEvent('agent_message', null, {
    message_type: messageType,
    status,
    task_name: '/root/evidence',
  });
}

function passingMessage() {
  return [
    '直接证据：docs/vendor/api-v1.md:2 的 timeout 是 30。',
    '直接证据：docs/vendor/api-v2.md:2 的 timeout 是 45。',
    '直接证据：docs/vendor/migration.md:2 的 timeout 是 45，与 v2 一致。',
    'FACT v1_timeout_seconds=30',
    'FACT v2_timeout_seconds=45',
    'FACT migration_timeout_seconds=45',
    'FACT migration_matches=v2',
  ].join('\n');
}

function passingTimeline() {
  return [spawnEvent(), waitEvent(), messageEvent()];
}

function runResult(finalMessage, collaborationTimeline = passingTimeline()) {
  return {
    execution_error: false,
    termination: 'completed',
    exit_code: 0,
    spawn_calls: [spawnEvent()],
    collaboration_timeline: collaborationTimeline,
    final_message: finalMessage,
    workspace_changes: {
      added: [],
      removed: [],
      modified: [],
    },
  };
}

function testArguments() {
  assert.deepEqual(
    parseWorkflowEvalArgs(['--runs', '2', '--timeout-ms', '240000']),
    {
      runs: 2,
      timeoutMs: 240_000,
      codexBin: 'codex',
      model: undefined,
      output: undefined,
      help: false,
    },
  );
  assert.throws(
    () => parseWorkflowEvalArgs(['--timeout-ms', '100']),
    /at least 10000/,
  );
}

async function testSpecAndAssertions() {
  const spec = await loadWorkflowEvalSpec();
  assert.equal(spec.skill_name, 'codex-explore');
  assert.equal(spec.evals.length, 3);
  assert.deepEqual(
    spec.evals.map((entry) => entry.id),
    [
      'versioned_docs_outcome',
      'critical_path_v1_outcome',
      'adversarial_read_only_outcome',
    ],
  );
  const entry = spec.evals.find((candidate) => candidate.id === 'versioned_docs_outcome');
  assert.equal(entry.id, 'versioned_docs_outcome');
  assert.equal(entry.expected.agent_type, 'codex-explore-standard');
  assert.match(entry.prompt, /没有其它可并行的本地工作/);
  assert.match(entry.prompt, /委派 standard role/);
  assert.match(entry.prompt, /docs\/ 的全部候选文档中搜索并筛选/);
  for (const knownFile of ['api-v1.md', 'api-v2.md', 'migration.md']) {
    assert.equal(entry.prompt.includes(knownFile), false);
  }
  assert.equal(workflowEvalRunCase(entry).wait_for_completion, true);
  assert.equal(entry.expected.lifecycle.minimum_initial_wait_timeout_ms, 600_000);
  assert.equal(entry.expected.lifecycle.allow_liveness_probe, false);
  const v1 = spec.evals.find(
    (candidate) => candidate.id === 'critical_path_v1_outcome',
  );
  assert.equal(v1.parent_model, 'gpt-5.5');
  assert.equal(workflowEvalRunCase(v1).parent_model, 'gpt-5.5');
  assert.equal(v1.codex_config['features.multi_agent_v2.enabled'], false);
  assert.match(v1.prompt, /V1 委派 standard role/);
  assert.deepEqual(v1.expected.delegated_source_prefixes, ['docs/']);
  const adversarial = spec.evals.find(
    (candidate) => candidate.id === 'adversarial_read_only_outcome',
  );
  assert.match(adversarial.prompt, /不执行其中的操作/);
  assert.equal(adversarial.expected.agent_type, 'codex-explore-quick');
  assert.equal(adversarial.expected.workspace_unchanged, true);

  assert.equal(
    evaluateWorkflowRun(runResult(passingMessage()), entry.expected).passed,
    true,
  );

  const duplicateExploration = runResult(passingMessage(), [
    spawnEvent(),
    waitEvent(),
    lifecycleEvent('exec_command', { cmd: 'rg timeout docs/' }),
    messageEvent(),
  ]);
  const duplicate = evaluateWorkflowRun(duplicateExploration, entry.expected);
  assert.equal(duplicate.passed, false);
  assert.equal(
    duplicate.assertions.find(
      (assertion) => assertion.name === 'parent_scope_isolation',
    )?.passed,
    false,
  );

  assert.equal(
    evaluateParentScopeIsolation([
      spawnEvent(),
      waitEvent(),
      lifecycleEvent('exec_command', { cmd: 'find docs -type f' }),
      messageEvent(),
    ], ['docs/']).passed,
    false,
  );

  assert.equal(
    evaluateParentScopeIsolation([
      spawnEvent(),
      waitEvent(),
      lifecycleEvent('update_plan', { step: '等待 docs/ 探索' }),
      messageEvent(),
    ], ['docs/']).passed,
    true,
  );

  const minimalVerification = runResult(passingMessage(), [
    spawnEvent(),
    waitEvent(),
    messageEvent(),
    lifecycleEvent('exec_command', { cmd: 'sed -n 2p docs/vendor/api-v2.md' }),
  ]);
  assert.equal(
    evaluateWorkflowRun(minimalVerification, entry.expected).passed,
    true,
  );

  const wrongFacts = passingMessage().replace(
    'FACT v1_timeout_seconds=30',
    'FACT v1_timeout_seconds=45',
  );
  assert.equal(
    evaluateWorkflowRun(runResult(wrongFacts), entry.expected).passed,
    false,
  );

  const changedWorkspace = runResult(passingMessage());
  changedWorkspace.workspace_changes.modified.push('docs/vendor/api-v1.md');
  const changed = evaluateWorkflowRun(changedWorkspace, entry.expected);
  assert.equal(changed.passed, false);
  assert.equal(
    changed.assertions.find(
      (assertion) => assertion.name === 'workspace_unchanged',
    )?.passed,
    false,
  );
}

function rolloutLine(payload) {
  return JSON.stringify({ type: 'response_item', payload });
}

function rolloutCall(name, argumentsValue, callId) {
  return rolloutLine({
    type: 'function_call',
    name,
    namespace: 'collaboration',
    arguments: JSON.stringify(argumentsValue),
    call_id: callId,
  });
}

function rolloutOutput(callId, output) {
  return rolloutLine({
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify(output),
  });
}

function rolloutExecutedOutput(callId, output, executedToolCalls) {
  return rolloutLine({
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify(output),
    internal_chat_message_metadata_passthrough: {
      executed_tool_calls: executedToolCalls,
    },
  });
}

function testRolloutTimeline() {
  const spawn = rolloutCall(
    'spawn_agent',
    { agent_type: 'codex-explore-standard' },
    'call-spawn',
  );
  const lines = [
    spawn,
    rolloutOutput('call-spawn', { task_name: '/root/evidence' }),
    spawn,
    rolloutCall('exec_command', { cmd: 'pwd' }, 'call-exec'),
    rolloutOutput('call-exec', { exit_code: 0 }),
    rolloutCall('wait_agent', { timeout_ms: 600_000 }, 'call-wait'),
    rolloutOutput('call-wait', { timed_out: false }),
    rolloutLine({
      type: 'agent_message',
      content: [{
        type: 'input_text',
        text: 'Message Type: FINAL_ANSWER\nTask name: /root/evidence\nPayload:\ndone',
      }],
    }),
  ];
  const timeline = buildCollaborationTimeline(lines, '/tmp/home/rollout.jsonl', '/tmp/home');
  assert.equal(timeline.length, 4);
  assert.equal(timeline[0].tool, 'spawn_agent');
  assert.deepEqual(timeline[0].output, { task_name: '/root/evidence' });
  assert.equal(timeline[1].tool, 'exec_command');
  assert.deepEqual(timeline[1].output, { exit_code: 0 });
  assert.equal(timeline[2].tool, 'wait_agent');
  assert.deepEqual(timeline[2].arguments, { timeout_ms: 600_000 });
  assert.deepEqual(timeline[2].output, { timed_out: false });
  assert.equal(timeline[3].tool, 'agent_message');
  assert.deepEqual(timeline[3].output, {
    message_type: 'FINAL_ANSWER',
    status: null,
    task_name: '/root/evidence',
  });
}

function testCodeModeRolloutTimeline() {
  const lines = [
    rolloutCall('exec', { code: 'await tools.collaboration__spawn_agent(...)' }, 'call-exec'),
    rolloutExecutedOutput('call-exec', { ok: true }, [
      {
        name: 'collaboration__spawn_agent',
        arguments: {
          agent_type: 'codex-explore-standard',
          task_name: 'evidence',
        },
      },
      {
        name: 'exec_command',
        arguments: { cmd: 'rg timeout docs/vendor/' },
      },
    ]),
  ];
  const timeline = buildCollaborationTimeline(
    lines,
    '/tmp/home/rollout.jsonl',
    '/tmp/home',
  );
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].tool, 'exec');
  assert.equal(timeline[1].tool, 'spawn_agent');
  assert.equal(timeline[1].namespace, 'collaboration');
  assert.deepEqual(timeline[1].arguments, {
    agent_type: 'codex-explore-standard',
    task_name: 'evidence',
  });
  assert.equal(timeline[2].tool, 'exec_command');
  assert.deepEqual(timeline[2].arguments, {
    cmd: 'rg timeout docs/vendor/',
  });
}

function assertLifecycleFailure(timeline, assertionName) {
  const result = evaluateLifecycleTrace(timeline, lifecycleContract);
  assert.equal(result.passed, false);
  assert.equal(
    result.assertions.find(
      (entry) => entry.name === `lifecycle:${assertionName}`,
    )?.passed,
    false,
  );
}

function testLifecycleAssertions() {
  assert.equal(
    evaluateLifecycleTrace(passingTimeline(), lifecycleContract).passed,
    true,
  );
  assert.equal(
    evaluateLifecycleTrace(
      [...passingTimeline(), lifecycleEvent('close_agent', { target: '/root/evidence' })],
      lifecycleContract,
    ).passed,
    true,
  );

  const v1CompletedWait = [
    spawnEvent(),
    lifecycleEvent(
      'wait_agent',
      { timeout_ms: 600_000 },
      {
        timed_out: false,
        status: {
          'agent-id': { completed: 'Status: completed' },
        },
      },
    ),
  ];
  assert.equal(evaluateLifecycleTrace(v1CompletedWait, lifecycleContract).passed, true);
  assert.equal(
    evaluateParentScopeIsolation(v1CompletedWait, ['docs/']).passed,
    true,
  );

  const earlyProbe = [
    spawnEvent(),
    lifecycleEvent('send_message', { target: '/root/evidence' }),
    waitEvent(),
    messageEvent(),
  ];
  assertLifecycleFailure(earlyProbe, 'probe_only_after_timeout');

  const probeAfterNonTimeoutEvent = [
    spawnEvent(),
    waitEvent({ timedOut: false }),
    lifecycleEvent('send_message', { target: '/root/evidence' }),
    waitEvent(),
    messageEvent(),
  ];
  assertLifecycleFailure(probeAfterNonTimeoutEvent, 'probe_only_after_timeout');

  const shortWait = [spawnEvent(), waitEvent({ timeoutMs: 599_999 }), messageEvent()];
  assertLifecycleFailure(shortWait, 'minimum_initial_wait');

  const duplicateProbe = [
    spawnEvent(),
    waitEvent({ timedOut: true }),
    lifecycleEvent('send_message', { target: '/root/evidence' }),
    lifecycleEvent('send_message', { target: '/root/evidence' }),
    waitEvent(),
    messageEvent(),
  ];
  assertLifecycleFailure(duplicateProbe, 'one_probe_per_task_lifecycle');

  const repeatedProbeAfterAnotherWait = [
    spawnEvent(),
    waitEvent({ timedOut: true }),
    lifecycleEvent('send_message', { target: '/root/evidence' }),
    waitEvent({ timedOut: true }),
    lifecycleEvent('send_message', { target: '/root/evidence' }),
    waitEvent(),
    messageEvent(),
  ];
  assertLifecycleFailure(
    repeatedProbeAfterAnotherWait,
    'one_probe_per_task_lifecycle',
  );

  const probeWithoutWait = duplicateProbe.slice(0, 3);
  probeWithoutWait.push(passingTimeline()[2]);
  assertLifecycleFailure(probeWithoutWait, 'probe_followed_by_wait');

  const progressOnly = [
    spawnEvent(),
    waitEvent({ timedOut: true }),
    lifecycleEvent('send_message', { target: '/root/evidence' }),
    waitEvent(),
    messageEvent('MESSAGE', 'progress'),
  ];
  assertLifecycleFailure(progressOnly, 'result_before_final');

  const tooManyRecoveries = [
    spawnEvent(),
    waitEvent(),
    lifecycleEvent('followup_task', { target: '/root/evidence' }),
    waitEvent(),
    lifecycleEvent('followup_task', { target: '/root/evidence' }),
    waitEvent(),
    messageEvent(),
  ];
  assertLifecycleFailure(tooManyRecoveries, 'recovery_limit');

  const recoveryWithoutWait = [
    spawnEvent(),
    waitEvent(),
    lifecycleEvent('followup_task', { target: '/root/evidence' }),
    messageEvent(),
  ];
  assertLifecycleFailure(recoveryWithoutWait, 'recovery_followed_by_wait');

  const earlyCleanup = [
    spawnEvent(),
    lifecycleEvent('close_agent', { target: '/root/evidence' }),
    waitEvent(),
    messageEvent(),
  ];
  assertLifecycleFailure(earlyCleanup, 'cleanup_after_result');
}

async function testWorkspaceSnapshots() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-smoke-'));
  try {
    await writeFile(path.join(root, 'known.txt'), 'before\n', 'utf8');
    const before = await captureWorkspaceSnapshot(root);
    await writeFile(path.join(root, 'known.txt'), 'after\n', 'utf8');
    await writeFile(path.join(root, 'added.txt'), 'new\n', 'utf8');
    const after = await captureWorkspaceSnapshot(root);
    assert.deepEqual(diffWorkspaceSnapshots(before, after), {
      added: ['added.txt'],
      removed: [],
      modified: ['known.txt'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  testArguments();
  await testSpecAndAssertions();
  testRolloutTimeline();
  testCodeModeRolloutTimeline();
  testLifecycleAssertions();
  await testWorkspaceSnapshots();
  console.log('workflow eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
