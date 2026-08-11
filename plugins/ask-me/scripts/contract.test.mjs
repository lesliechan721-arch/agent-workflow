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
const qualityGate = '开始非平凡实现前，先依据当前对话和仓库检查需求。检查本身不要求加载 Skill；只有检查后仍存在多种合理理解，且选错会明显影响交付结果、功能范围或验收，或多项小歧义合起来会决定成品形态时，才使用 `requirements-clarifier`。\n\n能从现有上下文查明、有明确项目惯例、容易调整、只涉及内部实现或用户已授权采用默认值的事项不必追问；会影响用户预期的关键默认值应明确说明，不要静默假设。';
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
  assert.match(skill, /不要仅因非平凡实现需要 agent 自查而使用/);
  assert.match(skill, /权威规范和现有实现已覆盖行为、范围与验收/);
  assert.match(skill, /需要通过逐轮讨论共同制定或修订计划时使用 decision-grill/);
  assert.match(skill, /单项影响有限，但多项合在一起会决定功能形态时，也应先澄清/);
  assert.match(skill, /已确认 \/ 采用的关键默认 \/ 待验证或未解决/);
}

function assertDecisionGrillContract(skill) {
  assertSharedSkillContract(skill, 'decision-grill');
  assert.match(skill, /计划本身是当前任务的产物/);
  assert.match(skill, /不是 agent 为完成其它任务安排的内部步骤/);
  assert.match(skill, /只有当前任务需要用户参与形成、修改或定稿计划时才继续/);
  assert.match(skill, /若用户只是要说明、比较、估算、推荐或一次性评审/);
  assert.match(skill, /必须由用户决定的关键取舍/);
  assert.match(skill, /依赖和推进顺序/);
  assert.match(skill, /上线、迁移和回退方式/);
  assert.match(skill, /不要为了完整而穷举细节/);
  assert.match(skill, /目标与边界 \/ 已定取舍 \/ 待验证 \/ 未解决/);
  assert.match(skill, /明确委托必须写入最相关条目/);
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
    assert.equal(entry.prompt.includes(`$${skillName}`), false);
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
  assert.match(qualityGate, /检查本身不要求加载 Skill/);
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
    decision.cases.find((entry) => entry.id === 'n01_observed_runner_explanation')
      .should_load_skill,
    false,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n09_implementation_ambiguity')
      .should_load_skill,
    false,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n08_agent_internal_planning')
      .workspace_fixture,
    'implementation_repo',
  );
  assert.match(
    requirements.cases.find((entry) => entry.id === 'n07_internal_planning').query,
    /docs\/approved-migration\.md/,
  );
  assert.equal(
    requirements.cases.find((entry) => entry.id === 'n06_complete_spec')
      .workspace_fixture,
    'account_pause_repo',
  );
  assert.equal(
    requirements.cases.find((entry) => entry.id === 'n07_internal_planning')
      .workspace_fixture,
    'session_migration_repo',
  );
  assert.match(
    requirements.cases.find((entry) => entry.id === 'n10_easy_default').query,
    /formatDebugContext\(value\)/,
  );
  assert.match(
    decision.cases.find((entry) => entry.id === 'n01_observed_runner_explanation').query,
    /MCP\/CI runner.*实现难度/,
  );
  assert.match(
    decision.cases.find((entry) => entry.id === 'p04_runner_choice_to_plan').query,
    /关键取舍逐项问我.*形成落地计划/,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n02_solution_comparison')
      .should_load_skill,
    false,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n03_one_shot_plan_review')
      .should_load_skill,
    false,
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n05_direct_recommendation')
      .should_load_skill,
    false,
  );
});

