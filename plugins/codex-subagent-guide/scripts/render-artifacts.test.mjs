import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderArtifactPlan,
  renderRoleDeveloperInstructions,
} from './render-artifacts.mjs';

const ROLE_EXPECTATIONS = [
  {
    artifactId: 'codex-subagent-simple-role',
    roleKey: 'codex-subagent-simple',
    refreshKeys: ['simpleTaskModel', 'simpleTaskReasoningEffort'],
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
  },
  {
    artifactId: 'codex-subagent-general-role',
    roleKey: 'codex-subagent-general',
    refreshKeys: ['generalTaskModel', 'generalTaskReasoningEffort'],
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
  },
  {
    artifactId: 'codex-subagent-complex-role',
    roleKey: 'codex-subagent-complex',
    refreshKeys: ['complexTaskModel', 'complexTaskReasoningEffort'],
    model: 'gpt-5.6-terra',
    reasoningEffort: 'max',
  },
  {
    artifactId: 'codex-subagent-plan-review-role',
    roleKey: 'codex-subagent-plan-review',
    refreshKeys: ['planningReviewTaskModel', 'planningReviewTaskReasoningEffort'],
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
      name: 'codex-subagent-guide',
      version: '0.1.0',
    },
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values,
    },
  };
}

function artifactsFrom(plan) {
  assert.equal(plan.version, 1);
  assert.equal(plan.artifacts.length, 5);

  const skill = plan.artifacts.find((artifact) => artifact.id === 'codex-subagent-guide-skill');
  assert.ok(skill, 'missing skill artifact');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.skillKey, 'codex-subagent-guide');
  assert.deepEqual(skill.refreshKeys, []);
  assert.equal(skill.state, 'present');

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

  return { skill, roles };
}

test('renders four task roles and agent-type-only preset guidance', async () => {
  const { skill, roles } = artifactsFrom(await renderArtifactPlan(createContext()));

  for (const expected of ROLE_EXPECTATIONS) {
    const role = roles.get(expected.roleKey);
    assert.equal(role.content.roleFile.model, expected.model);
    assert.equal(role.content.roleFile.model_reasoning_effort, expected.reasoningEffort);
    assert.equal(
      role.content.roleFile.developer_instructions,
      renderRoleDeveloperInstructions(),
    );
    assert.ok(skill.content.skillFile.includes(`| \`${expected.roleKey}\` |`));
  }

  assert.match(skill.content.skillFile, /\| 简单任务 \|/);
  assert.match(skill.content.skillFile, /\| 通用任务 \|/);
  assert.match(skill.content.skillFile, /\| 复杂任务 \|/);
  assert.match(skill.content.skillFile, /\| 计划与审核 \|/);
  assert.match(skill.content.skillFile, /计划或审核优先于其前置探索/);
  assert.match(skill.content.skillFile, /复杂实现与调试优先于通用/);
  assert.match(skill.content.skillFile, /预定义任务只传表中的 `agent_type`/);
  assert.match(skill.content.skillFile, /不回退到动态 model override/);
  assert.match(skill.content.skillFile, /整体作为自定义任务/);
  assert.match(skill.content.skillFile, /未指定字段不补预设值/);
  assert.match(skill.content.skillFile, /固定 role 与显式 model、effort 冲突时停止/);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-luna'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-terra'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-sol'), false);

  assert.match(skill.content.skillFile, /默认使用干净上下文/);
  assert.match(
    skill.content.skillFile,
    /按当前 `spawn_agent` schema 传表示“不继承”的值/,
  );
  assert.match(
    skill.content.skillFile,
    /完整历史、按轮次继承或其它非干净模式都统一视为继承上下文/,
  );
  assert.match(skill.content.skillFile, /具体参数和兼容性服从当前工具 schema/);
  assert.match(skill.content.skillFile, /显式要求无法同时满足时停止并说明/);
  assert.equal(skill.content.skillFile.includes('按当前 schema 对 `agent_type`'), false);

  assert.match(skill.content.skillFile, /`wait_agent` 公开 `targets` 时/);
  assert.match(skill.content.skillFile, /`wait_agent` 未公开 `targets` 且描述为 mailbox wait 时/);
  assert.match(skill.content.skillFile, /当前工具列表公开 `close_agent` 时/);
  assert.match(skill.content.skillFile, /读取当前 schema 的 min、default、max/);
  assert.match(
    skill.content.skillFile,
    /compatibility: Supports Codex multi-agent V1 and V2 collaboration tools with the bundled agent roles installed/,
  );
  assert.equal(skill.content.skillFile.includes('时是 V1'), false);
  assert.equal(skill.content.skillFile.includes('时是 V2'), false);
  assert.equal(skill.content.skillFile.includes('timeout_ms=600000'), false);
  assert.ok(skill.content.skillFile.split('\n').length <= 70);
  assert.equal(skill.content.skillFile.includes('{{spawnParameterGuidance}}'), false);
  assert.match(skill.content.openaiYaml, /allow_implicit_invocation: true/);
  assert.match(skill.content.openaiYaml, /子代理任务分类、fork 与等待指导/);
});

test('renders a configured role without changing the others', async () => {
  const { roles } = artifactsFrom(
    await renderArtifactPlan(
      createContext({
        planningReviewTaskModel: 'review-specialist',
        planningReviewTaskReasoningEffort: 'max',
      }),
    ),
  );

  const planningReview = roles.get('codex-subagent-plan-review');
  assert.equal(planningReview.content.roleFile.model, 'review-specialist');
  assert.equal(planningReview.content.roleFile.model_reasoning_effort, 'max');

  const complex = roles.get('codex-subagent-complex');
  assert.equal(complex.content.roleFile.model, 'gpt-5.6-terra');
  assert.equal(complex.content.roleFile.model_reasoning_effort, 'max');
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
  assert.equal(simple.content.roleFile.model_reasoning_effort, 'high');
});

test('does not read legacy six-category config keys', async () => {
  const { roles } = artifactsFrom(
    await renderArtifactPlan(
      createContext({
        explorationModel: 'legacy-exploration',
        reviewModel: 'legacy-review',
        generalReasoningEffort: 'low',
      }),
    ),
  );

  assert.equal(roles.get('codex-subagent-simple').content.roleFile.model, 'gpt-5.6-luna');
  assert.equal(roles.get('codex-subagent-plan-review').content.roleFile.model, 'gpt-5.6-sol');
  assert.equal(
    roles.get('codex-subagent-general').content.roleFile.model_reasoning_effort,
    'max',
  );
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
