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
  buildCodexArgs,
  captureGitState,
  createEvalWorkspace,
  inspectExecEvent,
  loadEvalCases,
  parseArgs,
  renderSkillTemplate,
  resolveCodexExecutable,
  runCodexOnce,
  summarizeCase,
} from '../evals/run-trigger-evals.mjs';

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
  assert.equal(context.plugin.version, '0.1.4');
  assert.equal(context.event, 'test');
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

async function testEvalCorpus() {
  const cases = await loadEvalCases('all');
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

function testArguments() {
  assert.deepEqual(
    parseArgs(['--split', 'validation', '--runs', '5', '--threshold', '0.6']),
    {
      split: 'validation',
      runs: 5,
      threshold: 0.6,
      timeoutMs: 120_000,
      codexBin: 'codex',
      model: undefined,
      output: undefined,
      help: false,
    },
  );
  assert.throws(() => parseArgs(['--split', 'unknown']), /train, validation, or all/);
  assert.throws(() => parseArgs(['--runs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--threshold', '1']), /less than 1/);
  assert.throws(
    () => resolveCodexExecutable('codex', 'win32'),
    /absolute path/,
  );
  assert.throws(
    () => resolveCodexExecutable('codex.cmd', 'win32'),
    /absolute path/,
  );
  assert.equal(
    resolveCodexExecutable(String.raw`C:\tools\codex.exe`, 'win32'),
    String.raw`C:\tools\codex.exe`,
  );
}

function assertCodexSkill(skill) {
  assert.equal(skill.includes('{{'), false);
  assert.equal(skill.includes('allowed-tools:'), false);
  assert.equal(skill.includes('## 当前 Git 快照'), false);
}

function assertClaudeSkill(skill) {
  assert.equal(skill.includes('{{'), false);
  assert.match(
    skill,
    /allowed-tools: "Bash\(git status \*\) Bash\(git diff \*\)"/,
  );
  const injectedCommands = [...skill.matchAll(/```!\n([\s\S]*?)\n```/g)]
    .map((match) => match[1].trim());
  assert.deepEqual(injectedCommands, [
    'git status --porcelain=v1 --untracked-files=all',
    'git diff --no-ext-diff --no-textconv --stat',
    'git diff --cached --no-ext-diff --no-textconv --stat',
  ]);
}

async function testSkillRenders(context) {
  const source = await readFile(
    path.join(context.sourceRoot, 'skills', 'commit', 'SKILL.md'),
    'utf8',
  );

  assert.match(source, /当用户明确要求实际创建一次 Git commit 时必须使用/);
  assert.match(source, /user-invocable: true/);
  assert.match(source, /优先遵守仓库通过 AGENTS\.md、CONTRIBUTING、commitlint/);
  assert.match(source, /同一文件同时存在已暂存和未暂存 hunks 时，可以只提交已暂存部分/);
  assert.match(source, /merge、rebase、cherry-pick、revert/);
  assert.match(source, /不要使用 `git add \.`、`git add -A`/);
  assert.match(source, /git commit --dry-run/);

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
    if (context.platform === 'codex') {
      assertCodexSkill(bundledSkill);
    } else {
      assert.equal(context.platform, 'claude');
      assertClaudeSkill(bundledSkill);
    }
    return;
  }

  assertCodexSkill(renderSkillTemplate(source, false));
  assertClaudeSkill(renderSkillTemplate(source, true));
}

function testEventDetectionAndSummary() {
  const skillPath = '/tmp/eval/.agents/skills/commit/SKILL.md';
  const startedEvent = {
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: "sed -n '1,180p' .agents/skills/commit/SKILL.md",
      status: 'in_progress',
    },
  };
  assert.deepEqual(inspectExecEvent(startedEvent, skillPath), {});

  const failedEvent = {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: "sed -n '1,180p' .agents/skills/commit/SKILL.md",
      status: 'failed',
      exit_code: 1,
    },
  };
  assert.deepEqual(inspectExecEvent(failedEvent, skillPath), {});

  const completedEvent = {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: "sed -n '1,180p' ./.agents/skills/commit/SKILL.md",
      status: 'completed',
      exit_code: 0,
    },
  };
  assert.deepEqual(inspectExecEvent(completedEvent, skillPath), {
    loaded: true,
    loadEvidence: "sed -n '1,180p' ./.agents/skills/commit/SKILL.md",
  });

  const changedDirectoryEvent = {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'cd ./.agents/skills/commit && cat ./SKILL.md',
      status: 'completed',
      exit_code: 0,
    },
  };
  assert.deepEqual(inspectExecEvent(changedDirectoryEvent, skillPath), {
    loaded: true,
    loadEvidence: 'cd ./.agents/skills/commit && cat ./SKILL.md',
  });
  for (const command of [
    'Get-Content -LiteralPath .\\.agents\\skills\\commit\\SKILL.md',
    'type .agents\\skills\\commit\\SKILL.md',
  ]) {
    assert.deepEqual(
      inspectExecEvent(
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command,
            status: 'completed',
            exit_code: 0,
          },
        },
        skillPath,
      ),
      {
        loaded: true,
        loadEvidence: command,
      },
    );
  }
  assert.deepEqual(
    inspectExecEvent(
      {
        ...completedEvent,
        item: {
          ...completedEvent.item,
          command: 'echo .agents/skills/commit/SKILL.md',
        },
      },
      skillPath,
    ),
    {},
  );

  const summary = summarizeCase(
    {
      id: 'example',
      split: 'train',
      query: 'query',
      should_load_skill: true,
    },
    [
      { loaded: true, execution_error: false },
      { loaded: true, execution_error: false },
      { loaded: false, execution_error: false },
    ],
    0.5,
  );
  assert.equal(summary.observed.load_rate, 2 / 3);
  assert.equal(summary.passed, true);

  const validationNegative = summarizeCase(
    {
      id: 'validation_negative',
      split: 'validation',
      query: 'query',
      should_load_skill: false,
    },
    [
      { loaded: true, execution_error: false },
      { loaded: false, execution_error: false },
      { loaded: false, execution_error: false },
    ],
    0.5,
  );
  assert.equal(validationNegative.passed, false);
}

