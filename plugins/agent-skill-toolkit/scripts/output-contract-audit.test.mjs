import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { SCAN_LIMITS } from './audit-output-contracts.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./audit-output-contracts.mjs', import.meta.url));

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), 'output-contract-audit-'));
}

async function put(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function run(root, ...args) {
  try {
    const result = await execFileAsync(process.execPath, [scriptPath, root, ...args]);
    return { code: 0, report: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr };
  }
}

function contract(report, contractPath) {
  const result = report.contracts.find((entry) => entry.path === contractPath);
  assert.ok(result, `缺少合同 ${contractPath}`);
  return result;
}

test('producer、schema 和 self-validator 只证明 validation-only', async () => {
  const root = await fixture();
  try {
    await put(root, 'contracts/result.schema.json', '{"type":"object"}\n');
    await put(root, 'scripts/create-result.mjs', "await writeFile('./result.json', JSON.stringify({ok:true}));\n");
    await put(root, 'scripts/validate-result.mjs', "const schema = JSON.parse(await readFile('../contracts/result.schema.json', 'utf8'));\nvalidate(schema);\n");
    const result = await run(root);
    assert.equal(result.code, 1);
    const item = contract(result.report, 'contracts/result.schema.json');
    assert.equal(item.assessment, 'validation-only');
    assert.equal(item.consumerEvidence.length, 0);
    assert.ok(item.validationOnlyEvidence.some((entry) => entry.relation === 'format-validation'));
    const validator = contract(result.report, 'scripts/validate-result.mjs');
    assert.equal(validator.assessment, 'not-found-in-scope');
    assert.equal(validator.consumerEvidence.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime projection 只证明复制关系，不升级 self-validator 合同', async () => {
  const root = await fixture();
  try {
    await put(root, 'contracts/result.schema.json', '{"type":"object"}\n');
    await put(root, 'scripts/validate-result.mjs', "const schema = JSON.parse(await readFile('../contracts/result.schema.json', 'utf8'));\nvalidate(schema);\n");
    await put(root, '.agents-plugin/plugin.json', JSON.stringify({
      note: 'install and execute the projected helper',
      buildConfig: {
        skillRuntimeFiles: [{
          skill: 'review',
          target: 'references/result.schema.json',
          source: './contracts/result.schema.json',
        }],
      },
    }, null, 2));
    const result = await run(root);
    const item = contract(result.report, 'contracts/result.schema.json');
    assert.equal(item.assessment, 'validation-only');
    assert.ok(item.consumerEvidence.some((entry) => entry.relation === 'unproven-runtime-import'));
    assert.ok(item.unknowns.some((entry) => entry.includes('无法静态证明')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同名 schema 和范围外路径不建立错误业务连边', async () => {
  const root = await fixture();
  try {
    await put(root, 'a/result.schema.json', '{"title":"a"}\n');
    await put(root, 'b/result.schema.json', '{"title":"b"}\n');
    await put(root, 'consumer/run.mjs', "const data = JSON.parse(await readFile('../../external/result.schema.json', 'utf8')); execute(data);\n");
    const result = await run(root);
    for (const contractPath of ['a/result.schema.json', 'b/result.schema.json']) {
      const item = contract(result.report, contractPath);
      assert.equal(item.assessment, 'not-found-in-scope');
      assert.equal(item.consumerEvidence.length, 0);
      assert.ok(item.unknowns.some((entry) => entry.includes('无法解析')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run gate 的结构化读取和执行用途是业务 consumer', async () => {
  const root = await fixture();
  try {
    await put(root, 'contracts/eval-audit.template.json', '{"permission":"allow"}\n');
    await put(root, 'scripts/run-gate.mjs', [
      "const audit = JSON.parse(await readFile('../contracts/eval-audit.template.json', 'utf8'));",
      "if (audit.permission === 'allow') await execFile('runner', []);",
    ].join('\n'));
    const result = await run(root);
    const item = contract(result.report, 'contracts/eval-audit.template.json');
    assert.equal(item.assessment, 'consumer-found');
    assert.ok(item.consumerEvidence.some((entry) => entry.relation === 'business-consumer'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('只出现文件名不建立 consumer 证据', async () => {
  const root = await fixture();
  try {
    await put(root, 'contracts/review.schema.json', '{"type":"object"}\n');
    await put(root, 'notes.txt', 'review.schema.json\n');
    const result = await run(root);
    const item = contract(result.report, 'contracts/review.schema.json');
    assert.equal(item.assessment, 'not-found-in-scope');
    assert.equal(item.consumerEvidence.length, 0);
    assert.equal(item.validationOnlyEvidence.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('用户请求的 JSON 输出形成 consumer 证据', async () => {
  const root = await fixture();
  try {
    await put(root, 'contracts/export.template.json', '{}\n');
    await put(root, 'scripts/export.mjs', [
      "const requestedOutput = process.argv.includes('--output');",
      "if (requestedOutput) await writeFile('../contracts/export.template.json', JSON.stringify(result));",
    ].join('\n'));
    const result = await run(root);
    const item = contract(result.report, 'contracts/export.template.json');
    assert.equal(item.assessment, 'consumer-found');
    assert.ok(item.consumerEvidence.some((entry) => entry.relation === 'user-requested-output'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('人读 Markdown 模板保持 human-format', async () => {
  const root = await fixture();
  try {
    await put(root, 'assets/review-template.md', '# Review\n\nExample for readers.\n');
    const result = await run(root);
    assert.equal(contract(result.report, 'assets/review-template.md').assessment, 'human-format');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('超过固定读取上限时报告 incomplete-scan', async () => {
  const root = await fixture();
  try {
    await put(root, 'contracts/result.schema.json', '{}\n');
    await put(root, 'large.md', 'x'.repeat(SCAN_LIMITS.maxFileBytes + 1));
    const result = await run(root);
    assert.equal(result.code, 1);
    assert.equal(result.report.scanComplete, false);
    assert.ok(result.report.scope.incompleteReasons.includes('file-size-limit'));
    assert.ok(result.report.warnings.some((entry) => entry.code === 'file-size-limit'));
    assert.equal(contract(result.report, 'contracts/result.schema.json').assessment, 'incomplete-scan');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('范围外 consumer 保持 unknown，不自动判定 orphan', async () => {
  const parent = await fixture();
  const root = path.join(parent, 'scope');
  try {
    await mkdir(root);
    await put(root, 'contract.schema.json', '{}\n');
    await put(parent, 'outside/run.mjs', "const value = JSON.parse(await readFile('../scope/contract.schema.json', 'utf8')); execute(value);\n");
    const result = await run(root);
    const item = contract(result.report, 'contract.schema.json');
    assert.equal(item.assessment, 'not-found-in-scope');
    assert.ok(item.unknowns.some((entry) => entry.includes('范围之外')));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('真实 materialized 同字节副本单独计数', async () => {
  const parent = await fixture();
  const source = path.join(parent, 'source');
  const materialized = path.join(parent, 'materialized');
  try {
    await put(source, 'contracts/result.schema.json', '{"type":"object"}\n');
    await put(materialized, 'skills/review/references/result.schema.json', '{"type":"object"}\n');
    const result = await run(source, '--materialized-root', materialized);
    const item = contract(result.report, 'contracts/result.schema.json');
    assert.deepEqual(item.copies, { source: 1, materialized: 1, uniqueContentHashes: 1 });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
