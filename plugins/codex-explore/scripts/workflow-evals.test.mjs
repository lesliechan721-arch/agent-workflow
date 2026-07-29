import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  evaluateWorkflowRun,
  loadWorkflowEvalSpec,
  parseWorkflowEvalArgs,
  workflowEvalRunCase,
} from '../evals/run-workflow-evals.mjs';

function passingMessage() {
  return [
    '直接证据：docs/vendor/api-v1.md:2 的 timeout 是 30。',
    '直接证据：docs/vendor/api-v2.md:2 的 timeout 是 45。',
    '直接证据：docs/vendor/migration.md:2 的 timeout 是 45，与 v2 一致。',
    'FACT v1_timeout_seconds=30',
    'FACT v2_timeout_seconds=45',
    'FACT migration_timeout_seconds=45',
    'FACT migration_matches=v2',
  ].join('\n');
}

function runResult(finalMessage) {
  return {
    execution_error: false,
    termination: 'completed',
    exit_code: 0,
    spawn_calls: [{
      arguments: {
        agent_type: 'codex-explore-agent',
      },
    }],
    final_message: finalMessage,
    workspace_changes: {
      added: [],
      removed: [],
      modified: [],
    },
  };
}

function testArguments() {
  assert.deepEqual(
    parseWorkflowEvalArgs(['--runs', '2', '--timeout-ms', '240000']),
    {
      runs: 2,
      timeoutMs: 240_000,
      codexBin: 'codex',
      model: undefined,
      output: undefined,
      help: false,
    },
  );
  assert.throws(
    () => parseWorkflowEvalArgs(['--timeout-ms', '100']),
    /at least 10000/,
  );
  assert.throws(
    () => parseWorkflowEvalArgs(['--variant', 'old']),
    /Unknown option/,
  );
}

async function testSpecAndAssertions() {
  const spec = await loadWorkflowEvalSpec();
  assert.equal(spec.skill_name, 'codex-explore');
  assert.equal(spec.evals.length, 1);
  const entry = spec.evals[0];
  assert.equal(entry.id, 'versioned_docs_outcome');
  assert.match(entry.prompt, /docs\/ 的全部候选文档中搜索并筛选/);
  for (const knownFile of ['api-v1.md', 'api-v2.md', 'migration.md']) {
    assert.equal(entry.prompt.includes(knownFile), false);
  }
  assert.equal(workflowEvalRunCase(entry).wait_for_completion, true);

  assert.equal(
    evaluateWorkflowRun(runResult(passingMessage()), entry.expected).passed,
    true,
  );

  const wrongFacts = passingMessage().replace(
    'FACT v1_timeout_seconds=30',
    'FACT v1_timeout_seconds=45',
  );
  assert.equal(
    evaluateWorkflowRun(runResult(wrongFacts), entry.expected).passed,
    false,
  );

  const changedWorkspace = runResult(passingMessage());
  changedWorkspace.workspace_changes.modified.push('docs/vendor/api-v1.md');
  const changed = evaluateWorkflowRun(changedWorkspace, entry.expected);
  assert.equal(changed.passed, false);
  assert.equal(
    changed.assertions.find(
      (assertion) => assertion.name === 'workspace_unchanged',
    )?.passed,
    false,
  );
}

async function testWorkspaceSnapshots() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-smoke-'));
  try {
    await writeFile(path.join(root, 'known.txt'), 'before\n', 'utf8');
    const before = await captureWorkspaceSnapshot(root);
    await writeFile(path.join(root, 'known.txt'), 'after\n', 'utf8');
    await writeFile(path.join(root, 'added.txt'), 'new\n', 'utf8');
    const after = await captureWorkspaceSnapshot(root);
    assert.deepEqual(diffWorkspaceSnapshots(before, after), {
      added: ['added.txt'],
      removed: [],
      modified: ['known.txt'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  testArguments();
  await testSpecAndAssertions();
  await testWorkspaceSnapshots();
  console.log('workflow eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
