import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { prepareExecutionWorkflow, gradeExecutionWorkflow, interactionSteps } from '../skills/dev-build/evals/workflow-evaluation.mjs';
import { verifyExport, verifyCurrentPage, semanticChecks } from '../skills/dev-build/evals/workflow-results.mjs';
import { stageCheckpointCheck, stageProductChecks, verifyExportChoice } from '../skills/dev-build/evals/stage-and-fidelity.mjs';
import { syncWorkflowEvals } from './sync-workflow-evals.mjs';

const execute = promisify(execFile);
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
  'skills/dev-workflow/evals/stage-and-fidelity-workflow.cases.json',
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

async function git(workspace, args) {
  return (await execute('git', args, { cwd: workspace })).stdout.trim();
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

test('stage export oracle accepts each delivered choice and rejects the opposite implementation', async () => {
  const state = await fixture();
  try {
    await mkdir(path.join(state.paths.workspace, 'src'));
    await writeFile(path.join(state.paths.workspace, 'package.json'), '{"type":"module"}');
    const implementations = {
      'filtered-csv': `
        const quote=value=>/[",\\n\\r]/u.test(value)?'"'+value.replaceAll('"','""')+'"':value;
        export function exportRows({filteredRows}) {
          return {format:'csv',content:['id,name',...filteredRows.map(({id,name})=>quote(id)+','+quote(name))].join('\\n')};
        }
      `,
      'page-json': `
        export function exportRows({pageRows}) {
          return {format:'json',content:JSON.stringify(pageRows)};
        }
      `,
    };
    for (const [implemented, source] of Object.entries(implementations)) {
      await writeFile(path.join(state.paths.workspace, 'src/export.js'), source);
      for (const expected of Object.keys(implementations)) {
        const result = await verifyExportChoice(state.paths.workspace, expected);
        assert.equal(result.verdict, expected === implemented ? 'pass' : 'fail', result.evidence);
      }
    }
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test('stage product oracle accepts the model-policy contract and rejects bad product or changed source evidence', async () => {
  const document = await json(path.join(root, 'skills/dev-workflow/evals/stage-and-fidelity-workflow.cases.json'));
  const selected = document.cases.find((item) => item.id === 'full-source-to-task-clean-worker');
  const state = await fixture();
  try {
    await prepareExecutionWorkflow({ case: selected, paths: state.paths });
    const bad = await stageProductChecks(selected, state.paths.workspace, { workspaceDiff: { added: [], modified: [], removed: [] } });
    assert.equal(bad.find((item) => item.name === 'model-policy-and-runtime').verdict, 'fail');

    await writeFile(path.join(state.paths.workspace, 'src/model-policy.js'), `
      const accepts=(id,filter)=>filter.mode==='all'||(filter.mode==='regex'?new RegExp(filter.pattern).test(id):filter.models.includes(id));
      export function chooseRoute(id,filter,upstreamAvailable){return id.startsWith('chatgpt-web/')?'local':upstreamAvailable&&accepts(id,filter)?'upstream':'deny';}
      export function visibleModels(local,remote,filter){return [...new Set([...local,...remote.filter((id)=>!id.startsWith('chatgpt-web/')&&accepts(id,filter))])];}
    `);
    await writeFile(path.join(state.paths.workspace, 'src/runtime-state.js'), "export const applicationState=(savedRevision,loadedRevision)=>savedRevision===loadedRevision?'applied':'pending';\n");
    const good = await stageProductChecks(selected, state.paths.workspace, { workspaceDiff: { added: [], modified: ['src/model-policy.js', 'src/runtime-state.js'], removed: [] } });
    assert.equal(good.find((item) => item.name === 'model-policy-and-runtime').verdict, 'pass');
    assert.equal(good.filter((item) => item.name.startsWith('source:')).every((item) => item.verdict === 'pass'), true);

    await writeFile(path.join(state.paths.workspace, 'decisions.md'), '# changed\n');
    const changedSource = await stageProductChecks(selected, state.paths.workspace, { workspaceDiff: { added: [], modified: ['decisions.md'], removed: [] } });
    assert.equal(changedSource.find((item) => item.name === 'source:decisions.md').verdict, 'fail');
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test('stage realignment and small-task product checks distinguish accepted outcomes from regressions', async () => {
  const document = await json(path.join(root, 'skills/dev-workflow/evals/stage-and-fidelity-workflow.cases.json'));
  const realign = document.cases.find((item) => item.id === 'new-evidence-realign-only-affected-work');
  const small = document.cases.find((item) => item.id === 'no-commit-and-small-task-path');

  const realignState = await fixture();
  try {
    await prepareExecutionWorkflow({ case: realign, paths: realignState.paths });
    const bad = await stageProductChecks(realign, realignState.paths.workspace, { workspaceDiff: { added: [], modified: [], removed: [] } });
    assert.equal(bad.find((item) => item.name === 'realigned-export-and-independent-list').verdict, 'fail');
    await writeFile(path.join(realignState.paths.workspace, 'src/export.js'), 'export async function exportRows(service){const {jobId}=await service.startExport();return {kind:"job",jobId};}\n');
    await writeFile(path.join(realignState.paths.workspace, 'src/list.js'), 'export const listTitle=()=>"客户记录";\n');
    const good = await stageProductChecks(realign, realignState.paths.workspace, { workspaceDiff: { added: [], modified: ['src/export.js', 'src/list.js'], removed: [] } });
    assert.equal(good.find((item) => item.name === 'realigned-export-and-independent-list').verdict, 'pass');
  } finally {
    await rm(realignState.directory, { recursive: true, force: true });
  }

  const smallState = await fixture();
  try {
    await prepareExecutionWorkflow({ case: small, paths: smallState.paths });
    await writeFile(path.join(smallState.paths.workspace, 'README.md'), '# 项目设置\n保留本段。\n');
    const good = await stageProductChecks(small, smallState.paths.workspace, { workspaceDiff: { added: [], modified: ['README.md'], removed: [] } });
    assert.equal(good.find((item) => item.name === 'actual-document').verdict, 'pass');
    assert.equal(good.find((item) => item.name === 'bounded-document-scope').verdict, 'pass');
    const outOfScope = await stageProductChecks(small, smallState.paths.workspace, { workspaceDiff: { added: ['spec.md'], modified: ['README.md'], removed: [] } });
    assert.equal(outOfScope.find((item) => item.name === 'bounded-document-scope').verdict, 'fail');
    await writeFile(path.join(smallState.paths.workspace, 'README.md'), '# 项目设置\n正文被改了。\n');
    const wrongDocument = await stageProductChecks(small, smallState.paths.workspace, { workspaceDiff: { added: [], modified: ['README.md'], removed: [] } });
    assert.equal(wrongDocument.find((item) => item.name === 'actual-document').verdict, 'fail');
  } finally {
    await rm(smallState.directory, { recursive: true, force: true });
  }
});

test('preimplementation checkpoint oracle saves project spec but excludes local process files', async () => {
  const document = await json(path.join(root, 'skills/dev-workflow/evals/stage-and-fidelity-workflow.cases.json'));
  const selected = document.cases.find((item) => item.id === 'preimplementation-baseline-scoped-commit');

  for (const variant of ['project-only', 'product-first', 'process-committed', 'process-staged']) {
    const state = await fixture();
    try {
      await prepareExecutionWorkflow({ case: selected, paths: state.paths });
      const baseline = await json(path.join(state.paths.output, 'fixture-baseline.json'));
      const ticket = '.dev-workflows/model-policy/tickets/model-policy.md';
      await mkdir(path.dirname(path.join(state.paths.workspace, ticket)), { recursive: true });
      await writeFile(path.join(state.paths.workspace, 'spec.md'), '# Spec\n');
      await writeFile(path.join(state.paths.workspace, ticket), '# Task\n');
      const added = ['spec.md'];
      if (variant === 'product-first') {
        await writeFile(path.join(state.paths.workspace, 'src/model-policy.js'), 'export const changed=true;\n');
        added.push('src/model-policy.js');
      }
      await git(state.paths.workspace, ['add', '--', ...added]);
      if (variant === 'process-committed') {
        await git(state.paths.workspace, ['add', '--force', '--', ticket]);
        added.push(ticket);
      }
      await git(state.paths.workspace, ['commit', '-m', 'Implementation baseline', '--', ...added]);
      if (variant === 'process-staged') await git(state.paths.workspace, ['add', '--force', '--', ticket]);
      const result = await stageCheckpointCheck(selected, state.paths.workspace, baseline, git);
      assert.equal(result.verdict, variant === 'project-only' ? 'pass' : 'fail', result.evidence);
      assert.equal(await readFile(path.join(state.paths.workspace, ticket), 'utf8'), '# Task\n');
    } finally {
      await rm(state.directory, { recursive: true, force: true });
    }
  }
});

test('commit permission does not require an optional checkpoint and still rejects unauthorized commits', async () => {
  const stage = await json(path.join(root, 'skills/dev-workflow/evals/stage-and-fidelity-workflow.cases.json'));
  const defaults = await json(path.join(root, 'skills/dev-build/evals/workflow-defaults.cases.json'));
  const cases = [
    stage.cases.find((item) => item.id === 'full-source-to-task-clean-worker'),
    defaults.cases.find((item) => item.id === 'milestone-no-commit-explicit'),
  ];
  for (const selected of cases) {
    const state = await fixture();
    try {
      await prepareExecutionWorkflow({ case: selected, paths: state.paths });
      await writeFile(state.paths.evidence, JSON.stringify({
        version: 1,
        rootThreadId: 'root',
        workspaceDiff: { added: [], modified: [], removed: [] },
        termination: { appServerProcessTreeCleanupConfirmed: true },
        cleanup: { isolatedCodexHomeRemoved: true },
      }));
      for (const committed of [false, true]) {
        if (committed) {
          await writeFile(path.join(state.paths.workspace, 'spec.md'), '# Current project spec\n');
          await git(state.paths.workspace, ['add', '--', 'spec.md']);
          await git(state.paths.workspace, ['commit', '-m', 'Project checkpoint']);
        }
        const result = await gradeExecutionWorkflow({ case: selected, paths: state.paths });
        const permission = result.details.checks.find((item) => item.name === 'git-save-permission');
        assert.equal(permission.verdict, committed && selected.id === 'milestone-no-commit-explicit' ? 'fail' : 'pass');
        assert.equal(result.passed, false, 'Git evidence must not replace independent product and review evidence.');
      }
    } finally {
      await rm(state.directory, { recursive: true, force: true });
    }
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
  assert.deepEqual(await syncWorkflowEvals({ pluginRoot: root }), { ok: true, checked: 7, drift: [] });
});
