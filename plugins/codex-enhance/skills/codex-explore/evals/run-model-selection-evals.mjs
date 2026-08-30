import { rm } from 'node:fs/promises';
import process from 'node:process';

import {
  createProviderOutput,
  createEvalWorkspace,
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  runCodexOnce,
} from './eval-harness.mjs';

function validateExpected(expected, id) {
  const range = expected?.spawn_calls;
  if (
    !range ||
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new Error(`${id}.expected.spawn_calls must define a valid integer range.`);
  }
  if (
    expected.spawn_rejected !== undefined &&
    typeof expected.spawn_rejected !== 'boolean'
  ) {
    throw new Error(`${id}.expected.spawn_rejected must be a boolean.`);
  }
  if (
    expected.preflight_rejection_evidence !== undefined &&
    (
      !Array.isArray(expected.preflight_rejection_evidence) ||
      expected.preflight_rejection_evidence.length === 0 ||
      expected.preflight_rejection_evidence.some(
        (value) => typeof value !== 'string' || value.trim() === '',
      )
    )
  ) {
    throw new Error(`${id}.expected.preflight_rejection_evidence must be a non-empty string array.`);
  }
  if (expected.nested_delegation !== undefined) {
    const nested = expected.nested_delegation;
    if (
      !nested ||
      typeof nested !== 'object' ||
      typeof nested.root_skill !== 'string' ||
      typeof nested.root_skill_explicitly_invoked !== 'boolean' ||
      typeof nested.child_skill !== 'string' ||
      typeof nested.child_agent_type !== 'string' ||
      (nested.child_initial_message !== undefined &&
        (typeof nested.child_initial_message !== 'string' ||
          nested.child_initial_message.trim() === '')) ||
      (nested.child_initial_encrypted_link !== undefined &&
        typeof nested.child_initial_encrypted_link !== 'boolean') ||
      (nested.child_initial_message !== undefined &&
        nested.child_initial_encrypted_link === true) ||
      (nested.expect_early_termination === true &&
        nested.child_initial_message === undefined &&
        nested.child_initial_encrypted_link !== true) ||
      (nested.expect_early_termination !== undefined &&
        typeof nested.expect_early_termination !== 'boolean') ||
      (nested.forbid_root_child_followup !== undefined &&
        typeof nested.forbid_root_child_followup !== 'boolean') ||
      !Number.isInteger(nested.grandchild_spawn_calls?.min) ||
      !Number.isInteger(nested.grandchild_spawn_calls?.max) ||
      nested.grandchild_spawn_calls.min < 0 ||
      nested.grandchild_spawn_calls.max < nested.grandchild_spawn_calls.min ||
      typeof nested.expect_child_multi_agent_gate !== 'boolean' ||
      typeof nested.expect_child_developer_authorization !== 'boolean'
    ) {
      throw new Error(`${id}.expected.nested_delegation must define the nested evidence contract.`);
    }
  }
}

function validateEvalCase(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`evals[${index}] must be an object.`);
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9_]+$/.test(entry.id)) {
    throw new Error(`evals[${index}].id must use lowercase letters, digits, and underscores.`);
  }
  if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') {
    throw new Error(`${entry.id}.prompt must be a non-empty string.`);
  }
  if (
    entry.parent_model !== undefined &&
    (typeof entry.parent_model !== 'string' || entry.parent_model.trim() === '')
  ) {
    throw new Error(`${entry.id}.parent_model must be a non-empty string.`);
  }
  if (
    typeof entry.expected_output !== 'string' ||
    entry.expected_output.trim() === ''
  ) {
    throw new Error(`${entry.id}.expected_output must be a non-empty string.`);
  }
  if (!Array.isArray(entry.files) || !Array.isArray(entry.assertions)) {
    throw new Error(`${entry.id}.files and assertions must be arrays.`);
  }
  validateExpected(entry.expected, entry.id);
  return entry;
}

