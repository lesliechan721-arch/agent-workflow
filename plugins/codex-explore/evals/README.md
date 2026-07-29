# Codex Explore Eval

## 触发与 Gate

20 个固定用例分成 train（12）和 validation（8），另有 8 个不参与 description 优化的 sanity 用例，同时评测：

- `should_load_skill`：Codex 是否加载 `codex-explore`。
- `should_spawn_agent`：skill 加载后，Gate 是否实际调用 `spawn_agent`。

train 和 validation 包含大型陌生材料、显式调用但 Gate 应拒绝、代码 review、写操作和少量已知来源等近似正反例。sanity 额外覆盖口语、简短请求、普通名称调用，以及 review / 写操作中夹带大范围检索的复合边界。不要根据 validation 或 sanity 结果反向修改已有用例；先在 train 上迭代，最后只用 validation 和 sanity 检查泛化。

## 运行

需要已登录且支持 `codex exec --json`、`spawn_agent.agent_type` 的 Codex：

```bash
node plugins/codex-explore/evals/run-trigger-evals.mjs \
  --split train \
  --runs 3 \
  --output /tmp/codex-explore-train.json

node plugins/codex-explore/evals/run-trigger-evals.mjs \
  --split validation \
  --runs 3 \
  --output /tmp/codex-explore-validation.json

node plugins/codex-explore/evals/run-trigger-evals.mjs \
  --split sanity \
  --runs 3 \
  --output /tmp/codex-explore-sanity.json
```

runner 会在临时目录渲染当前 skill、专用 role 和合成材料，使用只读 sandbox 逐条执行。显式 `$codex-explore` 由宿主注入记为已加载；自动触发则通过 JSONL 中读取临时 `.agents/skills/codex-explore/SKILL.md` 的命令识别。`spawn_agent` 通过 `collab_tool_call` 或隔离 rollout 中的原始 function call 识别。正向 spawn 用例在两个事件都出现后立即结束，避免等待完整探索结果。

默认每条运行 3 次，以 `0.5` 为分界：正例加载/调用率必须高于分界，反例必须低于分界。常规 `pnpm plugin:test codex-explore` 只验证用例、解析器和临时 staging，不会发起模型调用。

## 完整结果 smoke

`workflow-evals.json` 保留一个从 `docs/` 候选集中筛选版本资料的用例。runner 不在观察到 spawn 后提前终止，而是等待当前 skill 的完整进程结束，并机械检查：

- 只启动一个 `codex-explore-agent`
- 最终答复包含三份来源的行号、直接证据标记和预期 `FACT key=value`
- 临时 workspace 在运行前后没有新增、删除或修改文件

这只是结果级 smoke，不解析 Codex 的内部等待、子代理消息送达或父代理工具时序，也不声称证明具体的整合路径。runner 使用一次性的 `workspace-write` sandbox 观察只读提示词是否被遵守；该检查只评估 instruction compliance，不提供权限隔离。

```bash
node plugins/codex-explore/evals/run-workflow-evals.mjs \
  --runs 1 \
  --output /tmp/codex-explore-workflow.json
```

报告保留最终答复、`spawn_agent` 参数、workspace diff、duration 和可用时的 token usage。常规 `pnpm plugin:test codex-explore` 只测试 runner 和断言，不发起模型调用。

## 模型选择行为

`evals.json` 的 8 个真实工作流用例覆盖：

- 默认配置省略 `model`、传 `reasoning_effort=low`
- 自定义插件默认值
- 用户同时或逐字段显式指定时，分别覆盖对应插件默认值
- schema 隐藏默认字段时降级省略、隐藏用户显式字段时阻断
- 无效显式值不静默删除后重试

默认同时运行当前 skill 和冻结的 `0.1.18` old-skill baseline；baseline 独立保存当时的 `SKILL.md`、`openai.yaml`、role instructions、role 描述和委派授权，不调用当前 renderer。两者使用相同 prompt、配置、合成材料和独立干净会话。只对当前 skill 执行机械断言，旧版保留为对比轨迹：

```bash
node plugins/codex-explore/evals/run-model-selection-evals.mjs \
  --variant both \
  --runs 3 \
  --output /tmp/codex-explore-model-selection.json
```

调试单个用例时可先单次运行：

```bash
node plugins/codex-explore/evals/run-model-selection-evals.mjs \
  --variant current \
  --runs 1 \
  --case default_config
```

`codex exec --json` 的简化协作事件不包含模型调度参数，因此 runner 为每次运行在工作区外创建隔离的临时 `CODEX_HOME`，以 `0600` 权限复制当前认证文件，并从临时 session rollout 读取原始 `spawn_agent` arguments。模型 shell 环境不会继承该临时 home 路径；临时认证和 session 在正常完成、启动异常或收到中断信号后都会删除，不写入用户正常 session。报告同时保存参数证据、duration、可用时的 token usage、最终消息和 JSONL event trace；为避免等待完整探索而提前停止的用例没有完整 token usage，这是预期行为。

部分 Codex backend 会要求保留服务端预注册的完整 `spawn_agent` schema，拒绝本地隐藏模型字段。只有执行失败、未发生 spawn 且错误事件明确包含 `must match the configured schema` 时，两个隐藏字段用例才记为 `environment_skipped`。任何 skip 都会让报告标记为 incomplete 并返回非零；仅在已知环境限制且接受不完整证据时，才可显式传 `--allow-environment-skips`。其它失败仍正常阻断当前版评估。
