import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  captureTriggerWorkspaceState,
  setupTriggerWorkspace,
} from '../skills/git-commit/evals/trigger-fixture.mjs';
import {
  analysisMessageChecks,
  committedControlPaths,
  loadCases as loadMergeCases,
  parseArgs as parseMergeEvalArgs,
} from '../skills/reconciling-git-merges/evals/run-merge-evals.mjs';
import {
  ignoreEntriesForCase as worktreeIgnoreEntriesForCase,
  inspectExecTrace as inspectWorktreeExecTrace,
  loadCases as loadWorktreeCases,
  parseArgs as parseWorktreeEvalArgs,
  snapshot as snapshotWorktreeRepository,
} from '../skills/isolating-work-with-git-worktrees/evals/run-worktree-evals.mjs';
import {
  captureTriggerWorkspaceState as captureWorktreeTriggerWorkspaceState,
  setupTriggerWorkspace as setupWorktreeTriggerWorkspace,
} from '../skills/isolating-work-with-git-worktrees/evals/trigger-fixture.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bundledPluginRoot = path.resolve(scriptDir, '..');

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) {
      delete env[name];
    }
  }
  return {
    ...env,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_KEY_1: 'commit.gpgSign',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

async function git(cwd, args, env = isolatedGitEnv()) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
  });
}

async function resolveTestContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    return {
      sourceRoot: bundledPluginRoot,
      bundleRoot: bundledPluginRoot,
      platform: null,
    };
  }
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(context.plugin.name, 'git');
  assert.equal(context.plugin.version, '0.1.0');
  assert.equal(context.event, 'test');
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

