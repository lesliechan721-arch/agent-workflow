import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skills = ['dev-workflow', 'dev-spec', 'dev-review-spec', 'dev-implement', 'dev-review-code'];
const decisionSkills = ['decision-shape', 'decision-grill', 'decision-prototype'];
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

function assertCaseDocument(document) {
  assert.equal(document.version, 1);
  assert.equal(typeof document.suite?.unitUnderTest, 'string');
  assert.equal(Array.isArray(document.suite?.participants ?? []), true);
  const participants = new Set([
    document.suite.unitUnderTest,
    ...(document.suite.participants ?? []),
  ]);
  assert.equal([...participants].every((participant) => allParticipants.has(participant)), true);
  const entries = document.cases;
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length > 0, true);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string');
    if (document.suite.kind === 'trigger') {
      assert.equal(typeof entry.input?.query, 'string');
      const expectedLoad = entry.input?.expectedLoad;
      const loadedSkills = entry.input?.expected?.loadedSkills;
      assert.equal(expectedLoad !== undefined || loadedSkills !== undefined, true);
      if (expectedLoad !== undefined) assert.equal(typeof expectedLoad, 'boolean');
      if (loadedSkills !== undefined) {
        assert.equal(Array.isArray(loadedSkills), true);
        assert.equal(loadedSkills.every((participant) => participants.has(participant)), true);
      }
    }
  }
  return entries;
}

const target = await context();

test('manifest exposes five local Skills and declares the ask-me dependency', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assert.deepEqual(manifest.dependencies, ['ask-me']);
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

test('review Eval wiring covers blocker and current-state cases', async () => {
  const expectedCases = new Map([
    ['dev-review-spec', 'rereview-does-not-promote-reviewer-preference'],
    ['dev-review-code', 'public-skill-process-history-is-a-material-finding'],
    ['dev-implement', 'normalize-final-artifact-to-current-contract'],
  ]);
  for (const [name, caseId] of expectedCases) {
    const cases = assertCaseDocument(
      await readJson(path.join(target.source, 'skills', name, 'evals', 'behavior-cases.json')),
    );
    assert.equal(cases.some((entry) => entry.id === caseId), true);
  }
});

test('review behavior suites remain structurally valid', async () => {
  for (const name of ['dev-review-spec', 'dev-review-code']) {
    const evalRoot = path.join(target.source, 'skills', name, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    const behavior = manifest.suites.find((suite) => suite.id === 'behavior');
    assert.ok(behavior);
    const corpus = await readJson(path.join(evalRoot, behavior.cases));
    assert.equal(corpus.suite.unitUnderTest, name);
    assert.deepEqual(corpus.suite.participants ?? [], []);
    assert.equal('observeSpawnAgent' in corpus.suite.runtime, false);
    assertCaseDocument(corpus);
  }
});

test('workflow routing eval observes leaf candidates but routes Shape through decision-shape', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-workflow', 'evals');
  const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
  const router = manifest.suites.find((suite) => suite.id === 'router-composed');
  assert.ok(router);
  const routingCorpus = await readJson(path.join(evalRoot, router.cases));
  assert.equal(routingCorpus.suite.unitUnderTest, 'dev-workflow');
  assert.equal(routingCorpus.suite.participants.includes('decision-shape'), true);
  assert.equal(routingCorpus.suite.participants.includes('decision-grill'), true);
  assert.equal(routingCorpus.suite.participants.includes('decision-prototype'), true);

  const cases = assertCaseDocument(routingCorpus);
  for (const id of [
    'route_new_feature_intent_is_not_ready',
    'route_fast_to_implement',
    'route_fast_verified_to_code_review',
    'route_decisions_to_spec',
    'route_approved_spec_to_implement',
    'route_shape_evidence_branch_stays_in_shape',
    'direct_code_review_bypasses_router',
  ]) {
    assert.equal(cases.some((entry) => entry.id === id), true);
  }
  for (const id of [
    'route_new_feature_intent_is_not_ready',
    'route_material_decisions_to_shape',
    'route_shape_evidence_branch_stays_in_shape',
  ]) {
    const entry = cases.find((candidate) => candidate.id === id);
    assert.deepEqual(entry.input.expected.loadedSkills, ['dev-workflow', 'decision-shape']);
  }
  assert.deepEqual(
    cases.find((entry) => entry.id === 'route_fast_verified_to_code_review').input.expected.loadedSkills,
    ['dev-workflow', 'dev-review-code'],
  );
  const composition = assertCaseDocument(
    await readJson(path.join(evalRoot, 'composition-behavior-cases.json')),
  );
  for (const id of [
    'prototype-feedback-to-default-task-root',
    'assured-migration-stops-at-approval',
    'second-blocked-review-stops-before-more-repair',
    'route-summary-is-user-navigation',
  ]) assert.equal(composition.some((entry) => entry.id === id), true);
});

test('runtime keeps all Skill roots and conditional references', async () => {
  const skillsRoot = target.platform
    ? path.join(target.bundle, target.platform, 'skills')
    : path.join(target.bundle, 'skills');
  for (const name of skills) {
    assertSkill(await read(path.join(skillsRoot, name, 'SKILL.md')), name);
  }
  await read(path.join(skillsRoot, 'dev-workflow', 'references', 'review-repair.md'));
  await read(path.join(skillsRoot, 'dev-review-spec', 'references', 'rereview.md'));
  await read(path.join(skillsRoot, 'dev-review-code', 'references', 'rereview.md'));
});
