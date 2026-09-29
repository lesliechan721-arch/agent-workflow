import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseAdapterInput, safeRelativePath, writeWorkspaceFiles } from './runtime/context-role-workflow.mjs';
import { combineRequiredChecks } from './runtime/role-evidence.mjs';
import { check, evaluationForCase, nodeOracle, regularText, semanticChecks } from './runtime/workflow-results.mjs';

const execute = promisify(execFile);
const CASES = new Set([
  'shape-grill-before-material-answer', 'generated-local-spec-to-clean-context',
  'prototype-answer-and-new-question', 'completed-project-without-local-history',
]);
const ROLES = {
  'spec-reviewer': '只读审查当前真实Spec及原始来源，直接返回问题、证据和覆盖限制。',
  'implement-worker': '读取本轮实际生成的Spec及引用，在分配范围实施并验证。你与其他执行者共享工作区，保留他人的改动。',
  'design-reviewer': '独立完成已分配的需求与设计符合度审查，读取真实来源与实际结果。',
  'quality-reviewer': '独立完成已分配的工程质量审查，读取实际代码、测试与项目标准。',
  'prototype-builder': '按本轮brief构建和验证临时原型，返回实际展示入口，不替用户接受。保留共享工作区中他人的改动。',
  'maintenance-reader': '只读指定的已提交项目副本，从实际代码、测试和项目资料解释行为与依据；不读取作者历史或本地过程资料。',
};

function selectedCase(selected) {
  if (!CASES.has(selected?.id) || typeof selected.input?.task !== 'string') {
    throw new Error(`Unsupported lifecycle workflow case: ${selected?.id}`);
  }
  for (const [file, content] of Object.entries(selected.input.workspaceFiles)) {
    safeRelativePath(file, 'workspace file');
    if (typeof content !== 'string') throw new Error('Workspace fixture content must be text.');
  }
  return selected;
}

async function git(workspace, args, { encoding = 'utf8' } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  return (await execute('git', ['-c', 'core.hooksPath=.git/hooks', ...args], {
    cwd: workspace, env, encoding, timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  })).stdout;
}

export async function prepareLifecycleWorkflow(input) {
  const selected = selectedCase(input.case);
  const workspace = input.paths.workspace;
  if (await lstat(path.join(workspace, '.git')).catch(() => null)) {
    throw new Error('Lifecycle fixture must not reuse an existing Git repository.');
  }
  await writeWorkspaceFiles(workspace, selected.input.workspaceFiles);
  await git(workspace, ['init', '--initial-branch=eval']);
  await git(workspace, ['config', 'user.name', 'Workflow Eval Fixture']);
  await git(workspace, ['config', 'user.email', 'workflow-eval@example.invalid']);
  await git(workspace, ['config', 'commit.gpgsign', 'false']);
  await git(workspace, ['add', '--', ...Object.keys(selected.input.workspaceFiles).filter((file) => !file.startsWith('.dev-workflows/'))]);
  await git(workspace, ['commit', '-m', 'Imported lifecycle fixture baseline']);
  const baseline = { head: (await git(workspace, ['rev-parse', 'HEAD'])).trim() };
  if (selected.id === 'completed-project-without-local-history') {
    await writeFile(path.join(workspace, 'personal-notes.txt'), '用户已暂存的无关笔记\n');
    await git(workspace, ['add', '--', 'personal-notes.txt']);
    baseline.personalIndex = (await git(workspace, ['rev-parse', ':personal-notes.txt'])).trim();
    await writeFile(path.join(workspace, 'personal-notes.txt'), '用户另外未暂存的无关笔记\n');
    baseline.personalWorktree = (await git(workspace, ['hash-object', '--', 'personal-notes.txt'])).trim();
  }
  await writeFile(path.join(input.paths.output, 'fixture-baseline.json'), JSON.stringify(baseline), { flag: 'wx' });

  const roles = [];
  for (const [name, description] of Object.entries(ROLES)) {
    const configFile = `.codex/agents/${name}.toml`;
    await mkdir(path.dirname(path.join(workspace, configFile)), { recursive: true });
    await writeFile(path.join(workspace, configFile),
      `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(description)}\ndeveloper_instructions = ${JSON.stringify(description)}\n`, { flag: 'wx' });
    roles.push({ name, description, configFile });
  }
  const setup = selected.input.setup;
  const evaluation = evaluationForCase(selected, {
    interactions: setup.interactions,
    ...(setup.executionSetupPrompt ? { setupPrompt: setup.executionSetupPrompt } : {}),
  });
  evaluation.artifacts = [...new Set([...Object.keys(selected.input.workspaceFiles), ...setup.artifacts])];
  return {
    version: 1, prompt: selected.input.task, sandbox: 'workspace-write', model: null,
    developerInstructions: 'Follow the actual user request and applicable skills. Work in this isolated fixture. Use actual artifacts and available tools; report unavailable evidence. External writes and deployment are not authorized.',
    roles, evaluation,
    multiAgent: { protocol: 'v2', maxDepth: 3, hideSpawnAgentMetadata: true, exposeSpawnAgentModelOverrides: true },
  };
}

