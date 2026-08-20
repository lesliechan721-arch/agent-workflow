import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skills = ['dev-workflow', 'dev-spec', 'dev-review-spec', 'dev-implement', 'dev-review-code'];
const askMeSkills = ['requirements-clarifier', 'decision-grill', 'decision-prototype'];
const allParticipants = new Set([...skills, ...askMeSkills]);
const read = (file) => readFile(file, 'utf8');
const readJson = async (file) => JSON.parse(await read(file));

async function context() {
  if (!process.env.AW_PLUGIN_CONTEXT) return { source: root, bundle: root };
  const value = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(value.event, 'test');
  assert.equal(value.plugin.name, 'dev-workflow');
  return { source: value.sourceRoot, bundle: value.plugin.rootDir };
}

function assertSkill(text, name) {
  assert.match(text, new RegExp(`^name: ${name}$`, 'm'));
  assert.match(text, /^description: .+时使用/m);
  assert.doesNotMatch(text, /\[TODO:/);
}

function caseEntries(document) {
  if (Array.isArray(document.cases)) return document.cases;
  if (Array.isArray(document.evals)) return document.evals;
  return [];
}

const target = await context();

test('manifest stays minimal', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.slashCommands, './slash-commands');
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  for (const key of ['extensions', 'config', 'artifacts', 'lifecycle']) {
    assert.equal(key in manifest, false);
  }
});

test('source and evals contain exactly five public Skills', async () => {
  assert.deepEqual((await readdir(path.join(target.source, 'skills'))).sort(), [...skills].sort());
  for (const name of skills) {
    const skillRoot = path.join(target.source, 'skills', name);
    assertSkill(await read(path.join(skillRoot, 'SKILL.md')), name);
    await read(path.join(skillRoot, 'README.md'));
    const metadata = await read(path.join(skillRoot, 'agents', 'openai.yaml'));
    assert.match(metadata, new RegExp(`\\$${name}`));
    assert.match(metadata, /^policy:\n  allow_implicit_invocation: true$/m);

    const evalRoot = path.join(skillRoot, 'evals');
    const evalManifest = await readJson(path.join(evalRoot, 'manifest.json'));
    assert.equal(evalManifest.plugin, 'dev-workflow');
    assert.equal(evalManifest.skill, name);
    const trigger = evalManifest.suites.find((suite) => suite.id === 'trigger');
    assert.deepEqual(trigger.skills, skills);
    const triggerCases = await readJson(path.join(evalRoot, trigger.cases));
    assert.equal(triggerCases.skill, name);
    assert.equal(triggerCases.cases.filter((entry) => entry.should_load_skill).length, 3);
    assert.equal(triggerCases.cases.filter((entry) => !entry.should_load_skill).length, 3);

    for (const suite of evalManifest.suites) {
      assert.equal(suite.skills.every((participant) => allParticipants.has(participant)), true);
      const casesPath = path.resolve(evalRoot, suite.cases);
      await access(casesPath);
      assert.equal(caseEntries(await readJson(casesPath)).length > 0, true);
    }
  }
});

test('entry eval covers cross-plugin routing and missing-companion fallback', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-workflow', 'evals');
  const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
  const withAskMe = manifest.profiles.find((profile) => profile.id === 'project-with-ask-me');
  assert.deepEqual(withAskMe.plugins.map((plugin) => plugin.name), ['dev-workflow', 'ask-me']);

  const router = manifest.suites.find((suite) => suite.id === 'router-with-ask-me');
  assert.deepEqual([...router.skills].sort(), [...allParticipants].sort());
  const routingCases = await readJson(path.join(evalRoot, router.cases));
  assert.equal(routingCases.cases.length, 9);
  assert.equal(
    routingCases.cases.some((entry) => entry.expected_loaded_skills.includes('decision-prototype')),
    true,
  );

  const fallback = manifest.suites.find((suite) => suite.id === 'fallback-without-ask-me');
  const fallbackCases = await readJson(path.join(evalRoot, fallback.cases));
  assert.equal(fallbackCases.evals.length, 1);
  assert.equal(fallbackCases.evals[0].review.workspace_unchanged, true);
});

test('specialized Skills define representative behavior evidence', async () => {
  for (const name of skills.filter((entry) => entry !== 'dev-workflow')) {
    const evalRoot = path.join(target.source, 'skills', name, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    const behavior = manifest.suites.find((suite) => suite.id === 'behavior');
    assert.ok(behavior);
    const document = await readJson(path.join(evalRoot, behavior.cases));
    assert.equal(document.skill_name, name);
    assert.equal(document.evals.length > 0, true);
    for (const entry of document.evals) {
      assert.equal(Array.isArray(entry.review.checks), true);
      assert.equal(entry.review.checks.length > 0, true);
    }
  }
});

test('direct specialized use has a safe ask-me fallback', async () => {
  for (const name of ['dev-spec', 'dev-review-spec', 'dev-implement', 'dev-review-code']) {
    const skill = await read(path.join(target.source, 'skills', name, 'SKILL.md'));
    assert.match(skill, /所需 `ask-me` Skill 不可用时/);
    assert.match(skill, /不要临时复制访谈或原型流程/);
  }
});

test('runtime keeps all Skill roots', async () => {
  for (const name of skills) {
    assertSkill(await read(path.join(target.bundle, 'skills', name, 'SKILL.md')), name);
  }
});

test('/dev remains a thin manual router', async () => {
  const command = await read(path.join(target.source, 'slash-commands', 'dev.md'));
  assert.match(command, /^description: 启动或继续结构化开发工作流$/m);
  assert.match(command, /加载并执行 `dev-workflow` Skill/);
  assert.match(command, /\$dev/);
  assert.match(command, /supportsCommandArguments/);
});
