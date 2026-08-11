import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readSpawnCallsFromRollouts,
  writeJsonReport,
} from '../templates/codex-subagent-guide/evals/eval-harness.mjs';
import {
  evaluateRoutingRun,
  loadRoutingSpec,
  parseRoutingArgs,
  routingReportStatus,
  routingRunCase,
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
      v2Model: 'gpt-5.6-sol',
      profile: 'v2',
      variant: 'with_skill',
      caseId: 'partial_preset',
      output: undefined,
      help: false,
    },
  );
  assert.throws(() => parseRoutingArgs(['--profile', 'v3']), /v1, v2, or all/);
  assert.throws(() => parseRoutingArgs(['--runs', '0']), /positive integer/);
}

async function testEvalSpec() {
  const spec = await loadRoutingSpec();
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
  assert.equal(routingRunCase(full, 'v2', 'with_skill').stop_on_spawn, true);
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
        '',
      ].join('\n'),
      'utf8',
    );
    const calls = await readSpawnCallsFromRollouts(codexHome);
    assert.equal(calls.length, 2);
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
  testMechanicalAssertions();
  testReportStatus();
  console.log('routing eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
