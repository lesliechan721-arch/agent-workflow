import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCodexArgs,
  createEvalWorkspace,
  readEvalResource,
} from '../evals/eval-harness.mjs';
import {
  setupTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from '../evals/trigger-fixture.mjs';

const ROLE_NAMES = [
  'codex-subagent-simple',
  'codex-subagent-general',
  'codex-subagent-complex',
  'codex-subagent-plan-review',
];

async function testEvalCorpus() {
  const document = JSON.parse(await readEvalResource('trigger-cases.json'));
  const { cases } = document;
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, 'codex-subagent-guide');
  assert.equal(cases.length, 30);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 14);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 9);
  assert.equal(cases.filter((entry) => entry.split === 'sanity').length, 7);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.equal(cases.every((entry) => typeof entry.should_spawn_agent === 'boolean'), true);
  assert.equal(
    cases.filter((entry) => entry.workspace_fixture === 'project_authorization')
      .every((entry) => entry.use_project_rules === true),
    true,
  );

  const expectedContracts = new Map([
    ['authorized_simple_lookup', [true, true]],
    ['specialized_workflow_owns_lifecycle', [false, false]],
    ['explicit_skill_without_authority', [true, false]],
    ['validation_should_we_delegate', [false, false]],
    ['sanity_existing_cleanup', [true, false]],
  ]);
  for (const [id, [shouldLoad, shouldSpawn]] of expectedContracts) {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.ok(entry, `Missing required eval case ${id}`);
    assert.equal(entry.should_load_skill, shouldLoad);
    assert.equal(entry.should_spawn_agent, shouldSpawn);
  }
}

async function testFixtureVariants() {
  assert.deepEqual(
    [...TRIGGER_WORKSPACE_FIXTURES],
    ['default', 'project_authorization', 'authorization_skill', 'lifecycle_skill'],
  );
  for (const fixture of TRIGGER_WORKSPACE_FIXTURES) {
    const root = await mkdtemp(path.join(os.tmpdir(), `subagent-fixture-${fixture}-`));
    try {
      await setupTriggerWorkspace({
        workspaceRoot: root,
        evalCase: { workspace_fixture: fixture },
      });
      assert.match(await readFile(path.join(root, 'src', 'simple.ts'), 'utf8'), /retryLimit/);
      if (fixture === 'project_authorization') {
        assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /authorized and required/);
      }
      if (fixture === 'authorization_skill') {
        assert.match(
          await readFile(
            path.join(root, '.agents', 'skills', 'delegation-authorizer', 'SKILL.md'),
            'utf8',
          ),
          /does not choose an agent type/,
        );
      }
      if (fixture === 'lifecycle_skill') {
        assert.match(
          await readFile(
            path.join(root, '.agents', 'skills', 'delegation-lifecycle-owner', 'SKILL.md'),
            'utf8',
          ),
          /fully owns role selection/,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function writeFinalSubject(root) {
  const skillRoot = path.join(root, '.agents', 'skills', 'codex-subagent-guide');
  const roleRoot = path.join(root, '.codex', 'agents');
  await Promise.all([
    mkdir(skillRoot, { recursive: true }),
    mkdir(roleRoot, { recursive: true }),
  ]);
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# Materialized Guide\n', 'utf8');
  await writeFile(path.join(root, '.codex', 'config.toml'), '# materialized config\n', 'utf8');
  await Promise.all(ROLE_NAMES.map((name) => writeFile(
    path.join(roleRoot, `aw-guide-${name}.toml`),
    [
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(`Role ${name}`)}`,
      'developer_instructions = "Read-only role."',
      '',
    ].join('\n'),
    'utf8',
  )));
}

async function testSpecializedWorkspaceUsesFinalArtifact() {
  const subject = await mkdtemp(path.join(os.tmpdir(), 'subagent-final-subject-'));
  const previous = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  try {
    await writeFinalSubject(subject);
    process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = subject;
    const current = await createEvalWorkspace({ withSkill: true, fixture: 'project_authorization' });
    const baseline = await createEvalWorkspace({ withSkill: false, fixture: 'default' });
    try {
      assert.equal(await readFile(current.skillPath, 'utf8'), '# Materialized Guide\n');
      assert.deepEqual(current.roles.map((role) => role.roleFile.name).sort(), [...ROLE_NAMES].sort());
      await assert.rejects(readFile(baseline.skillPath, 'utf8'), /ENOENT/);
      await assert.rejects(readFile(path.join(current.root, '.codex', 'config.toml'), 'utf8'), /ENOENT/);
      const args = buildCodexArgs(
        current,
        { query: 'delegate', codex_config: {}, omit_roles: ['codex-subagent-simple'] },
        { profile: 'v2', model: 'gpt-test' },
      );
      assert.ok(args.includes('multi_agent'));
      assert.ok(args.includes('gpt-test'));
      assert.equal(
        args.some((arg) => arg.includes('agents.codex-subagent-simple.config_file=')),
        false,
      );
      assert.equal(
        args.some((arg) => arg.includes('agents.codex-subagent-general.config_file=')),
        true,
      );
      assert.equal(args.includes('--ignore-rules'), false);
    } finally {
      await Promise.all([
        rm(current.root, { recursive: true, force: true }),
        rm(baseline.root, { recursive: true, force: true }),
      ]);
    }
  } finally {
    if (previous === undefined) delete process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
    else process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = previous;
    await rm(subject, { recursive: true, force: true });
  }
}

async function testMissingFinalArtifactFails() {
  const previous = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  delete process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  try {
    await assert.rejects(createEvalWorkspace(), /AW_PLUGIN_EVAL_PROJECT_ROOT is required/);
  } finally {
    if (previous === undefined) delete process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
    else process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = previous;
  }
}

async function main() {
  await testEvalCorpus();
  await testFixtureVariants();
  await testSpecializedWorkspaceUsesFinalArtifact();
  await testMissingFinalArtifactFails();
  console.log('codex-subagent-guide trigger assets and specialized harness tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