export async function verifySelection(workspace) {
  return nodeOracle(workspace, `
    import assert from 'node:assert/strict';
    import {selectRecords} from './src/select.js';
    for (const tenant of ['tenant-one','tenant-two']) {
      const rows=Object.freeze([
        {id:'a',tenantId:tenant,value:1}, {id:'b',tenantId:'foreign',value:2},
        {id:'A',tenantId:tenant,value:3}, {id:'c',tenantId:tenant,value:4},
        {id:'a',tenantId:tenant,value:5},
      ].map(Object.freeze));
      for (const selected of [[],['a','b'],['A'],['c','a'],['missing'],['a','a']]) {
        const ids=Object.freeze(selected);
        const before=structuredClone({rows,ids});
        const actual=selectRecords(rows,tenant,ids);
        assert.deepEqual(actual,rows.filter(row=>row.tenantId===tenant&&ids.includes(row.id)));
        assert.deepEqual({rows,ids},before);
      }
    }
    assert.deepEqual(selectRecords([], 'tenant-one', ['a']), []);
  `, 'original-selection-requirements');
}

function decisionChecks(selected, evidence) {
  let previousAnswerOrdinal = 0;
  return selected.input.setup.interactions.map((step) => {
    const matches = (evidence.evaluation?.decisions ?? []).filter((entry) => entry.id === step.id);
    if (matches.length !== 1) return check(`decision:${step.id}`, 'unknown', 'Expected one actual Engine decision event.');
    const decision = matches[0];
    if (decision.status !== 'delivered') return check(`decision:${step.id}`,
      decision.status === 'rejected' ? 'fail' : 'unknown', decision.reason || 'No delivered answer.');
    const valid = decision.answer === step.answer && Number.isInteger(decision.questionOrdinal)
      && Number.isInteger(decision.answerOrdinal) && decision.questionOrdinal < decision.answerOrdinal
      && decision.questionOrdinal > previousAnswerOrdinal;
    if (valid) previousAnswerOrdinal = decision.answerOrdinal;
    return check(`decision:${step.id}`, valid ? 'pass' : 'fail', `Engine answer at ${decision.answerOrdinal}.`);
  });
}

export async function lifecycleGitChecks(selected, workspace, baseline) {
  const checks = [];
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).trim();
  const committed = selected.id === 'completed-project-without-local-history';
  const localIndex = (await git(workspace, ['ls-files', '--', '.dev-workflows'])).trim();
  const localHistory = (await git(workspace, ['log', '--format=', '--name-only', `${baseline.head}..HEAD`, '--', '.dev-workflows'])).trim();
  checks.push(check('local-process-not-tracked', localIndex || localHistory ? 'fail' : 'pass', localIndex || localHistory || 'No local process files in index or new commits.'));
  checks.push(check('commit-authority', (committed ? head !== baseline.head : head === baseline.head) ? 'pass' : 'fail', `baseline=${baseline.head}; current=${head}`));
  if (committed) {
    const treeNotes = (await git(workspace, ['ls-tree', '--name-only', 'HEAD', '--', 'personal-notes.txt'])).trim();
    const index = (await git(workspace, ['rev-parse', ':personal-notes.txt'])).trim();
    const worktree = (await git(workspace, ['hash-object', '--', 'personal-notes.txt'])).trim();
    checks.push(check('unrelated-index-and-worktree', !treeNotes && index === baseline.personalIndex
      && worktree === baseline.personalWorktree ? 'pass' : 'fail', 'Compared committed tree, staged blob and worktree blob with the fixture baseline.'));
  }
  return checks;
}

