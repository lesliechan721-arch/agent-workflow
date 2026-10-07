import {
  readFile,
} from 'node:fs/promises';

import {
  EXPLORE_DEVELOPER_INSTRUCTIONS,
  evidenceRun,
  inspectExploreRoleContract,
  legacyCase,
  readWorkflowEvidence,
  runCodexWorkflowAdapterMain,
  workflowProfile,
  workflowRoles,
} from './codex-workflow-adapter.mjs';
import { setupTriggerWorkspace } from './trigger-fixture.mjs';

function nonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  );
}

function validateLifecycleContract(value, id) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isInteger(value.minimum_initial_wait_timeout_ms) ||
    value.minimum_initial_wait_timeout_ms <= 0 ||
    typeof value.allow_liveness_probe !== 'boolean' ||
    !Number.isInteger(value.max_recoveries) ||
    value.max_recoveries < 0
  ) {
    throw new Error(`${id}.expected.lifecycle does not define the lifecycle contract.`);
  }
}

function validateLeafOutputContract(value, id) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['completed', 'blocked', 'insufficient'].includes(value.status) ||
    !Array.isArray(value.kinds) ||
    value.kinds.some((kind) => !['direct', 'inference', 'conflict'].includes(kind)) ||
    new Set(value.kinds).size !== value.kinds.length ||
    !nonEmptyStrings(value.includes_all) ||
    !nonEmptyStrings(value.patterns) ||
    !['absent', 'present'].includes(value.gaps)
  ) {
    throw new Error(`${id}.expected.leaf_output does not define the output contract.`);
  }
  for (const pattern of value.patterns) new RegExp(pattern, 'imu');
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
    expected.spawn_count !== 1 ||
    typeof expected.agent_type !== 'string' ||
    (expected.target_skill_loaded !== undefined && expected.target_skill_loaded !== true) ||
    (expected.clean_context_leaf_delegation !== undefined &&
      expected.clean_context_leaf_delegation !== true) ||
    (expected.clean_context_leaf_delegation === true &&
      (!nonEmptyStrings(expected.leaf_terminal_includes_all) ||
        !nonEmptyStrings(expected.leaf_terminal_patterns))) ||
    !nonEmptyStrings(expected.final_message_includes_all) ||
    !nonEmptyStrings(expected.final_message_patterns) ||
    !nonEmptyStrings(expected.delegated_source_prefixes) ||
    expected.workspace_unchanged !== true ||
    !expected.lifecycle
  ) {
    throw new Error(`${entry.id}.expected does not define the outcome contract.`);
  }
  validateLifecycleContract(expected.lifecycle, entry.id);
  if (expected.leaf_output !== undefined) {
    validateLeafOutputContract(expected.leaf_output, entry.id);
  }
  for (const pattern of expected.final_message_patterns) {
    new RegExp(pattern, 'iu');
  }
  for (const pattern of expected.leaf_terminal_patterns ?? []) {
    new RegExp(pattern, 'iu');
  }
  return entry;
}

function unchanged(changes) {
  return ['added', 'removed', 'modified'].every(
    (field) => Array.isArray(changes?.[field]) && changes[field].length === 0,
  );
}

function waitTimedOut(call) {
  if (call?.output && typeof call.output === 'object') {
    return call.output.timed_out === true ||
      call.output.timedOut === true ||
      call.output.status === 'timeout' ||
      call.output.status === 'timed_out';
  }
  return typeof call?.output === 'string' && /timed[ _-]?out/i.test(call.output);
}

function spawnedTaskIdentity(call) {
  return call?.output?.task_name ??
    call?.output?.thread_id ??
    call?.output?.threadId ??
    call?.output?.agent_id ??
    call?.output?.agentId ??
    null;
}

function callLinksChild(call, childId) {
  if (typeof childId !== 'string' || childId === '') return false;
  return call?.linked_thread_id === childId ||
    (call?.output?.status &&
      typeof call.output.status === 'object' &&
      !Array.isArray(call.output.status) &&
      Object.hasOwn(call.output.status, childId));
}

