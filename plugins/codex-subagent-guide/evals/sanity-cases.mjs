export const sanityCases = [
  {
    id: 'sanity_casual_delegate',
    query: '可以开子代理，找个 agent 帮我把 simple.ts 的事实捋清楚。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'sanity_explicit_role_work',
    query: '委派权限已给，请启动子代理做一次安全审核。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'sanity_parallel_phrase',
    query: '按 AGENTS.md 的要求并行 agent 工作：请把复杂调试交给一个子代理。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'sanity_docs_only',
    query: '帮我润色一段介绍 multi-agent 的 README，不使用任何 agent 工具。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'sanity_name_only',
    query: 'codex-subagent-guide 这个名字是什么意思？不要加载技能或委派。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'sanity_existing_cleanup',
    query: '子代理工作已获授权且 agent_gamma 已完成。请说明如何整合并清理它，不要 spawn 新 agent。',
    should_load_skill: true,
    should_spawn_agent: false,
  },
];
