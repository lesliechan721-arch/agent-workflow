import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { setupTriggerWorkspace } from './trigger-fixture.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
export const PROVIDER_CREDENTIAL_ENVIRONMENT = [
  'ALL_PROXY',
  'AW_SKILL_EVAL_CODEX_BIN',
  'AW_SKILL_EVAL_CODEX_MODEL',
  'CODEX_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
];

export async function readEvalResource(relativePath) {
  const normalized = path.normalize(relativePath);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`Eval resource must stay inside evals/: ${relativePath}`);
  }
  try {
    return await readFile(path.join(evalDir, normalized), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !process.env.AW_PLUGIN_CONTEXT) throw error;
  }
  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
  if (typeof context.sourceRoot !== 'string' || context.sourceRoot.trim() === '') {
    throw new Error(`Eval resource is missing from bundle: ${relativePath}`);
  }
  return readFile(
    path.join(context.sourceRoot, 'skills', 'codex-explore', 'evals', normalized),
    'utf8',
  );
}
export async function createEvalWorkspace({ configValues = {}, sourceRoot } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-eval-'));
  try {
    if (!sourceRoot) {
      throw new Error(
        'custom provider input.workspacePath is required; use the workspace snapshot from the prepared Eval Plan.',
      );
    }
    if (Object.keys(configValues).length > 0) {
      throw new Error('Specialized eval config must be represented by a materialized profile.');
    }
    await cp(sourceRoot, root, { recursive: true, force: true });
    await setupTriggerWorkspace({ workspaceRoot: root });
    return {
      root,
      skillPath: path.join(root, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function redactedProviderEvidence(value) {
  const secrets = PROVIDER_CREDENTIAL_ENVIRONMENT
    .map((name) => process.env[name])
    .filter((entry) => typeof entry === 'string' && entry !== '');
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (typeof entry !== 'string') return entry;
    return secrets.reduce(
      (result, secret) => result.replaceAll(secret, '[redacted credential]'),
      entry,
    );
  }));
}

export async function createProviderOutput({
  providerId,
  graderId,
  run,
  result,
  outputDir,
}) {
  const evidencePath = path.join(outputDir, 'provider-evidence.json');
  const tracePath = path.join(outputDir, 'provider-trace.json');
  await Promise.all([
    writeFile(
      evidencePath,
      `${JSON.stringify(redactedProviderEvidence(run), null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      tracePath,
      `${JSON.stringify(redactedProviderEvidence(run.event_trace ?? []), null, 2)}\n`,
      'utf8',
    ),
  ]);
  const artifacts = [
    { path: path.basename(evidencePath), role: 'report' },
    { path: path.basename(tracePath), role: 'trace' },
  ];
  if (typeof run.final_message === 'string' && run.final_message !== '') {
    const outputPath = path.join(outputDir, 'model-output.txt');
    await writeFile(
      outputPath,
      `${redactedProviderEvidence(run.final_message)}\n`,
      'utf8',
    );
    artifacts.push({ path: path.basename(outputPath), role: 'output' });
  }
  return {
    schemaVersion: 1,
    provider: { id: providerId, version: 'manifest-v1' },
    usage: run.usage && typeof run.usage === 'object'
      ? redactedProviderEvidence(run.usage)
      : null,
    grading: {
      grader: { id: graderId, version: '1' },
      result: redactedProviderEvidence(result),
    },
    artifacts,
  };
}

export function parseExecEventLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function eventItem(event) {
  if (!event || !['item.started', 'item.completed', 'item.updated'].includes(event.type)) {
    return null;
  }
  return event.item && typeof event.item === 'object' ? event.item : null;
}

export function inspectExecEvent(event, skillPath) {
  const item = eventItem(event);
  if (!item) {
    return {};
  }

  if (item.type === 'command_execution' && typeof item.command === 'string') {
    const normalizedCommand = item.command.replaceAll('\\', '/');
    const normalizedSkillPath = skillPath.replaceAll('\\', '/');
    if (
      normalizedCommand.includes(normalizedSkillPath) ||
      normalizedCommand.includes('.agents/skills/codex-explore/SKILL.md')
    ) {
      return { loaded: true, loadEvidence: item.command };
    }
  }

  if (item.type === 'collab_tool_call' && item.tool === 'spawn_agent') {
    return {
      spawned: true,
      spawnEvidence: typeof item.prompt === 'string' ? item.prompt : 'spawn_agent',
    };
  }

  return {};
}

function codexConfigValue(value) {
  return JSON.stringify(value);
}

function sensitiveEnvironmentNames(options) {
  if (Array.isArray(options.sensitiveEnvironmentNames)) {
    return options.sensitiveEnvironmentNames.filter((name) => typeof name === 'string');
  }
  try {
    const names = JSON.parse(process.env.AW_CODEX_EVAL_SENSITIVE_ENV_NAMES ?? '[]');
    return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

export function resolveParentModelOverride(evalCase, options) {
  return evalCase.parent_model ?? options.model ?? null;
}

export function buildCodexArgs(workspace, evalCase, options) {
  const args = [
    'exec',
    '--json',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    options.sandboxMode ?? 'read-only',
    '--cd',
    workspace.root,
    '--enable',
    'multi_agent',
    '--enable',
    'executed_tool_call_metadata',
    '--config',
    `skills.include_instructions=true`,
    '--config',
    'suppress_unstable_features_warning=true',
    '--config',
    `shell_environment_policy.exclude=${codexConfigValue([
      'CODEX_HOME',
      ...sensitiveEnvironmentNames(options),
    ])}`,
  ];
  const modelProvider = options.modelProvider ?? process.env.AW_CODEX_EVAL_MODEL_PROVIDER;
  if (modelProvider) {
    args.push('--config', `model_provider=${codexConfigValue(modelProvider)}`);
  }
  for (const feature of evalCase.enable_features ?? []) {
    args.push('--enable', feature);
  }
  for (const feature of evalCase.disable_features ?? []) {
    args.push('--disable', feature);
  }
  for (const [key, value] of Object.entries(evalCase.codex_config ?? {})) {
    args.push('--config', `${key}=${codexConfigValue(value)}`);
  }
  const parentModel = resolveParentModelOverride(evalCase, options);
  if (parentModel) {
    args.push('--model', parentModel);
  }
  args.push(evalCase.query);
  return args;
}

async function listFilesRecursively(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(candidate) : [candidate];
  }));
  return nested.flat();
}

function parseSerializedValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function agentMessageText(payload) {
  if (!Array.isArray(payload?.content)) {
    return '';
  }
  return payload.content
    .filter((item) => item?.type === 'input_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function agentUpdate(payload, rolloutFile, codexHome, lineNumber) {
  if (payload?.type !== 'agent_message') {
    return null;
  }
  const text = agentMessageText(payload);
  const messageType = text.match(/^Message Type:\s*(MESSAGE|FINAL_ANSWER)\s*$/mu)?.[1];
  if (!messageType) {
    return null;
  }
  return {
    call_id: null,
    namespace: 'collaboration',
    tool: 'agent_message',
    arguments: null,
    output: {
      message_type: messageType,
      status: text.match(/\bstatus=(progress|blocked)\b/u)?.[1] ?? null,
      task_name: text.match(/^Task name:\s*(.+)\s*$/mu)?.[1] ?? null,
    },
    rollout_file: path.relative(codexHome, rolloutFile),
    line_number: lineNumber,
  };
}

export function buildCollaborationTimeline(
  lines,
  rolloutFile = 'rollout.jsonl',
  codexHome = '.',
) {
  const calls = [];
  const callsById = new Map();
  const pendingOutputs = new Map();

  for (const [index, line] of lines.entries()) {
    const event = parseExecEventLine(line);
    const completedItem = event?.type === 'event_msg' && event.payload?.type === 'item_completed'
      ? event.payload.item
      : null;
    if (completedItem?.type === 'CommandExecution') {
      const parsedCommands = Array.isArray(completedItem.parsed_cmd)
        ? completedItem.parsed_cmd
          .filter((entry) => typeof entry?.cmd === 'string')
          .map((entry) => entry.cmd)
        : [];
      const rawCommand = Array.isArray(completedItem.command)
        ? completedItem.command.at(-1)
        : completedItem.command;
      const command = typeof rawCommand === 'string'
        ? rawCommand
        : parsedCommands.join('\n') || null;
      if (command) {
        calls.push({
          call_id: typeof completedItem.id === 'string'
            ? `command:${completedItem.id}`
            : `command:${index + 1}`,
          namespace: null,
          tool: 'exec_command',
          arguments: { cmd: command },
          output: {
            exit_code: Number.isInteger(completedItem.exit_code)
              ? completedItem.exit_code
              : null,
            status: completedItem.status ?? null,
          },
          rollout_file: path.relative(codexHome, rolloutFile),
          line_number: index + 1,
        });
      }
      continue;
    }
    const payload = event?.type === 'response_item' ? event.payload : null;
    const update = agentUpdate(payload, rolloutFile, codexHome, index + 1);
    if (update) {
      calls.push(update);
      continue;
    }
    if (payload?.type === 'custom_tool_call' && typeof payload.name === 'string') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      if (callId && callsById.has(callId)) {
        continue;
      }
      const call = {
        call_id: callId,
        namespace: null,
        tool: payload.name,
        arguments: typeof payload.input === 'string'
          ? { input: payload.input }
          : null,
        output: callId && pendingOutputs.has(callId)
          ? pendingOutputs.get(callId)
          : null,
        rollout_file: path.relative(codexHome, rolloutFile),
        line_number: index + 1,
      };
      calls.push(call);
      if (callId) {
        callsById.set(callId, call);
      }
      continue;
    }
    if (payload?.type === 'function_call' && typeof payload.name === 'string') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      if (callId && callsById.has(callId)) {
        continue;
      }
      const parsedArguments = parseSerializedValue(payload.arguments);
      const call = {
        call_id: callId,
        namespace: typeof payload.namespace === 'string' ? payload.namespace : null,
        tool: payload.name,
        arguments:
          parsedArguments &&
          typeof parsedArguments === 'object' &&
          !Array.isArray(parsedArguments)
            ? parsedArguments
            : null,
        output: callId && pendingOutputs.has(callId)
          ? pendingOutputs.get(callId)
          : null,
        rollout_file: path.relative(codexHome, rolloutFile),
        line_number: index + 1,
      };
      calls.push(call);
      if (callId) {
        callsById.set(callId, call);
      }
      continue;
    }

    const metadata = payload?.internal_chat_message_metadata_passthrough;
    const executedCalls = Array.isArray(metadata?.executed_tool_calls)
      ? metadata.executed_tool_calls
      : [];
    for (const [nestedIndex, executedCall] of executedCalls.entries()) {
      if (typeof executedCall?.name !== 'string') {
        continue;
      }
      const separator = executedCall.name.indexOf('__');
      const namespace = separator >= 0
        ? executedCall.name.slice(0, separator)
        : null;
      const name = separator >= 0
        ? executedCall.name.slice(separator + 2)
        : executedCall.name;
      const directCall = typeof payload.call_id === 'string'
        ? callsById.get(payload.call_id)
        : null;
      if (
        directCall?.tool === name &&
        (namespace === null || directCall.namespace === namespace)
      ) {
        continue;
      }
      calls.push({
        call_id: `executed:${index + 1}:${nestedIndex}`,
        namespace,
        tool: name,
        arguments:
          executedCall.arguments &&
          typeof executedCall.arguments === 'object' &&
          !Array.isArray(executedCall.arguments)
            ? executedCall.arguments
            : null,
        output: null,
        rollout_file: path.relative(codexHome, rolloutFile),
        line_number: index + 1,
      });
    }

    if (
      !['function_call_output', 'custom_tool_call_output'].includes(payload?.type) ||
      typeof payload.call_id !== 'string'
    ) {
      continue;
    }
    const output = parseSerializedValue(payload.output);
    const call = callsById.get(payload.call_id);
    if (call) {
      call.output = output;
    } else {
      pendingOutputs.set(payload.call_id, output);
    }
  }

  return calls;
}

function rolloutIdentity(lines) {
  for (const line of lines) {
    const event = parseExecEventLine(line);
    if (event?.type !== 'session_meta' || !event.payload) {
      continue;
    }
    const threadSpawn = event.payload.source?.subagent?.thread_spawn;
    return {
      threadId: typeof event.payload.id === 'string' ? event.payload.id : null,
      parentThreadId: typeof threadSpawn?.parent_thread_id === 'string'
        ? threadSpawn.parent_thread_id
        : null,
      agentPath: typeof threadSpawn?.agent_path === 'string'
        ? threadSpawn.agent_path
        : null,
      agentRole: typeof threadSpawn?.agent_role === 'string'
        ? threadSpawn.agent_role
        : null,
    };
  }
  return {
    threadId: null,
    parentThreadId: null,
    agentPath: null,
    agentRole: null,
  };
}

function developerContextMarkers(lines) {
  const developerText = lines.flatMap((line) => {
    const event = parseExecEventLine(line);
    const payload = event?.type === 'response_item' ? event.payload : null;
    if (payload?.type !== 'message' || payload.role !== 'developer') {
      return [];
    }
    return (payload.content ?? [])
      .filter((item) => item?.type === 'input_text' && typeof item.text === 'string')
      .map((item) => item.text);
  }).join('\n');
  return {
    developer_message_count: lines.filter((line) => {
      const event = parseExecEventLine(line);
      const payload = event?.type === 'response_item' ? event.payload : null;
      return payload?.type === 'message' && payload.role === 'developer';
    }).length,
    has_multi_agent_mode_gate: developerText.includes('<multi_agent_mode>'),
    has_nested_agent_capability: developerText.includes('Child agents can also spawn their own sub-agents'),
    has_codex_explore_developer_authorization:
      developerText.includes('### Codex Explore 子代理授权'),
  };
}

function initialUserMessage(lines) {
  for (const line of lines) {
    const event = parseExecEventLine(line);
    const payload = event?.type === 'response_item' ? event.payload : null;
    if (payload?.type !== 'message' || payload.role !== 'user') continue;
    const text = (payload.content ?? [])
      .filter((item) => item?.type === 'input_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
    if (text && !/^<environment_context>[\s\S]*<\/environment_context>$/u.test(text.trim())) {
      return text;
    }
  }
  return null;
}

function initialEncryptedAgentTask(lines) {
  for (const line of lines) {
    const event = parseExecEventLine(line);
    const payload = event?.type === 'response_item' ? event.payload : null;
    if (payload?.type !== 'agent_message' || !Array.isArray(payload.content)) continue;
    const envelope = payload.content.find(
      (item) => item?.type === 'input_text' && typeof item.text === 'string',
    )?.text;
    const encrypted = payload.content.find(
      (item) => item?.type === 'encrypted_content' &&
        typeof item.encrypted_content === 'string',
    )?.encrypted_content;
    if (envelope?.includes('Message Type: NEW_TASK') && encrypted) return encrypted;
  }
  return null;
}

export function recoverV1SpawnCallsFromExecEvents(events, threadIdentities) {
  const identitiesByThreadId = new Map(
    threadIdentities
      .filter((identity) => identity.threadId)
      .map((identity) => [identity.threadId, identity]),
  );
  const calls = [];
  for (const event of events ?? []) {
    const item = eventItem(event);
    if (
      item?.type !== 'collab_tool_call' ||
      item.tool !== 'spawn_agent' ||
      item.status !== 'completed' ||
      !Array.isArray(item.receiver_thread_ids)
    ) {
      continue;
    }
    for (const threadId of item.receiver_thread_ids) {
      const identity = identitiesByThreadId.get(threadId);
      if (!identity?.agentRole || typeof item.prompt !== 'string') {
        continue;
      }
      calls.push({
        call_id: typeof item.id === 'string' ? item.id : `v1-spawn:${threadId}`,
        namespace: 'multi_agent_v1',
        tool: 'spawn_agent',
        arguments: {
          agent_type: identity.agentRole,
          fork_context: false,
          message: item.prompt,
        },
        output: { agent_id: threadId },
        rollout_file: identity.rolloutFile ?? null,
        line_number: null,
        evidence_source: 'exec_collab_tool_call+child_session_meta',
      });
    }
  }
  return calls;
}

export async function readRolloutEvidenceFromRollouts(codexHome) {
  const files = (await listFilesRecursively(path.join(codexHome, 'sessions')))
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
  const rollouts = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n');
    const identity = rolloutIdentity(lines);
    const calls = buildCollaborationTimeline(lines, file, codexHome).map((call) => ({
      ...call,
      thread_id: identity.threadId,
      parent_thread_id: identity.parentThreadId,
    }));
    rollouts.push({
      file,
      calls,
      ...identity,
      context: developerContextMarkers(lines),
      initialUserMessage: initialUserMessage(lines),
      initialEncryptedAgentTask: initialEncryptedAgentTask(lines),
    });
  }

  const childThreadsByParent = new Map();
  for (const rollout of rollouts) {
    if (!rollout.parentThreadId) continue;
    const children = childThreadsByParent.get(rollout.parentThreadId) ?? [];
    children.push(rollout);
    childThreadsByParent.set(rollout.parentThreadId, children);
  }
  const rootParents = rollouts.filter(
    (rollout) =>
      rollout.parentThreadId === null &&
      (
        rollout.calls.some((call) => call.tool === 'spawn_agent') ||
        childThreadsByParent.has(rollout.threadId)
      ),
  );
  const fallbackParents = rootParents.length > 0
    ? rootParents
    : rollouts.filter((rollout) =>
      rollout.calls.some((call) => call.tool === 'spawn_agent'));
  const descendantParentIds = new Set(
    rootParents.map((rollout) => rollout.threadId).filter(Boolean),
  );
  const descendants = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const rollout of rollouts) {
      if (
        descendants.includes(rollout) ||
        !rollout.parentThreadId ||
        !descendantParentIds.has(rollout.parentThreadId)
      ) {
        continue;
      }
      descendants.push(rollout);
      if (rollout.threadId) descendantParentIds.add(rollout.threadId);
      changed = true;
    }
  }
  for (const rollout of descendants) {
    if (rollout.calls.some((call) => call.tool === 'spawn_agent')) continue;
    for (const child of childThreadsByParent.get(rollout.threadId) ?? []) {
      rollout.calls.push({
        call_id: `lineage-spawn:${child.threadId}`,
        namespace: 'multi_agent_v1',
        tool: 'spawn_agent',
        arguments: { agent_type: child.agentRole },
        output: { agent_id: child.threadId },
        rollout_file: path.relative(codexHome, child.file),
        line_number: null,
        thread_id: rollout.threadId,
        parent_thread_id: rollout.parentThreadId,
        evidence_source: 'child_session_meta_lineage',
      });
    }
  }
  return {
    parent_calls: fallbackParents.flatMap((rollout) => rollout.calls),
    leaf_calls: descendants.flatMap((rollout) => rollout.calls),
    leaf_trace_available: rootParents.length > 0 && descendants.length > 0,
    leaf_trace: {
      parent_thread_ids: rootParents.map((rollout) => rollout.threadId),
      child_threads: descendants.map((rollout) => ({
        thread_id: rollout.threadId,
        parent_thread_id: rollout.parentThreadId,
        agent_path: rollout.agentPath,
        agent_role: rollout.agentRole,
        initial_user_message: rollout.initialUserMessage,
        initial_encrypted_message: rollout.initialEncryptedAgentTask,
        developer_context: rollout.context,
      })),
    },
    thread_identities: rollouts.map((rollout) => ({
      threadId: rollout.threadId,
      parentThreadId: rollout.parentThreadId,
      agentPath: rollout.agentPath,
      agentRole: rollout.agentRole,
      rolloutFile: path.relative(codexHome, rollout.file),
    })),
  };
}

export async function readCollaborationTimelineFromRollouts(codexHome) {
  return (await readRolloutEvidenceFromRollouts(codexHome)).parent_calls;
}

function spawnCalls(calls) {
  return calls.filter((call) => call.tool === 'spawn_agent');
}

export async function readSpawnCallsFromRollouts(codexHome) {
  return spawnCalls(await readCollaborationTimelineFromRollouts(codexHome));
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function copyCodexRuntimeFiles(
  codexHome,
  sourceHome = process.env.AW_CODEX_EVAL_RUNTIME_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), '.codex'),
  { trustedProject } = {},
) {
  for (const name of ['config.toml', 'auth.json', '.credentials.json']) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) {
      continue;
    }
    const target = path.join(codexHome, name);
    await copyFile(source, target);
    await chmod(target, 0o600);
  }
  if (trustedProject) {
    const configPath = path.join(codexHome, 'config.toml');
    const existing = await pathExists(configPath)
      ? await readFile(configPath, 'utf8')
      : '';
    const project = await realpath(trustedProject);
    const trustBlock = [
      existing.trimEnd(),
      '',
      `[projects.${JSON.stringify(project)}]`,
      'trust_level = "trusted"',
      '',
    ].join('\n');
    await writeFile(configPath, trustBlock, 'utf8');
    await chmod(configPath, 0o600);
  }
}

export function shouldStopEarly(evalCase, observed) {
  if (evalCase.wait_for_completion) {
    return null;
  }
  if (!evalCase.should_load_skill && observed.loaded) {
    return 'unexpected_skill_load';
  }
  if (!evalCase.should_spawn_agent && observed.spawned) {
    return 'unexpected_spawn';
  }
  if (evalCase.stop_after_nested_evidence) {
    const expected = evalCase.expected;
    const nested = expected?.nested_delegation;
    const rootCalls = observed.spawnCalls ?? [];
    const rootThreadIds = new Set(observed.leafTrace?.parent_thread_ids ?? []);
    const directChildren = (observed.leafTrace?.child_threads ?? []).filter((thread) =>
      thread.agent_role === expected?.arguments?.agent_type &&
      rootThreadIds.has(thread.parent_thread_id));
    const directChild = directChildren.length === 1 ? directChildren[0] : null;
    const childCalls = directChild
      ? (observed.leafToolCalls ?? []).filter((call) => call.thread_id === directChild.thread_id)
      : [];
    const childLoaded = childCalls.some((call) => {
      const command = call?.tool === 'exec_command'
        ? call.arguments?.cmd
        : call?.tool === 'exec'
          ? call.arguments?.input
          : null;
      return typeof command === 'string' &&
        command.replaceAll('\\', '/').includes(`.agents/skills/${nested?.child_skill}/SKILL.md`);
    });
    const grandchildSpawns = childCalls.filter((call) =>
      call.tool === 'spawn_agent' &&
      call.arguments?.agent_type === nested?.child_agent_type &&
      call.output &&
      typeof call.output === 'object' &&
      !Array.isArray(call.output) &&
      (
        (typeof call.output.task_name === 'string' && call.output.task_name.trim() !== '') ||
        (typeof call.output.agent_id === 'string' && call.output.agent_id.trim() !== '')
      ));
    const rootArgumentsMatch = rootCalls.length >= expected.spawn_calls.min &&
      rootCalls.length <= expected.spawn_calls.max &&
      Object.entries(expected.arguments ?? {}).every(([key, value]) =>
        value === null
          ? !Object.hasOwn(rootCalls[0]?.arguments ?? {}, key)
          : rootCalls[0]?.arguments?.[key] === value);
    const rootChildFollowups = (observed.collaborationTimeline ?? []).filter((call) =>
      ['send_input', 'send_message', 'followup_task'].includes(call?.tool));
    if (
      rootArgumentsMatch &&
      directChild &&
      childLoaded &&
      grandchildSpawns.length >= nested.grandchild_spawn_calls.min &&
      grandchildSpawns.length <= nested.grandchild_spawn_calls.max &&
      (
        nested.child_initial_message !== undefined
          ? directChild.initial_user_message === nested.child_initial_message
          : nested.child_initial_encrypted_link === true &&
            directChild.initial_encrypted_message === rootCalls[0]?.arguments?.message
      ) &&
      (!nested.forbid_root_child_followup || rootChildFollowups.length === 0) &&
      directChild.developer_context?.has_multi_agent_mode_gate ===
        nested.expect_child_multi_agent_gate &&
      directChild.developer_context?.has_codex_explore_developer_authorization ===
        nested.expect_child_developer_authorization
    ) {
      return 'expected_nested_outcome_observed';
    }
    return null;
  }
  if (
    evalCase.should_load_skill &&
    evalCase.should_spawn_agent &&
    observed.loaded &&
    observed.spawned &&
    observed.spawnCalls.length > 0
  ) {
    return 'expected_outcome_observed';
  }
  return null;
}

export async function runCodexOnce(workspace, evalCase, options) {
  const parentModelOverride = resolveParentModelOverride(evalCase, options);
  const args = buildCodexArgs(workspace, evalCase, options);
  const runtimeHome = process.env.AW_CODEX_EVAL_RUNTIME_HOME;
  const runHomeRoot = runtimeHome
    ? path.join(runtimeHome, '.eval-runs')
    : os.tmpdir();
  await mkdir(runHomeRoot, { recursive: true });
  const codexHome = await mkdtemp(path.join(runHomeRoot, 'codex-explore-home-'));
  try {
    await copyCodexRuntimeFiles(codexHome, undefined, {
      trustedProject: workspace.root,
    });
  } catch (error) {
    await rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    throw error;
  }
  const startedAt = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      const childEnv = { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' };
      delete childEnv.AW_CODEX_EVAL_RUNTIME_HOME;
      delete childEnv.AW_CODEX_EVAL_MODEL_PROVIDER;
      delete childEnv.AW_CODEX_EVAL_SENSITIVE_ENV_NAMES;
      const child = spawn(options.codexBin, args, {
        cwd: workspace.root,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const observed = {
        loaded: evalCase.explicit_skill,
        spawned: false,
        loadEvidence: evalCase.explicit_skill ? 'explicit $codex-explore mention' : null,
        spawnEvidence: null,
        spawnCalls: [],
        collaborationTimeline: [],
        leafToolCalls: [],
        leafTraceAvailable: false,
        leafTrace: null,
      };
      let stderr = '';
      let finalMessage = null;
      let usage = null;
      let settled = false;
      let rolloutPollPending = false;
      const eventTrace = [];

      const pollRollouts = async () => {
        if (rolloutPollPending) {
          return;
        }
        rolloutPollPending = true;
        try {
          const rolloutEvidence = await readRolloutEvidenceFromRollouts(codexHome);
          let calls = spawnCalls(rolloutEvidence.parent_calls);
          if (
            calls.length === 0 &&
            evalCase.codex_config?.['features.multi_agent_v2.enabled'] === false
          ) {
            calls = recoverV1SpawnCallsFromExecEvents(
              eventTrace,
              rolloutEvidence.thread_identities,
            );
          }
          if (calls.length > 0) {
            observed.spawned = true;
            observed.spawnCalls = calls;
            observed.spawnEvidence ??= `rollout:${calls[0].call_id ?? 'spawn_agent'}`;
          }
          observed.collaborationTimeline = rolloutEvidence.parent_calls;
          observed.leafToolCalls = rolloutEvidence.leaf_calls;
          observed.leafTraceAvailable = rolloutEvidence.leaf_trace_available;
          observed.leafTrace = rolloutEvidence.leaf_trace;
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            stderr = `${stderr}\nFailed to poll rollout evidence: ${
              error instanceof Error ? error.message : String(error)
            }`.trim();
          }
        } finally {
          rolloutPollPending = false;
        }
      };
      const rolloutPollTimer = setInterval(() => {
        void pollRollouts();
      }, 250);
      rolloutPollTimer.unref();

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-16_000);
      });

      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const event = parseExecEventLine(line);
        if (options.captureTrace && event) {
          eventTrace.push(event);
        }
        const evidence = inspectExecEvent(event, workspace.skillPath);
        if (evidence.loaded) {
          observed.loaded = true;
          observed.loadEvidence ??= evidence.loadEvidence;
        }
        if (evidence.spawned) {
          observed.spawned = true;
          observed.spawnEvidence ??= evidence.spawnEvidence;
        }
        const item = eventItem(event);
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          finalMessage = item.text;
        }
        if (event?.type === 'turn.completed' && event.usage) {
          usage = event.usage;
        }
      });

      child.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(rolloutPollTimer);
        lines.close();
        reject(new Error(`Failed to start ${options.codexBin}: ${error.message}`));
      });

      child.once('close', async (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(rolloutPollTimer);
        lines.close();
        try {
          const rolloutEvidence = await readRolloutEvidenceFromRollouts(codexHome);
          observed.collaborationTimeline = rolloutEvidence.parent_calls;
          observed.leafToolCalls = rolloutEvidence.leaf_calls;
          observed.leafTraceAvailable = rolloutEvidence.leaf_trace_available;
          observed.leafTrace = rolloutEvidence.leaf_trace;
          observed.spawnCalls = spawnCalls(observed.collaborationTimeline);
          if (
            observed.spawnCalls.length === 0 &&
            evalCase.codex_config?.['features.multi_agent_v2.enabled'] === false
          ) {
            observed.spawnCalls = recoverV1SpawnCallsFromExecEvents(
              eventTrace,
              rolloutEvidence.thread_identities,
            );
            observed.collaborationTimeline.push(...observed.spawnCalls);
          }
        } catch (error) {
          stderr = `${stderr}\nFailed to read rollout evidence: ${
            error instanceof Error ? error.message : String(error)
          }`.trim();
        }
        if (observed.spawnCalls.length > 0) {
          observed.spawned = true;
          observed.spawnEvidence ??=
            `rollout:${observed.spawnCalls[0].call_id ?? 'spawn_agent'}`;
        }
        const termination = 'completed';
        const executionError = exitCode !== 0;
        resolve({
          loaded: observed.loaded,
          spawned: observed.spawned,
          load_evidence: observed.loadEvidence,
          spawn_evidence: observed.spawnEvidence,
          spawn_calls: observed.spawnCalls,
          collaboration_timeline: observed.collaborationTimeline,
          leaf_tool_calls: observed.leafToolCalls,
          leaf_trace_available: observed.leafTraceAvailable,
          leaf_trace: observed.leafTrace,
          termination,
          exit_code: exitCode,
          signal,
          execution_error: executionError,
          stderr: stderr.trim() || undefined,
          final_message: finalMessage,
          parent_model_override: parentModelOverride,
          duration_ms: Date.now() - startedAt,
          usage,
          event_trace: options.captureTrace ? eventTrace : undefined,
        });
      });
    });
  } finally {
    await rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