function terminalText(call, childId) {
  if (
    call?.tool === 'agent_message' &&
    call.output?.message_type === 'FINAL_ANSWER' &&
    callLinksChild(call, childId)
  ) {
    return call.output.payload;
  }
  if (
    call?.tool !== 'wait_agent' ||
    !call.output?.status ||
    typeof call.output.status !== 'object' ||
    Array.isArray(call.output.status)
  ) {
    return null;
  }
  return call.output.status[childId]?.completed ?? null;
}

function boundTerminalTexts(calls, childId) {
  return [...new Set((Array.isArray(calls) ? calls : [])
    .map((call) => terminalText(call, childId))
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim()))];
}

function linkedTerminal(call) {
  if (
    call?.tool !== 'agent_message' ||
    call.output?.message_type !== 'FINAL_ANSWER' ||
    typeof call?.linked_thread_id !== 'string' ||
    call.linked_thread_id === '' ||
    typeof call.output?.payload !== 'string' ||
    call.output.payload.trim() === ''
  ) {
    return null;
  }
  return {
    childId: call.linked_thread_id,
    text: call.output.payload.trim(),
  };
}

function linkedTerminalState(calls) {
  const terminals = [...new Map((Array.isArray(calls) ? calls : [])
    .map((call, index) => ({ index, terminal: linkedTerminal(call) }))
    .filter((entry) => entry.terminal !== null)
    .map((entry) => [
      `${entry.terminal.childId}\0${entry.terminal.text}`,
      entry,
    ])).values()];
  const childIds = new Set(terminals.map((entry) => entry.terminal.childId));
  return {
    childId: childIds.size === 1 ? terminals[0]?.terminal.childId ?? null : null,
    indexes: terminals.map((entry) => entry.index),
    terminalCount: terminals.length,
    childCount: childIds.size,
  };
}

