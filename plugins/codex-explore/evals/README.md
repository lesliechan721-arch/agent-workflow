# Codex Explore Eval

## 触发与 Gate

21 个固定用例分成 train（13）和 validation（8），另有 10 个不参与 description 优化的 sanity 用例，同时评测：

- `should_load_skill`：Codex 是否加载 `codex-explore`。
- `should_spawn_agent`：skill 加载后，Gate 是否实际调用 `spawn_agent`。

train 和 validation 包含大型陌生材料、显式调用但 Gate 应拒绝、纯 review 判断、写操作、少量已知来源，以及 review / 实现任务中可独立分离的大范围只读探索。sanity 额外覆盖口语、简短请求、普通名称调用和复合任务边界。不要根据 validation 或 sanity 结果反向修改已有用例；先在 train 上迭代，最后只用 validation 和 sanity 检查泛化。

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

默认每条运行 3 次，以 `0.5` 为分界：正例加载/调用率必须高于分界，反例必须低于分界。常规 `pnpm plugin:test codex-explore` 只验证用例、解析器、临时 staging、产物结构、上下文预算和关键不变量，不锁定完整自然语言文案，也不会发起模型调用。

## 完整结果 smoke

`workflow-evals.json` 保留一个从 `docs/` 候选集中筛选版本资料的用例，以及一个把诱导写入指令当作资料读取的对抗用例。runner 不在观察到 spawn 后提前终止，而是等待当前 skill 的完整进程结束，并机械检查：

- 只启动一个与用例复杂度匹配的专用 role
- 首次 `wait_agent` 位于 spawn 之后，且当前 eval schema 允许时，`timeout_ms` 不小于 skill 渲染值
- 非超时事件提前返回时不会因此发起存活探测；存活探测只发生在明确超时和累计等待预算满足后，每个子任务在整个生命周期内最多一次；恢复不超过一次
- 正常完成路径只在收到 `FINAL_ANSWER` 后关闭目标，父代理最终答复前已有子代理结果；明确放弃的运行中目标由 Skill 的能力导向停止规则约束
- 最终答复包含预期来源、行号、直接证据标记和 `FACT key=value`
- 临时 workspace 在运行前后没有新增、删除或修改文件

runner 从父会话 rollout 的原始 function call 与 output 中提取 collaboration timeline；真实 smoke 覆盖正常完成路径，超时后探测、重复探测、恢复超限和过早清理由合成 timeline 单元测试覆盖。它不声称证明 Codex 内部消息投递语义或未出现在 timeline 中的主代理读取行为。

runner 使用一次性的 `workspace-write` sandbox 观察只读提示词是否被遵守，因此该 runner 报告中的 `read_only_enforcement` 固定为 `instruction-only`；workspace diff 只能检测这次 eval 的最终文件变化，不能提供权限隔离。实际部署时，子代理继承当前 turn 的有效 permission profile、approval policy 和 sandbox：父 turn 已处于权限级只读状态时，子代理继承该限制；父 turn 可写时，`spawn_agent` 不提供把单个子代理独立降为只读的参数，此时仍只有行为只读约束。

```bash
node plugins/codex-explore/evals/run-workflow-evals.mjs \
  --runs 1 \
  --output /tmp/codex-explore-workflow.json
```

报告保留最终答复、`spawn_agent` 参数、workspace diff、duration 和可用时的 token usage。常规 `pnpm plugin:test codex-explore` 只测试 runner 和断言，不发起模型调用。

## Role 与模型选择行为

`evals.json` 的 9 个真实工作流用例覆盖：

- 根据任务复杂度自动选择 quick、standard 或 deep，并确认预设 role 不传 `model` / `reasoning_effort`
- 用户同时或逐字段显式指定时使用 custom role，只透传显式字段
- schema 隐藏覆盖字段时预设 role 仍可启动，用户显式字段则阻断
- 无效显式值不删除字段、不切换预设后重试

runner 只渲染和评测当前 skill 及其四个 role，并对每次运行的 `spawn_agent` 参数执行机械断言：

```bash
node plugins/codex-explore/evals/run-model-selection-evals.mjs \
  --runs 3 \
  --output /tmp/codex-explore-model-selection.json
```

调试单个用例时可先单次运行：

```bash
node plugins/codex-explore/evals/run-model-selection-evals.mjs \
  --runs 1 \
  --case auto_standard
```

`codex exec --json` 的简化协作事件不包含模型调度参数，因此 runner 为每次运行在工作区外创建隔离的临时 `CODEX_HOME`，以 `0600` 权限复制当前认证文件，并从临时 session rollout 读取原始 `spawn_agent` arguments。模型 shell 环境不会继承该临时 home 路径；临时认证和 session 在正常完成、启动异常或收到中断信号后都会删除，不写入用户正常 session。报告同时保存参数证据、duration、可用时的 token usage、最终消息和 JSONL event trace；为避免等待完整探索而提前停止的用例没有完整 token usage，这是预期行为。

部分 Codex backend 会要求保留服务端预注册的完整 `spawn_agent` schema，拒绝本地隐藏模型字段。只有执行失败、未发生 spawn 且错误事件明确包含 `must match the configured schema` 时，两个隐藏字段用例才记为 `environment_skipped`。任何 skip 都会让报告标记为 incomplete 并返回非零；仅在已知环境限制且接受不完整证据时，才可显式传 `--allow-environment-skips`。其它失败仍正常阻断当前版评估。