async function testEvalCorpora(sourceRoot) {
  const [
    triggerContent,
    behaviorContent,
    mergeTriggerContent,
    mergeEvalContent,
    mergeManifestContent,
    worktreeTriggerContent,
    worktreeEvalContent,
    worktreeManifestContent,
    worktreeEvalReadmeContent,
  ] = await Promise.all([
    readFile(
      path.join(sourceRoot, 'skills', 'git-commit', 'evals', 'trigger-cases.json'),
      'utf8',
    ),
    readFile(
      path.join(sourceRoot, 'skills', 'git-commit', 'evals', 'behavior-cases.json'),
      'utf8',
    ),
    readFile(
      path.join(sourceRoot, 'skills', 'reconciling-git-merges', 'evals', 'trigger-cases.json'),
      'utf8',
    ),
    readFile(
      path.join(sourceRoot, 'skills', 'reconciling-git-merges', 'evals', 'evals.json'),
      'utf8',
    ),
    readFile(
      path.join(sourceRoot, 'skills', 'reconciling-git-merges', 'evals', 'manifest.json'),
      'utf8',
    ),
    readFile(
      path.join(
        sourceRoot,
        'skills',
        'isolating-work-with-git-worktrees',
        'evals',
        'trigger-cases.json',
      ),
      'utf8',
    ),
    readFile(
      path.join(
        sourceRoot,
        'skills',
        'isolating-work-with-git-worktrees',
        'evals',
        'evals.json',
      ),
      'utf8',
    ),
    readFile(
      path.join(
        sourceRoot,
        'skills',
        'isolating-work-with-git-worktrees',
        'evals',
        'manifest.json',
      ),
      'utf8',
    ),
    readFile(
      path.join(
        sourceRoot,
        'skills',
        'isolating-work-with-git-worktrees',
        'evals',
        'README.md',
      ),
      'utf8',
    ),
  ]);
  const document = JSON.parse(triggerContent);
  const behaviorCases = JSON.parse(behaviorContent);
  const { cases } = document;
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, 'git-commit');
  assert.equal(cases.length, 20);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 12);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(cases.filter((entry) => entry.should_load_skill).length, 10);
  assert.equal(cases.filter((entry) => !entry.should_load_skill).length, 10);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);

  const expectedContracts = new Map([
    ['english_commit', true],
    ['commit_and_push', true],
    ['draft_message_only', false],
    ['stage_only', false],
    ['mixed_language_staged', true],
    ['squash_history', false],
    ['non_git_commitment', false],
    ['merge_operation', false],
    ['scoped_fix_commit', true],
    ['terse_commit', true],
  ]);
  for (const [id, shouldLoad] of expectedContracts) {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required eval case ${id}`);
    assert.equal(entry.should_load_skill, shouldLoad);
  }
  assert.equal(cases.some((entry) => entry.query.includes('$git-commit')), false);
  assert.match(cases.find((entry) => entry.id === 'english_commit').query, /useful summary/);
  assert.match(cases.find((entry) => entry.id === 'scoped_fix_commit').query, /body/);
  assert.match(cases.find((entry) => entry.id === 'terse_commit').query, /commti/);

  assert.equal(Array.isArray(behaviorCases), true);
  assert.equal(behaviorCases.length, 8);
  assert.equal(new Set(behaviorCases.map((entry) => entry.id)).size, behaviorCases.length);
  for (const entry of behaviorCases) {
    assert.equal(typeof entry.prompt, 'string');
    assert.notEqual(entry.prompt.trim(), '');
    assert.equal(Array.isArray(entry.assertions), true);
    assert.ok(entry.assertions.length >= 2);
    assert.equal(
      entry.assertions.every(
        (assertion) => typeof assertion === 'string' && assertion.trim() !== '',
      ),
      true,
    );
  }
  const expectedBehaviorContracts = new Map([
    [
      'detailed-body-for-nontrivial-change',
      'body 包含 2 到 4 条有排查价值且可由 diff 证实的变更事实',
    ],
    ['trivial-change-may-omit-body', '允许只使用准确标题而省略 body'],
    ['staged-only-with-unstaged-hunks', 'message 只描述实际提交内容'],
    ['unrelated-staged-content', '不使用 reset 重排用户暂存区'],
    ['repository-message-convention', '优先遵守仓库格式'],
    ['commit-and-push-composition', '结果可由外层流程继续 push'],
    ['conflict-or-operation-in-progress', '不继续对应历史操作'],
    ['hook-rejection', '不绕过 hooks'],
  ]);
  for (const [id, expectedAssertion] of expectedBehaviorContracts) {
    const entry = behaviorCases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required behavior case ${id}`);
    assert.ok(
      entry.assertions.includes(expectedAssertion),
      `Missing required behavior assertion for ${id}`,
    );
  }

  const mergeDocument = JSON.parse(mergeTriggerContent);
  const mergeCases = mergeDocument.cases;
  const participants = new Set(['reconciling-git-merges', 'git-commit']);
  assert.equal(mergeDocument.schemaVersion, 1);
  assert.equal(mergeDocument.skill, 'reconciling-git-merges');
  assert.equal(mergeCases.length, 21);
  assert.equal(mergeCases.filter((entry) => entry.split === 'train').length, 14);
  assert.equal(mergeCases.filter((entry) => entry.split === 'validation').length, 7);
  assert.equal(new Set(mergeCases.map((entry) => entry.id)).size, mergeCases.length);
  assert.equal(mergeCases.filter((entry) => entry.expected_loaded_skills.length === 1).length, 11);
  assert.equal(mergeCases.filter((entry) => entry.expected_loaded_skills.length === 0).length, 10);
  for (const entry of mergeCases) {
    assert.equal(Array.isArray(entry.expected_loaded_skills), true);
    assert.equal(
      entry.expected_loaded_skills.every((skill) => participants.has(skill)),
      true,
    );
    assert.equal(
      new Set(entry.expected_loaded_skills).size,
      entry.expected_loaded_skills.length,
    );
  }
  const expectedMergeRouting = new Map([
    ['source_01', ['reconciling-git-merges']],
    ['source_02', ['reconciling-git-merges']],
    ['source_08', ['reconciling-git-merges']],
    ['source_11', []],
    ['source_12', []],
    ['source_13', []],
    ['source_16', []],
    ['source_17', []],
    ['ordinary_local_commit', ['git-commit']],
  ]);
  for (const [id, expectedSkills] of expectedMergeRouting) {
    const entry = mergeCases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required merge routing case ${id}`);
    assert.deepEqual(entry.expected_loaded_skills, expectedSkills);
  }

  const mergeEvals = JSON.parse(mergeEvalContent);
  const mergeManifest = JSON.parse(mergeManifestContent);
  assert.equal(mergeEvals.skill_name, 'reconciling-git-merges');
  assert.equal(mergeEvals.evals.length, 4);
  assert.deepEqual(
    mergeEvals.evals.map((entry) => entry.id),
    [
      'ambiguous_retention',
      'semantic_same_file',
      'semantic_cross_file',
      'analysis_only_dirty_worktree',
    ],
  );
  for (const entry of mergeEvals.evals) {
    assert.equal(typeof entry.prompt, 'string');
    assert.equal(typeof entry.expected_output, 'string');
    assert.equal(entry.files.length, 1);
    const fixturePath = path.join(sourceRoot, 'skills', 'reconciling-git-merges', entry.files[0]);
    assert.ok((await readFile(fixturePath)).length > 0);
  }
  assert.equal(mergeManifest.skill, 'reconciling-git-merges');
  assert.equal(mergeManifest.suites.length, 2);
  const routerSuite = mergeManifest.suites.find((suite) => suite.id === 'router');
  const behaviorSuite = mergeManifest.suites.find((suite) => suite.id === 'behavior');
  assert.equal(routerSuite.kind, 'trigger');
  assert.deepEqual(routerSuite.skills, ['reconciling-git-merges', 'git-commit']);
  assert.equal(routerSuite.forbidMultipleSkillLoads, true);
  assert.equal(routerSuite.cases, './trigger-cases.json');
  assert.equal(behaviorSuite.kind, 'command');
  assert.deepEqual(behaviorSuite.skills, ['reconciling-git-merges', 'git-commit']);
  assert.equal(behaviorSuite.entry, './run-merge-evals.mjs');
  assert.equal(behaviorSuite.cases, './evals.json');
  assert.equal(behaviorSuite.requiredForRelease, true);
  assert.deepEqual(
    (await loadMergeCases()).map((entry) => entry.id),
    mergeEvals.evals.map((entry) => entry.id),
  );
  assert.deepEqual(parseMergeEvalArgs(['--runs', '2', '--case', 'semantic_same_file']), {
    runs: 2,
    timeoutMs: 300000,
    codexBin: 'codex',
    model: 'gpt-5.6-luna',
    caseId: 'semantic_same_file',
    output: undefined,
    help: false,
  });
  assert.throws(() => parseMergeEvalArgs(['--runs', '0']), /positive integer/);

  const worktreeDocument = JSON.parse(worktreeTriggerContent);
  const worktreeCases = worktreeDocument.cases;
  const worktreeParticipants = new Set([
    'isolating-work-with-git-worktrees',
    'reconciling-git-merges',
    'git-commit',
  ]);
  assert.equal(worktreeDocument.schemaVersion, 1);
  assert.equal(worktreeDocument.skill, 'isolating-work-with-git-worktrees');
  assert.equal(worktreeCases.length, 30);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'train').length, 14);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'validation').length, 6);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'sanity').length, 10);
  assert.equal(new Set(worktreeCases.map((entry) => entry.id)).size, worktreeCases.length);
  assert.equal(
    worktreeCases.filter((entry) =>
      entry.expected_loaded_skills.includes('isolating-work-with-git-worktrees'),
    ).length,
    15,
  );
  assert.equal(
    worktreeCases.filter((entry) => entry.expected_loaded_skills.length === 0).length,
    12,
  );
  for (const entry of worktreeCases) {
    assert.equal(Array.isArray(entry.expected_loaded_skills), true);
    assert.equal(
      entry.expected_loaded_skills.every((skill) => worktreeParticipants.has(skill)),
      true,
    );
    assert.equal(
      new Set(entry.expected_loaded_skills).size,
      entry.expected_loaded_skills.length,
    );
  }
  const expectedWorktreeRouting = new Map([
    ['source_01', ['isolating-work-with-git-worktrees']],
    ['source_08', ['isolating-work-with-git-worktrees']],
    ['source_10', ['isolating-work-with-git-worktrees']],
    ['source_11', []],
    ['source_13', []],
    ['source_15', []],
    ['source_17', ['reconciling-git-merges']],
    ['source_20', []],
    ['sanity_parallel_branch', ['isolating-work-with-git-worktrees']],
    ['sanity_list_worktrees', []],
    ['sanity_local_commit', ['git-commit']],
    ['sanity_merge_conflict', ['reconciling-git-merges']],
    ['sanity_dirty_new_task', ['isolating-work-with-git-worktrees']],
    ['sanity_parallel_test', ['isolating-work-with-git-worktrees']],
    ['sanity_dirty_same_branch', []],
  ]);
  for (const [id, expectedSkills] of expectedWorktreeRouting) {
    const entry = worktreeCases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required worktree routing case ${id}`);
    assert.deepEqual(entry.expected_loaded_skills, expectedSkills);
  }
  assert.equal(
    worktreeCases.some((entry) =>
      entry.query.includes('$isolating-work-with-git-worktrees'),
    ),
    false,
  );
  const worktreeFixtures = new Set([
    'clean_main',
    'commit_ready',
    'dirty_feature',
    'dirty_main',
    'dirty_mixed_feature',
    'linked_dirty_feature',
    'linked_feature',
    'merge_conflict',
  ]);
  assert.equal(
    worktreeCases.every((entry) =>
      entry.workspace_fixture === undefined || worktreeFixtures.has(entry.workspace_fixture),
    ),
    true,
  );
  assert.match(
    worktreeCases.find((entry) => entry.id === 'sanity_dirty_new_task').query,
    /两个任务的文件和 Git 状态不要混在一起/,
  );
  assert.match(
    worktreeCases.find((entry) => entry.id === 'sanity_dirty_same_branch').query,
    /继续完成这个功能/,
  );
  assert.match(
    worktreeCases.find((entry) => entry.id === 'sanity_parallel_test').query,
    /运行兼容性测试/,
  );
  const releaseParticipants = new Set(
    worktreeCases
      .filter((entry) => ['validation', 'sanity'].includes(entry.split))
      .flatMap((entry) => entry.expected_loaded_skills),
  );
  assert.deepEqual(
    [...releaseParticipants].sort(),
    [...worktreeParticipants].sort(),
  );

  const worktreeEvals = JSON.parse(worktreeEvalContent);
  const worktreeManifest = JSON.parse(worktreeManifestContent);
  assert.equal(worktreeEvals.skill_name, 'isolating-work-with-git-worktrees');
  assert.deepEqual(
    worktreeEvals.evals.map((entry) => entry.id),
    [
      'preserve_dirty_workspace_and_use_default_path',
      'stop_when_default_root_not_ignored',
      'reuse_existing_isolation',
      'report_dirty_baseline',
    ],
  );
  for (const entry of worktreeEvals.evals) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.prompt, 'string');
    assert.equal(typeof entry.expected_output, 'string');
  }
  assert.equal(worktreeManifest.skill, 'isolating-work-with-git-worktrees');
  assert.equal(worktreeManifest.suites.length, 2);
  const worktreeRouterSuite = worktreeManifest.suites.find((suite) => suite.id === 'router');
  const worktreeBehaviorSuite = worktreeManifest.suites.find((suite) => suite.id === 'behavior');
  assert.equal(worktreeRouterSuite.id, 'router');
  assert.equal(worktreeRouterSuite.kind, 'trigger');
  assert.deepEqual(worktreeRouterSuite.skills, [
    'isolating-work-with-git-worktrees',
    'reconciling-git-merges',
    'git-commit',
  ]);
  assert.equal(worktreeRouterSuite.forbidMultipleSkillLoads, true);
  assert.equal(worktreeRouterSuite.minimumPassRate, 0.8);
  assert.equal(worktreeRouterSuite.cases, './trigger-cases.json');
  assert.deepEqual(worktreeRouterSuite.strictNegativeSplits, ['validation', 'sanity']);
  assert.deepEqual(worktreeRouterSuite.releaseSplits, ['validation', 'sanity']);
  assert.equal(worktreeBehaviorSuite.kind, 'command');
  assert.deepEqual(worktreeBehaviorSuite.skills, [
    'isolating-work-with-git-worktrees',
    'reconciling-git-merges',
    'git-commit',
  ]);
  assert.equal(worktreeBehaviorSuite.entry, './run-worktree-evals.mjs');
  assert.equal(worktreeBehaviorSuite.cases, './evals.json');
  assert.equal(worktreeBehaviorSuite.requiredForRelease, true);
  assert.equal(worktreeRouterSuite.fixtureModule, './trigger-fixture.mjs');
  assert.match(worktreeEvalReadmeContent, /--batch-name release\b/);
  assert.equal(worktreeEvalReadmeContent.includes('--runs 1'), false);
  assert.deepEqual(
    (await loadWorktreeCases()).map((entry) => entry.id),
    worktreeEvals.evals.map((entry) => entry.id),
  );
  assert.deepEqual(
    parseWorktreeEvalArgs(['--runs', '2', '--case', 'reuse_existing_isolation']),
    {
      runs: 2,
      timeoutMs: 300000,
      codexBin: 'codex',
      model: 'gpt-5.6-luna',
      caseId: 'reuse_existing_isolation',
      output: undefined,
      help: false,
    },
  );
  assert.throws(() => parseWorktreeEvalArgs(['--timeout-ms', '0']), /positive integer/);
}

