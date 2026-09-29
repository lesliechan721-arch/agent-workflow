import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { gradeLifecycleWorkflow, prepareLifecycleWorkflow, verifySelection } from '../skills/dev-workflow/evals/method-lifecycle-workflow.mjs';

const execute = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')) : null;
const evalRoot = path.join(context?.sourceRoot ?? localRoot, 'skills/dev-workflow/evals');
const cases = JSON.parse(await readFile(path.join(evalRoot, 'method-lifecycle-workflow.cases.json'), 'utf8')).cases;
const goodSelection = 'export const selectRecords=(rows,tenantId,selectedIds)=>rows.filter(row=>row.tenantId===tenantId&&selectedIds.includes(row.id));\n';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lifecycle-workflow-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    workspace: path.join(root, 'workspace/subject'), fixtures: path.join(root, 'workspace/eval'),
    output: path.join(root, 'output'), evidence: path.join(root, 'output/workflow-evidence.json'),
    modelOutput: path.join(root, 'output/model-output.txt'),
  };
  await Promise.all([paths.workspace, paths.fixtures, paths.output].map((file) => mkdir(file, { recursive: true })));
  return { root, paths };
}

async function git(workspace, args) {
  return (await execute('git', args, { cwd: workspace, timeout: 10_000 })).stdout.trim();
}

// Synthetic Engine evidence exercises the adapter boundary only. It is not a
// model run, an independent Review, or evidence that the Skill follows the rules.
function evidenceFor(prepared) {
  return {
    version: 1, rootThreadId: 'root', completion: { status: 'completed' },
    termination: { appServerProcessTreeCleanupConfirmed: true }, cleanup: { isolatedCodexHomeRemoved: true },
    skillLoads: ['decision-shape', 'decision-grill', 'decision-prototype'].map((skill) => ({ threadId: 'root', skill })),
    evaluation: {
      checks: prepared.evaluation.checks.map(({ name }) => ({ name, verdict: 'pass', evidence: 'Synthetic boundary fixture.' })),
      decisions: prepared.evaluation.interactions.map((step, index) => ({
        id: step.id, status: 'delivered', answer: step.answer,
        questionOrdinal: index * 2 + 1, answerOrdinal: index * 2 + 2,
      })),
    },
  };
}

test('all four adapter CLI cases prepare real fixtures and keep answers outside subject inputs', async (t) => {
  for (const selected of cases) {
    const state = await fixture(t);
    const { workspace, fixtures, output } = state.paths;
    const prepared = JSON.parse(execFileSync(process.execPath, [path.join(evalRoot, 'method-lifecycle-workflow.mjs')], {
      cwd: state.root, encoding: 'utf8', timeout: 15_000,
      input: JSON.stringify({ version: 1, phase: 'prepare', variant: 'current', attempt: 1, case: selected, paths: { workspace, fixtures, output } }),
    }));
    assert.equal(prepared.model, null);
    assert.equal(prepared.sandbox, 'workspace-write');
    const visible = [prepared.prompt, prepared.developerInstructions, prepared.evaluation.setupPrompt ?? ''];
    for (const file of Object.keys(selected.input.workspaceFiles)) visible.push(await readFile(path.join(workspace, file), 'utf8'));
    for (const role of prepared.roles) visible.push(await readFile(path.join(workspace, role.configFile), 'utf8'));
    for (const step of prepared.evaluation.interactions) {
      assert.equal(visible.some((text) => text.includes(step.answer)), false, selected.id);
      assert.equal(step.protectedPaths.every((file) => prepared.evaluation.artifacts.includes(file)), true);
    }
    assert.equal(await git(workspace, ['ls-files', '--', '.dev-workflows']), '');
    if (selected.id !== 'completed-project-without-local-history') {
      const generated = prepared.evaluation.artifacts.filter((file) => file.endsWith('/spec.md') || file.endsWith('/artifact/index.html'));
      for (const file of generated) await assert.rejects(readFile(path.join(workspace, file)), { code: 'ENOENT' });
    }
  }
});

