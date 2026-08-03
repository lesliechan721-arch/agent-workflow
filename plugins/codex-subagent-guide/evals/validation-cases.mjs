export const validationCases = [
  {
    id: 'validation_casual_simple',
    query: '子代理可以用，帮我叫一个 agent 跑现有检查并核对输出就行。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'validation_parallel_general',
    query: '请为现有模块起草一份简洁的常规说明文档。',
    workspace_fixture: 'project_authorization',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'validation_complex_long',
    query: '我们已经同意使用子代理；现在线索分散在多个模块，涉及性能、并发和生命周期，请启动一个合适的 agent 完成根因分析。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'validation_plan',
    query: '已授权委派。派子代理先看架构再产出决策完整的迁移计划。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'validation_specialized_workflow_owner',
    query: '$delegation-lifecycle-owner 继续安全审计的现有流程，等待已经运行的 agent_delta。',
    workspace_fixture: 'lifecycle_skill',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'validation_should_we_delegate',
    query: '先判断是否需要多 agent 并行，不要真的调用 spawn_agent。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'validation_config_help',
    query: '列出 codex-subagent-guide 的四类模型配置键，我只是维护插件配置。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'validation_thorough_only',
    query: '认真阅读 src/complex/a.ts 并详细回答，不能使用子代理。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'validation_explicit_boundary',
    query: '$codex-subagent-guide 我已经有一个运行中的 agent_beta；告诉我 timeout 后该怎么处理，但不要新建 agent。',
    should_load_skill: true,
    should_spawn_agent: false,
  },
];
