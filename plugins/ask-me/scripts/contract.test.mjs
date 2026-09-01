import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setupTriggerWorkspace as setupDecisionTriggerWorkspace } from '../skills/decision-grill/evals/trigger-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const requiredSkills = ['decision-grill', 'decision-prototype', 'decision-shape'];
const leafSkills = ['decision-grill', 'decision-prototype'];
const questionToolSkills = new Set(leafSkills);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) {
    return {
      sourceRoot: localPluginRoot,
      bundleRoot: localPluginRoot,
      platform: null,
    };
  }

  const context = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'ask-me');
  assert.ok(['codex', 'claude'].includes(context.platform));
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

function assertStrictStableSemver(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
}

function assertOpenAiMetadata(openaiYaml, skillName) {
  assert.match(openaiYaml, /^interface:/m);
  assert.match(openaiYaml, new RegExp(`\\$${skillName}\\b`));
  assert.match(openaiYaml, /^policy:\n  allow_implicit_invocation: true$/m);
}

function assertCaseDocument(document, skillName, availableSkills) {
  assert.equal(document.version, 1);
  assert.equal(document.suite?.unitUnderTest, skillName);
  assert.equal(Array.isArray(document.suite?.participants ?? []), true);
  const participants = new Set([
    document.suite.unitUnderTest,
    ...(document.suite.participants ?? []),
  ]);
  assert.equal([...participants].every((skill) => availableSkills.has(skill)), true);
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
        assert.equal(loadedSkills.every((skill) => participants.has(skill)), true);
      }
    } else if (document.suite.kind === 'conversation') {
      assert.equal(typeof entry.prompt, 'string');
      assert.equal(entry.prompt.trim().length > 0, true);
      assert.equal(Array.isArray(entry.assertions), true);
      assert.equal(entry.assertions.length > 0, true);
      assert.equal(entry.assertions.every((assertion) => (
        typeof assertion === 'string' && assertion.trim().length > 0
      )), true);
    }
  }
  return document;
}

const context = await resolveContext();

test('manifest exposes the three decision Skills', async () => {
  const manifest = await readJson(path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'));

  assert.equal(manifest.name, 'ask-me');
  assertStrictStableSemver(manifest.version);
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.extensions?.instructions?.length ?? 0, 0);
  assert.equal(manifest.config, undefined);
  assert.equal(manifest.artifacts, undefined);
  assert.equal(manifest.scripts.artifacts, undefined);
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
});

test('source package contains the three public Skills and native metadata', async () => {
  const sourceSkillNames = new Set(await readdir(path.join(context.sourceRoot, 'skills')));
  assert.deepEqual([...sourceSkillNames].sort(), [...requiredSkills].sort());
  for (const skillName of requiredSkills) {
    assert.equal(sourceSkillNames.has(skillName), true);
    const skillRoot = path.join(context.sourceRoot, 'skills', skillName);
    const [skill, openaiYaml] = await Promise.all([
      readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
      readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
    ]);
    assert.match(skill, new RegExp(`^name: ${skillName}$`, 'm'));
    assertOpenAiMetadata(openaiYaml, skillName);
  }
});

