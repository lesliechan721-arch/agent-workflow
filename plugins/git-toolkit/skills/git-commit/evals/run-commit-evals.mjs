import { spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { runCustomProcessMain } from './custom-process-protocol.mjs';

const providerId = 'git-commit-provider';
const providerVersion = 'manifest-v1';

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

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return {
    ...env,
    LANG: 'C',
    LC_ALL: 'C',
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

async function snapshot(root) {
  const [head, refs, index, status, diff, cachedDiff] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['show-ref']),
    git(root, ['ls-files', '-s']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(root, ['diff', '--binary', 'HEAD']),
    git(root, ['diff', '--cached', '--binary']),
  ]);
  return {
    head: head.stdout,
    refs: refs.stdout,
    index: index.stdout,
    status: status.stdout,
    diff: diff.stdout,
    cached_diff: cachedDiff.stdout,
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

export function inspectCommitExecTrace(stdout) {
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
  const invocations = commands.flatMap(gitInvocations);
  return {
    commands,
    pushed: invocations.some((invocation) => invocation.subcommand === 'push'),
    bypassed_hooks: commands.some((command) => /--no-verify\b/u.test(command)),
    reset_index: invocations.some((invocation) => invocation.subcommand === 'reset'),
  };
}

async function initializeRepository(repo) {
  await Promise.all([
    mkdir(path.join(repo, 'src'), { recursive: true }),
    mkdir(path.join(repo, 'tests'), { recursive: true }),
    mkdir(path.join(repo, 'docs'), { recursive: true }),
  ]);
  const files = {
    '.gitignore': '.agents/\n.codex/\n.agent-workflows/\n',
    'README.md': '# Commit eval repository\n\nCorrect spelling.\n',
    'src/app.js': 'export const enabled = false;\n',
    'tests/app.test.js': 'export const expected = false;\n',
    'docs/guide.md': '# Guide\n\nFeature disabled.\n',
    VERSION: '1.0.0\n',
    'partial.txt': 'stage=base\nwork=base\n',
    'requested-a.txt': 'a=before\n',
    'requested-b.txt': 'b=before\n',
    'unrelated.txt': 'unrelated=before\n',
    'conflict.txt': 'mode=base\n',
  };
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(path.join(repo, relativePath), content, 'utf8');
  }
  await git(repo, ['init', '--quiet']);
  await git(repo, ['branch', '-M', 'main']);
  await git(repo, ['config', 'user.name', 'Commit Skill Eval']);
  await git(repo, ['config', 'user.email', 'commit-skill-eval@example.invalid']);
  await git(repo, ['config', 'commit.gpgSign', 'false']);
  await git(repo, ['add', '--', ...Object.keys(files)]);
  await git(repo, ['commit', '--quiet', '-m', 'chore: initialize commit fixture']);
}

async function setupFixture(evalCase, repo, root) {
  const expected = {};
  if (evalCase.id === 'detailed_body_for_nontrivial_change') {
    await writeFile(path.join(repo, 'src/app.js'), 'export const enabled = true;\n', 'utf8');
    await writeFile(path.join(repo, 'tests/app.test.js'), 'export const expected = true;\n', 'utf8');
    await writeFile(path.join(repo, 'docs/guide.md'), '# Guide\n\nFeature enabled.\n', 'utf8');
    await writeFile(path.join(repo, 'VERSION'), '1.1.0\n', 'utf8');
    expected.paths = ['VERSION', 'docs/guide.md', 'src/app.js', 'tests/app.test.js'];
  } else if (evalCase.id === 'trivial_change_may_omit_body') {
    await writeFile(
      path.join(repo, 'README.md'),
      '# Commit eval repository\n\nCorrected spelling.\n',
      'utf8',
    );
    expected.paths = ['README.md'];
  } else if (evalCase.id === 'staged_only_with_unstaged_hunks') {
    await writeFile(path.join(repo, 'partial.txt'), 'stage=selected\nwork=base\n', 'utf8');
    await git(repo, ['add', '--', 'partial.txt']);
    expected.stagedContent = (await git(repo, ['show', ':partial.txt'])).stdout;
    await writeFile(
      path.join(repo, 'partial.txt'),
      'stage=selected\nwork=uncommitted\n',
      'utf8',
    );
    expected.paths = ['partial.txt'];
  } else if (evalCase.id === 'unrelated_staged_content') {
    await writeFile(path.join(repo, 'unrelated.txt'), 'unrelated=staged\n', 'utf8');
    await git(repo, ['add', '--', 'unrelated.txt']);
    await writeFile(path.join(repo, 'requested-a.txt'), 'a=requested\n', 'utf8');
    await writeFile(path.join(repo, 'requested-b.txt'), 'b=requested\n', 'utf8');
    expected.paths = ['requested-a.txt', 'requested-b.txt'];
  } else if (evalCase.id === 'repository_message_convention') {
    await writeFile(
      path.join(repo, 'AGENTS.md'),
      '# Commit convention\n\nCommit subject 必须使用 `[docs] <中文摘要>`，不要使用 Conventional Commit。\n',
      'utf8',
    );
    await git(repo, ['add', '--', 'AGENTS.md']);
    await git(repo, ['commit', '--quiet', '-m', 'docs: add repository convention']);
    await writeFile(path.join(repo, 'docs/guide.md'), '# Guide\n\nUpdated installation notes.\n', 'utf8');
    expected.paths = ['docs/guide.md'];
  } else if (evalCase.id === 'commit_and_push_composition') {
    const origin = path.join(root, 'origin.git');
    const cloned = await execFile('git', ['clone', '--quiet', '--bare', repo, origin], {
      env: isolatedGitEnv(),
    });
    if (cloned.code !== 0) throw new Error(`git clone --bare failed: ${cloned.stderr}`);
    await git(repo, ['remote', 'add', 'origin', origin]);
    expected.remoteBefore = (await git(repo, ['ls-remote', 'origin', 'refs/heads/main'])).stdout;
    await writeFile(path.join(repo, 'src/app.js'), 'export const enabled = true;\n', 'utf8');
    expected.paths = ['src/app.js'];
  } else if (evalCase.id === 'conflict_or_operation_in_progress') {
    await git(repo, ['switch', '--quiet', '-c', 'feature']);
    await writeFile(path.join(repo, 'conflict.txt'), 'mode=feature\n', 'utf8');
    await git(repo, ['add', '--', 'conflict.txt']);
    await git(repo, ['commit', '--quiet', '-m', 'feat: change conflict mode']);
    await git(repo, ['switch', '--quiet', 'main']);
    await writeFile(path.join(repo, 'conflict.txt'), 'mode=main\n', 'utf8');
    await git(repo, ['add', '--', 'conflict.txt']);
    await git(repo, ['commit', '--quiet', '-m', 'fix: change conflict mode']);
    const merged = await git(repo, ['merge', 'feature'], { allowFailure: true });
    if (merged.code === 0) throw new Error('Conflict fixture did not produce a conflict.');
  } else if (evalCase.id === 'hook_rejection') {
    await writeFile(path.join(repo, 'src/app.js'), 'export const enabled = true;\n', 'utf8');
    await git(repo, ['add', '--', 'src/app.js']);
    expected.hookSentinel = path.join(repo, '.git', 'hook-ran');
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hook,
      '#!/bin/sh\nprintf "ran\\n" > .git/hook-ran\nprintf "blocked by eval hook\\n" >&2\nexit 1\n',
      'utf8',
    );
    await chmod(hook, 0o755);
  } else {
    throw new Error(`Unsupported commit eval case: ${evalCase.id}`);
  }
  return expected;
}

