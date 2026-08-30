import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const commitEvalRoot = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.resolve(commitEvalRoot, '..', '..');

const providers = [{
  skill: 'git-commit',
  caseFile: 'behavior-cases.json',
  caseId: 'conflict_or_operation_in_progress',
}, {
  skill: 'isolating-work-with-git-worktrees',
  caseFile: 'evals.json',
  caseId: 'stop_when_default_root_not_ignored',
}, {
  skill: 'reconciling-git-merges',
  caseFile: 'evals.json',
  caseId: 'analysis_only_dirty_worktree',
}];

async function copyProvider(provider, targetRoot) {
  const sourceRoot = path.join(skillsRoot, provider.skill, 'evals');
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
  const suite = manifest.suites.find((entry) => entry.kind === 'provider');
  assert.ok(suite);
  const evalRoot = path.join(targetRoot, 'eval-root');
  await mkdir(evalRoot, { recursive: true });
  for (const relative of [suite.provider.entry, ...(suite.provider.assets ?? [])]) {
    await cp(
      path.join(sourceRoot, relative),
      path.join(evalRoot, relative),
      { recursive: true },
    );
  }
  await writeFile(path.join(targetRoot, 'suite.json'), `${JSON.stringify({
    kind: 'provider',
    provider: suite.provider,
  }, null, 2)}\n`, 'utf8');
  return {
    entry: path.join(evalRoot, suite.provider.entry),
    id: suite.provider.id,
    sourceRoot,
  };
}

async function createWorkspace(root, skill) {
  const skillPath = path.join(root, '.agents', 'skills', skill);
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${skill}\ndescription: fixture\n---\n`, 'utf8');
  return skillPath;
}

function assertRedacted(content, secrets, label) {
  for (const secret of secrets) {
    assert.equal(content.includes(secret), false, `${label} exposed a credential value`);
  }
  assert.equal(content.includes('[REDACTED]'), true, `${label} did not retain redaction evidence`);
}

function assertProviderOutput(output, id, caseId, secrets) {
  assert.deepEqual(Object.keys(output).sort(), [
    'artifacts',
    'grading',
    'provider',
    'schemaVersion',
    'usage',
  ]);
  assert.equal(output.schemaVersion, 1);
  assert.deepEqual(output.provider, { id, version: 'manifest-v1' });
  assert.equal(output.usage.input_tokens, 7);
  assert.equal(output.grading.grader.id.endsWith('-mechanical'), true);
  assert.equal(output.grading.grader.version, '1');
  assert.equal(output.grading.result.caseId, caseId);
  assert.equal(output.grading.result.passed, true, `${caseId} mechanical grading failed`);
  assert.equal(output.grading.result.complete, true);
  assert.deepEqual(
    output.artifacts.map((entry) => entry.role).sort(),
    ['output', 'report', 'trace'],
  );
  for (const artifact of output.artifacts) {
    assert.equal(path.isAbsolute(artifact.path), false);
    assert.equal(artifact.path.includes('..'), false);
  }
  assertRedacted(JSON.stringify(output), secrets, `${caseId} ProviderOutput`);
}

test('custom Git providers load from independent eval roots and run one case once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-provider-contract-'));
  const invocationLog = path.join(root, 'invocations.log');
  const fakeCodex = path.join(root, 'fake-codex.mjs');
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    "import { appendFile } from 'node:fs/promises';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "await appendFile(process.env.FAKE_CODEX_LOG, `${process.cwd()}\\n`);",
    "let message = '.worktrees 未被忽略，停止并需要确认。';",
    "if (fs.existsSync(path.join(process.cwd(), '.git', 'MERGE_HEAD'))) message = 'merge conflict 冲突阻塞，未创建提交。';",
    "if (path.basename(process.cwd()) === 'analysis-only-dirty-worktree') message = 'subtotal 返回整数分 cents，invoice 按 dollars/元处理；建议在 invoice 边界除以 100，并运行 unittest 测试。';",
    "message += ` api=${process.env.OPENAI_API_KEY} proxy=${process.env.HTTPS_PROXY}`;",
    "process.stderr.write(`stderr api=${process.env.OPENAI_API_KEY} proxy=${process.env.HTTPS_PROXY}\\n`);",
    "process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } })}\\n`);",
    "process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } })}\\n`);",
  ].join('\n'), 'utf8');
  await chmod(fakeCodex, 0o755);

  const originalBin = process.env.AW_SKILL_EVAL_CODEX_BIN;
  const originalLog = process.env.FAKE_CODEX_LOG;
  const originalContext = process.env.AW_PLUGIN_CONTEXT;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const secrets = [
    'sk-provider-"contract\\secret',
    'https://user:provider-secret@proxy.invalid:8443',
  ];
  process.env.AW_SKILL_EVAL_CODEX_BIN = fakeCodex;
  process.env.FAKE_CODEX_LOG = invocationLog;
  process.env.AW_PLUGIN_CONTEXT = path.join(root, 'author-source-must-not-be-read.json');
  process.env.OPENAI_API_KEY = secrets[0];
  process.env.HTTPS_PROXY = secrets[1];
  try {
    for (const [index, provider] of providers.entries()) {
      const suiteRoot = path.join(root, `suite-${index}`);
      const copied = await copyProvider(provider, suiteRoot);
      const workspacePath = path.join(root, `workspace-${index}`);
      const skillPath = await createWorkspace(workspacePath, provider.skill);
      const outputDir = path.join(root, `output-${index}`);
      await mkdir(outputDir);
      const document = JSON.parse(await readFile(path.join(copied.sourceRoot, provider.caseFile), 'utf8'));
      const evalCase = document.evals.find((entry) => entry.id === provider.caseId);
      assert.ok(evalCase);

      const loaded = await import(`${pathToFileURL(copied.entry).href}?case=${index}`);
      assert.equal(typeof loaded.runEvalProvider, 'function');
      const output = await loaded.runEvalProvider({
        case: evalCase,
        caseId: provider.caseId,
        configuration: 'with-skill',
        skillMode: 'with-skill',
        skillPath,
        workspacePath,
        outputDir,
        runtimeInputs: Object.freeze({
          'aw-subject-base': workspacePath,
          'eval-suite': suiteRoot,
        }),
      });
      assertProviderOutput(output, copied.id, provider.caseId, secrets);
      for (const artifact of output.artifacts) {
        const content = await readFile(path.join(outputDir, artifact.path), 'utf8');
        assert.ok(content.length > 0);
        assertRedacted(content, secrets, `${provider.caseId}/${artifact.path}`);
      }
      const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n');
      assert.equal(invocations.length, index + 1);
    }
  } finally {
    if (originalBin === undefined) delete process.env.AW_SKILL_EVAL_CODEX_BIN;
    else process.env.AW_SKILL_EVAL_CODEX_BIN = originalBin;
    if (originalLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = originalLog;
    if (originalContext === undefined) delete process.env.AW_PLUGIN_CONTEXT;
    else process.env.AW_PLUGIN_CONTEXT = originalContext;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
    await rm(root, { recursive: true, force: true });
  }
});
