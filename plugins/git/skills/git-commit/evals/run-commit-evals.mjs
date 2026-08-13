import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { waitForEvalChild } from '../../../scripts/eval-child-process.mjs';
import { gitMetadataWritableArgs } from '../../../scripts/eval-git-permissions.mjs';
import { gitInvocations } from '../../../scripts/eval-git-trace.mjs';
import { isolateMaterializedSkills } from '../../../scripts/eval-participant-skills.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const skillKey = 'git-commit';
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
    'Usage: run-commit-evals.mjs [options]',
    '  --runs N          Runs per current/baseline variant (default: 1)',
    '  --case ID         Run one case from behavior-cases.json',
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
  const document = JSON.parse(await readEvalResource('behavior-cases.json'));
  if (document?.skill_name !== skillKey || !Array.isArray(document.evals)) {
    throw new Error(`behavior-cases.json must describe ${skillKey}.`);
  }
  const cases = caseId
    ? document.evals.filter((entry) => entry.id === caseId)
    : document.evals;
  if (cases.length === 0) throw new Error(`Unknown commit eval case: ${caseId}`);
  for (const evalCase of cases) {
    if (!Array.isArray(evalCase.assertions) || evalCase.assertions.length === 0) {
      throw new Error(`Commit eval case ${evalCase.id} requires assertions.`);
    }
    const graderChecks = evalCase.assertions.map((assertion) => assertion?.grader_check);
    if (graderChecks.some((check) => typeof check !== 'string' || check.length === 0)) {
      throw new Error(`Commit eval case ${evalCase.id} has an assertion without grader_check.`);
    }
    if (new Set(graderChecks).size !== graderChecks.length) {
      throw new Error(`Commit eval case ${evalCase.id} has duplicate grader_check values.`);
    }
  }
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

