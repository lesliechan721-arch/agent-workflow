import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  renderArtifactPlan,
  renderSubagentRoleDeveloperInstructions,
} from './render-artifacts.mjs';

const SHORT_DESCRIPTION = '子代理任务分类、参数选择、上下文继承、等待与清理原则';
const stagedArtifactSourcePath = fileURLToPath(
  new URL(
    '../.agents-plugin/artifact-sources/codex/codex-subagent-guide-skill/0/',
    import.meta.url,
  ),
);
const stagedExploreArtifactSourcePath = fileURLToPath(
  new URL('../.agents-plugin/artifact-sources/codex/codex-explore-skill/0/', import.meta.url),
);
const stagedClarifierArtifactSourcePath = fileURLToPath(
  new URL('../.agents-plugin/artifact-sources/codex/codex-clarifier-skill/0/', import.meta.url),
);
const artifactSourcePath = existsSync(stagedArtifactSourcePath)
  ? stagedArtifactSourcePath
  : fileURLToPath(new URL('../skills/codex-subagent-guide/', import.meta.url));
const exploreArtifactSourcePath = existsSync(stagedExploreArtifactSourcePath)
  ? stagedExploreArtifactSourcePath
  : fileURLToPath(new URL('../skills/codex-explore/', import.meta.url));
const clarifierArtifactSourcePath = existsSync(stagedClarifierArtifactSourcePath)
  ? stagedClarifierArtifactSourcePath
  : fileURLToPath(new URL('../skills/codex-clarifier/', import.meta.url));
const ROLE_EXPECTATIONS = [
  {
    artifactId: 'codex-subagent-simple-role',
    roleKey: 'codex-subagent-simple',
    refreshKeys: ['simpleTaskModel', 'simpleTaskReasoningEffort'],
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
  },
  {
    artifactId: 'codex-subagent-general-role',
    roleKey: 'codex-subagent-general',
    refreshKeys: ['generalTaskModel', 'generalTaskReasoningEffort'],
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  },
  {
    artifactId: 'codex-subagent-complex-role',
    roleKey: 'codex-subagent-complex',
    refreshKeys: ['complexTaskModel', 'complexTaskReasoningEffort'],
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  {
    artifactId: 'codex-subagent-advanced-role',
    roleKey: 'codex-subagent-advanced',
    refreshKeys: ['advancedTaskModel', 'advancedTaskReasoningEffort'],
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
  },
];

function createContext(values = {}) {
  return {
    event: 'install',
    platform: 'codex',
    scope: 'user',
    plugin: {
      name: 'codex-enhance',
      version: '0.2.0',
    },
    artifactSources: [
      {
        id: 'codex-clarifier-skill',
        target: 'codex.skill',
        sourceDirs: [clarifierArtifactSourcePath],
      },
      {
        id: 'codex-explore-skill',
        target: 'codex.skill',
        sourceDirs: [exploreArtifactSourcePath],
      },
      {
        id: 'codex-subagent-guide-skill',
        target: 'codex.skill',
        sourceDirs: [artifactSourcePath],
      },
    ],
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values,
    },
  };
}

function artifactsFrom(plan) {
  assert.equal(plan.version, 2);
  assert.equal(plan.artifacts.length, 11);

  const skill = plan.artifacts.find((artifact) => artifact.id === 'codex-subagent-guide-skill');
  assert.ok(skill, 'missing skill artifact');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.skillKey, 'codex-subagent-guide');
  assert.deepEqual(skill.refreshKeys, ['subagentMinimumInitialWaitMinutes']);
  assert.equal(skill.state, 'present');
  assert.equal('skillFile' in skill.content, false);
  assert.equal('openaiYaml' in skill.content, false);
  assert.equal(typeof skill.content.files['SKILL.md'], 'string');
  assert.equal(skill.content.files['agents/openai.yaml'], undefined);

  const roles = new Map();
  for (const expected of ROLE_EXPECTATIONS) {
    const role = plan.artifacts.find((artifact) => artifact.id === expected.artifactId);
    assert.ok(role, `missing role artifact ${expected.artifactId}`);
    assert.equal(role.kind, 'codexRole');
    assert.equal(role.target, 'codex.agentRole');
    assert.equal(role.roleKey, expected.roleKey);
    assert.deepEqual(role.refreshKeys, expected.refreshKeys);
    assert.equal(role.state, 'present');
    assert.equal(role.content.roleFile.name, expected.roleKey);
    assert.equal(role.content.registration.description, role.content.roleFile.description);
    roles.set(expected.roleKey, role);
  }

  return {
    skill: {
      ...skill,
      content: {
        ...skill.content,
        skillFile: skill.content.files['SKILL.md'],
      },
    },
    roles,
  };
}

