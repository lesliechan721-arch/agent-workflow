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

import commitTriggerDocument from '../skills/git-commit/evals/trigger-cases.json' with { type: 'json' };
import commitBehaviorDocument from '../skills/git-commit/evals/behavior-cases.json' with { type: 'json' };
import commitManifestDocument from '../skills/git-commit/evals/manifest.json' with { type: 'json' };
import mergeTriggerDocument from '../skills/reconciling-git-merges/evals/trigger-cases.json' with { type: 'json' };
import mergeEvalDocument from '../skills/reconciling-git-merges/evals/evals.json' with { type: 'json' };
import mergeManifestDocument from '../skills/reconciling-git-merges/evals/manifest.json' with { type: 'json' };
import worktreeTriggerDocument from '../skills/isolating-work-with-git-worktrees/evals/trigger-cases.json' with { type: 'json' };
import worktreeDiagnosticDocument from '../skills/isolating-work-with-git-worktrees/evals/trigger-diagnostic-cases.json' with { type: 'json' };
import worktreeEvalDocument from '../skills/isolating-work-with-git-worktrees/evals/evals.json' with { type: 'json' };
import worktreeManifestDocument from '../skills/isolating-work-with-git-worktrees/evals/manifest.json' with { type: 'json' };

import {
  captureTriggerWorkspaceState,
  setupTriggerWorkspace,
} from '../skills/git-commit/evals/trigger-fixture.mjs';
import {
  commitMessageChecks,
  declaredAssertionCoverage,
  hookFailureMessageChecks,
  inspectCommitExecTrace,
  partialMessageExcludesUnstagedFact,
} from '../skills/git-commit/evals/run-commit-evals.mjs';
import {
  analysisMessageChecks,
  ambiguousRetentionChecks,
  committedControlPaths,
  mergeCommitState,
  semanticMergeOutcomeChecks,
} from '../skills/reconciling-git-merges/evals/run-merge-evals.mjs';
import {
  captureTriggerWorkspaceState as captureMergeTriggerWorkspaceState,
  setupTriggerWorkspace as setupMergeTriggerWorkspace,
} from '../skills/reconciling-git-merges/evals/trigger-fixture.mjs';
import {
  ignoreEntriesForCase as worktreeIgnoreEntriesForCase,
  inspectExecTrace as inspectWorktreeExecTrace,
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
      bundleRoot: bundledPluginRoot,
      platform: null,
    };
  }
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  const bundleRoot = path.resolve(context.plugin.rootDir);
  const bundleManifest = JSON.parse(await readFile(
    path.join(bundleRoot, '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(context.plugin.name, 'git-toolkit');
  assert.equal(context.plugin.version, bundleManifest.version);
  assert.equal(context.event, 'test');
  return {
    bundleRoot,
    platform: context.platform,
  };
}

async function assertCustomProcessManifest(manifest, bundleRoot, expectedSkill, expectedCommands) {
  assert.equal(manifest.version, 1);
  const customProcessSuites = manifest.suites.filter((suite) => suite.kind === 'custom-process');
  assert.deepEqual(
    customProcessSuites.map((suite) => suite.id),
    [...expectedCommands.keys()],
  );
  const evalRoot = path.join(bundleRoot, 'skills', expectedSkill, 'evals');
  for (const suite of customProcessSuites) {
    assert.equal(suite.kind, 'custom-process');
    assert.equal(Object.hasOwn(suite, 'entry'), false);
    assert.equal(Object.hasOwn(suite, 'supports'), false);
    assert.equal(Object.hasOwn(suite, 'suiteTimeoutMs'), false);
    assert.equal(Object.hasOwn(suite, 'command'), false);
    assert.ok(suite.provider && typeof suite.provider === 'object');
    const provider = suite.provider;
    assert.equal(provider.type, 'custom-process');
    assert.deepEqual(provider.command, expectedCommands.get(suite.id));
    for (const field of ['id', 'entry', 'assets', 'credentialEnvironment', 'capabilities', 'describe']) {
      assert.equal(Object.hasOwn(provider, field), false);
    }
    assert.equal(typeof suite.cases, 'string');
    assert.equal(path.isAbsolute(suite.cases), false);
    assert.equal(suite.cases.startsWith('./'), false);
    await readFile(path.join(evalRoot, provider.command[1]), 'utf8');
  }
}

async function testEvalCorpora(bundleRoot) {
  const document = commitTriggerDocument;
  const behaviorDocument = commitBehaviorDocument;
  const behaviorCases = behaviorDocument.cases;
  const commitManifest = commitManifestDocument;
  const { cases } = document;
  assert.equal(document.version, 1);
  assert.equal(document.suite.kind, 'trigger');
  assert.equal(document.suite.unitUnderTest, 'git-commit');
  assert.equal(cases.length, 20);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 12);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(cases.filter((entry) => entry.input.expectedLoad).length, 10);
  assert.equal(cases.filter((entry) => !entry.input.expectedLoad).length, 10);
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
    assert.equal(entry.input.expectedLoad, shouldLoad);
  }
  assert.equal(cases.some((entry) => entry.input.query.includes('$git-commit')), false);
  assert.match(cases.find((entry) => entry.id === 'english_commit').input.query, /useful summary/);
  assert.match(cases.find((entry) => entry.id === 'scoped_fix_commit').input.query, /body/);
  assert.match(cases.find((entry) => entry.id === 'terse_commit').input.query, /commti/);
  assert.match(cases.find((entry) => entry.id === 'specific_files').input.query, /docs\/notes\.md/);

  assert.equal(behaviorDocument.version, 1);
  assert.equal(behaviorDocument.suite.kind, 'custom-process');
  assert.equal(behaviorDocument.suite.unitUnderTest, 'git-commit');
  assert.equal(behaviorDocument.suite.policy.optimization, 'critical');
  assert.equal(behaviorDocument.suite.policy.falseNegativeCost, 'high');
  assert.equal(behaviorDocument.suite.policy.falsePositiveCost, 'high');
  assert.equal(Array.isArray(behaviorCases), true);
  assert.equal(behaviorCases.length, 8);
  assert.equal(new Set(behaviorCases.map((entry) => entry.id)).size, behaviorCases.length);
  for (const entry of behaviorCases) {
    assert.equal(typeof entry.input?.prompt, 'string');
    assert.notEqual(entry.input.prompt.trim(), '');
    assert.equal(typeof entry.expected?.outcome, 'string');
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
  assert.equal(commitManifest.version, 1);
  assert.equal(commitManifest.suites.length, 2);
  const commitBehaviorSuite = commitManifest.suites.find((suite) => suite.id === 'behavior');
  assert.equal(commitBehaviorSuite.kind, 'custom-process');
  assert.equal(commitBehaviorSuite.cases, 'behavior-cases.json');
  assert.equal(commitBehaviorSuite.requiredForRelease, true);
  assert.equal(commitBehaviorSuite.runs, 3);
  assert.equal(commitBehaviorSuite.timeoutMs, 300000);
  await assertCustomProcessManifest(
    commitManifest,
    bundleRoot,
    'git-commit',
    new Map([['behavior', ['node', 'run-commit-evals.mjs']]]),
  );

  const mergeDocument = mergeTriggerDocument;
  const mergeCases = mergeDocument.cases;
  const participants = new Set(['reconciling-git-merges', 'git-commit']);
  assert.equal(mergeDocument.version, 1);
  assert.equal(mergeDocument.suite.kind, 'trigger');
  assert.equal(mergeDocument.suite.unitUnderTest, 'reconciling-git-merges');
  assert.deepEqual(mergeDocument.suite.participants, ['git-commit']);
  assert.equal(mergeCases.length, 21);
  assert.equal(mergeCases.filter((entry) => entry.split === 'train').length, 14);
  assert.equal(mergeCases.filter((entry) => entry.split === 'validation').length, 7);
  assert.equal(new Set(mergeCases.map((entry) => entry.id)).size, mergeCases.length);
  assert.equal(mergeCases.filter((entry) => entry.input.expected.loadedSkills.length === 1).length, 11);
  assert.equal(mergeCases.filter((entry) => entry.input.expected.loadedSkills.length === 0).length, 10);
  for (const entry of mergeCases) {
    assert.equal(Array.isArray(entry.input.expected.loadedSkills), true);
    assert.equal(
      entry.input.expected.loadedSkills.every((skill) => participants.has(skill)),
      true,
    );
    assert.equal(
      new Set(entry.input.expected.loadedSkills).size,
      entry.input.expected.loadedSkills.length,
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
    assert.deepEqual(entry.input.expected.loadedSkills, expectedSkills);
  }

  const mergeEvals = mergeEvalDocument;
  const mergeManifest = mergeManifestDocument;
  assert.equal(mergeEvals.version, 1);
  assert.equal(mergeEvals.suite.kind, 'custom-process');
  assert.equal(mergeEvals.suite.unitUnderTest, 'reconciling-git-merges');
  assert.equal(mergeEvals.cases.length, 4);
  assert.deepEqual(
    mergeEvals.cases.map((entry) => entry.id),
    [
      'ambiguous_retention',
      'semantic_same_file',
      'semantic_cross_file',
      'analysis_only_dirty_worktree',
    ],
  );
  for (const entry of mergeEvals.cases) {
    assert.equal(typeof entry.input.prompt, 'string');
    assert.equal(typeof entry.expected.outcome, 'string');
    assert.equal(entry.input.files.length, 1);
    assert.equal(path.isAbsolute(entry.input.files[0]), false);
    assert.equal(path.posix.normalize(entry.input.files[0]).startsWith('../'), false);
  }
  assert.equal(mergeManifest.version, 1);
  assert.equal(mergeManifest.suites.length, 2);
  const routerSuite = mergeManifest.suites.find((suite) => suite.id === 'router');
  const behaviorSuite = mergeManifest.suites.find((suite) => suite.id === 'behavior');
  assert.equal(routerSuite.kind, 'trigger');
  assert.equal(routerSuite.cases, 'trigger-cases.json');
  assert.equal(mergeDocument.suite.runtime.forbidMultipleSkillLoads, true);
  assert.equal(mergeDocument.suite.runtime.fixture, 'trigger-fixture.mjs');
  assert.equal(behaviorSuite.kind, 'custom-process');
  assert.equal(behaviorSuite.cases, 'evals.json');
  assert.equal(behaviorSuite.requiredForRelease, true);
  assert.equal(behaviorSuite.runs, 3);
  assert.equal(behaviorSuite.timeoutMs, 300000);
  await assertCustomProcessManifest(
    mergeManifest,
    bundleRoot,
    'reconciling-git-merges',
    new Map([['behavior', ['node', 'run-merge-evals.mjs']]]),
  );
  assert.equal(
    mergeCases.find((entry) => entry.id === 'source_08').input.workspaceFixture,
    'ambiguous_retention',
  );
  assert.equal(
    mergeCases.find((entry) => entry.id === 'source_09').input.workspaceFixture,
    'semantic_retry',
  );
  assert.equal(
    mergeCases.find((entry) => entry.id === 'source_10').input.workspaceFixture,
    'semantic_permissions',
  );
  assert.equal(
    mergeCases.find((entry) => entry.id === 'ordinary_local_commit').input.workspaceFixture,
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
    assert.equal(entry.input.workspaceFixture, fixture);
  }

  const worktreeDocument = worktreeTriggerDocument;
  const worktreeCases = worktreeDocument.cases;
  const worktreeParticipants = new Set([
    'isolating-work-with-git-worktrees',
    'reconciling-git-merges',
    'git-commit',
  ]);
  assert.equal(worktreeDocument.version, 1);
  assert.equal(worktreeDocument.suite.kind, 'trigger');
  assert.equal(worktreeDocument.suite.unitUnderTest, 'isolating-work-with-git-worktrees');
  assert.equal(worktreeDocument.suite.policy.optimization, 'recall-first');
  assert.equal(worktreeDocument.suite.policy.falseNegativeCost, 'high');
  assert.equal(worktreeDocument.suite.policy.falsePositiveCost, 'medium');
  assert.equal(worktreeCases.length, 28);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'train').length, 13);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'validation').length, 6);
  assert.equal(worktreeCases.filter((entry) => entry.split === 'sanity').length, 9);
  assert.equal(new Set(worktreeCases.map((entry) => entry.id)).size, worktreeCases.length);
  assert.equal(
    worktreeCases.filter((entry) =>
      entry.input.expected.loadedSkills.includes('isolating-work-with-git-worktrees'),
    ).length,
    15,
  );
  assert.equal(
    worktreeCases.filter((entry) => entry.input.expected.loadedSkills.length === 0).length,
    10,
  );
  for (const entry of worktreeCases) {
    assert.equal(Array.isArray(entry.input.expected.loadedSkills), true);
    assert.equal(
      entry.input.expected.loadedSkills.every((skill) => worktreeParticipants.has(skill)),
      true,
    );
    assert.equal(
      new Set(entry.input.expected.loadedSkills).size,
      entry.input.expected.loadedSkills.length,
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
    assert.deepEqual(entry.input.expected.loadedSkills, expectedSkills);
  }
  const worktreeDiagnosticCases = worktreeDiagnosticDocument;
  assert.equal(worktreeDiagnosticCases.version, 1);
  assert.equal(worktreeDiagnosticCases.suite.kind, 'trigger');
  assert.equal(worktreeDiagnosticCases.suite.policy.optimization, 'recall-first');
  assert.equal(worktreeDiagnosticCases.suite.policy.falsePositiveCost, 'low');
  assert.deepEqual(
    worktreeDiagnosticCases.cases.map((entry) => entry.id),
    ['source_15', 'sanity_full_clone'],
  );
  const fullCloneDiagnostic = worktreeDiagnosticCases.cases.find(
    (entry) => entry.id === 'source_15',
  );
  assert.equal(fullCloneDiagnostic.tags.includes('diagnostic'), true);
  const fullCloneSanityDiagnostic = worktreeDiagnosticCases.cases.find(
    (entry) => entry.id === 'sanity_full_clone',
  );
  assert.equal(fullCloneSanityDiagnostic.split, 'sanity');
  assert.equal(fullCloneSanityDiagnostic.tags.includes('diagnostic'), true);
  assert.equal(
    worktreeCases.some((entry) =>
      entry.input.query.includes('$isolating-work-with-git-worktrees'),
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
      entry.input.workspaceFixture === undefined || worktreeFixtures.has(entry.input.workspaceFixture),
    ),
    true,
  );
  assert.match(
    worktreeCases.find((entry) => entry.id === 'sanity_dirty_new_task').input.query,
    /两个任务的文件和 Git 状态不要混在一起/,
  );
  assert.match(
    worktreeCases.find((entry) => entry.id === 'sanity_dirty_same_branch').input.query,
    /继续完成这个功能/,
  );
  assert.match(
    worktreeCases.find((entry) => entry.id === 'sanity_parallel_test').input.query,
    /运行兼容性测试/,
  );
  const releaseParticipants = new Set(
    worktreeCases
      .filter((entry) => ['validation', 'sanity'].includes(entry.split))
      .flatMap((entry) => entry.input.expected.loadedSkills),
  );
  assert.deepEqual(
    [...releaseParticipants].sort(),
    [...worktreeParticipants].sort(),
  );

  const worktreeEvals = worktreeEvalDocument;
  const worktreeManifest = worktreeManifestDocument;
  assert.equal(worktreeEvals.version, 1);
  assert.equal(worktreeEvals.suite.kind, 'custom-process');
  assert.equal(worktreeEvals.suite.unitUnderTest, 'isolating-work-with-git-worktrees');
  assert.equal(worktreeEvals.suite.policy.optimization, 'critical');
  assert.deepEqual(
    worktreeEvals.cases.map((entry) => entry.id),
    [
      'preserve_dirty_workspace_and_use_default_path',
      'stop_when_default_root_not_ignored',
      'reuse_existing_isolation',
      'use_full_clone_for_repository_level_isolation',
      'report_dirty_baseline',
    ],
  );
  for (const entry of worktreeEvals.cases) {
    assert.equal(typeof entry.input.name, 'string');
    assert.equal(typeof entry.input.prompt, 'string');
    assert.equal(typeof entry.expected.outcome, 'string');
  }
  assert.equal(worktreeManifest.version, 1);
  assert.equal(worktreeManifest.suites.length, 3);
  const worktreeRouterSuite = worktreeManifest.suites.find((suite) => suite.id === 'router');
  const worktreeDiagnosticRouterSuite = worktreeManifest.suites.find(
    (suite) => suite.id === 'router-diagnostic',
  );
  const worktreeBehaviorSuite = worktreeManifest.suites.find((suite) => suite.id === 'behavior');
  assert.equal(worktreeRouterSuite.id, 'router');
  assert.equal(worktreeRouterSuite.kind, 'trigger');
  assert.deepEqual(worktreeDocument.suite.participants, [
    'reconciling-git-merges',
    'git-commit',
  ]);
  assert.equal(worktreeDocument.suite.runtime.forbidMultipleSkillLoads, true);
  assert.equal(worktreeRouterSuite.cases, 'trigger-cases.json');
  assert.deepEqual(worktreeDocument.suite.runtime.strictNegativeSplits, ['validation', 'sanity']);
  assert.deepEqual(worktreeRouterSuite.releaseSplits, ['validation', 'sanity']);
  assert.equal(worktreeDiagnosticRouterSuite.kind, 'trigger');
  assert.equal(
    worktreeDiagnosticRouterSuite.cases,
    'trigger-diagnostic-cases.json',
  );
  assert.equal(Object.hasOwn(worktreeDiagnosticRouterSuite, 'releaseSplits'), false);
  assert.equal(worktreeDiagnosticRouterSuite.requiredForRelease, false);
  assert.equal(worktreeBehaviorSuite.kind, 'custom-process');
  assert.equal(worktreeBehaviorSuite.cases, 'evals.json');
  assert.equal(worktreeBehaviorSuite.requiredForRelease, true);
  assert.equal(worktreeBehaviorSuite.runs, 3);
  assert.equal(worktreeBehaviorSuite.timeoutMs, 300000);
  assert.equal(worktreeDocument.suite.runtime.fixture, 'trigger-fixture.mjs');
  await assertCustomProcessManifest(
    worktreeManifest,
    bundleRoot,
    'isolating-work-with-git-worktrees',
    new Map([['behavior', ['node', 'run-worktree-evals.mjs']]]),
  );
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
  // Static contract exception: an invoked commit Skill could push or alter unauthorized Git state; behavior test is not suitable because the installed Skill text is the safety policy consumed by the model, not executable code.
  assert.match(skill, /本 skill 不执行 push/);
  assert.match(skill, /需要暂存时仅使用精确路径/);
  assert.match(skill, /不使用 `git add \.` 或 `git add -A`/);
  assert.match(skill, /存在未解决冲突或进行中的 Git 操作时停止并报告/);
}

