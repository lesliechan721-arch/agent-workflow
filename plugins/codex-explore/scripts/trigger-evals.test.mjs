import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
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
  readEvalResource,
} from '../evals/eval-harness.mjs';
import { setupTriggerWorkspace } from '../evals/trigger-fixture.mjs';

async function testEvalCorpus() {
  const document = JSON.parse(await readEvalResource('trigger-cases.json'));
  const { cases } = document;
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, 'codex-explore');
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
    ['readonly_deep_code_review', [false, false]],
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
        { model: 'gpt-test' },
      );
      assert.ok(args.includes('--enable'));
      assert.ok(args.includes('multi_agent'));
      assert.ok(args.includes('gpt-test'));
      assert.equal(args.some((arg) => arg.startsWith('agents.codex-explore-')), false);
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
