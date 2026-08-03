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
  executionErrorEvidence,
  inspectExecEvent,
  parseExecEventLine,
} from '../evals/eval-harness.mjs';
import {
  loadEvalCases,
  parseArgs,
  summarizeCase,
} from '../evals/run-trigger-evals.mjs';

async function testEvalCorpus() {
  const cases = await loadEvalCases('all');
  assert.equal(cases.length, 26);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 12);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(cases.filter((entry) => entry.split === 'sanity').length, 6);
  assert.equal(cases.filter((entry) => entry.should_load_skill).length, 16);
  assert.equal(cases.filter((entry) => !entry.should_load_skill).length, 10);
  assert.equal(cases.filter((entry) => entry.should_spawn_agent).length, 12);
  assert.equal(
    cases.filter((entry) => entry.should_load_skill && !entry.should_spawn_agent).length,
    4,
  );
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);

  const required = new Map([
    ['authorized_simple_lookup', [true, true]],
    ['decision_only_near_miss', [false, false]],
    ['explicit_skill_without_authority', [true, false]],
    ['manage_existing_agent', [true, false]],
    ['validation_config_help', [false, false]],
    ['sanity_existing_cleanup', [true, false]],
  ]);
  for (const [id, [shouldLoad, shouldSpawn]] of required) {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required trigger case ${id}`);
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
  assert.throws(() => parseArgs(['--split', 'unknown']), /train, validation, sanity, or all/);
  assert.throws(() => parseArgs(['--runs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--threshold', '1']), /less than 1/);
}

function testJsonlDetection() {
  assert.equal(parseExecEventLine('not json'), null);
  const loadEvent = parseExecEventLine(JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: "sed -n '1,120p' .agents/skills/codex-subagent-guide/SKILL.md",
    },
  }));
  assert.deepEqual(
    inspectExecEvent(loadEvent, '/tmp/eval/.agents/skills/codex-subagent-guide/SKILL.md'),
    {
      loaded: true,
      loadEvidence: "sed -n '1,120p' .agents/skills/codex-subagent-guide/SKILL.md",
    },
  );
  const spawnEvent = parseExecEventLine(JSON.stringify({
    type: 'item.started',
    item: {
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      prompt: 'Review the change.',
    },
  }));
  assert.deepEqual(
    inspectExecEvent(spawnEvent, '/tmp/eval/.agents/skills/codex-subagent-guide/SKILL.md'),
    { spawned: true, spawnEvidence: 'Review the change.' },
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
  assert.match(
    executionErrorEvidence({
      stderr: 'Reading additional input from stdin...',
      event_trace: [{ type: 'error', message: 'spawn_agent must match the configured schema' }],
    }),
    /must match the configured schema/,
  );
}

async function testWorkspaceStaging() {
  const workspace = await createEvalWorkspace({ withSkill: true });
  try {
    const [skill, ...roleFiles] = await Promise.all([
      readFile(workspace.skillPath, 'utf8'),
      ...workspace.roles.map((role) => readFile(role.rolePath, 'utf8')),
    ]);
    assert.match(skill, /适用 AGENTS\.md 或其它技能已明确要求 Codex 使用子代理/);
    assert.match(skill, /正整数 `fork_turns` 表示部分历史/);
    assert.deepEqual(
      workspace.roles.map((role) => role.roleFile.name),
      [
        'codex-subagent-simple',
        'codex-subagent-general',
        'codex-subagent-complex',
        'codex-subagent-plan-review',
      ],
    );
    const instructions = new Set(
      workspace.roles.map((role) => role.roleFile.developer_instructions),
    );
    assert.equal(instructions.size, 1);
    for (const roleFile of roleFiles) {
      assert.match(roleFile, /developer_instructions = "完成父代理/);
    }

    const v1Args = buildCodexArgs(
      workspace,
      { query: 'delegate', omit_roles: ['codex-subagent-simple'] },
      { profile: 'v1', model: 'gpt-v1' },
    );
    assert.ok(v1Args.includes('--json'));
    assert.ok(v1Args.includes('gpt-v1'));
    assert.ok(v1Args.includes('features.multi_agent_v2.enabled=false'));
    assert.equal(
      v1Args.some((arg) => arg.includes('agents.codex-subagent-simple.description=')),
      false,
    );
    const v2Args = buildCodexArgs(
      workspace,
      { query: 'delegate' },
      { profile: 'v2' },
    );
    assert.ok(v2Args.includes('features.multi_agent_v2.enabled=true'));
    assert.ok(v2Args.includes('features.multi_agent_v2.expose_spawn_agent_model_overrides=true'));
    assert.ok(v2Args.includes('read-only'));
    assert.ok(v2Args.includes('shell_environment_policy.exclude=["CODEX_HOME"]'));
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

async function testCredentialIsolation() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-auth-copy-'));
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
