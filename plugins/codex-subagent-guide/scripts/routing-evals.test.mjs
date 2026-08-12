import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  earlyStopReason,
  executionErrorEvidence,
  extractExecToolCalls,
  readEvalResource,
  readSpawnCallsFromRollouts,
  removeEvalDirectory,
  writeJsonReport,
} from '../templates/codex-subagent-guide/evals/eval-harness.mjs';
import {
  evaluateRoutingRun,
  loadRoutingSpec,
  parseRoutingArgs,
  routingReportStatus,
  routingRunCase,
  shouldRetryTransportFailure,
  summarizeRoutingVariant,
} from '../templates/codex-subagent-guide/evals/run-routing-evals.mjs';

function testArguments() {
  assert.deepEqual(
    parseRoutingArgs([
      '--runs',
      '2',
      '--threshold',
      '0.6',
      '--profile',
      'v2',
      '--variant',
      'with_skill',
      '--case',
      'partial_preset',
    ]),
    {
      runs: 2,
      threshold: 0.6,
      timeoutMs: 180_000,
      codexBin: 'codex',
      v1Model: 'gpt-5.6-luna',
      v2Model: 'gpt-5.6-luna',
      profile: 'v2',
      variant: 'with_skill',
      caseId: 'partial_preset',
      output: undefined,
      help: false,
    },
  );
  assert.throws(() => parseRoutingArgs(['--profile', 'v3']), /v1, v2, or all/);
  assert.throws(() => parseRoutingArgs(['--runs', '0']), /positive integer/);
  const overridden = parseRoutingArgs(['--model', 'gpt-test']);
  assert.equal(overridden.v1Model, 'gpt-test');
  assert.equal(overridden.v2Model, 'gpt-test');
}

async function testEvalSpec() {
  const spec = await loadRoutingSpec();
  const manifest = JSON.parse(await readEvalResource('manifest.json'));
  for (const suiteId of ['routing', 'lifecycle']) {
    assert.ok(
      manifest.suites.find((suite) => suite.id === suiteId).supports.includes('model'),
    );
  }
  assert.equal(spec.skill_name, 'codex-subagent-guide');
  assert.deepEqual(
    spec.evals.map((entry) => entry.id),
    [
      'simple_preset_fresh',
      'readonly_complexity_not_simple',
      'general_preset_fresh',
      'complex_preset_fresh',
      'planning_review_preset_fresh',
      'custom_model_only',
      'custom_effort_only',
      'custom_agent_type_only',
      'custom_model_and_effort',
      'custom_override_scoped_to_subtask',
      'partial_preset',
      'partial_custom_model',
      'full_history',
      'full_history_custom_override',
      'project_rule_partial_context',
      'skill_rule_full_history_context',
      'missing_preset_role',
      'fixed_role_custom_conflict',
    ],
  );
  const readonlyComplex = spec.evals.find((entry) => entry.id === 'readonly_complexity_not_simple');
  assert.equal(readonlyComplex.expectations.v1.arguments.agent_type, 'codex-subagent-complex');
  assert.equal(readonlyComplex.expectations.v2.arguments.agent_type, 'codex-subagent-complex');
  const scopedOverride = spec.evals.find((entry) => entry.id === 'custom_override_scoped_to_subtask');
  assert.equal(scopedOverride.expectations.v1.arguments.agent_type, 'codex-subagent-complex');
  assert.equal(scopedOverride.expectations.v1.arguments.model, null);
  assert.equal(scopedOverride.expectations.v2.arguments.agent_type, 'codex-subagent-complex');
  assert.equal(scopedOverride.expectations.v2.arguments.model, null);
  const partial = spec.evals.find((entry) => entry.id === 'partial_preset');
  assert.equal(partial.expectations.v1.spawn_calls.max, 0);
  assert.deepEqual(partial.expectations.v2.arguments, {
    agent_type: 'codex-subagent-simple',
    model: null,
    reasoning_effort: null,
    fork_context: null,
    fork_turns: '2',
  });
  const full = spec.evals.find((entry) => entry.id === 'full_history');
  assert.equal(full.expectations.v1.arguments.fork_context, true);
  assert.equal(full.expectations.v2.arguments.fork_turns, 'all');
  const fullRunCase = routingRunCase(full, 'v2', 'with_skill');
  assert.equal(fullRunCase.stop_on_spawn, true);
  assert.match(fullRunCase.query, /不需要子代理结果/u);
  assert.match(fullRunCase.query, /不要等待或清理子代理/u);
  const fullCustom = spec.evals.find((entry) => entry.id === 'full_history_custom_override');
  assert.equal(fullCustom.expectations.v1.arguments.model, 'gpt-5.6-terra');
  assert.equal(fullCustom.expectations.v1.arguments.fork_context, true);
  assert.equal(fullCustom.expectations.v2.spawn_calls.max, 0);
  const projectContext = spec.evals.find((entry) => entry.id === 'project_rule_partial_context');
  assert.equal(projectContext.expectations.v1.spawn_calls.max, 0);
  assert.equal(projectContext.expectations.v2.arguments.agent_type, 'codex-subagent-simple');
  assert.equal(projectContext.expectations.v2.arguments.fork_turns, '2');
  const skillContext = spec.evals.find((entry) => entry.id === 'skill_rule_full_history_context');
  assert.equal(skillContext.expectations.v1.arguments.fork_context, true);
  assert.equal(skillContext.expectations.v2.arguments.fork_turns, 'all');
  const missingRole = spec.evals.find((entry) => entry.id === 'missing_preset_role');
  assert.ok(missingRole.expectations.v1.final_message_includes_any.includes('不包含'));
  assert.ok(missingRole.expectations.v2.final_message_includes_any.includes('未提供'));
}

