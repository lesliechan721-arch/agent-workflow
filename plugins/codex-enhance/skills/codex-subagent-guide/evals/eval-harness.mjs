import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  setupTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from './trigger-fixture.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const SKILL_KEY = 'codex-subagent-guide';
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
const GUIDE_ROLE_NAMES = [
  'codex-subagent-simple',
  'codex-subagent-general',
  'codex-subagent-complex',
  'codex-subagent-advanced',
];
export { TRIGGER_WORKSPACE_FIXTURES };
const ROOT_DEVELOPER_INSTRUCTIONS = [
  'Follow the user request and applicable skills.',
  'Use spawn_agent only when the user, project instructions, or an applicable skill has already authorized delegation.',
  'When delegation is authorized, load matching skills before choosing spawn_agent parameters.',
  'Keep answers concise. Do not modify files in this evaluation workspace.',
].join(' ');

function tomlString(value) {
  return JSON.stringify(value);
}

export async function readEvalResource(relativePath) {
  const normalized = path.normalize(relativePath);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`Eval resource must stay inside evals/: ${relativePath}`);
  }

  return readFile(path.join(evalDir, normalized), 'utf8');
}

function parseTomlString(source, key, file) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm'));
  if (!match) {
    throw new Error(`${file} is missing ${key}.`);
  }
  return JSON.parse(match[1]);
}

async function readMaterializedRoles(root) {
  const roleRoot = path.join(root, '.codex', 'agents');
  const files = (await readdir(roleRoot)).filter((file) => file.endsWith('.toml')).sort();
  const roles = await Promise.all(files.map(async (file) => {
    const rolePath = path.join(roleRoot, file);
    const source = await readFile(rolePath, 'utf8');
    const name = parseTomlString(source, 'name', file);
    return {
      roleFile: { name },
      roleDescription: parseTomlString(source, 'description', file),
      rolePath,
    };
  }));
  return GUIDE_ROLE_NAMES.map((name) => {
    const matches = roles.filter((role) => role.roleFile.name === name);
    if (matches.length !== 1) {
      throw new Error(
        `Materialized codex-subagent-guide must contain role ${name} exactly once, got ${matches.length}.`,
      );
    }
    return matches[0];
  });
}

