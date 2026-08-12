# Codex Explore Eval

统一入口会先按 `evals/manifest.json` materialize default/non-default、project/user 最终制品；真实模型只运行 project-default：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name materialization --materialize-only
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-validation-debug --suite trigger --split validation --runs 1
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name release
```

最后一条运行全部 release-required suite/split。`pnpm plugin:eval` 是唯一模型评测入口；领域 command runner 缺少中央提供的 final-artifact root 时会直接失败。

真实模型默认要求 Full Access 管理后代进程；无 Full Access 时会在启动前阻断。用户确认风险后可传 `--allow-unmanaged-processes`，但该模式不保证清理后代进程。中间产物固定在项目 `.tmp/agent-workflows/evals/`，持久报告写入 `plugins/codex-enhance/reports/codex-explore/<batch-id>/`。

## 触发与 Gate

21 个固定用例分成 train（13）和 validation（8），另有 10 个不参与 description 优化的 sanity 用例，同时评测：

- `should_load_skill`：Codex 是否加载 `codex-explore`。
- `should_spawn_agent`：skill 加载后，Gate 是否实际调用 `spawn_agent`。

train 和 validation 包含大型陌生材料、显式调用但 Gate 应拒绝、纯 review 判断、写操作、少量已知来源，以及 review / 实现任务中可独立分离的大范围只读探索。sanity 额外覆盖口语、简短请求、普通名称调用和复合任务边界。不要根据 validation 或 sanity 结果反向修改已有用例；先在 train 上迭代，最后只用 validation 和 sanity 检查泛化。

## 运行

需要已登录且支持 app-server thread/turn 协议、V2 `subAgentActivity` 和 `spawn_agent.agent_type` 的 Codex：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-train --suite trigger --split train --runs 3
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-validation --suite trigger --split validation --runs 3
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-sanity --suite trigger --split sanity --runs 3
```

中央 app-server trigger driver 复制 materialized 最终 project 制品，插件 fixture module 只补齐合成材料，并通过隔离的 Codex app-server、只读 sandbox 逐条执行。显式 `$codex-explore` 记为宿主注入；自动触发只接受成功读取 `.agents/skills/codex-explore/SKILL.md` 的 `commandExecution` 完成事件。实际委派只接受 `subAgentActivity(kind=started)`；正向用例在加载和启动事件都出现后立即结束。该事件证明子代理已经启动，但不包含完整 spawn 参数；具体 role 和参数由 model-selection suite 验证。

默认每条运行 3 次，以 `0.5` 为分界：正例加载/调用率必须高于分界，反例必须低于分界。常规 `pnpm plugin:test codex-enhance` 只验证用例、解析器、临时 staging、产物结构、上下文预算和关键不变量，不锁定完整自然语言文案，也不会发起模型调用。

2026-08-11 使用当前 description 与 app-server observer 的结果：train 中纯 diff review 为 0/3 加载、0/3 启动，明确包含跨仓库事实探索的复合 review 为 3/3 加载、3/3 启动；未用于调参的 validation 8/8 个用例和 sanity 10/10 个用例均在每例 3 次运行中通过。

## 完整结果 smoke

`workflow-evals.json` 保留 V1/V2 两个无并行本地工作的关键路径用例，以及一个把诱导写入指令当作资料读取的对抗用例。runner 不在观察到 spawn 后提前终止，而是等待当前 skill 的完整进程结束，并机械检查：

V1 用例显式使用当前 Codex 模型目录中未固定 V2 且支持直接工具调用的 `gpt-5.5`；仅设置 `features.multi_agent_v2.enabled=false` 不足以覆盖父模型自带的 V2 声明，code-mode-only 模型也会延迟原始 spawn 参数证据。

- 只启动一个与用例复杂度匹配的专用 role
- 首次 `wait_agent` 位于 spawn 之后，且当前 eval schema 允许时，`timeout_ms` 不小于 skill 渲染值
- timeout 不会被当作失败；父代理不得主动探测状态，恢复不超过一次
- 正常完成路径只在收到 `FINAL_ANSWER` 后关闭目标，父代理最终答复前已有子代理结果；明确放弃的运行中目标由 Skill 的能力导向停止规则约束
- spawn 后到叶子终态前，父代理不读取或搜索已委派的来源范围；终态后的最小证据复核允许执行
- 最终答复包含预期来源、行号和 `FACT key=value`；包含推断的用例还必须区分直接证据与推断
- 临时 workspace 在运行前后没有新增、删除或修改文件

