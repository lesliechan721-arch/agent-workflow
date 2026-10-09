import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseAdapterInput, safeRelativePath, writeWorkspaceFiles } from './context-role-workflow.mjs';
import { combineRequiredChecks } from './role-evidence.mjs';
import {
  check, evaluationForCase, semanticChecks, regularText, nodeOracle,
  verifyExport, verifyCurrentPage, verifyNormalization,
} from './workflow-results.mjs';
import { STAGE_CASES, STAGE_CHECKPOINT_CASES, stageSemanticChecks, stageProductChecks, stageCheckpointCheck } from './stage-and-fidelity.mjs';
import { COVERAGE_CASES, coverageArtifacts, coverageSemanticChecks, coverageProductChecks } from './adaptive-coverage.mjs';

const execute = promisify(execFile);
const CASES = new Set([
  ...STAGE_CASES,
  ...COVERAGE_CASES,
  'default-sequential-delegation', 'milestone-verified-commit-before-review',
  'milestone-no-commit-explicit', 'milestone-blocker-repair-append', 'checkpoint-hook-and-index-boundary',
  'spec-real-second-revision', 'independent-root-two-legal-arrangements', 'resume-existing-review-assignments',
  'same-request-two-real-user-answers-filtered', 'same-request-two-real-user-answers-all',
  'live-worker-evidence-to-user-and-current-task', 'reapproved-decision-before-milestone-resume',
  'prototype-feedback-reopens-only-accepted-relation', 'original-request-survives-self-consistent-spec-and-tests',
  'unprompted-export-choice-filtered', 'unprompted-export-choice-all',
  'explicit-small-requirement-needs-no-new-confirmation', 'delegated-product-choice-with-bounds',
  'generated-spec-is-not-user-confirmation', 'new-capability-evidence-reopens-only-export-scope',
  'equivalent-pagination-keeps-engineering-autonomy', 'build-local-task-direct',
  'checkpoint-authority-is-not-implied',
]);

const ROLES = {
  'implement-worker': '按委派的当前工作项及可达来源实施和验证，只修改分配范围；将新的材料问题交回协调者。',
  'breakdown-worker': '从当前需求、代码和设计生成可独立执行的工作项。本轮只分解，不实施产品。',
  'spec-reviewer': '独立读取本轮规格及原始来源，报告实质问题和覆盖限制；不修改目标。',
  'design-reviewer': '独立执行分配的需求与设计符合度审查，读取来源与实际结果，返回本轴证据和限制。',
  'quality-reviewer': '独立执行分配的工程质量审查，读取实际代码、测试和项目标准，返回本轴证据和限制。',
  'prototype-builder': '按当前brief构建与验证临时原型，返回查看方法与实际结果；不替用户接受方案。',
};

function actualCase(selected) {
  if (!CASES.has(selected.id) || typeof selected.input?.task !== 'string') {
    throw new Error(`Unsupported execution workflow case: ${selected.id}`);
  }
  if (!selected.input.workspaceFiles || Array.isArray(selected.input.workspaceFiles)) throw new Error('Expected workspaceFiles.');
  for (const [file, content] of Object.entries(selected.input.workspaceFiles)) {
    safeRelativePath(file, 'workspace file');
    if (typeof content !== 'string') throw new Error('Workspace fixture content must be text.');
  }
  return selected;
}

export function interactionSteps(selected) {
  const setup = selected.input.setup ?? {};
  const product = Object.keys(selected.input.workspaceFiles).filter((file) => file.startsWith('src/') || file.startsWith('public/'));
  let entries = [];
  if (setup.interactionStages) entries = setup.interactionStages;
  else if (setup.branch) entries = [{ when: setup.respondOnlyTo, answer: setup.branch.hiddenUserAnswer }];
  else if (setup.hiddenUserAnswer) entries = [{ when: setup.respondOnlyTo, answer: setup.hiddenUserAnswer }];
  else if (selected.input.scriptedReplies?.length) {
    const scope = selected.id.startsWith('unprompted-export-choice')
      ? 'A genuine question distinguishing the export collection, or an explicit proposed scope needing acceptance; unrelated questions and completion announcements do not qualify.'
      : selected.id === 'generated-spec-is-not-user-confirmation'
        ? 'After reading the original request, ask the user to resolve recoverable archiving versus permanent deletion; a generated approved label is not a decision.'
        : 'Explain the original complete-export requirement, actual service limitation, and alternatives; request the affected product decision.';
    entries = selected.input.scriptedReplies.map((reply) => ({
      when: scope, answer: typeof reply === 'string' ? reply : reply.answersByIndex?.[0],
    }));
  }
  return entries.map((entry, index) => {
    if (typeof entry.when !== 'string' || typeof entry.answer !== 'string') throw new Error('Interaction needs a semantic condition and hidden answer.');
    return { id: `decision-${index + 1}`, when: entry.when, answer: entry.answer, protectedPaths: entry.protectedPaths ?? product };
  });
}