export async function createEvalWorkspace({
  withSkill = true,
  fixture = 'default',
  sourceRoot,
} = {}) {
  if (!TRIGGER_WORKSPACE_FIXTURES.has(fixture)) {
    throw new Error(`Unsupported trigger workspace fixture: ${fixture}`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-guide-eval-'));
  try {
    if (!sourceRoot) {
      throw new Error(
        'custom provider input.workspacePath is required; use the workspace snapshot from the prepared Eval Plan.',
      );
    }
    await cp(sourceRoot, root, { recursive: true, force: true });
    const skillRoot = path.join(root, '.agents', 'skills', SKILL_KEY);
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const roles = await readMaterializedRoles(root);
    await rm(path.join(root, '.codex', 'config.toml'), { force: true });
    if (!withSkill) {
      await rm(skillRoot, { recursive: true, force: true });
    }
    await setupTriggerWorkspace({
      workspaceRoot: root,
      evalCase: { workspace_fixture: fixture },
    });
    const fixtureSkillPaths = fixture === 'authorization_skill'
      ? [path.join(root, '.agents', 'skills', 'delegation-authorizer', 'SKILL.md')]
      : fixture === 'lifecycle_skill'
        ? [path.join(root, '.agents', 'skills', 'delegation-lifecycle-owner', 'SKILL.md')]
        : [];

    return {
      root,
      skillPath,
      roles,
      withSkill,
      fixture,
      fixtureSkillPaths,
      useProjectRules: fixture === 'project_authorization',
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
    const command = item.command.replaceAll('\\', '/');
    const normalizedSkillPath = skillPath.replaceAll('\\', '/');
    if (
      command.includes(normalizedSkillPath) ||
      command.includes('.agents/skills/codex-subagent-guide/SKILL.md')
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
  return typeof value === 'string' ? tomlString(value) : JSON.stringify(value);
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

export function buildCodexArgs(workspace, evalCase, options) {
  const profile = options.profile ?? 'v2';
  if (!['v1', 'v2'].includes(profile)) {
    throw new Error(`Unsupported multi-agent profile: ${profile}`);
  }
  const args = [
    'exec',
    '--json',
  ];
  if (!workspace.useProjectRules) {
    args.push('--ignore-rules');
  }
  args.push(
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--cd',
    workspace.root,
    '--enable',
    'multi_agent',
    '--enable',
    'executed_tool_call_metadata',
    '--config',
    'skills.include_instructions=true',
    '--config',
    'suppress_unstable_features_warning=true',
    '--config',
    `shell_environment_policy.exclude=${codexConfigValue([
      'CODEX_HOME',
      ...sensitiveEnvironmentNames(options),
    ])}`,
    '--config',
    `developer_instructions=${tomlString(ROOT_DEVELOPER_INSTRUCTIONS)}`,
    '--config',
    `features.multi_agent_v2.enabled=${profile === 'v2' ? 'true' : 'false'}`,
  );
  const modelProvider = options.modelProvider ?? process.env.AW_CODEX_EVAL_MODEL_PROVIDER;
  if (modelProvider) {
    args.push('--config', `model_provider=${codexConfigValue(modelProvider)}`);
  }
  if (profile === 'v2') {
    args.push(
      '--config',
      'features.multi_agent_v2.hide_spawn_agent_metadata=true',
      '--config',
      'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
    );
  }

  const omittedRoles = new Set(evalCase.omit_roles ?? []);
  for (const role of workspace.roles) {
    if (omittedRoles.has(role.roleFile.name)) {
      continue;
    }
    args.push(
      '--config',
      `agents.${role.roleFile.name}.description=${tomlString(role.roleDescription)}`,
      '--config',
      `agents.${role.roleFile.name}.config_file=${tomlString(role.rolePath)}`,
    );
  }
  for (const [key, value] of Object.entries(evalCase.codex_config ?? {})) {
    args.push('--config', `${key}=${codexConfigValue(value)}`);
  }
  if (options.model) {
    args.push('--model', options.model);
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
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizedToolName(value) {
  if (typeof value !== 'string') return { namespace: null, tool: null };
  const separator = value.includes('__')
    ? value.indexOf('__')
    : value.includes('.')
      ? value.indexOf('.')
      : -1;
  return separator < 0
    ? { namespace: null, tool: value }
    : { namespace: value.slice(0, separator), tool: value.slice(separator + (value[separator] === '.' ? 1 : 2)) };
}

function topLevelDelimiterIndex(source, delimiter) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{' || character === '[' || character === '(') depth += 1;
    else if (character === '}' || character === ']' || character === ')') depth -= 1;
    else if (character === delimiter && depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(source, delimiter) {
  const parts = [];
  let remaining = source;
  while (remaining !== '') {
    const index = topLevelDelimiterIndex(remaining, delimiter);
    if (index < 0) {
      parts.push(remaining);
      break;
    }
    parts.push(remaining.slice(0, index));
    remaining = remaining.slice(index + 1);
  }
  return parts;
}

const INLINE_LITERAL_MAX_DEPTH = 8;

function parseInlineValue(source, depth = 0) {
  if (depth > INLINE_LITERAL_MAX_DEPTH) return { parsed: false };
  const value = source.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? { parsed: true, value: parsed } : { parsed: false };
    } catch {
      return { parsed: false };
    }
  }
  if (value === 'true') return { parsed: true, value: true };
  if (value === 'false') return { parsed: true, value: false };
  if (value === 'null') return { parsed: true, value: null };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) {
    return { parsed: true, value: Number(value) };
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const parsed = parseInlineObjectLiteral(value, depth + 1);
    return parsed === null ? { parsed: false } : { parsed: true, value: parsed };
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const parsed = parseInlineArrayLiteral(value, depth + 1);
    return parsed === null ? { parsed: false } : { parsed: true, value: parsed };
  }
  return { parsed: false };
}

function parseInlineArrayLiteral(source, depth) {
  const value = source.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const result = [];
  for (const item of splitTopLevel(value.slice(1, -1), ',')) {
    if (item.trim() === '') continue;
    const parsedItem = parseInlineValue(item, depth);
    if (!parsedItem.parsed) return null;
    result.push(parsedItem.value);
  }
  return result;
}

function parseInlineObjectLiteral(source, depth = 0) {
  const value = source.trim();
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  const result = {};
  for (const property of splitTopLevel(value.slice(1, -1), ',')) {
    if (property.trim() === '') continue;
    const colon = topLevelDelimiterIndex(property, ':');
    if (colon < 0) return null;
    const rawKey = property.slice(0, colon).trim();
    let key;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(rawKey)) {
      key = rawKey;
    } else {
      const parsedKey = parseInlineValue(rawKey, depth);
      if (!parsedKey.parsed || typeof parsedKey.value !== 'string') return null;
      key = parsedKey.value;
    }
    const parsedValue = parseInlineValue(property.slice(colon + 1), depth);
    if (!parsedValue.parsed) return null;
    result[key] = parsedValue.value;
  }
  return result;
}

function closingBraceIndex(source, openingBrace) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

export function extractExecToolCalls(source) {
  if (typeof source !== 'string') return [];
  const calls = [];
  const pattern = /tools\.([A-Za-z_$][A-Za-z0-9_$]*(?:__[A-Za-z_$][A-Za-z0-9_$]*)?)\s*\(\s*/gu;
  for (const match of source.matchAll(pattern)) {
    const normalized = normalizedToolName(match[1]);
    if (!['spawn_agent', 'wait_agent', 'close_agent'].includes(normalized.tool)) continue;
    const openingBrace = match.index + match[0].length;
    if (source[openingBrace] !== '{') continue;
    const closingBrace = closingBraceIndex(source, openingBrace);
    if (closingBrace < 0) continue;
    const argumentsValue = parseInlineObjectLiteral(source.slice(openingBrace, closingBrace + 1));
    if (!argumentsValue) continue;
    calls.push({ ...normalized, arguments: argumentsValue });
  }
  return calls;
}

export async function readSpawnCallsFromRollouts(codexHome) {
  return (await readCollaborationTimelineFromRollouts(codexHome)).filter(
    (call) => call.tool === 'spawn_agent',
  );
}

function agentMessageText(payload) {
  if (!Array.isArray(payload?.content)) return '';
  return payload.content
    .filter((item) => item?.type === 'input_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function agentUpdate(payload, rolloutFile, codexHome, lineNumber) {
  if (payload?.type !== 'agent_message') return null;
  const text = agentMessageText(payload);
  const messageType = text.match(/^Message Type:\s*(MESSAGE|FINAL_ANSWER)\s*$/mu)?.[1];
  if (!messageType) return null;
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
  const execCallsByOuterId = new Map();
  const pendingOutputs = new Map();
  for (const [index, line] of lines.entries()) {
    const event = parseExecEventLine(line);
    const payload = event?.type === 'response_item' ? event.payload : null;
    const update = agentUpdate(payload, rolloutFile, codexHome, index + 1);
    if (update) {
      calls.push(update);
      continue;
    }
    if (
      payload?.type === 'custom_tool_call' &&
      payload.name === 'exec' &&
      typeof payload.input === 'string'
    ) {
      const nestedCalls = extractExecToolCalls(payload.input).map((call, nestedIndex) => ({
        call_id: typeof payload.call_id === 'string'
          ? `${payload.call_id}:${nestedIndex}`
          : `exec:${index + 1}:${nestedIndex}`,
        namespace: call.namespace,
        tool: call.tool,
        arguments: call.arguments,
        output: null,
        rollout_file: path.relative(codexHome, rolloutFile),
        line_number: index + 1,
      }));
      calls.push(...nestedCalls);
      if (typeof payload.call_id === 'string') {
        execCallsByOuterId.set(payload.call_id, nestedCalls);
      }
    }
    if (payload?.type === 'function_call' && typeof payload.name === 'string') {
      const normalized = normalizedToolName(payload.name);
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      if (callId && callsById.has(callId)) continue;
      const parsedArguments = parseSerializedValue(payload.arguments);
      const call = {
        call_id: callId,
        namespace: typeof payload.namespace === 'string'
          ? payload.namespace
          : normalized.namespace,
        tool: normalized.tool,
        arguments:
          parsedArguments && typeof parsedArguments === 'object' && !Array.isArray(parsedArguments)
            ? parsedArguments
            : null,
        output: callId && pendingOutputs.has(callId) ? pendingOutputs.get(callId) : null,
        rollout_file: path.relative(codexHome, rolloutFile),
        line_number: index + 1,
      };
      calls.push(call);
      if (callId) callsById.set(callId, call);
      continue;
    }
    const metadata = payload?.internal_chat_message_metadata_passthrough;
    const executedCalls = Array.isArray(metadata?.executed_tool_calls)
      ? metadata.executed_tool_calls
      : [];
    for (const [nestedIndex, executedCall] of executedCalls.entries()) {
      const normalized = normalizedToolName(executedCall?.name);
      if (!normalized.tool) continue;
      const directCall = typeof payload.call_id === 'string'
        ? callsById.get(payload.call_id)
        : null;
      const execCalls = typeof payload.call_id === 'string'
        ? execCallsByOuterId.get(payload.call_id) ?? []
        : [];
      if (
        (directCall?.tool === normalized.tool &&
          (normalized.namespace === null || directCall.namespace === normalized.namespace)) ||
        execCalls.some((call) =>
          call.tool === normalized.tool &&
          (normalized.namespace === null || call.namespace === normalized.namespace))
      ) {
        continue;
      }
      calls.push({
        call_id: `executed:${index + 1}:${nestedIndex}`,
        namespace: normalized.namespace,
        tool: normalized.tool,
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
    if (payload?.type !== 'function_call_output' || typeof payload.call_id !== 'string') {
      continue;
    }
    const output = parseSerializedValue(payload.output);
    const call = callsById.get(payload.call_id);
    if (call) call.output = output;
    else pendingOutputs.set(payload.call_id, output);
  }
  return calls;
}

export async function readCollaborationTimelineFromRollouts(codexHome) {
  const files = (await listFilesRecursively(path.join(codexHome, 'sessions')))
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
  const calls = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    calls.push(...buildCollaborationTimeline(content.split('\n'), file, codexHome));
  }
  const parentRollouts = new Set(
    calls.filter((call) => call.tool === 'spawn_agent').map((call) => call.rollout_file),
  );
  return parentRollouts.size === 0
    ? calls
    : calls.filter((call) => parentRollouts.has(call.rollout_file));
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
}

export async function removeEvalDirectory(root, removeDirectory = rm) {
  await removeDirectory(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export function earlyStopReason(evalCase, observed) {
  if (evalCase.wait_for_completion) {
    return null;
  }
  if (evalCase.stop_on_spawn) {
    return observed.spawned && observed.spawnCalls.length > 0 ? 'spawn_observed' : null;
  }
  if (!evalCase.should_load_skill && observed.loaded) {
    return 'unexpected_skill_load';
  }
  if (!evalCase.should_spawn_agent && observed.spawned) {
    return 'unexpected_spawn';
  }
  if (
    evalCase.should_load_skill &&
    evalCase.should_spawn_agent &&
    observed.loaded &&
    observed.spawned
  ) {
    return 'expected_outcome_observed';
  }
  return null;
}

export function skillRequestedExplicitly(evalCase) {
  return Boolean(
    evalCase.explicit_skill || evalCase.query.includes('$codex-subagent-guide'),
  );
}

export async function runCodexOnce(workspace, evalCase, options) {
  const runtimeHome = process.env.AW_CODEX_EVAL_RUNTIME_HOME;
  const runHomeRoot = runtimeHome
    ? path.join(runtimeHome, '.eval-runs')
    : os.tmpdir();
  await mkdir(runHomeRoot, { recursive: true });
  const codexHome = await mkdtemp(path.join(runHomeRoot, 'codex-subagent-guide-home-'));
  await copyCodexRuntimeFiles(codexHome).catch(async (error) => {
    await rm(codexHome, { recursive: true, force: true });
    throw error;
  });
  const args = buildCodexArgs(workspace, evalCase, options);
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
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end();
      const requestedExplicitly = skillRequestedExplicitly(evalCase);
      const observed = {
        requestedExplicitly,
        loaded: false,
        spawned: false,
        loadEvidence: null,
        spawnEvidence: null,
        spawnCalls: [],
        collaborationTimeline: [],
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
          const calls = await readSpawnCallsFromRollouts(codexHome);
          if (calls.length > 0) {
            observed.spawned = true;
            observed.spawnCalls = calls;
            observed.spawnEvidence ??= `rollout:${calls[0].call_id ?? 'spawn_agent'}`;
          }
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
      const rolloutPollTimer = setInterval(() => void pollRollouts(), 250);
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
          observed.collaborationTimeline = await readCollaborationTimelineFromRollouts(codexHome);
          observed.spawnCalls = observed.collaborationTimeline.filter(
            (call) => call.tool === 'spawn_agent',
          );
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
          requested_explicitly: observed.requestedExplicitly,
          loaded: observed.loaded,
          spawned: observed.spawned,
          load_evidence: observed.loadEvidence,
          spawn_evidence: observed.spawnEvidence,
          spawn_calls: observed.spawnCalls,
          collaboration_timeline: observed.collaborationTimeline,
          termination,
          exit_code: exitCode,
          signal,
          execution_error: executionError,
          stderr: stderr.trim() || undefined,
          final_message: finalMessage,
          duration_ms: Date.now() - startedAt,
          usage,
          event_trace: options.captureTrace ? eventTrace : undefined,
        });
      });
    });
  } finally {
    await removeEvalDirectory(codexHome);
  }
}
