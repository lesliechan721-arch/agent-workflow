import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  gradeContextRoleWorkflow,
  prepareContextRoleWorkflow,
} from '../skills/dev-build/evals/context-role-workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skills = ['dev-workflow', 'dev-design', 'dev-spec', 'dev-review-spec', 'dev-build', 'dev-repair', 'dev-breakdown', 'dev-implement', 'dev-review-code'];
const decisionSkills = ['decision-shape', 'decision-grill', 'decision-prototype', 'project-context'];
const localWorkspaceSkills = ['dev-design', 'dev-build'];
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
    } else if (document.suite.kind === 'conversation') {
      assert.equal(typeof entry.prompt, 'string');
      assert.equal(entry.prompt.trim().length > 0, true);
      assert.equal(Array.isArray(entry.assertions), true);
      assert.equal(entry.assertions.length > 0, true);
      assert.equal(entry.assertions.every((assertion) => (
        typeof assertion === 'string' && assertion.trim().length > 0
      )), true);
    } else if (document.suite.kind === 'codex-workflow') {
      assert.equal(entry.input && typeof entry.input === 'object', true);
      assert.equal(entry.expected !== undefined || entry.assertions !== undefined, true);
    }
  }
  return entries;
}

const target = await context();

test('manifest exposes local Skills and declares the decision-kit dependency', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'dev-workflow');
  assert.deepEqual(manifest.dependencies, ['decision-kit']);
  assert.equal(manifest.skills, './skills');
  assert.deepEqual(manifest.interface.capabilities, ['Skills']);
  for (const key of ['slashCommands', 'extensions', 'config', 'artifacts', 'lifecycle']) {
    assert.equal(key in manifest, false);
  }
  assert.deepEqual(manifest.buildConfig, {
    skillRuntimeFiles: localWorkspaceSkills.map((skill) => ({
      skill,
      target: 'references/local-workspace.md',
      source: './references/local-workspace.md',
    })),
  });
  await access(path.join(target.source, 'references', 'local-workspace.md'));
});