test('selection oracle distinguishes accepted behavior from tenant, empty, identity, order and mutation errors', async (t) => {
  const state = await fixture(t);
  await mkdir(path.join(state.paths.workspace, 'src'));
  await writeFile(path.join(state.paths.workspace, 'package.json'), '{"type":"module"}');
  const mutations = [
    'return rows.filter(r=>ids.includes(r.id));',
    'return ids.length ? rows.filter(r=>r.tenantId===tenant&&ids.includes(r.id)) : rows;',
    'return rows.filter(r=>r.tenantId===tenant&&ids.some(id=>id.toLowerCase()===r.id.toLowerCase()));',
    'return rows.filter(r=>r.tenantId===tenant&&ids.includes(r.id)).reverse();',
    'rows.sort((a,b)=>a.id.localeCompare(b.id)); return rows.filter(r=>r.tenantId===tenant&&ids.includes(r.id));',
  ];
  for (const body of mutations) {
    await writeFile(path.join(state.paths.workspace, 'src/select.js'), `export function selectRecords(rows,tenant,ids){${body}}`);
    assert.equal((await verifySelection(state.paths.workspace)).verdict, 'fail', body);
  }
  await writeFile(path.join(state.paths.workspace, 'src/select.js'), goodSelection);
  assert.equal((await verifySelection(state.paths.workspace)).verdict, 'pass');
});

test('adapter refuses absent artifacts, missing independent checks, and fabricated or unordered answers', async (t) => {
  const selected = cases.find((item) => item.id === 'shape-grill-before-material-answer');
  const state = await fixture(t);
  const prepared = await prepareLifecycleWorkflow({ case: selected, paths: state.paths });
  const evidence = evidenceFor(prepared);
  const grade = async (value) => {
    await writeFile(state.paths.evidence, JSON.stringify(value));
    return gradeLifecycleWorkflow({ case: selected, paths: state.paths, variant: 'current' });
  };
  assert.equal((await grade(evidence)).passed, false);
  await mkdir(path.join(state.paths.workspace, '.dev-workflows/export'), { recursive: true });
  await writeFile(path.join(state.paths.workspace, '.dev-workflows/export/spec.md'), '# Synthetic artifact\n');
  assert.equal((await grade(evidence)).passed, true);
  const missing = structuredClone(evidence);
  missing.evaluation.checks.pop();
  assert.equal((await grade(missing)).details.complete, false);
  const unknown = structuredClone(evidence);
  unknown.evaluation.checks[0].verdict = 'unknown';
  assert.equal((await grade(unknown)).passed, false);
  for (const change of [
    (value) => { value.evaluation.decisions = []; },
    (value) => { value.evaluation.decisions[0].answer = 'subject-authored approval'; },
    (value) => { value.evaluation.decisions[0].answerOrdinal = 0; },
    (value) => { value.skillLoads = []; },
  ]) {
    const changed = structuredClone(evidence);
    change(changed);
    assert.equal((await grade(changed)).passed, false);
  }
});

test('generated Spec requires confirmation before a separate implementation authorization', async (t) => {
  const selected = cases.find((item) => item.id === 'generated-local-spec-to-clean-context');
  const state = await fixture(t);
  const prepared = await prepareLifecycleWorkflow({ case: selected, paths: state.paths });
  // Text questions must use the Engine's interactive turns, not its non-interactive setup transition.
  assert.equal(prepared.evaluation.setupPrompt, undefined);
  assert.deepEqual(prepared.evaluation.interactions.map((step) => step.id), [
    'selection-spec-confirmed', 'selection-implementation-authorized',
  ]);
  for (const step of prepared.evaluation.interactions) assert.ok(step.protectedPaths.includes('src/select.js'));
  await mkdir(path.join(state.paths.workspace, '.dev-workflows/selection'), { recursive: true });
  await writeFile(path.join(state.paths.workspace, '.dev-workflows/selection/spec.md'), '# Synthetic artifact\n');
  for (const file of ['task.md', 'work.md']) {
    await assert.rejects(readFile(path.join(state.paths.workspace, '.dev-workflows/selection', file)), { code: 'ENOENT' });
  }
  await writeFile(path.join(state.paths.workspace, 'src/select.js'), goodSelection);
  const evidence = evidenceFor(prepared);
  const grade = async (value) => {
    await writeFile(state.paths.evidence, JSON.stringify(value));
    return gradeLifecycleWorkflow({ case: selected, paths: state.paths, variant: 'current' });
  };
  assert.equal((await grade(evidence)).passed, true);
  for (const verdict of ['fail', 'unknown', 'missing']) {
    const unrecoverable = structuredClone(evidence);
    const recovery = unrecoverable.evaluation.checks.find((item) => item.name === 'design-recovery');
    assert.ok(recovery, 'The Engine must independently check recoverable decisions, sources and open questions.');
    if (verdict === 'missing') {
      unrecoverable.evaluation.checks = unrecoverable.evaluation.checks.filter((item) => item !== recovery);
    } else recovery.verdict = verdict;
    assert.equal((await grade(unrecoverable)).passed, false, 'A readable Spec alone does not prove recoverable design evidence.');
  }
  for (const [questionOrdinal, answerOrdinal] of [[1, 2], [0, 1], [1, 4]]) {
    const premature = structuredClone(evidence);
    Object.assign(premature.evaluation.decisions[1], { questionOrdinal, answerOrdinal });
    const result = await grade(premature);
    assert.equal(result.passed, false, 'Implementation authorization must follow Spec confirmation.');
    assert.equal(result.details.checks.find((item) => item.name === 'decision:selection-implementation-authorized').verdict, 'fail');
  }
});