export function evaluateLifecycleTrace(calls, contract) {
  const timeline = Array.isArray(calls) ? calls : [];
  const assertions = [];
  const add = (name, passed, evidence) => {
    assertions.push({ name: `lifecycle:${name}`, passed, evidence });
  };
  const indexes = (tool) => timeline.flatMap(
    (call, index) => call?.tool === tool ? [index] : [],
  );
  const spawnIndexes = indexes('spawn_agent');
  const firstSpawn = spawnIndexes[0];
  const targetTaskIdentity = Number.isInteger(firstSpawn)
    ? spawnedTaskIdentity(timeline[firstSpawn])
    : null;
  const waitIndexes = indexes('wait_agent');
  const probeIndexes = indexes('send_message');
  const statusIndexes = timeline.flatMap(
    (call, index) =>
      call?.tool === 'agent_message' &&
      call.output?.message_type === 'MESSAGE' &&
      ['progress', 'blocked'].includes(call.output?.status)
        ? [index]
        : [],
  );
  const followupIndexes = indexes('followup_task');
  const closeIndexes = indexes('close_agent');
  const terminalState = linkedTerminalState(timeline);
  const resultIndexes = terminalState.indexes;
  const retrySpawnIndexes = spawnIndexes.slice(1);
  const recoveryIndexes = [...followupIndexes, ...retrySpawnIndexes].sort(
    (left, right) => left - right,
  );

  add('trace_present', timeline.length > 0, `calls=${timeline.length}`);
  add(
    'target_child',
    typeof targetTaskIdentity === 'string' && targetTaskIdentity !== '' &&
      terminalState.childCount === 1 && terminalState.terminalCount === 1,
    `task=${targetTaskIdentity ?? 'missing'} linked_child=${terminalState.childId ?? 'missing'} terminals=${terminalState.terminalCount}`,
  );
  const firstWait = waitIndexes.find((index) => index > firstSpawn);
  add(
    'wait_after_spawn',
    Number.isInteger(firstSpawn) && Number.isInteger(firstWait),
    `spawn_index=${firstSpawn ?? 'missing'} wait_index=${firstWait ?? 'missing'}`,
  );
  const firstWaitTimeout = Number.isInteger(firstWait)
    ? timeline[firstWait]?.arguments?.timeout_ms
    : undefined;
  add(
    'minimum_initial_wait',
    Number.isInteger(firstWaitTimeout) &&
      firstWaitTimeout >= contract.minimum_initial_wait_timeout_ms,
    `minimum=${contract.minimum_initial_wait_timeout_ms} actual=${firstWaitTimeout ?? 'missing'}`,
  );

  let previousWaitIndex = null;
  let probesFollowTimeout = true;
  let oneProbePerTaskLifecycle = true;
  const probeCountsByTarget = new Map();
  for (const [index, call] of timeline.entries()) {
    if (call?.tool === 'wait_agent') {
      previousWaitIndex = index;
      continue;
    }
    if (call?.tool !== 'send_message') {
      continue;
    }
    const target = call.arguments?.target ?? '<unknown>';
    const probeCount = (probeCountsByTarget.get(target) ?? 0) + 1;
    probeCountsByTarget.set(target, probeCount);
    const previousWait = Number.isInteger(previousWaitIndex)
      ? timeline[previousWaitIndex]
      : null;
    probesFollowTimeout &&= waitTimedOut(previousWait);
    oneProbePerTaskLifecycle &&= probeCount <= 1;
  }
  add(
    'probe_only_after_timeout',
    probesFollowTimeout,
    `probe_indexes=${JSON.stringify(probeIndexes)}`,
  );
  add(
    'one_probe_per_task_lifecycle',
    oneProbePerTaskLifecycle,
    `probe_counts=${JSON.stringify(Object.fromEntries(probeCountsByTarget))}`,
  );
  add(
    'probe_followed_by_wait',
    probeIndexes.every((probeIndex) => waitIndexes.some((waitIndex) => waitIndex > probeIndex)),
    `probe_indexes=${JSON.stringify(probeIndexes)} wait_indexes=${JSON.stringify(waitIndexes)}`,
  );
  add(
    'probe_policy',
    contract.allow_liveness_probe ||
      (probeIndexes.length === 0 && statusIndexes.length === 0),
    `allowed=${contract.allow_liveness_probe} probe_indexes=${JSON.stringify(probeIndexes)} status_indexes=${JSON.stringify(statusIndexes)}`,
  );
  add(
    'status_follows_probe',
    statusIndexes.every((statusIndex) =>
      probeIndexes.some((probeIndex) => probeIndex < statusIndex)),
    `probe_indexes=${JSON.stringify(probeIndexes)} status_indexes=${JSON.stringify(statusIndexes)}`,
  );

  add(
    'recovery_limit',
    recoveryIndexes.length <= contract.max_recoveries,
    `maximum=${contract.max_recoveries} actual=${recoveryIndexes.length}`,
  );
  add(
    'recovery_followed_by_wait',
    recoveryIndexes.every(
      (recoveryIndex) => waitIndexes.some((waitIndex) => waitIndex > recoveryIndex),
    ),
    `recovery_indexes=${JSON.stringify(recoveryIndexes)} wait_indexes=${JSON.stringify(waitIndexes)}`,
  );

  const lastResultIndex = resultIndexes.at(-1);
  const lastRecoveryIndex = recoveryIndexes.at(-1);
  add(
    'cleanup_after_result',
    closeIndexes.every(
      (closeIndex) => Number.isInteger(lastResultIndex) && lastResultIndex < closeIndex,
    ),
    `close_indexes=${JSON.stringify(closeIndexes)} result_index=${lastResultIndex ?? 'missing'}`,
  );
  add(
    'result_before_final',
    Number.isInteger(lastResultIndex) &&
      lastResultIndex >= firstWait &&
      (!Number.isInteger(lastRecoveryIndex) || lastResultIndex > lastRecoveryIndex),
    `result_index=${lastResultIndex ?? 'missing'} wait_index=${firstWait ?? 'missing'} recovery_index=${lastRecoveryIndex ?? 'none'}`,
  );

  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

export function evaluateParentScopeIsolation(calls, delegatedSourcePrefixes) {
  const timeline = Array.isArray(calls) ? calls : [];
  const firstSpawn = timeline.findIndex((call) => call?.tool === 'spawn_agent');
  const terminalState = linkedTerminalState(timeline);
  const firstFinalResult = terminalState.childCount === 1 && terminalState.terminalCount === 1
    ? terminalState.indexes[0]
    : -1;
  const normalizedPrefixes = delegatedSourcePrefixes.map((prefix) =>
    prefix.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, ''));
  const readableArguments = (call) => {
    if (call?.tool === 'exec_command' && typeof call.arguments?.cmd === 'string') {
      return [call.arguments.cmd];
    }
    const codeModeInput = call?.arguments?.input ?? call?.arguments?.code;
    if (
      call?.tool === 'exec' &&
      typeof codeModeInput === 'string' &&
      call.output !== null &&
      call.output !== undefined &&
      /\btools\.(?:exec_command|view_image|read_mcp_resource)\s*\(/u.test(codeModeInput)
    ) {
      return [codeModeInput];
    }
    if (call?.tool === 'view_image' && typeof call.arguments?.path === 'string') {
      return [call.arguments.path];
    }
    if (call?.tool === 'read_mcp_resource' && typeof call.arguments?.uri === 'string') {
      return [call.arguments.uri];
    }
    return [];
  };
  const referencesPrefix = (value, prefix) => value
    .replaceAll('\\', '/')
    .split(/[\s"'`=,:;|&()[\]{}<>]+/u)
    .some((token) => {
      const normalized = token.replace(/^\.\//u, '').replace(/\/+$/u, '');
      return normalized === prefix ||
        normalized.startsWith(`${prefix}/`) ||
        normalized.endsWith(`/${prefix}`) ||
        normalized.includes(`/${prefix}/`);
    });
  const duplicateCalls = timeline.flatMap((call, index) => {
    const argumentsToCheck = readableArguments(call);
    return normalizedPrefixes.some((prefix) =>
      argumentsToCheck.some((value) => referencesPrefix(value, prefix)))
      ? [{ index, tool: call?.tool, arguments: call?.arguments }]
      : [];
  });
  return {
    name: 'parent_scope_isolation',
    passed:
      Number.isInteger(firstSpawn) &&
      firstSpawn >= 0 &&
      Number.isInteger(firstFinalResult) &&
      firstFinalResult > firstSpawn &&
      duplicateCalls.length === 0,
    evidence: JSON.stringify({
      first_spawn: firstSpawn,
      first_final_result: firstFinalResult,
      delegated_source_prefixes: delegatedSourcePrefixes,
      duplicate_calls: duplicateCalls,
    }),
  };
}

function distinctPatternLineIndexes(value, patterns) {
  const lines = value.split(/\r?\n/u);
  const candidates = patterns.map((pattern) => lines.flatMap(
    (line, index) => new RegExp(pattern, 'iu').test(line) ? [index] : [],
  ));
  const assign = (patternIndex, used, selected) => {
    if (patternIndex === candidates.length) return selected;
    for (const lineIndex of candidates[patternIndex]) {
      if (used.has(lineIndex)) continue;
      const result = assign(
        patternIndex + 1,
        new Set([...used, lineIndex]),
        [...selected, lineIndex],
      );
      if (result !== null) return result;
    }
    return null;
  };
  return assign(0, new Set(), []);
}

function textMatchesContract(value, includesAll, patterns) {
  return includesAll.every((text) => value.includes(text)) &&
    distinctPatternLineIndexes(value, patterns) !== null;
}

function evaluateCleanContextLeafDelegation(run, expected) {
  const spawn = run.spawn_calls?.[0];
  const spawnIdentity = spawnedTaskIdentity(spawn);
  const child = (run.leaf_trace?.child_threads ?? []).find((entry) =>
    entry?.agent_role === expected.agent_type &&
    (entry.initial_opaque_link?.linkedCallId === spawn?.call_id ||
      (typeof entry.initial_user_message === 'string' &&
        entry.initial_user_message === spawn?.arguments?.message) ||
      (spawn?.output?.task_name === undefined && entry.thread_id === spawnIdentity)));
  const terminalResults = boundTerminalTexts(run.leaf_tool_calls, child?.thread_id);
  const cleanContext = spawn?.arguments?.fork_context === false ||
    spawn?.arguments?.fork_turns === 'none';
  return [
    {
      name: 'leaf:target_child',
      passed: child !== undefined,
      evidence: `expected_role=${expected.agent_type} child=${child?.thread_id ?? 'missing'}`,
    },
    {
      name: 'leaf:clean_context',
      passed: cleanContext,
      evidence: `fork_context=${String(spawn?.arguments?.fork_context)} fork_turns=${String(spawn?.arguments?.fork_turns)}`,
    },
    {
      name: 'leaf:terminal_result',
      passed: terminalResults.length === 1 &&
        textMatchesContract(
          terminalResults[0] ?? '',
          expected.leaf_terminal_includes_all,
          expected.leaf_terminal_patterns,
        ),
      evidence: `distinct_non_empty_results=${terminalResults.length}`,
    },
  ];
}

export function evaluateWorkflowRun(run, expected) {
  const finalMessage = run.final_message ?? '';
  const spawnCalls = run.spawn_calls ?? [];
  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}`,
    },
    {
      name: 'spawn_count',
      passed: spawnCalls.length === expected.spawn_count,
      evidence: `expected=${expected.spawn_count} actual=${spawnCalls.length}`,
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
      name: 'engine_cleanup_confirmed',
      passed: run.cleanup_confirmed === true,
      evidence: `confirmed=${run.cleanup_confirmed === true}`,
    },
  ];
  if (expected.target_skill_loaded === true) {
    assertions.push({
      name: 'target_skill_loaded',
      passed: run.loaded === true,
      evidence: `loaded=${run.loaded === true}`,
    });
  }
  if (expected.clean_context_leaf_delegation === true) {
    assertions.push(...evaluateCleanContextLeafDelegation(run, expected));
  }
  for (const text of expected.final_message_includes_all) {
    assertions.push({
      name: `final_message_includes:${text}`,
      passed: finalMessage.includes(text),
      evidence: `required=${JSON.stringify(text)}`,
    });
  }
  for (const pattern of expected.final_message_patterns) {
    assertions.push({
      name: `final_message_pattern:${pattern}`,
      passed: new RegExp(pattern, 'iu').test(finalMessage),
      evidence: `pattern=${JSON.stringify(pattern)}`,
    });
  }
  if (expected.clean_context_leaf_delegation === true) {
    const finalPatternLineIndexes = distinctPatternLineIndexes(
      finalMessage,
      expected.final_message_patterns,
    );
    assertions.push({
      name: 'final_message_distinct_pattern_lines',
      passed: finalPatternLineIndexes !== null,
      evidence: `line_indexes=${JSON.stringify(finalPatternLineIndexes)}`,
    });
  }
  assertions.push({
    name: 'workspace_unchanged',
    passed:
      expected.workspace_unchanged === true &&
      unchanged(run.workspace_changes),
    evidence: JSON.stringify(run.workspace_changes),
  });
  assertions.push(
    evaluateParentScopeIsolation(
      run.collaboration_timeline,
      expected.delegated_source_prefixes,
    ),
  );
  assertions.push(
    ...evaluateLifecycleTrace(run.collaboration_timeline, expected.lifecycle).assertions,
  );
  if (expected.leaf_output) {
    assertions.push({
      name: 'leaf:role_available',
      passed:
        run.role_contract?.roles?.length === 1,
      evidence: JSON.stringify(run.role_contract ?? null),
    });
    assertions.push(...evaluateLeafOutput(run.leaf_results, expected.leaf_output).assertions);
  }
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

export function evaluateLeafOutput(results, contract) {
  const observed = Array.isArray(results) ? results : [];
  const output = observed[0]?.text ?? '';
  const lines = output.split(/\r?\n/u);
  const assertions = [];
  const add = (name, passed, evidence) => {
    assertions.push({ name: `leaf:${name}`, passed, evidence });
  };

  add('result_count', observed.length === 1, `count=${observed.length}`);
  const expectedStatus = contract.status === 'completed'
    ? 'Status: completed'
    : new RegExp(`^Status: ${contract.status} — \\S.*$`, 'u');
  add(
    'status',
    typeof expectedStatus === 'string'
      ? lines[0] === expectedStatus
      : expectedStatus.test(lines[0] ?? ''),
    `first_line=${JSON.stringify(lines[0] ?? '')}`,
  );
  add(
    'findings_heading',
    lines.some((line) => line === '## Findings'),
    'expected exact ## Findings heading',
  );
  for (const kind of contract.kinds) {
    const pattern = new RegExp(`^- \\[${kind}\\] .+ — .+$`, 'mu');
    add(`kind:${kind}`, pattern.test(output), `pattern=${JSON.stringify(pattern.source)}`);
  }
  for (const text of contract.includes_all) {
    add(`includes:${text}`, output.includes(text), `required=${JSON.stringify(text)}`);
  }
  for (const pattern of contract.patterns) {
    add(
      `pattern:${pattern}`,
      new RegExp(pattern, 'imu').test(output),
      `pattern=${JSON.stringify(pattern)}`,
    );
  }
  const gapsIndex = lines.findIndex((line) => line === '## Gaps');
  add(
    'gaps',
    contract.gaps === 'absent'
      ? gapsIndex === -1
      : gapsIndex >= 0 && lines.slice(gapsIndex + 1).some((line) => line.trim() !== ''),
    `expected=${contract.gaps} index=${gapsIndex}`,
  );
  const legacyFields = ['**kind:**', '**claim:**', '**evidence:**', '**locator:**', '**support:**'];
  add(
    'legacy_fields_absent',
    legacyFields.every((field) => !output.includes(field)),
    `legacy_fields=${JSON.stringify(legacyFields.filter((field) => output.includes(field)))}`,
  );
  add('characters', true, `characters=${[...output].length}`);
  return { passed: assertions.every((assertion) => assertion.passed), assertions };
}

export function workflowEvalRunCase(entry) {
  return {
    query: entry.prompt,
    explicit_skill: true,
    should_load_skill: true,
    should_spawn_agent: true,
    wait_for_completion: true,
    codex_config: entry.codex_config,
  };
}

export async function prepareWorkflow(input) {
  const entry = validateCase(legacyCase(input.case), 0);
  await setupTriggerWorkspace({ workspaceRoot: input.paths.workspace });
  return {
    version: 1,
    prompt: entry.prompt,
    sandbox: 'read-only',
    model: null,
    developerInstructions: EXPLORE_DEVELOPER_INSTRUCTIONS,
    roles: await workflowRoles(input.paths.workspace),
    multiAgent: workflowProfile(entry),
  };
}

export async function gradeWorkflow(input) {
  const entry = validateCase(legacyCase(input.case), 0);
  const [evidence, modelOutput, roleContract] = await Promise.all([
    readWorkflowEvidence(input.paths.evidence),
    readFile(input.paths.modelOutput, 'utf8'),
    inspectExploreRoleContract(input.paths.workspace),
  ]);
  if (modelOutput.trim() === '') throw new Error('model-output.txt must not be empty.');
  const run = evidenceRun(evidence);
  run.final_message = modelOutput.trimEnd();
  run.role_contract = roleContract;
  const evaluation = evaluateWorkflowRun(run, entry.expected);
  return {
    passed: evaluation.passed,
    score: evaluation.passed ? 1 : 0,
    details: {
      caseId: entry.id,
      variant: input.variant,
      complete: !run.execution_error,
      ...evaluation,
    },
  };
}

await runCodexWorkflowAdapterMain(import.meta.url, {
  prepare: prepareWorkflow,
  grade: gradeWorkflow,
});
