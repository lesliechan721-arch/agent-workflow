import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateModelSelectionRun,
  loadModelEvalSpec,
  modelEvalReportStatus,
  modelEvalRunCase,
  parseModelEvalArgs,
  summarizeModelEval,
} from '../evals/run-model-selection-evals.mjs';
import {
  createEvalWorkspace,
  readSpawnCallsFromRollouts,
} from '../evals/run-trigger-evals.mjs';

function testArguments() {
  assert.deepEqual(
    parseModelEvalArgs([
      '--runs',
      '2',
      '--threshold',
      '0.6',
      '--case',
      'auto_standard',
    ]),
    {
      runs: 2,
      threshold: 0.6,
      timeoutMs: 180_000,
      codexBin: 'codex',
      model: undefined,
      caseId: 'auto_standard',
      output: undefined,
      allowEnvironmentSkips: false,
      help: false,
    },
  );
  assert.throws(() => parseModelEvalArgs(['--runs', '0']), /positive integer/);
}

async function testEvalSpec() {
  const spec = await loadModelEvalSpec();
  assert.equal(spec.skill_name, 'codex-explore');
  assert.deepEqual(
    spec.evals.map((entry) => entry.id),
    [
      'auto_quick',
      'auto_standard',
      'v1_auto_standard',
      'auto_deep',
      'custom_both_fields',
      'custom_model_only',
      'custom_reasoning_only',
      'hidden_fields_preset',
      'hidden_explicit_field',
      'invalid_explicit_values',
    ],
  );
  for (const entry of spec.evals) {
    assert.equal(
      entry.codex_config['features.multi_agent_v2.enabled'],
      entry.id !== 'v1_auto_standard',
    );
    assert.equal(entry.assertions.length > 0, true);
  }

  const hiddenExplicit = spec.evals.find((entry) => entry.id === 'hidden_explicit_field');
  assert.equal(modelEvalRunCase(hiddenExplicit).should_spawn_agent, false);
}

async function testRolloutArgumentEvidence() {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-rollout-eval-'));
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
          agent_type: 'codex-explore-custom',
          message: 'trace the evidence',
          task_name: 'trace_evidence',
          model: 'gpt-5.6-sol',
          fork_turns: 'none',
        }),
        call_id: 'call-1',
      },
    };
    await writeFile(
      path.join(sessionDir, 'rollout-test.jsonl'),
      `${JSON.stringify(line)}\n${JSON.stringify(line)}\n`,
      'utf8',
    );

    const calls = await readSpawnCallsFromRollouts(codexHome);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].arguments, {
      agent_type: 'codex-explore-custom',
      message: 'trace the evidence',
      task_name: 'trace_evidence',
      model: 'gpt-5.6-sol',
      fork_turns: 'none',
    });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function testMechanicalAssertions() {
  const preset = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'expected_outcome_observed',
      exit_code: null,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-standard',
          message: 'trace',
          task_name: 'trace',
          fork_turns: 'none',
        },
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-explore-standard',
        model: null,
        reasoning_effort: null,
        fork_turns: 'none',
      },
      present_arguments: ['message', 'task_name'],
    },
  );
  assert.equal(preset.passed, true);

  const v1Preset = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'expected_outcome_observed',
      exit_code: null,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-standard',
          message: 'trace',
          fork_context: false,
        },
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-explore-standard',
        model: null,
        reasoning_effort: null,
        fork_context: false,
        fork_turns: null,
      },
      present_arguments: ['message'],
    },
  );
  assert.equal(v1Preset.passed, true);

  const wrongPresetOverride = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'expected_outcome_observed',
      exit_code: null,
      spawn_calls: [{
        arguments: {
          agent_type: 'codex-explore-standard',
          model: 'gpt-5.6-luna',
          reasoning_effort: 'high',
        },
      }],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-explore-standard',
        model: null,
        reasoning_effort: null,
      },
    },
  );
  assert.equal(wrongPresetOverride.passed, false);

  const silentRetry = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      final_message: '启动失败。',
      spawn_calls: [
        {
          arguments: {
            agent_type: 'codex-explore-custom',
            model: 'definitely-unavailable-model',
            reasoning_effort: 'turbo',
          },
        },
        { arguments: { agent_type: 'codex-explore-deep' } },
      ],
    },
    {
      spawn_calls: { min: 0, max: 1 },
      arguments_if_called: {
        agent_type: 'codex-explore-custom',
        model: 'definitely-unavailable-model',
        reasoning_effort: 'turbo',
      },
      final_message_includes_any: ['失败'],
    },
  );
  assert.equal(silentRetry.passed, false);
}

function testEnvironmentSkipReportStatus() {
  const entry = {
    id: 'environment_skip',
    expected_output: 'test',
    expected: {
      spawn_calls: { min: 0, max: 0 },
      allowed_environment_errors: ['must match the configured schema'],
    },
  };
  const passingRun = {
    execution_error: false,
    termination: 'completed',
    exit_code: 0,
    spawn_calls: [],
  };
  const skippedRun = {
    execution_error: true,
    termination: 'completed',
    exit_code: 1,
    event_trace: [{ type: 'error', message: 'must match the configured schema' }],
    spawn_calls: [],
  };
  const result = summarizeModelEval(entry, [passingRun, passingRun, skippedRun], 0.5);
  assert.equal(result.complete, false);
  assert.equal(result.environment_skips, 1);
  assert.deepEqual(modelEvalReportStatus([result], false), { complete: false, passed: false });
  assert.deepEqual(modelEvalReportStatus([result], true), { complete: false, passed: true });
}

async function testCurrentStaging() {
  const current = await createEvalWorkspace();
  try {
    assert.equal(current.roles.length, 4);
    assert.deepEqual(
      current.roles.map((role) => role.roleFile.name),
      [
        'codex-explore-quick',
        'codex-explore-standard',
        'codex-explore-deep',
        'codex-explore-custom',
      ],
    );
    const [quick, standard, deep, custom] = current.roles;
    assert.deepEqual(
      [quick.roleFile.model_reasoning_effort, standard.roleFile.model_reasoning_effort, deep.roleFile.model_reasoning_effort],
      ['medium', 'high', 'xhigh'],
    );
    assert.equal('model' in custom.roleFile, false);
    assert.equal('model_reasoning_effort' in custom.roleFile, false);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
}

async function main() {
  testArguments();
  await testEvalSpec();
  await testRolloutArgumentEvidence();
  testMechanicalAssertions();
  testEnvironmentSkipReportStatus();
  await testCurrentStaging();
  console.log('model selection eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