async function testRolloutArgumentEvidence() {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-rollout-'));
  try {
    const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '03');
    await mkdir(sessionDir, { recursive: true });
    const line = {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'collaboration',
        arguments: JSON.stringify({
          agent_type: 'codex-subagent-simple',
          message: 'verify facts',
          fork_turns: '2',
        }),
        call_id: 'call-1',
      },
    };
    await writeFile(
      path.join(sessionDir, 'rollout-test.jsonl'),
      [
        JSON.stringify(line),
        JSON.stringify(line),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-2',
            internal_chat_message_metadata_passthrough: {
              executed_tool_calls: [{
                name: 'collaboration__spawn_agent',
                arguments: {
                  agent_type: 'codex-subagent-complex',
                  message: 'investigate',
                  fork_turns: 'none',
                },
              }],
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'exec-call-1',
            input: [
              'const result = await tools.multi_agent_v1__spawn_agent({',
              '  agent_type: "codex-subagent-simple",',
              '  fork_context: false,',
              '  message: "verify { left: 1, right: 2 }",',
              '  items: [{ type: "text", text: "nested evidence" }],',
              '}); text(result);',
            ].join('\n'),
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'exec-call-1',
            output: { task_name: '/root/verify' },
            internal_chat_message_metadata_passthrough: {
              executed_tool_calls: [{
                name: 'multi_agent_v1__spawn_agent',
                arguments: {
                  agent_type: 'codex-subagent-simple',
                  fork_context: false,
                  message: 'verify { left: 1, right: 2 }',
                  items: [{ type: 'text', text: 'nested evidence' }],
                },
              }],
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'exec-call-2',
            input: 'await tools.multi_agent_v1__spawn_agent(argumentsValue);',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'exec-call-2',
            internal_chat_message_metadata_passthrough: {
              executed_tool_calls: [{
                name: 'multi_agent_v1__spawn_agent',
                arguments: {
                  agent_type: 'codex-subagent-general',
                  message: 'metadata fallback',
                  fork_context: false,
                },
              }],
            },
          },
        }),
        '',
      ].join('\n'),
      'utf8',
    );
    const calls = await readSpawnCallsFromRollouts(codexHome);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].arguments, {
      agent_type: 'codex-subagent-simple',
      message: 'verify facts',
      fork_turns: '2',
    });
    assert.deepEqual(calls[1].arguments, {
      agent_type: 'codex-subagent-complex',
      message: 'investigate',
      fork_turns: 'none',
    });
    assert.deepEqual(calls[2].arguments, {
      agent_type: 'codex-subagent-simple',
      fork_context: false,
      message: 'verify { left: 1, right: 2 }',
      items: [{ type: 'text', text: 'nested evidence' }],
    });
    assert.deepEqual(calls[3].arguments, {
      agent_type: 'codex-subagent-general',
      message: 'metadata fallback',
      fork_context: false,
    });
    assert.deepEqual(extractExecToolCalls('await tools.exec_command({ cmd: "pwd" });'), []);
    assert.deepEqual(
      extractExecToolCalls('await tools.multi_agent_v1__spawn_agent(argumentsValue);'),
      [],
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function testJsonReportOutput() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-report-'));
  const outputPath = path.join(root, 'reports', 'routing.json');
  const report = { complete: true, passed: true };
  try {
    await writeJsonReport(report, outputPath);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testEvalDirectoryCleanupContract() {
  const root = path.join(os.tmpdir(), 'codex-subagent-guide-eval');
  const calls = [];
  await removeEvalDirectory(root, async (candidate, options) => {
    calls.push({ root: candidate, options });
  });
  assert.deepEqual(calls, [{
    root,
    options: {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    },
  }]);
}

function testMechanicalAssertions() {
  const expected = {
    spawn_calls: { min: 1, max: 1 },
    arguments: {
      agent_type: 'codex-subagent-simple',
      model: null,
      reasoning_effort: null,
      fork_turns: '2',
    },
    present_arguments: ['message'],
  };
  const passingRun = {
    loaded: true,
    load_evidence: 'read SKILL.md',
    execution_error: false,
    termination: 'spawn_observed',
    exit_code: null,
    spawn_calls: [{
      arguments: {
        agent_type: 'codex-subagent-simple',
        message: 'verify',
        fork_turns: '2',
      },
    }],
  };
  assert.equal(evaluateRoutingRun(passingRun, expected, 'with_skill').passed, true);

  const rejectedByToolRouter = {
    ...passingRun,
    stderr: 'ERROR codex_core::tools::router: error=Provide either message or items, but not both',
  };
  const routerEvaluation = evaluateRoutingRun(rejectedByToolRouter, expected, 'with_skill');
  assert.equal(routerEvaluation.passed, false);
  assert.match(
    routerEvaluation.assertions.find((assertion) => assertion.name === 'execution').evidence,
    /router_error/,
  );

  const explicitlyInjected = {
    ...passingRun,
    requested_explicitly: true,
    loaded: false,
    load_evidence: null,
  };
  assert.equal(evaluateRoutingRun(explicitlyInjected, expected, 'with_skill').passed, true);
  assert.equal(
    earlyStopReason(
      { stop_on_spawn: true },
      { spawned: true, spawnCalls: [] },
    ),
    null,
  );
  assert.equal(
    earlyStopReason(
      { stop_on_spawn: true },
      { spawned: true, spawnCalls: [{ arguments: { message: 'verify' } }] },
    ),
    'spawn_observed',
  );

  const inheritedWrongly = {
    ...passingRun,
    spawn_calls: [{ arguments: { message: 'verify', fork_turns: '2' } }],
  };
  assert.equal(
    evaluateRoutingRun(inheritedWrongly, expected, 'with_skill').passed,
    false,
  );

  const baseline = { ...passingRun, loaded: false, load_evidence: null };
  assert.equal(evaluateRoutingRun(baseline, expected, 'without_skill').passed, true);

  const missingRawArguments = {
    loaded: false,
    spawned: true,
    execution_error: false,
    termination: 'spawn_observed',
    exit_code: 0,
    spawn_calls: [],
    final_message: '部分历史不可用。',
  };
  assert.equal(
    evaluateRoutingRun(
      missingRawArguments,
      {
        spawn_calls: { min: 0, max: 0 },
        final_message_includes_any: ['部分历史'],
      },
      'without_skill',
    ).passed,
    false,
  );

  const incomplete = summarizeRoutingVariant(
    {
      id: 'missing_raw',
      expected_output: 'raw arguments required',
      expectations: {
        v2: {
          spawn_calls: { min: 1, max: 1 },
          arguments: { fork_turns: 'none' },
        },
      },
    },
    'v2',
    'with_skill',
    [{ ...missingRawArguments, loaded: true, load_evidence: 'read SKILL.md' }],
    0.5,
  );
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.raw_evidence_missing, 1);
  assert.equal(incomplete.load_evidence_missing, 0);

  const missingLoadEvidence = summarizeRoutingVariant(
    {
      id: 'missing_load',
      expected_output: 'load evidence required',
      expectations: {
        v2: {
          spawn_calls: { min: 0, max: 0 },
        },
      },
    },
    'v2',
    'with_skill',
    [{
      loaded: true,
      load_evidence: null,
      spawned: false,
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      spawn_calls: [],
    }],
    0.5,
  );
  assert.equal(missingLoadEvidence.complete, false);
  assert.equal(missingLoadEvidence.load_evidence_missing, 1);
  assert.equal(missingLoadEvidence.passed, false);
}

function testTransportRetryGate() {
  const transient = {
    execution_error: true,
    stderr: 'Reading additional input from stdin...',
    event_trace: [{
      type: 'error',
      message: 'stream disconnected before completion: WebSocket protocol error: Connection reset without closing handshake',
    }],
  };
  assert.equal(shouldRetryTransportFailure(transient, 0), true);
  assert.equal(shouldRetryTransportFailure(transient, 1), true);
  assert.equal(shouldRetryTransportFailure(transient, 2), false);
  assert.equal(shouldRetryTransportFailure({ ...transient, execution_error: false }, 0), false);
  assert.equal(
    shouldRetryTransportFailure({ execution_error: true, stderr: 'ordinary timeout' }, 0),
    false,
  );
  assert.deepEqual(
    JSON.parse(executionErrorEvidence({
      execution_error: true,
      termination: 'timeout',
      exit_code: 0,
      signal: null,
      stderr: 'Reading additional input from stdin...',
    })),
    {
      termination: 'timeout',
      exit_code: 0,
      signal: null,
      stderr: 'Reading additional input from stdin...',
      error_events: [],
    },
  );
}

function testReportStatus() {
  const entry = {
    id: 'example',
    expected_output: 'route correctly',
    expectations: {
      v2: {
        spawn_calls: { min: 0, max: 0 },
        final_message_includes_any: ['冲突'],
      },
    },
  };
  const completed = {
    loaded: true,
    load_evidence: 'read SKILL.md',
    execution_error: false,
    termination: 'completed',
    exit_code: 0,
    spawn_calls: [],
    final_message: '字段冲突，不能启动。',
  };
  const current = summarizeRoutingVariant(entry, 'v2', 'with_skill', [completed], 0.5);
  const baseline = summarizeRoutingVariant(
    entry,
    'v2',
    'without_skill',
    [{ ...completed, loaded: false, load_evidence: null, final_message: '不知道。' }],
    0.5,
  );
  assert.deepEqual(routingReportStatus([current, baseline], 2), {
    complete: true,
    passed: true,
  });
  assert.deepEqual(routingReportStatus([current], 2), {
    complete: false,
    passed: false,
  });
  assert.deepEqual(routingReportStatus([baseline], 1), {
    complete: true,
    passed: true,
  });
}

async function main() {
  testArguments();
  await testEvalSpec();
  await testRolloutArgumentEvidence();
  await testJsonReportOutput();
  await testEvalDirectoryCleanupContract();
  testMechanicalAssertions();
  testTransportRetryGate();
  testReportStatus();
  console.log('routing eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
