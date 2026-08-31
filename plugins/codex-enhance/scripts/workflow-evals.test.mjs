import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateLeafOutput,
  evaluateLifecycleTrace,
  evaluateParentScopeIsolation,
  evaluateWorkflowRun,
  workflowEvalRunCase,
} from '../skills/codex-explore/evals/run-workflow-evals.mjs';
import {
  collectFinalAgentResults,
} from '../skills/codex-explore/evals/eval-harness.mjs';
import { inspectExploreRoleContract } from '../skills/codex-explore/evals/codex-workflow-adapter.mjs';
import workflowCorpusDocument from '../skills/codex-explore/evals/workflow-evals.json' with { type: 'json' };
import outputContractCorpusDocument from '../skills/codex-explore/evals/output-contract-evals.json' with { type: 'json' };

const lifecycleContract = {
  minimum_initial_wait_timeout_ms: 600_000,
  allow_liveness_probe: false,
  max_recoveries: 1,
};

const syntheticExpected = {
  spawn_count: 1,
  agent_type: 'synthetic-agent',
  final_message_includes_all: ['RESULT value=ok'],
  final_message_patterns: ['RESULT\\s+value=ok'],
  delegated_source_prefixes: ['synthetic-source/'],
  workspace_unchanged: true,
  lifecycle: lifecycleContract,
};

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (entry) => typeof entry === 'string' && entry.length > 0,
  );
}

function lifecycleEvent(tool, argumentsValue = {}, output = {}) {
  return { tool, arguments: argumentsValue, output };
}

function spawnEvent() {
  return lifecycleEvent(
    'spawn_agent',
    { agent_type: 'synthetic-agent' },
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
  return 'Evidence: synthetic-source/result.txt:2\nRESULT value=ok';
}

function passingTimeline() {
  return [spawnEvent(), waitEvent(), messageEvent()];
}

function runResult(finalMessage, collaborationTimeline = passingTimeline()) {
  return {
    execution_error: false,
    termination: 'completed',
    exit_code: 0,
    cleanup_confirmed: true,
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

function testCorpusAndAssertions() {
  const spec = workflowCorpusDocument;
  assert.equal(spec.version, 1);
  assert.equal(spec.suite.kind, 'codex-workflow');
  assert.equal(spec.suite.unitUnderTest, 'codex-explore');
  assert.equal(spec.cases.length > 0, true);
  assert.equal(spec.cases.every((entry) => (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.input?.prompt === 'string' &&
    entry.input.prompt.length > 0 &&
    (entry.input.parent_model === undefined || typeof entry.input.parent_model === 'string') &&
    (entry.input.codex_config === undefined || typeof entry.input.codex_config === 'object') &&
    Number.isInteger(entry.expected?.criteria?.spawn_count) &&
    typeof entry.expected?.criteria?.agent_type === 'string' &&
    entry.expected.criteria.agent_type.length > 0 &&
    nonEmptyStrings(entry.expected?.criteria?.final_message_includes_all) &&
    nonEmptyStrings(entry.expected?.criteria?.final_message_patterns) &&
    nonEmptyStrings(entry.expected?.criteria?.delegated_source_prefixes) &&
    typeof entry.expected?.criteria?.workspace_unchanged === 'boolean' &&
    Number.isInteger(entry.expected?.criteria?.lifecycle?.minimum_initial_wait_timeout_ms) &&
    typeof entry.expected?.criteria?.lifecycle?.allow_liveness_probe === 'boolean' &&
    Number.isInteger(entry.expected?.criteria?.lifecycle?.max_recoveries)
  )), true);
  assert.equal(new Set(spec.cases.map((entry) => entry.id)).size, spec.cases.length);
  assert.equal(outputContractCorpusDocument.version, 1);
  assert.equal(outputContractCorpusDocument.suite.unitUnderTest, 'codex-explore');
  assert.equal(outputContractCorpusDocument.cases.length, 6);
  assert.deepEqual(
    outputContractCorpusDocument.cases.map((entry) => entry.id),
    [
      'shared_source_direct',
      'multiple_sources_one_finding',
      'inference_with_direct_basis',
      'conflicting_sources',
      'blocked_authenticated_source',
      'insufficient_partial_record',
    ],
  );
  assert.equal(outputContractCorpusDocument.cases.every((entry) => (
    ['completed', 'blocked', 'insufficient'].includes(entry.expected?.criteria?.leaf_output?.status) &&
    Array.isArray(entry.expected?.criteria?.leaf_output?.kinds) &&
    nonEmptyStrings(entry.expected?.criteria?.leaf_output?.includes_all) &&
    nonEmptyStrings(entry.expected?.criteria?.leaf_output?.patterns) &&
    ['absent', 'present'].includes(entry.expected?.criteria?.leaf_output?.gaps) &&
    entry.expected?.criteria?.lifecycle?.max_recoveries === 0
  )), true);
  assert.deepEqual(
    workflowEvalRunCase({
      prompt: 'inspect',
      parent_model: 'parent-model',
      codex_config: { feature: true },
    }),
    {
      query: 'inspect',
      parent_model: 'parent-model',
      explicit_skill: true,
      should_load_skill: true,
      should_spawn_agent: true,
      wait_for_completion: true,
      codex_config: { feature: true },
    },
  );

  assert.equal(
    evaluateWorkflowRun(runResult(passingMessage()), syntheticExpected).passed,
    true,
  );

  const duplicateExploration = runResult(passingMessage(), [
    spawnEvent(),
    waitEvent(),
    lifecycleEvent('exec_command', { cmd: 'rg value synthetic-source/' }),
    messageEvent(),
  ]);
  const duplicate = evaluateWorkflowRun(duplicateExploration, syntheticExpected);
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
      lifecycleEvent('exec_command', { cmd: 'find synthetic-source -type f' }),
      messageEvent(),
    ], ['synthetic-source/']).passed,
    false,
  );

  assert.equal(
    evaluateParentScopeIsolation([
      spawnEvent(),
      waitEvent(),
      lifecycleEvent('exec', {
        input: 'const result = await tools.exec_command({cmd:"rg value synthetic-source/records"}); text(result.output);',
      }, 'Script completed'),
      messageEvent(),
    ], ['synthetic-source/records']).passed,
    false,
  );

  assert.equal(
    evaluateParentScopeIsolation([
      spawnEvent(),
      waitEvent(),
      lifecycleEvent('update_plan', { step: 'wait for delegated work' }),
      messageEvent(),
    ], ['synthetic-source/']).passed,
    true,
  );

  const minimalVerification = runResult(passingMessage(), [
    spawnEvent(),
    waitEvent(),
    messageEvent(),
    lifecycleEvent('exec_command', { cmd: 'sed -n 2p synthetic-source/result.txt' }),
  ]);
  assert.equal(
    evaluateWorkflowRun(minimalVerification, syntheticExpected).passed,
    true,
  );

  const wrongFacts = passingMessage().replace(
    'RESULT value=ok',
    'RESULT value=wrong',
  );
  assert.equal(
    evaluateWorkflowRun(runResult(wrongFacts), syntheticExpected).passed,
    false,
  );

  const changedWorkspace = runResult(passingMessage());
  changedWorkspace.workspace_changes.modified.push('synthetic-source/input.txt');
  const changed = evaluateWorkflowRun(changedWorkspace, syntheticExpected);
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
    payload: 'done',
  });
  assert.deepEqual(collectFinalAgentResults(timeline), [{
    source: 'agent_message',
    task_name: '/root/evidence',
    text: 'done',
  }]);
  assert.deepEqual(collectFinalAgentResults([
    ...timeline,
    lifecycleEvent('wait_agent', {}, {
      status: {
        '/root/evidence': { completed: 'done' },
      },
    }),
  ]), [{
    source: 'agent_message',
    task_name: '/root/evidence',
    text: 'done',
  }]);
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