function valueEvidence(args, key) {
  return Object.hasOwn(args ?? {}, key)
    ? JSON.stringify(args[key])
    : '<absent>';
}

function evaluateArguments(call, expectedArguments, label) {
  const args = call?.arguments;
  if (!args) {
    return [{
      name: label,
      passed: false,
      evidence: 'spawn_agent arguments were unavailable in rollout evidence',
    }];
  }
  return Object.entries(expectedArguments ?? {}).map(([key, expected]) => {
    const present = Object.hasOwn(args, key);
    const passed = expected === null ? !present : present && args[key] === expected;
    return {
      name: `${label}.${key}`,
      passed,
      evidence: `expected=${expected === null ? '<absent>' : JSON.stringify(expected)} actual=${valueEvidence(args, key)}`,
    };
  });
}

function spawnRejected(call) {
  if (!call || call.output === undefined || call.output === null) return false;
  if (
    typeof call.output === 'object' &&
    !Array.isArray(call.output) &&
    (
      (typeof call.output.task_name === 'string' && call.output.task_name.trim() !== '') ||
      (typeof call.output.agent_id === 'string' && call.output.agent_id.trim() !== '')
    )
  ) {
    return false;
  }
  return typeof call.output === 'string'
    ? call.output.trim() !== ''
    : true;
}

function commandLoadedSkill(calls, skill) {
  const suffix = `.agents/skills/${skill}/SKILL.md`;
  return (calls ?? []).some((call) => {
    const command = call?.tool === 'exec_command'
      ? call.arguments?.cmd
      : call?.tool === 'exec'
        ? call.arguments?.input
        : null;
    return typeof command === 'string' && command.replaceAll('\\', '/').includes(suffix);
  });
}

