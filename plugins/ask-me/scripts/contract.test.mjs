import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const pluginVersion = '0.2.0';
const qualityGate = '开始非平凡实施前，先检查现有上下文。若仍有必须由用户决定、且会实质改变行为、接口或数据、兼容迁移、安全合规或验收的阻塞项，使用 `requirements-clarifier`；可查事实、可逆实现细节和已授权默认不阻塞。当前任务若是形成或压力测试计划、想法、方案或重大决策，使用 `decision-grill`。';
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
  assert.match(skill, /先只读检查/);
  assert.match(skill, /自行查明可发现|自行查明已经给出或能够发现/);
  assert.match(skill, /互相独立时每轮最多三题/);
  assert.match(skill, /适合单选时使用 \{\{questionTool\}\}/);
  assert.match(skill, /待验证/);
  assert.match(skill, /交还外层/);
  assert.equal(skill.includes('request_user_input'), false);
  assert.equal(skill.includes('AskUserQuestion'), false);
  assert.doesNotMatch(skill, /^user-invocable:\s*false$/m);
  assert.doesNotMatch(skill, /^disable-model-invocation:\s*true$/m);
}

function assertRequirementsClarifierContract(skill) {
  assertSharedSkillContract(skill, 'requirements-clarifier');
  assert.match(skill, /让具体任务可以安全继续，而不是重新设计它/);
  assert.match(skill, /决策属于用户，而非内部、可逆的实现选择/);
  assert.match(skill, /用户尚未决定或委托，也不存在安全默认值/);
  assert.match(skill, /当前任务若是在形成或挑战计划、想法或方案，改用 `decision-grill`/);
  assert.match(skill, /已确认 \/ 已委托 \/ 待验证 \/ 未解决/);
}

function assertDecisionGrillContract(skill) {
  assertSharedSkillContract(skill, 'decision-grill');
  assert.match(skill, /提高计划或决策的质量；先暴露重大分支，再收敛/);
  assert.match(skill, /主要替代方案，包括维持现状或不做/);
  assert.match(skill, /失败、降级、恢复、迁移与回滚/);
  assert.match(skill, /不追求穷举/);
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

test('manifest declares two automatic skills and the global quality gate', async () => {
  const manifest = await readJson(
    path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'),
  );

  assert.equal(manifest.name, 'ask-me');
  assert.equal(manifest.version, pluginVersion);
  assert.equal(manifest.skills, './skills');
  assert.deepEqual(manifest.skillTriggers, {
    'requirements-clarifier': {
      defaultTrigger: 'auto',
      allowDynamicTrigger: true,
    },
    'decision-grill': {
      defaultTrigger: 'auto',
      allowDynamicTrigger: true,
    },
  });
  assert.deepEqual(manifest.marketplace, {
    category: 'workflow',
    strict: true,
    policy: {
      installation: 'AVAILABLE',
      authentication: 'NONE',
    },
  });
  assert.equal('products' in manifest.marketplace.policy, false);
  assert.equal(manifest.interface.displayName, 'Ask Me');
  assert.deepEqual(manifest.interface.capabilities, ['Skills', 'Instructions']);
  assert.deepEqual(manifest.extensions, {
    instructions: [
      {
        name: 'quality-gate',
        title: '需求与决策质量门禁',
        content: qualityGate,
      },
    ],
  });
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
    requirements.cases.find((entry) => entry.id === 'n05_plan_scene').should_load_skill,
    false,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n01_implementation_blocker')
      .should_load_skill,
    false,
  );
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
      triggerPreference: 'default',
      runModel: true,
      requiredForRelease: true,
    },
    {
      id: 'user-default',
      scope: 'user',
      config: {},
      triggerPreference: 'default',
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
    if (suite.kind === 'trigger') {
      assert.equal(suite.defaultRuns, 3);
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
    'discover-before-ask',
    'delegated-defaults',
    'dependent-frontier',
    'engineering-validation',
    'conflict',
    'explicit-no-gap',
    'partial-answer',
    'no-side-effects',
    'handoff',
  ]);
  assertBehaviorCorpus(decision, 'decision-grill', [
    'frame-without-redundancy',
    'alternatives',
    'challenge-assumption',
    'decision-frontier',
    'recommendation-calibration',
    'avoid-exhaustion',
    'user-stops',
    'decision-brief',
    'reuse-upstream-ledger',
    'no-side-effects',
  ]);

  assert.equal(
    requirements.evals.find((entry) => entry.id === 'partial-answer').scripted_replies.length,
    2,
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