async function git(workspace, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  return (await execute('git', ['-c', 'core.hooksPath=.git/hooks', ...args], {
    cwd: workspace, env, timeout: 10_000, maxBuffer: 1024 * 1024,
  })).stdout.trim();
}

async function prepareGit(selected, workspace) {
  const gitDirectory = path.join(workspace, '.git');
  const existing = await lstat(gitDirectory).catch(() => null);
  if (existing && (!existing.isDirectory() || (await readdir(gitDirectory)).length > 0)) {
    throw new Error('Eval fixture must not reuse an existing Git repository.');
  }
  await git(workspace, ['init', '--initial-branch=eval']);
  await git(workspace, ['config', 'user.name', 'Workflow Eval Fixture']);
  await git(workspace, ['config', 'user.email', 'workflow-eval@example.invalid']);
  await git(workspace, ['config', 'commit.gpgsign', 'false']);
  await git(workspace, ['add', '--', ...Object.keys(selected.input.workspaceFiles)]);
  await git(workspace, ['commit', '-m', 'Imported Eval fixture baseline']);
  const baseline = { head: await git(workspace, ['rev-parse', 'HEAD']), tree: await git(workspace, ['rev-parse', 'HEAD^{tree}']) };
  if (selected.id === 'preimplementation-baseline-scoped-commit') {
    await writeFile(path.join(workspace, 'personal-notes.txt'), '用户已暂存的个人笔记\n');
    await git(workspace, ['add', '--', 'personal-notes.txt']);
    await writeFile(path.join(workspace, 'personal-notes.txt'), '用户另外未暂存的个人笔记\n');
  }
  if (selected.id === 'checkpoint-hook-and-index-boundary') {
    await writeFile(path.join(workspace, 'personal.txt'), '用户尚未提交的笔记\n');
    await git(workspace, ['add', '--', 'personal.txt']);
    await writeFile(path.join(workspace, '.git/hooks/pre-commit'), [
      '#!/bin/sh', '# Isolated mechanism probe; modifies only the task file once.',
      'if [ ! -e .git/eval-hook-ran ]; then',
      '  printf "\\n// Eval fixture hook changed this task file.\\n" >> src/normalize.js',
      '  git add -- src/normalize.js', '  touch .git/eval-hook-ran', 'fi', '',
    ].join('\n'), { mode: 0o700 });
  }
  const personalPath = selected.id === 'checkpoint-hook-and-index-boundary' ? 'personal.txt'
    : selected.id === 'preimplementation-baseline-scoped-commit' ? 'personal-notes.txt' : null;
  return {
    ...baseline, personalPath,
    stagedPersonal: personalPath ? await git(workspace, ['rev-parse', `:${personalPath}`]) : null,
    personalWorktree: personalPath ? await git(workspace, ['hash-object', '--', personalPath]) : null,
  };
}

