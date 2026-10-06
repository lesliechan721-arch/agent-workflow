import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const INPUT_KEYS = ['attempt', 'case', 'paths', 'phase', 'variant', 'version'];
const ROLE_NAMES = [
  'codex-explore',
];

export const EXPLORE_DEVELOPER_INSTRUCTIONS = [
  'Follow the user request and applicable skills.',
  'Use the materialized Codex Explore roles for delegated read-only investigation.',
  'Do not modify files in this evaluation workspace.',
].join(' ');

export function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} must contain only ${keys.join(', ')}.`);
  }
}

function assertAttemptPath(value, expected, type, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  const attemptRoot = process.cwd();
  const relative = path.relative(attemptRoot, value);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the attempt root.`);
  }
  let current = attemptRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link.`);
    if (current !== value && !info.isDirectory()) {
      throw new Error(`${label} has a non-directory path component.`);
    }
  }
  const info = lstatSync(value);
  if (type === 'directory' ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`${label} must be a regular ${type}.`);
  }
  if (realpathSync(value) !== value) throw new Error(`${label} must not traverse a symbolic link.`);
}

export function parseAdapterInput(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`stdin must contain one JSON object: ${error.message}`);
  }
  const input = record(value, 'CodexWorkflowAdapterInput');
  exactKeys(input, INPUT_KEYS, 'CodexWorkflowAdapterInput');
  if (input.version !== 1) throw new Error('CodexWorkflowAdapterInput.version must be 1.');
  if (!['prepare', 'grade'].includes(input.phase)) {
    throw new Error('CodexWorkflowAdapterInput.phase must be prepare or grade.');
  }
  if (!['current', 'without-skill', 'previous-version'].includes(input.variant)) {
    throw new Error('CodexWorkflowAdapterInput.variant is invalid.');
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('CodexWorkflowAdapterInput.attempt must be a positive safe integer.');
  }
  record(input.case, 'CodexWorkflowAdapterInput.case');
  const paths = record(input.paths, 'CodexWorkflowAdapterInput.paths');
  exactKeys(
    paths,
    input.phase === 'prepare'
      ? ['fixtures', 'output', 'workspace']
      : ['evidence', 'fixtures', 'modelOutput', 'output', 'workspace'],
    'CodexWorkflowAdapterInput.paths',
  );
  const attemptRoot = process.cwd();
  if (realpathSync(attemptRoot) !== attemptRoot || !lstatSync(attemptRoot).isDirectory()) {
    throw new Error('CodexWorkflowAdapterInput attempt root must be a regular directory.');
  }
  const expectedDirectories = {
    workspace: path.join(attemptRoot, 'workspace', 'subject'),
    fixtures: path.join(attemptRoot, 'workspace', 'eval'),
    output: path.join(attemptRoot, 'output'),
  };
  for (const key of ['workspace', 'fixtures', 'output']) {
    assertAttemptPath(
      paths[key],
      expectedDirectories[key],
      'directory',
      `CodexWorkflowAdapterInput.paths.${key}`,
    );
  }
  if (input.phase === 'grade') {
    assertAttemptPath(
      paths.evidence,
      path.join(attemptRoot, 'output', 'workflow-evidence.json'),
      'file',
      'CodexWorkflowAdapterInput.paths.evidence',
    );
    assertAttemptPath(
      paths.modelOutput,
      path.join(attemptRoot, 'output', 'model-output.txt'),
      'file',
      'CodexWorkflowAdapterInput.paths.modelOutput',
    );
  }
  return input;
}

export function legacyCase(selectedCase) {
  const input = selectedCase.input === undefined
    ? {}
    : record(selectedCase.input, 'CodexWorkflowAdapterInput.case.input');
  const result = { id: selectedCase.id, ...input };
  if (selectedCase.expected !== undefined) {
    const expected = record(selectedCase.expected, 'CodexWorkflowAdapterInput.case.expected');
    if (Object.hasOwn(expected, 'criteria')) result.expected = expected.criteria;
    if (Object.hasOwn(expected, 'outcome')) result.expected_output = expected.outcome;
  }
  if (selectedCase.assertions !== undefined) result.assertions = selectedCase.assertions;
  return result;
}

function parseTomlString(source, key, file) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'mu'));
  if (!match) throw new Error(`${file} is missing ${key}.`);
  return JSON.parse(match[1]);
}

export async function workflowRoles(workspace, omitted = []) {
  const omittedNames = new Set(omitted);
  const root = path.join(workspace, '.codex', 'agents');
  const files = (await readdir(root)).filter((file) => file.endsWith('.toml')).sort();
  const found = new Map();
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    const name = parseTomlString(source, 'name', file);
    if (!ROLE_NAMES.includes(name)) continue;
    found.set(name, {
      name,
      description: parseTomlString(source, 'description', file),
      configFile: path.posix.join('.codex', 'agents', file),
    });
  }
  return ROLE_NAMES.filter((name) => !omittedNames.has(name)).map((name) => {
    const role = found.get(name);
    if (!role) throw new Error(`attempt workspace is missing role ${name}.`);
    return role;
  });
}

export function workflowProfile(evalCase) {
  const config = evalCase.codex_config ?? {};
  const protocol = config['features.multi_agent_v2.enabled'] === false ? 'v1' : 'v2';
  return {
    protocol,
    maxDepth: config['agents.max_depth'] ?? 1,
    hideSpawnAgentMetadata: protocol === 'v2'
      ? config['features.multi_agent_v2.hide_spawn_agent_metadata'] !== false
      : false,
    exposeSpawnAgentModelOverrides: protocol === 'v2'
      ? config['features.multi_agent_v2.expose_spawn_agent_model_overrides'] !== false
      : false,
  };
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

export async function readWorkflowEvidence(evidencePath) {
  const evidence = record(JSON.parse(await readFile(evidencePath, 'utf8')), 'workflow evidence');
  if (evidence.version !== 1) throw new Error('workflow evidence.version must be 1.');
  if (typeof evidence.rootThreadId !== 'string' || evidence.rootThreadId === '') {
    throw new Error('workflow evidence.rootThreadId is required.');
  }
  const completion = record(evidence.completion, 'workflow evidence.completion');
  const termination = record(evidence.termination, 'workflow evidence.termination');
  const cleanup = record(evidence.cleanup, 'workflow evidence.cleanup');
  const diff = record(evidence.workspaceDiff, 'workflow evidence.workspaceDiff');
  if (
    completion.status !== 'completed'
    || !Number.isSafeInteger(completion.durationMs)
    || completion.durationMs < 0
    || termination.reason !== 'completed'
    || termination.appServerProcessTreeCleanupConfirmed !== true
    || cleanup.isolatedCodexHomeRemoved !== true
    || typeof evidence.finalMessage !== 'string'
    || evidence.finalMessage.trim() === ''
    || evidence.usage === undefined
  ) throw new Error('workflow evidence is missing required completion, cleanup, final, or usage evidence.');
  for (const key of ['added', 'removed', 'modified']) requiredArray(diff[key], `workflow evidence.workspaceDiff.${key}`);
  for (const key of ['skillLoads', 'threadGraph', 'collaborationCalls', 'leafCalls']) {
    requiredArray(evidence[key], `workflow evidence.${key}`);
  }
  for (const thread of evidence.threadGraph) {
    const entry = record(thread, 'workflow evidence.threadGraph[]');
    if (Object.hasOwn(entry, 'agentPath') || Object.hasOwn(entry, 'agent_path')) {
      throw new Error('workflow evidence.threadGraph must not expose agent paths.');
    }
  }
  return evidence;
}

function oldCall(call) {
  const output = call.tool === 'agent_message' && call.output && typeof call.output === 'object'
    ? {
      message_type: call.output.messageType,
      status: call.output.status ?? null,
      task_name: call.output.taskName ?? null,
      payload: call.output.payload ?? null,
    }
    : call.output;
  return {
    ordinal: call.ordinal,
    thread_id: call.threadId,
    parent_thread_id: call.parentThreadId,
    linked_thread_id: call.linkedThreadId ?? null,
    call_id: call.callId,
    namespace: call.namespace,
    tool: call.tool,
    arguments: call.arguments,
    output,
    status: call.status,
  };
}

function collectFinalAgentResults(calls, descendantIds) {
  const results = [];
  const terminalResults = new Set();
  const add = (threadId, value) => {
    if (!descendantIds.has(threadId)) return;
    if (typeof value !== 'string' || value.trim() === '') return;
    const text = value.trim();
    const key = `${threadId}\0${text}`;
    if (terminalResults.has(key)) return;
    terminalResults.add(key);
    results.push({ text });
  };
  for (const call of calls) {
    if (call.tool === 'agent_message' && call.output?.message_type === 'FINAL_ANSWER') {
      add(call.linked_thread_id ?? call.thread_id, call.output.payload);
      continue;
    }
    if (call.tool !== 'wait_agent' || !call.output?.status || typeof call.output.status !== 'object') continue;
    for (const [threadId, status] of Object.entries(call.output.status)) {
      if (status && typeof status === 'object' && typeof status.completed === 'string') {
        add(threadId, status.completed);
      }
    }
  }
  return results;
}

export function evidenceRun(evidence) {
  const descendants = evidence.threadGraph.filter((thread) => thread.threadId !== evidence.rootThreadId);
  const descendantIds = new Set(descendants.map((thread) => thread.threadId));
  const calls = evidence.collaborationCalls
    .filter((call) => call.threadId === evidence.rootThreadId)
    .map(oldCall);
  const leafCalls = evidence.leafCalls
    .filter((call) =>
      descendantIds.has(call.threadId)
      || descendantIds.has(call.linkedThreadId))
    .map(oldCall);
  const loads = new Set(evidence.skillLoads.map((load) => `${load.threadId}\0${load.skill}`));
  const spawnCalls = calls.filter((call) => call.thread_id === evidence.rootThreadId && call.tool === 'spawn_agent');
  return {
    requested_explicitly: false,
    loaded: loads.has(`${evidence.rootThreadId}\0codex-explore`),
    load_evidence: evidence.skillLoads.find((load) => load.threadId === evidence.rootThreadId)?.callId ?? null,
    spawned: spawnCalls.length > 0,
    spawn_calls: spawnCalls,
    collaboration_timeline: calls,
    leaf_tool_calls: leafCalls,
    leaf_results: collectFinalAgentResults(leafCalls, descendantIds),
    leaf_trace_available: descendants.length > 0,
    leaf_trace: {
      parent_thread_ids: [evidence.rootThreadId],
      child_threads: descendants.map((thread) => ({
        thread_id: thread.threadId,
        parent_thread_id: thread.parentThreadId,
        agent_role: thread.agentRole,
        initial_user_message: thread.initialMessage?.kind === 'plaintext' ? thread.initialMessage.text : null,
        initial_opaque_link: thread.initialMessage?.kind === 'opaque-link' ? thread.initialMessage : null,
        developer_context: {
          present: thread.developerContext?.present === true,
          developer_message_count: thread.developerContext?.messageCount,
          has_multi_agent_mode_gate: thread.developerContext?.hasMultiAgentModeGate,
          has_nested_agent_capability: thread.developerContext?.hasNestedAgentCapability,
          has_codex_explore_developer_authorization:
            thread.developerContext?.hasCodexExploreDeveloperAuthorization,
        },
      })),
    },
    root_thread_id: evidence.rootThreadId,
    skill_loads: evidence.skillLoads,
    execution_error: false,
    termination: evidence.termination.reason,
    exit_code: 0,
    final_message: evidence.finalMessage,
    workspace_changes: evidence.workspaceDiff,
    duration_ms: evidence.completion.durationMs,
    usage: evidence.usage,
    descendant_cleanup_confirmed:
      evidence.termination.appServerProcessTreeCleanupConfirmed === true
      && evidence.cleanup.isolatedCodexHomeRemoved === true,
    cleanup_confirmed:
      evidence.termination.appServerProcessTreeCleanupConfirmed === true
      && evidence.cleanup.isolatedCodexHomeRemoved === true,
  };
}

export async function inspectExploreRoleContract(root) {
  const roles = await workflowRoles(root);
  const entries = await Promise.all(roles.map(async (role) => ({
    name: role.name,
    path: role.configFile,
    digest: `sha256:${createHash('sha256')
      .update(await readFile(path.join(root, role.configFile)))
      .digest('hex')}`,
  })));
  return {
    digest: `sha256:${createHash('sha256')
      .update(JSON.stringify(entries.map(({ name, digest }) => ({ name, digest }))))
      .digest('hex')}`,
    roles: entries,
  };
}

async function stdin() {
  process.stdin.setEncoding('utf8');
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

export async function runCodexWorkflowAdapterMain(moduleUrl, handlers) {
  if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(moduleUrl))) return;
  try {
    const input = parseAdapterInput(await stdin());
    const result = input.phase === 'prepare'
      ? await handlers.prepare(input)
      : await handlers.grade(input);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
