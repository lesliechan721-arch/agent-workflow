import { readFile } from 'node:fs/promises';

import {
  ROOT_DEVELOPER_INSTRUCTIONS,
  evidenceRun,
  legacyCase,
  readWorkflowEvidence,
  runCodexWorkflowAdapterMain,
  workflowProfile,
  workflowRoles,
} from './codex-workflow-adapter.mjs';
import { setupTriggerWorkspace } from './trigger-fixture.mjs';

const TOOL_ROUTER_ERROR = /codex_core::tools::router: error=([^\n]+)/u;
const BLOCK_REASON_MARKER = /^ROUTING_BLOCK_REASON=([a-z_]+)$/gmu;
const BLOCK_REASONS = new Set([
  'partial_history_unsupported',
  'preset_role_unavailable',
  'routing_override_conflict',
]);
const ROUTING_SCOPE_INSTRUCTION =
  '本用例只评估委派选择和 spawn_agent 参数，不需要子代理结果。';
const ROUTING_END_INSTRUCTION =
  '若发起委派，在 spawn_agent 返回后立即结束当前回复；不要等待或清理子代理。';
const ROUTING_FINAL_INSTRUCTION =
  '若发起委派，在 spawn_agent 返回后输出固定单行最终确认 `ROUTING_SPAWNED`，然后立即结束当前回复；不要等待或清理子代理。';

function validateExpected(expected, label) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error(`${label} must be an object.`);
  }
  const min = expected.spawn_calls?.min;
  const max = expected.spawn_calls?.max;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
    throw new Error(`${label}.spawn_calls must contain a valid min/max range.`);
  }
  if (
    expected.arguments !== undefined &&
    (!expected.arguments || typeof expected.arguments !== 'object' || Array.isArray(expected.arguments))
  ) {
    throw new Error(`${label}.arguments must be an object.`);
  }
  if (
    expected.present_arguments !== undefined &&
    (!Array.isArray(expected.present_arguments) ||
      expected.present_arguments.some((value) => typeof value !== 'string'))
  ) {
    throw new Error(`${label}.present_arguments must be a string array.`);
  }
  if (expected.block_reason !== undefined && !BLOCK_REASONS.has(expected.block_reason)) {
    throw new Error(`${label}.block_reason must be a supported routing block reason.`);
  }
  if (expected.block_reason !== undefined && expected.spawn_calls.max !== 0) {
    throw new Error(`${label}.block_reason requires spawn_calls.max to be 0.`);
  }
}

function valueEvidence(args, key) {
  return Object.hasOwn(args ?? {}, key) ? JSON.stringify(args[key]) : '<absent>';
}

function evaluateArguments(call, expectedArguments) {
  const args = call?.arguments;
  if (!args) {
    return [{
      name: 'arguments',
      passed: false,
      evidence: 'spawn_agent arguments were unavailable in rollout evidence',
    }];
  }
  return Object.entries(expectedArguments ?? {}).map(([key, expected]) => {
    const present = Object.hasOwn(args, key);
    return {
      name: `arguments.${key}`,
      passed: expected === null ? !present : present && args[key] === expected,
      evidence: `expected=${expected === null ? '<absent>' : JSON.stringify(expected)} actual=${valueEvidence(args, key)}`,
    };
  });
}

function hasLoadEvidence(run) {
  return (
    run.requested_explicitly === true ||
    (
      run.loaded === true &&
      typeof run.load_evidence === 'string' &&
      run.load_evidence !== ''
    )
  );
}

