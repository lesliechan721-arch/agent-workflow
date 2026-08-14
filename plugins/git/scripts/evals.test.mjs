import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  chmod,
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
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  captureTriggerWorkspaceState,
  setupTriggerWorkspace,
} from '../skills/git-commit/evals/trigger-fixture.mjs';
import {
  commitMessageChecks,
  declaredAssertionCoverage,
  hookFailureMessageChecks,
  inspectCommitExecTrace,
  loadCases as loadCommitCases,
  parseArgs as parseCommitEvalArgs,
  partialMessageExcludesUnstagedFact,
} from '../skills/git-commit/evals/run-commit-evals.mjs';
import {
  analysisMessageChecks,
  ambiguousRetentionChecks,
  committedControlPaths,
  loadCases as loadMergeCases,
  mergeCommitState,
  parseArgs as parseMergeEvalArgs,
  semanticMergeOutcomeChecks,
} from '../skills/reconciling-git-merges/evals/run-merge-evals.mjs';
import {
  captureTriggerWorkspaceState as captureMergeTriggerWorkspaceState,
  setupTriggerWorkspace as setupMergeTriggerWorkspace,
} from '../skills/reconciling-git-merges/evals/trigger-fixture.mjs';
import {
  ignoreEntriesForCase as worktreeIgnoreEntriesForCase,
  inspectExecTrace as inspectWorktreeExecTrace,
  loadCases as loadWorktreeCases,
  parseArgs as parseWorktreeEvalArgs,
  snapshot as snapshotWorktreeRepository,
  worktreeCaseAllowsGitWrites,
  worktreePathsOutsideRoot,
} from '../skills/isolating-work-with-git-worktrees/evals/run-worktree-evals.mjs';
import {
  captureTriggerWorkspaceState as captureWorktreeTriggerWorkspaceState,
  setupTriggerWorkspace as setupWorktreeTriggerWorkspace,
} from '../skills/isolating-work-with-git-worktrees/evals/trigger-fixture.mjs';
import { waitForEvalChild } from './eval-child-process.mjs';
import {
  commandRunsScript,
  gitInvocations,
} from './eval-git-trace.mjs';
import {
  gitMetadataWritableArgs,
  gitMetadataWritableRoots,
} from './eval-git-permissions.mjs';
import { isolateMaterializedSkills } from './eval-participant-skills.mjs';

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
    commitManifestContent,
    mergeTriggerContent,
    mergeEvalContent,
    mergeManifestContent,
    worktreeTriggerContent,
    worktreeDiagnosticTriggerContent,
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
      path.join(sourceRoot, 'skills', 'git-commit', 'evals', 'manifest.json'),
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
        'trigger-diagnostic-cases.json',
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
  const behaviorDocument = JSON.parse(behaviorContent);
  const behaviorCases = behaviorDocument.evals;
  const commitManifest = JSON.parse(commitManifestContent);
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
  assert.match(cases.find((entry) => entry.id === 'specific_files').query, /docs\/notes\.md/);

  assert.equal(behaviorDocument.skill_name, 'git-commit');
  assert.equal(behaviorDocument.policy.optimization, 'critical');
  assert.equal(behaviorDocument.policy.false_negative_cost, 'high');
  assert.equal(behaviorDocument.policy.false_positive_cost, 'high');
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
        (assertion) =>
          typeof assertion?.text === 'string'
          && assertion.text.trim() !== ''
          && assertion.grader === 'script'
          && typeof assertion.grader_check === 'string'
          && assertion.grader_check.trim() !== ''
          && typeof assertion.allowed_variance === 'string'
          && assertion.allowed_variance.trim() !== '',
      ),
      true,
    );
    assert.equal(
      new Set(entry.assertions.map((assertion) => assertion.grader_check)).size,
      entry.assertions.length,
    );
    assert.equal(
      declaredAssertionCoverage(
        entry,
        entry.assertions.map((assertion) => ({ name: assertion.grader_check })),
      ).passed,
      true,
    );
    assert.equal(declaredAssertionCoverage(entry, []).passed, false);
  }
  const expectedBehaviorContracts = new Map([
    [
      'detailed_body_for_nontrivial_change',
      [
        'body 包含 2 到 4 条有排查价值且可由 diff 证实的变更事实',
        'body_is_evidence_based_summary',
      ],
    ],
    [
      'trivial_change_may_omit_body',
      ['允许只使用准确标题而省略 body', 'body_is_not_padded'],
    ],
    [
      'staged_only_with_unstaged_hunks',
      ['message 只描述实际提交内容', 'message_excludes_unstaged_fact'],
    ],
    [
      'unrelated_staged_content',
      [
        '只提交用户指定的两个文件，或在无法安全隔离时停止',
        'requested_scope_or_safe_stop',
      ],
    ],
    ['repository_message_convention', ['优先遵守仓库格式', 'repository_message_format']],
    [
      'commit_and_push_composition',
      ['结果可由外层流程继续 push', 'local_commit_ready_for_outer_push'],
    ],
    [
      'conflict_or_operation_in_progress',
      ['不继续对应历史操作', 'repository_state_preserved'],
    ],
    ['hook_rejection', ['不绕过 hooks', 'hooks_not_bypassed']],
  ]);
  for (const [id, [expectedText, expectedGraderCheck]] of expectedBehaviorContracts) {
    const entry = behaviorCases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required behavior case ${id}`);
    assert.ok(
      entry.assertions.some(
        (assertion) =>
          assertion.text === expectedText && assertion.grader_check === expectedGraderCheck,
      ),
      `Missing required behavior assertion for ${id}`,
    );
  }
  assert.equal(commitManifest.skill, 'git-commit');
  assert.equal(commitManifest.suites.length, 2);
  const commitBehaviorSuite = commitManifest.suites.find((suite) => suite.id === 'behavior');
  assert.equal(commitBehaviorSuite.kind, 'command');
  assert.deepEqual(commitBehaviorSuite.skills, ['git-commit']);
  assert.equal(commitBehaviorSuite.entry, './run-commit-evals.mjs');
  assert.equal(commitBehaviorSuite.cases, './behavior-cases.json');
  assert.equal(commitBehaviorSuite.requiredForRelease, true);
  assert.equal(commitBehaviorSuite.defaultRuns, 3);
  assert.equal(commitBehaviorSuite.suiteTimeoutMs, 16200000);
  assert.deepEqual(
    (await loadCommitCases()).map((entry) => entry.id),
    behaviorCases.map((entry) => entry.id),
  );
  assert.deepEqual(
    parseCommitEvalArgs(['--runs', '2', '--case', 'hook_rejection']),
    {
      runs: 2,
      timeoutMs: 300000,
      codexBin: 'codex',
      model: 'gpt-5.6-luna',
      caseId: 'hook_rejection',
      output: undefined,
      help: false,
    },
  );
  assert.throws(() => parseCommitEvalArgs(['--timeout-ms', '0']), /positive integer/);

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
  assert.equal(routerSuite.fixtureModule, './trigger-fixture.mjs');
  assert.equal(behaviorSuite.kind, 'command');
  assert.deepEqual(behaviorSuite.skills, ['reconciling-git-merges', 'git-commit']);
  assert.equal(behaviorSuite.entry, './run-merge-evals.mjs');
  assert.equal(behaviorSuite.cases, './evals.json');
  assert.equal(behaviorSuite.requiredForRelease, true);
  assert.equal(behaviorSuite.defaultRuns, 3);
  assert.equal(behaviorSuite.suiteTimeoutMs, 9000000);
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
  assert.equal(
    mergeCases.find((entry) => entry.id === 'source_08').workspace_fixture,
    'ambiguous_retention',
  );
  assert.equal(
    mergeCases.find((entry) => entry.id === 'source_09').workspace_fixture,
    'semantic_retry',
  );
  assert.equal(
    mergeCases.find((entry) => entry.id === 'source_10').workspace_fixture,
    'semantic_permissions',
  );
  assert.equal(
    mergeCases.find((entry) => entry.id === 'ordinary_local_commit').workspace_fixture,
    'commit_ready',
  );
  const alignedMergeFixtures = new Map([
    ['source_01', 'ambiguous_retention'],
    ['source_02', 'semantic_retry'],
    ['source_03', 'semantic_permissions'],
    ['source_11', 'fast_forward'],
    ['source_12', 'up_to_date'],
    ['source_13', 'independent_clean_merge'],
    ['source_15', 'same_file_independent_merge'],
    ['source_16', 'rebase_conflict'],
    ['source_17', 'cherry_pick_conflict'],
  ]);
  for (const [id, fixture] of alignedMergeFixtures) {
    const entry = mergeCases.find((candidate) => candidate.id === id);
    assert.equal(entry.workspace_fixture, fixture);
    assert.equal(entry.preconditions.workspace_fixture, fixture);
  }

  const worktreeDocument = JSON.parse(worktreeTriggerContent);
  const worktreeCases = worktreeDocument.cases;
  const worktreeParticipants = new Set([
    'isolating-work-with-git-worktrees',
    'reconciling-git-merges',
    'git-commit',
  ]);
  assert.equal(worktreeDocument.schemaVersion, 1);
  assert.equal(worktreeDocument.skill, 'isolating-work-with-git-worktrees');
  assert.equal(worktreeDocument.policy.optimization, 'recall-first');
  assert.equal(worktreeDocument.policy.false_negative_cost, 'high');
  assert.equal(worktreeDocument.policy.false_positive_cost, 'medium');
  assert.equal(worktreeCases.length, 28);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'train').length, 13);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'validation').length, 6);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'sanity').length, 9);
  assert.equal(new Set(worktreeCases.map((entry) => entry.id)).size, worktreeCases.length);
  assert.equal(
    worktreeCases.filter((entry) =>
      entry.expected_loaded_skills.includes('isolating-work-with-git-worktrees'),
    ).length,
    15,
  );
  assert.equal(
    worktreeCases.filter((entry) => entry.expected_loaded_skills.length === 0).length,
    10,
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
  const worktreeDiagnosticDocument = JSON.parse(worktreeDiagnosticTriggerContent);
  assert.equal(worktreeDiagnosticDocument.policy.optimization, 'recall-first');
  assert.equal(worktreeDiagnosticDocument.policy.false_positive_cost, 'low');
  assert.deepEqual(
    worktreeDiagnosticDocument.cases.map((entry) => entry.id),
    ['source_15', 'sanity_full_clone'],
  );
  const fullCloneDiagnostic = worktreeDiagnosticDocument.cases.find(
    (entry) => entry.id === 'source_15',
  );
  assert.equal(fullCloneDiagnostic.case_role, 'diagnostic');
  assert.equal(fullCloneDiagnostic.oracle.confidence, 'medium');
  assert.match(fullCloneDiagnostic.oracle.rationale, /expected-tradeoff/);
  const fullCloneSanityDiagnostic = worktreeDiagnosticDocument.cases.find(
    (entry) => entry.id === 'sanity_full_clone',
  );
  assert.equal(fullCloneSanityDiagnostic.split, 'sanity');
  assert.equal(fullCloneSanityDiagnostic.case_role, 'diagnostic');
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
  assert.equal(worktreeEvals.policy.optimization, 'critical');
  assert.deepEqual(
    worktreeEvals.evals.map((entry) => entry.id),
    [
      'preserve_dirty_workspace_and_use_default_path',
      'stop_when_default_root_not_ignored',
      'reuse_existing_isolation',
      'use_full_clone_for_repository_level_isolation',
      'report_dirty_baseline',
    ],
  );
  for (const entry of worktreeEvals.evals) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.prompt, 'string');
    assert.equal(typeof entry.expected_output, 'string');
  }
  assert.equal(worktreeManifest.skill, 'isolating-work-with-git-worktrees');
  assert.equal(worktreeManifest.suites.length, 3);
  const worktreeRouterSuite = worktreeManifest.suites.find((suite) => suite.id === 'router');
  const worktreeDiagnosticRouterSuite = worktreeManifest.suites.find(
    (suite) => suite.id === 'router-diagnostic',
  );
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
  assert.equal(worktreeDiagnosticRouterSuite.kind, 'trigger');
  assert.equal(
    worktreeDiagnosticRouterSuite.cases,
    './trigger-diagnostic-cases.json',
  );
  assert.deepEqual(worktreeDiagnosticRouterSuite.releaseSplits, []);
  assert.equal(worktreeDiagnosticRouterSuite.requiredForRelease, false);
  assert.equal(worktreeBehaviorSuite.kind, 'command');
  assert.deepEqual(worktreeBehaviorSuite.skills, [
    'isolating-work-with-git-worktrees',
    'reconciling-git-merges',
    'git-commit',
  ]);
  assert.equal(worktreeBehaviorSuite.entry, './run-worktree-evals.mjs');
  assert.equal(worktreeBehaviorSuite.cases, './evals.json');
  assert.equal(worktreeBehaviorSuite.requiredForRelease, true);
  assert.equal(worktreeBehaviorSuite.defaultRuns, 3);
  assert.equal(worktreeBehaviorSuite.suiteTimeoutMs, 10800000);
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
  assert.equal(worktreeCaseAllowsGitWrites('stop_when_default_root_not_ignored'), true);
  assert.equal(
    worktreeCaseAllowsGitWrites('use_full_clone_for_repository_level_isolation'),
    true,
  );
  assert.equal(worktreeCaseAllowsGitWrites('reuse_existing_isolation'), false);
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
  assert.match(skill, /合并提交必须包含双方意图协调和组合验证所需的集成修正/);
  assert.match(skill, /不得把未经组合验证的合并结果与后续集成修正拆成多个提交/);
  assert.match(skill, /合并提交属于本技能的完成步骤，不转交其他 Skill/);
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
  assert.match(worktreeSource, /需要独立 refs\/对象库的完整仓库隔离/);
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

async function testGitMetadataWritableRoots() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'git-eval-permissions-'));
  const primary = path.join(tempRoot, 'primary');
  const linked = path.join(tempRoot, 'linked');
  try {
    await mkdir(primary);
    await initializeRepository(primary);
    const primaryGitDir = await realpath(path.join(primary, '.git'));
    assert.deepEqual(
      await gitMetadataWritableRoots(primary, tempRoot),
      [primaryGitDir],
    );
    assert.deepEqual(
      await gitMetadataWritableArgs(primary, tempRoot),
      ['--add-dir', primaryGitDir],
    );

    await git(primary, ['branch', 'feature']);
    await git(primary, ['worktree', 'add', '--quiet', linked, 'feature']);
    const linkedRoots = await gitMetadataWritableRoots(linked, tempRoot);
    assert.equal(linkedRoots.length, 2);
    assert.ok(linkedRoots.includes(primaryGitDir));
    assert.ok(linkedRoots.some((entry) => entry.includes(`${path.sep}worktrees${path.sep}`)));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function testMergeTriggerFixtures() {
  const expectations = new Map([
    ['ambiguous_retention', { status: /^UU retention\.py$/m, operation: 'merge' }],
    ['semantic_retry', { status: /^M  idempotency\.py$/m, operation: 'merge' }],
    ['semantic_permissions', { status: /^UU conflict\.txt$/m, operation: 'merge' }],
    ['commit_ready', { status: /^M  change\.txt$/m }],
    ['fast_forward', { status: /^$/u, relation: 'fast-forward' }],
    ['up_to_date', { status: /^$/u, relation: 'up-to-date' }],
    ['independent_clean_merge', { status: /^$/u, relation: 'clean-merge' }],
    ['same_file_independent_merge', { status: /^$/u, relation: 'clean-merge' }],
    ['rebase_conflict', { status: /^UU conflict\.txt$/m, operation: 'rebase' }],
    ['cherry_pick_conflict', { status: /^UU conflict\.txt$/m, operation: 'cherry-pick' }],
  ]);
  for (const [fixture, expectation] of expectations) {
    const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), 'git-merge-trigger-fixture-'));
    const workspaceRoot = path.join(cleanupRoot, 'project');
    const home = path.join(cleanupRoot, 'home');
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    const context = {
      workspaceRoot,
      evalCase: { workspace_fixture: fixture },
      env: { ...process.env, HOME: home },
    };
    try {
      const setup = await setupMergeTriggerWorkspace(context);
      context.env = { ...context.env, ...setup.environment };
      const status = await git(
        workspaceRoot,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        context.env,
      );
      assert.match(status.stdout, expectation.status);
      if (expectation.operation === 'merge') {
        const mergeHead = await git(
          workspaceRoot,
          ['rev-parse', '--verify', 'MERGE_HEAD'],
          context.env,
        );
        assert.match(mergeHead.stdout, /^[0-9a-f]{40,64}\n$/);
      } else if (expectation.operation === 'rebase') {
        const fullStatus = await git(workspaceRoot, ['status'], context.env);
        assert.match(fullStatus.stdout, /rebase in progress/iu);
      } else if (expectation.operation === 'cherry-pick') {
        const cherryPickHead = await git(
          workspaceRoot,
          ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'],
          context.env,
        );
        assert.match(cherryPickHead.stdout, /^[0-9a-f]{40,64}\n$/);
      } else if (expectation.relation === 'fast-forward') {
        const [main, feature] = await Promise.all([
          git(workspaceRoot, ['rev-parse', 'main'], context.env),
          git(workspaceRoot, ['rev-parse', 'feature'], context.env),
        ]);
        assert.notEqual(main.stdout, feature.stdout);
        await git(workspaceRoot, ['merge-base', '--is-ancestor', 'main', 'feature'], context.env);
      } else if (expectation.relation === 'up-to-date') {
        const [main, feature] = await Promise.all([
          git(workspaceRoot, ['rev-parse', 'main'], context.env),
          git(workspaceRoot, ['rev-parse', 'feature'], context.env),
        ]);
        assert.equal(main.stdout, feature.stdout);
      } else if (expectation.relation === 'clean-merge') {
        await git(workspaceRoot, ['merge', '--no-commit', '--no-ff', 'feature'], context.env);
        await git(workspaceRoot, ['merge', '--abort'], context.env);
      }
      assert.equal(
        await captureMergeTriggerWorkspaceState(context),
        await captureMergeTriggerWorkspaceState(context),
      );
    } finally {
      await rm(cleanupRoot, { recursive: true, force: true });
    }
  }
}

async function testParticipantSkillIsolation() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-eval-participants-'));
  const agentsRoot = path.join(root, '.agents');
  const skillsRoot = path.join(agentsRoot, 'skills');
  const previous = process.env.AW_PLUGIN_EVAL_PARTICIPANT_SKILLS;
  try {
    for (const skill of ['git-commit', 'reconciling-git-merges', 'unrelated-skill']) {
      await mkdir(path.join(skillsRoot, skill), { recursive: true });
      await writeFile(path.join(skillsRoot, skill, 'SKILL.md'), `${skill}\n`, 'utf8');
    }
    process.env.AW_PLUGIN_EVAL_PARTICIPANT_SKILLS = JSON.stringify([
      'git-commit',
      'reconciling-git-merges',
    ]);
    await isolateMaterializedSkills(agentsRoot, 'git-commit', true);
    await assert.rejects(
      readFile(path.join(skillsRoot, 'unrelated-skill', 'SKILL.md'), 'utf8'),
      /ENOENT/,
    );
    assert.equal(
      await readFile(path.join(skillsRoot, 'git-commit', 'SKILL.md'), 'utf8'),
      'git-commit\n',
    );

    await isolateMaterializedSkills(agentsRoot, 'git-commit', false);
    await assert.rejects(
      readFile(path.join(skillsRoot, 'git-commit', 'SKILL.md'), 'utf8'),
      /ENOENT/,
    );
    assert.equal(
      await readFile(path.join(skillsRoot, 'reconciling-git-merges', 'SKILL.md'), 'utf8'),
      'reconciling-git-merges\n',
    );
  } finally {
    if (previous === undefined) delete process.env.AW_PLUGIN_EVAL_PARTICIPANT_SKILLS;
    else process.env.AW_PLUGIN_EVAL_PARTICIPANT_SKILLS = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function testCommitExecTraceAssertions() {
  const events = [
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: "/bin/zsh -lc 'git reset --soft HEAD^ && git status --short'",
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: "/bin/zsh -lc 'git commit --no-verify -m test && git push origin main'",
      },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const unsafe = inspectCommitExecTrace(events);
  assert.equal(unsafe.reset_index, true);
  assert.equal(unsafe.bypassed_hooks, true);
  assert.equal(unsafe.pushed, true);
  const safe = inspectCommitExecTrace(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'git status --short' },
  }));
  assert.equal(safe.reset_index, false);
  assert.equal(safe.bypassed_hooks, false);
  assert.equal(safe.pushed, false);

  const gitDirectoryOptions = inspectCommitExecTrace([
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: "/bin/zsh -lc 'git -C . reset --soft HEAD^ && git -C . push origin probe'",
      },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  assert.equal(gitDirectoryOptions.reset_index, true);
  assert.equal(gitDirectoryOptions.pushed, true);

  assert.deepEqual(
    gitInvocations("/bin/zsh -lc '(git -C . reset --hard HEAD)'")
      .map((invocation) => invocation.subcommand),
    ['reset'],
  );
  assert.deepEqual(
    gitInvocations("/bin/zsh -lc 'git commit -m \"keep && literal\" && git status'")
      .map((invocation) => invocation.subcommand),
    ['commit', 'status'],
  );
  assert.equal(
    commandRunsScript(
      "/bin/zsh -lc 'cd .worktrees/feature && node ./test.mjs'",
      'node',
      'test.mjs',
    ),
    true,
  );
  const observedNestedQuoteCommand = String.raw`/bin/zsh -lc 'node test.mjs; test_status=$?; printf '"'TEST_EXIT=%s\\n' \""'$test_status"; git diff -- app.txt; git status --short --branch; printf '"'\\nMAIN_STATUS\\n'; git -C ../.. status --short --branch"`;
  assert.equal(
    commandRunsScript(observedNestedQuoteCommand, 'node', 'test.mjs'),
    true,
  );
  assert.equal(
    commandRunsScript("/bin/zsh -lc 'echo \"node test.mjs\"'", 'node', 'test.mjs'),
    false,
  );
}

function testCommitMessageAssertions() {
  const detailed = [
    'feat: activate the application',
    '',
    '- Switch the application runtime flag from false to true and align test expectations',
    '- Mark the guide feature as enabled and bump 1.0.0 to 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', detailed)
      .every((check) => check.passed),
    true,
  );
  const detailedChinese = [
    'feat: 启用应用功能',
    '',
    '- 将应用开关改为启用并同步测试预期',
    '- 更新指南中的启用状态并将版本从 1.0.0 升至 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', detailedChinese)
      .every((check) => check.passed),
    true,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      `${detailedChinese}\n- 解决线上事故并关联 issue #42`,
    ).find((check) => check.name === 'unverifiable_external_claims_absent').passed,
    false,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      `${detailed}\n- Update the database schema for the application feature`,
    ).find((check) => check.name === 'all_body_bullets_match_fixture_facts').passed,
    false,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      [
        'feat: activate the application',
        '',
        '- Switch the application runtime flag from false to true and align test expectations',
        '- Mark the guide feature as enabled and bump 1.0.0 to 1.1.0',
        '- Enable the application feature and update the database schema',
      ].join('\n'),
    ).find((check) => check.name === 'all_body_bullets_match_fixture_facts').passed,
    false,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      `${detailed}\n- Improve security for the application feature`,
    ).find((check) => check.name === 'unverifiable_external_claims_absent').passed,
    false,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      [
        'feat: activate the application',
        '',
        '- Enable the application runtime flag',
        '- Align test expectations',
        '- Mark the guide feature as enabled',
        '- Bump 1.0.0 to 1.1.0',
      ].join('\n'),
    ).find((check) => check.name === 'body_avoids_per_file_restatement').passed,
    false,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      [
        'feat: 启用功能并同步版本',
        '',
        '- 将应用功能开关及对应测试期望值切换为启用状态',
        '- 更新使用指南以反映功能已启用',
        '- 将项目版本从 1.0.0 升级至 1.1.0',
      ].join('\n'),
    ).every((check) => check.passed),
    true,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      [
        'feat: 启用功能并升级版本',
        '',
        '- 将应用功能开关设为启用状态，并把期望值同步为 true',
        '- 更新使用指南以反映功能已启用',
        '- 将版本号从 1.0.0 升至 1.1.0',
      ].join('\n'),
    ).every((check) => check.passed),
    true,
  );
  const perFileRestatement = [
    'feat: 启用应用功能',
    '',
    '- 在 src/app.js 启用应用功能',
    '- 在 tests/app.test.js 将测试预期更新为 true',
    '- 在 docs/guide.md 说明功能已启用',
    '- 将 VERSION 从 1.0.0 更新为 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', perFileRestatement)
      .find((check) => check.name === 'body_avoids_per_file_restatement').passed,
    false,
  );
  const crossGroupedSummary = [
    'feat: activate the application',
    '',
    '- Enable the application runtime flag and update guide documentation to show it enabled',
    '- Align test expectations and bump 1.0.0 to 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', crossGroupedSummary)
      .every((check) => check.passed),
    true,
  );
  const applicationGuideRestatement = [
    'feat: activate the application',
    '',
    '- Enable the application runtime flag',
    '- Align test expectations',
    '- Update the application guide to show it enabled',
    '- Bump 1.0.0 to 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', applicationGuideRestatement)
      .find((check) => check.name === 'body_avoids_per_file_restatement').passed,
    false,
  );
  for (const docsBullet of [
    '- 更新应用功能指南，说明功能已启用',
    '- Update the application feature guide to show it enabled',
  ]) {
    const featureGuideRestatement = [
      'feat: 启用应用功能',
      '',
      '- 启用应用运行时开关',
      '- 更新测试预期为 true',
      docsBullet,
      '- 将版本从 1.0.0 升至 1.1.0',
    ].join('\n');
    assert.equal(
      commitMessageChecks('detailed_body_for_nontrivial_change', featureGuideRestatement)
        .find((check) => check.name === 'body_avoids_per_file_restatement').passed,
      false,
    );
  }
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook 失败，未创建 commit。HEAD 未变，index 仍 staged，worktree clean。',
    ).every((check) => check.passed),
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook failed; no commit was created. HEAD is unchanged; staged changes remain in the index; working tree is clean.',
    ).every((check) => check.passed),
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook failed; no commit created. HEAD unchanged; staged changes remain in the index; working tree clean.',
    ).every((check) => check.passed),
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook failed; no commit created. HEAD unchanged; staged changes remain in the index, working tree clean.',
    ).every((check) => check.passed),
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook failed; no commit created. HEAD unchanged; staged changes remain in the index; working tree is clean.',
    ).find((check) => check.name === 'does_not_claim_commit_success').passed,
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook 失败，没有创建提交。HEAD 未改变；已暂存修改仍保留在 index；工作树干净。',
    ).every((check) => check.passed),
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook 失败，未创建提交。HEAD 未变；暂存修改仍在 index；工作树干净。',
    ).every((check) => check.passed),
    true,
  );
  const observedHookFailure = [
    '提交未创建：pre-commit hook 已拒绝提交，且未绕过 hook。',
    '',
    '- HEAD 仍为 `3657841 chore: initialize commit fixture`',
    '- `src/app.js` 改动仍保持暂存状态',
    '- 工作区没有额外未暂存改动',
  ].join('\n');
  assert.equal(
    hookFailureMessageChecks(observedHookFailure, '3657841abcdef').every((check) => check.passed),
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      observedHookFailure.replace('3657841', 'deadbee'),
      '3657841abcdef',
    ).find((check) => check.name === 'reports_actual_repository_state').passed,
    false,
  );
  assert.equal(
    hookFailureMessageChecks('pre-commit hook 失败，但 commit 成功。')
      .find((check) => check.name === 'does_not_claim_commit_success').passed,
    false,
  );
  assert.equal(
    partialMessageExcludesUnstagedFact('chore: 记录选定的暂存内容'),
    true,
  );
  assert.equal(
    partialMessageExcludesUnstagedFact('chore: Update the work value to the pending local setting'),
    false,
  );
  assert.equal(
    hookFailureMessageChecks(
      'pre-commit hook 失败。HEAD advanced，index is clean，worktree is clean。',
    ).find((check) => check.name === 'reports_actual_repository_state').passed,
    false,
  );
  assert.equal(
    commitMessageChecks(
      'detailed_body_for_nontrivial_change',
      'feat: enable feature\n\n- Update runtime and tests\n- Update docs to 1.1.0',
    ).some((check) => !check.passed),
    true,
  );
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', 'x\n\n- foo\n- bar')
      .some((check) => !check.passed),
    true,
  );
  const accurateSubjects = new Map([
    ['trivial_change_may_omit_body', 'docs: 修正 README 拼写'],
    ['staged_only_with_unstaged_hunks', 'chore: 提交选定的暂存修改'],
    ['unrelated_staged_content', 'chore: 更新 requested 文件'],
    ['repository_message_convention', '[docs] 更新安装指南'],
    ['commit_and_push_composition', 'feat: 启用应用功能'],
  ]);
  const genericSubjects = new Map([
    ['trivial_change_may_omit_body', 'docs: docs'],
    ['staged_only_with_unstaged_hunks', 'chore: staged'],
    ['unrelated_staged_content', 'chore: requested'],
    ['repository_message_convention', '[docs] docs'],
    ['commit_and_push_composition', 'feat: feature'],
  ]);
  for (const [caseId, message] of accurateSubjects) {
    assert.equal(commitMessageChecks(caseId, message).every((check) => check.passed), true);
    assert.equal(commitMessageChecks(caseId, 'x').some((check) => !check.passed), true);
    assert.equal(
      commitMessageChecks(caseId, genericSubjects.get(caseId))
        .some((check) => !check.passed),
      true,
    );
  }
  assert.equal(
    commitMessageChecks('unrelated_staged_content', '修改 requested 文件')
      .every((check) => check.passed),
    true,
  );
}

