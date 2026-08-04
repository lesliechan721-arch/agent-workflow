import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCodexArgs,
  copyCodexAuthFiles,
  createEvalWorkspace,
  inspectExecEvent,
  loadEvalCases,
  parseArgs,
  parseExecEventLine,
  summarizeCase,
} from '../evals/run-trigger-evals.mjs';

async function testEvalCorpus() {
  const cases = await loadEvalCases('all');
  assert.equal(cases.length, 31);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 13);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(cases.filter((entry) => entry.split === 'sanity').length, 10);
  assert.equal(cases.filter((entry) => entry.should_load_skill).length, 19);
  assert.equal(cases.filter((entry) => !entry.should_load_skill).length, 12);
  assert.equal(cases.filter((entry) => entry.should_spawn_agent).length, 16);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);

  const expectedContracts = new Map([
    ['cross_module_fact', [true, true]],
    ['explicit_known_file', [true, false]],
    ['skill_design_review', [false, false]],
    ['large_pr_review', [false, false]],
    ['readonly_deep_code_review', [false, false]],
    ['official_docs_and_logs', [true, true]],
    ['casual_unknown_repo', [true, true]],
    ['typo_unknown_repo', [true, true]],
    ['plain_name_small_request', [true, false]],
    ['composite_review_boundary', [true, true]],
    ['composite_write_boundary', [true, true]],
    ['typo_known_file_near_miss', [false, false]],
  ]);
  for (const [id, [shouldLoad, shouldSpawn]] of expectedContracts) {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required eval case ${id}`);
    assert.equal(entry.should_load_skill, shouldLoad);
    assert.equal(entry.should_spawn_agent, shouldSpawn);
  }
}

function testArguments() {
  assert.deepEqual(
    parseArgs(['--split', 'validation', '--runs', '5', '--threshold', '0.6']),
    {
      split: 'validation',
      runs: 5,
      threshold: 0.6,
      timeoutMs: 180_000,
      codexBin: 'codex',
      model: undefined,
      output: undefined,
      help: false,
    },
  );
  assert.throws(
    () => parseArgs(['--split', 'unknown']),
    /train, validation, sanity, or all/,
  );
  assert.throws(() => parseArgs(['--runs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--threshold', '1']), /less than 1/);
}

function testJsonlDetection() {
  assert.equal(parseExecEventLine('not json'), null);
  const loadEvent = parseExecEventLine(JSON.stringify({
    type: 'item.started',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: "sed -n '1,220p' .agents/skills/codex-explore/SKILL.md",
    },
  }));
  assert.deepEqual(
    inspectExecEvent(loadEvent, '/tmp/eval/.agents/skills/codex-explore/SKILL.md'),
    {
      loaded: true,
      loadEvidence: "sed -n '1,220p' .agents/skills/codex-explore/SKILL.md",
    },
  );

  const spawnEvent = parseExecEventLine(JSON.stringify({
    type: 'item.started',
    item: {
      id: 'item_2',
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      prompt: 'Trace the cross-module fact.',
    },
  }));
  assert.deepEqual(
    inspectExecEvent(spawnEvent, '/tmp/eval/.agents/skills/codex-explore/SKILL.md'),
    {
      spawned: true,
      spawnEvidence: 'Trace the cross-module fact.',
    },
  );
}

function testSummary() {
  const summary = summarizeCase(
    {
      id: 'example',
      split: 'train',
      query: 'query',
      should_load_skill: true,
      should_spawn_agent: false,
    },
    [
      { loaded: true, spawned: false, execution_error: false },
      { loaded: true, spawned: false, execution_error: false },
      { loaded: false, spawned: false, execution_error: false },
    ],
    0.5,
  );
  assert.equal(summary.observed.load_rate, 2 / 3);
  assert.equal(summary.observed.spawn_rate, 0);
  assert.equal(summary.passed, true);
}

async function testWorkspaceStaging() {
  const workspace = await createEvalWorkspace();
  try {
    const [skill, ...roles] = await Promise.all([
      readFile(workspace.skillPath, 'utf8'),
      ...workspace.roles.map((role) => readFile(role.rolePath, 'utf8')),
    ]);
    assert.match(skill, /compatibility: 仅适用于支持 spawn_agent\.agent_type 的 Codex/);
    assert.match(skill, /spawn_agent 不提供子代理只读 sandbox.*只读.*行为约束/);
    assert.match(skill, /用户把权限级只读作为继续条件/);
    assert.equal(skill.includes('user-invocable:'), false);
    assert.deepEqual(
      workspace.roles.map((role) => role.roleFile.name),
      [
        'codex-explore-quick',
        'codex-explore-standard',
        'codex-explore-deep',
        'codex-explore-custom',
      ],
    );
    for (const role of roles) {
      assert.match(role, /区分直接证据、推断、冲突和缺失/);
      assert.match(role, /尤其不得调用 `wait_agent`/);
    }
    assert.match(roles[0], /model = "gpt-5\.6-luna"/);
    assert.match(roles[0], /model_reasoning_effort = "medium"/);
    assert.match(roles[1], /model_reasoning_effort = "high"/);
    assert.match(roles[2], /model_reasoning_effort = "xhigh"/);
    assert.equal(roles[3].includes('\nmodel = '), false);
    assert.equal(roles[3].includes('\nmodel_reasoning_effort = '), false);

    const args = buildCodexArgs(
      workspace,
      { query: '$codex-explore read known/settings.ts' },
      { model: 'gpt-test' },
    );
    assert.ok(args.includes('--json'));
    assert.equal(args.includes('--ephemeral'), false);
    assert.ok(args.includes('--ignore-rules'));
    assert.ok(args.includes('read-only'));
    assert.ok(args.includes('gpt-test'));
    assert.ok(args.includes('shell_environment_policy.exclude=["CODEX_HOME"]'));
    for (const roleName of [
      'codex-explore-quick',
      'codex-explore-standard',
      'codex-explore-deep',
      'codex-explore-custom',
    ]) {
      assert.ok(args.some((arg) => arg.includes(`agents.${roleName}.config_file=`)));
    }
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

async function testCredentialIsolation() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-copy-'));
  const sourceHome = path.join(root, 'source');
  const targetHome = path.join(root, 'target');
  try {
    await Promise.all([
      mkdir(sourceHome, { recursive: true }),
      mkdir(targetHome, { recursive: true }),
    ]);
    await writeFile(path.join(sourceHome, 'auth.json'), '{"token":"test"}\n', 'utf8');
    await copyCodexAuthFiles(targetHome, sourceHome);
    const target = path.join(targetHome, 'auth.json');
    assert.equal((await lstat(target)).isSymbolicLink(), false);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(await readFile(target, 'utf8'), '{"token":"test"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  await testEvalCorpus();
  testArguments();
  testJsonlDetection();
  testSummary();
  await testWorkspaceStaging();
  await testCredentialIsolation();
  console.log('trigger eval tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
