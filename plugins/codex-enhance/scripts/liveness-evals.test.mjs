import assert from 'node:assert/strict';
import {
  evaluateLivenessRun,
  loadLivenessEvalSpec,
  parseLivenessEvalArgs,
  summarizeLivenessRuns,
} from '../skills/codex-explore/evals/run-liveness-evals.mjs';

const syntheticExpected = {
  agent_type: 'synthetic-agent',
  final_message_includes_all: ['RESULT accepted'],
  delegated_source_prefixes: ['synthetic-source/'],
  workspace_unchanged: true,
  lifecycle: {
    minimum_initial_wait_timeout_ms: 60_000,
    allow_liveness_probe: false,
    max_recoveries: 1,
  },
};

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (entry) => typeof entry === 'string' && entry.length > 0,
  );
}

function event(tool, argumentsValue = {}, output = {}) {
  return { tool, arguments: argumentsValue, output };
}

function passingTimeline({ withProbe = false } = {}) {
  const timeline = [
    event(
      'spawn_agent',
      { agent_type: 'synthetic-agent' },
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

function testArguments() {
  assert.deepEqual(
    parseLivenessEvalArgs(['--runs', '2', '--case', 'synthetic_case']),
    {
      runs: 2,
      timeoutMs: 300_000,
      codexBin: 'codex',
      model: undefined,
      caseId: 'synthetic_case',
      output: undefined,
      help: false,
    },
  );
}

async function testSpecShape() {
  const spec = await loadLivenessEvalSpec();
  assert.equal(spec.skill_name, 'codex-explore');
  assert.equal(spec.evals.length > 0, true);
  assert.equal(spec.evals.every((entry) => (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.prompt === 'string' &&
    entry.prompt.length > 0 &&
    (entry.parent_model === undefined || typeof entry.parent_model === 'string') &&
    (entry.codex_config === undefined || typeof entry.codex_config === 'object') &&
    typeof entry.expected?.agent_type === 'string' &&
    entry.expected.agent_type.length > 0 &&
    nonEmptyStrings(entry.expected?.final_message_includes_all) &&
    nonEmptyStrings(entry.expected?.delegated_source_prefixes) &&
    typeof entry.expected?.workspace_unchanged === 'boolean' &&
    Number.isInteger(entry.expected?.lifecycle?.minimum_initial_wait_timeout_ms) &&
    typeof entry.expected?.lifecycle?.allow_liveness_probe === 'boolean' &&
    Number.isInteger(entry.expected?.lifecycle?.max_recoveries)
  )), true);
  assert.equal(new Set(spec.evals.map((entry) => entry.id)).size, spec.evals.length);
}

function testEvaluation() {
  const finalMessage = 'RESULT accepted';

  const noProbeTimeline = passingTimeline();
  const noProbeRun = runResult(finalMessage, noProbeTimeline);
  assert.equal(evaluateLivenessRun(noProbeRun, syntheticExpected, false).passed, true);
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
    evaluateLivenessRun(codeModeVerifierRun, syntheticExpected, false).passed,
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
    evaluateLivenessRun(compoundVerifierRun, syntheticExpected, false).passed,
    true,
  );

  const v1Timeline = [
    event(
      'spawn_agent',
      { agent_type: 'synthetic-agent' },
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
    evaluateLivenessRun(
      runResult(finalMessage, v1Timeline),
      syntheticExpected,
      false,
    ).passed,
    true,
  );

  const instantRun = {
    ...runResult(finalMessage, noProbeTimeline),
    duration_ms: 1,
  };
  const instantEvaluation = evaluateLivenessRun(instantRun, syntheticExpected, false);
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
    syntheticExpected,
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
    syntheticExpected,
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
  const probeEvaluation = evaluateLivenessRun(probeRun, syntheticExpected, false);
  assert.equal(probeEvaluation.passed, false);
  assert.equal(probeEvaluation.metrics.probes, 1);
  assert.deepEqual(probeEvaluation.metrics.status_messages, ['progress']);
  assert.equal(probeEvaluation.metrics.timed_out_waits, 1);
  assert.equal(probeEvaluation.metrics.wait_count, 2);
  assert.equal(evaluateLivenessRun(noProbeRun, syntheticExpected, true).passed, false);

  const summary = summarizeLivenessRuns([
    { ...probeRun, evaluation: probeEvaluation },
    {
      ...noProbeRun,
      duration_ms: 60_000,
      evaluation: evaluateLivenessRun(noProbeRun, syntheticExpected, false),
    },
  ]);
  assert.equal(summary.accepted_runs, 1);
  assert.equal(summary.probe_runs, 1);
  assert.equal(summary.status_runs, 1);
  assert.equal(summary.median_duration_ms, 75_000);
}

async function main() {
  testArguments();
  await testSpecShape();
  testEvaluation();
  console.log('liveness eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