async function testWorkspaceStaging(sourceRoot) {
  const workspace = await createEvalWorkspace({ sourceRoot });
  try {
    const [skill, status] = await Promise.all([
      readFile(workspace.skillPath, 'utf8'),
      git(
        workspace.root,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        workspace.env,
      ),
    ]);
    assert.equal(skill.includes('{{'), false);
    assert.equal(skill.includes('## 当前 Git 快照'), false);
    assert.match(status.stdout, /^M  README\.md$/m);
    assert.match(status.stdout, /^ M src\/app\.ts$/m);
    assert.match(status.stdout, /^\?\? docs\/notes\.md$/m);
    assert.equal(status.stdout.includes('.agents/'), false);

    const args = buildCodexArgs(
      workspace,
      { query: '提交一下' },
      { model: 'gpt-test' },
    );
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--ignore-rules'));
    assert.ok(args.includes('--strict-config'));
    assert.ok(args.includes('read-only'));
    assert.ok(args.includes('gpt-test'));
    assert.ok(args.includes('skills.bundled.enabled=false'));
    assert.ok(args.includes('orchestrator.skills.enabled=false'));
    assert.equal(args.includes('提交一下'), false);
    assert.equal(workspace.env.HOME.startsWith(workspace.cleanupRoot), true);
    assert.equal(workspace.env.CODEX_HOME.startsWith(workspace.cleanupRoot), true);
    assert.equal(workspace.env.GIT_DIR, undefined);
    assert.match(workspace.identity.plugin_version, /^0\.1\.4$/);
    assert.match(workspace.identity.skill_sha256, /^[0-9a-f]{64}$/);

    const initialState = await captureGitState(workspace);
    await writeFile(
      path.join(workspace.root, 'docs', 'notes.md'),
      '# Mutated untracked notes\n',
      'utf8',
    );
    assert.notEqual(await captureGitState(workspace), initialState);
    await writeFile(
      path.join(workspace.root, 'docs', 'notes.md'),
      '# Untracked notes\n',
      'utf8',
    );
    assert.equal(await captureGitState(workspace), initialState);
    if (process.platform !== 'win32') {
      const result = await runCodexOnce(
        workspace,
        {
          id: 'explicit_without_events',
          split: 'train',
          query: '$commit 检查当前改动并完成提交。',
          should_load_skill: true,
        },
        {
          codexBin: '/usr/bin/true',
          model: undefined,
          timeoutMs: 10_000,
        },
      );
      assert.equal(result.loaded, false);
      assert.equal(result.execution_error, false);
      assert.equal(result.fixture_unchanged, true);
      assert.equal(await captureGitState(workspace), initialState);
    }
  } finally {
    await rm(workspace.cleanupRoot, { recursive: true, force: true });
  }
}

async function testHostileGitConfigurationIsIgnored(sourceRoot) {
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

  let workspace;
  try {
    workspace = await createEvalWorkspace({
      sourceRoot,
      sourceEnv: {
        ...process.env,
        HOME: hostileRoot,
        CODEX_HOME: path.join(hostileRoot, 'codex-home'),
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: '0',
        GIT_DIR: path.join(hostileRoot, 'redirected.git'),
        GIT_WORK_TREE: hostileRoot,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: hooksDir,
      },
    });
    assert.notEqual(workspace.env.HOME, hostileRoot);
    assert.notEqual(workspace.env.GIT_CONFIG_GLOBAL, globalConfig);
    assert.equal(workspace.env.GIT_DIR, undefined);
    assert.equal(workspace.env.GIT_WORK_TREE, undefined);
    await assert.rejects(readFile(sentinelPath, 'utf8'), /ENOENT/);
  } finally {
    if (workspace) {
      await rm(workspace.cleanupRoot, { recursive: true, force: true });
    }
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
  await testEvalCorpus();
  testArguments();
  await testSkillRenders(context);
  testEventDetectionAndSummary();
  await testWorkspaceStaging(context.sourceRoot);
  await testHostileGitConfigurationIsIgnored(context.sourceRoot);
  await testPartialStagingBehavior();
  await testMergeInProgressDetection();
  await testCherryPickConflictDetection();
  console.log('git-commit eval and Git behavior tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
