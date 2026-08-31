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
const secrets = [
  'sk-provider-"contract\\secret',
  'https://user:provider-secret@proxy.invalid:8443',
];

async function copyPreparedFixtures(provider, targetRoot) {
  const sourceRoot = path.join(skillsRoot, provider.skill, 'evals');
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
  const suite = manifest.suites.find((entry) => entry.kind === 'custom-process');
  assert.ok(suite);
  const fixturesPath = path.join(targetRoot, 'workspace', 'eval');
  await cp(sourceRoot, fixturesPath, { recursive: true });
  await Promise.all([
    rm(path.join(fixturesPath, 'manifest.json')),
    ...manifest.suites.map((entry) => rm(path.join(fixturesPath, entry.cases))),
  ]);
  return { fixturesPath, sourceRoot, suite };
}

async function createWorkspace(root, skill) {
  const skillPath = path.join(root, '.agents', 'skills', skill);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: fixture\n---\n`,
  );
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
  assert.deepEqual(output.usage, { inputTokens: 7, outputTokens: 3 });
  assert.equal(output.grade.passed, true);
  assert.equal(output.grade.score, 1);
  assert.equal(typeof output.grade.details, 'object');
  for (const secret of secrets) assert.equal(stdout.includes(secret), false);
}

test('Git custom-process commands run one selected case without exposing secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-provider-contract-'));
  const invocationLog = path.join(root, 'invocations.log');
  const fakeCodex = path.join(root, 'fake-codex.mjs');
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    "import { appendFile } from 'node:fs/promises';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `await appendFile(${JSON.stringify(invocationLog)}, \`\${process.cwd()}\\n\`);`,
    "let message = '.worktrees 未被忽略，停止并需要确认。';",
    "if (fs.existsSync(path.join(process.cwd(), '.git', 'MERGE_HEAD'))) message = 'merge conflict 冲突阻塞，未创建提交。';",
    "if (path.basename(process.cwd()) === 'analysis-only-dirty-worktree') message = 'subtotal 返回整数分 cents，invoice 按 dollars/元处理；建议在 invoice 边界除以 100，并运行 unittest 测试。';",
    "message += \` api=\${process.env.OPENAI_API_KEY} proxy=\${process.env.HTTPS_PROXY}\`;",
    "process.stderr.write(\`stderr api=\${process.env.OPENAI_API_KEY} proxy=\${process.env.HTTPS_PROXY}\\n\`);",
    "process.stdout.write(\`\${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } })}\\n\`);",
    "process.stdout.write(\`\${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } })}\\n\`);",
  ].join('\n'));
  await chmod(fakeCodex, 0o755);
  const env = {
    ...process.env,
    AW_SKILL_EVAL_CODEX_BIN: fakeCodex,
    AW_PLUGIN_CONTEXT: path.join(root, 'author-source-must-not-be-read.json'),
    OPENAI_API_KEY: secrets[0],
    HTTPS_PROXY: secrets[1],
  };

  try {
    for (const [index, provider] of providers.entries()) {
      const suiteRoot = path.join(root, `suite-${index}`);
      const { fixturesPath, sourceRoot, suite } = await copyPreparedFixtures(provider, suiteRoot);
      const workspacePath = path.join(suiteRoot, 'workspace', 'subject');
      const outputDir = path.join(suiteRoot, 'output');
      await Promise.all([
        createWorkspace(workspacePath, provider.skill),
        mkdir(outputDir, { recursive: true }),
      ]);
      const document = JSON.parse(await readFile(path.join(sourceRoot, provider.caseFile), 'utf8'));
      const selectedCase = document.cases.find((entry) => entry.id === provider.caseId);
      assert.ok(selectedCase);

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
        const content = await readFile(file, 'utf8');
        for (const secret of secrets) assert.equal(content.includes(secret), false);
      }
      assert.equal((await readFile(invocationLog, 'utf8')).trim().split('\n').length, index + 1);
    }

    const provider = providers[0];
    const { fixturesPath, suite } = await copyPreparedFixtures(provider, path.join(root, 'invalid'));
    await assert.rejects(
      invoke(suite.provider.command, fixturesPath, { version: 1 }, env),
      (error) => {
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /must contain only/u);
        return true;
      },
    );
    assert.equal((await readFile(invocationLog, 'utf8')).trim().split('\n').length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
