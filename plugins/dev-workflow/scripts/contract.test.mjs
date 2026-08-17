import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const skillNames = [
  'dev-workflow',
  'dev-prototype',
  'dev-spec',
  'dev-review-spec',
  'dev-implement',
  'dev-review-code',
];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) {
    return { sourceRoot: localPluginRoot, bundleRoot: localPluginRoot, platform: null };
  }
  const context = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'dev-workflow');
  assert.ok(['codex', 'claude'].includes(context.platform));
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

function yamlQuotedValue(yaml, key) {
  const match = yaml.match(new RegExp(`^\\s*${key}:\\s*"([^"]*)"$`, 'm'));
  assert.ok(match, `missing ${key}`);
  return match[1];
}

function assertSkillFrontmatter(skill, skillName) {
  assert.match(skill, new RegExp(`^name: ${skillName}$`, 'm'));
  assert.match(skill, /^description: .+时使用/m);
  assert.equal(skill.includes('[TODO:'), false);
}

function assertOpenAiMetadata(yaml, skillName) {
  const displayName = yamlQuotedValue(yaml, 'display_name');
  const shortDescription = yamlQuotedValue(yaml, 'short_description');
  const defaultPrompt = yamlQuotedValue(yaml, 'default_prompt');
  const length = Array.from(shortDescription).length;
  assert.match(displayName, /^[\x20-\x7E]+$/);
  assert.equal(length >= 25, true);
  assert.equal(length <= 64, true);
  assert.match(defaultPrompt, new RegExp(`\\$${skillName}`));
  assert.match(yaml, /^policy:\n  allow_implicit_invocation: true$/m);
}

function assertTriggerCorpus(document, skillName) {
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, skillName);
  assert.equal(document.cases.length, 6);
  assert.equal(document.cases.filter((entry) => entry.should_load_skill).length, 3);
  assert.equal(document.cases.filter((entry) => !entry.should_load_skill).length, 3);
  assert.equal(document.cases.every((entry) => entry.split === 'validation'), true);
  assert.equal(new Set(document.cases.map((entry) => entry.id)).size, 6);
  for (const entry of document.cases) {
    assert.equal(entry.eval_type, 'trigger');
    assert.equal(entry.unit_under_test, 'description');
    assert.equal(typeof entry.oracle.rationale, 'string');
    assert.equal(entry.oracle.rule_refs.length > 0, true);
    assert.equal(typeof entry.oracle.allowed_variance, 'string');
    if (!entry.should_load_skill) {
      assert.equal(typeof entry.oracle.minimal_counterexample, 'string');
    }
  }
}

const context = await resolveContext();

test('manifest declares the minimal plugin surface', async () => {
  const manifest = await readJson(path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.slashCommands, './slash-commands');
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  assert.deepEqual(manifest.scripts.tests.node, ['./scripts/contract.test.mjs']);
  assert.deepEqual(manifest.buildConfig.templates.include, ['slash-commands/*.md']);
  assert.equal('extensions' in manifest, false);
  assert.equal('config' in manifest, false);
  assert.equal('artifacts' in manifest, false);
  assert.equal('lifecycle' in manifest, false);
});

test('source package contains six coherent Skills', async () => {
  const actual = (await readdir(path.join(context.sourceRoot, 'skills'))).sort();
  assert.deepEqual(actual, [...skillNames].sort());

  for (const skillName of skillNames) {
    const sourceSkillRoot = path.join(context.sourceRoot, 'skills', skillName);
    const skill = await readFile(path.join(sourceSkillRoot, 'SKILL.md'), 'utf8');
    const metadata = await readFile(path.join(sourceSkillRoot, 'agents', 'openai.yaml'), 'utf8');
    assertSkillFrontmatter(skill, skillName);
    assertOpenAiMetadata(metadata, skillName);
    await readFile(path.join(sourceSkillRoot, 'README.md'), 'utf8');

    const evalManifest = await readJson(path.join(sourceSkillRoot, 'evals', 'manifest.json'));
    assert.equal(evalManifest.schemaVersion, 2);
    assert.equal(evalManifest.plugin, 'dev-workflow');
    assert.equal(evalManifest.skill, skillName);
    assert.deepEqual(evalManifest.suites[0].skills, skillNames);
    assert.equal(evalManifest.suites[0].kind, 'trigger');
    assertTriggerCorpus(
      await readJson(path.join(sourceSkillRoot, 'evals', 'trigger-cases.json')),
      skillName,
    );
  }
});

test('runtime bundle keeps all Skill roots', async () => {
  for (const skillName of skillNames) {
    const skill = await readFile(
      path.join(context.bundleRoot, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assertSkillFrontmatter(skill, skillName);
  }
});

test('manual /dev source stays a thin router', async () => {
  const command = await readFile(
    path.join(context.sourceRoot, 'slash-commands', 'dev.md'),
    'utf8',
  );
  assert.match(command, /^description: 启动或继续结构化开发工作流$/m);
  assert.match(command, /加载并执行 `dev-workflow` Skill/);
  assert.match(command, /\$dev/);
  assert.match(command, /supportsCommandArguments/);
  assert.equal(command.includes('dev-review-code` 的完整流程'), false);
});
