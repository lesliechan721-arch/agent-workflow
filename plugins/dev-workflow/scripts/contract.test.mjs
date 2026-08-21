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
  assert.equal(manifest.version, '0.4.0');
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

test('workflow explicitly composes decision capabilities and review loops', async () => {
  const entry = await read(path.join(target.source, 'skills', 'dev-workflow', 'SKILL.md'));
  for (const name of ['decision-grill', 'decision-prototype', 'dev-spec', 'dev-review-spec', 'dev-implement', 'dev-review-code']) {
    assert.match(entry, new RegExp(name));
  }
  assert.match(entry, /Spec Review 为 `blocked`/);
  assert.match(entry, /Code Review 为 `blocked`/);
  assert.match(entry, /重新运行 `dev-review-spec`/);
  assert.match(entry, /重新运行 `dev-review-code`/);
  assert.match(entry, /docs\/dev\/<task-slug>\//);
  assert.doesNotMatch(entry, /自然语言状态机|更细的状态表|task-state\.json/);
});

test('specialized Skills define direct completion and next steps', async () => {
  const expected = {
    'dev-spec': ['decision-grill', 'decision-prototype', 'dev-review-spec'],
    'dev-implement': ['dev-spec', 'dev-review-code'],
    'dev-review-spec': ['decision-grill', 'decision-prototype', 'dev-spec', 'dev-review-spec'],
    'dev-review-code': ['decision-grill', 'decision-prototype', 'dev-spec', 'dev-implement', 'dev-review-code'],
  };
  for (const [name, references] of Object.entries(expected)) {
    const skill = await read(path.join(target.source, 'skills', name, 'SKILL.md'));
    assert.match(skill, /## 输出/);
    assert.match(skill, /下一步/);
    for (const reference of references) assert.match(skill, new RegExp(reference));
  }
});

test('review reports are version-bound, overwrite by default and re-run after fixes', async () => {
  const specSkill = await read(path.join(target.source, 'skills', 'dev-review-spec', 'SKILL.md'));
  assert.match(specSkill, /fresh 独立 reviewer/);
  assert.match(specSkill, /覆盖：/);
  assert.match(specSkill, /修订完成后，重新运行 `dev-review-spec`/);
  assert.doesNotMatch(specSkill, /Git blob\/OID|没有 Git 身份|Git 负责普通历史|pointer|round lineage|finding registry/);

  const codeSkill = await read(path.join(target.source, 'skills', 'dev-review-code', 'SKILL.md'));
  assert.match(codeSkill, /并行创建两个 fresh reviewer/);
  assert.match(codeSkill, /覆盖：/);
  assert.match(codeSkill, /任何代码或 Spec 变化后，重新运行 `dev-review-code`/);
  assert.doesNotMatch(codeSkill, /Git blob\/OID|没有 Git 身份|Git 负责普通历史|pointer|round lineage|finding registry/);

  const specTemplate = await read(path.join(target.source, 'skills', 'dev-review-spec', 'assets', 'spec-review-template.md'));
  assert.match(specTemplate, /Reviewed version/);
  assert.match(specTemplate, /修复与复审/);
  assert.doesNotMatch(specTemplate, /git blob|OID|sha256/i);

  const codeTemplate = await read(path.join(target.source, 'skills', 'dev-review-code', 'assets', 'code-review-template.md'));
  assert.match(codeTemplate, /Review range/);
  assert.match(codeTemplate, /Implementation version/);
  assert.match(codeTemplate, /修复与复审/);
  assert.doesNotMatch(codeTemplate, /git blob|OID|sha256/i);
});

test('review behavior evals cover independent review and full rereview', async () => {
  for (const name of ['dev-review-spec', 'dev-review-code']) {
    const evalRoot = path.join(target.source, 'skills', name, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    const behavior = manifest.suites.find((suite) => suite.id === 'behavior');
    assert.deepEqual(behavior.skills, [name]);
    assert.equal(behavior.observeSpawnAgent, true);
    const entries = assertCaseDocument(await readJson(path.join(evalRoot, behavior.cases)));
    assert.equal(entries.some((entry) => entry.id.includes('rereview')), true);
    assert.equal(entries.every((entry) => entry.review.checks.some((check) => check.includes('fresh'))), true);
  }
});

test('workflow routing eval covers direct use and repair loops', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-workflow', 'evals');
  const routing = await readJson(path.join(evalRoot, 'cross-plugin-routing-cases.json'));
  const ids = new Set(assertCaseDocument(routing).map((entry) => entry.id));
  for (const id of [
    'route_material_decisions_to_grill',
    'route_evidence_decision_to_prototype',
    'route_revised_spec_to_rereview',
    'route_fixed_code_to_rereview',
    'direct_spec_review_bypasses_router',
    'direct_code_review_bypasses_router',
  ]) {
    assert.equal(ids.has(id), true);
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