async function prepareWorkspace(evalCase, withSkill) {
  const materializedRoot = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  if (!materializedRoot) {
    throw new Error('AW_PLUGIN_EVAL_PROJECT_ROOT is required; run through pnpm plugin:eval.');
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-commit-skill-eval-'));
  const repo = path.join(root, 'repo');
  try {
    await mkdir(repo);
    await initializeRepository(repo);
    const expected = await setupFixture(evalCase, repo, root);
    await cp(path.join(materializedRoot, '.agents'), path.join(repo, '.agents'), { recursive: true });
    await isolateMaterializedSkills(path.join(repo, '.agents'), skillKey, withSkill);
    return { root, repo, expected };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runCodex(workspace, prompt, options) {
  const metadataArgs = await gitMetadataWritableArgs(workspace.repo, workspace.root);
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--color', 'never',
    '--sandbox', 'workspace-write', ...metadataArgs,
    '--cd', workspace.repo, '--model', options.model,
    '--config', 'approval_policy="never"',
    '--config', 'skills.include_instructions=true', prompt,
  ];
  const child = spawn(options.codexBin, args, {
    cwd: workspace.repo,
    env: isolatedGitEnv(),
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

function detailedBodyFactsAreGrounded(message) {
  const bullets = bulletLines(message);
  const unsupportedFixtureClaim = /(?:database|schema|cache|queue|API|dependency|数据库|数据表|缓存|队列|接口|依赖)/iu;
  const factPatterns = [
    /(?=.*(?:功能|应用|运行时|开关|app(?:\.js)?|application|runtime|flag|feature))(?=.*(?:启用|激活|开启|已启用|enable(?:d)?|activate(?:d)?|false.{0,20}true))/iu,
    /(?=.*(?:测试|预期|test|expect))(?=.*(?:同步|对齐|调整|更新|改为|设为|sync|align|adjust|update|set|true))/iu,
    /(?=.*(?:文档|指南|说明|docs?|guide|documentation))(?=.*(?:启用|激活|开启|已启用|enable(?:d)?|activate(?:d)?))/iu,
    /\b1\.0\.0\b.*\b1\.1\.0\b|\b1\.1\.0\b.*\b1\.0\.0\b/u,
  ];
  return bullets.length >= 2
    && bullets.length <= 4
    && bullets.every((line) =>
      !unsupportedFixtureClaim.test(line)
        && factPatterns.some((pattern) => pattern.test(line)),
    );
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

export function hookFailureMessageChecks(message) {
  const text = typeof message === 'string' ? message : '';
  const reportsFailure = /(?:hook|pre-commit|拒绝|失败|blocked|未(?:创建|提交)|没有(?:创建|提交)|no commit)/iu.test(text);
  const textWithoutExplicitFailure = text.replace(
    /(?:no (?:new )?commit (?:was )?created|commit was not created|did not create (?:a )?commit|未创建(?:新的?)?(?:\s*commit|提交)?|没有(?:创建|产生)(?:新的?)?(?:\s*commit|提交)?)/giu,
    '',
  );
  const claimsSuccess = /(?:commit|提交)\s*(?:已|已经)?\s*(?:成功|完成)|(?:已|已经|成功)(?:创建|完成|提交)(?:了)?(?:本地)?(?:\s*commit)?|commit\s+(?:was\s+)?(?:created|succeeded|completed successfully)/iu.test(textWithoutExplicitFailure);
  const reportsUnchangedHead = /(?:HEAD|提交头).{0,24}(?:未变|不变|未改变|保持|unchanged|same|did not change|remains?)/iu.test(text)
    || /(?:未|没有|no).{0,12}(?:创建|产生|new).{0,12}(?:commit|提交)/iu.test(text);
  const reportsStagedIndex = (
    /index.{0,20}(?:仍|保持|依然|still|remains?|retained|unchanged)?.{0,8}(?:staged|已暂存)/iu.test(text)
      || /(?:变更|修改|改动|changes?).{0,20}(?:仍|保持|依然|still|remains?).{0,12}(?:staged|已暂存|暂存区)/iu.test(text)
      || /(?:staged changes?|(?:已)?暂存(?:的)?(?:变更|修改|改动)).{0,24}(?:remain|仍|保留|保持).{0,20}(?:index|暂存区)/iu.test(text)
      || /(?:暂存区|staging area).{0,16}(?:保留|仍|未变|不变|retained|unchanged|remains?|still)/iu.test(text)
  ) && !/(?:index|暂存区|staging area)[^,，;；。.!！?？\n]{0,16}(?:clean|empty|空|清空)/iu.test(text);
  const reportsCleanWorktree = /(?:worktree|working tree|工作树).{0,24}(?:clean|干净|无未暂存|没有未暂存)/iu.test(text)
    || /(?:无|没有|no).{0,12}(?:unstaged|未暂存).{0,12}(?:change|修改|改动)?/iu.test(text);
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
    const bullets = bulletLines(message);
    add(
      'body_bullets_are_actions',
      bullets.every((line) => /(?:启用|激活|实现|新增|更新|同步|调整|修正|切换|提升|enable|activate|implement|add|update|sync|align|switch|refresh|bump|fix|change)/iu.test(line)),
    );
    add(
      'body_covers_runtime_and_verification',
      bullets.some((line) => (
        /(?:功能|应用|运行时|开关|app(?:\.js)?|application|runtime|flag|feature)/iu.test(line)
          && /(?:启用|激活|开启|已启用|enable(?:d)?|activate(?:d)?|switch\w*.{0,20}\bon\b|false.{0,20}true)/iu.test(line)
          && /(?:测试|预期|test|expect)/iu.test(line)
          && /(?:同步|对齐|调整|更新|改为|设为|sync|align|adjust|update|set|true)/iu.test(line)
        )),
    );
    add(
      'body_covers_docs_and_exact_version',
      bullets.some((line) => (
        /(?:文档|指南|说明|docs?|guide|documentation)/iu.test(line)
          && /(?:启用|激活|开启|已启用|enable(?:d)?|activate(?:d)?)/iu.test(line)
          && /\b1\.0\.0\b.*\b1\.1\.0\b|\b1\.1\.0\b.*\b1\.0\.0\b/u.test(line)
      )),
    );
    add('all_body_bullets_match_fixture_facts', detailedBodyFactsAreGrounded(message));
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
      /(?:提交|记录|更新|commit|record|update)/iu,
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
    checks.push(...hookFailureMessageChecks(run.final_message));
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
      'body_bullets_are_actions',
      'body_covers_runtime_and_verification',
      'body_covers_docs_and_exact_version',
      'unverifiable_external_claims_absent',
    ]);
    alias('body_groups_related_changes', [
      'body_has_two_to_four_bullets',
      'all_body_bullets_match_fixture_facts',
      'body_covers_runtime_and_verification',
      'body_covers_docs_and_exact_version',
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

async function runVariant(evalCase, variant, options) {
  const runs = [];
  for (let index = 0; index < options.runs; index += 1) {
    const workspace = await prepareWorkspace(evalCase, variant === 'current');
    try {
      const before = await snapshot(workspace.repo);
      const model = await runCodex(workspace, evalCase.prompt, options);
      const evaluation = await evaluateCase(evalCase, workspace, before, model);
      runs.push({ run: index + 1, model, evaluation });
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
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