function testLeafOutputAssertions() {
  const contract = {
    status: 'completed',
    kinds: ['direct', 'inference'],
    includes_all: ['45s', 'docs/api.md:2', 'docs/migration.md:2'],
    patterns: ['docs/api\\.md:2', 'docs/migration\\.md:2'],
    gaps: 'absent',
  };
  const output = [
    'Status: completed',
    '',
    '## Findings',
    '- [direct] Timeout is 45s — docs/api.md:2',
    '- [inference] Migration matches v2 — 依据 docs/api.md:2; docs/migration.md:2',
  ].join('\n');
  assert.equal(
    evaluateLeafOutput([{ source: 'agent_message', task_name: 'evidence', text: output }], contract)
      .passed,
    true,
  );
  assert.equal(
    evaluateLeafOutput(
      [{ source: 'agent_message', task_name: 'evidence', text: `${output}\n\n## Gaps\n- 无` }],
      contract,
    ).passed,
    false,
  );
  assert.equal(
    evaluateLeafOutput(
      [{
        source: 'agent_message',
        task_name: 'evidence',
        text: 'Status: blocked — 登录凭据不可用\n\n## Findings',
      }],
      {
        status: 'blocked',
        kinds: [],
        includes_all: ['登录凭据不可用'],
        patterns: ['^Status: blocked — .+'],
        gaps: 'absent',
      },
    ).passed,
    true,
  );
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
  assert.deepEqual(collectFinalAgentResults(v1CompletedWait), [{
    source: 'wait_agent',
    task_name: 'agent-id',
    text: 'Status: completed',
  }]);

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

async function testRoleContractDigest() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-role-contract-'));
  const agentsRoot = path.join(root, '.codex', 'agents');
  try {
    await mkdir(agentsRoot, { recursive: true });
    for (const name of [
      'codex-explore-custom',
      'codex-explore-deep',
      'codex-explore-quick',
      'codex-explore-standard',
    ]) {
      await writeFile(
        path.join(agentsRoot, `${name}.toml`),
        `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(`${name} role`)}\ndeveloper_instructions = "Inspect evidence."\n`,
        'utf8',
      );
    }
    const initial = await inspectExploreRoleContract(root);
    assert.match(initial.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(initial.roles.map((role) => role.name), [
      'codex-explore-custom',
      'codex-explore-deep',
      'codex-explore-quick',
      'codex-explore-standard',
    ]);
    await writeFile(
      path.join(agentsRoot, 'codex-explore-standard.toml'),
      'name = "codex-explore-standard"\ndescription = "standard role"\ndeveloper_instructions = "Changed."\n',
      'utf8',
    );
    assert.notEqual((await inspectExploreRoleContract(root)).digest, initial.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  testCorpusAndAssertions();
  testLeafOutputAssertions();
  testLifecycleAssertions();
  await testRoleContractDigest();
  console.log('workflow eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
