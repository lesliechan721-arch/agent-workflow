export const trainCases = [
  {
    id: 'cross_module_fact',
    query: '我刚接手这个陌生 monorepo。请从 repo/ 下至少三个服务和共享配置里查清 checkout 风控开关从入口到 worker 的完整传递路径，给出文件与行号证据；不要修改代码。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'official_docs_and_logs',
    query: '线上升级后偶发 401。请结合 docs/vendor/ 下多版本官方接口说明和 logs/ 下四段长日志，核验究竟是哪次协议变化造成的，并区分直接证据和推断。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'large_user_materials',
    query: 'materials/ 里是十几份访谈和会议记录。帮我筛选所有关于续费失败原因的原始证据，标出冲突说法和材料位置，最后只给简短结论。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'external_repository_trace',
    query: '请调查 repo/ 这个我没接触过的外部代码库，确认审计事件在 API、队列、持久化和前端四个模块中的字段名称是否一致，并给可核验的路径证据。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'incident_timeline',
    query: 'reports/audit/ 有跨三天的审计日志，docs/runbooks/ 有多份处理手册。请重建故障时间线并核对每个关键节点的来源，不确定处不要猜。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'explicit_known_file',
    query: '$codex-explore 只打开 known/settings.ts，告诉我 DEFAULT_REGION 的值和行号，不要查看其它文件。',
    should_load_skill: true,
    should_spawn_agent: false,
  },
  {
    id: 'skill_design_review',
    query: '评估一下 plugins/codex-explore 这套 skill 的设计是否合理，指出缺陷、严重性和修改建议。相关实现只有 README.md 与 workflow.md 两个已知文件。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'large_pr_review',
    query: '请 review changes/large-pr.diff，判断有哪些真实 bug，按严重性排序并给修改建议。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'two_known_files',
    query: '请对照 known/settings.ts 和 known/constants.ts，确认 DEFAULT_REGION 是否一致。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'implementation_task',
    query: '根据 known/parser-spec.md 实现一个解析器并补测试，直接修改 repo/shared/parser.ts。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'small_cross_check',
    query: '独立核对一下 docs/vendor/api-v2.md 和 docs/vendor/migration.md 里 timeout 默认值是否一致，只需要这两个已知段落。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'composite_review_exploration',
    query: 'review changes/large-pr.diff 前，先在这个陌生 repo 的网关、任务和存储模块中把 deleteSafely 的全部调用点与数据流查清并列出文件证据；探索结果返回后我再判断 bug 和严重性。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
];