async function prepareWorkspace(evalCase, workspacePath) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-commit-skill-eval-'));
  const repo = path.join(root, 'repo');
  try {
    await mkdir(repo);
    await initializeRepository(repo);
    const expected = await setupFixture(evalCase, repo, root);
    await cp(path.join(workspacePath, '.agents'), path.join(repo, '.agents'), { recursive: true });
    return { root, repo, expected };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runCodex(workspace, prompt) {
  const metadataArgs = await gitMetadataWritableArgs(workspace.repo, workspace.root);
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--color', 'never',
    '--sandbox', 'workspace-write', ...metadataArgs,
    '--cd', workspace.repo,
    '--model', process.env.AW_SKILL_EVAL_CODEX_MODEL ?? 'gpt-5.6-luna',
    '--config', 'approval_policy="never"',
    '--config', 'skills.include_instructions=true', prompt,
  ];
  const child = spawn(process.env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex', args, {
    cwd: workspace.repo,
    env: isolatedGitEnv(),
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

async function headCommitInfo(repo, beforeHead) {
  const [count, parents, message, paths, controls] = await Promise.all([
    git(repo, ['rev-list', '--count', `${beforeHead}..HEAD`]),
    git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']),
    git(repo, ['log', '-1', '--format=%B']),
    git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']),
    git(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.agents']),
  ]);
  const parentCount = parents.stdout.trim().split(/\s+/u).length - 1;
  return {
    count: Number(count.stdout.trim()),
    parent_count: parentCount,
    message: message.stdout,
    paths: paths.stdout.trim().split('\n').filter(Boolean).sort(),
    control_paths: controls.stdout.trim().split('\n').filter(Boolean),
  };
}

function bulletLines(message) {
  return message.split('\n').slice(1).filter((line) => /^\s*[-*]\s+\S/u.test(line));
}

function messageContainsUnverifiableClaim(message) {
  return /(?:issue|ticket|jira|用户反馈|客户反馈|生产事故|线上事故|性能提升|性能提高|安全性提升|安全性提高|performance|security|解决.{0,12}(?:事故|投诉|反馈)|fix(?:es|ed)?\s+#\d+)/iu.test(message);
}

function detailedBodyFactCoverage(message) {
  const bullets = bulletLines(message);
  const unsupportedFixtureClaim = /(?:database|schema|cache|queue|API|dependency|数据库|数据表|缓存|队列|接口|依赖)/iu;
  const runtimeAction = /(?:启用|激活|开启|已启用|enable(?:d)?|activate(?:d)?|false.{0,20}true)/iu;
  const explicitRuntime = /(?:运行时|开关|\bapp(?:\.js)?\b|runtime|flag|应用功能(?:状态|开关)|功能(?:状态|开关))/iu;
  const genericRuntime = /(?:启用|激活|开启|enable|activate).{0,20}(?:应用|功能|application|feature)/iu;
  const genericRuntimeOnlyInDocs = /(?:(?:应用|功能|application|feature)(?:(?!\b(?:and|then|document|update)\b|并|同时|以及|记录|更新).){0,20}(?:in|within|for)\s+(?:the\s+)?(?:文档|指南|说明|docs?|guide|documentation)|(?:(?:在|于).{0,8}(?:文档|指南|说明)|(?:文档|指南|说明)(?:中|内|里)).{0,20}(?:应用|功能|application|feature))/iu;
  const factMatchers = new Map([
    ['runtime', (line) =>
      (explicitRuntime.test(line) && runtimeAction.test(line))
        || (genericRuntime.test(line) && !genericRuntimeOnlyInDocs.test(line))],
    ['verification', (line) => /(?=.*(?:测试|预期|期望|test|expect))(?=.*(?:同步|对齐|调整|更新|改为|设为|切换|启用状态|sync|align|adjust|update|set|switch|enabled?|true))/iu.test(line)],
    ['docs', (line) => /(?=.*(?:文档|指南|说明|docs?|guide|documentation))(?=.*(?:启用|激活|开启|已启用|enable(?:d)?|activate(?:d)?))/iu.test(line)],
    ['version', (line) => /\b1\.0\.0\b.*\b1\.1\.0\b|\b1\.1\.0\b.*\b1\.0\.0\b/u.test(line)],
  ]);
  const matchedFacts = bullets.map((line) => [...factMatchers]
    .filter(([, matches]) => matches(line))
    .map(([name]) => name));
  return {
    bullets,
    covered: new Set(matchedFacts.flat()),
    groupsRelatedFacts: matchedFacts.some((facts) => facts.length >= 2),
    allGrounded: bullets.length >= 2
      && bullets.length <= 4
      && bullets.every((line, index) =>
        !unsupportedFixtureClaim.test(line) && matchedFacts[index].length > 0),
  };
}

export function partialMessageExcludesUnstagedFact(message) {
  const text = typeof message === 'string' ? message : '';
  return !/(?:uncommitted|unstaged|working tree|worktree|未暂存|工作树|\bwork\s*=|\bwork\b.{0,24}(?:value|pending|local|setting|update|change)|(?:pending|local).{0,16}\bwork\b)/iu.test(text);
}

export function declaredAssertionCoverage(evalCase, checks) {
  const available = new Set(checks.map((check) => check.name));
  const declared = evalCase.assertions.map((assertion) => assertion.grader_check);
  const missing = declared.filter((name) => !available.has(name));
  return {
    name: 'declared_assertions_graded',
    passed: missing.length === 0,
    evidence: JSON.stringify({ declared, available: [...available], missing }),
  };
}

function evaluationResult(evalCase, checks, details) {
  const finalChecks = [...checks, declaredAssertionCoverage(evalCase, checks)];
  return {
    ...details,
    passed: finalChecks.every((check) => check.passed),
    checks: finalChecks,
  };
}

export function hookFailureMessageChecks(message, expectedHead = '') {
  const text = typeof message === 'string' ? message : '';
  const normalizedExpectedHead = typeof expectedHead === 'string' ? expectedHead.trim() : '';
  const expectedHeadPrefix = normalizedExpectedHead.slice(0, 7);
  const reportsFailure = /(?:hook|pre-commit|拒绝|失败|blocked|未(?:创建|提交)|没有(?:创建|提交)|no commit)/iu.test(text);
  const textWithoutExplicitFailure = text.replace(
    /(?:no (?:new )?commit (?:was )?created|commit was not created|did not create (?:a )?commit|未创建(?:新的?)?(?:\s*commit|提交)?|没有(?:创建|产生)(?:新的?)?(?:\s*commit|提交)?)/giu,
    '',
  );
  const claimsSuccess = /(?:commit|提交)\s*(?:已|已经)?\s*(?:成功|完成)|(?:已|已经|成功)(?:创建|完成|提交)(?:了)?(?:本地)?(?:\s*commit)?|commit\s+(?:was\s+)?(?:created|succeeded|completed successfully)/iu.test(textWithoutExplicitFailure);
  const expectedHeadCandidates = /^[0-9a-f]{7,64}$/iu.test(normalizedExpectedHead)
    ? [normalizedExpectedHead, expectedHeadPrefix]
    : [];
  const reportsExpectedHead = expectedHeadCandidates.some((candidate) =>
    new RegExp(`(?:HEAD|提交头)[^\\n]{0,48}${candidate}(?![0-9a-f])`, 'iu').test(text));
  const reportsUnchangedHead = (
    normalizedExpectedHead.length > 0
      ? reportsExpectedHead
      : /(?:HEAD|提交头).{0,24}(?:未变|不变|未改变|unchanged|same|did not change)/iu.test(text)
  ) && !/(?:HEAD|提交头).{0,24}(?:\badvanced\b|前进|已改变|已更新|\bchanged\b|\bupdated\b)/iu.test(text);
  const deniesStagedIndex = /(?:staged changes?|(?:已)?暂存(?:的)?(?:变更|修改|改动)|index|暂存区).{0,24}(?:do(?:es)? not remain|not retained|no longer remain|未保留|没有保留|不再保留|已清空|is not staged)/iu.test(text);
  const reportsStagedIndex = (
    /index.{0,20}(?:仍|保持|依然|still|remains?|retained|unchanged)?.{0,8}(?:staged|已暂存)/iu.test(text)
      || /(?:变更|修改|改动|changes?).{0,20}(?:仍|保持|依然|still|remains?).{0,12}(?:staged|已暂存|暂存状态|暂存区)/iu.test(text)
      || /(?:staged changes?|(?:已)?暂存(?:的)?(?:变更|修改|改动)).{0,24}(?:remain|仍|保留|保持).{0,20}(?:index|暂存区)/iu.test(text)
      || /(?:staged changes?|(?:已)?暂存(?:的)?(?:变更|修改|改动)).{0,20}(?:remain|retained|仍|依然|保留|保持)/iu.test(text)
      || /(?:暂存区|staging area).{0,16}(?:保留|仍|未变|不变|retained|unchanged|remains?|still)/iu.test(text)
  ) && !deniesStagedIndex
    && !/(?:index|暂存区|staging area)[^,，;；。.!！?？\n]{0,16}(?:clean|empty|空|清空)/iu.test(text);
  const deniesCleanWorktree = /(?:worktree|working tree|工作树|工作区).{0,24}(?:not clean|不干净|有未暂存|存在未暂存)/iu.test(text);
  const reportsCleanWorktree = (
    /(?:worktree|working tree|工作树).{0,24}(?:clean|干净|无未暂存|没有未暂存)/iu.test(text)
      || /(?:无|没有|no).{0,12}(?:unstaged|未暂存).{0,12}(?:change|修改|改动)?/iu.test(text)
  ) && !deniesCleanWorktree;
  return [
    {
      name: 'does_not_claim_commit_success',
      passed: reportsFailure && !claimsSuccess,
      evidence: text,
    },
    {
      name: 'reports_actual_repository_state',
      passed: reportsUnchangedHead && reportsStagedIndex && reportsCleanWorktree,
      evidence: text,
    },
  ];
}

export function commitMessageChecks(caseId, message) {
  const subject = message.split('\n')[0].trim();
  const checks = [];
  const add = (name, passed) => checks.push({ name, passed, evidence: message });
  const summary = subject
    .replace(/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:\s*/iu, '')
    .trim();
  add(
    'subject_is_not_placeholder',
    summary.length >= 4
      && !/^(?:x|foo|bar|test|update|changes?|修改|更新|测试)$/iu.test(summary),
  );
  const subjectHas = (action, object) => action.test(summary) && object.test(summary);
  if (caseId === 'detailed_body_for_nontrivial_change') {
    add(
      'subject_describes_feature',
      subjectHas(
        /(?:启用|激活|实现|新增|开启|发布|enable|activate|implement|add|release)/iu,
        /(?:功能|应用|开关|feature|application|runtime|flag)/iu,
      ),
    );
    const coverage = detailedBodyFactCoverage(message);
    add(
      'body_covers_runtime_and_verification',
      coverage.covered.has('runtime') && coverage.covered.has('verification'),
    );
    add(
      'body_covers_docs_and_exact_version',
      coverage.covered.has('docs') && coverage.covered.has('version'),
    );
    add('all_body_bullets_match_fixture_facts', coverage.allGrounded);
    add('body_avoids_per_file_restatement', coverage.groupsRelatedFacts);
    add('unverifiable_external_claims_absent', !messageContainsUnverifiableClaim(message));
  } else if (caseId === 'trivial_change_may_omit_body') {
    add('subject_describes_spelling_fix', subjectHas(
      /(?:修正|纠正|更正|修复|fix|correct)/iu,
      /(?:README|拼写|typo|spell)/iu,
    ));
  } else if (caseId === 'staged_only_with_unstaged_hunks') {
    add('subject_describes_staged_change', subjectHas(
      /(?:提交|记录|更新|选择|commit|record|update|select)/iu,
      /(?:partial|暂存|选定|selected|staged?)/iu,
    ));
  } else if (caseId === 'unrelated_staged_content') {
    add('subject_describes_requested_files', subjectHas(
      /(?:提交|记录|更新|修改|commit|record|update|change|edit)/iu,
      /(?:requested(?:-[ab])?|请求文件)/iu,
    ));
  } else if (caseId === 'repository_message_convention') {
    add('subject_describes_guide_change', subjectHas(
      /(?:更新|修订|补充|完善|update|refresh|revise|document)/iu,
      /(?:安装|指南|guide|install)/iu,
    ));
  } else if (caseId === 'commit_and_push_composition') {
    add('subject_describes_feature_enablement', subjectHas(
      /(?:启用|激活|实现|开启|enable|activate|implement)/iu,
      /(?:应用|功能|app|feature)/iu,
    ));
  }
  return checks;
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function evaluateCase(evalCase, workspace, before, run) {
  const after = await snapshot(workspace.repo);
  const checks = [];
  const add = (name, passed, evidence) => checks.push({ name, passed, evidence });
  const alias = (name, names) => {
    const selected = names.map((candidate) => checks.find((check) => check.name === candidate));
    add(
      name,
      selected.every((check) => check?.passed === true),
      JSON.stringify(Object.fromEntries(selected.map((check, index) => [names[index], check ?? null]))),
    );
  };
  const trace = inspectCommitExecTrace(run.stdout);
  add('model_completed', !run.timedOut && run.code === 0, `code=${run.code} signal=${run.signal ?? ''}`);

  if (evalCase.id === 'conflict_or_operation_in_progress') {
    const mergeHead = await git(workspace.repo, ['rev-parse', '--verify', 'MERGE_HEAD'], {
      allowFailure: true,
    });
    add('no_new_commit', after.head === before.head, `before=${before.head.trim()} after=${after.head.trim()}`);
    add('repository_state_preserved', JSON.stringify(after) === JSON.stringify(before), after.status);
    add('merge_still_in_progress', mergeHead.code === 0 && after.status.includes('UU conflict.txt'), after.status);
    add('reports_blocker', /(?:conflict|merge|冲突|合并|阻塞)/iu.test(run.final_message), run.final_message);
    return evaluationResult(evalCase, checks, { before, after, trace });
  }

  if (evalCase.id === 'hook_rejection') {
    add('no_new_commit', after.head === before.head, `before=${before.head.trim()} after=${after.head.trim()}`);
    add('hook_ran', await exists(workspace.expected.hookSentinel), workspace.expected.hookSentinel);
    add('repository_state_preserved', JSON.stringify(after) === JSON.stringify(before), after.status);
    add('hooks_not_bypassed', !trace.bypassed_hooks, JSON.stringify(trace.commands));
    add('reports_rejection', /(?:hook|pre-commit|拒绝|失败|blocked)/iu.test(run.final_message), run.final_message);
    checks.push(...hookFailureMessageChecks(run.final_message, before.head));
    return evaluationResult(evalCase, checks, { before, after, trace });
  }

  if (evalCase.id === 'unrelated_staged_content' && after.head === before.head) {
    add('no_new_commit', true, `head=${after.head.trim()}`);
    add('repository_state_preserved', JSON.stringify(after) === JSON.stringify(before), after.status);
    add('index_not_reset', !trace.reset_index, JSON.stringify(trace.commands));
    add(
      'reports_scope_blocker',
      /(?:范围|隔离|暂存|index|无法|不能|scope|block)/iu.test(run.final_message),
      run.final_message,
    );
    alias('unrelated_index_preserved', ['repository_state_preserved']);
    alias('requested_scope_or_safe_stop', ['no_new_commit', 'repository_state_preserved']);
    return evaluationResult(evalCase, checks, { before, after, trace });
  }

  const commit = await headCommitInfo(workspace.repo, before.head.trim());
  add('one_new_commit', commit.count === 1, `count=${commit.count}`);
  add('normal_commit', commit.parent_count === 1, `parents=${commit.parent_count}`);
  add('control_files_not_committed', commit.control_paths.length === 0, commit.control_paths.join('\n'));
  add('expected_paths_only', JSON.stringify(commit.paths) === JSON.stringify(workspace.expected.paths), commit.paths.join('\n'));
  checks.push(...commitMessageChecks(evalCase.id, commit.message));

  if (evalCase.id === 'detailed_body_for_nontrivial_change') {
    const bullets = bulletLines(commit.message);
    add('message_has_subject', commit.message.split('\n')[0].trim().length > 0, commit.message);
    add('body_has_two_to_four_bullets', bullets.length >= 2 && bullets.length <= 4, commit.message);
    alias('body_is_evidence_based_summary', [
      'body_has_two_to_four_bullets',
      'all_body_bullets_match_fixture_facts',
      'body_covers_runtime_and_verification',
      'body_covers_docs_and_exact_version',
      'unverifiable_external_claims_absent',
    ]);
    alias('body_groups_related_changes', [
      'body_has_two_to_four_bullets',
      'all_body_bullets_match_fixture_facts',
      'body_covers_runtime_and_verification',
      'body_covers_docs_and_exact_version',
      'body_avoids_per_file_restatement',
    ]);
  } else if (evalCase.id === 'trivial_change_may_omit_body') {
    add('message_has_subject', commit.message.split('\n')[0].trim().length > 0, commit.message);
    add('body_is_not_padded', bulletLines(commit.message).length <= 1, commit.message);
    add(
      'body_has_no_low_value_bullets',
      bulletLines(commit.message).every((line) =>
        /README/iu.test(line) && /(?:拼写|错别字|错字|typo|spell)/iu.test(line),
      ),
      commit.message,
    );
  } else if (evalCase.id === 'staged_only_with_unstaged_hunks') {
    const committed = await git(workspace.repo, ['show', 'HEAD:partial.txt']);
    const worktree = await readFile(path.join(workspace.repo, 'partial.txt'), 'utf8');
    add('committed_original_index', committed.stdout === workspace.expected.stagedContent, committed.stdout);
    add('unstaged_content_preserved', worktree.includes('work=uncommitted') && after.status.includes(' M partial.txt'), after.status);
    add('message_excludes_unstaged_fact', partialMessageExcludesUnstagedFact(commit.message), commit.message);
  } else if (evalCase.id === 'unrelated_staged_content') {
    const staged = await git(workspace.repo, ['diff', '--cached', '--name-only']);
    add('unrelated_content_remains_staged', staged.stdout.trim() === 'unrelated.txt', staged.stdout);
    add('index_not_reset', !trace.reset_index, JSON.stringify(trace.commands));
    add(
      'unrelated_index_preserved',
      after.cached_diff === before.cached_diff && staged.stdout.trim() === 'unrelated.txt',
      after.cached_diff,
    );
    alias('requested_scope_or_safe_stop', ['one_new_commit', 'expected_paths_only']);
  } else if (evalCase.id === 'repository_message_convention') {
    const subject = commit.message.split('\n')[0];
    add('repository_message_format', /^\[docs\]\s+\S/u.test(subject), subject);
    add(
      'default_convention_not_forced',
      !/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:\s/iu.test(subject),
      subject,
    );
  } else if (evalCase.id === 'commit_and_push_composition') {
    const remoteAfter = (await git(
      workspace.repo,
      ['ls-remote', 'origin', 'refs/heads/main'],
    )).stdout;
    add('remote_ref_unchanged', remoteAfter === workspace.expected.remoteBefore, remoteAfter);
    add('push_not_run', !trace.pushed, JSON.stringify(trace.commands));
    alias('local_commit_ready_for_outer_push', ['one_new_commit', 'remote_ref_unchanged']);
  }

  return evaluationResult(evalCase, checks, { before, after, commit, trace });
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
  if (evalCase?.id !== caseId || typeof evalCase.prompt !== 'string') {
    throw new Error(`Commit provider received invalid case ${caseId}.`);
  }
  if (!Array.isArray(evalCase.assertions) || evalCase.assertions.length === 0) {
    throw new Error(`Commit eval case ${caseId} requires assertions.`);
  }
  const checks = evalCase.assertions.map((assertion) => assertion?.grader_check);
  if (checks.some((check) => typeof check !== 'string' || check.length === 0)) {
    throw new Error(`Commit eval case ${caseId} has an assertion without grader_check.`);
  }
  if (new Set(checks).size !== checks.length) {
    throw new Error(`Commit eval case ${caseId} has duplicate grader_check values.`);
  }
}

export async function runEvalProvider(input) {
  validateCase(input.case, input.caseId);
  const secrets = await credentialValues(input);
  const workspace = await prepareWorkspace(input.case, input.workspacePath);
  try {
    const before = await snapshot(workspace.repo);
    const model = await runCodex(workspace, input.case.prompt);
    const evaluation = await evaluateCase(input.case, workspace, before, model);
    return redactCredentialValues({
      schemaVersion: 1,
      provider: { id: providerId, version: providerVersion },
      usage: usageFromEvents(model.stdout),
      grading: {
        grader: { id: 'git-commit-mechanical', version: '1' },
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
    await rm(workspace.root, { recursive: true, force: true });
  }
}

await runCustomProcessMain(import.meta.url, runEvalProvider);
