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
const skillNames = ['requirements-clarifier', 'decision-grill'];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) {
    const manifest = await readJson(path.join(localPluginRoot, '.agents-plugin', 'plugin.json'));
    return {
      sourceRoot: localPluginRoot,
      bundleRoot: localPluginRoot,
      platform: null,
      pluginVersion: manifest.version,
    };
  }

  const context = await readJson(process.env.AW_PLUGIN_CONTEXT);
  const sourceManifest = await readJson(
    path.join(context.sourceRoot, '.agents-plugin', 'plugin.json'),
  );
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'ask-me');
  assert.equal(context.plugin.version, sourceManifest.version);
  assert.ok(['codex', 'claude'].includes(context.platform));
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
    pluginVersion: sourceManifest.version,
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
  assert.equal(cases.length, 25);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 25);
  assert.equal(cases.every((entry) => /^[a-z0-9][a-z0-9_]*$/.test(entry.id)), true);
  assert.equal(cases.filter((entry) => entry.split === 'train').length, 10);
  assert.equal(cases.filter((entry) => entry.split === 'validation').length, 10);
  assert.equal(cases.filter((entry) => entry.split === 'sanity').length, 5);
  assert.equal(
    cases.filter((entry) => entry.split === 'train' && entry.should_load_skill).length,
    5,
  );
  assert.equal(
    cases.filter((entry) => entry.split === 'validation' && entry.should_load_skill).length,
    5,
  );
  assert.equal(
    cases.filter((entry) => entry.split === 'sanity' && entry.should_load_skill).length,
    2,
  );
  assert.equal(
    cases.filter((entry) => entry.split === 'sanity' && !entry.should_load_skill).length,
    3,
  );
  assert.equal(
    cases.filter((entry) => entry.split !== 'sanity')
      .every((entry) => !entry.query.includes(`$${skillName}`)),
    true,
  );
  assert.equal(cases.every((entry) => typeof entry.use_project_rules === 'boolean'), true);
  cases.forEach((entry) => assertCaseAdmission(entry, 'trigger'));
}

function assertExactRoutingCorpus(document, skillName, expectedCounts) {
  const participants = new Set(['decision-grill', 'requirements-clarifier']);
  assertAuditPolicy(document);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.skill, skillName);
  assert.equal(document.cases.length, expectedCounts.total);
  assert.equal(new Set(document.cases.map((entry) => entry.id)).size, expectedCounts.total);
  assert.equal(
    document.cases.filter((entry) => entry.split === 'validation').length,
    expectedCounts.validation,
  );
  assert.equal(
    document.cases.filter((entry) => entry.split === 'sanity').length,
    expectedCounts.sanity,
  );
  for (const entry of document.cases) {
    assert.equal(['validation', 'sanity'].includes(entry.split), true);
    assert.equal(Array.isArray(entry.expected_loaded_skills), true);
    assert.equal(entry.expected_loaded_skills.every((skill) => participants.has(skill)), true);
    assert.equal(new Set(entry.expected_loaded_skills).size, entry.expected_loaded_skills.length);
    assert.equal('should_load_skill' in entry, false);
    assert.equal(entry.use_project_rules, true);
    assertCaseAdmission(entry, 'routing');
  }
}

function assertRoutingCorpus(document) {
  assertExactRoutingCorpus(document, 'decision-grill', {
    total: 14,
    validation: 8,
    sanity: 6,
  });
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
  assert.deepEqual(conventionOverride.expected_loaded_skills, ['requirements-clarifier']);
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'runner_explain').expected_loaded_skills,
    [],
  );
  assert.equal(
    document.cases.find((entry) => entry.id === 'export_clarify').workspace_fixture,
    'neutral_export_repo',
  );
  const fullSpec = document.cases.find((entry) => entry.id === 'full_spec');
  assert.equal(fullSpec.preconditions.current_task_is_read_only_review, true);
}

