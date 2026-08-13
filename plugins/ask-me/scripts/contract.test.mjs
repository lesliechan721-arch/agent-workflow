import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  setupTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from './trigger-fixture.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');
const pluginVersion = '0.1.0';
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
  const displayName = yamlQuotedValue(openaiYaml, 'display_name');
  const shortDescription = yamlQuotedValue(openaiYaml, 'short_description');
  const defaultPrompt = yamlQuotedValue(openaiYaml, 'default_prompt');
  const shortDescriptionLength = Array.from(shortDescription).length;

  assert.equal(displayName, skillName === 'decision-grill'
    ? 'Decision Grill'
    : 'Requirements Clarifier');
  assert.match(displayName, /^[\x20-\x7E]+$/);
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
  assert.match(skill, /只给宽泛目标不等于授权 agent 决定这些事项/);
  assert.match(skill, /已有或已批准计划.*实施阶段仍有此类局部缺口.*使用本 Skill/);
  assert.match(skill, /用户明确授权采用默认值/);
  assert.match(skill, /明确希望通过逐轮访谈.*使用 decision-grill/);
  assert.match(skill, /用最少问题补齐足够实施的需求边界/);
  assert.match(skill, /单项影响有限，但多项合在一起会决定功能形态时，也应先澄清/);
  assert.match(skill, /已确认 \/ 采用的关键默认 \/ 待验证或未解决/);
}

function assertDecisionGrillContract(skill) {
  assertSharedSkillContract(skill, 'decision-grill');
  assert.match(skill, /计划、决策或想法进行逐轮访谈/);
  assert.match(skill, /产物是经过讨论的共享理解/);
  assert.match(skill, /不是 agent 为完成其它任务安排的内部计划/);
  assert.match(skill, /用户需要通过逐轮访谈/);
  assert.match(skill, /实现具体结果或执行已有计划时.*局部歧义，使用 requirements-clarifier/);
  assert.match(skill, /用户或外层工作流要求.*逐轮推演.*仍使用本 Skill/);
  assert.match(skill, /一次性说明、比较、评估、推荐或评审应直接回答/);
  assert.match(skill, /只需补齐局部需求歧义，使用 `requirements-clarifier`/);
  assert.match(skill, /明确要求围绕该决定进行逐轮访谈时.*覆盖实施语境/);
  assert.match(skill, /建立决策树/);
  assert.match(skill, /事实由 agent 查明/);
  assert.match(skill, /不要替用户作出仍属于用户的决定/);
  assert.match(skill, /收到回答后重新计算当前前沿/);
  assert.match(skill, /不要为了完整而穷举低影响细节/);
  assert.match(skill, /主题与边界 \/ 已定决定 \/ 明确委托 \/ 待验证 \/ 延后及风险 \/ 未解决/);
  assert.match(skill, /请用户确认记录是否准确反映共享理解/);
  assert.match(skill, /逐项给出决定不等于确认最终记录/);
  assert.match(skill, /确认前不修改文件、不做原型/);
}

function assertAuditPolicy(document) {
  assert.equal(['recall-first', 'precision-first', 'balanced', 'critical']
    .includes(document.policy.optimization), true);
  assert.equal(['low', 'medium', 'high', 'critical']
    .includes(document.policy.false_negative_cost), true);
  assert.equal(['low', 'medium', 'high', 'critical']
    .includes(document.policy.false_positive_cost), true);
  assert.equal(typeof document.policy.rationale, 'string');
  assert.equal(document.policy.rationale.length > 0, true);
}

function assertCaseAdmission(entry, evalType) {
  assert.equal(entry.eval_type, evalType);
  assert.equal(['representative', 'regression', 'boundary', 'challenge', 'diagnostic']
    .includes(entry.case_role), true);
  assert.equal([
    'observed',
    'derived',
    'representative-synthetic',
    'boundary',
    'challenge',
    'mechanism-probe',
  ].includes(entry.provenance), true);
  assert.equal(typeof entry.scenario_family, 'string');
  assert.equal(entry.scenario_family.length > 0, true);
  assert.equal(typeof entry.unit_under_test, 'string');
  assert.equal(entry.unit_under_test.length > 0, true);
  assert.equal(typeof entry.preconditions, 'object');
  assert.equal(Array.isArray(entry.preconditions), false);
  assert.equal(typeof entry.oracle.rationale, 'string');
  assert.equal(entry.oracle.rationale.length > 0, true);
  assert.equal(entry.oracle.rule_refs.length > 0, true);
  assert.equal(['high', 'medium', 'low'].includes(entry.oracle.confidence), true);
  assert.equal(typeof entry.oracle.allowed_variance, 'string');
  assert.equal(entry.oracle.allowed_variance.length > 0, true);
  if (entry.case_role === 'boundary' || entry.case_role === 'regression') {
    assert.equal(typeof entry.oracle.minimal_counterexample, 'string');
    assert.equal(entry.oracle.minimal_counterexample.length > 0, true);
  }
}

