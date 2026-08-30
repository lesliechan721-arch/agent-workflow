import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evalRoot = path.dirname(fileURLToPath(import.meta.url));

async function writeFakeCodex(root, marker) {
  const executable = path.join(root, 'fake-codex.mjs');
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(marker)}, 'run\\n');`,
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `fake model output ${process.env.OPENAI_API_KEY ?? ''}` } }));",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
    '',
  ].join('\n'));
  await chmod(executable, 0o755);
  return executable;
}

async function writeWorkspace(root) {
  const skillRoot = path.join(root, '.agents', 'skills', 'codex-explore');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# Codex Explore\n');
  return skillRoot;
}

async function copySuiteAssets(sourceRoot, destinationRoot, suite) {
  const files = [suite.provider.entry, ...suite.provider.assets];
  for (const relative of files) {
    await cp(path.join(sourceRoot, relative), path.join(destinationRoot, relative), {
      recursive: true,
    });
  }
}

async function assertProviderOutput(output, suite, outputDir) {
  assert.deepEqual(Object.keys(output).sort(), [
    'artifacts',
    'grading',
    'provider',
    'schemaVersion',
    'usage',
  ]);
  assert.equal(output.schemaVersion, 1);
  assert.deepEqual(output.provider, { id: suite.provider.id, version: 'manifest-v1' });
  assert.equal(typeof output.grading?.grader?.id, 'string');
  assert.equal(output.grading?.grader?.version, '1');
  assert.equal(typeof output.grading?.result, 'object');
  for (const artifact of output.artifacts) {
    assert.equal(path.isAbsolute(artifact.path), false);
    assert.equal(artifact.path.includes('..'), false);
    assert.ok(['trace', 'report', 'output', 'other'].includes(artifact.role));
    assert.ok(path.resolve(outputDir, artifact.path).startsWith(`${path.resolve(outputDir)}${path.sep}`));
    assert.equal((await lstat(path.join(outputDir, artifact.path))).isFile(), true);
  }
}

test('copied Codex Explore provider entries run one case and return ProviderOutput v1', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-provider-contract-'));
  const previous = {
    bin: process.env.AW_SKILL_EVAL_CODEX_BIN,
    home: process.env.CODEX_HOME,
    context: process.env.AW_PLUGIN_CONTEXT,
    key: process.env.OPENAI_API_KEY,
  };
  try {
    const manifest = JSON.parse(await readFile(path.join(evalRoot, 'manifest.json'), 'utf8'));
    const isolated = path.join(root, 'eval-root');
    const workspace = path.join(root, 'workspace');
    const codexHome = path.join(root, 'codex-home');
    const marker = path.join(root, 'invocations.txt');
    const skillPath = await writeWorkspace(workspace);
    await Promise.all([mkdir(isolated, { recursive: true }), mkdir(codexHome)]);
    process.env.AW_SKILL_EVAL_CODEX_BIN = await writeFakeCodex(root, marker);
    process.env.CODEX_HOME = codexHome;
    process.env.AW_PLUGIN_CONTEXT = path.join(root, 'author-source-must-not-be-read.json');
    process.env.OPENAI_API_KEY = 'fake-provider-secret';

    for (const suiteId of ['model-selection', 'workflow', 'liveness']) {
      const suite = manifest.suites.find((entry) => entry.id === suiteId);
      assert.ok(suite);
      await copySuiteAssets(evalRoot, isolated, suite);
      const entry = await import(`${pathToFileURL(path.join(isolated, suite.provider.entry)).href}?${suiteId}`);
      assert.equal(typeof entry.runEvalProvider, 'function');
      const caseDocument = JSON.parse(await readFile(path.join(evalRoot, suite.cases), 'utf8'));
      const evalCase = (caseDocument.evals ?? caseDocument.cases ?? caseDocument)[0];
      const outputDir = path.join(root, `output-${suiteId}`);
      await mkdir(outputDir);
      const output = await entry.runEvalProvider({
        case: evalCase,
        caseId: evalCase.id,
        configuration: 'with-skill',
        skillMode: 'with-skill',
        skillPath,
        workspacePath: workspace,
        outputDir,
        runtimeInputs: Object.freeze({ 'eval-suite': path.dirname(isolated) }),
      });
      await assertProviderOutput(output, suite, outputDir);
      assert.equal(output.grading.result.caseId, evalCase.id);
      assert.ok(output.grading.result.assertions.some(({ name }) => name === 'execution'));
      assert.equal(JSON.stringify(output).includes('fake-provider-secret'), false);
      for (const artifact of output.artifacts) {
        assert.equal(
          (await readFile(path.join(outputDir, artifact.path), 'utf8'))
            .includes('fake-provider-secret'),
          false,
        );
      }
    }
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 3);
  } finally {
    if (previous.bin === undefined) delete process.env.AW_SKILL_EVAL_CODEX_BIN;
    else process.env.AW_SKILL_EVAL_CODEX_BIN = previous.bin;
    if (previous.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.home;
    if (previous.context === undefined) delete process.env.AW_PLUGIN_CONTEXT;
    else process.env.AW_PLUGIN_CONTEXT = previous.context;
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
    await rm(root, { recursive: true, force: true });
  }
});
