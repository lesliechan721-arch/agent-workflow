export const sanityCases = [
  {
    id: 'casual_unknown_repo',
    query: '这仓库我完全不熟，regional_checkout 到底从哪传到哪？repo/ 里文件一堆，帮我翻清楚，最后把出处列一下。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'terse_long_logs',
    query: '日志太多了，帮我沿 req-9 把 reports/audit/ 里三天的链路捋出来，出处别漏。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'casual_material_conflicts',
    query: 'materials/ 有十来份访谈和会议记录，帮我找续费失败的共同原因，还有哪些说法互相打架，标一下原文位置。',
    should_load_skill: true,
    should_spawn_agent: true,
  },
  {
    id: 'plain_name_small_request',
    query: '请用 codex-explore 看一下 known/constants.ts 的 RETRY_LIMIT，给我值和行号就行。',
    should_load_skill: true,
    should_spawn_agent: false,
  },
  {
    id: 'composite_review_boundary',
    query: 'review changes/large-pr.diff 前先把 deleteSafely 在这个陌生 repo 的所有调用点和数据流查清，再判断 bug 严重性并给修改建议。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'composite_write_boundary',
    query: '我要给这个陌生 repo 加 regional_checkout，先搜索所有扩展点和调用链，然后直接修改代码并补测试。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'casual_two_known_files',
    query: '就看 known/settings.ts 和 known/constants.ts，这俩 DEFAULT_REGION 对不对得上？',
    should_load_skill: false,
    should_spawn_agent: false,
  },
  {
    id: 'incidental_plugin_name',
    query: 'plugins/codex-explore/.agents-plugin/plugin.json 里的版本号是多少？只读这个文件。',
    should_load_skill: false,
    should_spawn_agent: false,
  },
];
