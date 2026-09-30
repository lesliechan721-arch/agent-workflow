import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  EXPLORE_DEVELOPER_INSTRUCTIONS,
  evidenceRun,
  legacyCase,
  readWorkflowEvidence,
  runCodexWorkflowAdapterMain,
  workflowProfile,
  workflowRoles,
} from './codex-workflow-adapter.mjs';
import {
  evaluateLifecycleTrace,
  evaluateParentScopeIsolation,
} from './run-workflow-evals.mjs';
import { setupTriggerWorkspace } from './trigger-fixture.mjs';

function nonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  );
}

function validateCase(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`evals[${index}] must be an object.`);
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9_]+$/.test(entry.id)) {
    throw new Error(`evals[${index}].id must use lowercase letters, digits, and underscores.`);
  }
  if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') {
    throw new Error(`${entry.id}.prompt must be a non-empty string.`);
  }
  const expected = entry.expected;
  if (
    !expected ||
    typeof expected.agent_type !== 'string' ||
    !nonEmptyStrings(expected.final_message_includes_all) ||
    !nonEmptyStrings(expected.delegated_source_prefixes) ||
    expected.workspace_unchanged !== true ||
    !Number.isInteger(expected.lifecycle?.minimum_initial_wait_timeout_ms) ||
    expected.lifecycle.minimum_initial_wait_timeout_ms <= 0 ||
    typeof expected.lifecycle?.allow_liveness_probe !== 'boolean' ||
    !Number.isInteger(expected.lifecycle?.max_recoveries) ||
    expected.lifecycle.max_recoveries < 0
  ) {
    throw new Error(`${entry.id}.expected does not define the liveness contract.`);
  }
  return entry;
}

export async function setupLivenessWorkspace(workspaceRoot) {
  const recordsRoot = path.join(workspaceRoot, 'docs', 'liveness', 'records');
  await mkdir(recordsRoot, { recursive: true });
  await Promise.all(Array.from({ length: 120 }, async (_, offset) => {
    const index = offset + 1;
    const timeout = index <= 40 ? 30 : index <= 80 ? 45 : 60;
    const name = `record-${String(index).padStart(3, '0')}.md`;
    const content = [
      `# Liveness record ${index}`,
      `record=${index} service=service-${(index % 8) + 1} timeout=${timeout}`,
      `region=region-${(index % 4) + 1} verified=true`,
      '',
    ].join('\n');
    await writeFile(path.join(recordsRoot, name), content, 'utf8');
  }));
  const verifier = [
    "import { readFile, readdir } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const recordsRoot = fileURLToPath(new URL('./records/', import.meta.url));",
    "const files = (await readdir(recordsRoot)).filter((name) => name.endsWith('.md')).sort();",
    'const values = new Set();',
    'for (const name of files) {',
    "  const text = await readFile(path.join(recordsRoot, name), 'utf8');",
    "  const match = text.match(/timeout=(\\d+)/);",
    "  if (!match) throw new Error(`Missing timeout in ${name}`);",
    '  values.add(Number(match[1]));',
    '}',
    'await new Promise((resolve) => setTimeout(resolve, 65_000));',
    'console.log(`records=${files.length}`);',
    'console.log(`timeout_values=${[...values].sort((left, right) => left - right).join(\',\')}`);',
    '',
  ].join('\n');
  await writeFile(
    path.join(workspaceRoot, 'docs', 'liveness', 'verify-records.mjs'),
    verifier,
    'utf8',
  );
}

function unchanged(changes) {
  return ['added', 'removed', 'modified'].every(
    (field) => Array.isArray(changes?.[field]) && changes[field].length === 0,
  );
}

function livenessMetrics(run) {
  const timeline = Array.isArray(run.collaboration_timeline)
    ? run.collaboration_timeline
    : [];
  const probes = timeline.filter((call) => call?.tool === 'send_message');
  const statusMessages = timeline.filter(
    (call) =>
      call?.tool === 'agent_message' &&
      call.output?.message_type === 'MESSAGE' &&
      ['progress', 'blocked'].includes(call.output?.status),
  );
  const timedOutWaits = timeline.filter(
    (call) => call?.tool === 'wait_agent' && call.output?.timed_out === true,
  );
  const waits = timeline.filter((call) => call?.tool === 'wait_agent');
  return {
    probes: probes.length,
    status_messages: statusMessages.map((call) => call.output.status),
    timed_out_waits: timedOutWaits.length,
    wait_count: waits.length,
    duration_ms: run.duration_ms,
    usage: run.usage ?? null,
  };
}