async function testEvalChildTimeout() {
  const descendantProgram = process.platform === 'win32'
    ? "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"
    : "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
  const program = [
    "const { spawn } = require('node:child_process');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
    "descendant.stdout.once('data', () => process.stdout.write(String(descendant.pid) + '\\n'));",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const child = spawn(process.execPath, ['-e', program], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const firstOutput = await new Promise((resolve) => child.stdout.once('data', resolve));
  const descendantPid = Number(firstOutput.toString().trim());
  const startedAt = Date.now();
  const result = await waitForEvalChild(child, 30, { forceKillAfterMs: 60 });
  assert.equal(result.timedOut, true);
  if (process.platform !== 'win32') {
    assert.equal(result.signal, 'SIGTERM');
    assert.ok(Date.now() - startedAt >= 60);
  }
  assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
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

async function testWorktreeExecTraceAssertions() {
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
  assert.equal(safe.pushed, false);

  const prohibited = inspectWorktreeExecTrace(worktreeExecTrace([
    'git stash push --include-untracked',
    'git reset --hard HEAD',
    'git worktree add --force .worktrees/feature feature',
    'git -C repo worktree remove -f .worktrees/old',
    'git worktree add -ff .worktrees/feature feature',
    'git worktree add -qf .worktrees/feature feature',
    'cd "$TMPDIR/full-clone" && git push --force origin main',
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
  assert.equal(prohibited.pushed, true);

  const evalRoot = path.resolve(os.tmpdir(), 'worktree-eval-root');
  assert.deepEqual(
    worktreePathsOutsideRoot([
      `worktree ${path.join(evalRoot, 'repo')}`,
      `worktree ${path.join(evalRoot, 'repo', '.worktrees', 'feature')}`,
      '',
    ].join('\n'), evalRoot),
    [],
  );
  assert.deepEqual(
    worktreePathsOutsideRoot(`worktree ${path.resolve(os.tmpdir(), 'outside-worktree')}\n`, evalRoot),
    [path.resolve(os.tmpdir(), 'outside-worktree')],
  );

  const createdRoot = await mkdtemp(path.join(os.tmpdir(), 'git-worktree-containment-'));
  const canonicalRoot = await realpath(createdRoot);
  try {
    const repo = path.join(canonicalRoot, 'repo');
    await mkdir(repo);
    await initializeRepository(repo);
    await git(repo, ['branch', 'feature']);
    await git(repo, [
      'worktree', 'add', '--quiet', path.join(canonicalRoot, 'linked'), 'feature',
    ]);
    const worktrees = await git(repo, ['worktree', 'list', '--porcelain']);
    assert.deepEqual(worktreePathsOutsideRoot(worktrees.stdout, canonicalRoot), []);
  } finally {
    await rm(canonicalRoot, { recursive: true, force: true });
  }
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

  const unresolvedRetention = [
    '<<<<<<< HEAD',
    'RETENTION_DAYS = 7',
    '=======',
    'RETENTION_DAYS = 90',
    '>>>>>>> origin/feature',
    '',
  ].join('\n');
  assert.equal(
    ambiguousRetentionChecks(
      unresolvedRetention,
      '7 天隐私保留与 90 天审计保留不兼容，仓库证据不足，需要产品决定优先级。',
    ).every((entry) => entry.passed),
    true,
  );
  assert.equal(
    ambiguousRetentionChecks(
      unresolvedRetention,
      [
        'main 要求保留 7 天，origin/feature 要求保留 90 天，两者不兼容。',
        'README 明确说明产品需求尚未确定，仓库没有证据支持优先选择任一策略。',
        '请提供权威决策后，我再解决冲突并运行测试。',
      ].join('\n'),
    ).every((entry) => entry.passed),
    true,
  );
  assert.equal(
    ambiguousRetentionChecks(
      unresolvedRetention,
      [
        'main 要求保留 7 天，origin/feature 要求保留 90 天。',
        'README 明确说明需求尚未确定，仓库没有证据支持选择任一策略。',
        '因此未擅自解决或提交，合并保持暂停。',
      ].join('\n'),
    ).every((entry) => entry.passed),
    true,
  );
  assert.equal(
    ambiguousRetentionChecks(
      'RETENTION_DAYS = 30\n',
      '7 天与 90 天冲突，因此选择 30 天折中。',
    ).some((entry) => !entry.passed),
    true,
  );
  assert.equal(
    ambiguousRetentionChecks(
      [
        'RETENTION_DAYS = 30',
        '# <<<<<<< HEAD',
        '# RETENTION_DAYS = 7',
        '# =======',
        '# RETENTION_DAYS = 90',
        '# >>>>>>> origin/feature',
        '',
      ].join('\n'),
      '7 天与 90 天不兼容，仓库证据不足，需要产品决定优先级。',
    ).some((entry) => !entry.passed),
    true,
  );
  assert.equal(
    ambiguousRetentionChecks(
      [
        'RETENTION_DAYS: int = 30',
        'CONFLICT_NOTE = """',
        '<<<<<<< HEAD',
        'RETENTION_DAYS = 7',
        '=======',
        'RETENTION_DAYS = 90',
        '>>>>>>> origin/feature',
        '"""',
        '',
      ].join('\n'),
      '7 天与 90 天不兼容，仓库证据不足，需要产品决定优先级。',
    ).some((entry) => !entry.passed),
    true,
  );
  assert.equal(
    ambiguousRetentionChecks(
      unresolvedRetention,
      '7 天与 90 天不兼容，但先保持冲突。',
    ).find((entry) => entry.name === 'requires_product_decision').passed,
    false,
  );

  const semanticRoot = await mkdtemp(path.join(os.tmpdir(), 'git-merge-semantic-oracle-'));
  try {
    await writeFile(
      path.join(semanticRoot, 'logger.py'),
      [
        'class Logger:',
        '    def __init__(self):',
        '        self.entries = []',
        '    def log(self, message):',
        '        self.entries.append(message)',
        '    def log_all(self, messages):',
        '        if type(self) is Logger:',
        '            self.entries.extend(messages)',
        '        else:',
        '            for message in messages:',
        '                self.log(message)',
        '',
        'class FilteredLogger(Logger):',
        '    def log(self, message):',
        "        if 'secret' not in message:",
        '            super().log(message)',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.equal(
      (await semanticMergeOutcomeChecks(semanticRoot, 'semantic_same_file'))
        .every((entry) => entry.passed),
      true,
    );
    await writeFile(
      path.join(semanticRoot, 'logger.py'),
      [
        'class Logger:',
        '    def __init__(self):',
        '        self.entries = []',
        '    def log(self, message):',
        '        self.entries.append(message)',
        '    def log_all(self, messages):',
        '        self.entries.extend(messages)',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.equal(
      (await semanticMergeOutcomeChecks(semanticRoot, 'semantic_same_file'))
        .some((entry) => !entry.passed),
      true,
    );

    await writeFile(
      path.join(semanticRoot, 'pricing.py'),
      'def subtotal(prices):\n    return sum(round(price * 100) for price in prices)\n',
      'utf8',
    );
    await writeFile(
      path.join(semanticRoot, 'invoice.py'),
      "from pricing import subtotal\n\ndef render_total(prices):\n    return f'${subtotal(prices) / 100:.2f}'\n",
      'utf8',
    );
    assert.equal(
      (await semanticMergeOutcomeChecks(semanticRoot, 'semantic_cross_file'))
        .every((entry) => entry.passed),
      true,
    );
    await writeFile(
      path.join(semanticRoot, 'invoice.py'),
      "from pricing import subtotal\n\ndef render_total(prices):\n    return f'${subtotal(prices):.2f}'\n",
      'utf8',
    );
    assert.equal(
      (await semanticMergeOutcomeChecks(semanticRoot, 'semantic_cross_file'))
        .some((entry) => !entry.passed),
      true,
    );
  } finally {
    await rm(semanticRoot, { recursive: true, force: true });
  }

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

  const mergeRoot = await mkdtemp(path.join(os.tmpdir(), 'git-merge-topology-'));
  try {
    await initializeRepository(mergeRoot);
    await git(mergeRoot, ['checkout', '--quiet', '-b', 'feature']);
    await writeFile(path.join(mergeRoot, 'feature.txt'), 'feature\n', 'utf8');
    await git(mergeRoot, ['add', '--', 'feature.txt']);
    await git(mergeRoot, ['commit', '--quiet', '-m', 'feat: add feature']);
    await git(mergeRoot, ['checkout', '--quiet', 'main']);
    await writeFile(path.join(mergeRoot, 'main.txt'), 'main\n', 'utf8');
    await git(mergeRoot, ['add', '--', 'main.txt']);
    await git(mergeRoot, ['commit', '--quiet', '-m', 'chore: update main']);
    const beforeHead = (await git(mergeRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(mergeRoot, ['merge', '--quiet', '--no-edit', 'feature']);
    assert.deepEqual(
      await mergeCommitState(mergeRoot, beforeHead),
      { mainlineCount: 1, parentCount: 2 },
    );
  } finally {
    await rm(mergeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const context = await resolveTestContext();
  await testEvalCorpora(context.sourceRoot);
  await testSkillRenders(context);
  await testWorkspaceFixture();
  await testHostileGitConfigurationIsIgnored();
  await testWorktreeSnapshotTracksUntrackedContent();
  await testGitMetadataWritableRoots();
  await testMergeTriggerFixtures();
  await testParticipantSkillIsolation();
  await testEvalChildTimeout();
  await testWorktreeIgnoreFixtures();
  await testWorktreeTriggerFixtures();
  await testWorktreeExecTraceAssertions();
  await testPartialStagingBehavior();
  await testMergeInProgressDetection();
  await testCherryPickConflictDetection();
  await testMergeEvalAssertions();
  testCommitExecTraceAssertions();
  testCommitMessageAssertions();
  console.log('git skill eval and Git behavior tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