function assertTriggerCorpus(document, skillName) {
  const { cases } = document;
  assertAuditPolicy(document);
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
  assert.equal(cases.every((entry) => typeof entry.use_project_rules === 'boolean'), true);
  cases.forEach((entry) => assertCaseAdmission(entry, 'trigger'));
}

function assertRoutingCorpus(document) {
  const participants = new Set(['decision-grill', 'requirements-clarifier']);
  assertAuditPolicy(document);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, 'decision-grill');
  assert.equal(document.cases.length, 14);
  assert.equal(new Set(document.cases.map((entry) => entry.id)).size, 14);
  assert.equal(document.cases.filter((entry) => entry.split === 'validation').length, 8);
  assert.equal(document.cases.filter((entry) => entry.split === 'sanity').length, 6);
  for (const entry of document.cases) {
    assert.equal(['validation', 'sanity'].includes(entry.split), true);
    assert.equal(Array.isArray(entry.expected_loaded_skills), true);
    assert.equal(entry.expected_loaded_skills.every((skill) => participants.has(skill)), true);
    assert.equal(new Set(entry.expected_loaded_skills).size, entry.expected_loaded_skills.length);
    assert.equal('should_load_skill' in entry, false);
    assert.equal(entry.use_project_rules, true);
    assertCaseAdmission(entry, 'routing');
  }
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'export_clarify').expected_loaded_skills,
    ['requirements-clarifier'],
  );
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'export_grill').expected_loaded_skills,
    ['decision-grill'],
  );
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'approved_plan_implementation_gap')
      .expected_loaded_skills,
    ['requirements-clarifier'],
  );
  const conventionOverride = document.cases.find(
    (entry) => entry.id === 'export_override_convention',
  );
  assert.match(conventionOverride.query, /现在开始实现订单导出/);
  assert.doesNotMatch(conventionOverride.query, /先实现其它部分/);
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'runner_explain').expected_loaded_skills,
    [],
  );
  assert.equal(
    document.cases.find((entry) => entry.id === 'export_clarify').workspace_fixture,
    'neutral_export_repo',
  );
}

