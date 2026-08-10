import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  renderArtifactPlan,
  renderRoleDeveloperInstructions,
} from './render-artifacts.mjs';

const SHORT_DESCRIPTION = '子代理任务分类、参数选择、上下文继承、等待与清理原则';
const artifactSourcePath = fileURLToPath(new URL(
  '../.agents-plugin/artifact-sources/codex/codex-subagent-guide-skill/0/',
  import.meta.url,
));
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
    artifactSources: [{
      id: 'codex-subagent-guide-skill',
      target: 'codex.skill',
      sourceDirs: [artifactSourcePath],
    }],
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values,
    },
  };
}

function artifactsFrom(plan) {
  assert.equal(plan.version, 2);
  assert.equal(plan.artifacts.length, 5);

  const skill = plan.artifacts.find((artifact) => artifact.id === 'codex-subagent-guide-skill');
  assert.ok(skill, 'missing skill artifact');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.skillKey, 'codex-subagent-guide');
  assert.deepEqual(skill.refreshKeys, ['minimumInitialWaitMinutes']);
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

test('renders four task roles and agent-type-only preset guidance', async () => {
  const { skill, roles } = artifactsFrom(await renderArtifactPlan(createContext()));
  const openaiYaml = await readFile(
    new URL('../.agents-plugin/artifact-sources/codex/codex-subagent-guide-skill/0/agents/openai.yaml', import.meta.url),
    'utf8',
  );

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

  assert.match(skill.content.skillFile, /\| 简单 \|/);
  assert.match(skill.content.skillFile, /\| 通用 \|/);
  assert.match(skill.content.skillFile, /\| 复杂 \|/);
  assert.match(skill.content.skillFile, /\| 计划与审核 \|/);
  assert.match(skill.content.skillFile, /且没有专用 skill 管理本次委派时使用/);
  assert.match(skill.content.skillFile, /本 skill 不授予或判断委派权限/);
  assert.equal(skill.content.skillFile.includes('委派必须已经获准'), false);
  assert.match(skill.content.skillFile, /显式指定 `model`、`reasoning_effort` 或 `agent_type`/);
  assert.match(skill.content.skillFile, /按其作用域作为自定义任务/);
  assert.match(skill.content.skillFile, /否则按最终交付物选择 preset/);
  assert.match(skill.content.skillFile, /计划或审核优先于前置探索/);
  assert.match(skill.content.skillFile, /复杂实现或调试优先于通用/);
  assert.match(skill.content.skillFile, /只读不等于简单/);
  assert.match(skill.content.skillFile, /按范围、歧义、冲突、因果推理和完整性要求判断复杂度/);
  assert.match(skill.content.skillFile, /preset 只传表中的 `agent_type`/);
  assert.match(skill.content.skillFile, /role 不可用时停止/);
  assert.match(skill.content.skillFile, /不改用动态 model override/);
  assert.match(skill.content.skillFile, /自定义任务只传作用于该子任务/);
  assert.match(skill.content.skillFile, /不可用或冲突时停止/);
  assert.match(skill.content.skillFile, /不猜测、试探或降级/);
  assert.equal(skill.content.skillFile.includes('整体作为自定义任务'), false);
  assert.equal(skill.content.skillFile.includes('service_tier'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-luna'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-terra'), false);
  assert.equal(skill.content.skillFile.includes('gpt-5.6-sol'), false);

  assert.match(skill.content.skillFile, /默认使用干净上下文/);
  assert.match(skill.content.skillFile, /约束、成功标准、验证要求和预期输出/);
  assert.match(skill.content.skillFile, /`fork_turns: "none"` 或 `fork_context: false`/);
  assert.match(skill.content.skillFile, /只有明确要求继承/);
  assert.match(skill.content.skillFile, /上下文选择独立于 preset\/custom/);

  assert.match(skill.content.skillFile, /只在需要结果才能继续时调用 `wait_agent`/);
  assert.match(skill.content.skillFile, /至少 `10` 分钟的响应式窗口（`timeout_ms=600000`）/);
  assert.match(skill.content.skillFile, /超时不是失败/);
  assert.match(skill.content.skillFile, /不短于前次且不超过上限的窗口/);
  assert.match(skill.content.skillFile, /只有工具结果或通知明确表示终态时才算完成/);
  assert.match(skill.content.skillFile, /不得使用 shell `sleep`、短 wait 循环、周期性查询/);
  assert.match(skill.content.skillFile, /文件、Git、测试状态或重复进度询问进行监控/);
  assert.match(skill.content.skillFile, /当前工具提供 `close_agent` 时/);
  assert.match(skill.content.skillFile, /所需结果或终态信息已保留/);
  assert.match(skill.content.skillFile, /目标及其后代均不再需要后续调用后关闭/);
  assert.equal(skill.content.skillFile.includes('follow-up'), false);
  assert.equal(skill.content.skillFile.includes('重复 spawn'), false);
  assert.equal(skill.content.skillFile.includes('存活探测'), false);
  assert.equal(skill.content.skillFile.includes('status=progress'), false);
  assert.equal(skill.content.skillFile.includes('status=blocked'), false);
  assert.match(
    skill.content.skillFile,
    /compatibility: Requires Codex multi-agent spawn_agent\.agent_type and the four bundled roles/,
  );
  assert.equal(skill.content.skillFile.includes('时是 V1'), false);
  assert.equal(skill.content.skillFile.includes('时是 V2'), false);
  assert.equal(skill.content.skillFile.includes('催促后等待'), false);
  assert.equal(skill.content.skillFile.includes('非中断收敛请求'), false);
  assert.equal(skill.content.skillFile.includes('list_agents'), false);
  assert.equal(skill.content.skillFile.includes('interrupt_agent'), false);
  assert.ok(skill.content.skillFile.split('\n').length <= 65);
  assert.equal(skill.content.skillFile.includes('{{spawnParameterGuidance}}'), false);
  assert.equal(skill.content.skillFile.includes('{{minimumInitialWaitMinutes}}'), false);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);
  assert.match(skill.content.skillFile, new RegExp(`short-description: ${SHORT_DESCRIPTION}`));
  assert.match(openaiYaml, new RegExp(`short_description: "${SHORT_DESCRIPTION}"`));
  assert.ok(Array.from(SHORT_DESCRIPTION).length >= 25);
  assert.ok(Array.from(SHORT_DESCRIPTION).length <= 64);
});

test('renders a configured minimum initial wait window', async () => {
  const { skill } = artifactsFrom(
    await renderArtifactPlan(createContext({ minimumInitialWaitMinutes: 15 })),
  );

  assert.match(
    skill.content.skillFile,
    /至少 `15` 分钟的响应式窗口（`timeout_ms=900000`）/,
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
