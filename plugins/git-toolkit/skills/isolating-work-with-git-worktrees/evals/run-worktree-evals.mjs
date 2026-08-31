import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { runCustomProcessMain } from './custom-process-protocol.mjs';

const REPOSITORY_ISOLATION_CASE = 'use_full_clone_for_repository_level_isolation';
const providerId = 'git-worktree-provider';
const providerVersion = 'manifest-v1';
const GIT_METADATA_WRITE_CASES = new Set([
  'preserve_dirty_workspace_and_use_default_path',
  'stop_when_default_root_not_ignored',
  'report_dirty_baseline',
  REPOSITORY_ISOLATION_CASE,
]);

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

const gitOptionsWithValue = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--namespace', '--super-prefix', '--work-tree',
]);

function unquoteShellToken(token) {
  if (
    token.length >= 2
    && ((token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith("'") && token.endsWith("'")))
  ) return token.slice(1, -1);
  return token;
}

function shellTokens(command) {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? []).map(unquoteShellToken);
}

function splitShellSegments(command) {
  const segments = [];
  let buffer = '';
  let quote = null;
  let escaped = false;
  const push = () => {
    if (buffer.trim()) segments.push(buffer.trim());
    buffer = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      buffer += character;
      escaped = false;
    } else if (quote) {
      buffer += character;
      if (character === '\\' && quote !== "'") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
      buffer += character;
    } else if (['&&', '||'].includes(command.slice(index, index + 2))) {
      push();
      index += 1;
    } else if (character === ';' || character === '|' || character === '\n') {
      push();
    } else {
      buffer += character;
    }
  }
  push();
  return segments;
}

