import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateModelSelectionRun,
  loadModelEvalSpec,
  modelEvalReportStatus,
  modelEvalRunCase,
  parseModelEvalArgs,
  summarizeVariant,
} from '../evals/run-model-selection-evals.mjs';
import {
  createEvalWorkspace,
  readSpawnCallsFromRollouts,
} from '../evals/run-trigger-evals.mjs';

function testArguments() {
  assert.deepEqual(
    parseModelEvalArgs([
      '--variant',
      'current',
      '--runs',
      '2',
      '--threshold',
      '0.6',
      '--case',
      'default_config',
    ]),
    {
      variant: 'current',
      runs: 2,
      threshold: 0.6,
      timeoutMs: 180_000,
      codexBin: 'codex',
      model: undefined,
      caseId: 'default_config',
      output: undefined,
      allowEnvironmentSkips: false,
      help: false,
    },
  );
  assert.equal(
    parseModelEvalArgs(['--allow-environment-skips']).allowEnvironmentSkips,
    true,
  );
  assert.throws(
    () => parseModelEvalArgs(['--variant', 'unknown']),
    /current, old, or both/,
  );
  assert.throws(() => parseModelEvalArgs(['--runs', '0']), /positive integer/);
}

async function testEvalSpec() {
  const spec = await loadModelEvalSpec();
  assert.equal(spec.skill_name, 'codex-explore');
  assert.equal(spec.baseline.version, '0.1.18');
  assert.equal(spec.baseline.should_spawn_agent, true);
  assert.equal(spec.evals.length, 8);
  assert.equal(new Set(spec.evals.map((entry) => entry.id)).size, 8);
  assert.deepEqual(
    spec.evals.map((entry) => entry.id),
    [
      'default_config',
      'configured_defaults',
      'user_overrides_config',
      'user_overrides_model_only',
      'user_overrides_reasoning_only',
      'hidden_default_fields',
      'hidden_explicit_field',
      'invalid_explicit_values',
    ],
  );
  for (const entry of spec.evals) {
    assert.equal(entry.codex_config['features.multi_agent_v2.enabled'], true);
    assert.equal(Array.isArray(entry.assertions), true);
    assert.equal(entry.assertions.length > 0, true);
  }

  const hiddenExplicit = spec.evals.find(
    (entry) => entry.id === 'hidden_explicit_field',
  );
  assert.equal(
    modelEvalRunCase(hiddenExplicit, 'current', spec.baseline).should_spawn_agent,
    false,
  );
  assert.equal(
    modelEvalRunCase(hiddenExplicit, 'old', spec.baseline).should_spawn_agent,
    true,
  );
  assert.equal(
    modelEvalRunCase(hiddenExplicit, 'current', spec.baseline).wait_for_completion,
    true,
  );
  assert.equal(
    modelEvalRunCase(hiddenExplicit, 'old', spec.baseline).wait_for_completion,
    true,
  );
}

