import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderArtifactPlan,
  renderRoleDeveloperInstructions,
} from './render-artifacts.mjs';

const SHORT_DESCRIPTION = '子代理任务分类、参数选择、上下文继承、等待与生命周期管理';
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
  assert.deepEqual(skill.refreshKeys, ['minimumInitialWaitMinutes']);
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
    assert.match(role.content.roleFile.developer_instructions, /收到父代理显式存活探测时/);
    assert.match(role.content.roleFile.developer_instructions, /`status=progress`/);
    assert.match(role.content.roleFile.developer_instructions, /回复 progress 后继续原任务/);
    assert.ok(skill.content.skillFile.includes(`| \`${expected.roleKey}\` |`));
  }

  assert.match(skill.content.skillFile, /\| 简单任务 \|/);
  assert.match(skill.content.skillFile, /\| 通用任务 \|/);
  assert.match(skill.content.skillFile, /\| 复杂任务 \|/);
  assert.match(skill.content.skillFile, /\| 计划与审核 \|/);
  assert.match(skill.content.skillFile, /且没有专用 skill 自行完整管理本次委派时使用/);
  assert.match(skill.content.skillFile, /不与已经定义独立委派流程的专用 skill 叠加使用/);
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
  assert.match(skill.content.skillFile, /用户、适用规则或其它已加载 skill 明确要求继承/);
  assert.match(skill.content.skillFile, /多个显式 context 要求按当前指令优先级解析/);
  assert.match(skill.content.skillFile, /同级冲突无法消解/);
  assert.match(skill.content.skillFile, /context 选择独立于预设或自定义任务分类/);
  assert.equal(skill.content.skillFile.includes('按当前 schema 对 `agent_type`'), false);

  assert.match(skill.content.skillFile, /调用时只等待尚未终态的 agent/);
  assert.match(skill.content.skillFile, /返回活动通知而非最终结果时，以完成通知为准/);
  assert.match(skill.content.skillFile, /其它已加载的任务专用 skill 明确提供首次存活探测下限时优先使用/);
  assert.match(skill.content.skillFile, /首次探测前至少等待 `10` 分钟（`timeout_ms=600000`）/);
  assert.match(skill.content.skillFile, /只有 `wait_agent` 明确报告超时才发起存活探测/);
  assert.match(skill.content.skillFile, /同一子任务同时最多有一个未决探测/);
  assert.match(skill.content.skillFile, /暂未回复不能单独证明代理已经挂死/);
  assert.match(skill.content.skillFile, /向原 agent 发送一次聚焦缺口的 follow-up/);
  assert.match(skill.content.skillFile, /收到结果后重新校验/);
  assert.match(skill.content.skillFile, /不要为可恢复缺口重复 spawn 相同任务/);
  assert.match(skill.content.skillFile, /不得把不合格结果当作任务完成/);
  assert.match(skill.content.skillFile, /是否请求部分结果或提前收敛由主代理/);
  assert.match(skill.content.skillFile, /当前工具提供 `close_agent` 时/);
  assert.match(
    skill.content.skillFile,
    /compatibility: Supports Codex multi-agent V1 and V2 collaboration tools with the bundled agent roles installed/,
  );
  assert.equal(skill.content.skillFile.includes('时是 V1'), false);
  assert.equal(skill.content.skillFile.includes('时是 V2'), false);
  assert.equal(skill.content.skillFile.includes('催促后等待'), false);
  assert.equal(skill.content.skillFile.includes('非中断收敛请求'), false);
  assert.equal(skill.content.skillFile.includes('list_agents'), false);
  assert.equal(skill.content.skillFile.includes('interrupt_agent'), false);
  assert.ok(skill.content.skillFile.split('\n').length <= 80);
  assert.equal(skill.content.skillFile.includes('{{spawnParameterGuidance}}'), false);
  assert.equal(skill.content.skillFile.includes('{{minimumInitialWaitMinutes}}'), false);
  assert.match(skill.content.openaiYaml, /allow_implicit_invocation: true/);
  assert.match(skill.content.skillFile, new RegExp(`short-description: ${SHORT_DESCRIPTION}`));
  assert.match(skill.content.openaiYaml, new RegExp(`short_description: "${SHORT_DESCRIPTION}"`));
  assert.ok(Array.from(SHORT_DESCRIPTION).length >= 25);
  assert.ok(Array.from(SHORT_DESCRIPTION).length <= 64);
});

test('renders a configured initial liveness probe delay', async () => {
  const { skill } = artifactsFrom(
    await renderArtifactPlan(createContext({ minimumInitialWaitMinutes: 15 })),
  );

  assert.match(
    skill.content.skillFile,
    /首次探测前至少等待 `15` 分钟（`timeout_ms=900000`）/,
  );
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