function unwrapShellCommand(command) {
  const match = command.match(
    /^(?:\S*\/)?(?:bash|sh|zsh)\s+-(?:c|lc)\s+([\s\S]+)$/u,
  );
  return match ? unquoteShellToken(match[1]) : command;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function containsDirectScriptInvocation(command, executable, script) {
  const withoutWrapperPrefix = command.replace(
    /^(?:\S*\/)?(?:bash|sh|zsh)\s+-(?:c|lc)\s+['"]?/u,
    '',
  );
  const executablePattern = `(?:\\S*\\/)?${escapeRegExp(executable)}`;
  const scriptPattern = `(?:\\.?\\/)?${escapeRegExp(script)}`;
  return new RegExp(
    `(?:^|&&|\\|\\||[;|\\n({])\\s*${executablePattern}\\s+['"]?${scriptPattern}(?=['"\\s;&|)\\]}]|$)`,
    'u',
  ).test(withoutWrapperPrefix);
}

function gitInvocations(command) {
  return splitShellSegments(unwrapShellCommand(command)).flatMap((segment) => {
    const tokens = shellTokens(segment).map((token) => token
      .replace(/^[({]+/u, '')
      .replace(/[)}]+$/u, ''));
    const gitIndex = tokens.findIndex((token) => path.basename(token) === 'git');
    if (gitIndex < 0) return [];
    let index = gitIndex + 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
      if (tokens[index] === '--') {
        index += 1;
        break;
      }
      index += gitOptionsWithValue.has(tokens[index]) ? 2 : 1;
    }
    return index >= tokens.length
      ? []
      : [{ subcommand: tokens[index], args: tokens.slice(index + 1) }];
  });
}

function commandRunsScript(command, executable, script) {
  const parsedInvocation = splitShellSegments(unwrapShellCommand(command)).some((segment) => {
    const tokens = shellTokens(segment).map((token) => token
      .replace(/^[({]+/u, '')
      .replace(/[)}]+$/u, ''));
    const index = tokens.findIndex((token) => path.basename(token) === executable);
    return index >= 0 && path.basename(tokens[index + 1] ?? '') === script;
  });
  return parsedInvocation || containsDirectScriptInvocation(command, executable, script);
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

async function gitMetadataWritableArgs(repo, fixtureRoot) {
  const [root, absoluteGitDir, commonDir] = await Promise.all([
    realpath(fixtureRoot),
    git(repo, ['rev-parse', '--absolute-git-dir']),
    git(repo, ['rev-parse', '--git-common-dir']),
  ]);
  const roots = [];
  for (const candidate of [
    absoluteGitDir.stdout.trim(),
    path.isAbsolute(commonDir.stdout.trim())
      ? commonDir.stdout.trim()
      : path.resolve(repo, commonDir.stdout.trim()),
  ]) {
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Git metadata path escapes the eval fixture: ${resolved}`);
    }
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots.flatMap((rootPath) => ['--add-dir', rootPath]);
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
  return origin;
}

async function copyMaterializedSkills(repo, workspacePath) {
  await cp(path.join(workspacePath, '.agents'), path.join(repo, '.agents'), {
    recursive: true,
  });
}

export function ignoreEntriesForCase(caseId) {
  return caseId === 'stop_when_default_root_not_ignored'
    ? ['.agents/']
    : ['.agents/', '.worktrees/'];
}

async function prepareWorkspace(evalCase, workspacePath) {
  const tempRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'git-worktree-skill-eval-')),
  );
  const externalTempRoot = path.join(tempRoot, 'external-temp');
  const testMarker = '.worktree-eval-requested-test-ran';
  try {
    await mkdir(externalTempRoot, { recursive: true });
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
      await copyMaterializedSkills(repo, workspacePath);
      return {
        tempRoot, externalTempRoot, repo, primary, testMarker, caseId: evalCase.id,
      };
    }

    const repo = path.join(tempRoot, 'repo');
    let origin;
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
      origin = await addOrigin(tempRoot, repo);
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
      origin = await addOrigin(tempRoot, repo);
    }
    await git(repo, [
      'commit', '--quiet', '--allow-empty', '-m',
      'chore: keep local main ahead of origin for base verification',
    ]);
    await copyMaterializedSkills(repo, workspacePath);
    const primaryRefsBefore = (await git(repo, ['show-ref'])).stdout;
    const originRefsBefore = (await git(origin, ['show-ref'])).stdout;
    return {
      tempRoot,
      externalTempRoot,
      repo,
      primary: repo,
      origin,
      primaryRefsBefore,
      originRefsBefore,
      testMarker,
      caseId: evalCase.id,
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function runtimePrompt(evalCase) {
  if (evalCase.id === 'preserve_dirty_workspace_and_use_default_path') {
    return '当前 main 工作区有与任务无关的未提交修改。没有平台隔离，也没有项目 worktree 路径约定；候选路径 .worktrees/hotfix-login 已确认被 ignore 规则排除，不需要重新判断。请从 origin/main 创建 hotfix-login 分支，在独立工作区把 app.txt 改为 login=fixed，并运行 node test.mjs。不要 stash、reset、提交或改动当前工作区的任何内容。';
  }
  if (evalCase.id === 'stop_when_default_root_not_ignored') {
    return '当前 main 工作区有与任务无关的未提交修改。没有平台隔离和项目 worktree 路径约定，.worktrees/ 也未被忽略。请为 hotfix-blocked 准备隔离工作区。不要修改 .gitignore、创建其他目录、stash、reset 或改动当前工作区。';
  }
  if (evalCase.id === 'reuse_existing_isolation') {
    return '当前会话已经位于平台创建的 linked worktree，feature 分支和基点符合要求。请直接在这里把 feature.txt 改为 feature=done。不要创建新的 worktree。';
  }
  if (evalCase.id === REPOSITORY_ISOLATION_CASE) {
    return '这个实验会重写 refs、删除 tags 并运行 aggressive gc。请在环境变量 TMPDIR 指向的目录下创建名为 full-clone 的完全独立仓库副本；不要创建 linked worktree、修改当前仓库或 push。';
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
    pushed: commands.some((command) =>
      gitInvocations(command).some((invocation) => invocation.subcommand === 'push')),
  };
}

export function worktreePathsOutsideRoot(porcelain, root) {
  return porcelain.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((worktreePath) => {
      const relative = path.relative(root, worktreePath);
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    });
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

async function runCodex(workspace, prompt) {
  const metadataArgs = worktreeCaseAllowsGitWrites(workspace.caseId)
    ? await gitMetadataWritableArgs(workspace.repo, workspace.tempRoot)
    : [];
  const containedPrompt = `${prompt}\n\n评测安全边界：如需仓库外临时路径，只能使用环境变量 TMPDIR 指向的目录；这不是项目 worktree 路径约定。`;
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--color', 'never',
    '--sandbox', 'workspace-write', ...metadataArgs,
    '--cd', workspace.repo,
    '--model', process.env.AW_SKILL_EVAL_CODEX_MODEL ?? 'gpt-5.6-luna',
    '--config', 'approval_policy="never"',
    '--config', 'skills.include_instructions=true', containedPrompt,
  ];
  const child = spawn(process.env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex', args, {
    cwd: workspace.repo,
    env: {
      ...process.env,
      TMPDIR: workspace.externalTempRoot,
      TMP: workspace.externalTempRoot,
      TEMP: workspace.externalTempRoot,
      WORKTREE_EVAL_MARKER: workspace.testMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    ...result,
    timedOut: false,
    stdout,
    stderr,
    final_message: finalMessage(stdout),
  };
}

export function worktreeCaseAllowsGitWrites(caseId) {
  return GIT_METADATA_WRITE_CASES.has(caseId);
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
  const worktrees = await git(workspace.primary, ['worktree', 'list', '--porcelain']);
  const outsideWorktrees = worktreePathsOutsideRoot(worktrees.stdout, workspace.tempRoot);
  add(
    'worktrees_contained_in_eval_root',
    outsideWorktrees.length === 0,
    JSON.stringify(outsideWorktrees),
  );

  if (evalCase.id === REPOSITORY_ISOLATION_CASE) {
    const after = await snapshot(workspace.primary);
    add('primary_worktree_unchanged', JSON.stringify(after) === JSON.stringify(before), 'HEAD, index, status, tracked diff, untracked contents, and stash ref');
    const primaryRefsAfter = (await git(workspace.primary, ['show-ref'])).stdout;
    add(
      'primary_refs_unchanged',
      primaryRefsAfter === workspace.primaryRefsBefore,
      primaryRefsAfter,
    );
    add(
      'does_not_create_linked_worktree',
      worktrees.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length === 1,
      worktrees.stdout,
    );
    const worktreeAdds = trace.commands.filter((command) =>
      gitInvocations(command).some((invocation) =>
        invocation.subcommand === 'worktree' && invocation.args[0] === 'add'));
    add('does_not_run_worktree_add', worktreeAdds.length === 0, JSON.stringify(worktreeAdds));
    add('does_not_push', !trace.pushed, JSON.stringify(trace.commands));
    const originRefsAfter = (await git(workspace.origin, ['show-ref'])).stdout;
    add(
      'origin_refs_unchanged',
      originRefsAfter === workspace.originRefsBefore,
      originRefsAfter,
    );
    const cloneRoot = path.join(workspace.externalTempRoot, 'full-clone');
    const cloneGitDir = path.join(cloneRoot, '.git');
    add('creates_full_clone', await exists(cloneGitDir), cloneGitDir);
    if (await exists(cloneGitDir)) {
      const [absoluteGitDir, commonDir] = await Promise.all([
        git(cloneRoot, ['rev-parse', '--absolute-git-dir'], { allowFailure: true }),
        git(cloneRoot, ['rev-parse', '--git-common-dir'], { allowFailure: true }),
      ]);
      const resolvedCommonDir = commonDir.code === 0
        ? path.resolve(cloneRoot, commonDir.stdout.trim())
        : '';
      add(
        'clone_has_independent_git_metadata',
        absoluteGitDir.code === 0
          && path.resolve(absoluteGitDir.stdout.trim()) === path.resolve(cloneGitDir)
          && resolvedCommonDir === path.resolve(cloneGitDir),
        `gitDir=${absoluteGitDir.stdout.trim()} commonDir=${commonDir.stdout.trim()}`,
      );
      add(
        'clone_does_not_use_alternates',
        !(await exists(path.join(cloneGitDir, 'objects', 'info', 'alternates'))),
        path.join(cloneGitDir, 'objects', 'info', 'alternates'),
      );
    }
    return { passed: checks.every((check) => check.passed), checks };
  }

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

function usageFromEvents(stdout) {
  let usage = null;
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.usage && typeof event.usage === 'object' && !Array.isArray(event.usage)) {
        usage = event.usage;
      }
    } catch {
      // Codex JSONL can contain non-event diagnostics.
    }
  }
  return usage;
}

async function credentialValues() {
  const names = [
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
  return [...new Set(names.flatMap((name) => {
    const value = process.env[name];
    return value ? [value] : [];
  }))].sort((left, right) => right.length - left.length);
}

function redactText(value, secrets) {
  return secrets.reduce((text, secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return text
      .split(secret).join('[REDACTED]')
      .split(escaped).join('[REDACTED]');
  }, value);
}

function redactCredentialValues(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactCredentialValues(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [
        redactText(key, secrets),
        redactCredentialValues(entry, secrets),
      ]));
  }
  return value;
}

async function writeArtifacts(input, model, evaluation, secrets) {
  const reportPath = path.join(input.outputDir, 'provider-evidence.json');
  const tracePath = path.join(input.outputDir, 'codex-events.jsonl');
  const outputPath = path.join(input.outputDir, 'model-output.txt');
  const safeModel = redactCredentialValues(model, secrets);
  const safeEvaluation = redactCredentialValues(evaluation, secrets);
  await Promise.all([
    writeFile(reportPath, `${JSON.stringify({
      caseId: input.caseId,
      configuration: input.configuration,
      skillMode: input.skillMode,
      model: {
        exitCode: safeModel.code,
        signal: safeModel.signal,
        stderr: safeModel.stderr,
      },
      evaluation: safeEvaluation,
    }, null, 2)}\n`, 'utf8'),
    writeFile(tracePath, redactText(model.stdout, secrets), 'utf8'),
    writeFile(outputPath, `${redactText(model.final_message, secrets)}\n`, 'utf8'),
  ]);
  return [
    { path: path.basename(reportPath), role: 'report' },
    { path: path.basename(tracePath), role: 'trace' },
    { path: path.basename(outputPath), role: 'output' },
  ];
}

function validateCase(evalCase, caseId) {
  if (
    evalCase?.id !== caseId
    || typeof evalCase.prompt !== 'string'
    || typeof evalCase.expected_output !== 'string'
  ) throw new Error(`Worktree provider received invalid case ${caseId}.`);
}

export async function runEvalProvider(input) {
  validateCase(input.case, input.caseId);
  const secrets = await credentialValues(input);
  const workspace = await prepareWorkspace(input.case, input.workspacePath);
  try {
    const before = await snapshot(workspace.primary);
    const model = await runCodex(workspace, runtimePrompt(input.case));
    const evaluation = await evaluateCase(input.case, workspace, before, model);
    return redactCredentialValues({
      schemaVersion: 1,
      provider: { id: providerId, version: providerVersion },
      usage: usageFromEvents(model.stdout),
      grading: {
        grader: { id: 'git-worktree-mechanical', version: '1' },
        result: {
          caseId: input.caseId,
          configuration: input.configuration,
          passed: evaluation.passed,
          complete: model.code === 0,
          checks: evaluation.checks,
        },
      },
      artifacts: await writeArtifacts(input, model, evaluation, secrets),
    }, secrets);
  } finally {
    await rm(workspace.tempRoot, { recursive: true, force: true });
  }
}

await runCustomProcessMain(import.meta.url, runEvalProvider);
