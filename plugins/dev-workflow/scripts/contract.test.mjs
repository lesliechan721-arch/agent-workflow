import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skills = ['dev-workflow', 'dev-spec', 'dev-review-spec', 'dev-implement', 'dev-review-code'];
const read = (file) => readFile(file, 'utf8');
const readJson = async (file) => JSON.parse(await read(file));

async function context() {
  if (!process.env.AW_PLUGIN_CONTEXT) return { source: root, bundle: root, platform: null };
  const value = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(value.event, 'test');
  assert.equal(value.plugin.name, 'dev-workflow');
  assert.ok(['claude', 'codex'].includes(value.platform));
  return { source: value.sourceRoot, bundle: value.plugin.rootDir, platform: value.platform };
}

function assertSkill(text, name) {
  assert.match(text, new RegExp(`^name: ${name}$`, 'm'));
  assert.match(text, /^description: .+时使用/m);
  assert.doesNotMatch(text, /\[TODO:/);
}

const target = await context();

test('manifest stays minimal', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.slashCommands, './slash-commands');
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  for (const key of ['extensions', 'config', 'artifacts', 'lifecycle']) {
    assert.equal(key in manifest, false);
  }
});

test('source and evals contain exactly five Skills', async () => {
  assert.deepEqual((await readdir(path.join(target.source, 'skills'))).sort(), [...skills].sort());
  for (const name of skills) {
    const skillRoot = path.join(target.source, 'skills', name);
    assertSkill(await read(path.join(skillRoot, 'SKILL.md')), name);
    await read(path.join(skillRoot, 'README.md'));
    const metadata = await read(path.join(skillRoot, 'agents', 'openai.yaml'));
    assert.match(metadata, new RegExp(`\\$${name}`));
    assert.match(metadata, /^policy:\n  allow_implicit_invocation: true$/m);
    const evalManifest = await readJson(path.join(skillRoot, 'evals', 'manifest.json'));
    assert.equal(evalManifest.plugin, 'dev-workflow');
    assert.equal(evalManifest.skill, name);
    assert.deepEqual(evalManifest.suites[0].skills, skills);
    const cases = await readJson(path.join(skillRoot, 'evals', 'trigger-cases.json'));
    assert.equal(cases.skill, name);
    assert.equal(cases.cases.filter((entry) => entry.should_load_skill).length, 3);
    assert.equal(cases.cases.filter((entry) => !entry.should_load_skill).length, 3);
  }
});

test('runtime keeps all Skill roots', async () => {
  for (const name of skills) {
    const skillsRoot = target.platform
      ? path.join(target.bundle, target.platform, 'skills')
      : path.join(target.bundle, 'skills');
    assertSkill(await read(path.join(skillsRoot, name, 'SKILL.md')), name);
  }
});

test('/dev remains a thin manual router', async () => {
  const command = await read(path.join(target.source, 'slash-commands', 'dev.md'));
  assert.match(command, /^description: 启动或继续结构化开发工作流$/m);
  assert.match(command, /加载并执行 `dev-workflow` Skill/);
  assert.match(command, /\$dev/);
  assert.match(command, /supportsCommandArguments/);
});