async function testRolloutArgumentEvidence() {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-rollout-eval-'));
  try {
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '29');
    await mkdir(sessionDir, { recursive: true });
    const line = {
      timestamp: '2026-07-29T00:00:00Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        namespace: 'collaboration',
        arguments: JSON.stringify({
          agent_type: 'codex-explore-agent',
          message: 'trace the evidence',
          task_name: 'trace_evidence',
          reasoning_effort: 'low',
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

    assert.deepEqual(await readSpawnCallsFromRollouts(codexHome), [
      {
        call_id: 'call-1',
        namespace: 'collaboration',
        arguments: {
          agent_type: 'codex-explore-agent',
          message: 'trace the evidence',
          task_name: 'trace_evidence',
          reasoning_effort: 'low',
          fork_turns: 'none',
        },
        rollout_file: path.join(
          'sessions',
          '2026',
          '07',
          '29',
          'rollout-test.jsonl',
        ),
      },
    ]);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function testMechanicalAssertions() {
  const passing = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'expected_outcome_observed',
      exit_code: null,
      spawn_calls: [
        {
          arguments: {
            agent_type: 'codex-explore-agent',
            message: 'trace',
            task_name: 'trace',
            reasoning_effort: 'low',
            fork_turns: 'none',
          },
        },
      ],
    },
    {
      spawn_calls: { min: 1, max: 1 },
      arguments: {
        agent_type: 'codex-explore-agent',
        model: null,
        reasoning_effort: 'low',
        fork_turns: 'none',
      },
      present_arguments: ['message', 'task_name'],
    },
  );
  assert.equal(passing.passed, true);

  const silentRetry = evaluateModelSelectionRun(
    {
      execution_error: false,
      termination: 'completed',
      exit_code: 0,
      final_message: '启动失败。',
      spawn_calls: [
        {
          arguments: {
            model: 'definitely-unavailable-model',
            reasoning_effort: 'turbo',
          },
        },
        {
          arguments: {
            model: 'gpt-5.6-terra',
            reasoning_effort: 'low',
          },
        },
      ],
    },
    {
      spawn_calls: { min: 0, max: 1 },
      arguments_if_called: {
        model: 'definitely-unavailable-model',
        reasoning_effort: 'turbo',
      },
      final_message_includes_any: ['失败'],
    },
  );
  assert.equal(silentRetry.passed, false);
  assert.equal(
    silentRetry.assertions.find((entry) => entry.name === 'spawn_call_count')?.passed,
    false,
  );

  const unsupportedSchemaProfile = evaluateModelSelectionRun(
    {
      execution_error: true,
      event_trace: [{
        type: 'error',
        message: 'Function spawn_agent must match the configured schema.',
      }],
    },
    {
      spawn_calls: { min: 0, max: 0 },
      allowed_environment_errors: ['must match the configured schema'],
    },
  );
  assert.equal(unsupportedSchemaProfile.skipped, true);
  assert.equal(unsupportedSchemaProfile.passed, null);

  const nonExecutionError = evaluateModelSelectionRun(
    {
      execution_error: false,
      stderr: 'Function spawn_agent must match the configured schema.',
      spawn_calls: [],
    },
    {
      spawn_calls: { min: 0, max: 0 },
      allowed_environment_errors: ['must match the configured schema'],
    },
  );
  assert.equal(nonExecutionError.skipped, false);

  const spawnedBeforeError = evaluateModelSelectionRun(
    {
      execution_error: true,
      stderr: 'Function spawn_agent must match the configured schema.',
      spawn_calls: [{ arguments: {} }],
    },
    {
      spawn_calls: { min: 0, max: 0 },
      allowed_environment_errors: ['must match the configured schema'],
    },
  );
  assert.equal(spawnedBeforeError.skipped, false);
}

function testEnvironmentSkipReportStatus() {
  const entry = {
    id: 'environment_skip',
    expected_output: 'test',
    expected_current: {
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
    stderr: 'Function spawn_agent must match the configured schema.',
    spawn_calls: [],
  };
  const result = summarizeVariant(
    entry,
    'current',
    [passingRun, passingRun, skippedRun],
    0.5,
  );
  assert.equal(result.complete, false);
  assert.equal(result.environment_skips, 1);
  assert.equal(result.pass_rate, 2 / 3);
  assert.deepEqual(modelEvalReportStatus([result], false), {
    complete: false,
    passed: false,
  });
  assert.deepEqual(modelEvalReportStatus([result], true), {
    complete: false,
    passed: true,
  });
}

async function testFrozenBaselineStaging() {
  const current = await createEvalWorkspace({
    configValues: {
      explorerModel: 'gpt-5.6-terra',
      modelReasoningEffort: 'high',
    },
    variant: 'current',
  });
  const old = await createEvalWorkspace({
    configValues: {
      explorerModel: 'gpt-5.6-terra',
      modelReasoningEffort: 'high',
    },
    variant: 'old',
  });
  try {
    const [currentSkill, currentRole, oldSkill, oldRole] = await Promise.all([
      readFile(current.skillPath, 'utf8'),
      readFile(current.rolePath, 'utf8'),
      readFile(old.skillPath, 'utf8'),
      readFile(old.rolePath, 'utf8'),
    ]);
    assert.match(currentSkill, /`model`: `gpt-5\.6-terra`/);
    assert.match(currentSkill, /`reasoning_effort`: `high`/);
    assert.equal(currentRole.includes('\nmodel = '), false);
    assert.equal(currentRole.includes('\nmodel_reasoning_effort = '), false);

    assert.match(oldSkill, /默认模型是 `gpt-5\.6-terra`/);
    assert.match(oldSkill, /推理强度是 `high`/);
    assert.match(oldRole, /\nmodel = "gpt-5\.6-terra"/);
    assert.match(oldRole, /\nmodel_reasoning_effort = "high"/);
  } finally {
    await Promise.all([
      rm(current.root, { recursive: true, force: true }),
      rm(old.root, { recursive: true, force: true }),
    ]);
  }
}

async function main() {
  testArguments();
  await testEvalSpec();
  await testRolloutArgumentEvidence();
  testMechanicalAssertions();
  testEnvironmentSkipReportStatus();
  await testFrozenBaselineStaging();
  console.log('model selection eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
