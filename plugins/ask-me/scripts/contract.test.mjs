import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  setupTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from '../evals/trigger-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const pluginVersion = '0.2.3';
const qualityGate = '开始非平凡实现前，先检查需求是否还有关键歧义。若存在多种合理理解，且选错会明显影响交付结果、功能范围或验收，或多项小歧义合起来会决定成品形态，先使用 `requirements-clarifier`。\n\n能从现有上下文查明、有明确项目惯例、容易调整、只涉及内部实现或用户已授权采用默认值的事项不必追问；会影响用户预期的关键默认值应明确说明，不要静默假设。';
const skillNames = ['requirements-clarifier', 'decision-grill'];

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
  assert.equal(context.plugin.version, pluginVersion);
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

function assertOpenAiMetadata(openaiYaml, skillName) {
  const shortDescription = yamlQuotedValue(openaiYaml, 'short_description');
  const defaultPrompt = yamlQuotedValue(openaiYaml, 'default_prompt');
  const shortDescriptionLength = Array.from(shortDescription).length;

  assert.equal(shortDescriptionLength >= 25, true);
  assert.equal(shortDescriptionLength <= 64, true);
  assert.match(defaultPrompt, new RegExp(`\\$${skillName}`));
  assert.match(openaiYaml, /^policy:\n  allow_implicit_invocation: true$/m);
}

function assertSharedSkillContract(skill, skillName) {
  assert.equal(skill.includes('[TODO:'), false);
  assert.match(skill, new RegExp(`^name: ${skillName}$`, 'm'));
  assert.match(skill, /^description: .+何时使用|^description: .+时使用/m);
  assert.match(skill, /先只读查看/);
  assert.match(skill, /已经说明或能查到的事实直接采用|能查到的事实自行确认/);
  assert.match(skill, /互相独立时每轮最多三题/);
  assert.match(skill, /适合列选项时使用 \{\{questionTool\}\}/);
  assert.match(skill, /待验证/);
  assert.match(skill, /交还原任务|交还原工作流/);
  assert.equal(skill.includes('request_user_input'), false);
  assert.equal(skill.includes('AskUserQuestion'), false);
  assert.doesNotMatch(skill, /^user-invocable:\s*false$/m);
  assert.doesNotMatch(skill, /^disable-model-invocation:\s*true$/m);
}

function assertRequirementsClarifierContract(skill) {
  assertSharedSkillContract(skill, 'requirements-clarifier');
  assert.match(skill, /不是把所有细节都问一遍/);
  assert.match(skill, /询问用户/);
  assert.match(skill, /采用默认/);
  assert.match(skill, /列为待验证/);
  assert.match(skill, /猜错后的返工大于现在提问的成本/);
  assert.match(skill, /单项影响有限，但多项合在一起会决定功能形态时，也应先澄清/);
  assert.match(skill, /已确认 \/ 采用的关键默认 \/ 待验证或未解决/);
}

function assertDecisionGrillContract(skill) {
  assertSharedSkillContract(skill, 'decision-grill');
  assert.match(skill, /计划或决定本身是当前任务的产物/);
  assert.match(skill, /不是 agent 为完成其它任务安排的内部步骤/);
  assert.match(skill, /主要备选，包括维持现状或不做/);
  assert.match(skill, /失败、降级、恢复、迁移和回滚/);
  assert.match(skill, /不要为了完整而穷举细节/);
  assert.match(skill, /决定 \/ 关键取舍与假设 \/ 待验证 \/ 未解决/);
}

function assertTriggerCorpus(document, skillName) {
  const { cases } = document;
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, skillName);
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 20);
  assert.equal(cases.every((entry) => /^[a-z0-9][a-z0-9_]*$/.test(entry.id)), true);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 10);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 10);
  assert.equal(cases.filter((entry) => entry.should_load_skill).length, 10);
  assert.equal(cases.filter((entry) => !entry.should_load_skill).length, 10);
  assert.equal(
    cases.filter((entry) => entry.split === 'train' && entry.should_load_skill).length,
    5,
  );
  assert.equal(
    cases.filter((entry) => entry.split === 'validation' && entry.should_load_skill).length,
    5,
  );
  assert.equal(cases.every((entry) => entry.use_project_rules === true), true);
  assert.equal(
    cases.every((entry) => typeof entry.rationale === 'string' && entry.rationale.length > 0),
    true,
  );
}

function assertBehaviorCorpus(document, skillName, expectedIds) {
  assert.equal(document.skill_name, skillName);
  assert.deepEqual(document.evals.map((entry) => entry.id), expectedIds);

  for (const entry of document.evals) {
    assert.match(entry.prompt, new RegExp(`\\$${skillName}`));
    assert.equal(Array.isArray(entry.scripted_replies), true);
    assert.equal(typeof entry.expected_output, 'string');
    assert.equal(entry.expected_output.length > 0, true);
    assert.deepEqual(entry.files, []);
    assert.deepEqual(entry.review.platforms, ['codex', 'claude']);
    assert.equal(entry.review.clean_session, true);
    assert.equal(entry.review.workspace_unchanged, true);
    assert.equal(entry.review.checks.length >= 3, true);

    for (const reply of entry.scripted_replies) {
      if (reply.expected_question_count !== undefined) {
        assert.equal(Number.isInteger(reply.expected_question_count), true);
        assert.equal(reply.expected_question_count >= 0, true);
      }
      assert.equal(Array.isArray(reply.answers_by_index), true);
      assert.equal(reply.answers_by_index.every((answer) => typeof answer === 'string'), true);
      assert.equal(typeof reply.unexpected_question_answer, 'string');
      assert.equal(reply.unexpected_question_answer.length > 0, true);
    }
  }
}

