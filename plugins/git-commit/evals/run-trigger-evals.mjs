import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { trainCases, validationCases } from './trigger-cases.mjs';

const execFileAsync = promisify(execFile);
const evalDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPluginRoot = path.resolve(evalDir, '..');
const caseSets = {
  train: trainCases,
  validation: validationCases,
};
const PASSTHROUGH_ENV = new Set([
  'ALL_PROXY',
  'CODEX_API_KEY',
  'ComSpec',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'WINDIR',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

const DEFAULT_OPTIONS = {
  split: 'train',
  runs: 3,
  threshold: 0.5,
  timeoutMs: 120_000,
  codexBin: 'codex',
  model: undefined,
  output: undefined,
};

function usage() {
  return `Usage: node plugins/git-commit/evals/run-trigger-evals.mjs [OPTIONS]

Runs real Codex implicit skill-load evaluations against a temporary read-only Git repository.

Options:
  --split <train|validation|all>  Eval split to run (default: train)
  --runs <count>                  Repetitions per query (default: 3)
  --threshold <rate>              Pass boundary between 0 and 1 (default: 0.5)
  --timeout-ms <milliseconds>     Per-run safety timeout (default: 120000)
  --codex-bin <path>              Codex executable (Windows requires an absolute native .exe path)
  --model <model>                 Optional model override
  --output <path>                 Also write the JSON report to this path
  -h, --help                      Show this help

The runner uses a read-only sandbox and stops as soon as a skill load is observed.`;
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
      if (!['train', 'validation', 'all'].includes(value)) {
        throw new Error('--split must be train, validation, or all.');
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

  return {
    ...entry,
    split,
  };
}

function readCaseSet(split) {
  return caseSets[split].map((entry, index) => validateCase(entry, split, index));
}

export async function loadEvalCases(split = 'train') {
  const selectedSplits = split === 'all' ? ['train', 'validation'] : [split];
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

export function renderSkillTemplate(source, includeClaudeBlocks) {
  const rendered = source.replace(
    /{{#if claudeCommandOutputFill}}\r?\n([\s\S]*?){{\/if}}\r?\n/g,
    (_match, content) => includeClaudeBlocks ? content : '',
  );
  if (rendered.includes('{{')) {
    throw new Error('Rendered skill still contains template syntax.');
  }
  return rendered;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceCodexHome(sourceEnv) {
  if (sourceEnv.CODEX_HOME) {
    return path.resolve(sourceEnv.CODEX_HOME);
  }
  const sourceHome = sourceEnv.HOME || sourceEnv.USERPROFILE || os.homedir();
  return path.join(sourceHome, '.codex');
}

function systemCodexRoot(sourceEnv) {
  if (process.platform === 'win32') {
    return path.join(
      sourceEnv.ProgramData || String.raw`C:\ProgramData`,
      'OpenAI',
      'Codex',
    );
  }
  return '/etc/codex';
}

function buildIsolatedEnv(layout, sourceEnv) {
  const env = {};
  for (const name of PASSTHROUGH_ENV) {
    if (sourceEnv[name] !== undefined) {
      env[name] = sourceEnv[name];
    }
  }
  return {
    ...env,
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir,
    XDG_CACHE_HOME: layout.xdgCacheDir,
    XDG_CONFIG_HOME: layout.xdgConfigDir,
    XDG_STATE_HOME: layout.xdgStateDir,
    CODEX_HOME: layout.codexHome,
    TMPDIR: layout.tempDir,
    TEMP: layout.tempDir,
    TMP: layout.tempDir,
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: layout.gitConfigPath,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: layout.disabledHooksDir,
    GIT_CONFIG_KEY_1: 'commit.gpgSign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function createIsolatedLayout(sourceEnv) {
  const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), 'git-commit-trigger-eval-'));
  const layout = {
    cleanupRoot,
    root: path.join(cleanupRoot, 'repo'),
    homeDir: path.join(cleanupRoot, 'home'),
    codexHome: path.join(cleanupRoot, 'codex-home'),
    tempDir: path.join(cleanupRoot, 'tmp'),
    xdgCacheDir: path.join(cleanupRoot, 'xdg-cache'),
    xdgConfigDir: path.join(cleanupRoot, 'xdg-config'),
    xdgStateDir: path.join(cleanupRoot, 'xdg-state'),
    disabledHooksDir: path.join(cleanupRoot, 'disabled-hooks'),
    gitConfigPath: path.join(cleanupRoot, 'gitconfig'),
  };
  await Promise.all([
    mkdir(layout.root, { recursive: true }),
    mkdir(layout.homeDir, { recursive: true }),
    mkdir(layout.codexHome, { recursive: true }),
    mkdir(layout.tempDir, { recursive: true }),
    mkdir(layout.xdgCacheDir, { recursive: true }),
    mkdir(layout.xdgConfigDir, { recursive: true }),
    mkdir(layout.xdgStateDir, { recursive: true }),
    mkdir(layout.disabledHooksDir, { recursive: true }),
    writeFile(layout.gitConfigPath, '', 'utf8'),
  ]);
  const authSource = path.join(sourceCodexHome(sourceEnv), 'auth.json');
  await copyFile(authSource, path.join(layout.codexHome, 'auth.json')).catch((error) => {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  });
  return {
    ...layout,
    env: buildIsolatedEnv(layout, sourceEnv),
    systemCodexRoot: systemCodexRoot(sourceEnv),
  };
}

async function git(cwd, args, env) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
  });
}

async function createGitFixture(root, env) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.agents/\n.codex/\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# Eval repository\n', 'utf8');
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const enabled = false;\n', 'utf8');

  await git(root, ['init', '--quiet'], env);
  await git(root, ['branch', '-M', 'main'], env);
  await git(root, ['config', 'user.name', 'Skill Eval'], env);
  await git(root, ['config', 'user.email', 'skill-eval@example.invalid'], env);
  await git(root, ['add', '--', '.gitignore', 'README.md', 'src/app.ts'], env);
  await git(root, ['commit', '--quiet', '-m', 'chore: initialize eval repository'], env);

  await writeFile(
    path.join(root, 'README.md'),
    '# Eval repository\n\nStaged documentation update.\n',
    'utf8',
  );
  await git(root, ['add', '--', 'README.md'], env);
  await writeFile(
    path.join(root, 'src', 'app.ts'),
    'export const enabled = true;\n',
    'utf8',
  );
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'notes.md'), '# Untracked notes\n', 'utf8');
}