test('renders four task roles with required metadata and safety invariants', async () => {
  const { skill, roles } = artifactsFrom(await renderArtifactPlan(createContext()));
  const openaiYaml = await readFile(
    new URL('agents/openai.yaml', pathToFileURL(`${artifactSourcePath}/`)),
    'utf8',
  );

  for (const expected of ROLE_EXPECTATIONS) {
    const role = roles.get(expected.roleKey);
    assert.equal(role.content.roleFile.model, expected.model);
    assert.equal(role.content.roleFile.model_reasoning_effort, expected.reasoningEffort);
    assert.equal(
      role.content.roleFile.developer_instructions,
      renderSubagentRoleDeveloperInstructions(),
    );
  }

  // Static contract exception: rendered instructions must not grant delegation authority; behavior test is not suitable because the prohibition is consumed directly by the model.
  assert.match(skill.content.skillFile, /本 skill 不授予或判断委派权限/);

  // Static contract exception: unavailable presets must not trigger an unapproved model override; behavior test is not suitable because the renderer only emits model instructions.
  assert.match(skill.content.skillFile, /role 不可用时停止，不改用动态 model override/);

  // Static contract exception: rendered waiting instructions must prohibit active polling; behavior test is not suitable because no deterministic runner executes model tool choices.
  assert.match(
    skill.content.skillFile,
    /不得使用 shell `sleep`、短 wait 循环、周期性查询、文件、Git、测试状态或重复进度询问进行监控/,
  );

  assert.doesNotMatch(skill.content.skillFile, /{{[^}]+}}/);

  // Static contract exception: Codex consumes Skill frontmatter and invocation metadata as text; behavior test is not suitable because ArtifactPlan does not parse these platform metadata files.
  assert.match(skill.content.skillFile, /name: codex-subagent-guide/);
  assert.match(
    skill.content.skillFile,
    /compatibility: Requires Codex multi-agent spawn_agent\.agent_type and the four bundled roles/,
  );
  assert.match(openaiYaml, /allow_implicit_invocation: true/);
  assert.match(skill.content.skillFile, new RegExp(`short-description: ${SHORT_DESCRIPTION}`));
  assert.match(openaiYaml, new RegExp(`short_description: "${SHORT_DESCRIPTION}"`));
  assert.ok(Array.from(SHORT_DESCRIPTION).length >= 25);
  assert.ok(Array.from(SHORT_DESCRIPTION).length <= 64);
});

test('renders a configured minimum initial wait window', async () => {
  const plan = await renderArtifactPlan(
    createContext({
      exploreMinimumInitialWaitMinutes: 2,
      subagentMinimumInitialWaitMinutes: 15,
    }),
  );
  const { skill } = artifactsFrom(plan);
  const exploreSkill = plan.artifacts.find(
    (artifact) => artifact.id === 'codex-explore-skill',
  );
  assert.ok(exploreSkill, 'missing explore skill artifact');

  assert.match(skill.content.skillFile, /至少 `15` 分钟的响应式窗口（`timeout_ms=900000`）/);
  assert.match(exploreSkill.content.files['SKILL.md'], /至少 `2` 分钟的单次窗口/);
  assert.match(exploreSkill.content.files['SKILL.md'], /即 `timeout_ms=120000`/);
});

test('renders a configured role without changing the others', async () => {
  const { roles } = artifactsFrom(
    await renderArtifactPlan(
      createContext({
        advancedTaskModel: 'advanced-specialist',
        advancedTaskReasoningEffort: 'max',
      }),
    ),
  );

  const advanced = roles.get('codex-subagent-advanced');
  assert.equal(advanced.content.roleFile.model, 'advanced-specialist');
  assert.equal(advanced.content.roleFile.model_reasoning_effort, 'max');

  const complex = roles.get('codex-subagent-complex');
  assert.equal(complex.content.roleFile.model, 'gpt-5.6-sol');
  assert.equal(complex.content.roleFile.model_reasoning_effort, 'high');
});

test('treats blank configured values as their task defaults', async () => {
  const { roles } = artifactsFrom(
    await renderArtifactPlan(
      createContext({
        simpleTaskModel: '   ',
        simpleTaskReasoningEffort: '   ',
      }),
    ),
  );

  const simple = roles.get('codex-subagent-simple');
  assert.equal(simple.content.roleFile.model, 'gpt-5.6-luna');
  assert.equal(simple.content.roleFile.model_reasoning_effort, 'max');
});

test('rejects unsupported platforms', async () => {
  await assert.rejects(
    renderArtifactPlan({
      ...createContext(),
      platform: 'claude',
    }),
    /Unsupported platform: claude/,
  );
});
