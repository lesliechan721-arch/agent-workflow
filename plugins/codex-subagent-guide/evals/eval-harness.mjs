import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
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

import { renderArtifactPlan } from '../scripts/render-artifacts.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const SKILL_KEY = 'codex-subagent-guide';
const ROOT_DEVELOPER_INSTRUCTIONS = [
  'Follow the user request and applicable skills.',
  'Use spawn_agent only when the user, project instructions, or an applicable skill has already authorized delegation.',
  'When delegation is authorized, load matching skills before choosing spawn_agent parameters.',
  'Keep answers concise. Do not modify files in this evaluation workspace.',
].join(' ');

function tomlString(value) {
  return JSON.stringify(value);
}

export function renderRoleToml(roleFile) {
  const lines = [
    `name = ${tomlString(roleFile.name)}`,
    `description = ${tomlString(roleFile.description)}`,
    `developer_instructions = ${tomlString(roleFile.developer_instructions)}`,
  ];
  if (typeof roleFile.model === 'string' && roleFile.model.trim() !== '') {
    lines.push(`model = ${tomlString(roleFile.model)}`);
  }
  if (
    typeof roleFile.model_reasoning_effort === 'string' &&
    roleFile.model_reasoning_effort.trim() !== ''
  ) {
    lines.push(
      `model_reasoning_effort = ${tomlString(roleFile.model_reasoning_effort)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
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

  try {
    return await readFile(path.join(evalDir, normalized), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !process.env.AW_PLUGIN_CONTEXT) {
      throw error;
    }
  }

  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
  if (typeof context.sourceRoot !== 'string' || context.sourceRoot.trim() === '') {
    throw new Error(`Eval resource is missing from bundle: ${relativePath}`);
  }
  return readFile(path.join(context.sourceRoot, 'evals', normalized), 'utf8');
}

async function writeFixtureFiles(root) {
  const files = {
    'src/simple.ts': 'export const retryLimit = 3;\n',
    'src/general.ts': 'export function formatResult(value) { return String(value); }\n',
    'src/complex/a.ts': 'export async function acquire(lock) { return lock.acquire(); }\n',
    'src/complex/b.ts': 'export async function release(lock) { return lock.release(); }\n',
    'docs/architecture.md': '# Architecture\nRequests flow through gateway, queue, and worker.\n',
    'changes/review.diff': 'diff --git a/src/simple.ts b/src/simple.ts\n-export const retryLimit = 3;\n+export const retryLimit = -1;\n',
  };
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }));
}

export async function createEvalWorkspace({ withSkill = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-guide-eval-'));
  try {
    const plan = await renderArtifactPlan({
      event: 'install',
      platform: 'codex',
      scope: 'project',
      config: { values: {} },
    });
    const skill = plan.artifacts.find(
      (entry) => entry.id === 'codex-subagent-guide-skill',
    );
    const roleArtifacts = plan.artifacts.filter(
      (entry) => entry.target === 'codex.agentRole',
    );
    if (
      !skill?.content?.skillFile ||
      !skill.content.openaiYaml ||
      roleArtifacts.length !== 4 ||
      roleArtifacts.some(
        (role) =>
          !role?.content?.roleFile?.developer_instructions ||
          !role?.content?.registration?.description,
      )
    ) {
      throw new Error(
        'Renderer did not return the expected codex-subagent-guide skill and roles.',
      );
    }

    const skillRoot = path.join(root, '.agents', 'skills', SKILL_KEY);
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const metadataPath = path.join(skillRoot, 'agents', 'openai.yaml');
    const roleRoot = path.join(root, '.codex', 'agents');
    const roles = roleArtifacts.map((role) => ({
      roleFile: role.content.roleFile,
      roleDescription: role.content.registration.description,
      rolePath: path.join(roleRoot, `${role.content.roleFile.name}.toml`),
    }));

    await Promise.all([
      mkdir(roleRoot, { recursive: true }),
      writeFixtureFiles(root),
      ...(withSkill ? [mkdir(path.dirname(metadataPath), { recursive: true })] : []),
    ]);
    await Promise.all([
      ...roles.map((role) =>
        writeFile(role.rolePath, renderRoleToml(role.roleFile), 'utf8')),
      ...(withSkill
        ? [
            writeFile(skillPath, skill.content.skillFile, 'utf8'),
            writeFile(metadataPath, skill.content.openaiYaml, 'utf8'),
          ]
        : []),
    ]);

    return { root, skillPath, roles, withSkill };
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

export function buildCodexArgs(workspace, evalCase, options) {
  const profile = options.profile ?? 'v2';
  if (!['v1', 'v2'].includes(profile)) {
    throw new Error(`Unsupported multi-agent profile: ${profile}`);
  }
  const args = [
    'exec',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--cd',
    workspace.root,
    '--enable',
    'multi_agent',
    '--config',
    'skills.include_instructions=true',
    '--config',
    'shell_environment_policy.exclude=["CODEX_HOME"]',
    '--config',
    `developer_instructions=${tomlString(ROOT_DEVELOPER_INSTRUCTIONS)}`,
    '--config',
    `features.multi_agent_v2.enabled=${profile === 'v2' ? 'true' : 'false'}`,
  ];
  if (profile === 'v2') {
    args.push(
      '--config',
      'features.multi_agent_v2.hide_spawn_agent_metadata=false',
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

function parseSpawnCallFromRolloutLine(line, rolloutFile, codexHome) {
  const event = parseExecEventLine(line);
  const payload = event?.type === 'response_item' ? event.payload : null;
  if (payload?.type !== 'function_call' || payload.name !== 'spawn_agent') {
    return null;
  }

  let args;
  try {
    args = typeof payload.arguments === 'string'
      ? JSON.parse(payload.arguments)
      : payload.arguments;
  } catch {
    args = null;
  }
  return {
    call_id: typeof payload.call_id === 'string' ? payload.call_id : null,
    namespace: typeof payload.namespace === 'string' ? payload.namespace : null,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : null,
    rollout_file: path.relative(codexHome, rolloutFile),
  };
}

export async function readSpawnCallsFromRollouts(codexHome) {
  const files = (await listFilesRecursively(path.join(codexHome, 'sessions')))
    .filter((file) => file.endsWith('.jsonl'));
  const calls = [];
  const seen = new Set();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const line of content.split('\n')) {
      const call = parseSpawnCallFromRolloutLine(line, file, codexHome);
      if (!call) {
        continue;
      }
      const identity = call.call_id ?? `${call.rollout_file}:${calls.length}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        calls.push(call);
      }
    }
  }
  return calls;
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function copyCodexAuthFiles(
  codexHome,
  sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
) {
  for (const name of ['auth.json', '.credentials.json']) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) {
      continue;
    }
    const target = path.join(codexHome, name);
    await copyFile(source, target);
    await chmod(target, 0o600);
  }
}