const context = await resolveContext();

test('manifest declares two skills and the implementation requirements gate', async () => {
  const manifest = await readJson(
    path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'),
  );

  assert.equal(manifest.name, 'ask-me');
  assert.equal(manifest.version, pluginVersion);
  assert.equal(manifest.skills, './skills');
  assert.deepEqual(manifest.marketplace, {
    category: 'workflow',
    strict: true,
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
  });
  assert.equal('products' in manifest.marketplace.policy, false);
  assert.equal(manifest.interface.displayName, 'Ask Me');
  assert.deepEqual(manifest.interface.capabilities, ['Skills', 'Instructions']);
  assert.deepEqual(manifest.extensions, {
    instructions: [
      {
        name: 'quality-gate',
        title: '实施前需求检查',
        content: qualityGate,
      },
    ],
  });
  assert.equal(qualityGate.includes('decision-grill'), false);
  assert.deepEqual(manifest.buildConfig, {
    templates: {
      include: ['skills/**/*.md'],
      vars: {
        questionTool: {
          claude: '`AskUserQuestion`',
          codex: '`request_user_input`',
        },
      },
    },
  });
  assert.deepEqual(manifest.scripts.tests.node, ['./scripts/contract.test.mjs']);
  assert.equal('dependencies' in manifest, false);
  assert.equal('mcpServers' in manifest, false);
  assert.equal('apps' in manifest, false);
  assert.equal('slashCommands' in manifest, false);
  assert.equal('artifacts' in manifest, false);
});

test('source package contains only the two redesigned skills', async () => {
  const skillDirectories = (await readdir(path.join(context.sourceRoot, 'skills'))).sort();
  assert.deepEqual(skillDirectories, [...skillNames].sort());

  const [requirementsSkill, requirementsOpenAi, decisionSkill, decisionOpenAi] =
    await Promise.all([
      readFile(
        path.join(context.sourceRoot, 'skills', 'requirements-clarifier', 'SKILL.md'),
        'utf8',
      ),
      readFile(
        path.join(
          context.sourceRoot,
          'skills',
          'requirements-clarifier',
          'agents',
          'openai.yaml',
        ),
        'utf8',
      ),
      readFile(
        path.join(context.sourceRoot, 'skills', 'decision-grill', 'SKILL.md'),
        'utf8',
      ),
      readFile(
        path.join(
          context.sourceRoot,
          'skills',
          'decision-grill',
          'agents',
          'openai.yaml',
        ),
        'utf8',
      ),
    ]);

  assertRequirementsClarifierContract(requirementsSkill);
  assertDecisionGrillContract(decisionSkill);
  assertOpenAiMetadata(requirementsOpenAi, 'requirements-clarifier');
  assertOpenAiMetadata(decisionOpenAi, 'decision-grill');
});

test('trigger corpora preserve balanced adjacent-skill coverage and load project rules', async () => {
  const [requirements, decision] = await Promise.all([
    readJson(
      path.join(context.sourceRoot, 'evals', 'requirements-clarifier-trigger-cases.json'),
    ),
    readJson(path.join(context.sourceRoot, 'evals', 'decision-grill-trigger-cases.json')),
  ]);

  assertTriggerCorpus(requirements, 'requirements-clarifier');
  assertTriggerCorpus(decision, 'decision-grill');

  assert.equal(
    requirements.cases.find((entry) => entry.id === 'n05_decision_planning')
      .should_load_skill,
    false,
  );
  assert.equal(
    requirements.cases.find((entry) => entry.id === 'n02_existing_pattern')
      .workspace_fixture,
    'implementation_repo',
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n01_internal_plan')
      .should_load_skill,
    false,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n03_implementation_ambiguity')
      .should_load_skill,
    false,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n01_internal_plan')
      .workspace_fixture,
    'implementation_repo',
  );
});

