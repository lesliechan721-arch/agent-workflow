import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCodexArgs,
  createEvalWorkspace,
  readEvalResource,
} from '../skills/codex-subagent-guide/evals/eval-harness.mjs';
import {
  setupTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from '../skills/codex-subagent-guide/evals/trigger-fixture.mjs';

const GUIDE_ROLE_NAMES = [
  'codex-subagent-simple',
  'codex-subagent-general',
  'codex-subagent-complex',
  'codex-subagent-plan-review',
];
const EXPLORE_ROLE_NAMES = [
  'codex-explore-quick',
  'codex-explore-standard',
  'codex-explore-deep',
  'codex-explore-custom',
];
const ROLE_NAMES = [...GUIDE_ROLE_NAMES, ...EXPLORE_ROLE_NAMES];

async function testEvalCorpus() {
  const manifest = JSON.parse(await readEvalResource('manifest.json'));
  const releaseSuite = manifest.suites.find((entry) => entry.id === 'trigger');
  const compositionSuite = manifest.suites.find((entry) => entry.id === 'trigger-composition');
  assert.deepEqual(
    {
      cases: releaseSuite?.cases,
      isolation: releaseSuite?.isolation,
      strictNegativeSplits: releaseSuite?.strictNegativeSplits,
      releaseSplits: releaseSuite?.releaseSplits,
      requiredForRelease: releaseSuite?.requiredForRelease,
    },
    {
      cases: './trigger-cases.json',
      isolation: 'strict',
      strictNegativeSplits: ['validation', 'sanity'],
      releaseSplits: ['validation', 'sanity'],
      requiredForRelease: true,
    },
  );
  assert.deepEqual(
    {
      cases: compositionSuite?.cases,
      skills: compositionSuite?.skills,
      isolation: compositionSuite?.isolation,
      strictNegativeSplits: compositionSuite?.strictNegativeSplits,
      minimumPassRate: compositionSuite?.minimumPassRate,
      forbidMultipleSkillLoads: compositionSuite?.forbidMultipleSkillLoads,
      releaseSplits: compositionSuite?.releaseSplits,
      requiredForRelease: compositionSuite?.requiredForRelease,
    },
    {
      cases: './trigger-composition-cases.json',
      skills: ['codex-subagent-guide', 'codex-explore'],
      isolation: 'standard',
      strictNegativeSplits: ['validation', 'sanity'],
      minimumPassRate: 1,
      forbidMultipleSkillLoads: true,
      releaseSplits: [],
      requiredForRelease: false,
    },
  );

  const releaseDocument = JSON.parse(await readEvalResource('trigger-cases.json'));
  const compositionDocument = JSON.parse(
    await readEvalResource('trigger-composition-cases.json'),
  );
  const releaseCases = releaseDocument.cases;
  const compositionCases = compositionDocument.cases;
  const cases = [...releaseCases, ...compositionCases];
  assert.equal(releaseDocument.schemaVersion, 1);
  assert.equal(releaseDocument.skill, 'codex-subagent-guide');
  assert.equal(compositionDocument.schemaVersion, 1);
  assert.equal(compositionDocument.skill, 'codex-subagent-guide');
  assert.equal(releaseCases.length > 0, true);
  assert.equal(compositionCases.length > 0, true);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.equal(cases.every((entry) => typeof entry.should_spawn_agent === 'boolean'), true);
  assert.equal(
    compositionCases.every((entry) => (
      Array.isArray(entry.expected_loaded_skills) && entry.should_load_skill === undefined
    )),
    true,
  );
  assert.equal(
    releaseCases.every((entry) => !['authorization_skill', 'lifecycle_skill'].includes(
      entry.workspace_fixture,
    )),
    true,
  );
  assert.equal(
    compositionCases.every((entry) => ['authorization_skill', 'lifecycle_skill', 'explore_route'].includes(
      entry.workspace_fixture,
    )),
    true,
  );
  assert.equal(
    releaseCases.filter((entry) => entry.workspace_fixture === 'project_authorization')
      .every((entry) => entry.use_project_rules === true),
    true,
  );

}

async function testFixtureVariants() {
  assert.deepEqual(
    [...TRIGGER_WORKSPACE_FIXTURES],
    ['default', 'project_authorization', 'authorization_skill', 'lifecycle_skill', 'explore_route'],
  );
  for (const fixture of TRIGGER_WORKSPACE_FIXTURES) {
    const root = await mkdtemp(path.join(os.tmpdir(), `subagent-fixture-${fixture}-`));
    try {
      await setupTriggerWorkspace({
        workspaceRoot: root,
        evalCase: { workspace_fixture: fixture },
      });
      assert.equal((await readFile(path.join(root, 'src', 'simple.ts'), 'utf8')).length > 0, true);
      if (fixture === 'project_authorization') {
        assert.equal((await readFile(path.join(root, 'AGENTS.md'), 'utf8')).length > 0, true);
      }
      if (fixture === 'authorization_skill') {
        assert.equal(
          (await readFile(
            path.join(root, '.agents', 'skills', 'delegation-authorizer', 'SKILL.md'),
            'utf8',
          )).length > 0,
          true,
        );
      }
      if (fixture === 'lifecycle_skill') {
        assert.equal(
          (await readFile(
            path.join(root, '.agents', 'skills', 'delegation-lifecycle-owner', 'SKILL.md'),
            'utf8',
          )).length > 0,
          true,
        );
      }
      if (fixture === 'explore_route') {
        assert.equal(
          (await readFile(path.join(root, 'repo', 'shared', 'config.ts'), 'utf8')).length > 0,
          true,
        );
        assert.equal(
          (await readFile(
            path.join(root, 'repo', 'modules', 'module-24', 'handler.ts'),
            'utf8',
          )).length > 0,
          true,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function writeFinalSubject(root, { omitRole, duplicateRole } = {}) {
  const skillRoot = path.join(root, '.agents', 'skills', 'codex-subagent-guide');
  const roleRoot = path.join(root, '.codex', 'agents');
  await Promise.all([
    mkdir(skillRoot, { recursive: true }),
    mkdir(roleRoot, { recursive: true }),
  ]);
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# Materialized Guide\n', 'utf8');
  await writeFile(path.join(root, '.codex', 'config.toml'), '# materialized config\n', 'utf8');
  await Promise.all(ROLE_NAMES.filter((name) => name !== omitRole).map((name) => writeFile(
    path.join(roleRoot, `aw-guide-${name}.toml`),
    [
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(`Role ${name}`)}`,
      'developer_instructions = "Read-only role."',
      '',
    ].join('\n'),
    'utf8',
  )));
  if (duplicateRole) {
    await writeFile(
      path.join(roleRoot, `duplicate-${duplicateRole}.toml`),
      [
        `name = ${JSON.stringify(duplicateRole)}`,
        `description = ${JSON.stringify(`Duplicate role ${duplicateRole}`)}`,
        'developer_instructions = "Read-only role."',
        '',
      ].join('\n'),
      'utf8',
    );
  }
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
      assert.deepEqual(
        current.roles.map((role) => role.roleFile.name).sort(),
        [...GUIDE_ROLE_NAMES].sort(),
      );
      await assert.rejects(readFile(baseline.skillPath, 'utf8'), /ENOENT/);
      await assert.rejects(readFile(path.join(current.root, '.codex', 'config.toml'), 'utf8'), /ENOENT/);
      const args = buildCodexArgs(
        current,
        { query: 'delegate', codex_config: {}, omit_roles: ['codex-subagent-simple'] },
        {
          profile: 'v2',
          model: 'gpt-test',
          modelProvider: 'fixture-provider',
          sensitiveEnvironmentNames: ['CUSTOM_TOKEN'],
        },
      );
      assert.ok(args.includes('multi_agent'));
      assert.ok(args.includes('executed_tool_call_metadata'));
      assert.ok(args.includes('features.multi_agent_v2.hide_spawn_agent_metadata=true'));
      assert.ok(args.includes('gpt-test'));
      assert.ok(args.includes('model_provider="fixture-provider"'));
      assert.ok(args.includes('shell_environment_policy.exclude=["CODEX_HOME","CUSTOM_TOKEN"]'));
      assert.equal(args.includes('--ignore-user-config'), false);
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

async function testGuideRoleValidation() {
  const cases = [
    {
      options: { omitRole: 'codex-subagent-simple' },
      expected: /role codex-subagent-simple exactly once, got 0/,
    },
    {
      options: { duplicateRole: 'codex-subagent-general' },
      expected: /role codex-subagent-general exactly once, got 2/,
    },
  ];
  for (const entry of cases) {
    const subject = await mkdtemp(path.join(os.tmpdir(), 'subagent-invalid-subject-'));
    const previous = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
    try {
      await writeFinalSubject(subject, entry.options);
      process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = subject;
      await assert.rejects(createEvalWorkspace(), entry.expected);
    } finally {
      if (previous === undefined) delete process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
      else process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = previous;
      await rm(subject, { recursive: true, force: true });
    }
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
  await testGuideRoleValidation();
  await testMissingFinalArtifactFails();
  console.log('codex-subagent-guide trigger assets and specialized harness tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
