import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateLivenessRun,
  loadLivenessEvalSpec,
  parseLivenessEvalArgs,
  setupLivenessWorkspace,
  summarizeLivenessRuns,
} from '../skills/codex-explore/evals/run-liveness-evals.mjs';

function event(tool, argumentsValue = {}, output = {}) {
  return { tool, arguments: argumentsValue, output };
}

function passingTimeline({ withProbe = false } = {}) {
  const timeline = [
    event(
      'spawn_agent',
      { agent_type: 'codex-explore-standard' },
      { task_name: '/root/evidence' },
    ),
    event(
      'wait_agent',
      { timeout_ms: 60_000 },
      { timed_out: true },
    ),
  ];
  if (withProbe) {
    timeline.push(event('send_message', { target: '/root/evidence' }));
  }
  timeline.push(
    event('wait_agent', { timeout_ms: 60_000 }, { timed_out: false }),
  );
  if (withProbe) {
    timeline.push(event('agent_message', null, {
      message_type: 'MESSAGE',
      status: 'progress',
      task_name: '/root/evidence',
    }));
  }
  timeline.push(event('agent_message', null, {
    message_type: 'FINAL_ANSWER',
    status: null,
    task_name: '/root/evidence',
  }));
  return timeline;
}

function runResult(finalMessage, timeline) {
  return {
    execution_error: false,
    termination: 'completed',
    exit_code: 0,
    duration_ms: 90_000,
    usage: { input_tokens: 100, output_tokens: 50 },
    spawn_calls: [timeline[0]],
    collaboration_timeline: timeline,
    leaf_trace_available: true,
    leaf_tool_calls: [event(
      'exec_command',
      { cmd: 'node docs/liveness/verify-records.mjs' },
      { exit_code: 0 },
    )],
    final_message: finalMessage,
    workspace_changes: { added: [], removed: [], modified: [] },
  };
}

async function testSpec() {
  const spec = await loadLivenessEvalSpec();
  assert.equal(spec.skill_name, 'codex-explore');
  assert.deepEqual(
    spec.evals.map((entry) => entry.id),
    ['v2_long_progress', 'v2_late_blocked', 'v1_long_progress'],
  );
  assert.equal(
    spec.evals[0].expected.lifecycle.minimum_initial_wait_timeout_ms,
    60_000,
  );
  assert.equal(spec.evals[0].expected.lifecycle.allow_liveness_probe, false);
  assert.equal(spec.evals[0].prompt.includes('FACT records=120'), false);
  assert.equal(spec.evals[0].prompt.includes('FACT timeout_values=30,45,60'), false);
  assert.equal(
    spec.evals.find((entry) => entry.id === 'v2_late_blocked')
      .prompt.includes('FACT authority_available=false'),
    false,
  );
  assert.equal(
    spec.evals.find((entry) => entry.id === 'v1_long_progress').parent_model,
    'gpt-5.5',
  );
  assert.deepEqual(
    parseLivenessEvalArgs(['--runs', '2', '--case', 'v2_long_progress']),
    {
      runs: 2,
      timeoutMs: 300_000,
      codexBin: 'codex',
      model: undefined,
      caseId: 'v2_long_progress',
      output: undefined,
      help: false,
    },
  );
}

