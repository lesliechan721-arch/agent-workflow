import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = pluginContext?.sourceRoot ?? root;
const runtimeRoot = pluginContext?.platform ? path.join(root, pluginContext.platform) : root;
const runtimeSkillRoot = path.join(runtimeRoot, 'skills', 'run-agent-skill-evals');

async function readRuntime(relativePath) {
  return readFile(path.join(runtimeSkillRoot, relativePath), 'utf8');
}

async function runInjectedBin(bin, args) {
  return bin.endsWith('.js')
    ? execFileAsync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    : execFileAsync(bin, args, { encoding: 'utf8' });
}

test('plugin is a manual-only orchestration Skill', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), 'utf8'),
  );
  const skill = await readRuntime('SKILL.md');
  const openai = await readRuntime('agents/openai.yaml');

  assert.match(skill, /^disable-model-invocation: true$/mu);
  assert.match(skill, /^user-invocable: true$/mu);
  assert.match(openai, /^\s*allow_implicit_invocation: false$/mu);

  const triggerCases = JSON.parse(
    await readFile(
      path.join(
        sourceRoot,
        'skills',
        'run-agent-skill-evals',
        'evals',
        'trigger-cases.json',
      ),
      'utf8',
    ),
  );
  for (const triggerCase of triggerCases.cases.filter((entry) => entry.should_load_skill)) {
    assert.match(triggerCase.query, /\$run-agent-skill-evals\b/u);
  }
});

test('orchestration preserves authorization, ordered preflight, and result triage', async () => {
  const skill = await readRuntime('SKILL.md');
  const orderedMarkers = [
    '## 1. 人工授权 gate',
    'aw-skill-eval capabilities --json',
    '## 3. EvalAuditResult 运行前审核',
    'aw-skill-eval digest skill <skill-dir>',
    'aw-skill-eval plan validate <plan.json>',
    'aw-skill-eval run <plan.json>',
    'aw-skill-eval bundle validate <bundle.json>',
    'audit-agent-skill-evals(result-triage)',
  ];

  let previous = -1;
  for (const marker of orderedMarkers) {
    const current = skill.indexOf(marker);
    assert.ok(current > previous, `${marker} must occur after the prior gate`);
    previous = current;
  }

  for (const authorization of ['模型成本', '外部进程', '凭据', '网络访问', '临时输出']) {
    assert.match(skill, new RegExp(authorization, 'u'));
  }
  assert.match(skill, /fresh-context `audit-agent-skill-evals\(result-triage\)`/u);
});

test('Skill declares the stable shared CLI contract without a local execution fallback', async () => {
  const skill = await readRuntime('SKILL.md');
  const commands = [
    'aw-skill-eval capabilities --json',
    'aw-skill-eval schema print eval-execution-plan',
    'aw-skill-eval schema print eval-audit-result',
    'aw-skill-eval schema print eval-run-bundle',
    'aw-skill-eval plan validate <plan.json>',
    'aw-skill-eval run <plan.json>',
    'aw-skill-eval bundle validate <bundle.json>',
    'aw-skill-eval digest skill <skill-dir>',
  ];

  for (const command of commands) {
    assert.ok(skill.includes(`\`${command}\``), `${command} must use the stable command name`);
  }
  assert.doesNotMatch(skill, /\bnpx\s+aw-skill-eval\b/u);
  assert.doesNotMatch(skill, /(?:node\s+)?scripts\//u);
  assert.doesNotMatch(skill, /providers\//u);
  assert.doesNotMatch(skill, /schemas\//u);

  for (const removedPath of ['scripts', 'providers', 'schemas']) {
    const entries = await readdir(path.join(runtimeSkillRoot, removedPath), {
      recursive: true,
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(
      entries.filter((entry) => !entry.isDirectory()),
      [],
    );
  }
  await access(path.join(runtimeSkillRoot, 'assets', 'eval-execution-plan.template.json'));
});

test('the retained plan asset is a model-readable template, not a machine schema', async () => {
  const template = JSON.parse(await readRuntime('assets/eval-execution-plan.template.json'));
  assert.equal(template.schemaVersion, 2);
  assert.equal(typeof template.planId, 'string');
  assert.equal(typeof template.provider, 'object');
  assert.equal('$schema' in template, false);
});

test(
  'an explicitly injected shared CLI reports the compatible capabilities and schemas',
  { skip: !process.env.AW_SKILL_EVAL_TEST_BIN },
  async () => {
    const bin = process.env.AW_SKILL_EVAL_TEST_BIN;
    const capabilities = JSON.parse(
      (await runInjectedBin(bin, ['capabilities', '--json'])).stdout,
    );
    assert.equal(capabilities.schemaVersion, 1);

    for (const schemaName of [
      'eval-execution-plan',
      'eval-audit-result',
      'eval-run-bundle',
    ]) {
      const schema = JSON.parse(
        (await runInjectedBin(bin, ['schema', 'print', schemaName])).stdout,
      );
      assert.equal(schema.properties.schemaVersion.const, 2);
    }
  },
);