function assertRenderedSkill(skill) {
  assert.equal(skill.includes('{{'), false);
  assert.equal(skill.includes('allowed-tools:'), false);
  assert.equal(skill.includes('## 当前 Git 快照'), false);
  assert.equal(skill.includes('```!'), false);
}

function assertCoreCommitContract(skill) {
  assert.match(
    skill,
    /只提交用户授权改动，不主动改变范围外的 index、worktree 或既有历史/,
  );
  assert.match(skill, /本 skill 不执行 push/);
  assert.match(
    skill,
    /范围无法精确隔离、存在未解决冲突或进行中的 Git 操作时停止并报告/,
  );
  assert.match(skill, /检查状态和相关 diff，确定提交范围与 message/);
  assert.match(skill, /需要暂存时仅使用精确路径/);
  assert.match(skill, /不使用 `git add \.` 或 `git add -A`/);
  assert.match(skill, /核对完整 staged diff 后正常运行 hooks，创建一个新 commit/);
  assert.match(skill, /验证新 commit，报告 hash、subject 和剩余改动/);
  assert.match(skill, /失败时报告实际的 HEAD、index 和 worktree 状态/);
  assert.match(skill, /优先遵守用户和仓库规范；否则使用中文 Conventional Commit/);
  assert.match(skill, /<type>\(<scope>\): <中文标题>/);
  assert.match(skill, /scope 没有明确模块时省略/);
  assert.match(skill, /body 是供后续检索的变更摘要/);
  assert.match(skill, /非琐碎提交通常写 2–4 条，最多 4 条/);
  assert.match(skill, /可由 diff 或仓库上下文证实的关键事实/);
  assert.match(skill, /合并同类改动，不逐文件复述/);
  assert.match(skill, /不为凑数加入实现噪音/);
  assert.match(skill, /原因或影响没有证据时不推测/);
  assert.match(skill, /琐碎单点改动可省略 body/);
}