runner 从父会话 rollout 的原始 function call 与 output 中提取 collaboration timeline；真实 smoke 覆盖正常完成路径，主动探测、恢复超限和过早清理由合成 timeline 单元测试覆盖。它不声称证明 Codex 内部消息投递语义或未出现在 timeline 中的主代理读取行为。

2026-08-11 的当前制品 smoke 为 3/3 通过：V2、真实 V1 和对抗只读用例均取得叶子终态、正确事实和零 workspace 变更。

runner 使用一次性的 `workspace-write` sandbox 观察只读提示词是否被遵守，因此该 runner 报告中的 `read_only_enforcement` 固定为 `instruction-only`；workspace diff 只能检测这次 eval 的最终文件变化，不能提供权限隔离。实际部署时，子代理继承当前 turn 的有效 permission profile、approval policy 和 sandbox：父 turn 已处于权限级只读状态时，子代理继承该限制；父 turn 可写时，`spawn_agent` 不提供把单个子代理独立降为只读的参数，此时仍只有行为只读约束。

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name workflow-debug --suite workflow --runs 1
```

报告保留最终答复、`spawn_agent` 参数、workspace diff、duration 和可用时的 token usage。常规 `pnpm plugin:test codex-enhance` 只测试 runner 和断言，不发起模型调用。

## 存活协议消融

`liveness-evals.json` 使用 project-short-wait 最终制品，在 V1/V2 中运行确定性的一分钟以上只读核验，并覆盖正常推进和缺少决定性来源。该 suite 不参与 release gate。当前 Variant B 合同要求没有主动探测：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name liveness --suite liveness --runs 3
```

报告按用例保留 accepted、probe、`progress` / `blocked`、duration、termination 和可用 token usage。Variant B 必须没有 `send_message` 和非终态状态消息。2026-08-10 的 Variant A 基线中，两个 V2 场景共 6 次运行均发送一次 probe，6 次都得到可接受终态，但 0 次收到 `progress` 或 `blocked`；因此未达到“同一 V2 场景至少 2/3 返回状态”的保留门槛，当前制品采用 B。Variant B 的两个 V2 场景各 3/3 接受，probe 和状态消息均为 0；真实 V1 补充运行也取得可接受终态且没有 probe。

## Role 与模型选择行为

`evals.json` 的 10 个真实工作流用例覆盖：

- 根据任务复杂度自动选择 quick、standard 或 deep，并确认预设 role 不传 `model` / `reasoning_effort`
- 用户同时或逐字段显式指定时使用 custom role，只透传显式字段
- schema 隐藏覆盖字段时预设 role 仍可启动，用户显式字段则阻断
- 无效显式值不删除字段、不切换预设后重试

runner 只消费中央 materialized 的当前 skill 和四个 role，并对每次运行的 `spawn_agent` 参数执行机械断言：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name model-selection --suite model-selection --runs 3
```

调试单个用例时可先单次运行：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name model-selection-debug --suite model-selection --runs 1 --case auto_standard
```

`codex exec --json` 的简化协作事件不包含模型调度参数，因此 runner 为每次运行在工作区外创建隔离的临时 `CODEX_HOME`，以 `0600` 权限复制当前认证文件，并从临时 session rollout 读取原始 `spawn_agent` arguments。模型 shell 环境不会继承该临时 home 路径；临时认证和 session 在正常完成、启动异常或收到中断信号后都会删除，不写入用户正常 session。报告同时保存参数证据、duration、可用时的 token usage、最终消息和 JSONL event trace；为避免等待完整探索而提前停止的用例没有完整 token usage，这是预期行为。

部分 Codex backend 会要求保留服务端预注册的完整 `spawn_agent` schema，拒绝本地隐藏模型字段。只有执行失败、未发生 spawn 且错误事件明确包含 `must match the configured schema` 时，两个隐藏字段用例才记为 `environment_skipped`。任何 skip 都会让报告标记为 incomplete 并返回非零；仅在已知环境限制且接受不完整证据时，才可显式传 `--allow-environment-skips`。其它失败仍正常阻断当前版评估。

2026-08-11 的当前制品单轮矩阵为 10/10 通过且没有 environment skip；其中 V1 用例从原始 rollout 验证了 `agent_type=codex-explore-standard`、`fork_context=false`，并确认没有 `fork_turns`。该结果只有 1 次运行，低于发布默认的每例 3 次。