function assertCoreMergeContract(skill) {
  // Static contract exception: an analysis-only merge request could mutate repository state or publish an unrequested result; behavior test is not suitable because these prohibitions are model-consumed policy in the rendered Skill.
  assert.match(skill, /仅分析时不得改变 refs、index 或 worktree/);
  assert.match(skill, /只在用户要求且验证通过后完成/);
  assert.match(skill, /不得在未被要求时推送/);
}

function assertCoreWorktreeContract(skill) {
  // Static contract exception: isolation setup or cleanup could alter unauthorized repository state or destroy unrelated user work; behavior test is not suitable because the rendered Skill is the only executable consumer boundary for these model actions.
  assert.match(skill, /不得创建 worktree、分支或改用其他路径/);
  assert.match(skill, /不得 stash、reset、discard 当前无关修改/);
  assert.match(skill, /不得用 force 抢占已有 worktree 或已检出分支/);
  assert.match(skill, /不要直接删除目录、强制清理或顺带删除分支/);
}

async function testSkillRenders(context) {
  const skillsRoot = path.join(
    context.bundleRoot,
    ...(context.platform ? [context.platform] : []),
    'skills',
  );
  const [renderedCommitSkill, renderedMergeSkill, renderedWorktreeSkill] = await Promise.all([
    readFile(path.join(skillsRoot, 'git-commit', 'SKILL.md'), 'utf8'),
    readFile(path.join(skillsRoot, 'reconciling-git-merges', 'SKILL.md'), 'utf8'),
    readFile(path.join(skillsRoot, 'isolating-work-with-git-worktrees', 'SKILL.md'), 'utf8'),
  ]);

  if (context.platform) {
    const [commitOpenai, mergeOpenai, worktreeOpenai] = await Promise.all([
      readFile(path.join(skillsRoot, 'git-commit', 'agents', 'openai.yaml'), 'utf8'),
      readFile(path.join(skillsRoot, 'reconciling-git-merges', 'agents', 'openai.yaml'), 'utf8'),
      readFile(path.join(skillsRoot, 'isolating-work-with-git-worktrees', 'agents', 'openai.yaml'), 'utf8'),
    ]);
    assert.match(
      commitOpenai,
      /default_prompt: "使用 \$git-commit 核对当前改动，并按仓库规范完成 Git 提交。"/,
    );
    assert.match(commitOpenai, /allow_implicit_invocation: true/);
    assert.match(
      mergeOpenai,
      /default_prompt: "使用 \$reconciling-git-merges 协调 Git merge 双方意图并验证组合结果。"/,
    );
    assert.match(mergeOpenai, /allow_implicit_invocation: true/);
    assert.match(
      worktreeOpenai,
      /default_prompt: "使用 \$isolating-work-with-git-worktrees：安全创建或复用 Git worktree/,
    );
    assert.match(worktreeOpenai, /allow_implicit_invocation: true/);
    assert.ok(['codex', 'claude'].includes(context.platform));
  }

  assertCoreCommitContract(renderedCommitSkill);
  assertCoreMergeContract(renderedMergeSkill);
  assertCoreWorktreeContract(renderedWorktreeSkill);
  assertRenderedSkill(renderedCommitSkill);
  assertRenderedSkill(renderedMergeSkill);
  assertRenderedSkill(renderedWorktreeSkill);
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
  const observedGroupedSummary = [
    'feat: 启用功能并同步版本与说明',
    '',
    '- 将应用功能状态切换为启用，并同步测试期望值',
    '- 更新使用指南以反映功能已启用',
    '- 将项目版本从 1.0.0 升级至 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', observedGroupedSummary)
      .every((check) => check.passed),
    true,
  );
  const naturalGroupedSummary = [
    'feat: activate the application',
    '',
    '- Activate the application and align test expectations',
    '- Update the guide to show the feature enabled',
    '- Bump 1.0.0 to 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', naturalGroupedSummary)
      .every((check) => check.passed),
    true,
  );
  const runtimeAndDocsGroupedSummary = [
    'feat: activate the application',
    '',
    '- Activate the application and update the guide to show it enabled',
    '- Align test expectations',
    '- Bump 1.0.0 to 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', runtimeAndDocsGroupedSummary)
      .every((check) => check.passed),
    true,
  );
  const coordinatedRuntimeAndDocsSummary = [
    'feat: activate the application',
    '',
    '- Enable the application and document it in the guide',
    '- Align test expectations',
    '- Bump 1.0.0 to 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', coordinatedRuntimeAndDocsSummary)
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
  const imperativeGuideRestatement = [
    'feat: activate the application',
    '',
    '- Enable the application runtime flag',
    '- Align test expectations',
    '- Enable the application feature in the guide',
    '- Bump 1.0.0 to 1.1.0',
  ].join('\n');
  assert.equal(
    commitMessageChecks('detailed_body_for_nontrivial_change', imperativeGuideRestatement)
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
  const observedCurrentHead = [
    '提交未创建：pre-commit hook 按预期拒绝了提交，且未绕过。',
    '',
    '- 当前 HEAD：`19742a5 chore: initialize commit fixture`',
    '- 暂存改动仍保留：`src/app.js`',
    '- 工作区无未暂存改动',
  ].join('\n');
  assert.equal(
    hookFailureMessageChecks(observedCurrentHead, '19742a5abcdef').every(
      (check) => check.passed,
    ),
    true,
  );
  const observedCurrentHeadWithStateVerb = [
    '提交未创建：pre-commit hook 按预期拒绝了提交，未绕过。',
    '',
    '- HEAD 仍为 `0016db5`',
    '- 暂存改动仍保留：`src/app.js`',
    '- 工作区无未暂存改动',
  ].join('\n');
  assert.equal(
    hookFailureMessageChecks(observedCurrentHeadWithStateVerb, '0016db5abcdef').every(
      (check) => check.passed,
    ),
    true,
  );
  assert.equal(
    hookFailureMessageChecks(
      observedCurrentHead.replace('19742a5', 'deadbee'),
      '19742a5abcdef',
    ).find((check) => check.name === 'reports_actual_repository_state').passed,
    false,
  );
  assert.equal(
    hookFailureMessageChecks(
      '提交未创建。HEAD 未变，暂存改动仍保留，工作区无未暂存改动。',
      '19742a5abcdef',
    ).find((check) => check.name === 'reports_actual_repository_state').passed,
    false,
  );
  for (const deniedState of [
    '提交未创建。当前 HEAD：19742a5。staged changes do not remain. working tree is not clean.',
    '提交未创建。当前 HEAD：19742a5。暂存改动未保留，工作区不干净。',
  ]) {
    assert.equal(
      hookFailureMessageChecks(deniedState, '19742a5abcdef')
        .find((check) => check.name === 'reports_actual_repository_state').passed,
      false,
    );
  }
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
  const decimalAnalysis = [
    'subtotal 返回整数分值，invoice 按元格式化。',
    '建议使用 Decimal(cents) / Decimal(100) 做边界转换，并运行 unittest 验证。',
  ].join('\n');
  assert.equal(analysisMessageChecks(decimalAnalysis).every((entry) => entry.passed), true);
  assert.equal(
    analysisMessageChecks(
      'subtotal 返回整数分值，invoice 按元格式化。错误地乘以 Decimal(100)，然后运行 unittest。',
    ).find((entry) => entry.name === 'proposes_boundary_conversion').passed,
    false,
  );
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
        'retention.py 冲突：RETENTION_DAYS 应为 7 还是 90。',
        '仓库没有更高优先级证据决定取舍，当前 merge 保持暂停。',
        '请明确应保留 7 天还是 90 天。',
      ].join('\n'),
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
  assert.equal(
    ambiguousRetentionChecks(
      unresolvedRetention,
      '7 天与 90 天不兼容。我建议折中采用 30 天，请确认这个方案。',
    ).find((entry) => entry.name === 'does_not_invent_retention_value').passed,
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
  await testEvalCorpora(context.bundleRoot);
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