function assertCoreMergeContract(skill) {
  assert.match(skill, /检查当前状态和相关历史/);
  assert.match(skill, /仅分析时不得改变 refs、index 或 worktree/);
  assert.match(skill, /若只是 fast-forward 或 already up to date/);
  assert.match(skill, /Clean merge 只证明文本兼容，不证明组合行为正确/);
  assert.match(skill, /跨文件追踪行为、契约和依赖/);
  assert.match(skill, /兼容时保留双方意图/);
  assert.match(skill, /只做具体交互所需的集成修改，不发明行为/);
  assert.match(skill, /运行项目要求的检查，以及能覆盖双方交互的针对性测试/);
  assert.match(skill, /只在用户要求且验证通过后完成/);
  assert.match(skill, /不得在未被要求时推送/);
}

function assertCoreWorktreeContract(skill) {
  assert.match(skill, /已有满足要求的 worktree 或 sandbox；有则复用，不重复创建/);
  assert.match(skill, /共享对象库和多数 refs/);
  assert.match(skill, /需要仓库级隔离时改用独立 clone/);
  assert.match(skill, /只有平台明确提供独立 refs 与对象库时/);
  assert.match(skill, /优先使用平台原生的 worktree\/隔离能力/);
  assert.match(skill, /默认使用仓库根目录下的 `.worktrees\/<分支或任务名>\/`/);
  assert.match(skill, /创建前确认 `.worktrees\/` 已被忽略/);
  assert.match(skill, /不得擅自修改并提交 `.gitignore`/);
  assert.match(skill, /不得 stash、reset、discard 当前无关修改/);
  assert.match(skill, /不得用 force 抢占已有 worktree 或已检出分支/);
  assert.match(skill, /创建失败时不得静默退回当前工作区/);
  assert.match(skill, /确认隔离工作区的路径、基点、分支和初始状态/);
  assert.match(skill, /若已有失败，先报告，不要归因于本次工作/);
  assert.match(skill, /将任务操作及其产生的修改限制在该工作区，并报告路径与分支/);
  assert.match(skill, /仅在用户要求且无未保存工作后使用 `git worktree remove`/);
  assert.match(skill, /不要直接删除目录、强制清理或顺带删除分支/);
}

