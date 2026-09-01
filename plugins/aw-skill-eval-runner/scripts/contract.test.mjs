import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = pluginContext?.sourceRoot ?? root;
const runtimeRoot = pluginContext?.platform ? path.join(root, pluginContext.platform) : root;
const runtimeSkillRoot = path.join(runtimeRoot, 'skills', 'run-aw-skill-evals');

async function readRuntime(relativePath) {
  return readFile(path.join(runtimeSkillRoot, relativePath), 'utf8');
}

async function exists(relativePath) {
  return access(path.join(runtimeSkillRoot, relativePath)).then(() => true, () => false);
}

async function materializeHandoffFiles(workspaceFiles) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eval-runner-handoff-contract-'));
  for (const [relative, contents] of Object.entries(workspaceFiles)) {
    const destination = path.join(temporary, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return temporary;
}

async function runEval(args, cwd) {
  const bin = path.resolve(sourceRoot, '../../packages/agent-skill-eval/dist/bin.js');
  return execFileAsync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

test('Runner declares the Auditor dependency and v2 runtime capability', async () => {
  const manifest = JSON.parse(await readFile(
    path.join(sourceRoot, '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(manifest.name, 'aw-skill-eval-runner');
  assert.deepEqual(manifest.dependencies, ['agent-skill-toolkit']);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.buildConfig, undefined);
  assert.deepEqual(manifest.requires.aw.capabilities, ['aw.skill-eval.v2']);
  for (const relativePath of ['schemas', 'providers', 'scripts']) {
    assert.equal(await exists(relativePath), false, relativePath);
  }
});

test('Runner exposes exactly five public workflow steps', async () => {
  const skill = await readRuntime('SKILL.md');
  const openai = await readRuntime('agents/openai.yaml');
  assert.match(openai, /^\s*allow_implicit_invocation: true$/mu);

  // Static contract exception: an installed Agent reads these five headings as the executable workflow; behavior test is not suitable because the contract is consumed as instructions rather than code.
  assert.deepEqual(
    [...skill.matchAll(/^## ([1-5])\. /gmu)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5],
  );
  for (const command of [
    'aw skill eval prepare <plugin> <skill> --suite <suite> --profile <profile> --output <new-spec-directory> --json',
    'aw-skill-eval spec validate <spec.json>',
    'aw-skill-eval audit validate <audit.json> --spec <spec.json>',
    'aw-skill-eval run <spec.json> --audit <audit.json>',
    'aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>',
  ]) {
    assert.ok(skill.includes(command), command);
  }
  assert.match(skill, /预计调用数 `<=10`/u);
  assert.match(skill, /预计调用数 `>10`/u);
  assert.match(skill, /`custom-process` 因调用数和外部影响未知/u);
  // Static contract exception: an installed Runner must disclose that custom-process is cooperative containment, not a sandbox; behavior test is not suitable because this safety boundary is direct Agent instruction.
  assert.match(skill, /可信、协作式 provider，不是任意外部程序 sandbox/u);
  assert.match(skill, /Engine 只在 macOS\/Linux 启动它/u);
  assert.match(skill, /违反或检查失效会 fail closed、丢弃 grade 并停止 batch/u);
  assert.match(skill, /Runner 只披露并调用 Engine，不重复该运行期检查/u);
  assert.match(skill, /clean success 直接结束，不要求 triage/u);
  assert.match(skill, /只有出现 execution\/grade 失败、current 结果混合、current 相对 baseline 回归/u);

  const diagnosticsStart = skill.indexOf('## 高级诊断');
  assert.ok(diagnosticsStart > 0, 'advanced diagnostics pointer');
  const publicWorkflow = skill.slice(skill.indexOf('## 1. '), diagnosticsStart);
  assert.doesNotMatch(publicWorkflow, /\bdoctor\b|capabilit(?:y|ies)|\bdescribe\b|\bsmoke\b/u);
  assert.match(publicWorkflow, /run 失败.*高级诊断/u);
  assert.ok(skill.indexOf('aw skill eval doctor --json') > diagnosticsStart);
  assert.match(skill.slice(diagnosticsStart), /安装或版本升级.*用户显式请求.*run 失败/u);

  // Static contract exception: obsolete commands can start unapproved model paths or bind stale contracts; behavior test is not suitable because absence from the installed instructions is the safety property.
  for (const forbidden of [
    /capabilities --json/u,
    /schema print/u,
    /provider describe/u,
    /provider smoke/u,
    /plan validate/u,
    /bundle validate/u,
    /EvalRunBundle/u,
    /EvalAuditResult/u,
    /Plan v4/u,
    /Bundle v4/u,
    /逐.*digest/u,
    /强制.*triage/u,
  ]) {
    assert.doesNotMatch(skill, forbidden);
  }
  assert.doesNotMatch(skill, /\bnpx\b/u);
});

test('Runner user-facing summaries agree on EvalSpec, EvalAudit, EvalResult, and conditional triage', async () => {
  const [skillReadme, pluginReadme, openai] = await Promise.all([
    readRuntime('README.md'),
    readFile(path.join(sourceRoot, 'README.md'), 'utf8'),
    readRuntime('agents/openai.yaml'),
  ]);
  // Static contract exception: conflicting installed summaries cause users to authorize the wrong workflow; behavior test is not suitable because these are direct user and Agent instructions.
  for (const text of [skillReadme, pluginReadme, openai]) {
    assert.match(text, /EvalSpec/u);
    assert.match(text, /EvalAudit|Audit/u);
    assert.match(text, /EvalResult/u);
    assert.match(text, /triage/u);
  }
});

test('trigger cases route direct selection and reject Audit-only requests', async () => {
  const cases = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/run-aw-skill-evals/evals/trigger-cases.json'),
    'utf8',
  )).cases;
  assert.equal(cases.find((entry) => entry.id === 'prepare_selection')?.input.expectedLoad, true);
  assert.equal(cases.find((entry) => entry.id === 'unaudited')?.input.expectedLoad, true);
  assert.equal(cases.find((entry) => entry.id === 'audit')?.input.expectedLoad, false);
});

test('nested Runner handoff fixtures reach their intended admission states', async () => {
  const cases = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/run-aw-skill-evals/evals/behavior-cases.json'),
    'utf8',
  )).cases;
  const unknownAudit = cases.find((entry) => entry.id === 'missing-audit-blocks-model-run');
  const audited = cases.find((entry) => entry.id === 'audited-run-validates-and-triages');
  assert.ok(unknownAudit);
  assert.ok(audited);

  for (const entry of [unknownAudit, audited]) {
    const temporary = await materializeHandoffFiles(entry.input.workspaceFiles);
    try {
      const specPath = path.join(temporary, 'spec.json');
      const auditPath = path.join(temporary, 'audit.json');
      assert.equal(JSON.parse((await runEval(['spec', 'validate', specPath], temporary)).stdout).valid, true);
      if (entry.id === unknownAudit.id) {
        await assert.rejects(
          runEval(['audit', 'validate', auditPath, '--spec', specPath], temporary),
          (error) => JSON.parse(error.stdout).errors.includes('Audit status is unknown; execution is blocked'),
        );
      } else {
        const resultPath = path.join(temporary, 'result.json');
        assert.equal(JSON.parse((await runEval([
          'audit', 'validate', auditPath, '--spec', specPath,
        ], temporary)).stdout).valid, true);
        assert.equal(JSON.parse((await runEval([
          'result', 'validate', resultPath, '--spec', specPath, '--audit', auditPath,
        ], temporary)).stdout).valid, true);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
