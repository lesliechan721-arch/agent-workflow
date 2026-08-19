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
  assert.equal(cases.length > 0, true);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.equal(cases.every((entry) => (
    typeof entry.query === 'string' &&
    typeof entry.should_load_skill === 'boolean' &&
    typeof entry.should_spawn_agent === 'boolean'
  )), true);

  const largePrReview = cases.find((entry) => entry.id === 'large_pr_review');
  assert.ok(largePrReview, 'missing large_pr_review case');
  assert.match(largePrReview.query, /只作为入口/);
  assert.match(largePrReview.query, /定义、全部调用点和数据流/);
  assert.match(largePrReview.oracle?.rationale ?? '', /diff 只是入口/);
  assert.match(largePrReview.oracle?.minimal_counterexample ?? '', /已知短 diff/);
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
    const fixturePaths = [
      ['repo', 'shared', 'config.ts'],
      ['repo', 'storage', 'store.ts'],
      ['repo', 'orders', 'cancel.ts'],
      ['repo', 'cleanup', 'expired.ts'],
      ['docs', 'vendor', 'api-v2.md'],
      ['reports', 'audit', 'day-03.log'],
      ['repo', 'modules', 'module-16', 'handler-160.ts'],
      ['reports', 'audit', 'archive-072.log'],
      ['materials', 'interview-18.md'],
    ];
    for (const segments of fixturePaths) {
      assert.equal((await readFile(path.join(root, ...segments), 'utf8')).length > 0, true);
    }
    assert.match(
      await readFile(path.join(root, 'changes', 'large-pr.diff'), 'utf8'),
      /repo\/storage\/store\.ts/,
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