function assertRequirementsRoutingCorpus(document) {
  assertExactRoutingCorpus(document, 'requirements-clarifier', {
    total: 10,
    validation: 6,
    sanity: 4,
  });
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'implementation_clarify')
      .expected_loaded_skills,
    ['requirements-clarifier'],
  );
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'implementation_grill')
      .expected_loaded_skills,
    ['decision-grill'],
  );
  assert.deepEqual(
    document.cases.find((entry) => entry.id === 'fully_specified_helper')
      .expected_loaded_skills,
    [],
  );
  const existingConvention = document.cases.find(
    (entry) => entry.id === 'existing_convention',
  );
  assert.deepEqual(existingConvention.expected_loaded_skills, []);
  assert.equal(existingConvention.workspace_fixture, 'implementation_repo');
  assert.match(existingConvention.query, /exportInvoicesCsv.*exportOrdersCsv/);

  const missingExportFlow = document.cases.find(
    (entry) => entry.id === 'existing_policy_missing_flow',
  );
  assert.deepEqual(missingExportFlow.expected_loaded_skills, ['requirements-clarifier']);
  assert.equal(missingExportFlow.workspace_fixture, 'export_policy_only_repo');
  assert.equal(missingExportFlow.scenario_family, existingConvention.scenario_family);
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
    if (entry.workspace_files !== undefined) {
      assert.equal(typeof entry.workspace_files, 'object');
      assert.equal(Array.isArray(entry.workspace_files), false);
      assert.equal(Object.keys(entry.workspace_files).length > 0, true);
      assert.equal(
        Object.values(entry.workspace_files).every((content) =>
          typeof content === 'string' && content.length > 0),
        true,
      );
    }
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
  assert.equal(manifest.version, context.pluginVersion);
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
  assert.equal(manifest.extensions.instructions.length, 1);
  assert.equal(manifest.extensions.instructions[0].name, 'quality-gate');
  assert.equal(manifest.extensions.instructions[0].title, '实施前需求检查');
  assert.equal(typeof manifest.extensions.instructions[0].content, 'string');
  assert.equal(manifest.extensions.instructions[0].content.length > 0, true);
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

test('source package contains the declared Skill file structures', async () => {
  const skillDirectories = (await readdir(path.join(context.sourceRoot, 'skills'))).sort();
  assert.deepEqual(skillDirectories, [...skillNames].sort());

  for (const skillName of skillNames) {
    const skillRoot = path.join(context.sourceRoot, 'skills', skillName);
    const skillEntries = await readdir(skillRoot, { withFileTypes: true });
    assert.deepEqual(
      skillEntries
        .map((entry) => `${entry.name}:${entry.isDirectory() ? 'directory' : 'file'}`)
        .sort(),
      [
        'README.md:file',
        'SKILL.md:file',
        'agents:directory',
        'evals:directory',
      ],
    );
    assert.deepEqual(await readdir(path.join(skillRoot, 'agents')), ['openai.yaml']);
  }
});

