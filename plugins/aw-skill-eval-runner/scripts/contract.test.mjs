import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
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

async function runInjectedBin(bin, args) {
  return bin.endsWith('.js')
    ? execFileAsync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    : execFileAsync(bin, args, { encoding: 'utf8' });
}

test('Runner declares the Auditor dependency and no copied engine contract', async () => {
  const manifest = JSON.parse(await readFile(
    path.join(sourceRoot, '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(manifest.name, 'aw-skill-eval-runner');
  assert.deepEqual(manifest.dependencies, ['agent-skill-toolkit']);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.buildConfig, undefined);
  assert.deepEqual(manifest.requires.aw.capabilities, ['aw.skill-eval.v1']);
  for (const relativePath of [
    'assets/aw-skill-eval-execution-plan.template.json',
    'schemas',
    'providers',
    'scripts',
  ]) {
    assert.equal(await exists(relativePath), false, relativePath);
  }
});

test('Runner exposes prepare, Audit, authorization, execution, and triage boundaries', async () => {
  const skill = await readRuntime('SKILL.md');
  const openai = await readRuntime('agents/openai.yaml');
  assert.match(skill, /^user-invocable: true$/mu);
  assert.match(openai, /^\s*allow_implicit_invocation: true$/mu);
  for (const command of [
    'aw skill eval prepare <plugin> --skill <skill> --suite <suite> --profile <profile> --output <new-plan-directory> --json',
    'aw-skill-eval capabilities --json',
    'aw-skill-eval schema print aw-skill-eval-execution-plan',
    'aw-skill-eval schema print eval-run-bundle',
    'aw-skill-eval schema print eval-audit-result',
    'aw-skill-eval plan validate <plan.json>',
    'aw-skill-eval audit validate <audit.json>',
    'aw-skill-eval run <plan.json> --audit <audit.json>',
    'aw-skill-eval bundle validate <bundle.json>',
  ]) {
    assert.ok(skill.includes(command), command);
  }
  assert.match(skill, /无 passing preflight Audit 不得启动 provider/u);
  assert.match(skill, /只有全部 preflight Audit 通过后/u);
  assert.match(skill, /新的全新上下文/u);
  assert.doesNotMatch(skill, /\bnpx\b/u);
});

test('trigger cases route direct selection and reject unaudited execution', async () => {
  const cases = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/run-aw-skill-evals/evals/trigger-cases.json'),
    'utf8',
  )).cases;
  assert.equal(cases.find((entry) => entry.id === 'prepare_selection')?.should_load_skill, true);
  assert.equal(cases.find((entry) => entry.id === 'unaudited')?.should_load_skill, true);
  assert.equal(cases.find((entry) => entry.id === 'audit')?.should_load_skill, false);
});

test(
  'an injected canonical CLI reports capabilities v2 and Plan/Bundle v4',
  { skip: !process.env.AW_SKILL_EVAL_TEST_BIN },
  async () => {
    const bin = process.env.AW_SKILL_EVAL_TEST_BIN;
    const capabilities = JSON.parse(
      (await runInjectedBin(bin, ['capabilities', '--json'])).stdout,
    );
    assert.equal(capabilities.schemaVersion, 2);

    for (const [schemaName, version] of [
      ['aw-skill-eval-execution-plan', 4],
      ['eval-run-bundle', 4],
      ['eval-audit-result', 3],
    ]) {
      const schema = JSON.parse(
        (await runInjectedBin(bin, ['schema', 'print', schemaName])).stdout,
      );
      assert.equal(schema.properties.schemaVersion.const, version);
    }
  },
);