async function testSkillRenders(context) {
  const [source, mergeSource, worktreeSource] = await Promise.all([
    readFile(path.join(context.sourceRoot, 'skills', 'git-commit', 'SKILL.md'), 'utf8'),
    readFile(
      path.join(context.sourceRoot, 'skills', 'reconciling-git-merges', 'SKILL.md'),
      'utf8',
    ),
    readFile(
      path.join(
        context.sourceRoot,
        'skills',
        'isolating-work-with-git-worktrees',
        'SKILL.md',
      ),
      'utf8',
    ),
  ]);

  assert.match(source, /当用户要求实际创建新的本地 Git commit 时使用/);
  assert.equal(source.includes('user-invocable:'), false);
  assert.equal(source.includes('metadata:'), false);
  assert.match(
    mergeSource,
    /当 Git merge 需要协调双方意图时使用/,
  );
  assert.equal(mergeSource.includes('user-invocable:'), false);
  assert.equal(mergeSource.includes('metadata:'), false);
  assert.match(
    worktreeSource,
    /当任务需要独立 Git 工作目录以保护当前工作区或并行检出另一分支/,
  );
  assert.match(worktreeSource, /不触碰当前未完成工作的情况下处理另一个独立任务/);
  assert.match(worktreeSource, /若现有环境已提供所需隔离则复用/);
  assert.match(worktreeSource, /不要仅因工作区有未提交修改/);
  assert.match(worktreeSource, /继续当前 checkout 中的同一任务且没有隔离需求/);
  assert.match(worktreeSource, /不需要独立 checkout 的只读检查/);
  assert.equal(worktreeSource.includes('user-invocable:'), false);
  assert.equal(worktreeSource.includes('metadata:'), false);

  if (context.platform) {
    const [
      bundledSkill,
      bundledOpenai,
      bundledMergeSkill,
      bundledMergeOpenai,
      bundledWorktreeSkill,
      bundledWorktreeOpenai,
    ] = await Promise.all([
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'git-commit',
          'SKILL.md',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'git-commit',
          'agents',
          'openai.yaml',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'reconciling-git-merges',
          'SKILL.md',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'reconciling-git-merges',
          'agents',
          'openai.yaml',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'isolating-work-with-git-worktrees',
          'SKILL.md',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'isolating-work-with-git-worktrees',
          'agents',
          'openai.yaml',
        ),
        'utf8',
      ),
    ]);
    assert.match(
      bundledOpenai,
      /default_prompt: "使用 \$git-commit 核对当前改动，并按仓库规范完成 Git 提交。"/,
    );
    assert.match(bundledOpenai, /allow_implicit_invocation: true/);
    assert.match(
      bundledMergeOpenai,
      /default_prompt: "使用 \$reconciling-git-merges 协调 Git merge 双方意图并验证组合结果。"/,
    );
    assert.match(bundledMergeOpenai, /allow_implicit_invocation: true/);
    assert.match(
      bundledWorktreeOpenai,
      /default_prompt: "使用 \$isolating-work-with-git-worktrees：安全创建或复用 Git worktree/,
    );
    assert.match(bundledWorktreeOpenai, /allow_implicit_invocation: true/);
    assertCoreCommitContract(bundledSkill);
    assertCoreMergeContract(bundledMergeSkill);
    assertCoreWorktreeContract(bundledWorktreeSkill);
    assert.ok(['codex', 'claude'].includes(context.platform));
    assertRenderedSkill(bundledSkill);
    assertRenderedSkill(bundledMergeSkill);
    assertRenderedSkill(bundledWorktreeSkill);
    return;
  }

  assertCoreCommitContract(source);
  assertCoreMergeContract(mergeSource);
  assertCoreWorktreeContract(worktreeSource);
  assertRenderedSkill(source);
  assertRenderedSkill(mergeSource);
  assertRenderedSkill(worktreeSource);
}

