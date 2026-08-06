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
} from '../evals/trigger-fixture.mjs';

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
  assert.equal(context.plugin.name, 'git-commit');
  assert.equal(context.plugin.version, '0.1.6');
  assert.equal(context.event, 'test');
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

async function testEvalCorpus(sourceRoot) {
  const document = JSON.parse(await readFile(
    path.join(sourceRoot, 'evals', 'trigger-cases.json'),
    'utf8',
  ));
  const { cases } = document;
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, 'commit');
  assert.equal(cases.length, 20);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 12);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(cases.filter((entry) => entry.should_load_skill).length, 10);
  assert.equal(cases.filter((entry) => !entry.should_load_skill).length, 10);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);

  const expectedContracts = new Map([
    ['commit_and_push', true],
    ['draft_message_only', false],
    ['stage_only', false],
    ['mixed_language_staged', true],
    ['squash_history', false],
    ['non_git_commitment', false],
    ['merge_operation', false],
    ['scoped_fix_commit', true],
  ]);
  for (const [id, shouldLoad] of expectedContracts) {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required eval case ${id}`);
    assert.equal(entry.should_load_skill, shouldLoad);
  }
  assert.equal(cases.some((entry) => entry.query.includes('$commit')), false);
}

function assertRenderedSkill(skill) {
  assert.equal(skill.includes('{{'), false);
  assert.equal(skill.includes('allowed-tools:'), false);
  assert.equal(skill.includes('## 当前 Git 快照'), false);
  assert.equal(skill.includes('```!'), false);
}

function assertCoreCommitContract(skill) {
  assert.match(skill, /只有用户明确要求实际创建提交时，才可改变暂存区或创建 commit/);
  assert.match(skill, /push 不属于本 skill 的职责/);
  assert.match(skill, /后续 push 由外层任务依据同一用户请求中的明确授权处理/);
  assert.match(skill, /commit 必须只包含用户授权范围/);
  assert.match(skill, /无法精确隔离时停止并报告/);
  assert.match(skill, /存在进行中的 Git 操作或未解决冲突时停止并报告/);
  assert.match(skill, /本 skill 不继续对应操作/);
  assert.match(skill, /需要暂存时只操作已确认候选并使用精确路径/);
  assert.match(skill, /不使用 `git add \.`、`git add -A`/);
  assert.match(skill, /<type>: <中文描述>/);
  assert.match(skill, /不绕过 hooks，不执行 amend、reset/);
  assert.match(skill, /不得主动改变范围外状态/);
  assert.match(skill, /历史改写或范围外暂存重排/);
  assert.match(skill, /提交前重新核对完整候选/);
  assert.match(skill, /创建一次 commit/);
  assert.match(skill, /失败后不自动重试或回滚/);
  assert.match(skill, /核对新 `HEAD` 的内容和最终 message/);
  assert.match(skill, /不保证自动恢复到操作前状态/);
}

async function testSkillRenders(context) {
  const source = await readFile(
    path.join(context.sourceRoot, 'skills', 'commit', 'SKILL.md'),
    'utf8',
  );

  assert.match(source, /当用户明确要求实际创建一次新的本地 Git commit 时必须使用/);
  assert.equal(source.includes('user-invocable:'), false);

  if (context.platform) {
    const [bundledSkill, bundledOpenai] = await Promise.all([
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'commit',
          'SKILL.md',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          context.bundleRoot,
          context.platform,
          'skills',
          'commit',
          'agents',
          'openai.yaml',
        ),
        'utf8',
      ),
    ]);
    assert.match(
      bundledOpenai,
      /default_prompt: "使用 \$commit 核对当前改动，并按仓库规范完成 Git 提交。"/,
    );
    assert.match(bundledOpenai, /allow_implicit_invocation: true/);
    assertCoreCommitContract(bundledSkill);
    assert.ok(['codex', 'claude'].includes(context.platform));
    assertRenderedSkill(bundledSkill);
    return;
  }

  assertCoreCommitContract(source);
  assertRenderedSkill(source);
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

async function main() {
  const context = await resolveTestContext();
  await testEvalCorpus(context.sourceRoot);
  await testSkillRenders(context);
  await testWorkspaceFixture();
  await testHostileGitConfigurationIsIgnored();
  await testPartialStagingBehavior();
  await testMergeInProgressDetection();
  await testCherryPickConflictDetection();
  console.log('git-commit eval and Git behavior tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
