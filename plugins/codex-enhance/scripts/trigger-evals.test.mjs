import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCodexArgs,
  copyCodexRuntimeFiles,
  createEvalWorkspace,
  readEvalResource,
  resolveParentModelOverride,
  shouldStopEarly,
} from '../skills/codex-explore/evals/eval-harness.mjs';
import { setupTriggerWorkspace } from '../skills/codex-explore/evals/trigger-fixture.mjs';

async function testEvalCorpus() {
  const manifest = JSON.parse(await readEvalResource('manifest.json'));
  const triggerSuite = manifest.suites.find((entry) => entry.id === 'trigger');
  assert.deepEqual(triggerSuite?.strictNegativeSplits, ['validation', 'sanity']);

  const document = JSON.parse(await readEvalResource('trigger-cases.json'));
  const { cases } = document;
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, 'codex-explore');
  assert.equal(cases.length, 31);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 13);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(cases.filter((entry) => entry.split === 'sanity').length, 10);
  assert.equal(cases.filter((entry) => entry.should_load_skill).length, 22);
  assert.equal(cases.filter((entry) => !entry.should_load_skill).length, 9);
  assert.equal(cases.filter((entry) => entry.should_spawn_agent).length, 19);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);

  const expectedContracts = new Map([
    ['cross_module_fact', [true, true]],
    ['explicit_known_file', [true, false]],
    ['skill_design_review', [false, false]],
    ['large_pr_review', [true, true]],
    ['readonly_deep_code_review', [true, true]],
    ['pr_defect_validation', [true, true]],
    ['plain_name_small_request', [true, false]],
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

function testPositiveEarlyStopRequiresRawSpawnArguments() {
  const evalCase = {
    should_load_skill: true,
    should_spawn_agent: true,
  };
  const observed = {
    loaded: true,
    spawned: true,
    spawnCalls: [],
  };
  assert.equal(shouldStopEarly(evalCase, observed), null);
  observed.spawnCalls.push({ arguments: { agent_type: 'codex-explore-standard' } });
  assert.equal(shouldStopEarly(evalCase, observed), 'expected_outcome_observed');
}

async function testFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-fixture-'));
  try {
    await setupTriggerWorkspace({ workspaceRoot: root });
    assert.match(
      await readFile(path.join(root, 'repo', 'shared', 'config.ts'), 'utf8'),
      /regional_checkout/,
    );
    assert.match(
      await readFile(path.join(root, 'docs', 'vendor', 'api-v2.md'), 'utf8'),
      /45s/,
    );
    assert.match(
      await readFile(path.join(root, 'reports', 'audit', 'day-03.log'), 'utf8'),
      /worker/,
    );
    assert.match(
      await readFile(
        path.join(root, 'repo', 'modules', 'module-16', 'handler-160.ts'),
        'utf8',
      ),
      /unrelated_feature_160/,
    );
    assert.match(
      await readFile(path.join(root, 'reports', 'audit', 'archive-072.log'), 'utf8'),
      /decoy-072/,
    );
    assert.match(
      await readFile(path.join(root, 'materials', 'interview-18.md'), 'utf8'),
      /outcome is unknown/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSpecializedWorkspaceRequiresFinalArtifact() {
  const previous = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  delete process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  try {
    await assert.rejects(createEvalWorkspace(), /AW_PLUGIN_EVAL_PROJECT_ROOT is required/);
  } finally {
    if (previous === undefined) delete process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
    else process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = previous;
  }
}

async function testSpecializedWorkspaceCopiesFinalArtifact() {
  const subject = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-subject-'));
  const skillPath = path.join(subject, '.agents', 'skills', 'codex-explore', 'SKILL.md');
  const previous = process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
  try {
    await mkdir(path.dirname(skillPath), { recursive: true });
    await mkdir(path.join(subject, '.codex'), { recursive: true });
    await writeFile(skillPath, '# Materialized Explore\n', 'utf8');
    await writeFile(path.join(subject, '.codex', 'config.toml'), '# final config\n', 'utf8');
    process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = subject;
    const workspace = await createEvalWorkspace();
    try {
      assert.equal(await readFile(workspace.skillPath, 'utf8'), '# Materialized Explore\n');
      assert.equal(
        await readFile(path.join(workspace.root, '.codex', 'config.toml'), 'utf8'),
        '# final config\n',
      );
      assert.match(
        await readFile(path.join(workspace.root, 'known', 'constants.ts'), 'utf8'),
        /RETRY_LIMIT/,
      );
      const args = buildCodexArgs(
        workspace,
        { query: '$codex-explore inspect', codex_config: {} },
        {
          model: 'gpt-test',
          modelProvider: 'fixture-provider',
          sensitiveEnvironmentNames: ['CUSTOM_TOKEN'],
        },
      );
      assert.ok(args.includes('--enable'));
      assert.ok(args.includes('multi_agent'));
      assert.ok(args.includes('executed_tool_call_metadata'));
      assert.ok(args.includes('suppress_unstable_features_warning=true'));
      assert.ok(args.includes('gpt-test'));
      assert.ok(args.includes('model_provider="fixture-provider"'));
      assert.ok(args.includes('shell_environment_policy.exclude=["CODEX_HOME","CUSTOM_TOKEN"]'));
      assert.equal(args.includes('--ignore-user-config'), false);
      assert.equal(args.some((arg) => arg.startsWith('agents.codex-explore-')), false);
      const v1Args = buildCodexArgs(
        workspace,
        {
          query: '$codex-explore inspect with V1',
          parent_model: 'gpt-5.5',
          codex_config: { 'features.multi_agent_v2.enabled': false },
        },
        { model: 'gpt-5.6-sol' },
      );
      assert.equal(v1Args[v1Args.indexOf('--model') + 1], 'gpt-5.5');
      assert.equal(v1Args.includes('gpt-5.6-sol'), false);
      assert.equal(
        resolveParentModelOverride(
          { parent_model: 'gpt-5.5' },
          { model: 'gpt-5.6-sol' },
        ),
        'gpt-5.5',
      );
      assert.equal(
        resolveParentModelOverride({}, { model: 'gpt-5.6-sol' }),
        'gpt-5.6-sol',
      );
      assert.equal(resolveParentModelOverride({}, {}), null);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.AW_PLUGIN_EVAL_PROJECT_ROOT;
    else process.env.AW_PLUGIN_EVAL_PROJECT_ROOT = previous;
    await rm(subject, { recursive: true, force: true });
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
    await writeFile(path.join(sourceHome, 'config.toml'), 'model_provider = "fixture"\n', 'utf8');
    const trustedProject = path.join(root, 'trusted-project');
    await mkdir(trustedProject, { recursive: true });
    await copyCodexRuntimeFiles(targetHome, sourceHome, { trustedProject });
    const target = path.join(targetHome, 'auth.json');
    assert.equal((await lstat(target)).isSymbolicLink(), false);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(await readFile(target, 'utf8'), '{"token":"test"}\n');
    assert.equal(
      await readFile(path.join(targetHome, 'config.toml'), 'utf8'),
      [
        'model_provider = "fixture"',
        '',
        `[projects.${JSON.stringify(await realpath(trustedProject))}]`,
        'trust_level = "trusted"',
        '',
      ].join('\n'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  await testEvalCorpus();
  testPositiveEarlyStopRequiresRawSpawnArguments();
  await testFixture();
  await testSpecializedWorkspaceRequiresFinalArtifact();
  await testSpecializedWorkspaceCopiesFinalArtifact();
  await testCredentialIsolation();
  console.log('codex-explore trigger assets and specialized harness tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
