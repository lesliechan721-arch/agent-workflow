import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareExecutionWorkflow, gradeExecutionWorkflow, interactionSteps } from '../skills/dev-build/evals/workflow-evaluation.mjs';
import { verifyExport, verifyCurrentPage, semanticChecks } from '../skills/dev-build/evals/workflow-results.mjs';
import { syncWorkflowEvals } from './sync-workflow-evals.mjs';

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.AW_PLUGIN_CONTEXT ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')) : null;
if (target) { assert.equal(target.event, 'test'); assert.equal(target.plugin.name, 'dev-workflow'); }
const root = target?.sourceRoot ?? localRoot;
const evalRoot = path.join(root, 'skills/dev-build/evals');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const files = [
  'skills/dev-build/evals/workflow-defaults.cases.json',
  'skills/dev-workflow/evals/continuous-alignment-workflow.cases.json',
  'skills/dev-build/evals/execution-milestone-cases.json',
  'skills/dev-build/evals/alignment-execution-cases.json',
  'skills/dev-workflow/evals/continuous-alignment-cases.json',
];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-adapter-'));
  const paths = {
    workspace: path.join(directory, 'workspace/subject'), fixtures: path.join(directory, 'workspace/eval'),
    output: path.join(directory, 'output'), evidence: path.join(directory, 'output/workflow-evidence.json'),
    modelOutput: path.join(directory, 'output/model-output.txt'),
  };
  await Promise.all([paths.workspace, paths.fixtures, paths.output].map((file) => mkdir(file, { recursive: true })));
  return { directory, paths };
}

test('all execution cases prepare real isolated fixtures without running a model or exposing answers', async () => {
  for (const file of files) {
    const document = await json(path.join(root, file));
    for (const selected of document.cases) {
      const state = await fixture();
      try {
        const prepared = await prepareExecutionWorkflow({ case: selected, paths: state.paths });
        assert.equal(prepared.prompt, selected.input.task);
        assert.equal(prepared.model, null);
        assert.equal(prepared.evaluation.checks.length > 0, true);
        const visible = [prepared.prompt, prepared.developerInstructions];
        for (const file of Object.keys(selected.input.workspaceFiles)) visible.push(await readFile(path.join(state.paths.workspace, file), 'utf8'));
        for (const role of prepared.roles) visible.push(await readFile(path.join(state.paths.workspace, role.configFile), 'utf8'));
        for (const step of prepared.evaluation.interactions) assert.equal(visible.some((text) => text.includes(step.answer)), false, selected.id);
        const baseline = await json(path.join(state.paths.output, 'fixture-baseline.json'));
        assert.match(baseline.head, /^[a-f0-9]{40}$/u);
        assert.match(baseline.tree, /^[a-f0-9]{40}$/u);
      } finally {
        await rm(state.directory, { recursive: true, force: true });
      }
    }
  }
});

test('paired answer cases have identical visible initial inputs and distinct hidden answers', async () => {
  const document = await json(path.join(root, 'skills/dev-workflow/evals/continuous-alignment-workflow.cases.json'));
  const [filtered, all] = document.cases;
  assert.equal(filtered.input.task, all.input.task);
  assert.deepEqual(filtered.input.workspaceFiles, all.input.workspaceFiles);
  assert.notEqual(interactionSteps(filtered)[0].answer, interactionSteps(all)[0].answer);
});

test('export oracle rejects the opposite user answer and verifies the actual implementation signature', async () => {
  const state = await fixture();
  try {
    await mkdir(path.join(state.paths.workspace, 'src'));
    await writeFile(path.join(state.paths.workspace, 'package.json'), '{"type":"module"}');
    for (const implemented of ['filtered', 'all']) {
      await writeFile(path.join(state.paths.workspace, 'src/export.js'), `export function chooseExportRows(allRows,filteredRows){return [...${implemented === 'all' ? 'allRows' : 'filteredRows'}];}`);
      for (const answer of ['filtered', 'all']) {
        const result = await verifyExport(state.paths.workspace, answer);
        assert.equal(result.verdict, answer === implemented ? 'pass' : 'fail', result.evidence);
      }
    }
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test('current-page oracle checks real disjoint service inputs, not a fixture-specific constant', async () => {
  const state = await fixture();
  try {
    await mkdir(path.join(state.paths.workspace, 'src'));
    await writeFile(path.join(state.paths.workspace, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(state.paths.workspace, 'src/export.js'), 'export async function exportCustomers(service){return {rows:(await service.firstPage()).items,scopeLabel:"当前页"}}');
    assert.equal((await verifyCurrentPage(state.paths.workspace)).verdict, 'pass');
    await writeFile(path.join(state.paths.workspace, 'src/export.js'), 'export async function exportCustomers(){return {rows:[{id:"c1"},{id:"c2"}],scopeLabel:"当前页"}}');
    assert.equal((await verifyCurrentPage(state.paths.workspace)).verdict, 'fail');
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test('product correctness and model approval labels cannot fill missing user/Review evidence', async () => {
  const document = await json(path.join(root, 'skills/dev-workflow/evals/continuous-alignment-cases.json'));
  const selected = document.cases[0];
  const state = await fixture();
  try {
    await prepareExecutionWorkflow({ case: selected, paths: state.paths });
    await writeFile(path.join(state.paths.workspace, 'src/export.js'), 'export const chooseExportRows=(allRows,filteredRows)=>[...filteredRows];');
    await writeFile(path.join(state.paths.workspace, 'decisions.md'), '# 已确认\nfiltered');
    const evidence = {
      version: 1, rootThreadId: 'root', workspaceDiff: { added: ['decisions.md'], modified: ['src/export.js'], removed: [] },
      termination: { appServerProcessTreeCleanupConfirmed: true }, cleanup: { isolatedCodexHomeRemoved: true },
      finalMessage: 'User approved; independent Review clean.',
    };
    await writeFile(state.paths.evidence, JSON.stringify(evidence));
    const grade = await gradeExecutionWorkflow({ case: selected, paths: state.paths });
    assert.equal(grade.passed, false);
    assert.equal(grade.details.complete, false);
    assert.equal(grade.details.checks.find((item) => item.name === 'actual-user-answers').verdict, 'fail');
    assert.equal(semanticChecks(selected, evidence).every((item) => item.verdict === 'unknown'), true);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test('Eval-local generated closure remains synchronized with the canonical provider', async () => {
  assert.deepEqual(await syncWorkflowEvals({ pluginRoot: root }), { ok: true, checked: 6, drift: [] });
});