test('committed project cannot pass when no project tests execute', async (t) => {
  const selected = cases.find((item) => item.id === 'completed-project-without-local-history');
  for (const mode of ['missing', 'skipped']) {
    await t.test(mode, async (t) => {
      const state = await fixture(t);
      const prepared = await prepareLifecycleWorkflow({ case: selected, paths: state.paths });
      const workspace = state.paths.workspace;
      await writeFile(path.join(workspace, 'src/select.js'), goodSelection);
      if (mode === 'missing') await rm(path.join(workspace, 'test/select.test.js'));
      else await writeFile(path.join(workspace, 'test/select.test.js'), "import test from 'node:test';\ntest.skip('selection',()=>{});\n");
      await git(workspace, ['commit', '--only', '-m', 'selection with no executed tests', '--', 'src/select.js', 'test/select.test.js']);
      await writeFile(state.paths.evidence, JSON.stringify(evidenceFor(prepared)));
      const result = await gradeLifecycleWorkflow({ case: selected, paths: state.paths, variant: 'current' });
      assert.equal(result.passed, false, 'A successful process exit is not evidence of executed tests.');
      assert.equal(result.details.checks.find((item) => item.name === 'committed-project-tests').verdict, 'fail');
    });
  }
});

test('final project grading reads committed behavior without local history and preserves unrelated staging', async (t) => {
  const selected = cases.find((item) => item.id === 'completed-project-without-local-history');
  for (const mode of ['valid', 'bad-committed-product', 'tracked-local-process', 'unrelated-commit', 'missing-local-source']) {
    const state = await fixture(t);
    const prepared = await prepareLifecycleWorkflow({ case: selected, paths: state.paths });
    const workspace = state.paths.workspace;
    await writeFile(path.join(workspace, 'src/select.js'), mode === 'bad-committed-product'
      ? 'export const selectRecords=(rows,tenantId)=>rows.filter(row=>row.tenantId===tenantId);\n' : goodSelection);
    if (mode === 'unrelated-commit') {
      await git(workspace, ['add', '--', 'src/select.js']);
      await git(workspace, ['commit', '-m', 'incorrectly includes user staging']);
    } else {
      await git(workspace, ['commit', '--only', '-m', 'selection delivery', '--', 'src/select.js']);
    }
    if (mode === 'bad-committed-product') await writeFile(path.join(workspace, 'src/select.js'), goodSelection);
    if (mode === 'tracked-local-process') await git(workspace, ['add', '--force', '--', '.dev-workflows/selection/spec.md']);
    if (mode === 'missing-local-source') await rm(path.join(workspace, '.dev-workflows/selection/task.md'));
    await writeFile(state.paths.evidence, JSON.stringify(evidenceFor(prepared)));
    const result = await gradeLifecycleWorkflow({ case: selected, paths: state.paths, variant: 'current' });
    assert.equal(result.passed, mode === 'valid', JSON.stringify(result.details.checks));
    assert.equal(await readFile(path.join(workspace, '.dev-workflows/selection/spec.md'), 'utf8'), selected.input.workspaceFiles['.dev-workflows/selection/spec.md']);
    assert.equal(await readFile(path.join(workspace, 'personal-notes.txt'), 'utf8'), '用户另外未暂存的无关笔记\n');
    if (mode === 'valid') assert.equal(await git(workspace, ['diff', '--cached', '--name-only']), 'personal-notes.txt');
  }
});
