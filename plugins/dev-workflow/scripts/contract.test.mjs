import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
    if (entry.expected_loaded_skills !== undefined) {
      assert.equal(
        entry.expected_loaded_skills.every((participant) => allParticipants.has(participant)),
        true,
      );
    }
  }
  return entries;
}

const target = await context();

test('manifest exposes the five-Skill workflow surface', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assert.equal(manifest.skills, './skills');
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  for (const key of ['slashCommands', 'buildConfig', 'extensions', 'config', 'artifacts', 'lifecycle']) {
    assert.equal(key in manifest, false);
  }
});

test('source exposes five directly usable Skills', async () => {
  assert.deepEqual((await readdir(path.join(target.source, 'skills'))).sort(), [...skills].sort());
  for (const name of skills) {
    const skillRoot = path.join(target.source, 'skills', name);
    assertSkill(await read(path.join(skillRoot, 'SKILL.md')), name);
    await read(path.join(skillRoot, 'README.md'));
    const metadata = await read(path.join(skillRoot, 'agents', 'openai.yaml'));
    assert.match(metadata, new RegExp(`\\$${name}`));
    assert.match(metadata, /^policy:\n  allow_implicit_invocation: true$/m);
  }
});

test('review behavior suites remain structurally valid', async () => {
  for (const name of ['dev-review-spec', 'dev-review-code']) {
    const evalRoot = path.join(target.source, 'skills', name, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    const behavior = manifest.suites.find((suite) => suite.id === 'behavior');
    assert.ok(behavior);
    assert.deepEqual(behavior.skills, [name]);
    assert.equal('observeSpawnAgent' in behavior, false);
    assertCaseDocument(await readJson(path.join(evalRoot, behavior.cases)));
  }
});

test('workflow routing eval references only installed participants', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-workflow', 'evals');
  assertCaseDocument(await readJson(path.join(evalRoot, 'cross-plugin-routing-cases.json')));
});

test('runtime keeps all Skill roots', async () => {
  for (const name of skills) {
    const skillsRoot = target.platform
      ? path.join(target.bundle, target.platform, 'skills')
      : path.join(target.bundle, 'skills');
    assertSkill(await read(path.join(skillsRoot, name, 'SKILL.md')), name);
  }
});