export async function createEvalWorkspace(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? defaultPluginRoot);
  const sourceEnv = options.sourceEnv ?? process.env;
  const layout = await createIsolatedLayout(sourceEnv);
  try {
    const [skillSource, openaiYaml, manifestSource] = await Promise.all([
      readFile(path.join(sourceRoot, 'skills', 'commit', 'SKILL.md'), 'utf8'),
      readFile(
        path.join(sourceRoot, 'skills', 'commit', 'agents', 'openai.yaml'),
        'utf8',
      ),
      readFile(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), 'utf8'),
    ]);
    const skill = renderSkillTemplate(skillSource, false);
    const skillRoot = path.join(layout.root, '.agents', 'skills', 'commit');
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const openaiPath = path.join(skillRoot, 'agents', 'openai.yaml');

    await createGitFixture(layout.root, layout.env);
    await mkdir(path.dirname(openaiPath), { recursive: true });
    await Promise.all([
      writeFile(skillPath, skill, 'utf8'),
      writeFile(openaiPath, openaiYaml, 'utf8'),
    ]);

    return {
      ...layout,
      skillPath,
      openaiPath,
      identity: {
        plugin_version: JSON.parse(manifestSource).version,
        skill_sha256: sha256(skill),
        corpus_sha256: sha256(JSON.stringify([...trainCases, ...validationCases])),
      },
    };
  } catch (error) {
    await rm(layout.cleanupRoot, { recursive: true, force: true });
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

function normalizedCommand(command) {
  let normalized = command.replaceAll('\\', '/').replaceAll('"', '').replaceAll("'", '');
  for (let index = 0; index < 3; index += 1) {
    normalized = normalized.replace(/(^|[\s/])\.\/(?=\S)/g, '$1');
  }
  return normalized;
}

function commandReadsSkill(command, skillPath) {
  const normalized = normalizedCommand(command);
  const normalizedSkillPath = normalizedCommand(skillPath);
  const normalizedSkillDir = path.posix.dirname(normalizedSkillPath);
  const readsFile =
    /(?:^|[\s;&|/])(?:cat|sed|head|tail|less|more|bat|awk|grep|rg|type|get-content)\b/i.test(
      normalized,
    );
  if (!readsFile) {
    return false;
  }
  if (
    normalized.includes(normalizedSkillPath) ||
    normalized.includes('.agents/skills/commit/SKILL.md')
  ) {
    return true;
  }
  return (
    (normalized.includes(normalizedSkillDir) ||
      normalized.includes('.agents/skills/commit')) &&
    /(?:^|[\s;&|/])SKILL\.md(?:$|[\s;&|])/.test(normalized)
  );
}

export function inspectExecEvent(event, skillPath) {
  if (event?.type !== 'item.completed') {
    return {};
  }
  const item = eventItem(event);
  if (
    item?.type !== 'command_execution' ||
    item.status !== 'completed' ||
    item.exit_code !== 0 ||
    typeof item.command !== 'string'
  ) {
    return {};
  }

  if (commandReadsSkill(item.command, skillPath)) {
    return {
      loaded: true,
      loadEvidence: item.command,
    };
  }
  return {};
}

export function buildCodexArgs(workspace, evalCase, options) {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--cd',
    workspace.root,
    '--config',
    'skills.include_instructions=true',
    '--config',
    'skills.bundled.enabled=false',
    '--config',
    'orchestrator.skills.enabled=false',
    '--config',
    'orchestrator.mcp.enabled=false',
    '--config',
    'include_apps_instructions=false',
    '--config',
    'include_collaboration_mode_instructions=false',
  ];
  if (options.model) {
    args.push('--model', options.model);
  }
  return args;
}

