import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const requiredSkills = [
  'requirements-clarifier',
  'decision-grill',
  'decision-prototype',
];

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

function assertCaseDocument(document, participants) {
  const entries = Array.isArray(document.cases)
    ? document.cases
    : Array.isArray(document.evals)
      ? document.evals
      : [];
  assert.equal(entries.length > 0, true);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'string');
    if (entry.expected_loaded_skills !== undefined) {
      assert.equal(Array.isArray(entry.expected_loaded_skills), true);
      assert.equal(
        entry.expected_loaded_skills.every((skill) => participants.has(skill)),
        true,
      );
    }
    if (entry.should_load_skill !== undefined) {
      assert.equal(typeof entry.should_load_skill, 'boolean');
    }
  }
}

const context = await resolveContext();

test('manifest declares a config-driven quality gate', async () => {
  const manifest = await readJson(
    path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'),
  );

  assert.equal(manifest.name, 'ask-me');
  assertStrictStableSemver(manifest.version);
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.extensions?.instructions?.length ?? 0, 0);
  assert.deepEqual(manifest.config.schema.qualityGateEnabled, {
    type: 'boolean',
    title: '实施前需求检查',
    description: '启用后，在非平凡实现前检查是否仍有会影响结果、范围或验收的关键歧义。',
    default: true,
  });
  assert.deepEqual(manifest.scripts.artifacts.render, {
    runner: 'node',
    path: './scripts/render-artifacts.mjs',
  });

  const targets = new Map(
    manifest.artifacts.targets.map((target) => [target.id, target]),
  );
  assert.deepEqual(
    targets.get('ask-me-quality-gate-codex'),
    {
      id: 'ask-me-quality-gate-codex',
      platform: 'codex',
      scopes: ['user', 'project'],
      target: 'codex.developerInstructionsBlock',
      projectManagedKind: 'instruction',
      states: ['present', 'disabled'],
      refreshKeys: ['qualityGateEnabled'],
      requiresCodexProjectConfig: true,
    },
  );
  assert.deepEqual(
    targets.get('ask-me-quality-gate-claude'),
    {
      id: 'ask-me-quality-gate-claude',
      platform: 'claude',
      scopes: ['user', 'project'],
      target: 'claude.skill',
      states: ['present', 'disabled'],
      refreshKeys: ['qualityGateEnabled'],
      skillKey: 'ask-me-quality-gate',
    },
  );
});

test('source package contains the three public Skills and native metadata', async () => {
  const sourceSkillNames = new Set(await readdir(path.join(context.sourceRoot, 'skills')));
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
    assert.equal(manifest.plugin, 'ask-me');
    assert.equal(manifest.skill, skillName);
    assert.equal(Array.isArray(manifest.suites), true);
    assert.equal(manifest.suites.length > 0, true);

    for (const suite of manifest.suites) {
      assert.equal(Array.isArray(suite.skills), true);
      assert.equal(suite.skills.every((name) => participants.has(name)), true);
      const casePath = path.resolve(evalRoot, suite.cases);
      await access(casePath);
      assertCaseDocument(await readJson(casePath), participants);
      if (suite.fixtureModule) {
        await access(path.resolve(evalRoot, suite.fixtureModule));
      }
    }
  }
});

test('plan-review cases receive an actual migration plan fixture', async () => {
  const [
    { setupTriggerWorkspace: setupDecisionTriggerWorkspace },
    { setupTriggerWorkspace: setupRequirementsTriggerWorkspace },
  ] = await Promise.all([
    import(pathToFileURL(path.join(
      context.sourceRoot,
      'skills',
      'decision-grill',
      'evals',
      'trigger-fixture.mjs',
    )).href),
    import(pathToFileURL(path.join(
      context.sourceRoot,
      'skills',
      'requirements-clarifier',
      'evals',
      'trigger-fixture.mjs',
    )).href),
  ]);
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'ask-me-plan-review-trigger-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-plan-review-router-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-plan-review-requirements-')),
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
    await setupRequirementsTriggerWorkspace({
      workspaceRoot: roots[2],
      evalCase: { id: 'direct_plan_review' },
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

test('prepared bundle renders static Skills and ships the artifact renderer', async () => {
  if (!context.platform) return;

  const platformManifest = await readJson(
    path.join(context.bundleRoot, `.${context.platform}-plugin`, 'plugin.json'),
  );
  assert.equal(platformManifest.name, 'ask-me');
  assert.equal(platformManifest.skills, `./${context.platform}/skills`);
  await access(path.join(context.bundleRoot, 'scripts', 'render-artifacts.mjs'));

  const expectedTool = context.platform === 'codex'
    ? '`request_user_input`'
    : '`AskUserQuestion`';
  const otherTool = context.platform === 'codex'
    ? '`AskUserQuestion`'
    : '`request_user_input`';

  for (const skillName of requiredSkills) {
    const skill = await readFile(
      path.join(context.bundleRoot, context.platform, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assert.equal(skill.includes(expectedTool), true);
    assert.equal(skill.includes(otherTool), false);
    assert.equal(skill.includes('{{questionTool}}'), false);
  }
});
