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
  createEvalWorkspace,
} from '../skills/codex-explore/evals/eval-harness.mjs';
import { setupTriggerWorkspace } from '../skills/codex-explore/evals/trigger-fixture.mjs';
import manifestDocument from '../skills/codex-explore/evals/manifest.json' with { type: 'json' };
import triggerCorpusDocument from '../skills/codex-explore/evals/trigger-cases.json' with { type: 'json' };

async function testEvalCorpus() {
  const manifest = manifestDocument;
  const triggerSuite = manifest.suites.find((entry) => entry.id === 'trigger');
  assert.equal(manifest.version, 1);

  const document = triggerCorpusDocument;
  const { cases } = document;
  assert.equal(document.version, 1);
  assert.equal(document.suite.kind, 'trigger');
  assert.equal(document.suite.unitUnderTest, 'codex-explore');
  assert.deepEqual(document.suite.runtime.strictNegativeSplits, ['validation', 'sanity']);
  assert.equal(triggerSuite?.kind, 'trigger');
  assert.equal(triggerSuite?.cases, 'trigger-cases.json');
  assert.equal(cases.length > 0, true);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.equal(cases.every((entry) => (
    typeof entry.input?.query === 'string' &&
    typeof entry.input.expectedLoad === 'boolean' &&
    typeof entry.input.shouldSpawnAgent === 'boolean'
  )), true);

  const largePrReview = cases.find((entry) => entry.id === 'large_pr_review');
  assert.ok(largePrReview, 'missing large_pr_review case');
  assert.match(largePrReview.input.query, /只作为入口/);
  assert.match(largePrReview.input.query, /定义、全部调用点和数据流/);
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

async function testCustomProviderWorkspaceUsesRuntimeSnapshot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-provider-workspace-'));
  const authorSource = path.join(root, 'author-source');
  const runtimeSnapshot = path.join(root, 'runtime-snapshot');
  const contextPath = path.join(root, 'author-context.json');
  const previousContext = process.env.AW_PLUGIN_CONTEXT;
  try {
    await Promise.all([
      mkdir(path.join(authorSource, '.agents', 'skills', 'codex-explore'), { recursive: true }),
      mkdir(path.join(runtimeSnapshot, '.agents', 'skills', 'codex-explore'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(authorSource, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
        '# Author source\n',
        'utf8',
      ),
      writeFile(
        path.join(runtimeSnapshot, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
        '# Runtime snapshot\n',
        'utf8',
      ),
      writeFile(path.join(authorSource, 'origin.txt'), 'author source\n', 'utf8'),
      writeFile(path.join(runtimeSnapshot, 'origin.txt'), 'runtime snapshot\n', 'utf8'),
      writeFile(contextPath, `${JSON.stringify({ sourceRoot: authorSource })}\n`, 'utf8'),
    ]);
    process.env.AW_PLUGIN_CONTEXT = contextPath;

    const customProviderInput = Object.freeze({ workspacePath: runtimeSnapshot });
    const workspace = await createEvalWorkspace({
      sourceRoot: customProviderInput.workspacePath,
    });
    try {
      assert.equal(await readFile(workspace.skillPath, 'utf8'), '# Runtime snapshot\n');
      assert.equal(
        await readFile(path.join(workspace.root, 'origin.txt'), 'utf8'),
        'runtime snapshot\n',
      );
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }

    await assert.rejects(
      createEvalWorkspace(),
      /custom provider input\.workspacePath is required/,
    );
  } finally {
    if (previousContext === undefined) delete process.env.AW_PLUGIN_CONTEXT;
    else process.env.AW_PLUGIN_CONTEXT = previousContext;
    await rm(root, { recursive: true, force: true });
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
  await testFixture();
  await testCustomProviderWorkspaceUsesRuntimeSnapshot();
  console.log('codex-explore trigger assets and provider workspace tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