test('source exposes nine directly usable Skills', async () => {
  assert.deepEqual((await readdir(path.join(target.source, 'skills'))).sort(), [...skills].sort());
  for (const name of skills) {
    const skillRoot = path.join(target.source, 'skills', name);
    const skill = await read(path.join(skillRoot, 'SKILL.md'));
    assertSkill(skill, name);
    if (name === 'dev-workflow') {
      // Static contract exception: users must explicitly invoke the published Skill; runtime routing alone cannot verify both platform metadata fields.
      assert.match(skill, /^user-invocable: true$/m);
      assert.match(skill, /^disable-model-invocation: true$/m);
    }
    await read(path.join(skillRoot, 'README.md'));
    const metadata = await read(path.join(skillRoot, 'agents', 'openai.yaml'));
    assert.match(metadata, new RegExp(`\\$${name}`));
    assert.match(metadata, new RegExp(`^policy:\\n  allow_implicit_invocation: ${name === 'dev-workflow' ? 'false' : 'true'}$`, 'm'));
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

test('Eval manifests expose parseable suites and registered workflow adapters', async () => {
  for (const name of skills) {
    const evalRoot = path.join(target.source, 'skills', name, 'evals');
    const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
    for (const suite of manifest.suites) {
      const casesPath = path.resolve(evalRoot, suite.cases);
      await access(casesPath);
      assertCaseDocument(await readJson(casesPath));
      if (suite.kind === 'codex-workflow') {
        assert.equal(suite.provider?.type, 'codex-workflow');
        assert.equal(suite.provider.command[0], 'node');
        assert.equal(Array.isArray(suite.provider.allowedModels), true);
        await access(path.resolve(evalRoot, suite.provider.command[1]));
      }
    }
  }
  const manifest = await readJson(path.join(target.source, 'skills', 'dev-build', 'evals', 'manifest.json'));
  assert.deepEqual(
    manifest.suites.filter((suite) => suite.kind === 'codex-workflow').map((suite) => suite.id),
    ['context-role-workflow', 'generated-ticket-handoff', 'execution-milestone', 'alignment-execution', 'workflow-defaults'],
  );
});

function workflowEvidence(overrides = {}) {
  const evidence = {
    version: 1,
    rootThreadId: 'root',
    completion: { status: 'completed' },
    termination: {
      reason: 'completed',
      appServerProcessTreeCleanupConfirmed: true,
    },
    cleanup: { isolatedCodexHomeRemoved: true },
    workspaceDiff: { added: [], modified: [], removed: [] },
    skillLoads: [],
    threadGraph: [{ threadId: 'root', parentThreadId: null }],
    collaborationCalls: [],
    ...overrides,
  };
  evidence.collaborationCalls.forEach((call, index) => {
    call.ordinal = index + 1;
  });
  return evidence;
}

async function workflowFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dev-workflow-context-role-'));
  const paths = {
    workspace: path.join(root, 'workspace', 'subject'),
    fixtures: path.join(root, 'workspace', 'eval'),
    output: path.join(root, 'output'),
    evidence: path.join(root, 'output', 'workflow-evidence.json'),
    modelOutput: path.join(root, 'output', 'model-output.txt'),
  };
  await Promise.all([
    mkdir(paths.workspace, { recursive: true }),
    mkdir(paths.fixtures, { recursive: true }),
    mkdir(paths.output, { recursive: true }),
  ]);
  return { root, paths };
}

async function writeWorkflowResult(paths, evidence, output = '') {
  await Promise.all([
    writeFile(paths.evidence, JSON.stringify(evidence)),
    writeFile(paths.modelOutput, output),
  ]);
}

function spawnCall(role, threadId) {
  return {
    threadId: 'root',
    linkedThreadId: threadId,
    tool: 'spawn_agent',
    arguments: { agent_type: role, fork_turns: 'none' },
  };
}

test('context-role adapter prepares every case without selecting or starting a model', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-build', 'evals');
  const documents = await Promise.all([
    readJson(path.join(evalRoot, 'context-role-workflow.cases.json')),
    readJson(path.join(evalRoot, 'generated-ticket-handoff.cases.json')),
  ]);
  for (const evalCase of documents.flatMap((document) => document.cases)) {
    const fixture = await workflowFixture();
    try {
      const prepared = await prepareContextRoleWorkflow({ case: evalCase, paths: fixture.paths });
      assert.equal(prepared.sandbox, 'workspace-write');
      assert.equal(prepared.model, null);
      assert.deepEqual(prepared.multiAgent, {
        protocol: 'v2',
        maxDepth: 2,
        hideSpawnAgentMetadata: true,
        exposeSpawnAgentModelOverrides: true,
      });
      assert.equal(prepared.roles.length > 0, true);
      for (const role of prepared.roles) {
        assert.equal(path.isAbsolute(role.configFile), false);
        await access(path.join(fixture.paths.workspace, role.configFile));
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('context-role adapter CLI accepts only the Engine attempt layout', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-build', 'evals');
  const adapter = path.join(evalRoot, 'context-role-workflow.mjs');
  const document = await readJson(path.join(evalRoot, 'context-role-workflow.cases.json'));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dev-workflow-adapter-cli-')));
  const paths = {
    workspace: path.join(root, 'workspace', 'subject'),
    fixtures: path.join(root, 'workspace', 'eval'),
    output: path.join(root, 'output'),
  };
  try {
    await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })));
    const input = {
      version: 1,
      phase: 'prepare',
      variant: 'current',
      attempt: 1,
      case: document.cases[0],
      paths,
    };
    const result = spawnSync(process.execPath, [adapter], {
      cwd: root,
      input: JSON.stringify(input),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).multiAgent.protocol, 'v2');

    input.paths = { ...paths, output: paths.workspace };
    const rejected = spawnSync(process.execPath, [adapter], {
      cwd: root,
      input: JSON.stringify(input),
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /paths\.output must be/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('context-role grader rejects redundant delegation by an already independent reviewer', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-build', 'evals');
  const document = await readJson(path.join(evalRoot, 'context-role-workflow.cases.json'));
  const evalCase = document.cases.find((entry) => entry.id === 'real-spec-clean-context-direct');
  assert.ok(evalCase);
  const fixture = await workflowFixture();
  try {
    await prepareContextRoleWorkflow({ case: evalCase, paths: fixture.paths });
    const direct = workflowEvidence({
      skillLoads: [{ threadId: 'root', skill: 'dev-review-spec' }],
    });
    await writeWorkflowResult(fixture.paths, direct, 'now == expiresAt 与 now > expiresAt 的边界要求冲突。');
    const passing = await gradeContextRoleWorkflow({
      case: evalCase,
      variant: 'current',
      paths: fixture.paths,
    });
    assert.equal(passing.passed, false);
    assert.equal(passing.details.complete, false, 'Topology alone does not prove an independent judgment.');
    assert.equal(passing.details.assertions.find((entry) => entry.name === 'no_delegation').passed, true);

    direct.threadGraph.push({
      threadId: 'nested-reviewer',
      parentThreadId: 'root',
      agentRole: 'spec-reviewer',
    });
    direct.collaborationCalls.push(spawnCall('spec-reviewer', 'nested-reviewer'));
    direct.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });
    await writeWorkflowResult(fixture.paths, direct, 'now == expiresAt 与 now > expiresAt 的边界要求冲突。');
    const redundant = await gradeContextRoleWorkflow({
      case: evalCase,
      variant: 'current',
      paths: fixture.paths,
    });
    assert.equal(redundant.passed, false);
    assert.equal(
      redundant.details.assertions.find((entry) => entry.name === 'no_delegation').passed,
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('context-role grader requires leaf reviewer topology and real target reads', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-build', 'evals');
  const document = await readJson(path.join(evalRoot, 'context-role-workflow.cases.json'));
  const evalCase = document.cases.find((entry) => entry.id === 'real-author-to-spec-reviewer-leaf');
  assert.ok(evalCase);
  const fixture = await workflowFixture();
  try {
    await prepareContextRoleWorkflow({ case: evalCase, paths: fixture.paths });
    await writeFile(path.join(fixture.paths.workspace, 'spec.md'), '# Spec\n');
    const evidence = workflowEvidence({
      workspaceDiff: { added: ['spec.md'], modified: [], removed: [] },
      skillLoads: [{ threadId: 'reviewer', skill: 'dev-review-spec' }],
      threadGraph: [
        { threadId: 'root', parentThreadId: null },
        { threadId: 'reviewer', parentThreadId: 'root', agentRole: 'spec-reviewer' },
      ],
      collaborationCalls: [
        {
          threadId: 'root',
          tool: 'apply_patch',
          arguments: { patch: '*** Begin Patch\n*** Add File: spec.md\n+# Spec\n*** End Patch' },
          status: 'completed',
        },
        spawnCall('spec-reviewer', 'reviewer'),
        {
          threadId: 'reviewer',
          tool: 'exec_command',
          arguments: { cmd: "sed -n '1,120p' spec.md" },
          output: { exitCode: 0 },
          status: 'completed',
        },
      ],
    });
    await writeWorkflowResult(fixture.paths, evidence, '审查完成。');
    const passing = await gradeContextRoleWorkflow({
      case: evalCase,
      variant: 'current',
      paths: fixture.paths,
    });
    assert.equal(passing.passed, false);
    assert.equal(passing.details.complete, false, 'A path in tool arguments is not a complete source-read proof.');
    assert.equal(passing.details.assertions.find((entry) => entry.name === 'spec-reviewer:no_nested').passed, true);

    evidence.threadGraph.push({
      threadId: 'grandchild',
      parentThreadId: 'reviewer',
      agentRole: 'spec-reviewer',
    });
    evidence.collaborationCalls.push({
      threadId: 'reviewer',
      linkedThreadId: 'grandchild',
      tool: 'spawn_agent',
      arguments: { agent_type: 'spec-reviewer', fork_turns: 'none' },
    });
    evidence.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });
    await writeWorkflowResult(fixture.paths, evidence, '审查完成。');
    const nested = await gradeContextRoleWorkflow({
      case: evalCase,
      variant: 'current',
      paths: fixture.paths,
    });
    assert.equal(nested.passed, false);
    assert.equal(
      nested.details.assertions.find((entry) => entry.name === 'spec-reviewer:no_nested').passed,
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Ticket handoff grader requires attributable ownership and browser evidence', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-build', 'evals');
  const document = await readJson(path.join(evalRoot, 'generated-ticket-handoff.cases.json'));
  const evalCase = document.cases[0];
  const fixture = await workflowFixture();
  try {
    await prepareContextRoleWorkflow({ case: evalCase, paths: fixture.paths });
    await mkdir(path.join(fixture.paths.workspace, 'tickets'), { recursive: true });
    await writeFile(
      path.join(fixture.paths.workspace, 'tickets', 'view.md'),
      '# 页面 Ticket\n读取 spec.md、design/accepted.md 与 design/reference.html。修改 public/index.html。桌面 1200 左右布局；窄屏 420 预览在前。运行交互验收 test。\n',
    );
    const roles = [
      ['breakdown', 'breakdown-worker', 'dev-breakdown'],
      ['implementer', 'implement-worker', 'dev-implement'],
      ['design', 'design-reviewer', 'dev-review-code'],
      ['quality', 'quality-reviewer', 'dev-review-code'],
    ];
    const calls = roles.map(([threadId, role]) => spawnCall(role, threadId));
    calls.push(
      {
        threadId: 'breakdown',
        tool: 'apply_patch',
        arguments: { patch: '*** Begin Patch\n*** Add File: tickets/view.md\n+# 页面 Ticket\n*** End Patch' },
        status: 'completed',
      },
      {
        threadId: 'implementer',
        tool: 'exec_command',
        arguments: { cmd: "sed -n '1,200p' tickets/view.md" },
        output: { exitCode: 0 },
        status: 'completed',
      },
      {
        threadId: 'implementer',
        tool: 'apply_patch',
        arguments: { patch: '*** Begin Patch\n*** Update File: public/index.html\n@@\n*** End Patch' },
        status: 'completed',
      },
      {
        threadId: 'design',
        tool: 'exec_command',
        arguments: { cmd: "sed -n '1,240p' public/index.html" },
        output: { exitCode: 0 },
        status: 'completed',
      },
      {
        threadId: 'quality',
        tool: 'exec_command',
        arguments: { cmd: "sed -n '1,240p' public/index.html" },
        output: { exitCode: 0 },
        status: 'completed',
      },
      {
        threadId: 'root',
        tool: 'browser_screenshot',
        arguments: { viewport: { width: 1200, height: 800 } },
        status: 'completed',
      },
      {
        threadId: 'root',
        tool: 'playwright_screenshot',
        arguments: { viewport: { width: 420, height: 820 } },
        status: 'completed',
      },
    );
    const evidence = workflowEvidence({
      workspaceDiff: { added: ['tickets/view.md'], modified: ['public/index.html'], removed: [] },
      skillLoads: roles.map(([threadId, , skill]) => ({ threadId, skill })),
      threadGraph: [
        { threadId: 'root', parentThreadId: null },
        ...roles.map(([threadId, role]) => ({ threadId, parentThreadId: 'root', agentRole: role })),
      ],
      collaborationCalls: calls,
    });
    await writeWorkflowResult(fixture.paths, evidence, '交接、实施和双轴审查完成。');
    const passing = await gradeContextRoleWorkflow({
      case: evalCase,
      variant: 'current',
      paths: fixture.paths,
    });
    assert.equal(passing.passed, false);
    assert.equal(passing.details.complete, false, 'Browser call keywords and Ticket headings do not prove the product or Review.');

    evidence.collaborationCalls = evidence.collaborationCalls.filter((call) => (
      !/(browser|playwright)/u.test(call.tool)
    ));
    evidence.collaborationCalls.forEach((call, index) => {
      call.ordinal = index + 1;
    });
    await writeWorkflowResult(fixture.paths, evidence, '浏览器已验证 1200 与 420。');
    const unsupportedClaim = await gradeContextRoleWorkflow({
      case: evalCase,
      variant: 'current',
      paths: fixture.paths,
    });
    assert.equal(unsupportedClaim.passed, false);
    assert.equal(
      unsupportedClaim.details.checks.some((entry) => entry.name.startsWith('semantic:') && entry.verdict === 'unknown'),
      true,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('workflow routing Eval includes Build and decision candidates', async () => {
  const evalRoot = path.join(target.source, 'skills', 'dev-workflow', 'evals');
  const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
  const router = manifest.suites.find((suite) => suite.id === 'router-composed');
  assert.ok(router);
  const routingCorpus = await readJson(path.join(evalRoot, router.cases));
  assert.equal(routingCorpus.suite.unitUnderTest, 'dev-workflow');
  assert.equal(routingCorpus.suite.participants.includes('decision-shape'), true);
  assert.equal(routingCorpus.suite.participants.includes('decision-grill'), true);
  assert.equal(routingCorpus.suite.participants.includes('decision-prototype'), true);
  assert.equal(routingCorpus.suite.participants.includes('dev-build'), true);
  assert.equal(routingCorpus.suite.participants.includes('dev-breakdown'), true);

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
    assert.deepEqual(entry.input.expected.loadedSkills, ['dev-workflow', 'dev-design']);
  }
  assert.deepEqual(
    cases.find((entry) => entry.id === 'route_fast_verified_to_code_review').input.expected.loadedSkills,
    ['dev-workflow', 'dev-build'],
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
  await read(path.join(skillsRoot, 'dev-design', 'references', 'review-repair.md'));
  for (const reference of ['review-repair.md', 'task-artifacts.md', 'local-workspace.md']) {
    await assert.rejects(
      read(path.join(skillsRoot, 'dev-workflow', 'references', reference)),
      { code: 'ENOENT' },
    );
  }
  if (target.platform) {
    const localWorkspace = await read(path.join(target.source, 'references', 'local-workspace.md'));
    for (const name of localWorkspaceSkills) {
      assert.equal(
        await read(path.join(skillsRoot, name, 'references', 'local-workspace.md')),
        localWorkspace,
        `${name} must receive the canonical shared reference`,
      );
    }
  }
  await read(path.join(skillsRoot, 'dev-review-spec', 'references', 'rereview.md'));
  await read(path.join(skillsRoot, 'dev-review-code', 'references', 'rereview.md'));
  await read(path.join(skillsRoot, 'dev-review-code', 'references', 'design-fidelity.md'));
  await read(path.join(skillsRoot, 'dev-repair', 'references', 'review-loop.md'));
  for (const reference of ['coordinated-build.md', 'checkpoints.md', 'review-planning.md']) {
    await read(path.join(skillsRoot, 'dev-build', 'references', reference));
  }
  await assert.rejects(
    read(path.join(skillsRoot, 'dev-build', 'references', 'review-repair.md')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    read(path.join(skillsRoot, 'dev-design', 'assets', 'task-template.md')),
    { code: 'ENOENT' },
  );
  await read(path.join(skillsRoot, 'dev-breakdown', 'assets', 'ticket-template.md'));
  await read(path.join(skillsRoot, 'dev-build', 'assets', 'work-index-template.md'));
  await assert.rejects(
    read(path.join(skillsRoot, 'dev-implement', 'assets', 'work-template.md')),
    { code: 'ENOENT' },
  );
  if (target.platform) {
    for (const name of ['dev-build', 'dev-breakdown', 'dev-repair']) {
      await assert.rejects(readdir(path.join(skillsRoot, name, 'evals')), { code: 'ENOENT' });
    }
  }
});