async function testWorkspaceFixture() {
  const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), 'git-commit-fixture-test-'));
  const root = path.join(cleanupRoot, 'project');
  const home = path.join(cleanupRoot, 'home');
  await Promise.all([mkdir(root, { recursive: true }), mkdir(home, { recursive: true })]);
  const context = { workspaceRoot: root, evalCase: {}, env: { ...process.env, HOME: home } };
  try {
    const setup = await setupTriggerWorkspace(context);
    context.env = { ...context.env, ...setup.environment };
    const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'], context.env);
    assert.match(status.stdout, /^M  README\.md$/m);
    assert.match(status.stdout, /^ M src\/app\.ts$/m);
    assert.match(status.stdout, /^\?\? docs\/notes\.md$/m);
    assert.equal(status.stdout.includes('.agents/'), false);
    const initialState = await captureTriggerWorkspaceState(context);
    await writeFile(
      path.join(root, 'docs', 'notes.md'),
      '# Mutated untracked notes\n',
      'utf8',
    );
    assert.notEqual(await captureTriggerWorkspaceState(context), initialState);
    await writeFile(
      path.join(root, 'docs', 'notes.md'),
      '# Untracked notes\n',
      'utf8',
    );
    assert.equal(await captureTriggerWorkspaceState(context), initialState);
  } finally {
    await rm(cleanupRoot, { recursive: true, force: true });
  }
}

async function testHostileGitConfigurationIsIgnored() {
  const hostileRoot = await mkdtemp(path.join(os.tmpdir(), 'git-commit-hostile-git-'));
  const hooksDir = path.join(hostileRoot, 'hooks');
  const sentinelPath = path.join(hostileRoot, 'hook-ran');
  const hookPath = path.join(hooksDir, 'pre-commit');
  const globalConfig = path.join(hostileRoot, 'gitconfig');
  await mkdir(hooksDir, { recursive: true });
  await writeFile(
    hookPath,
    `#!/bin/sh\nprintf ran > "${sentinelPath}"\nexit 1\n`,
    'utf8',
  );
  await chmod(hookPath, 0o755);
  await writeFile(
    globalConfig,
    `[core]\n\thooksPath = ${hooksDir}\n[commit]\n\tgpgSign = true\n`,
    'utf8',
  );

  try {
    const workspaceRoot = path.join(hostileRoot, 'project');
    const isolatedHome = path.join(hostileRoot, 'isolated-home');
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(isolatedHome, { recursive: true }),
    ]);
    const setup = await setupTriggerWorkspace({
      workspaceRoot,
      evalCase: {},
      env: {
        ...process.env,
        HOME: isolatedHome,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: '0',
        GIT_DIR: path.join(hostileRoot, 'redirected.git'),
        GIT_WORK_TREE: hostileRoot,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: hooksDir,
      },
    });
    assert.notEqual(setup.environment.GIT_CONFIG_GLOBAL, globalConfig);
    assert.equal(setup.environment.GIT_DIR, undefined);
    assert.equal(setup.environment.GIT_WORK_TREE, undefined);
    await assert.rejects(readFile(sentinelPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(hostileRoot, { recursive: true, force: true });
  }
}