export function resolveCodexExecutable(codexBin, platform = process.platform) {
  if (platform !== 'win32') {
    return codexBin;
  }
  if (
    !codexBin.toLowerCase().endsWith('.exe') ||
    !path.win32.isAbsolute(codexBin)
  ) {
    throw new Error(
      'On Windows, --codex-bin must be an absolute path to the native codex.exe selected by the official Codex launcher.',
    );
  }
  return codexBin;
}

function spawnCodex(codexBin, args, options) {
  const executable = resolveCodexExecutable(codexBin);
  return {
    child: spawn(executable, args, options),
    executable,
  };
}

async function collectCodexCommand(workspace, codexBin, args) {
  return new Promise((resolve, reject) => {
    const { child, executable } = spawnCodex(codexBin, args, {
      cwd: workspace.root,
      env: workspace.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-64_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64_000);
    });
    child.once('error', (error) => {
      reject(new Error(`Failed to start ${executable}: ${error.message}`));
    });
    child.once('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new Error(
            `${executable} ${args.join(' ')} failed with exit code ${exitCode}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function preflightCodex(workspace, options) {
  const systemEntries = await readdir(workspace.systemCodexRoot).catch((error) => {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  if (systemEntries.length > 0) {
    throw new Error(
      `Refusing a non-hermetic trigger eval because Codex system configuration exists at ${workspace.systemCodexRoot}.`,
    );
  }
  const [{ stdout: versionStdout }, { stdout: helpStdout, stderr: helpStderr }] =
    await Promise.all([
      collectCodexCommand(workspace, options.codexBin, ['--version']),
      collectCodexCommand(workspace, options.codexBin, ['exec', '--help']),
    ]);
  const help = `${helpStdout}\n${helpStderr}`;
  for (const requiredFlag of [
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    '--strict-config',
  ]) {
    if (!help.includes(requiredFlag)) {
      throw new Error(`Codex CLI does not support required flag ${requiredFlag}.`);
    }
  }
  return {
    version: versionStdout.trim(),
    executable: resolveCodexExecutable(options.codexBin),
    system_codex_root: workspace.systemCodexRoot,
    system_codex_root_present: false,
  };
}

export async function captureGitState(workspace) {
  const commands = [
    ['rev-parse', 'HEAD'],
    ['for-each-ref', '--format=%(refname)%00%(objectname)'],
    ['config', '--local', '--null', '--list'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
    ['status', '--porcelain=v1', '--untracked-files=all'],
    ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--'],
    ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--'],
  ];
  const results = await Promise.all(
    commands.map((args) => git(workspace.root, args, workspace.env)),
  );
  const untrackedPaths = results[3].stdout.split('\0').filter(Boolean);
  const untrackedFiles = await Promise.all(
    untrackedPaths.map(async (file) => [
      file,
      sha256(await readFile(path.join(workspace.root, file))),
    ]),
  );
  return sha256(
    JSON.stringify({
      git: results.map((result) => result.stdout),
      untracked_files: untrackedFiles,
    }),
  );
}

function shouldStopEarly(evalCase, observed) {
  if (!observed.loaded) {
    return null;
  }
  return evalCase.should_load_skill
    ? 'expected_skill_load'
    : 'unexpected_skill_load';
}

export async function runCodexOnce(workspace, evalCase, options) {
  const args = buildCodexArgs(workspace, evalCase, options);
  const initialGitState = await captureGitState(workspace);
  return new Promise((resolve, reject) => {
    const { child, executable } = spawnCodex(options.codexBin, args, {
      cwd: workspace.root,
      env: workspace.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const observed = {
      loaded: false,
      loadEvidence: null,
    };
    let stderr = '';
    let finalMessage = null;
    let stopReason = null;
    let settled = false;
    let forceKillTimer;

    const stop = (reason) => {
      if (stopReason || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      stopReason = reason;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const event = parseExecEventLine(line);
      const evidence = inspectExecEvent(event, workspace.skillPath);
      if (evidence.loaded) {
        observed.loaded = true;
        observed.loadEvidence ??= evidence.loadEvidence;
      }
      const item = eventItem(event);
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        finalMessage = item.text;
      }
      const earlyReason = shouldStopEarly(evalCase, observed);
      if (earlyReason) {
        stop(earlyReason);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(evalCase.query, 'utf8');

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      lines.close();
      reject(new Error(`Failed to start ${executable}: ${error.message}`));
    });

    child.once('close', async (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      lines.close();
      const termination = stopReason ?? 'completed';
      let executionError =
        termination === 'timeout' ||
        (termination === 'completed' && exitCode !== 0);
      try {
        const finalGitState = await captureGitState(workspace);
        const fixtureUnchanged = finalGitState === initialGitState;
        executionError ||= !fixtureUnchanged;
        resolve({
          loaded: observed.loaded,
          load_evidence: observed.loadEvidence,
          termination,
          exit_code: exitCode,
          signal,
          execution_error: executionError,
          fixture_unchanged: fixtureUnchanged,
          stderr: stderr.trim() || undefined,
          final_message: finalMessage,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function ratePasses(rate, expected, threshold, split = 'train') {
  if (!expected && split === 'validation') {
    return rate === 0;
  }
  return expected ? rate > threshold : rate < threshold;
}

export function summarizeCase(evalCase, runs, threshold) {
  const loadRate = runs.filter((run) => run.loaded).length / runs.length;
  const executionErrors = runs.filter((run) => run.execution_error).length;
  return {
    id: evalCase.id,
    split: evalCase.split,
    query: evalCase.query,
    expected: {
      load_skill: evalCase.should_load_skill,
    },
    observed: {
      load_rate: loadRate,
      execution_errors: executionErrors,
    },
    passed:
      ratePasses(loadRate, evalCase.should_load_skill, threshold, evalCase.split) &&
      executionErrors === 0,
    runs,
  };
}

async function run(options) {
  const cases = await loadEvalCases(options.split);
  const workspace = await createEvalWorkspace();
  const results = [];
  let preflight;
  try {
    preflight = await preflightCodex(workspace, options);
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
    await rm(workspace.cleanupRoot, { recursive: true, force: true });
  }

  const report = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    eval_surface: 'codex_project_local_implicit_skill_discovery',
    split: options.split,
    runs_per_case: options.runs,
    threshold: options.threshold,
    model: options.model ?? 'cli-default',
    environment: {
      codex_version: preflight.version,
      codex_executable: preflight.executable,
      system_codex_root: preflight.system_codex_root,
      system_codex_root_present: preflight.system_codex_root_present,
      plugin_version: workspace.identity.plugin_version,
      skill_sha256: workspace.identity.skill_sha256,
      corpus_sha256: workspace.identity.corpus_sha256,
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
      },
      isolation: {
        user_config_ignored: true,
        user_and_project_rules_ignored: true,
        bundled_skills_disabled: true,
        orchestrator_skills_and_mcp_disabled: true,
        system_cloud_and_managed_layers_disabled: false,
      },
    },
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
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
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
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