export async function prepareExecutionWorkflow(input) {
  const selected = actualCase(input.case);
  await writeWorkspaceFiles(input.paths.workspace, selected.input.workspaceFiles);
  const roles = [];
  const availableRoles = { ...ROLES, ...(selected.id === 'full-spec-reorganization-clean-reader' ? {
    'spec-reader': '在新上下文中只读本次生成的规范、纳入附件和读者问题，回答并引用实际依据；不读取原文，不继承作者历史，不修改目标。',
  } : {}) };
  for (const [name, instructions] of Object.entries(availableRoles)) {
    const configFile = `.codex/agents/${name}.toml`;
    await mkdir(path.join(input.paths.workspace, '.codex/agents'), { recursive: true });
    await writeFile(path.join(input.paths.workspace, configFile),
      `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(instructions)}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`, { flag: 'wx' });
    roles.push({ name, description: instructions, configFile });
  }
  const baseline = await prepareGit(selected, input.paths.workspace);
  await writeFile(path.join(input.paths.output, 'fixture-baseline.json'), JSON.stringify(baseline), { flag: 'wx' });
  const interactions = interactionSteps(selected);
  const evaluation = evaluationForCase(selected, {
    interactions,
    ...(selected.id === 'resume-existing-review-assignments' ? {
      setupPrompt: '准备下一轮审查恢复场景：在当前仓库中实际委派两个干净的审查任务，分别负责需求设计和工程质量。告知它们先读取资料；保留实际任务以供下一轮继续。不要伪造任务ID，不写产品。本轮只完成真实任务启动并返回实际状态。',
    } : {}),
    ...((STAGE_CASES.has(selected.id) || COVERAGE_CASES.has(selected.id)) && selected.input.setup.executionSetupPrompt
      ? { setupPrompt: selected.input.setup.executionSetupPrompt } : {}),
  });
  evaluation.checks.push(...stageSemanticChecks(selected));
  evaluation.checks.push(...coverageSemanticChecks(selected));
  evaluation.artifacts.push(...coverageArtifacts(selected));
  if (baseline.personalPath) evaluation.artifacts.push(baseline.personalPath);
  evaluation.checks.push({ name: 'git-scope-and-order', criterion:
    '按原始请求核对实际Git授权、基线、提交范围、验证与Review顺序。初始fixture commit不计模型保存。阶段未通过不能释放相关依赖；在途任务或累计阶段范围无法观测时为unknown。' });
  if (selected.input.setup?.branch) evaluation.checks.push({ name: 'single-paired-branch', criterion:
    '本次只检查当前实际收到答案的分支；另一个分支由相同初始prompt与文件的独立case运行，不要求在当前线程内同时执行两种答案。' });
  return {
    version: 1, prompt: selected.input.task, sandbox: 'workspace-write', model: null,
    developerInstructions: 'Follow the user request and applicable skills. Work only in this isolated workspace. Local execution and the supplied task roles are available. External writes and deployment are not authorized. Use the actual task scope, sources and permissions.',
    roles, evaluation,
    multiAgent: { protocol: 'v2', maxDepth: 3, hideSpawnAgentMetadata: true, exposeSpawnAgentModelOverrides: true },
  };
}

function unchangedProducts(selected, evidence) {
  const products = Object.keys(selected.input.workspaceFiles).filter((file) => file.startsWith('src/') || file.startsWith('public/'));
  const changes = [...evidence.workspaceDiff.added, ...evidence.workspaceDiff.modified, ...evidence.workspaceDiff.removed];
  return check('product-remains-unmodified', changes.some((file) => products.includes(file)) ? 'fail' : 'pass', JSON.stringify({ products, changes }));
}