async function testWorktreeSnapshotTracksUntrackedContent() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-worktree-snapshot-test-'));
  try {
    await initializeRepository(root);
    const scratch = path.join(root, 'scratch.txt');
    await writeFile(scratch, 'original untracked content\n', 'utf8');
    const before = await snapshotWorktreeRepository(root);
    await writeFile(scratch, 'mutated untracked content\n', 'utf8');
    const after = await snapshotWorktreeRepository(root);
    assert.notDeepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testWorktreeIgnoreFixtures() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-worktree-ignore-test-'));
  const ignored = path.join(root, 'ignored');
  const unignored = path.join(root, 'unignored');
  try {
    await Promise.all([mkdir(ignored), mkdir(unignored)]);
    await Promise.all([
      git(ignored, ['init', '--quiet']),
      git(unignored, ['init', '--quiet']),
    ]);
    await Promise.all([
      writeFile(
        path.join(ignored, '.gitignore'),
        `${worktreeIgnoreEntriesForCase('preserve_dirty_workspace_and_use_default_path').join('\n')}\n`,
        'utf8',
      ),
      writeFile(
        path.join(unignored, '.gitignore'),
        `${worktreeIgnoreEntriesForCase('stop_when_default_root_not_ignored').join('\n')}\n`,
        'utf8',
      ),
    ]);
    await git(ignored, ['check-ignore', '--quiet', '--no-index', '.worktrees/probe']);
    await assert.rejects(
      git(unignored, ['check-ignore', '--quiet', '--no-index', '.worktrees/probe']),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createWorktreeTriggerFixture(fixture) {
  const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), 'git-worktree-trigger-fixture-'));
  const workspaceRoot = path.join(cleanupRoot, 'project');
  const home = path.join(cleanupRoot, 'home');
  await Promise.all([
    mkdir(path.join(workspaceRoot, '.agents'), { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  await writeFile(path.join(workspaceRoot, '.agents', 'preserved.txt'), 'control\n', 'utf8');
  const context = {
    workspaceRoot,
    evalCase: { workspace_fixture: fixture },
    env: { ...process.env, HOME: home },
  };
  const setup = await setupWorktreeTriggerWorkspace(context);
  context.env = { ...context.env, ...setup.environment };
  return { cleanupRoot, context };
}

async function testWorktreeTriggerFixtures() {
  const fixtureChecks = [
    ['clean_main', 'main', ''],
    ['dirty_main', 'main', ' M src/form.ts\n'],
    ['dirty_feature', 'feature', ' M src/form.ts\n'],
    [
      'dirty_mixed_feature',
      'feature',
      'M  README.md\n M src/form.ts\n?? notes/local.txt\n',
    ],
    ['commit_ready', 'feature', 'M  src/button.ts\n'],
  ];
  for (const [fixture, expectedBranch, expectedStatus] of fixtureChecks) {
    const { cleanupRoot, context } = await createWorktreeTriggerFixture(fixture);
    try {
      assert.equal((await git(context.workspaceRoot, ['branch', '--show-current'], context.env)).stdout.trim(), expectedBranch);
      assert.equal(
        (await git(
          context.workspaceRoot,
          ['status', '--porcelain=v1', '--untracked-files=all'],
          context.env,
        )).stdout,
        expectedStatus,
      );
      const [originMain, main, originUrl] = await Promise.all([
        git(context.workspaceRoot, ['rev-parse', '--verify', 'refs/remotes/origin/main'], context.env),
        git(context.workspaceRoot, ['rev-parse', '--verify', 'refs/heads/main'], context.env),
        git(context.workspaceRoot, ['remote', 'get-url', 'origin'], context.env),
      ]);
      assert.equal(originMain.stdout, main.stdout);
      assert.notEqual(originUrl.stdout.trim(), '');
      assert.equal(
        await readFile(path.join(context.workspaceRoot, '.agents', 'preserved.txt'), 'utf8'),
        'control\n',
      );
      const state = await captureWorktreeTriggerWorkspaceState(context);
      assert.equal(await captureWorktreeTriggerWorkspaceState(context), state);
    } finally {
      await rm(cleanupRoot, { recursive: true, force: true });
    }
  }

  for (const fixture of ['linked_feature', 'linked_dirty_feature']) {
    const { cleanupRoot, context } = await createWorktreeTriggerFixture(fixture);
    try {
      const worktrees = await git(context.workspaceRoot, ['worktree', 'list', '--porcelain'], context.env);
      assert.equal((worktrees.stdout.match(/^worktree /gm) ?? []).length, 2);
      assert.equal((await git(context.workspaceRoot, ['branch', '--show-current'], context.env)).stdout.trim(), 'feature');
      const status = await git(
        context.workspaceRoot,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        context.env,
      );
      assert.equal(status.stdout, fixture === 'linked_feature' ? '' : ' M src/form.ts\n');
    } finally {
      await rm(cleanupRoot, { recursive: true, force: true });
    }
  }

  const { cleanupRoot, context } = await createWorktreeTriggerFixture('merge_conflict');
  try {
    await git(context.workspaceRoot, ['rev-parse', '--verify', 'MERGE_HEAD'], context.env);
    const status = await git(
      context.workspaceRoot,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      context.env,
    );
    assert.match(status.stdout, /^UU src\/conflict\.ts$/m);
  } finally {
    await rm(cleanupRoot, { recursive: true, force: true });
  }

  const invalidRoot = await mkdtemp(path.join(os.tmpdir(), 'git-worktree-trigger-invalid-'));
  try {
    const workspaceRoot = path.join(invalidRoot, 'project');
    const home = path.join(invalidRoot, 'home');
    await Promise.all([mkdir(workspaceRoot), mkdir(home)]);
    await assert.rejects(
      setupWorktreeTriggerWorkspace({
        workspaceRoot,
        evalCase: { workspace_fixture: 'invented' },
        env: { ...process.env, HOME: home },
      }),
      /Unsupported worktree trigger fixture/,
    );
  } finally {
    await rm(invalidRoot, { recursive: true, force: true });
  }
}

function worktreeExecTrace(commands) {
  return commands.map((command) => JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      exit_code: 0,
      command,
    },
  })).join('\n');
}

function testWorktreeExecTraceAssertions() {
  const safe = inspectWorktreeExecTrace(worktreeExecTrace([
    'git status --short',
    'git stash list',
    'git stash show -p',
    'git worktree add .worktrees/feature origin/main',
    'cd .worktrees/feature && node test.mjs',
  ]));
  assert.deepEqual(safe.prohibited_commands, []);
  assert.deepEqual(safe.requested_test_commands, [
    'cd .worktrees/feature && node test.mjs',
  ]);

  const prohibited = inspectWorktreeExecTrace(worktreeExecTrace([
    'git stash push --include-untracked',
    'git reset --hard HEAD',
    'git worktree add --force .worktrees/feature feature',
    'git -C repo worktree remove -f .worktrees/old',
    'git worktree add -ff .worktrees/feature feature',
    'git worktree add -qf .worktrees/feature feature',
  ]));
  assert.deepEqual(
    prohibited.prohibited_commands.map((entry) => entry.reason),
    [
      'state-changing git stash',
      'git reset',
      'forced git worktree operation',
      'forced git worktree operation',
      'forced git worktree operation',
      'forced git worktree operation',
    ],
  );
}

async function initializeRepository(root) {
  await git(root, ['init', '--quiet']);
  await git(root, ['branch', '-M', 'main']);
  await git(root, ['config', 'user.name', 'Git Behavior Test']);
  await git(root, ['config', 'user.email', 'git-behavior@example.invalid']);
  await writeFile(path.join(root, 'tracked.txt'), 'base\n', 'utf8');
  await git(root, ['add', '--', 'tracked.txt']);
  await git(root, ['commit', '--quiet', '-m', 'chore: initialize repository']);
}

async function testPartialStagingBehavior() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-commit-partial-stage-'));
  try {
    await initializeRepository(root);
    await writeFile(path.join(root, 'tracked.txt'), 'base\nstaged\n', 'utf8');
    await git(root, ['add', '--', 'tracked.txt']);
    await writeFile(
      path.join(root, 'tracked.txt'),
      'base\nstaged\nunstaged\n',
      'utf8',
    );

    await git(root, ['commit', '--quiet', '-m', 'test: commit staged content']);
    const [committed, workingTree, status] = await Promise.all([
      git(root, ['show', 'HEAD:tracked.txt']),
      readFile(path.join(root, 'tracked.txt'), 'utf8'),
      git(root, ['status', '--porcelain=v1']),
    ]);
    assert.equal(committed.stdout, 'base\nstaged\n');
    assert.equal(workingTree, 'base\nstaged\nunstaged\n');
    assert.equal(status.stdout, ' M tracked.txt\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testMergeInProgressDetection() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-commit-merge-state-'));
  try {
    await initializeRepository(root);
    await git(root, ['checkout', '--quiet', '-b', 'feature']);
    await writeFile(path.join(root, 'feature.txt'), 'feature\n', 'utf8');
    await git(root, ['add', '--', 'feature.txt']);
    await git(root, ['commit', '--quiet', '-m', 'feat: add feature']);

    await git(root, ['checkout', '--quiet', 'main']);
    await writeFile(path.join(root, 'main.txt'), 'main\n', 'utf8');
    await git(root, ['add', '--', 'main.txt']);
    await git(root, ['commit', '--quiet', '-m', 'chore: update main']);
    await git(root, ['merge', '--no-commit', '--no-ff', 'feature']);

    const [mergeHead, porcelain, fullStatus] = await Promise.all([
      git(root, ['rev-parse', '--verify', 'MERGE_HEAD']),
      git(root, ['status', '--porcelain=v1']),
      git(root, ['status']),
    ]);
    assert.match(mergeHead.stdout, /^[0-9a-f]{40,64}\n$/);
    assert.equal(porcelain.stdout.includes('merg'), false);
    assert.match(fullStatus.stdout, /you are still merging/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testCherryPickConflictDetection() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-commit-cherry-pick-state-'));
  try {
    await initializeRepository(root);
    await git(root, ['checkout', '--quiet', '-b', 'feature']);
    await writeFile(path.join(root, 'tracked.txt'), 'feature\n', 'utf8');
    await git(root, ['add', '--', 'tracked.txt']);
    await git(root, ['commit', '--quiet', '-m', 'feat: update tracked file']);
    const featureHead = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

    await git(root, ['checkout', '--quiet', 'main']);
    await writeFile(path.join(root, 'tracked.txt'), 'main\n', 'utf8');
    await git(root, ['add', '--', 'tracked.txt']);
    await git(root, ['commit', '--quiet', '-m', 'chore: update tracked file']);
    await assert.rejects(git(root, ['cherry-pick', featureHead]));

    const [cherryPickHead, porcelain, fullStatus] = await Promise.all([
      git(root, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD']),
      git(root, ['status', '--porcelain=v1']),
      git(root, ['status']),
    ]);
    assert.match(cherryPickHead.stdout, /^[0-9a-f]{40,64}\n$/);
    assert.match(porcelain.stdout, /^UU tracked\.txt$/m);
    assert.match(fullStatus.stdout, /cherry-pick/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testMergeEvalAssertions() {
  const goodAnalysis = 'subtotal 返回整数分值，invoice 按元格式化。建议在边界除以 100，并运行 unittest 验证。';
  assert.equal(analysisMessageChecks(goodAnalysis).every((entry) => entry.passed), true);
  assert.equal(
    analysisMessageChecks('仓库未修改。').some((entry) => !entry.passed),
    true,
  );

  const root = await mkdtemp(path.join(os.tmpdir(), 'git-merge-control-paths-'));
  try {
    await initializeRepository(root);
    assert.deepEqual(await committedControlPaths(root), []);
    await mkdir(path.join(root, '.agents'), { recursive: true });
    await writeFile(path.join(root, '.agents', 'control.txt'), 'control\n', 'utf8');
    await git(root, ['add', '--', '.agents/control.txt']);
    await git(root, ['commit', '--quiet', '-m', 'test: add control file']);
    assert.deepEqual(await committedControlPaths(root), ['.agents/control.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const context = await resolveTestContext();
  await testEvalCorpora(context.sourceRoot);
  await testSkillRenders(context);
  await testWorkspaceFixture();
  await testHostileGitConfigurationIsIgnored();
  await testWorktreeSnapshotTracksUntrackedContent();
  await testWorktreeIgnoreFixtures();
  await testWorktreeTriggerFixtures();
  testWorktreeExecTraceAssertions();
  await testPartialStagingBehavior();
  await testMergeInProgressDetection();
  await testCherryPickConflictDetection();
  await testMergeEvalAssertions();
  console.log('git skill eval and Git behavior tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