export function evaluateRoutingRun(run, expected, variant) {
  const calls = run.spawn_calls ?? [];
  const loadObserved = hasLoadEvidence(run);
  const routerError = run.stderr?.match(TOOL_ROUTER_ERROR)?.[1];
  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error && !routerError,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}${routerError ? ` router_error=${JSON.stringify(routerError)}` : ''}`,
    },
    {
      name: 'skill_load',
      passed: variant === 'with_skill' ? loadObserved : run.loaded === false,
      evidence: `variant=${variant} requested=${Boolean(run.requested_explicitly)} loaded=${Boolean(run.loaded)} evidence=${JSON.stringify(run.load_evidence ?? null)}`,
    },
    {
      name: 'spawn_call_count',
      passed: calls.length >= expected.spawn_calls.min && calls.length <= expected.spawn_calls.max,
      evidence: `expected=${expected.spawn_calls.min}..${expected.spawn_calls.max} actual=${calls.length}`,
    },
    {
      name: 'raw_spawn_argument_evidence',
      passed: !(run.spawned && calls.length === 0),
      evidence: run.spawned && calls.length === 0
        ? 'spawn_agent was observed but rollout arguments were unavailable'
        : `observed=${Boolean(run.spawned)} raw_calls=${calls.length}`,
    },
  ];
  if (expected.arguments) {
    assertions.push(...evaluateArguments(calls[0], expected.arguments));
  }
  for (const key of expected.present_arguments ?? []) {
    assertions.push({
      name: `present_arguments.${key}`,
      passed: Object.hasOwn(calls[0]?.arguments ?? {}, key),
      evidence: `actual=${valueEvidence(calls[0]?.arguments, key)}`,
    });
  }
  if (expected.block_reason) {
    const finalMessage = run.final_message ?? '';
    const reasons = [...finalMessage.matchAll(BLOCK_REASON_MARKER)].map((match) => match[1]);
    const explanation = finalMessage.replace(BLOCK_REASON_MARKER, '').trim();
    assertions.push({
      name: 'final_message_explanation',
      passed: explanation.length > 0,
      evidence: `characters=${[...explanation].length}`,
    });
    assertions.push({
      name: 'block_reason',
      passed: reasons.length === 1 && reasons[0] === expected.block_reason,
      evidence: `expected=${JSON.stringify(expected.block_reason)} actual=${JSON.stringify(reasons)}`,
    });
  }
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

export function routingRunCase(entry, profile, variant) {
  const expected = (entry.expected ?? entry.expectations)[profile];
  const blockReasonInstruction = expected.block_reason
    ? [
      '若不调用 spawn_agent，请先用自然语言说明阻断，再在末尾另起一行输出结构化原因。',
      `格式为 ROUTING_BLOCK_REASON=<reason>；reason 只能是 ${[...BLOCK_REASONS].join('、')}。`,
    ].join('')
    : '';
  return {
    query: [
      entry.prompt,
      ROUTING_SCOPE_INSTRUCTION,
      entry.id === 'simple_preset_fresh-v2'
        ? ROUTING_FINAL_INSTRUCTION
        : ROUTING_END_INSTRUCTION,
      blockReasonInstruction,
    ]
      .filter(Boolean)
      .join('\n\n'),
    explicit_skill: true,
    should_load_skill: variant === 'with_skill',
    should_spawn_agent: expected.spawn_calls.min > 0,
    stop_on_spawn: true,
    omit_roles: entry.omit_roles,
  };
}

function thrownExecutionError(error) {
  return {
    requested_explicitly: false,
    loaded: false,
    spawned: false,
    load_evidence: null,
    spawn_calls: [],
    termination: 'environment_error',
    exit_code: null,
    execution_error: true,
    stderr: error instanceof Error ? error.stack ?? error.message : String(error),
    final_message: null,
    duration_ms: 0,
    usage: null,
  };
}

function validateProviderRoutingCase(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Provider routing case must be an object.');
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9_-]+$/u.test(entry.id)) {
    throw new Error('Provider routing case id is invalid.');
  }
  if (typeof entry.sourceCaseId !== 'string' || !/^[a-z0-9_]+$/u.test(entry.sourceCaseId)) {
    throw new Error(`${entry.id}.sourceCaseId is invalid.`);
  }
  if (!['v1', 'v2'].includes(entry.runtimeProfile)) {
    throw new Error(`${entry.id}.runtimeProfile must be v1 or v2.`);
  }
  if (
    !entry.expected ||
    Object.keys(entry.expected).length !== 1 ||
    !Object.hasOwn(entry.expected, entry.runtimeProfile)
  ) {
    throw new Error(`${entry.id}.expected must contain only its runtime profile.`);
  }
  if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') {
    throw new Error(`${entry.id}.prompt must be a non-empty string.`);
  }
  if (!Array.isArray(entry.files)) {
    throw new Error(`${entry.id}.files must be an array.`);
  }
  validateExpected(entry.expected[entry.runtimeProfile], `${entry.id}.expected`);
  return entry;
}

export async function prepareRouting(input) {
  const entry = validateProviderRoutingCase(legacyCase(input.case));
  const profile = entry.runtimeProfile;
  const variant = input.variant === 'without-skill' ? 'without_skill' : 'with_skill';
  await setupTriggerWorkspace({
    workspaceRoot: input.paths.workspace,
    evalCase: { workspace_fixture: 'default' },
  });
  const runCase = routingRunCase(entry, profile, variant);
  return {
    version: 1,
    prompt: runCase.query,
    sandbox: 'read-only',
    model: 'gpt-5.6-luna',
    developerInstructions: ROOT_DEVELOPER_INSTRUCTIONS,
    roles: await workflowRoles(input.paths.workspace, runCase.omit_roles),
    multiAgent: workflowProfile(profile),
  };
}

export async function gradeRouting(input) {
  const entry = validateProviderRoutingCase(legacyCase(input.case));
  const profile = entry.runtimeProfile;
  const variant = input.variant === 'without-skill' ? 'without_skill' : 'with_skill';
  const [evidence, modelOutput] = await Promise.all([
    readWorkflowEvidence(input.paths.evidence),
    readFile(input.paths.modelOutput, 'utf8'),
  ]);
  if (modelOutput.trim() === '') throw new Error('model-output.txt must not be empty.');
  const run = evidenceRun(evidence, input.case, input.variant);
  run.final_message = modelOutput.trimEnd();
  const evaluation = evaluateRoutingRun(run, entry.expected[profile], variant);
  return {
    passed: evaluation.passed,
    score: evaluation.passed ? 1 : 0,
    details: {
      caseId: entry.id,
      sourceCaseId: entry.sourceCaseId,
      runtimeProfile: profile,
      variant: input.variant,
      complete: !run.execution_error,
      ...evaluation,
    },
  };
}

await runCodexWorkflowAdapterMain(import.meta.url, {
  prepare: prepareRouting,
  grade: gradeRouting,
});