test('trigger fixture provides the repository facts used by near-miss cases', async () => {
  assert.deepEqual([...TRIGGER_WORKSPACE_FIXTURES], [
    'default',
    'implementation_repo',
    'account_pause_repo',
    'session_migration_repo',
  ]);
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'ask-me-trigger-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-account-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-session-fixture-')),
  ]);
  const [root, accountRoot, sessionRoot] = roots;
  try {
    await Promise.all([
      setupTriggerWorkspace({
        workspaceRoot: root,
        evalCase: { workspace_fixture: 'implementation_repo' },
      }),
      setupTriggerWorkspace({
        workspaceRoot: accountRoot,
        evalCase: { workspace_fixture: 'account_pause_repo' },
      }),
      setupTriggerWorkspace({
        workspaceRoot: sessionRoot,
        evalCase: { workspace_fixture: 'session_migration_repo' },
      }),
    ]);
    assert.match(
      await readFile(path.join(root, 'src', 'features', 'invoices', 'export.ts'), 'utf8'),
      /current-filter/,
    );
    const accountPause = await readFile(
      path.join(root, 'spec', 'account-pause.md'),
      'utf8',
    );
    assert.match(accountPause, /account-paused/);
    assert.match(accountPause, /Pausing an already paused account/);
    assert.match(accountPause, /Existing behavior for active accounts remains unchanged/);

    const approvedMigration = await readFile(
      path.join(root, 'docs', 'approved-migration.md'),
      'utf8',
    );
    assert.match(approvedMigration, /Add a nullable `expires_at` column/);
    assert.match(approvedMigration, /## Rollback/);
    assert.match(approvedMigration, /## Acceptance/);

    const parserSource = await readFile(path.join(root, 'src', 'parser.py'), 'utf8');
    const parserTest = await readFile(path.join(root, 'tests', 'parser_test.py'), 'utf8');
    assert.match(parserSource, /return value/);
    assert.doesNotMatch(parserSource, /strip/);
    assert.match(parserTest, /test_parse_trims_whitespace/);
    assert.match(parserTest, /== 'value'/);

    assert.match(
      await readFile(path.join(accountRoot, 'src', 'accounts', 'pause-account.ts'), 'utf8'),
      /not implemented/,
    );
    assert.match(
      await readFile(path.join(accountRoot, 'src', 'auth', 'sign-in.ts'), 'utf8'),
      /ACCOUNT_PAUSED/,
    );
    assert.match(
      await readFile(path.join(sessionRoot, 'db', 'migrations', 'README.md'), 'utf8'),
      /forward-only/,
    );
    assert.match(
      await readFile(path.join(sessionRoot, 'src', 'sessions', 'repository.ts'), 'utf8'),
      /createSession/,
    );
  } finally {
    await Promise.all(roots.map((entry) => rm(entry, { recursive: true, force: true })));
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
    'known-fact-before-question',
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
    'goal-boundary',
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
  assert.equal(
    decision.evals.find((entry) => entry.id === 'main-alternatives')
      .scripted_replies.length,
    0,
  );
  assert.equal(
    decision.evals.find((entry) => entry.id === 'reopen-existing-decision')
      .scripted_replies[0].expected_question_count,
    1,
  );
  assert.equal(
    decision.evals.find((entry) => entry.id === 'avoid-exhaustion')
      .scripted_replies[0].expected_question_count,
    1,
  );
  assert.equal(
    requirements.evals.find((entry) => entry.id === 'combined-small-ambiguities')
      .scripted_replies[0].expected_question_count,
    3,
  );
  assert.match(
    requirements.evals.find((entry) => entry.id === 'question-shape').prompt,
    /外层实现工作流现在进入需求澄清阶段/,
  );
  assert.match(
    decision.evals.find((entry) => entry.id === 'decision-record').prompt,
    /外层协作规划工作流现在进入规划记录阶段/,
  );

  const readBeforeQuestion = decision.evals.find(
    (entry) => entry.id === 'read-before-question',
  );
  assert.match(readBeforeQuestion.prompt, /减少设计稿评审中的版本来回传递/);
  assert.match(readBeforeQuestion.prompt, /3–10 人的独立设计团队/);
  assert.match(readBeforeQuestion.prompt, /2027 年第一季度完成 12 周试点/);
  assert.match(readBeforeQuestion.prompt, /不要在本轮提问/);
  assert.equal(readBeforeQuestion.scripted_replies.length, 0);
  assert.match(readBeforeQuestion.review.checks.join('\n'), /具体路线图事实/);

  const decisionRecord = decision.evals.find((entry) => entry.id === 'decision-record');
  assert.match(decisionRecord.prompt, /产品负责人在本周五前确认数据驻留条款/);
  assert.match(
    decisionRecord.review.checks.join('\n'),
    /完整保留产品负责人在本周五前确认数据驻留条款的委托/,
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