function evaluateNestedDelegation(run, expected) {
  const nested = expected.nested_delegation;
  if (!nested) return [];
  const leafCalls = run.leaf_tool_calls ?? [];
  const rootThreadIds = new Set(run.leaf_trace?.parent_thread_ids ?? []);
  const directChildThreads = (run.leaf_trace?.child_threads ?? []).filter((thread) =>
    thread.agent_role === expected.arguments?.agent_type &&
    rootThreadIds.has(thread.parent_thread_id));
  const directChild = directChildThreads.length === 1 ? directChildThreads[0] : null;
  const directChildCalls = directChild
    ? leafCalls.filter((call) => call?.thread_id === directChild.thread_id)
    : [];
  const grandchildAttempts = directChildCalls.filter((call) => call?.tool === 'spawn_agent');
  const grandchildSpawns = grandchildAttempts.filter((call) => !spawnRejected(call));
  const childContext = directChild?.developer_context;
  const rootChildFollowups = (run.collaboration_timeline ?? []).filter((call) =>
    ['send_input', 'send_message', 'followup_task'].includes(call?.tool));
  const assertions = [
    {
      name: 'nested.root_skill_load',
      passed: nested.root_skill_explicitly_invoked ||
        commandLoadedSkill(run.collaboration_timeline, nested.root_skill),
      evidence: `skill=${nested.root_skill} explicitly_invoked=${nested.root_skill_explicitly_invoked}`,
    },
    {
      name: 'nested.child_skill_load',
      passed: commandLoadedSkill(directChildCalls, nested.child_skill),
      evidence: `skill=${nested.child_skill}`,
    },
    {
      name: 'nested.direct_child_trace',
      passed: directChildThreads.length === 1,
      evidence: `expected=1 actual=${directChildThreads.length}`,
    },
    {
      name: 'nested.grandchild_spawn_count',
      passed: grandchildSpawns.length >= nested.grandchild_spawn_calls.min &&
        grandchildSpawns.length <= nested.grandchild_spawn_calls.max,
      evidence: `expected=${nested.grandchild_spawn_calls.min}..${nested.grandchild_spawn_calls.max} successful=${grandchildSpawns.length} attempted=${grandchildAttempts.length}`,
    },
    {
      name: 'nested.grandchild_agent_type',
      passed: grandchildSpawns.length > 0 && grandchildSpawns.every((call) =>
        call?.arguments?.agent_type === nested.child_agent_type),
      evidence: `expected=${nested.child_agent_type} actual=${JSON.stringify(
        grandchildSpawns.map((call) => call?.arguments?.agent_type),
      )}`,
    },
    {
      name: 'nested.child_multi_agent_gate',
      passed: childContext?.has_multi_agent_mode_gate === nested.expect_child_multi_agent_gate,
      evidence: `expected=${nested.expect_child_multi_agent_gate} actual=${childContext?.has_multi_agent_mode_gate}`,
    },
    {
      name: 'nested.child_developer_authorization',
      passed: childContext?.has_codex_explore_developer_authorization ===
        nested.expect_child_developer_authorization,
      evidence: `expected=${nested.expect_child_developer_authorization} actual=${childContext?.has_codex_explore_developer_authorization}`,
    },
  ];
  if (nested.child_initial_message !== undefined) {
    assertions.push({
      name: 'nested.child_initial_message',
      passed: directChild?.initial_user_message === nested.child_initial_message,
      evidence: `expected=${JSON.stringify(nested.child_initial_message)} actual=${JSON.stringify(directChild?.initial_user_message)}`,
    });
  }
  if (nested.child_initial_encrypted_link === true) {
    assertions.push({
      name: 'nested.child_initial_encrypted_link',
      passed: typeof directChild?.initial_encrypted_message === 'string' &&
        directChild.initial_encrypted_message !== '' &&
        directChild.initial_encrypted_message === run.spawn_calls?.[0]?.arguments?.message,
      evidence: `child_encrypted=${directChild?.initial_encrypted_message ? '<present>' : '<absent>'} root_match=${directChild?.initial_encrypted_message === run.spawn_calls?.[0]?.arguments?.message}`,
    });
  }
  if (nested.forbid_root_child_followup === true) {
    assertions.push({
      name: 'nested.no_root_child_followup',
      passed: rootChildFollowups.length === 0,
      evidence: `expected=0 actual=${rootChildFollowups.length} tools=${JSON.stringify(rootChildFollowups.map((call) => call.tool))}`,
    });
  }
  if (nested.expect_early_termination === true) {
    assertions.push({
      name: 'nested.early_termination',
      passed: run.termination === 'expected_nested_outcome_observed',
      evidence: `expected=expected_nested_outcome_observed actual=${run.termination}`,
    }, {
      name: 'nested.descendant_cleanup',
      passed: run.descendant_cleanup_confirmed === true,
      evidence: `expected=true actual=${run.descendant_cleanup_confirmed}`,
    });
  }
  return assertions;
}