function earlyStopReason(evalCase, observed) {
  if (evalCase.wait_for_completion) {
    return null;
  }
  if (evalCase.stop_on_spawn) {
    return observed.spawnCalls.length > 0 ? 'spawn_observed' : null;
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
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-guide-home-'));
  await copyCodexAuthFiles(codexHome).catch(async (error) => {
    await rm(codexHome, { recursive: true, force: true });
    throw error;
  });
  const args = buildCodexArgs(workspace, evalCase, options);
  const startedAt = Date.now();

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(options.codexBin, args, {
        cwd: workspace.root,
        env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end();
      const explicitSkill =
        workspace.withSkill && evalCase.query.includes('$codex-subagent-guide');
      const observed = {
        loaded: explicitSkill,
        spawned: false,
        loadEvidence: explicitSkill ? 'explicit $codex-subagent-guide mention' : null,
        spawnEvidence: null,
        spawnCalls: [],
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
            const reason = earlyStopReason(evalCase, observed);
            if (reason) {
              stop(reason);
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
        const reason = earlyStopReason(evalCase, observed);
        if (reason) {
          stop(reason);
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
          observed.spawnCalls = await readSpawnCallsFromRollouts(codexHome);
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

export function ratePasses(rate, expected, threshold) {
  return expected ? rate > threshold : rate < threshold;
}

export function executionErrorEvidence(run) {
  const eventErrors = (run.event_trace ?? []).flatMap((event) => {
    if (event?.type === 'error' && typeof event.message === 'string') {
      return [event.message];
    }
    if (event?.item?.type === 'error' && typeof event.item.message === 'string') {
      return [event.item.message];
    }
    if (event?.type === 'turn.failed' && typeof event.error?.message === 'string') {
      return [event.error.message];
    }
    return [];
  });
  return JSON.stringify({
    stderr: run.stderr ?? null,
    error_events: eventErrors,
  });
}

export async function writeJsonReport(report, outputPath) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, 'utf8');
  }
  process.stdout.write(output);
}