function invokesVerifier(call) {
  if (call?.tool === 'exec_command' && typeof call.arguments?.cmd === 'string') {
    return /(?:^|[\s;&|])node\s+(?:\.\/)?docs\/liveness\/verify-records\.mjs(?:$|[\s;&|])/u
      .test(call.arguments.cmd);
  }
  if (
    call?.tool !== 'exec' ||
    typeof call.arguments?.input !== 'string' ||
    call.output === null ||
    call.output === undefined
  ) {
    return false;
  }
  return /\btools\.exec_command\s*\(\s*\{[\s\S]{0,4000}?\bcmd\s*:\s*["'`]node\s+(?:\.\/)?docs\/liveness\/verify-records\.mjs(?:[\s;&|"'`])/u
    .test(call.arguments.input);
}

export function evaluateLivenessRun(run, expected, probeEnabled) {
  const finalMessage = run.final_message ?? '';
  const spawnCalls = Array.isArray(run.spawn_calls) ? run.spawn_calls : [];
  const leafTraceAvailable = run.leaf_trace_available === true;
  const metrics = livenessMetrics(run);
  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}`,
    },
    {
      name: 'spawn_count',
      passed: spawnCalls.length === 1,
      evidence: `expected=1 actual=${spawnCalls.length}`,
    },
    {
      name: 'agent_type',
      passed: spawnCalls[0]?.arguments?.agent_type === expected.agent_type,
      evidence: `expected=${expected.agent_type} actual=${spawnCalls[0]?.arguments?.agent_type}`,
    },
    {
      name: 'final_message',
      passed: finalMessage.trim() !== '',
      evidence: `characters=${[...finalMessage].length}`,
    },
    {
      name: 'workspace_unchanged',
      passed: expected.workspace_unchanged === true && unchanged(run.workspace_changes),
      evidence: JSON.stringify(run.workspace_changes),
    },
    {
      name: 'engine_cleanup_confirmed',
      passed: run.cleanup_confirmed === true,
      evidence: `confirmed=${run.cleanup_confirmed === true}`,
    },
    {
      name: 'materialized_probe_policy',
      passed: probeEnabled === expected.lifecycle.allow_liveness_probe,
      evidence: JSON.stringify({
        probe_enabled: probeEnabled,
        expected: expected.lifecycle.allow_liveness_probe,
      }),
    },
    {
      name: 'long_wait_exercised',
      passed:
        metrics.timed_out_waits >= 1 &&
        metrics.wait_count >= 2 &&
        run.duration_ms >= expected.lifecycle.minimum_initial_wait_timeout_ms,
      evidence: JSON.stringify({
        timed_out_waits: metrics.timed_out_waits,
        wait_count: metrics.wait_count,
        minimum_duration_ms: expected.lifecycle.minimum_initial_wait_timeout_ms,
        duration_ms: run.duration_ms,
      }),
    },
    {
      name: 'verifier_invoked_by_leaf',
      passed: leafTraceAvailable
        ? (run.leaf_tool_calls ?? []).some(invokesVerifier)
        : null,
      evidence: leafTraceAvailable
        ? JSON.stringify(
          (run.leaf_tool_calls ?? []).filter(
            (call) => ['exec_command', 'exec'].includes(call?.tool),
          ),
        )
        : 'child rollout trace is unavailable',
    },
    evaluateParentScopeIsolation(
      run.collaboration_timeline,
      expected.delegated_source_prefixes,
    ),
    ...evaluateLifecycleTrace(
      run.collaboration_timeline,
      expected.lifecycle,
    ).assertions,
  ];
  for (const text of expected.final_message_includes_all) {
    assertions.push({
      name: `final_message_includes:${text}`,
      passed: finalMessage.includes(text),
      evidence: `required=${JSON.stringify(text)}`,
    });
  }
  return {
    complete: leafTraceAvailable,
    passed: leafTraceAvailable && assertions.every((assertion) => assertion.passed === true),
    assertions,
    metrics,
  };
}

export async function prepareLiveness(input) {
  const entry = validateCase(legacyCase(input.case), 0);
  await setupTriggerWorkspace({ workspaceRoot: input.paths.workspace });
  await setupLivenessWorkspace(input.paths.workspace);
  return {
    version: 1,
    prompt: entry.prompt,
    sandbox: 'workspace-write',
    model: null,
    developerInstructions: EXPLORE_DEVELOPER_INSTRUCTIONS,
    roles: await workflowRoles(input.paths.workspace),
    multiAgent: workflowProfile(entry),
  };
}

export async function gradeLiveness(input) {
  const entry = validateCase(legacyCase(input.case), 0);
  const [evidence, modelOutput] = await Promise.all([
    readWorkflowEvidence(input.paths.evidence),
    readFile(input.paths.modelOutput, 'utf8'),
  ]);
  if (modelOutput.trim() === '') throw new Error('model-output.txt must not be empty.');
  const skillPath = path.join(
    input.paths.workspace,
    '.agents',
    'skills',
    'codex-explore',
    'SKILL.md',
  );
  const probeEnabled = input.variant !== 'without-skill'
    && (await readFile(skillPath, 'utf8')).includes('status=progress');
  const run = evidenceRun(evidence);
  run.final_message = modelOutput.trimEnd();
  run.probe_enabled = probeEnabled;
  const evaluation = evaluateLivenessRun(run, entry.expected, probeEnabled);
  const passed = evaluation.complete && evaluation.passed;
  return {
    passed,
    score: passed ? 1 : 0,
    details: {
      caseId: entry.id,
      variant: input.variant,
      complete: evaluation.complete,
      ...evaluation,
    },
  };
}

await runCodexWorkflowAdapterMain(import.meta.url, {
  prepare: prepareLiveness,
  grade: gradeLiveness,
});
