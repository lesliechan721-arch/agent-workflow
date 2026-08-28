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
const runtimeSkillRoot = path.join(runtimeRoot, 'skills', 'run-aw-skill-evals');

async function readRuntime(relativePath) {
  return readFile(path.join(runtimeSkillRoot, relativePath), 'utf8');
}

async function runInjectedBin(bin, args) {
  return bin.endsWith('.js')
    ? execFileAsync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    : execFileAsync(bin, args, { encoding: 'utf8' });
}

test('plugin has no runtime dependency on the review toolkit', async () => {
  const manifest = JSON.parse(await readFile(
    path.join(sourceRoot, '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(manifest.name, 'aw-skill-eval-runner');
  assert.deepEqual(manifest.dependencies, []);
  assert.equal(manifest.schemaVersion, 2);
});

test('plugin supports implicit and explicit invocation while keeping only execution gates', async () => {
  const skill = await readRuntime('SKILL.md');
  const openai = await readRuntime('agents/openai.yaml');

  assert.doesNotMatch(skill, /^disable-model-invocation:/mu);
  assert.match(skill, /^user-invocable: true$/mu);
  assert.match(openai, /^\s*allow_implicit_invocation: true$/mu);
  assert.match(skill, /人工授权/u);
  assert.match(skill, /Capability preflight/u);
  assert.match(skill, /若用户只要求验证，返回验证结果并停止/u);
  assert.match(skill, /不得调用 `aw-skill-eval run <plan\.json>`/u);
  assert.doesNotMatch(skill, /^## .*Audit/mu);
  assert.doesNotMatch(skill, /audit-agent-skill-evals/u);

  const triggerCases = JSON.parse(
    await readFile(
      path.join(sourceRoot, 'skills', 'run-aw-skill-evals', 'evals', 'trigger-cases.json'),
      'utf8',
    ),
  );
  const positives = triggerCases.cases.filter((entry) => entry.should_load_skill);
  assert.ok(positives.some((entry) => !entry.query.includes('$run-aw-skill-evals')));
  assert.equal(
    triggerCases.cases.find((entry) => entry.id === 'unaudited')?.should_load_skill,
    true,
  );
});

test('Skill declares the stable shared CLI contract without a local execution fallback', async () => {
  const skill = await readRuntime('SKILL.md');
  const commands = [
    'aw-skill-eval capabilities --json',
    'aw-skill-eval schema print aw-skill-eval-execution-plan',
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
    assert.deepEqual(entries.filter((entry) => !entry.isDirectory()), []);
  }
  await access(path.join(runtimeSkillRoot, 'assets', 'aw-skill-eval-execution-plan.template.json'));
});

test('the retained plan asset is a model-readable template, not a machine schema', async () => {
  const template = JSON.parse(await readRuntime('assets/aw-skill-eval-execution-plan.template.json'));
  assert.equal(template.schemaVersion, 3);
  assert.equal(template.minimumEvidenceLevel, 'executed');
  assert.equal(typeof template.planId, 'string');
  assert.equal(typeof template.provider, 'object');
  assert.equal('audit' in template, false);
  assert.equal('$schema' in template, false);
});

test(
  'an injected shared CLI reports compatible capabilities and schemas',
  { skip: !process.env.AW_SKILL_EVAL_TEST_BIN },
  async () => {
    const bin = process.env.AW_SKILL_EVAL_TEST_BIN;
    const capabilities = JSON.parse(
      (await runInjectedBin(bin, ['capabilities', '--json'])).stdout,
    );
    assert.equal(capabilities.schemaVersion, 1);

    for (const schemaName of ['aw-skill-eval-execution-plan', 'eval-run-bundle']) {
      const schema = JSON.parse(
        (await runInjectedBin(bin, ['schema', 'print', schemaName])).stdout,
      );
      assert.equal(schema.properties.schemaVersion.const, 3);
    }
  },
);