async function testFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-liveness-fixture-'));
  try {
    await setupLivenessWorkspace(root);
    const first = await readFile(
      path.join(root, 'docs', 'liveness', 'records', 'record-001.md'),
      'utf8',
    );
    const last = await readFile(
      path.join(root, 'docs', 'liveness', 'records', 'record-120.md'),
      'utf8',
    );
    const verifier = await readFile(
      path.join(root, 'docs', 'liveness', 'verify-records.mjs'),
      'utf8',
    );
    assert.match(first, /timeout=30/);
    assert.match(last, /timeout=60/);
    assert.match(verifier, /setTimeout\(resolve, 65_000\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testEvaluation() {
  const spec = await loadLivenessEvalSpec();
  const expected = spec.evals[0].expected;
  const finalMessage = [
    '直接证据：docs/liveness/records/ 中有 120 条记录。',
    'FACT records=120',
    'FACT timeout_values=30,45,60',
  ].join('\n');

  const noProbeTimeline = passingTimeline();
  const noProbeRun = runResult(finalMessage, noProbeTimeline);
  assert.equal(evaluateLivenessRun(noProbeRun, expected, false).passed, true);
  const codeModeVerifierRun = {
    ...noProbeRun,
    leaf_tool_calls: [event(
      'exec',
      {
        input: 'const result = await tools.exec_command({cmd:"node docs/liveness/verify-records.mjs"}); text(result.output);',
      },
      'Script completed',
    )],
  };
  assert.equal(
    evaluateLivenessRun(codeModeVerifierRun, expected, false).passed,
    true,
  );
  const compoundVerifierRun = {
    ...noProbeRun,
    leaf_tool_calls: [event(
      'exec_command',
      { cmd: 'pwd && node docs/liveness/verify-records.mjs' },
      { exit_code: 0 },
    )],
  };
  assert.equal(
    evaluateLivenessRun(compoundVerifierRun, expected, false).passed,
    true,
  );

  const v1Timeline = [
    event(
      'spawn_agent',
      { agent_type: 'codex-explore-standard' },
      { agent_id: 'agent-id' },
    ),
    event(
      'wait_agent',
      { timeout_ms: 60_000 },
      { timed_out: true },
    ),
    event(
      'wait_agent',
      { timeout_ms: 60_000 },
      {
        timed_out: false,
        status: {
          'agent-id': { completed: 'Status: completed' },
        },
      },
    ),
  ];
  assert.equal(
    evaluateLivenessRun(runResult(finalMessage, v1Timeline), expected, false).passed,
    true,
  );

  const instantRun = {
    ...runResult(finalMessage, noProbeTimeline),
    duration_ms: 1,
  };
  const instantEvaluation = evaluateLivenessRun(instantRun, expected, false);
  assert.equal(instantEvaluation.passed, false);
  assert.equal(
    instantEvaluation.assertions.find(
      (assertion) => assertion.name === 'long_wait_exercised',
    )?.passed,
    false,
  );

  const missingVerifierRun = {
    ...noProbeRun,
    leaf_tool_calls: [],
  };
  const missingVerifierEvaluation = evaluateLivenessRun(
    missingVerifierRun,
    expected,
    false,
  );
  assert.equal(missingVerifierEvaluation.passed, false);
  assert.equal(
    missingVerifierEvaluation.assertions.find(
      (assertion) => assertion.name === 'verifier_invoked_by_leaf',
    )?.passed,
    false,
  );

  const missingLeafTraceEvaluation = evaluateLivenessRun(
    {
      ...noProbeRun,
      leaf_trace_available: false,
      leaf_tool_calls: [],
    },
    expected,
    false,
  );
  assert.equal(missingLeafTraceEvaluation.complete, false);
  assert.equal(missingLeafTraceEvaluation.passed, false);
  assert.equal(
    missingLeafTraceEvaluation.assertions.find(
      (assertion) => assertion.name === 'verifier_invoked_by_leaf',
    )?.passed,
    null,
  );

  const probeTimeline = passingTimeline({ withProbe: true });
  const probeRun = runResult(finalMessage, probeTimeline);
  const probeEvaluation = evaluateLivenessRun(probeRun, expected, false);
  assert.equal(probeEvaluation.passed, false);
  assert.equal(probeEvaluation.metrics.probes, 1);
  assert.deepEqual(probeEvaluation.metrics.status_messages, ['progress']);
  assert.equal(probeEvaluation.metrics.timed_out_waits, 1);
  assert.equal(probeEvaluation.metrics.wait_count, 2);
  assert.equal(evaluateLivenessRun(noProbeRun, expected, true).passed, false);

  const summary = summarizeLivenessRuns([
    { ...probeRun, evaluation: probeEvaluation },
    {
      ...noProbeRun,
      duration_ms: 60_000,
      evaluation: evaluateLivenessRun(noProbeRun, expected, false),
    },
  ]);
  assert.equal(summary.accepted_runs, 1);
  assert.equal(summary.probe_runs, 1);
  assert.equal(summary.status_runs, 1);
  assert.equal(summary.median_duration_ms, 75_000);
}

async function main() {
  await testSpec();
  await testFixture();
  await testEvaluation();
  console.log('liveness eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
