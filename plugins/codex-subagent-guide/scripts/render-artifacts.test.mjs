import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderArtifactPlan,
  renderRoleDeveloperInstructions,
} from './render-artifacts.mjs';

const SHORT_DESCRIPTION = '子代理任务分类、参数选择、上下文继承、等待与清理原则';
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
    assert.match(role.content.roleFile.developer_instructions, /完成或无法继续时直接返回/);
    assert.match(role.content.roleFile.developer_instructions, /阻塞原因和未解决项/);
    assert.equal(role.content.roleFile.developer_instructions.includes('存活探测'), false);
    assert.equal(role.content.roleFile.developer_instructions.includes('status=progress'), false);
    assert.equal(role.content.roleFile.developer_instructions.includes('status=blocked'), false);
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
  assert.match(skill.content.skillFile, /低歧义、边界清晰且成功标准明确的只读探索/);
  assert.match(skill.content.skillFile, /只读不自动等于简单/);
  assert.match(skill.content.skillFile, /需要跨模块因果归纳、未知根因分析或高完整性核验的只读任务/);
  assert.match(skill.content.skillFile, /超出简单任务范围的常规交付使用通用任务/);
  assert.match(skill.content.skillFile, /预定义任务使用表中的 `agent_type` 选择 preset/);
  assert.match(skill.content.skillFile, /不额外传 `model` 或 `reasoning_effort`/);
  assert.match(skill.content.skillFile, /不回退到动态 model override/);
  assert.match(skill.content.skillFile, /`reasoning_effort` 或 `agent_type`/);
  assert.match(skill.content.skillFile, /按显式指令的实际作用域逐个子任务判断/);
  assert.match(skill.content.skillFile, /仅该子任务作为自定义任务并跳过 preset/);
  assert.match(skill.content.skillFile, /未指定字段不补预设/);
  assert.match(skill.content.skillFile, /字段或值不可用、组合冲突时停止并说明/);
  assert.match(skill.content.skillFile, /不猜测、循环试探或降级/);
  assert.equal(skill.content.skillFile.includes('整体作为自定义任务'), false);
  assert.equal(skill.content.skillFile.includes('service_tier'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-luna'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-terra'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-sol'), false);

  assert.match(skill.content.skillFile, /默认使用干净上下文/);
  assert.match(skill.content.skillFile, /约束、成功标准、验证要求和预期输出/);
  assert.match(
    skill.content.skillFile,
    /按当前 `spawn_agent` schema 传表示“不继承”的值/,
  );
  assert.match(skill.content.skillFile, /具体模式和兼容性服从当前工具 schema/);
  assert.match(skill.content.skillFile, /用户、适用规则或其它已加载 skill 明确要求继承/);
  assert.equal(skill.content.skillFile.includes('多个显式 context 要求'), false);
  assert.equal(
    skill.content.skillFile.includes('同级冲突或 schema 无法满足时停止并说明'),
    false,
  );
  assert.match(skill.content.skillFile, /context 选择独立于预设或自定义任务分类/);
  assert.equal(skill.content.skillFile.includes('按当前 schema 对 `agent_type`'), false);

  assert.match(skill.content.skillFile, /调用时只等待尚未终态的 agent/);
  assert.match(skill.content.skillFile, /活动通知不等于最终结果/);
  assert.match(skill.content.skillFile, /用户或任务专用 skill 明确指定单次等待时优先遵守/);
  assert.match(skill.content.skillFile, /至少使用 `10` 分钟的响应式窗口（`timeout_ms=600000`）/);
  assert.match(skill.content.skillFile, /timeout 不是终态或失败/);
  assert.match(skill.content.skillFile, /继续使用相同或更长且不超过当前 schema 上限的响应式等待窗口/);
  assert.match(skill.content.skillFile, /只有工具结果或运行时通知明确表示终态时才视为完成/);
  assert.match(skill.content.skillFile, /发送一次聚焦缺口的 follow-up 并重新校验/);
  assert.match(skill.content.skillFile, /不要为相同任务重复 spawn/);
  assert.match(skill.content.skillFile, /否则向用户说明未解决项/);
  assert.match(skill.content.skillFile, /重复进度询问来监控子代理/);
  assert.match(skill.content.skillFile, /当前工具提供 `close_agent` 时/);
  assert.match(skill.content.skillFile, /所需结果或终态信息已保留/);
  assert.match(skill.content.skillFile, /目标及其后代均不再需要后续调用后，才关闭目标/);
  assert.equal(skill.content.skillFile.includes('存活探测'), false);
  assert.equal(skill.content.skillFile.includes('status=progress'), false);
  assert.equal(skill.content.skillFile.includes('status=blocked'), false);
  assert.match(
    skill.content.skillFile,
    /compatibility: Preset routing requires Codex multi-agent V1 or V2 spawn_agent with agent_type exposed and the four bundled agent roles installed/,
  );
  assert.equal(skill.content.skillFile.includes('`followup_task`'), false);
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

test('renders a configured minimum initial wait window', async () => {
  const { skill } = artifactsFrom(
    await renderArtifactPlan(createContext({ minimumInitialWaitMinutes: 15 })),
  );

  assert.match(
    skill.content.skillFile,
    /至少使用 `15` 分钟的响应式窗口（`timeout_ms=900000`）/,
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
    'medium',
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