async function committedProjectChecks(workspace, output) {
  const copy = await mkdtemp(path.join(output, 'committed-project-'));
  try {
    const entries = (await git(workspace, ['ls-tree', '-r', '-z', 'HEAD'])).split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(entry);
      if (!match || !['100644', '100755'].includes(match[1])) {
        return [check('committed-project', 'unknown', 'Committed fixture contains a non-regular file.')];
      }
      const file = safeRelativePath(match[3], 'committed path');
      if (file.startsWith('.dev-workflows/')) return [check('committed-project', 'fail', 'Local process content entered the committed project.')];
      await mkdir(path.dirname(path.join(copy, file)), { recursive: true });
      await writeFile(path.join(copy, file), await git(workspace, ['cat-file', 'blob', match[2]], { encoding: 'buffer' }));
    }
    const product = await verifySelection(copy);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const tests = await execute(process.execPath, ['--test', '--test-reporter=tap'], { cwd: copy, env, timeout: 15_000, maxBuffer: 1024 * 1024 });
    const passed = tests.stdout.match(/^# pass (\d+)\r?$/mu);
    return [
      { ...product, name: 'committed-project-behavior' },
      check('committed-project-tests', passed ? Number(passed[1]) > 0 ? 'pass' : 'fail' : 'unknown',
        tests.stdout.trim().slice(-8_000) || 'No test execution summary from the committed project copy.'),
    ];
  } catch (error) {
    return [check('committed-project', error.killed || error.code === 'ENOENT' ? 'unknown' : 'fail', String(error.stderr || error.message).slice(0, 8_000))];
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

export async function gradeLifecycleWorkflow(input) {
  const selected = selectedCase(input.case);
  const evidence = JSON.parse(await readFile(input.paths.evidence, 'utf8'));
  const baseline = JSON.parse(await readFile(path.join(input.paths.output, 'fixture-baseline.json'), 'utf8'));
  const checks = [...semanticChecks(selected, evidence), ...decisionChecks(selected, evidence)];
  const methods = selected.id === 'shape-grill-before-material-answer' ? ['decision-shape', 'decision-grill']
    : selected.id === 'prototype-answer-and-new-question' ? ['decision-shape', 'decision-prototype', 'decision-grill'] : [];
  for (const skill of methods) checks.push(check(`method:${skill}`,
    evidence.skillLoads?.some((entry) => entry.skill === skill) ? 'pass' : 'unknown', `Engine skill-load evidence for ${skill}.`));
  const local = selected.id === 'shape-grill-before-material-answer' ? ['.dev-workflows/export/spec.md']
    : selected.id === 'prototype-answer-and-new-question' ? ['.dev-workflows/form/prototype/artifact/index.html', '.dev-workflows/form/prototype/verdict.md']
      : ['.dev-workflows/selection/spec.md'];
  // Existing local sources must survive; new designs need no generic task record.
  const retainedSources = Object.keys(selected.input.workspaceFiles).filter((file) => file.startsWith('.dev-workflows/'));
  for (const file of new Set([...local, ...retainedSources])) {
    try {
      const content = await regularText(input.paths.workspace, file);
      checks.push(check(`artifact:${file}`, content.trim() ? 'pass' : 'fail', 'Actual local artifact remains readable.'));
    } catch (error) { checks.push(check(`artifact:${file}`, 'fail', error.message)); }
  }
  checks.push(...await lifecycleGitChecks(selected, input.paths.workspace, baseline));
  if (selected.id === 'generated-local-spec-to-clean-context') checks.push(await verifySelection(input.paths.workspace));
  if (selected.id === 'completed-project-without-local-history') {
    checks.push(...await committedProjectChecks(input.paths.workspace, input.paths.output));
  }
  checks.push(check('engine-cleanup', evidence.termination?.appServerProcessTreeCleanupConfirmed === true
    && evidence.cleanup?.isolatedCodexHomeRemoved === true ? 'pass' : 'unknown', 'Engine-owned process and isolated-home cleanup evidence.'));
  const result = combineRequiredChecks(checks.map((item) => item.name), checks);
  return { ...result, details: { ...result.details, caseId: selected.id, variant: input.variant } };
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node method-lifecycle-workflow.mjs < CodexWorkflowAdapterInput.json\nPrepare/grade only; the Engine owns models, user events and isolated contexts.\n');
    return;
  }
  try {
    let source = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      source += chunk;
      if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error('Adapter input exceeds 2 MiB.');
    }
    const input = parseAdapterInput(source);
    const result = input.phase === 'prepare' ? await prepareLifecycleWorkflow(input) : await gradeLifecycleWorkflow(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