test('eval manifests point to parseable case documents with valid participant names', async () => {
  const participants = new Set(requiredSkills);
  for (const skillName of requiredSkills) {
    const evalRoot = path.join(context.sourceRoot, 'skills', skillName, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    assert.equal(manifest.version, 1);
    assert.equal(Array.isArray(manifest.suites), true);
    assert.equal(manifest.suites.length > 0, true);

    for (const suite of manifest.suites) {
      const casePath = path.resolve(evalRoot, suite.cases);
      await access(casePath);
      assertCaseDocument(await readJson(casePath), skillName, participants);
      if (suite.fixtureModule) {
        await access(path.resolve(evalRoot, suite.fixtureModule));
      }
    }
  }
});

test('leaf behavior stays independent and decision-shape owns composition', async () => {
  for (const skillName of leafSkills) {
    const manifest = await readJson(
      path.join(context.sourceRoot, 'skills', skillName, 'evals', 'manifest.json'),
    );
    const router = manifest.suites.find((suite) => suite.id === 'router');
    const routerCorpus = await readJson(path.join(
      context.sourceRoot, 'skills', skillName, 'evals', router.cases,
    ));
    assert.deepEqual(
      [routerCorpus.suite.unitUnderTest, ...(routerCorpus.suite.participants ?? [])].sort(),
      [...leafSkills].sort(),
    );
    assert.equal(routerCorpus.suite.runtime.forbidMultipleSkillLoads, true);

    for (const suite of manifest.suites.filter((entry) => entry.kind === 'conversation')) {
      const corpus = await readJson(path.join(
        context.sourceRoot, 'skills', skillName, 'evals', suite.cases,
      ));
      assert.equal(corpus.suite.unitUnderTest, skillName);
      assert.deepEqual(corpus.suite.participants ?? [], []);
    }
  }

  const shapeManifest = await readJson(
    path.join(context.sourceRoot, 'skills', 'decision-shape', 'evals', 'manifest.json'),
  );
  const shapeRouter = shapeManifest.suites.find((suite) => suite.id === 'router');
  const shapeEvalRoot = path.join(context.sourceRoot, 'skills', 'decision-shape', 'evals');
  const shapeRouterCorpus = await readJson(path.join(shapeEvalRoot, shapeRouter.cases));
  assert.deepEqual(
    [shapeRouterCorpus.suite.unitUnderTest, ...(shapeRouterCorpus.suite.participants ?? [])].sort(),
    [...requiredSkills].sort(),
  );
  assert.equal(shapeRouterCorpus.suite.runtime.forbidMultipleSkillLoads, false);
  for (const suite of shapeManifest.suites.filter((entry) => entry.kind === 'conversation')) {
    const corpus = await readJson(path.join(shapeEvalRoot, suite.cases));
    assert.deepEqual(
      [corpus.suite.unitUnderTest, ...(corpus.suite.participants ?? [])].sort(),
      [...requiredSkills].sort(),
    );
  }
  const sharedFrameSuite = shapeManifest.suites.find((suite) => suite.id === 'shared-frame');
  assert.ok(sharedFrameSuite);
  assert.equal(sharedFrameSuite.cases, 'shared-frame-cases.json');
  const sharedFrameCorpus = await readJson(path.join(shapeEvalRoot, sharedFrameSuite.cases));
  assert.deepEqual(
    sharedFrameCorpus.cases.map((entry) => entry.id),
    [
      'shape-shares-provisional-frame',
      'shape-passes-frame-to-prototype',
      'shape-passes-frame-to-grill',
      'frame-change-reopens-affected-only',
    ],
  );

  const prototypeRoot = path.join(context.sourceRoot, 'skills', 'decision-prototype', 'evals');
  const behavior = await readJson(
    path.join(prototypeRoot, 'decision-prototype-release-evals.json'),
  );
  assert.equal(behavior.version, 1);
  assert.equal(behavior.suite.unitUnderTest, 'decision-prototype');
  assert.equal(behavior.suite.runtime.isolation, 'strict');
  assert.equal(Array.isArray(behavior.cases), true);
  assert.equal(behavior.cases.length > 0, true);
  for (const entry of behavior.cases) {
    assert.equal(entry.expected.workspaceUnchanged, false);
    assert.equal(entry.expected.allowedWorkspaceChanges.length > 0, true);
    assert.equal(
      Object.keys(entry.input.workspaceFiles).some((file) => file.startsWith('src/')),
      true,
    );
    assert.equal(
      entry.expected.artifacts.every((artifact) => artifact.path.startsWith('prototypes/')),
      true,
    );
  }
});

test('published leaf Skills stay independent and the macro stays generic', async () => {
  const grill = await readFile(
    path.join(context.sourceRoot, 'skills', 'decision-grill', 'SKILL.md'),
    'utf8',
  );
  const prototype = await readFile(
    path.join(context.sourceRoot, 'skills', 'decision-prototype', 'SKILL.md'),
    'utf8',
  );
  const shape = await readFile(
    path.join(context.sourceRoot, 'skills', 'decision-shape', 'SKILL.md'),
    'utf8',
  );

  // Static contract exception: leaf independence and reverse coupling are properties of the published instruction text itself, so runtime behavior cannot prove that the forbidden dependency is absent.
  assert.doesNotMatch(grill, /decision-shape|decision-prototype/);
  assert.doesNotMatch(prototype, /decision-shape|decision-grill/);
  assert.match(shape, /decision-grill/);
  assert.match(shape, /decision-prototype/);
  assert.doesNotMatch(shape, /dev-workflow|docs\/dev|Fast|Standard|Assured/);
});

test('plan-review cases receive an actual migration plan fixture', async () => {
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'ask-me-plan-review-trigger-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-plan-review-router-')),
  ]);
  try {
    await setupDecisionTriggerWorkspace({
      workspaceRoot: roots[0],
      evalCase: { id: 'n03_one_shot_plan_review' },
    });
    await setupDecisionTriggerWorkspace({
      workspaceRoot: roots[1],
      evalCase: { id: 'plan_review' },
    });
    for (const root of roots) {
      const plan = await readFile(path.join(root, 'docs', 'migration-plan.md'), 'utf8');
      assert.match(plan, /Session expiry migration plan/);
      assert.match(plan, /## Rollback/);
      assert.match(plan, /## Known risks/);
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test('prepared bundle renders the three static Skills', async () => {
  if (!context.platform) return;

  const platformManifest = await readJson(
    path.join(context.bundleRoot, `.${context.platform}-plugin`, 'plugin.json'),
  );
  assert.equal(platformManifest.name, 'ask-me');
  assert.equal(platformManifest.skills, `./${context.platform}/skills`);
  const expectedTool = context.platform === 'codex' ? '`request_user_input`' : '`AskUserQuestion`';
  const otherTool = context.platform === 'codex' ? '`AskUserQuestion`' : '`request_user_input`';

  for (const skillName of requiredSkills) {
    const skill = await readFile(
      path.join(context.bundleRoot, context.platform, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assert.equal(skill.includes(expectedTool), questionToolSkills.has(skillName));
    assert.equal(skill.includes(otherTool), false);
    assert.equal(skill.includes('{{questionTool}}'), false);
  }

  await access(path.join(
    context.bundleRoot,
    context.platform,
    'skills',
    'decision-grill',
    'references',
    'decision-presentation.md',
  ));
});