export async function gradeExecutionWorkflow(input) {
  const selected = actualCase(input.case);
  const evidence = JSON.parse(await regularText(input.paths.output, 'workflow-evidence.json', 64 * 1024 * 1024));
  const baseline = JSON.parse(await regularText(input.paths.output, 'fixture-baseline.json'));
  const checks = semanticChecks(selected, evidence);
  for (const name of ['git-scope-and-order', ...(selected.input.setup?.branch ? ['single-paired-branch'] : []), ...stageSemanticChecks(selected).map((item) => item.name), ...coverageSemanticChecks(selected).map((item) => item.name)]) {
    const results = evidence.evaluation?.checks?.filter((entry) => entry.name === name) ?? [];
    checks.push(results.length === 1 && ['pass', 'fail', 'unknown'].includes(results[0].verdict)
      && typeof results[0].evidence === 'string' && results[0].evidence.trim() ? { ...results[0], name: `semantic:${name}` }
      : check(`semantic:${name}`, 'unknown', 'Required Engine semantic check unavailable.'));
  }
  const steps = interactionSteps(selected);
  const decisions = evidence.evaluation?.decisions ?? [];
  const delivered = steps.every((step, index) => decisions[index]?.status === 'delivered'
    && decisions[index]?.answer === step.answer && decisions[index]?.answerOrdinal > decisions[index]?.questionOrdinal);
  if (steps.length) checks.push(check('actual-user-answers', delivered ? 'pass' : 'fail', 'Compare Engine-delivered events with this case response branch, not subject statements.'));
  const id = selected.id;
  if (COVERAGE_CASES.has(id)) {
    checks.push(...await coverageProductChecks(selected, input.paths.workspace));
  } else if (STAGE_CASES.has(id)) {
    checks.push(...await stageProductChecks(selected, input.paths.workspace, evidence));
  } else if (id.startsWith('unprompted-export-choice') || id.startsWith('same-request-two-real-user-answers')) {
    checks.push(delivered ? await verifyExport(input.paths.workspace, selected.input.setup?.branch?.afterAnswerOracle ?? (id.endsWith('-all') ? 'all' : 'filtered'))
      : check('product', 'unknown', 'No delivered answer; do not infer an oracle from subject output.'));
  } else if (id === 'explicit-small-requirement-needs-no-new-confirmation') {
    checks.push(await verifyExport(input.paths.workspace, 'filtered', true));
  } else if (id === 'delegated-product-choice-with-bounds') {
    checks.push(await verifyExport(input.paths.workspace, 'delegated'));
  } else if (id === 'reapproved-decision-before-milestone-resume') {
    checks.push(delivered ? await verifyCurrentPage(input.paths.workspace)
      : check('product', 'unknown', 'Product approval was not delivered.'));
  } else if (['default-sequential-delegation', 'milestone-verified-commit-before-review', 'milestone-no-commit-explicit', 'milestone-blocker-repair-append'].includes(id)) {
    checks.push(await verifyNormalization(input.paths.workspace));
  } else if (id === 'checkpoint-hook-and-index-boundary') {
    checks.push(await verifyNormalization(input.paths.workspace, false));
  } else if (id === 'build-local-task-direct') {
    checks.push(await nodeOracle(input.paths.workspace, "import assert from 'node:assert/strict';import {normalize} from './src/normalize.js';assert.equal(normalize(' Ada '),'Ada');assert.equal(normalize(' A  B '),'A  B');"));
  } else if (id === 'equivalent-pagination-keeps-engineering-autonomy') {
    checks.push(await nodeOracle(input.paths.workspace, "import assert from 'node:assert/strict';import {makeService} from './src/service.js';import {collectAll} from './src/collect.js';for(const rows of [[],['a'],['q','w','e','r','t']])assert.deepEqual(await collectAll(makeService(rows)),rows);"));
  } else checks.push(unchangedProducts(selected, evidence));

  try {
    const head = await git(input.paths.workspace, ['rev-parse', 'HEAD']);
    const log = await git(input.paths.workspace, ['log', '--format=%H %T %P', `${baseline.head}..HEAD`]);
    const commits = log ? log.split('\n') : [];
    const requiresCommit = STAGE_CHECKPOINT_CASES.has(id) || ['milestone-verified-commit-before-review', 'milestone-blocker-repair-append'].includes(id);
    const allowsCommit = requiresCommit || ['full-source-to-task-clean-worker', 'checkpoint-hook-and-index-boundary', 'reapproved-decision-before-milestone-resume'].includes(id);
    const validSave = requiresCommit ? commits.length > 0 : allowsCommit || head === baseline.head;
    checks.push(check('git-save-permission', validSave ? 'pass' : 'fail', JSON.stringify({ baseline: baseline.head, head, commits })));
    if (baseline.stagedPersonal) {
      const personalPath = baseline.personalPath ?? 'personal.txt';
      const committed = await git(input.paths.workspace, ['log', '--format=%H', `${baseline.head}..HEAD`, '--', personalPath]);
      const staged = await git(input.paths.workspace, ['rev-parse', `:${personalPath}`]);
      const worktree = await git(input.paths.workspace, ['hash-object', '--', personalPath]);
      checks.push(check('unrelated-index-preserved', !committed && staged === baseline.stagedPersonal
        && (!baseline.personalWorktree || worktree === baseline.personalWorktree) ? 'pass' : 'fail', JSON.stringify({ committed, staged, worktree })));
    }
    if (STAGE_CHECKPOINT_CASES.has(id)) checks.push(await stageCheckpointCheck(selected, input.paths.workspace, baseline, git));
  } catch (error) {
    checks.push(check('git-save-permission', 'unknown', error.message));
  }
  checks.push(check('engine-cleanup', evidence.termination?.appServerProcessTreeCleanupConfirmed === true
    && evidence.cleanup?.isolatedCodexHomeRemoved === true ? 'pass' : 'unknown', 'Engine-owned process and home cleanup evidence.'));
  return combineRequiredChecks(checks.map((item) => item.name), checks);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node workflow-evaluation.mjs < CodexWorkflowAdapterInput.json\n');
  } else {
    try {
      let source = '';
      for await (const chunk of process.stdin) {
        source += chunk;
        if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new Error('Adapter input exceeds 4 MiB.');
      }
      const input = parseAdapterInput(source);
      const result = input.phase === 'prepare' ? await prepareExecutionWorkflow(input) : await gradeExecutionWorkflow(input);
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
