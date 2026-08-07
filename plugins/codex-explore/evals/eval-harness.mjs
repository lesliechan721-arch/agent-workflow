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
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { setupTriggerWorkspace } from './trigger-fixture.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const collaborationToolNames = new Set([
  'spawn_agent',
  'wait_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'close_agent',
]);
export async function readEvalResource(relativePath) {
  const normalized = path.normalize(relativePath);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`Eval resource must stay inside evals/: ${relativePath}`);
  }
  const localPath = path.join(evalDir, normalized);
  try {
    return await readFile(localPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !process.env.AW_PLUGIN_CONTEXT) {
      throw error;
    }
  }

  const context = JSON.parse(
    await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'),
  );
  if (typeof context.sourceRoot !== 'string' || context.sourceRoot.trim() === '') {
    throw new Error(`Eval resource is missing from bundle: ${relativePath}`);
  }
  return readFile(path.join(context.sourceRoot, 'evals', normalized), 'utf8');
}
export async function createEvalWorkspace({ configValues = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-eval-'));
  try {
    const materializedProjectRoot = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
    if (!materializedProjectRoot) {
      throw new Error(
        'AW_PLUGIN_EVAL_PROJECT_ROOT is required; run this suite through pnpm plugin:eval.',
      );
    }
    if (Object.keys(configValues).length > 0) {
      throw new Error('Specialized eval config must be represented by a materialized profile.');
    }
    await cp(materializedProjectRoot, root, { recursive: true, force: true });
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
    '--config',
    `skills.include_instructions=true`,
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
    const payload = event?.type === 'response_item' ? event.payload : null;
    const update = agentUpdate(payload, rolloutFile, codexHome, index + 1);
    if (update) {
      calls.push(update);
      continue;
    }
    if (payload?.type === 'function_call' && collaborationToolNames.has(payload.name)) {
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

    if (payload?.type !== 'function_call_output' || typeof payload.call_id !== 'string') {
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
    calls
      .filter((call) => call.tool === 'spawn_agent')
      .map((call) => call.rollout_file),
  );
  if (parentRollouts.size === 0) {
    return calls;
  }
  return calls.filter((call) => parentRollouts.has(call.rollout_file));
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

function shouldStopEarly(evalCase, observed) {
  if (evalCase.wait_for_completion) {
    return null;
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

export async function runCodexOnce(workspace, evalCase, options) {
  const args = buildCodexArgs(workspace, evalCase, options);
  const runtimeHome = process.env.AW_CODEX_EVAL_RUNTIME_HOME;
  const runHomeRoot = runtimeHome
    ? path.join(runtimeHome, '.eval-runs')
    : os.tmpdir();
  await mkdir(runHomeRoot, { recursive: true });
  const codexHome = await mkdtemp(path.join(runHomeRoot, 'codex-explore-home-'));
  try {
    await copyCodexRuntimeFiles(codexHome);
  } catch (error) {
    await rm(codexHome, { recursive: true, force: true });
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
      };
      let stderr = '';
      let finalMessage = null;
      let usage = null;
      let stopReason = null;
      let interruptedSignal = null;
      let settled = false;
      let forceKillTimer;
      let rolloutPollPending = false;
      const eventTrace = [];

      const stop = (reason) => {
        if (stopReason || child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        stopReason = reason;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        forceKillTimer.unref();
      };
      const handleInterrupt = (signal) => {
        interruptedSignal = signal;
        stop(`parent_${signal.toLowerCase()}`);
      };
      const handleSigint = () => handleInterrupt('SIGINT');
      const handleSigterm = () => handleInterrupt('SIGTERM');
      const removeInterruptHandlers = () => {
        process.off('SIGINT', handleSigint);
        process.off('SIGTERM', handleSigterm);
      };
      process.once('SIGINT', handleSigint);
      process.once('SIGTERM', handleSigterm);

      const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
      timeout.unref();

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
            const earlyReason = shouldStopEarly(evalCase, observed);
            if (earlyReason) {
              stop(earlyReason);
            }
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
        const earlyReason = shouldStopEarly(evalCase, observed);
        if (earlyReason) {
          stop(earlyReason);
        }
      });

      child.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimer);
        clearInterval(rolloutPollTimer);
        removeInterruptHandlers();
        lines.close();
        reject(new Error(`Failed to start ${options.codexBin}: ${error.message}`));
      });

      child.once('close', async (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimer);
        clearInterval(rolloutPollTimer);
        removeInterruptHandlers();
        lines.close();
        try {
          observed.collaborationTimeline =
            await readCollaborationTimelineFromRollouts(codexHome);
          observed.spawnCalls = spawnCalls(observed.collaborationTimeline);
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
        if (interruptedSignal) {
          reject(new Error(`Interrupted by ${interruptedSignal}.`));
          return;
        }
        const termination = stopReason ?? 'completed';
        const executionError =
          termination === 'timeout' ||
          (termination === 'completed' && exitCode !== 0);
        resolve({
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
    await rm(codexHome, { recursive: true, force: true });
  }
}
