export const validationCases = [
  {
    id: 'feature_flag_validation',
    query: '老板让我确认这个陌生仓库里的 regional_checkout 标志是否真的覆盖全部调用链。请搜索 repo/ 的网关、结算、任务和共享模块，整理可复核证据。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'standards_research_validation',
    query: '请从 docs/standards/ 的多份规范、docs/vendor/ 的官方说明和 reports/audit/ 的现场记录中核验重试语义，来源冲突要单列。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'long_audit_validation',
    query: 'reports/audit/ 日志很多而且边界不清楚。请找出同一 request id 在三天内经过了哪些组件，并为每个跳转给出原始记录位置。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'explicit_small_validation',
    query: '$codex-explore 读取 known/constants.ts 里 RETRY_LIMIT 的定义，返回值和行号即可。',
    should_load_skill: true,
    should_spawn_agent: false,
  },
  {
    id: 'workflow_quality_validation',
    query: '请评价 plugins/codex-explore/workflow.md 的 Gate 设计，判断是否过度复杂并提出重构建议。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'pr_defect_validation',
    query: '审查 changes/large-pr.diff，找出会导致数据丢失的缺陷并建议怎么改。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'composite_implementation_validation',
    query: '我要给这个陌生 repo 加 regional_checkout。实现前先跨网关、结算、任务和共享配置搜索全部扩展点与现有调用链，给出可核验路径；主流程之后再负责修改和测试。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'single_constant_validation',
    query: '用 rg 在 known/constants.ts 里查一下 RETRY_LIMIT 在第几行。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
];
