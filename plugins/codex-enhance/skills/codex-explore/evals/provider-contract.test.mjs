import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const secret = 'fake-provider-secret';

async function writeFakeCodex(root, marker) {
  const executable = path.join(root, 'fake-codex.mjs');
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(marker)}, 'run\\n');`,
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: \`fake model output \${process.env.OPENAI_API_KEY ?? ''}\` } }));",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
    '',
  ].join('\n'));
  await chmod(executable, 0o755);
  return executable;
}

async function writeWorkspace(root) {
  const skillRoot = path.join(root, '.agents', 'skills', 'codex-explore');
  const agentsRoot = path.join(root, '.codex', 'agents');
  await Promise.all([
    mkdir(skillRoot, { recursive: true }),
    mkdir(agentsRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(skillRoot, 'SKILL.md'), '# Codex Explore\n'),
    ...[
      'codex-explore-custom',
      'codex-explore-deep',
      'codex-explore-quick',
      'codex-explore-standard',
    ].map((name) => writeFile(
      path.join(agentsRoot, `${name}.toml`),
      `name = ${JSON.stringify(name)}\ndeveloper_instructions = "Inspect evidence."\n`,
    )),
  ]);
}

async function copyPreparedFixtures(source, destination, manifest) {
  await cp(source, destination, { recursive: true });
  await Promise.all([
    rm(path.join(destination, 'manifest.json')),
    ...manifest.suites.map((suite) => rm(path.join(destination, suite.cases))),
  ]);
}

async function outputFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await outputFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

async function invoke(command, cwd, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [
      path.join(cwd, command[1]),
      ...command.slice(2),
    ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`provider exited with ${code}`), { stdout, stderr }));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function assertOutput(stdout) {
  const output = JSON.parse(stdout);
  assert.deepEqual(Object.keys(output).sort(), ['grade', 'usage', 'version']);
  assert.equal(output.version, 1);
  assert.deepEqual(output.usage, { inputTokens: 1, outputTokens: 1 });
  assert.equal(typeof output.grade.passed, 'boolean');
  assert.ok([0, 1].includes(output.grade.score));
  assert.equal(typeof output.grade.details, 'object');
  assert.equal(stdout.includes(secret), false);
}

test('Codex Explore custom-process commands run only the selected case', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-provider-contract-'));
  try {
    const manifest = JSON.parse(await readFile(path.join(evalRoot, 'manifest.json'), 'utf8'));
    const fixturesPath = path.join(root, 'workspace', 'eval');
    const workspacePath = path.join(root, 'workspace', 'subject');
    const marker = path.join(root, 'invocations.txt');
    await Promise.all([
      copyPreparedFixtures(evalRoot, fixturesPath, manifest),
      writeWorkspace(workspacePath),
    ]);
    const env = {
      ...process.env,
      AW_SKILL_EVAL_CODEX_BIN: await writeFakeCodex(root, marker),
      AW_PLUGIN_CONTEXT: path.join(root, 'author-source-must-not-be-read.json'),
      OPENAI_API_KEY: secret,
    };

    const providerSuites = manifest.suites.filter((suite) => suite.kind === 'custom-process');
    assert.deepEqual(
      providerSuites.map((suite) => suite.id),
      ['model-selection', 'workflow', 'output-contract', 'liveness'],
    );
    for (const [index, suite] of providerSuites.entries()) {
      const document = JSON.parse(await readFile(path.join(evalRoot, suite.cases), 'utf8'));
      const selectedCase = document.cases[0];
      const outputDir = path.join(root, `output-${index}`);
      await mkdir(outputDir);
      const { stdout, stderr } = await invoke(suite.provider.command, fixturesPath, {
        version: 1,
        case: selectedCase,
        variant: 'current',
        attempt: 1,
        workspacePath,
        fixturesPath,
        outputDir,
      }, env);
      assert.equal(stderr, '');
      assertOutput(stdout);
      const artifacts = await outputFiles(outputDir);
      assert.ok(artifacts.length > 0);
      for (const file of artifacts) {
        assert.equal((await readFile(file, 'utf8')).includes(secret), false);
      }
      assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, index + 1);
    }

    const suite = providerSuites[0];
    await assert.rejects(
      invoke(suite.provider.command, fixturesPath, {}, env),
      (error) => {
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /must contain only/u);
        return true;
      },
    );
    assert.equal(
      (await readFile(marker, 'utf8')).trim().split('\n').length,
      providerSuites.length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
