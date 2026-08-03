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
import { sanityCases } from './sanity-cases.mjs';
import { trainCases } from './train-cases.mjs';
import { validationCases } from './validation-cases.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(evalDir, '..');
const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
const caseSets = {
  train: trainCases,
  validation: validationCases,
  sanity: sanityCases,
};

const DEFAULT_OPTIONS = {
  split: 'train',
  runs: 3,
  threshold: 0.5,
  timeoutMs: 180_000,
  codexBin: 'codex',
  model: undefined,
  output: undefined,
};

function usage() {
  return `Usage: node plugins/codex-explore/evals/run-trigger-evals.mjs [OPTIONS]

Runs real Codex skill-load and Gate/spawn evaluations against a temporary read-only fixture.

Options:
  --split <train|validation|sanity|all>
                                    Eval split to run (default: train)
  --runs <count>                  Repetitions per query (default: 3)
  --threshold <rate>              Pass boundary between 0 and 1 (default: 0.5)
  --timeout-ms <milliseconds>     Per-run safety timeout (default: 180000)
  --codex-bin <path>              Codex executable (default: codex)
  --model <model>                 Optional parent model override
  --output <path>                 Also write the JSON report to this path
  -h, --help                      Show this help

The runner prints progress to stderr and one JSON report to stdout. It stops positive
spawn cases as soon as both skill loading and spawn_agent are observed.`;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      options.help = true;
      continue;
    }

    const value = readOptionValue(argv, index, flag);
    index += 1;
    if (flag === '--split') {
      if (!['train', 'validation', 'sanity', 'all'].includes(value)) {
        throw new Error('--split must be train, validation, sanity, or all.');
      }
      options.split = value;
    } else if (flag === '--runs') {
      options.runs = parsePositiveInteger(value, flag);
    } else if (flag === '--threshold') {
      options.threshold = Number(value);
      if (!(options.threshold > 0 && options.threshold < 1)) {
        throw new Error('--threshold must be greater than 0 and less than 1.');
      }
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = parsePositiveInteger(value, flag);
      if (options.timeoutMs < 10_000) {
        throw new Error('--timeout-ms must be at least 10000.');
      }
    } else if (flag === '--codex-bin') {
      options.codexBin = value;
    } else if (flag === '--model') {
      options.model = value;
    } else if (flag === '--output') {
      options.output = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

function validateCase(entry, split, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${split}[${index}] must be an object.`);
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9_]+$/.test(entry.id)) {
    throw new Error(`${split}[${index}].id must use lowercase letters, digits, and underscores.`);
  }
  if (typeof entry.query !== 'string' || entry.query.trim() === '') {
    throw new Error(`${split}[${index}].query must be a non-empty string.`);
  }
  if (typeof entry.should_load_skill !== 'boolean') {
    throw new Error(`${split}[${index}].should_load_skill must be boolean.`);
  }
  if (typeof entry.should_spawn_agent !== 'boolean') {
    throw new Error(`${split}[${index}].should_spawn_agent must be boolean.`);
  }
  if (entry.should_spawn_agent && !entry.should_load_skill) {
    throw new Error(`${split}[${index}] cannot spawn without loading the skill.`);
  }

  return {
    ...entry,
    split,
    explicit_skill: entry.query.includes('$codex-explore'),
  };
}

function readCaseSet(split) {
  return caseSets[split].map((entry, index) => validateCase(entry, split, index));
}

export async function loadEvalCases(split = 'train') {
  const selectedSplits =
    split === 'all' ? ['train', 'validation', 'sanity'] : [split];
  const cases = selectedSplits.flatMap(readCaseSet);
  const ids = new Set();
  for (const entry of cases) {
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate eval id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return cases;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function renderRoleToml(roleFile) {
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

async function writeFixtureFiles(root) {
  const files = {
    'repo/gateway/checkout.ts': 'export const regionalCheckout = config.regional_checkout;\n',
    'repo/services/auth/flags.ts': 'export const riskFlag = "regional_checkout";\n',
    'repo/services/billing/checkout.ts': 'export function checkout(flag) { return queue(flag); }\n',
    'repo/services/worker/job.ts': 'export function run(job) { return job.regional_checkout; }\n',
    'repo/shared/config.ts': 'export const config = { regional_checkout: true };\n',
    'repo/shared/events.ts': 'export type AuditEvent = { request_id: string; regional_checkout: boolean };\n',
    'repo/frontend/api.ts': 'export const checkoutField = "regional_checkout";\n',
    'repo/storage/audit.ts': 'export const auditColumn = "regional_checkout";\n',
    'repo/shared/parser.ts': 'export function parse(input) { return input; }\n',
    'docs/vendor/api-v1.md': '# API v1\nTimeout: 30s. Legacy auth header.\n',
    'docs/vendor/api-v2.md': '# API v2\nTimeout: 45s. Rotating auth token.\n',
    'docs/vendor/migration.md': '# Migration\nClients must rotate tokens; timeout remains 45s.\n',
    'docs/vendor/faq.md': '# FAQ\n401 may indicate an expired legacy token.\n',
    'docs/runbooks/auth.md': '# Auth incident\nCorrelate request_id before rotating credentials.\n',
    'docs/runbooks/queue.md': '# Queue incident\nCheck producer and worker timestamps.\n',
    'docs/standards/retry.md': '# Retry\nRetry idempotent requests three times.\n',
    'docs/standards/audit.md': '# Audit\nEvery hop must preserve request_id.\n',
    'logs/app-01.log': '2026-07-01T01:00:00Z request=req-7 gateway status=401 legacy_token=true\n',
    'logs/app-02.log': '2026-07-01T01:00:01Z request=req-7 auth token_rotation=required\n',
    'logs/app-03.log': '2026-07-01T01:00:02Z request=req-7 queue published=true\n',
    'logs/app-04.log': '2026-07-01T01:00:03Z request=req-7 worker completed=false\n',
    'materials/interview-01.md': 'Renewal failed after the billing card expired.\n',
    'materials/interview-02.md': 'Renewal failed because the retry email arrived late.\n',
    'materials/meeting-01.md': 'Support attributes most failures to expired cards.\n',
    'materials/meeting-02.md': 'Finance disputes the support sample size.\n',
    'materials/summary.csv': 'source,reason\nsupport,expired card\nfinance,unknown\n',
    'reports/audit/day-01.log': 'request=req-9 component=gateway next=auth\n',
    'reports/audit/day-02.log': 'request=req-9 component=auth next=queue\n',
    'reports/audit/day-03.log': 'request=req-9 component=queue next=worker\n',
    'known/settings.ts': 'export const DEFAULT_REGION = "eu-west-1";\n',
    'known/constants.ts': 'export const DEFAULT_REGION = "eu-west-1";\nexport const RETRY_LIMIT = 3;\n',
    'known/parser-spec.md': '# Parser\nReturn the input fields without mutation.\n',
    'plugins/codex-explore/README.md': '# Explore\nA read-only evidence workflow.\n',
    'plugins/codex-explore/workflow.md': '# Gate\nDelegate only valuable, separable read-only exploration.\n',
    'changes/large-pr.diff': 'diff --git a/store.ts b/store.ts\n-deleteSafely(record)\n+deleteImmediately(record)\n',
  };

  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }));
}

export async function createEvalWorkspace({ configValues = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-eval-'));
  try {
    const plan = await renderArtifactPlan({
      event: 'install',
      platform: 'codex',
      scope: 'project',
      config: { values: configValues },
    });
    const skill = plan.artifacts.find(
      (entry) => entry.id === 'codex-explore-skill',
    );
    const roleArtifacts = plan.artifacts.filter(
      (entry) => entry.target === 'codex.agentRole',
    );
    if (
      !skill?.content?.skillFile ||
      !skill.content.openaiYaml ||
      roleArtifacts.length !== 4 ||
      roleArtifacts.some((role) => !role?.content?.roleFile)
    ) {
      throw new Error(
        'Renderer did not return the expected codex-explore skill and roles.',
      );
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const authorization = manifest.extensions?.instructions?.find(
      (entry) => entry.name === 'delegation-authorization',
    )?.content;
    if (typeof authorization !== 'string' || authorization.trim() === '') {
      throw new Error(
        'Plugin manifest is missing delegation-authorization instructions.',
      );
    }

    const skillRoot = path.join(root, '.agents', 'skills', 'codex-explore');
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const openaiPath = path.join(skillRoot, 'agents', 'openai.yaml');
    const roleRoot = path.join(root, '.codex', 'agents');
    const roles = roleArtifacts.map((role) => ({
      roleFile: role.content.roleFile,
      roleDescription: role.content.registration.description,
      rolePath: path.join(roleRoot, `${role.content.roleFile.name}.toml`),
    }));
    await Promise.all([
      mkdir(path.dirname(openaiPath), { recursive: true }),
      mkdir(roleRoot, { recursive: true }),
      writeFixtureFiles(root),
    ]);
    await Promise.all([
      writeFile(skillPath, skill.content.skillFile, 'utf8'),
      writeFile(openaiPath, skill.content.openaiYaml, 'utf8'),
      ...roles.map((role) =>
        writeFile(role.rolePath, renderRoleToml(role.roleFile), 'utf8')),
    ]);

    return {
      root,
      skillPath,
      roles,
      rolePath: roles[0].rolePath,
      roleDescription: roles[0].roleDescription,
      authorization,
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
  return typeof value === 'string' ? tomlString(value) : JSON.stringify(value);
}

export function buildCodexArgs(workspace, evalCase, options) {
  const args = [
    'exec',
    '--json',
    '--ignore-user-config',
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
    'shell_environment_policy.exclude=["CODEX_HOME"]',
    '--config',
    `developer_instructions=${tomlString(workspace.authorization)}`,
  ];
  for (const role of workspace.roles) {
    args.push(
      '--config',
      `agents.${role.roleFile.name}.description=${tomlString(role.roleDescription)}`,
      '--config',
      `agents.${role.roleFile.name}.config_file=${tomlString(role.rolePath)}`,
    );
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

function parseSpawnCallFromRolloutLine(line, rolloutFile, codexHome) {
  const event = parseExecEventLine(line);
  const payload = event?.type === 'response_item' ? event.payload : null;
  if (payload?.type !== 'function_call' || payload.name !== 'spawn_agent') {
    return null;
  }

  let args;
  try {
    args =
      typeof payload.arguments === 'string'
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
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-home-'));
  try {
    await copyCodexAuthFiles(codexHome);
  } catch (error) {
    await rm(codexHome, { recursive: true, force: true });
    throw error;
  }
  const startedAt = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(options.codexBin, args, {
        cwd: workspace.root,
        env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const observed = {
        loaded: evalCase.explicit_skill,
        spawned: false,
        loadEvidence: evalCase.explicit_skill ? 'explicit $codex-explore mention' : null,
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

export function summarizeCase(evalCase, runs, threshold) {
  const loadRate = runs.filter((run) => run.loaded).length / runs.length;
  const spawnRate = runs.filter((run) => run.spawned).length / runs.length;
  const executionErrors = runs.filter((run) => run.execution_error).length;
  const loadPassed = ratePasses(loadRate, evalCase.should_load_skill, threshold);
  const spawnPassed = ratePasses(spawnRate, evalCase.should_spawn_agent, threshold);
  return {
    id: evalCase.id,
    split: evalCase.split,
    query: evalCase.query,
    expected: {
      load_skill: evalCase.should_load_skill,
      spawn_agent: evalCase.should_spawn_agent,
    },
    observed: {
      load_rate: loadRate,
      spawn_rate: spawnRate,
      execution_errors: executionErrors,
    },
    passed: loadPassed && spawnPassed && executionErrors === 0,
    runs,
  };
}

async function run(options) {
  const cases = await loadEvalCases(options.split);
  const workspace = await createEvalWorkspace();
  const results = [];
  try {
    for (const evalCase of cases) {
      const runs = [];
      for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
        process.stderr.write(
          `[${evalCase.split}] ${evalCase.id} run ${runIndex + 1}/${options.runs}\n`,
        );
        runs.push(await runCodexOnce(workspace, evalCase, options));
      }
      results.push(summarizeCase(evalCase, runs, options.threshold));
    }
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    split: options.split,
    runs_per_case: options.runs,
    threshold: options.threshold,
    model: options.model ?? null,
    passed: results.every((result) => result.passed),
    summary: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
    },
    results,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, output, 'utf8');
  }
  process.stdout.write(output);
  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await run(options);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