export function evaluateModelSelectionRun(run, expected) {
  const calls = run.spawn_calls ?? [];
  const errorEvents = (run.event_trace ?? []).filter(
    (event) =>
      event?.type === 'error' ||
      event?.item?.type === 'error',
  );
  const environmentEvidence = JSON.stringify({
    stderr: run.stderr,
    error_events: errorEvents,
  });
  const matchedEnvironmentError =
    run.execution_error &&
    calls.length === 0 &&
    expected.allowed_environment_errors?.find(
      (text) => environmentEvidence.includes(text),
    );
  if (matchedEnvironmentError) {
    return {
      passed: null,
      skipped: true,
      assertions: [{
        name: 'environment_capability',
        passed: null,
        evidence: `runtime rejected the requested schema profile: ${matchedEnvironmentError}`,
      }],
    };
  }

  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}`,
    },
    {
      name: 'spawn_call_count',
      passed:
        calls.length >= expected.spawn_calls.min &&
        calls.length <= expected.spawn_calls.max,
      evidence: `expected=${expected.spawn_calls.min}..${expected.spawn_calls.max} actual=${calls.length}`,
    },
  ];

  if (expected.arguments) {
    assertions.push(...evaluateArguments(calls[0], expected.arguments, 'arguments'));
  }
  if (calls.length > 0 && expected.arguments_if_called) {
    assertions.push(
      ...evaluateArguments(calls[0], expected.arguments_if_called, 'arguments_if_called'),
    );
  }
  for (const key of expected.present_arguments ?? []) {
    const args = calls[0]?.arguments;
    assertions.push({
      name: `present_arguments.${key}`,
      passed: Object.hasOwn(args ?? {}, key),
      evidence: `actual=${valueEvidence(args, key)}`,
    });
  }
  if (expected.spawn_rejected !== undefined) {
    const runtimeRejected = spawnRejected(calls[0]);
    const preflightEvidence = expected.preflight_rejection_evidence ?? [];
    const preflightRejected = calls.length === 0 &&
      preflightEvidence.length > 0 &&
      preflightEvidence.every((value) => (run.final_message ?? '').includes(value));
    const rejected = runtimeRejected || preflightRejected;
    assertions.push({
      name: 'spawn_rejected',
      passed: rejected === expected.spawn_rejected,
      evidence: `expected=${expected.spawn_rejected} actual=${rejected} mode=${runtimeRejected ? 'runtime' : preflightRejected ? 'preflight' : 'none'} output=${JSON.stringify(calls[0]?.output ?? null)}`,
    });
  }
  if (expected.final_message_includes_any) {
    const finalMessage = run.final_message ?? '';
    const matched = expected.final_message_includes_any.find((text) =>
      finalMessage.includes(text));
    assertions.push({
      name: 'final_message_includes_any',
      passed: Boolean(matched),
      evidence: matched
        ? `matched=${JSON.stringify(matched)}`
        : `expected one of ${JSON.stringify(expected.final_message_includes_any)}`,
    });
  }

  assertions.push(...evaluateNestedDelegation(run, expected));

  return {
    passed: assertions.every((assertion) => assertion.passed),
    skipped: false,
    assertions,
  };
}

export function modelEvalRunCase(entry) {
  return {
    query: entry.prompt,
    explicit_skill: entry.prompt.includes('$codex-explore'),
    should_load_skill: true,
    should_spawn_agent: entry.expected.spawn_calls.min > 0,
    wait_for_completion: Boolean(entry.wait_for_completion),
    stop_after_nested_evidence: Boolean(entry.expected.nested_delegation) &&
      !entry.wait_for_completion,
    expected: entry.expected,
    parent_model: entry.parent_model,
    enable_features: entry.enable_features,
    disable_features: entry.disable_features,
    codex_config: entry.codex_config,
  };
}

export async function runEvalProvider(input) {
  const entry = validateEvalCase(input.case, 0);
  if (entry.id !== input.caseId) {
    throw new Error('Provider case id does not match input.caseId.');
  }
  const workspace = await createEvalWorkspace({
    sourceRoot: input.workspacePath,
    configValues: entry.config_values,
  });
  try {
    const run = await runCodexOnce(workspace, modelEvalRunCase(entry), {
      codexBin: process.env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex',
      model: process.env.AW_SKILL_EVAL_CODEX_MODEL,
      captureTrace: true,
      sensitiveEnvironmentNames: PROVIDER_CREDENTIAL_ENVIRONMENT,
    });
    const evaluation = evaluateModelSelectionRun(run, entry.expected);
    return createProviderOutput({
      providerId: 'codex-explore-model-selection',
      graderId: 'codex-explore-model-selection-mechanical',
      run,
      result: {
        caseId: input.caseId,
        configuration: input.configuration,
        skillMode: input.skillMode,
        complete: !run.execution_error && !evaluation.skipped,
        ...evaluation,
      },
      outputDir: input.outputDir,
    });
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}
