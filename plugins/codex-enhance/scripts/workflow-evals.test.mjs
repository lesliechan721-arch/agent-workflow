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

function messageEvent(messageType = 'FINAL_ANSWER', status = null, payload = 'terminal result') {
  return {
    ...lifecycleEvent('agent_message', null, {
      message_type: messageType,
      status,
      task_name: '/root',
      payload,
    }),
    linked_thread_id: 'child-evidence',
  };
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
  assert.equal(spec.suite.policy.optimization, 'precision-first');
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
  const versionedCase = spec.cases.find((entry) => entry.id === 'versioned_docs_outcome');
  assert.equal(versionedCase.input.parent_model, 'gpt-5.6-luna');
  assert.equal(versionedCase.expected.criteria.target_skill_loaded, true);
  assert.equal(versionedCase.expected.criteria.clean_context_leaf_delegation, true);
  assert.equal(nonEmptyStrings(versionedCase.expected.criteria.leaf_terminal_includes_all), true);
  assert.equal(nonEmptyStrings(versionedCase.expected.criteria.leaf_terminal_patterns), true);
  assert.equal(JSON.stringify(versionedCase).includes('verification_tag'), false);
  for (const leakedAnswer of [
    'v1_timeout_seconds=30',
    'v2_timeout_seconds=45',
    'migration_timeout_seconds=45',
    'migration_matches=v2',
    'docs/vendor/api-v1.md:2',
  ]) {
    assert.equal(versionedCase.input.prompt.includes(leakedAnswer), false);
  }
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
      messageEvent('MESSAGE', 'progress', 'progress cites docs/vendor/api-v1.md:2'),
      lifecycleEvent('update_plan', { step: 'wait for delegated work' }),
      messageEvent(),
    ], ['synthetic-source/']).passed,
    true,
  );

  const postTerminalDuplicateRead = runResult(passingMessage(), [
    spawnEvent(),
    waitEvent(),
    messageEvent(),
    lifecycleEvent('exec_command', { cmd: 'sed -n 2p synthetic-source/result.txt' }),
  ]);
  assert.equal(
    evaluateWorkflowRun(postTerminalDuplicateRead, syntheticExpected).passed,
    false,
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

function versionedOutcome() {
  return [
    '- [direct] v1 timeout is 30 seconds — docs/vendor/api-v1.md:2',
    '- [direct] v2 timeout is 45 seconds — docs/vendor/api-v2.md:2',
    '- [direct] migration timeout is 45 seconds — docs/vendor/migration.md:2',
    '- [inference] migration matches v2 — docs/vendor/migration.md:2; docs/vendor/api-v2.md:2',
    'FACT v1_timeout_seconds=30',
    'FACT v2_timeout_seconds=45',
    'FACT migration_timeout_seconds=45',
    'FACT migration_matches=v2',
  ].join('\n');
}

function versionedRun() {
  const childId = 'child-versioned';
  const result = versionedOutcome();
  const spawn = {
    tool: 'spawn_agent',
    call_id: 'spawn-versioned',
    arguments: {
      agent_type: 'codex-explore-standard',
      message: '调查 docs/ 中的 timeout 演进。',
      fork_turns: 'none',
    },
    output: { task_name: '/root/vendor_timeout_docs' },
  };
  const wait = {
    tool: 'wait_agent',
    arguments: { timeout_ms: 600_000 },
    output: { message: 'Wait completed.', timed_out: false },
  };
  const delivered = {
    tool: 'agent_message',
    linked_thread_id: childId,
    arguments: null,
    output: {
      message_type: 'FINAL_ANSWER',
      task_name: null,
      payload: result,
    },
  };
  return {
    ...runResult(result, [spawn, wait, delivered]),
    loaded: true,
    spawn_calls: [spawn],
    leaf_trace: {
      child_threads: [{
        thread_id: childId,
        agent_role: 'codex-explore-standard',
        initial_user_message: null,
        initial_opaque_link: { linkedCallId: 'spawn-versioned' },
      }],
    },
    leaf_tool_calls: [delivered],
  };
}

function testVersionedWorkflowOracle() {
  const expected = workflowCorpusDocument.cases.find(
    (entry) => entry.id === 'versioned_docs_outcome',
  ).expected.criteria;
  const passing = versionedRun();
  assert.equal(evaluateWorkflowRun(passing, expected).passed, true);

  const snakeCaseAssignments = structuredClone(passing);
  const toSnakeCaseAssignments = (value) => value
    .replace('v1 timeout is 30 seconds', 'v1_timeout_seconds=30')
    .replace('v2 timeout is 45 seconds', 'v2_timeout_seconds=45')
    .replace('migration timeout is 45 seconds', 'migration_timeout_seconds=45')
    .replace('migration matches v2', 'migration_matches=v2');
  snakeCaseAssignments.final_message = toSnakeCaseAssignments(
    snakeCaseAssignments.final_message,
  );
  snakeCaseAssignments.leaf_tool_calls[0].output.payload = toSnakeCaseAssignments(
    snakeCaseAssignments.leaf_tool_calls[0].output.payload,
  );
  snakeCaseAssignments.collaboration_timeline[2].output.payload =
    snakeCaseAssignments.leaf_tool_calls[0].output.payload;
  assert.equal(evaluateWorkflowRun(snakeCaseAssignments, expected).passed, true);

  const compressedOutcome = versionedOutcome().replace(
    [
      '- [direct] v1 timeout is 30 seconds — docs/vendor/api-v1.md:2\n',
      '- [direct] v2 timeout is 45 seconds — docs/vendor/api-v2.md:2\n',
      '- [direct] migration timeout is 45 seconds — docs/vendor/migration.md:2',
    ].join(''),
    '- [direct] v1 timeout is 30 seconds docs/vendor/api-v1.md:2; v2 timeout is 45 seconds docs/vendor/api-v2.md:2; migration timeout is 45 seconds docs/vendor/migration.md:2',
  );
  const compressedRootDirectLines = structuredClone(passing);
  compressedRootDirectLines.final_message = compressedOutcome;
  assert.equal(evaluateWorkflowRun(compressedRootDirectLines, expected).passed, false);

  const compressedChildDirectLines = structuredClone(passing);
  compressedChildDirectLines.leaf_tool_calls[0].output.payload = compressedOutcome;
  compressedChildDirectLines.collaboration_timeline[2].output.payload = compressedOutcome;
  assert.equal(evaluateWorkflowRun(compressedChildDirectLines, expected).passed, false);

  const missingLoad = structuredClone(passing);
  missingLoad.loaded = false;
  assert.equal(evaluateWorkflowRun(missingLoad, expected).passed, false);

  const wrongRole = structuredClone(passing);
  wrongRole.leaf_trace.child_threads[0].agent_role = 'codex-explore-quick';
  assert.equal(evaluateWorkflowRun(wrongRole, expected).passed, false);

  const inheritedContext = structuredClone(passing);
  delete inheritedContext.spawn_calls[0].arguments.fork_turns;
  assert.equal(evaluateWorkflowRun(inheritedContext, expected).passed, false);

  const overriddenPreset = structuredClone(passing);
  overriddenPreset.spawn_calls[0].arguments.model = 'gpt-5.6-luna';
  assert.equal(evaluateWorkflowRun(overriddenPreset, expected).passed, false);

  const missingTerminal = structuredClone(passing);
  missingTerminal.leaf_tool_calls = [];
  assert.equal(evaluateWorkflowRun(missingTerminal, expected).passed, false);

  const conflictingTerminal = structuredClone(passing);
  const conflict = structuredClone(conflictingTerminal.leaf_tool_calls[0]);
  conflict.output.payload += '\nconflicting child result';
  conflictingTerminal.leaf_tool_calls.push(conflict);
  conflictingTerminal.collaboration_timeline.push(conflict);
  assert.equal(evaluateWorkflowRun(conflictingTerminal, expected).passed, false);

  const duplicateTerminal = structuredClone(passing);
  duplicateTerminal.leaf_tool_calls.push(structuredClone(duplicateTerminal.leaf_tool_calls[0]));
  duplicateTerminal.collaboration_timeline.push(
    structuredClone(duplicateTerminal.collaboration_timeline[2]),
  );
  assert.equal(evaluateWorkflowRun(duplicateTerminal, expected).passed, true);

  const differentChildTerminal = structuredClone(passing);
  const differentChild = structuredClone(differentChildTerminal.collaboration_timeline[2]);
  differentChild.linked_thread_id = 'child-other';
  differentChildTerminal.collaboration_timeline.push(differentChild);
  assert.equal(evaluateWorkflowRun(differentChildTerminal, expected).passed, false);

  const wrongRootFact = structuredClone(passing);
  wrongRootFact.final_message = wrongRootFact.final_message.replace(
    'FACT v1_timeout_seconds=30',
    'FACT v1_timeout_seconds=31',
  );
  assert.equal(evaluateWorkflowRun(wrongRootFact, expected).passed, false);

  const wrongChildLocator = structuredClone(passing);
  for (const terminal of wrongChildLocator.leaf_tool_calls) {
    terminal.output.payload = terminal.output.payload.replace(
      'docs/vendor/api-v1.md:2',
      'docs/vendor/api-v1.md:3',
    );
  }
  assert.equal(evaluateWorkflowRun(wrongChildLocator, expected).passed, false);

  const wrongInference = structuredClone(passing);
  wrongInference.final_message = wrongInference.final_message.replace(
    '[inference] migration matches v2',
    '[direct] migration matches v2',
  );
  assert.equal(evaluateWorkflowRun(wrongInference, expected).passed, false);

  const parentDocsRead = structuredClone(passing);
  parentDocsRead.collaboration_timeline.splice(1, 0,
    lifecycleEvent('exec_command', { cmd: 'rg timeout docs/' }));
  assert.equal(evaluateWorkflowRun(parentDocsRead, expected).passed, false);

  const parentDocsReadBeforeSpawn = structuredClone(passing);
  parentDocsReadBeforeSpawn.collaboration_timeline.unshift(
    lifecycleEvent('exec_command', { cmd: 'rg timeout docs/' }),
  );
  assert.equal(evaluateWorkflowRun(parentDocsReadBeforeSpawn, expected).passed, false);

  const parentDocsReadAfterTerminal = structuredClone(passing);
  parentDocsReadAfterTerminal.collaboration_timeline.push(
    lifecycleEvent('exec_command', { cmd: 'sed -n 2p docs/vendor/api-v2.md' }),
  );
  assert.equal(evaluateWorkflowRun(parentDocsReadAfterTerminal, expected).passed, false);

  const changedWorkspace = structuredClone(passing);
  changedWorkspace.workspace_changes.modified.push('docs/vendor/api-v1.md');
  assert.equal(evaluateWorkflowRun(changedWorkspace, expected).passed, false);

  const shortInitialWait = structuredClone(passing);
  shortInitialWait.collaboration_timeline[1].arguments.timeout_ms = 599_999;
  assert.equal(evaluateWorkflowRun(shortInitialWait, expected).passed, false);

  const earlyCleanup = structuredClone(passing);
  earlyCleanup.collaboration_timeline.splice(1, 0,
    lifecycleEvent('close_agent', { target: 'child-versioned' }));
  assert.equal(evaluateWorkflowRun(earlyCleanup, expected).passed, false);

  const cleanupAfterTerminal = structuredClone(passing);
  cleanupAfterTerminal.collaboration_timeline.push(
    lifecycleEvent('close_agent', { target: 'child-versioned' }),
  );
  assert.equal(evaluateWorkflowRun(cleanupAfterTerminal, expected).passed, true);
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
          '/root/evidence': { completed: 'Status: completed' },
        },
      },
    ),
  ];
  assertLifecycleFailure(v1CompletedWait, 'result_before_final');
  assert.equal(
    evaluateParentScopeIsolation(v1CompletedWait, ['docs/']).passed,
    false,
  );
  assert.deepEqual(collectFinalAgentResults(v1CompletedWait), [{
    source: 'wait_agent',
    task_name: '/root/evidence',
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
  testVersionedWorkflowOracle();
  testLeafOutputAssertions();
  testLifecycleAssertions();
  await testRoleContractDigest();
  console.log('workflow eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