test('trigger fixture provides the repository facts used by near-miss cases', async () => {
  assert.deepEqual([...TRIGGER_WORKSPACE_FIXTURES], ['default', 'implementation_repo']);
  const root = await mkdtemp(path.join(os.tmpdir(), 'ask-me-trigger-fixture-'));
  try {
    await setupTriggerWorkspace({
      workspaceRoot: root,
      evalCase: { workspace_fixture: 'implementation_repo' },
    });
    assert.match(
      await readFile(path.join(root, 'src', 'features', 'invoices', 'export.ts'), 'utf8'),
      /current-filter/,
    );
    assert.match(
      await readFile(path.join(root, 'spec', 'account-pause.md'), 'utf8'),
      /acceptance checks/,
    );
    assert.match(
      await readFile(path.join(root, 'tests', 'parser_test.py'), 'utf8'),
      /test_parse_trims_whitespace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('eval manifest delegates both skills to central trigger and conversation drivers', async () => {
  const manifest = await readJson(path.join(context.sourceRoot, 'evals', 'manifest.json'));

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.plugin, 'ask-me');
  assert.deepEqual(manifest.profiles, [
    {
      id: 'project-default',
      scope: 'project',
      config: {},
      runModel: true,
      requiredForRelease: true,
    },
    {
      id: 'user-default',
      scope: 'user',
      config: {},
      runModel: false,
      requiredForRelease: true,
    },
  ]);
  assert.deepEqual(
    manifest.suites.map((suite) => [suite.id, suite.kind, suite.skill]),
    [
      ['requirements-clarifier-trigger', 'trigger', 'requirements-clarifier'],
      ['decision-grill-trigger', 'trigger', 'decision-grill'],
      ['requirements-clarifier-behavior', 'conversation', 'requirements-clarifier'],
      ['decision-grill-behavior', 'conversation', 'decision-grill'],
    ],
  );

  for (const suite of manifest.suites) {
    assert.deepEqual(suite.profiles, ['project-default']);
    assert.equal(suite.requiredForRelease, true);
    assert.equal(suite.isolation, 'strict');
    if (suite.kind === 'trigger') {
      assert.equal(suite.defaultRuns, 3);
      assert.equal(suite.fixtureModule, './evals/trigger-fixture.mjs');
      assert.deepEqual(suite.releaseSplits, ['validation']);
      assert.deepEqual(suite.strictNegativeSplits, ['validation']);
    } else {
      assert.equal(suite.defaultRuns, 1);
      assert.deepEqual(suite.releaseSplits, []);
    }
  }
});

test('behavior corpora preserve all redesigned assertions in executable conversation shape', async () => {
  const [requirements, decision] = await Promise.all([
    readJson(path.join(context.sourceRoot, 'evals', 'requirements-clarifier-evals.json')),
    readJson(path.join(context.sourceRoot, 'evals', 'decision-grill-evals.json')),
  ]);

  assertBehaviorCorpus(requirements, 'requirements-clarifier', [
    'find-before-ask',
    'three-way-routing',
    'transparent-default',
    'combined-small-ambiguities',
    'dependent-frontier',
    'engineering-validation',
    'conflicting-requirements',
    'question-shape',
    'stop-with-no-gap',
    'handoff-on-stop',
  ]);
  assertBehaviorCorpus(decision, 'decision-grill', [
    'collaborative-plan-boundary',
    'read-before-question',
    'main-alternatives',
    'challenge-assumption',
    'decision-frontier',
    'reopen-existing-decision',
    'recommendation-calibration',
    'avoid-exhaustion',
    'decision-record',
    'user-defers-risk',
  ]);

  assert.equal(
    requirements.evals.find((entry) => entry.id === 'question-shape').scripted_replies.length,
    0,
  );
  assert.equal(
    decision.evals.find((entry) => entry.id === 'challenge-assumption')
      .scripted_replies.length,
    0,
  );

  const readme = await readFile(path.join(context.sourceRoot, 'evals', 'README.md'), 'utf8');
  assert.match(readme, /use_project_rules: true/);
  assert.match(readme, /requirements-clarifier-evals\.json/);
  assert.match(readme, /decision-grill-evals\.json/);
  assert.match(readme, /Claude.*不能把 Codex/s);
});

test('prepared bundle renders the platform question tool for both skills', async () => {
  if (!context.platform) {
    return;
  }

  const platformManifest = await readJson(
    path.join(context.bundleRoot, `.${context.platform}-plugin`, 'plugin.json'),
  );
  assert.equal(platformManifest.name, 'ask-me');
  assert.equal(platformManifest.skills, `./${context.platform}/skills`);

  const expectedTool = context.platform === 'codex'
    ? '`request_user_input`'
    : '`AskUserQuestion`';
  const otherTool = context.platform === 'codex'
    ? '`AskUserQuestion`'
    : '`request_user_input`';

  for (const skillName of skillNames) {
    const skillRoot = path.join(
      context.bundleRoot,
      context.platform,
      'skills',
      skillName,
    );
    const [skill, openaiYaml] = await Promise.all([
      readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
      readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
    ]);

    if (skillName === 'requirements-clarifier') {
      assertRequirementsClarifierContract(
        skill.replace(expectedTool, '{{questionTool}}'),
      );
    } else {
      assertDecisionGrillContract(skill.replace(expectedTool, '{{questionTool}}'));
    }
    assert.equal(skill.includes(expectedTool), true);
    assert.equal(skill.includes(`\`${expectedTool}\``), false);
    assert.equal(skill.includes(otherTool), false);
    assert.equal(skill.includes('{{questionTool}}'), false);
    assertOpenAiMetadata(openaiYaml, skillName);
  }

  await assert.rejects(
    readFile(
      path.join(context.bundleRoot, context.platform, 'skills', 'ask-me', 'SKILL.md'),
      'utf8',
    ),
    { code: 'ENOENT' },
  );
});
