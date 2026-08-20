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

function containsSlashDevReference(text) {
  return text.startsWith('/dev') || text.includes('\n/dev') || text.includes(' /dev');
}

const target = await context();

test('manifest exposes only the Skill entry surface', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assertStrictStableSemver(manifest.version);
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.slashCommands, undefined);
  assert.equal(manifest.buildConfig, undefined);
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  for (const key of ['extensions', 'config', 'artifacts', 'lifecycle']) {
    assert.equal(key in manifest, false);
  }
  await assert.rejects(access(path.join(target.source, 'slash-commands', 'dev.md')), {
    code: 'ENOENT',
  });
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
      assert.equal(
        suite.skills.every((participant) => allParticipants.has(participant)),
        true,
      );
      const casesPath = path.resolve(evalRoot, suite.cases);
      await access(casesPath);
      const document = await readJson(casesPath);
      const entries = assertCaseDocument(document);
      if (suite.id === 'trigger') {
        assert.equal(document.skill, name);
        assert.equal(
          entries.every((entry) => typeof entry.should_load_skill === 'boolean'),
          true,
        );
        assert.deepEqual(suite.skills, skills);
      }
    }
  }
});

test('entry eval covers assurance, stage recovery and default artifact roots', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-workflow', 'evals');
  const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
  const composed = manifest.profiles.find((profile) => profile.id === 'project-composed');
  assert.deepEqual(
    composed.plugins.map((plugin) => plugin.name),
    ['dev-workflow', 'ask-me'],
  );
  assert.equal(manifest.suites.some((suite) => suite.id.includes('fallback')), false);

  const router = manifest.suites.find((suite) => suite.id === 'router-composed');
  assert.deepEqual([...router.skills].sort(), [...allParticipants].sort());
  const routingCases = await readJson(path.join(evalRoot, router.cases));
  const routingEntries = assertCaseDocument(routingCases);
  const ids = new Set(routingEntries.map((entry) => entry.id));
  for (const id of [
    'route_fast_explicit_workflow',
    'route_standard_decision_grill',
    'route_standard_decision_prototype',
    'resume_grill_evidence_to_prototype',
    'resume_prototype_verdict_to_spec',
    'resume_spec_review_material_decision',
    'resume_code_review_implementation_defect',
  ]) {
    assert.equal(ids.has(id), true);
  }
  assert.equal(routingEntries.some((entry) => containsSlashDevReference(entry.query)), false);

  const composition = manifest.suites.find((suite) => suite.id === 'composition-composed');
  const compositionCases = await readJson(path.join(evalRoot, composition.cases));
  const compositionEntries = assertCaseDocument(compositionCases);
  assert.equal(
    compositionEntries.every((entry) =>
      entry.review.allowed_workspace_changes.every((change) => change.startsWith('docs/dev/')),
    ),
    true,
  );
  assert.equal(
    compositionEntries.flatMap((entry) => entry.review.artifacts).every((artifact) =>
      artifact.path.startsWith('docs/dev/'),
    ),
    true,
  );
});

test('specialized behavior suites run with only their owner Skill', async () => {
  for (const name of skills.filter((entry) => entry !== 'dev-workflow')) {
    const evalRoot = path.join(target.source, 'skills', name, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    const behavior = manifest.suites.find((suite) => suite.id === 'behavior');
    assert.deepEqual(behavior.skills, [name]);
    const document = await readJson(path.join(evalRoot, behavior.cases));
    assert.equal(document.skill_name, name);
    const entries = assertCaseDocument(document);
    for (const entry of entries) {
      assert.equal(Array.isArray(entry.review.checks), true);
      assert.equal(entry.review.checks.length > 0, true);
    }
  }
});

test('published specialized Skills return neutral results instead of orchestrating peers', async () => {
  const prohibited = ['ask-me', ...skills, ...decisionSkills];
  for (const name of skills.filter((entry) => entry !== 'dev-workflow')) {
    const skill = await read(path.join(target.source, 'skills', name, 'SKILL.md'));
    const otherNames = prohibited.filter((entry) => entry !== name);
    // Static contract exception: specialized Skills must not encode cross-Skill orchestration; behavior test is not suitable because the forbidden coupling is the published instruction text itself.
    assert.doesNotMatch(skill, new RegExp(otherNames.join('|')));
  }

  const entry = await read(path.join(target.source, 'skills', 'dev-workflow', 'SKILL.md'));
  // Static contract exception: the public workflow contract must declare its default artifact root and assurance profiles; behavior test is not suitable because these literals are consumed as portable path and profile conventions.
  assert.match(entry, /docs\/dev\/<task-slug>\//);
  for (const profile of ['Fast', 'Standard', 'Assured']) {
    assert.match(entry, new RegExp(`### ${profile}`));
  }
  assert.equal(containsSlashDevReference(entry), false);
  assert.doesNotMatch(entry, /对应 Skill 不可用|建议安装/);
});

test('release manifests require representative evidence without fixing corpus sizes', async () => {
  const entryRoot = path.join(target.source, 'skills', 'dev-workflow', 'evals');
  const entryManifest = await readJson(path.join(entryRoot, 'manifest.json'));

  for (const profileId of ['project-default', 'project-composed']) {
    const profile = entryManifest.profiles.find((entry) => entry.id === profileId);
    assert.equal(profile?.requiredForRelease, true);
  }
  for (const suiteId of ['trigger', 'router-composed', 'composition-composed']) {
    const suite = entryManifest.suites.find((entry) => entry.id === suiteId);
    assert.equal(suite?.requiredForRelease, true);
  }

  for (const name of skills.filter((entry) => entry !== 'dev-workflow')) {
    const manifest = await readJson(
      path.join(target.source, 'skills', name, 'evals', 'manifest.json'),
    );
    const profile = manifest.profiles.find((entry) => entry.id === 'project-default');
    const behavior = manifest.suites.find((entry) => entry.id === 'behavior');
    assert.equal(profile?.requiredForRelease, true);
    assert.equal(behavior?.requiredForRelease, true);
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