function assertBehaviorCorpus(document, skillName, expectedIds, expectedRole) {
  assertAuditPolicy(document);
  assert.equal(document.skill_name, skillName);
  assert.deepEqual(document.evals.map((entry) => entry.id), expectedIds);

  for (const entry of document.evals) {
    assertCaseAdmission(entry, 'behavior');
    assert.equal(entry.case_role, expectedRole);
    assert.equal(entry.prompt.includes(`$${skillName}`), false);
    assert.equal(Array.isArray(entry.scripted_replies), true);
    assert.equal(typeof entry.expected_output, 'string');
    assert.equal(entry.expected_output.length > 0, true);
    assert.deepEqual(entry.files, []);
    assert.equal(entry.review.platforms.includes('codex'), true);
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

test('trigger corpora preserve balanced single-Skill coverage and exact routing', async () => {
  const [requirements, decision, routing] = await Promise.all([
    readJson(
      path.join(
        context.sourceRoot,
        'skills',
        'requirements-clarifier',
        'evals',
        'requirements-clarifier-trigger-cases.json',
      ),
    ),
    readJson(path.join(
      context.sourceRoot,
      'skills',
      'decision-grill',
      'evals',
      'decision-grill-trigger-cases.json',
    )),
    readJson(path.join(
      context.sourceRoot,
      'skills',
      'decision-grill',
      'evals',
      'ask-me-routing-cases.json',
    )),
  ]);

  assertTriggerCorpus(requirements, 'requirements-clarifier');
  assertTriggerCorpus(decision, 'decision-grill');
  assertRoutingCorpus(routing);

  assert.equal(
    requirements.cases.find((entry) => entry.id === 'n05_decision_planning')
      .should_load_skill,
    false,
  );
  assert.equal(
    requirements.cases.find((entry) => entry.id === 'n05_decision_planning')
      .use_project_rules,
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
    decision.cases.find((entry) => entry.id === 'n09_implementation_ambiguity')
      .workspace_fixture,
    'neutral_export_repo',
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n09_implementation_ambiguity')
      .use_project_rules,
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
    'neutral_export_repo',
    'implementation_repo',
    'account_pause_repo',
    'session_migration_repo',
  ]);
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'ask-me-neutral-export-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-trigger-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-account-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-session-fixture-')),
  ]);
  const [neutralRoot, root, accountRoot, sessionRoot] = roots;
  try {
    await Promise.all([
      setupTriggerWorkspace({
        workspaceRoot: neutralRoot,
        evalCase: { workspace_fixture: 'neutral_export_repo' },
      }),
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
      await readFile(path.join(neutralRoot, 'docs', 'order-export.md'), 'utf8'),
      /no approved export range convention/,
    );
    await assert.rejects(
      readFile(
        path.join(neutralRoot, 'src', 'features', 'invoices', 'export.ts'),
        'utf8',
      ),
      { code: 'ENOENT' },
    );
    assert.match(
      await readFile(path.join(root, 'src', 'features', 'invoices', 'export.ts'), 'utf8'),
      /current-filter/,
    );
    assert.match(
      await readFile(path.join(root, 'src', 'features', 'orders', 'list.ts'), 'utf8'),
      /customer[\s\S]*amount[\s\S]*created_at/,
    );
    assert.match(
      await readFile(path.join(root, 'src', 'features', 'settings', 'page.ts'), 'utf8'),
      /settingsPrimaryButtonColor = 'gray'/,
    );
    assert.match(
      await readFile(path.join(root, 'src', 'styles', 'button-colors.ts'), 'utf8'),
      /primaryButtonBlue = '#2563eb'/,
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

test('each Skill owns an independent central eval manifest', async () => {
  for (const skill of skillNames) {
    const manifest = await readJson(
      path.join(context.sourceRoot, 'skills', skill, 'evals', 'manifest.json'),
    );
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.plugin, 'ask-me');
    assert.equal(manifest.skill, skill);
    assert.deepEqual(manifest.profiles, [
    {
      id: 'project-default',
      scope: 'project',
      plugins: [{ name: 'ask-me', config: {} }],
      runModel: true,
      requiredForRelease: true,
    },
    {
      id: 'user-default',
      scope: 'user',
      plugins: [{ name: 'ask-me', config: {} }],
      runModel: false,
      requiredForRelease: true,
    },
    ]);
    assert.deepEqual(
      manifest.suites.map((suite) => [suite.id, suite.kind]),
      skill === 'decision-grill'
        ? [
            ['trigger', 'trigger'],
            ['router', 'trigger'],
            ['behavior', 'conversation'],
            ['behavior-diagnostic', 'conversation'],
          ]
        : [
            ['trigger', 'trigger'],
            ['behavior', 'conversation'],
            ['behavior-diagnostic', 'conversation'],
          ],
    );

    for (const suite of manifest.suites) {
      if (suite.id === 'trigger') {
        assert.deepEqual(suite.skills, [skill]);
      } else {
        assert.deepEqual(
          suite.skills,
          skill === 'decision-grill'
            ? ['decision-grill', 'requirements-clarifier']
            : ['requirements-clarifier', 'decision-grill'],
        );
      }
      assert.deepEqual(suite.profiles, ['project-default']);
      assert.equal(suite.requiredForRelease, suite.id !== 'behavior-diagnostic');
      assert.equal(suite.isolation, 'strict');
      if (suite.id === 'trigger') {
        assert.equal(suite.defaultRuns, 3);
        assert.equal(suite.fixtureModule, './trigger-fixture.mjs');
        assert.deepEqual(suite.releaseSplits, ['validation']);
        assert.deepEqual(suite.strictNegativeSplits, ['validation']);
      } else if (suite.id === 'router') {
        assert.equal(suite.defaultRuns, 10);
        assert.equal(suite.fixtureModule, './trigger-fixture.mjs');
        assert.deepEqual(suite.releaseSplits, ['validation']);
        assert.deepEqual(suite.strictNegativeSplits, []);
        assert.equal(suite.minimumPassRate, 0.9);
        assert.equal(suite.forbidMultipleSkillLoads, true);
      } else {
        assert.equal(suite.defaultRuns, 1);
        assert.deepEqual(suite.releaseSplits, []);
        assert.equal(
          suite.cases,
          suite.id === 'behavior'
            ? `./${skill}-release-evals.json`
            : `./${skill}-evals.json`,
        );
      }
    }
  }
});

test('behavior corpora preserve all redesigned assertions in executable conversation shape', async () => {
  const [requirements, requirementsRelease, decision, decisionRelease] = await Promise.all([
    readJson(path.join(
      context.sourceRoot,
      'skills',
      'requirements-clarifier',
      'evals',
      'requirements-clarifier-evals.json',
    )),
    readJson(path.join(
      context.sourceRoot,
      'skills',
      'requirements-clarifier',
      'evals',
      'requirements-clarifier-release-evals.json',
    )),
    readJson(path.join(
      context.sourceRoot,
      'skills',
      'decision-grill',
      'evals',
      'decision-grill-evals.json',
    )),
    readJson(path.join(
      context.sourceRoot,
      'skills',
      'decision-grill',
      'evals',
      'decision-grill-release-evals.json',
    )),
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
  ], 'diagnostic');
  assertBehaviorCorpus(requirementsRelease, 'requirements-clarifier', [
    'natural-mixed-ambiguity',
    'natural-combined-ambiguities',
    'natural-engineering-evidence',
  ], 'representative');
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
    'low-prompt-frontier',
    'silent-assumption-audit',
    'user-decision-not-self-answer',
    'shared-understanding-confirmation',
    'reopen-on-correction',
  ], 'diagnostic');
  assertBehaviorCorpus(decisionRelease, 'decision-grill', [
    'natural-access-frontier',
    'natural-owner-choice',
    'natural-deferred-risk',
  ], 'representative');

  for (const entry of [...requirementsRelease.evals, ...decisionRelease.evals]) {
    assert.doesNotMatch(entry.prompt, /使用问题工具|只询问|第一轮请|收到回答后/);
    assert.deepEqual(
      {
        current_owner_skill_available:
          entry.preconditions.current_owner_skill_available,
        baseline_owner_skill_available:
          entry.preconditions.baseline_owner_skill_available,
        companion_skill_available_in_both:
          entry.preconditions.companion_skill_available_in_both,
        baseline_kind: entry.preconditions.baseline_kind,
      },
      {
        current_owner_skill_available: true,
        baseline_owner_skill_available: false,
        companion_skill_available_in_both: true,
        baseline_kind: 'without-owner-skill',
      },
    );
  }
  assert.match(
    decisionRelease.evals.find((entry) => entry.id === 'natural-access-frontier').prompt,
    /面向谁会决定.*项目.*访问范围又会影响权限和计费/,
  );
  assert.match(
    requirementsRelease.evals.find(
      (entry) => entry.id === 'natural-combined-ambiguities',
    ).prompt,
    /三项可以分别选择.*不限制另外两项/,
  );

  assert.equal(
    requirements.evals.find((entry) => entry.id === 'question-shape').scripted_replies.length,
    0,
  );
  const transparentDefault = requirements.evals.find(
    (entry) => entry.id === 'transparent-default',
  );
  assert.match(transparentDefault.prompt, /除空状态样式外/);
  assert.match(transparentDefault.prompt, /数据对象与范围.*验收都已明确/);
  assert.equal(transparentDefault.scripted_replies.length, 0);
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
    /外层协作决策访谈现在进入决策记录阶段/,
  );

  assert.equal(
    decision.evals.find((entry) => entry.id === 'low-prompt-frontier')
      .scripted_replies.length,
    2,
  );
  assert.match(
    decision.evals.find((entry) => entry.id === 'low-prompt-frontier').prompt,
    /内部成员、受邀外部合作伙伴或公开访客.*仅受邀项目、同组织跨项目或公开访问/,
  );
  assert.equal(
    decision.evals.find((entry) => entry.id === 'shared-understanding-confirmation')
      .scripted_replies[0].expected_question_count,
    1,
  );
  assert.equal(
    decision.evals.find((entry) => entry.id === 'reopen-on-correction')
      .scripted_replies.length,
    2,
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

  const readme = (await Promise.all(skillNames.map((skill) => readFile(
    path.join(context.sourceRoot, 'skills', skill, 'evals', 'README.md'),
    'utf8',
  )))).join('\n');
  assert.match(readme, /use_project_rules: true/);
  assert.match(readme, /requirements-clarifier-evals\.json/);
  assert.match(readme, /requirements-clarifier-release-evals\.json/);
  assert.match(readme, /decision-grill-evals\.json/);
  assert.match(readme, /decision-grill-release-evals\.json/);
  assert.match(readme, /behavior-diagnostic/);
  assert.doesNotMatch(
    readme,
    /(Full Access|allow-unmanaged-processes|后代进程|完整批次|review:publish|Claude.*不能把 Codex)/s,
  );
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
        skill.replaceAll(expectedTool, '{{questionTool}}'),
      );
    } else {
      assertDecisionGrillContract(skill.replaceAll(expectedTool, '{{questionTool}}'));
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
