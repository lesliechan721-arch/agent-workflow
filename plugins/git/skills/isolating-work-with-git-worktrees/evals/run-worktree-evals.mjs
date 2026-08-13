import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { waitForEvalChild } from '../../../scripts/eval-child-process.mjs';
import { gitMetadataWritableArgs } from '../../../scripts/eval-git-permissions.mjs';
import {
  commandRunsScript,
  gitInvocations,
} from '../../../scripts/eval-git-trace.mjs';
import { isolateMaterializedSkills } from '../../../scripts/eval-participant-skills.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const skillKey = 'isolating-work-with-git-worktrees';
const defaults = {
  runs: 1,
  timeoutMs: 300_000,
  codexBin: 'codex',
  model: 'gpt-5.6-luna',
  caseId: undefined,
  output: undefined,
};

function usage() {
  return [
    'Usage: run-worktree-evals.mjs [options]',
    '  --runs N          Runs per current/baseline variant (default: 1)',
    '  --case ID         Run one case from evals.json',
    '  --model MODEL     Codex model (default: gpt-5.6-luna)',
    '  --codex-bin PATH  Codex executable (default: codex)',
    '  --timeout-ms MS   Timeout per model run (default: 300000)',
    '  --output PATH     Write the JSON report to PATH',
    'Exit 0 means every current run passed its mechanical checks.',
  ].join('\n');
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(argv) {
  const options = { ...defaults, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      options.help = true;
      continue;
    }
    const value = valueAfter(argv, index, flag);
    index += 1;
    if (flag === '--runs' || flag === '--timeout-ms') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive integer.`);
      }
      if (flag === '--runs') options.runs = parsed;
      else options.timeoutMs = parsed;
    } else if (flag === '--case') options.caseId = value;
    else if (flag === '--model') options.model = value;
    else if (flag === '--codex-bin') options.codexBin = value;
    else if (flag === '--output') options.output = path.resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function readEvalResource(relativePath) {
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new Error(`Eval resource must stay inside evals/: ${relativePath}`);
  }
  try {
    return await readFile(path.join(evalDir, normalized), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !process.env.AW_PLUGIN_CONTEXT) throw error;
  }
  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
  return readFile(
    path.join(context.sourceRoot, 'skills', skillKey, 'evals', normalized),
    'utf8',
  );
}

export async function loadCases(caseId) {
  const document = JSON.parse(await readEvalResource('evals.json'));
  if (document?.skill_name !== skillKey || !Array.isArray(document.evals)) {
    throw new Error(`evals.json must describe ${skillKey}.`);
  }
  const cases = caseId
    ? document.evals.filter((entry) => entry.id === caseId)
    : document.evals;
  if (cases.length === 0) throw new Error(`Unknown worktree eval case: ${caseId}`);
  return cases;
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(root, args, { allowFailure = false } = {}) {
  const result = await execFile('git', args, { cwd: root, env: isolatedGitEnv() });
  if (!allowFailure && result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function exists(target) {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if (error?.code === 'EISDIR') return true;
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function initializeRepository(repo, files, ignoreEntries) {
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '--quiet', '--initial-branch=main']);
  await git(repo, ['config', 'user.name', 'Worktree Skill Eval']);
  await git(repo, ['config', 'user.email', 'worktree-skill-eval@example.invalid']);
  await writeFile(path.join(repo, '.gitignore'), `${ignoreEntries.join('\n')}\n`, 'utf8');
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(repo, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await git(repo, ['add', '--', '.gitignore', ...Object.keys(files)]);
  await git(repo, ['commit', '--quiet', '-m', 'chore: initialize worktree eval']);
}

async function addOrigin(tempRoot, repo) {
  const origin = path.join(tempRoot, 'origin.git');
  const cloned = await execFile('git', ['clone', '--quiet', '--bare', repo, origin], {
    env: isolatedGitEnv(),
  });
  if (cloned.code !== 0) throw new Error(`git clone --bare failed: ${cloned.stderr}`);
  await git(repo, ['remote', 'add', 'origin', origin]);
  await git(repo, ['fetch', '--quiet', 'origin']);
}

async function copyMaterializedSkills(repo, withSkill) {
  const materializedRoot = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  if (!materializedRoot) {
    throw new Error('AW_PLUGIN_EVAL_PROJECT_ROOT is required; run through pnpm plugin:eval.');
  }
  await cp(path.join(materializedRoot, '.agents'), path.join(repo, '.agents'), {
    recursive: true,
  });
  await isolateMaterializedSkills(path.join(repo, '.agents'), skillKey, withSkill);
}

export function ignoreEntriesForCase(caseId) {
  return caseId === 'stop_when_default_root_not_ignored'
    ? ['.agents/']
    : ['.agents/', '.worktrees/'];
}

async function prepareWorkspace(evalCase, withSkill) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'git-worktree-skill-eval-'));
  const testMarker = '.worktree-eval-requested-test-ran';
  try {
    if (evalCase.id === 'reuse_existing_isolation') {
      const primary = path.join(tempRoot, 'primary');
      await initializeRepository(
        primary,
        { 'feature.txt': 'feature=pending\n' },
        ['.agents/'],
      );
      await git(primary, ['branch', 'feature']);
      const repo = path.join(tempRoot, 'platform-worktree');
      await git(primary, ['worktree', 'add', '--quiet', repo, 'feature']);
      await copyMaterializedSkills(repo, withSkill);
      return { tempRoot, repo, primary, testMarker, caseId: evalCase.id };
    }

    const repo = path.join(tempRoot, 'repo');
    if (
      evalCase.id === 'preserve_dirty_workspace_and_use_default_path'
      || evalCase.id === 'stop_when_default_root_not_ignored'
    ) {
      await initializeRepository(
        repo,
        {
          'app.txt': 'login=broken\n',
          'notes.txt': 'keep this local state\n',
          'test.mjs': "import assert from 'node:assert/strict';\nimport { readFile, writeFile } from 'node:fs/promises';\nif (process.env.WORKTREE_EVAL_MARKER) await writeFile(process.env.WORKTREE_EVAL_MARKER, 'ran\\n', 'utf8');\nassert.equal(await readFile('app.txt', 'utf8'), 'login=fixed\\n');\n",
        },
        ignoreEntriesForCase(evalCase.id),
      );
      await addOrigin(tempRoot, repo);
      await writeFile(path.join(repo, 'notes.txt'), 'uncommitted user notes\n', 'utf8');
      await writeFile(path.join(repo, 'scratch.txt'), 'untracked user scratch\n', 'utf8');
    } else {
      await initializeRepository(
        repo,
        {
          'app.txt': 'feature=unchanged\n',
          'test.mjs': "import { writeFile } from 'node:fs/promises';\nif (process.env.WORKTREE_EVAL_MARKER) await writeFile(process.env.WORKTREE_EVAL_MARKER, 'ran\\n', 'utf8');\nthrow new Error('pre-existing baseline failure');\n",
        },
        ignoreEntriesForCase(evalCase.id),
      );
      await addOrigin(tempRoot, repo);
    }
    await git(repo, [
      'commit', '--quiet', '--allow-empty', '-m',
      'chore: keep local main ahead of origin for base verification',
    ]);
    await copyMaterializedSkills(repo, withSkill);
    return { tempRoot, repo, primary: repo, testMarker, caseId: evalCase.id };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function runtimePrompt(evalCase) {
  if (evalCase.id === 'preserve_dirty_workspace_and_use_default_path') {
    return '当前 main 工作区有与任务无关的未提交修改。没有平台隔离，也没有项目 worktree 路径约定。请从 origin/main 创建 hotfix-login 分支，在独立工作区把 app.txt 改为 login=fixed，并运行 node test.mjs。不要 stash、reset、提交或改动当前工作区的任何内容。';
  }
  if (evalCase.id === 'stop_when_default_root_not_ignored') {
    return '当前 main 工作区有与任务无关的未提交修改。没有平台隔离和项目 worktree 路径约定，.worktrees/ 也未被忽略。请为 hotfix-blocked 准备隔离工作区。不要修改 .gitignore、创建其他目录、stash、reset 或改动当前工作区。';
  }
  if (evalCase.id === 'reuse_existing_isolation') {
    return '当前会话已经位于平台创建的 linked worktree，feature 分支和基点符合要求。请直接在这里把 feature.txt 改为 feature=done。不要创建新的 worktree。';
  }
  return '请从 origin/main 为 feature 分支建立隔离 worktree。在任何任务修改前，先运行 node test.mjs 作为基线检查。该检查失败后停止，不要修改 app.txt；报告失败属于修改前的基线状态。';
}

export async function snapshot(repo) {
  const [head, index, status, diff, untracked, stash] = await Promise.all([
    git(repo, ['rev-parse', 'HEAD']),
    git(repo, ['ls-files', '-s']),
    git(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(repo, ['diff', '--binary', 'HEAD']),
    git(repo, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(repo, ['for-each-ref', '--format=%(objectname)', 'refs/stash']),
  ]);
  const untrackedPaths = untracked.stdout.split('\0').filter(Boolean).sort();
  const untrackedContents = Object.fromEntries(
    await Promise.all(untrackedPaths.map(async (relativePath) => [
      relativePath,
      (await readFile(path.join(repo, relativePath))).toString('base64'),
    ])),
  );
  return {
    head: head.stdout,
    index: index.stdout,
    status: status.stdout,
    diff: diff.stdout,
    untracked: untrackedContents,
    stash: stash.stdout,
  };
}

function prohibitedGitCommands(commands) {
  const prohibited = [];
  for (const command of commands) {
    for (const invocation of gitInvocations(command)) {
      if (invocation.subcommand === 'reset') {
        prohibited.push({ command, reason: 'git reset' });
      } else if (
        invocation.subcommand === 'stash'
        && !['list', 'show'].includes(invocation.args[0])
      ) {
        prohibited.push({ command, reason: 'state-changing git stash' });
      } else if (
        invocation.subcommand === 'worktree'
        && worktreeUsesForce(invocation.args)
      ) {
        prohibited.push({ command, reason: 'forced git worktree operation' });
      }
    }
  }
  return prohibited;
}

function worktreeUsesForce(args) {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--force') return true;
    if (!arg.startsWith('-') || arg.startsWith('--')) continue;
    for (const option of arg.slice(1)) {
      if (option === 'f') return true;
      if (option === 'b' || option === 'B') break;
    }
  }
  return false;
}

function requestedTestCommands(commands) {
  return commands.filter((command) => commandRunsScript(command, 'node', 'test.mjs'));
}

export function inspectExecTrace(stdout) {
  const commands = [];
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (
        ['item.started', 'item.completed', 'item.updated'].includes(event.type)
        && event.item?.type === 'command_execution'
        && typeof event.item.command === 'string'
        && !seen.has(event.item.command)
      ) {
        seen.add(event.item.command);
        commands.push(event.item.command);
      }
    } catch {
      // Ignore non-event diagnostics in Codex JSONL output.
    }
  }
  return {
    commands,
    prohibited_commands: prohibitedGitCommands(commands),
    requested_test_commands: requestedTestCommands(commands),
  };
}

function finalMessage(stdout) {
  let message = '';
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        message = event.item.text ?? event.item.content ?? message;
      }
    } catch {
      // Ignore non-event diagnostics in Codex JSONL output.
    }
  }
  return typeof message === 'string' ? message : JSON.stringify(message);
}

async function runCodex(workspace, prompt, options) {
  const metadataArgs = [
    'preserve_dirty_workspace_and_use_default_path',
    'report_dirty_baseline',
  ].includes(workspace.caseId)
    ? await gitMetadataWritableArgs(workspace.repo, workspace.tempRoot)
    : [];
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--color', 'never',
    '--sandbox', 'workspace-write', ...metadataArgs,
    '--cd', workspace.repo, '--model', options.model,
    '--config', 'approval_policy="never"',
    '--config', 'skills.include_instructions=true', prompt,
  ];
  const child = spawn(options.codexBin, args, {
    cwd: workspace.repo,
    env: {
      ...process.env,
      WORKTREE_EVAL_MARKER: workspace.testMarker,
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await waitForEvalChild(child, options.timeoutMs);
  return { ...result, stdout, stderr, final_message: finalMessage(stdout) };
}

async function evaluateCase(evalCase, workspace, before, run) {
  const checks = [];
  const add = (name, passed, evidence) => checks.push({ name, passed, evidence });
  add('model_completed', !run.timedOut && run.code === 0, `code=${run.code} signal=${run.signal ?? ''}`);
  const trace = inspectExecTrace(run.stdout);
  add(
    'avoids_prohibited_git_commands',
    trace.prohibited_commands.length === 0,
    JSON.stringify(trace.prohibited_commands),
  );

  if (evalCase.id === 'reuse_existing_isolation') {
    const after = await snapshot(workspace.primary);
    add('primary_worktree_unchanged', JSON.stringify(after) === JSON.stringify(before), 'HEAD, index, status, tracked diff, untracked contents, and stash ref');
    const list = await git(workspace.primary, ['worktree', 'list', '--porcelain']);
    add('reuses_current_worktree', list.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length === 2, list.stdout);
    add('no_nested_default_worktree', !(await exists(path.join(workspace.repo, '.worktrees'))), '.worktrees absent');
    add('keeps_feature_branch', (await git(workspace.repo, ['branch', '--show-current'])).stdout.trim() === 'feature', 'feature');
    add('implements_in_existing_worktree', await readFile(path.join(workspace.repo, 'feature.txt'), 'utf8') === 'feature=done\n', 'feature.txt');
  } else {
    const after = await snapshot(workspace.primary);
    add('primary_worktree_unchanged', JSON.stringify(after) === JSON.stringify(before), 'HEAD, index, status, tracked diff, untracked contents, and stash ref');
    if (evalCase.id === 'stop_when_default_root_not_ignored') {
      const list = await git(workspace.primary, ['worktree', 'list', '--porcelain']);
      const branch = await git(workspace.primary, ['branch', '--list', 'hotfix-blocked']);
      add('does_not_create_worktree', list.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length === 1, list.stdout);
      add('does_not_create_branch', branch.stdout.trim() === '', branch.stdout);
      add(
        'reports_ignore_blocker',
        /(?:\.worktrees|gitignore)/iu.test(run.final_message)
          && /(?:未[^。\n]*忽略|not[^.\n]*ignore|阻塞|停止|不能|无法|需要确认)/iu.test(run.final_message),
        run.final_message,
      );
      return { passed: checks.every((check) => check.passed), checks };
    }
    const branchName = evalCase.id === 'preserve_dirty_workspace_and_use_default_path'
      ? 'hotfix-login'
      : 'feature';
    const linked = path.join(workspace.primary, '.worktrees', branchName);
    add('uses_default_path', await exists(linked), linked);
    if (await exists(linked)) {
      add('uses_expected_branch', (await git(linked, ['branch', '--show-current'])).stdout.trim() === branchName, branchName);
      const [linkedHead, expectedBase] = await Promise.all([
        git(linked, ['rev-parse', 'HEAD']),
        git(workspace.primary, ['rev-parse', 'refs/remotes/origin/main']),
      ]);
      add(
        'uses_expected_base',
        linkedHead.stdout.trim() === expectedBase.stdout.trim(),
        `actual=${linkedHead.stdout.trim()} expected=${expectedBase.stdout.trim()}`,
      );
      if (branchName === 'hotfix-login') {
        add('implements_only_in_linked_worktree', await readFile(path.join(linked, 'app.txt'), 'utf8') === 'login=fixed\n', 'app.txt');
        add(
          'runs_requested_test',
          await exists(path.join(linked, workspace.testMarker))
            && trace.requested_test_commands.length > 0,
          JSON.stringify(trace.requested_test_commands),
        );
        const tests = await execFile('node', ['test.mjs'], {
          cwd: linked,
          env: {
            ...process.env,
            WORKTREE_EVAL_MARKER: workspace.testMarker,
          },
        });
        add('tests_pass', tests.code === 0, tests.stderr || tests.stdout);
      } else {
        add('source_unchanged_after_baseline_failure', await readFile(path.join(linked, 'app.txt'), 'utf8') === 'feature=unchanged\n', 'app.txt');
        add(
          'runs_baseline_test',
          await exists(path.join(linked, workspace.testMarker))
            && trace.requested_test_commands.length > 0,
          JSON.stringify(trace.requested_test_commands),
        );
        add('reports_preexisting_failure', /(?:基线|修改前|pre-existing|already failing)/iu.test(run.final_message), run.final_message);
      }
    }
  }
  return { passed: checks.every((check) => check.passed), checks };
}

async function runVariant(evalCase, variant, options) {
  const runs = [];
  for (let index = 0; index < options.runs; index += 1) {
    const workspace = await prepareWorkspace(evalCase, variant === 'current');
    try {
      const before = await snapshot(workspace.primary);
      const model = await runCodex(workspace, runtimePrompt(evalCase), options);
      const evaluation = await evaluateCase(evalCase, workspace, before, model);
      runs.push({ run: index + 1, model, evaluation });
    } finally {
      await rm(workspace.tempRoot, { recursive: true, force: true });
    }
  }
  return {
    variant,
    complete: runs.every((entry) => !entry.model.timedOut && entry.model.code === 0),
    passed: runs.every((entry) => entry.evaluation.passed),
    runs,
  };
}

async function writeReport(report, output) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, text, 'utf8');
  }
  process.stdout.write(text);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const cases = await loadCases(options.caseId);
  const results = [];
  let environmentError = null;
  try {
    for (const evalCase of cases) {
      process.stderr.write(`${evalCase.id}: current and baseline\n`);
      results.push({
        id: evalCase.id,
        current: await runVariant(evalCase, 'current', options),
        baseline: await runVariant(evalCase, 'baseline', options),
      });
    }
  } catch (error) {
    environmentError = error instanceof Error ? error.stack ?? error.message : String(error);
  }
  const complete = !environmentError
    && results.length === cases.length
    && results.every((entry) => entry.current.complete && entry.baseline.complete);
  const passed = complete && results.every((entry) => entry.current.passed);
  const report = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    complete,
    passed,
    ...(environmentError ? { environment_error: environmentError } : {}),
    case_results: cases.map((evalCase) => {
      const result = results.find((entry) => entry.id === evalCase.id);
      const caseComplete = result?.current.complete === true && result?.baseline.complete === true;
      const casePassed = caseComplete && result.current.passed === true;
      return {
        id: evalCase.id,
        outcome: caseComplete ? (casePassed ? 'passed' : 'failed') : 'incomplete',
        complete: caseComplete,
        mechanical_passed: casePassed,
      };
    }),
    results,
  };
  await writeReport(report, options.output);
  if (!passed) process.exitCode = 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