test('trigger corpora preserve balanced single-Skill coverage and exact routing', async () => {
  const [requirements, decision, routing, requirementsRouting] = await Promise.all([
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
    readJson(path.join(
      context.sourceRoot,
      'skills',
      'requirements-clarifier',
      'evals',
      'requirements-clarifier-routing-cases.json',
    )),
  ]);

  assertTriggerCorpus(requirements, 'requirements-clarifier');
  assertTriggerCorpus(decision, 'decision-grill');
  assertRoutingCorpus(routing);
  assertRequirementsRoutingCorpus(requirementsRouting);

  assert.equal(
    requirements.cases.find((entry) => entry.id === 'p06_explicit_check').split,
    'sanity',
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'p10_explicit_skill_plan').split,
    'sanity',
  );

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
    decision.cases.find((entry) => entry.id === 'n09_implementation_ambiguity')
      .preconditions.iterative_interview_requested,
    false,
  );
  assert.equal(
    'companion_skill_available' in decision.cases.find(
      (entry) => entry.id === 'n09_implementation_ambiguity',
    ).preconditions,
    false,
  );
  assert.equal(
    requirements.cases.find((entry) => entry.id === 'p05_account_pause')
      .workspace_fixture,
    'account_pause_gap_repo',
  );
  assert.equal(
    decision.cases.find((entry) => entry.id === 'n08_agent_internal_planning')
      .workspace_fixture,
    'implementation_repo',
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
    'export_policy_only_repo',
    'implementation_repo',
    'account_pause_gap_repo',
    'account_pause_repo',
    'session_migration_repo',
  ]);
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), 'ask-me-neutral-export-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-policy-only-export-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-trigger-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-account-gap-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-account-fixture-')),
    mkdtemp(path.join(os.tmpdir(), 'ask-me-session-fixture-')),
  ]);
  const [neutralRoot, policyOnlyRoot, root, accountGapRoot, accountRoot, sessionRoot] = roots;
  try {
    await Promise.all([
      setupTriggerWorkspace({
        workspaceRoot: neutralRoot,
        evalCase: { workspace_fixture: 'neutral_export_repo' },
      }),
      setupTriggerWorkspace({
        workspaceRoot: policyOnlyRoot,
        evalCase: { workspace_fixture: 'export_policy_only_repo' },
      }),
      setupTriggerWorkspace({
        workspaceRoot: root,
        evalCase: { workspace_fixture: 'implementation_repo' },
      }),
      setupTriggerWorkspace({
        workspaceRoot: accountGapRoot,
        evalCase: { workspace_fixture: 'account_pause_gap_repo' },
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
      /current-filter[\s\S]*exportInvoicesCsv/,
    );
    const policyOnlyExport = await readFile(
      path.join(policyOnlyRoot, 'src', 'features', 'invoices', 'export.ts'),
      'utf8',
    );
    assert.match(policyOnlyExport, /invoiceExportPolicy/);
    assert.doesNotMatch(policyOnlyExport, /exportInvoicesCsv/);
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
      await readFile(path.join(accountGapRoot, 'docs', 'account-pause.md'), 'utf8'),
      /no approved specification/,
    );
    await assert.rejects(
      readFile(path.join(accountGapRoot, 'spec', 'account-pause.md'), 'utf8'),
      { code: 'ENOENT' },
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
      [
        ['trigger', 'trigger'],
        ['router', 'trigger'],
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
        assert.deepEqual(suite.releaseSplits, ['validation', 'sanity']);
        assert.deepEqual(suite.strictNegativeSplits, ['validation', 'sanity']);
      } else if (suite.id === 'router') {
        assert.equal(suite.defaultRuns, 10);
        assert.equal(suite.fixtureModule, './trigger-fixture.mjs');
        assert.equal(
          suite.cases,
          skill === 'decision-grill'
            ? './ask-me-routing-cases.json'
            : './requirements-clarifier-routing-cases.json',
        );
        assert.deepEqual(suite.releaseSplits, ['validation', 'sanity']);
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

test('behavior corpora preserve executable conversation shape', async () => {
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
  assert.deepEqual(
    (await readdir(path.join(context.bundleRoot, context.platform, 'skills'))).sort(),
    [...skillNames].sort(),
  );

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

    assert.match(skill, new RegExp(`^name: ${skillName}$`, 'm'));
    assert.equal(skill.includes(expectedTool), true);
    assert.equal(skill.includes(`\`${expectedTool}\``), false);
    assert.equal(skill.includes(otherTool), false);
    assert.equal(skill.includes('{{questionTool}}'), false);
    // Static contract exception: unresolved author placeholders can ship to users; behavior test is not suitable because placeholder absence is a deterministic artifact property.
    assert.equal(skill.includes('[TODO:'), false);
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
