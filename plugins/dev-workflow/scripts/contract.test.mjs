import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skills = ['dev-workflow', 'dev-spec', 'dev-review-spec', 'dev-implement', 'dev-review-code'];
const decisionSkills = ['decision-grill', 'decision-prototype'];
const allParticipants = new Set([...skills, ...decisionSkills]);
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

function assertStrictStableSemver(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
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

function assertCaseDocument(document) {
  const entries = caseEntries(document);
  assert.equal(entries.length > 0, true);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string');
    if (entry.should_load_skill !== undefined) {
      assert.equal(typeof entry.should_load_skill, 'boolean');
    }
    if (entry.expected_loaded_skills !== undefined) {
      assert.equal(Array.isArray(entry.expected_loaded_skills), true);
      assert.equal(
        entry.expected_loaded_skills.every((participant) => allParticipants.has(participant)),
        true,
      );
    }
  }
  return entries;
}

const target = await context();

test('manifest exposes a Skill-only entry surface', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assertStrictStableSemver(manifest.version);
  assert.equal(manifest.skills, './skills');
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  for (const key of ['slashCommands', 'buildConfig', 'extensions', 'config', 'artifacts', 'lifecycle']) {
    assert.equal(key in manifest, false);
  }
});

test('source and evals expose the five public Skills', async () => {
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

    for (const suite of evalManifest.suites) {
      assert.equal(suite.skills.every((participant) => allParticipants.has(participant)), true);
      const casesPath = path.resolve(evalRoot, suite.cases);
      await access(casesPath);
      assertCaseDocument(await readJson(casesPath));
    }
  }
});

test('specialized Skills remain directly usable and do not orchestrate peers', async () => {
  const prohibited = ['ask-me', ...skills, ...decisionSkills];
  for (const name of skills.filter((entry) => entry !== 'dev-workflow')) {
    const skill = await read(path.join(target.source, 'skills', name, 'SKILL.md'));
    const otherNames = prohibited.filter((entry) => entry !== name);
    assert.doesNotMatch(skill, new RegExp(otherNames.join('|')));
    assert.match(skill, /## 输出/);
  }

  const entry = await read(path.join(target.source, 'skills', 'dev-workflow', 'SKILL.md'));
  assert.match(entry, /可选的开发流程编排器/);
  assert.match(entry, /docs\/dev\/<task-slug>\//);
  for (const profile of ['Fast', 'Standard', 'Assured']) {
    assert.match(entry, new RegExp(`\\*\\*${profile}\\*\\*`));
  }
  assert.doesNotMatch(entry, /task-state\.json|pointer|round lineage|finding registry/);
});

test('formal Review Skills require fresh independent subagents', async () => {
  const specSkill = await read(
    path.join(target.source, 'skills', 'dev-review-spec', 'SKILL.md'),
  );
  assert.match(specSkill, /fresh 独立子代理上下文/);
  assert.match(specSkill, /返回 `incomplete`/);
  assert.match(specSkill, /Target revision/);
  assert.match(specSkill, /reviews\/spec\/<timestamp>\.md/);
  assert.doesNotMatch(specSkill, /task-state\.json/);

  const codeSkill = await read(
    path.join(target.source, 'skills', 'dev-review-code', 'SKILL.md'),
  );
  assert.match(codeSkill, /两个 fresh 独立子代理/);
  assert.match(codeSkill, /并行创建两个 fresh reviewer/);
  assert.match(codeSkill, /返回 `incomplete`/);
  assert.match(codeSkill, /reviews\/code\/<timestamp>\.md/);
  assert.doesNotMatch(codeSkill, /task-state\.json/);

  const specTemplate = await read(
    path.join(target.source, 'skills', 'dev-review-spec', 'assets', 'spec-review-template.md'),
  );
  assert.match(specTemplate, /Target revision/);
  assert.match(specTemplate, /Review context: `independent`/);
  assert.match(specTemplate, /clean \| blocked \| incomplete/);

  const codeTemplate = await read(
    path.join(target.source, 'skills', 'dev-review-code', 'assets', 'code-review-template.md'),
  );
  assert.match(codeTemplate, /Diff revision/);
  assert.match(codeTemplate, /Spec revision/);
  assert.match(codeTemplate, /independent-spec-fidelity, independent-engineering-quality/);
});

test('Review behavior evals observe subagent creation', async () => {
  for (const name of ['dev-review-spec', 'dev-review-code']) {
    const evalRoot = path.join(target.source, 'skills', name, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    const behavior = manifest.suites.find((suite) => suite.id === 'behavior');
    assert.deepEqual(behavior.skills, [name]);
    assert.equal(behavior.observeSpawnAgent, true);

    const document = await readJson(path.join(evalRoot, behavior.cases));
    const entries = assertCaseDocument(document);
    assert.equal(
      entries.every((entry) => entry.review.checks.some((check) => check.includes('fresh'))),
      true,
    );
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
