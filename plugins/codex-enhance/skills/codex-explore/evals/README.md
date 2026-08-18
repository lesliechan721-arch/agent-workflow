# Codex Explore Eval

该 manifest 覆盖 default/non-default 和 project/user 最终制品；模型用例位于 project-default：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name materialization --materialize-only
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-validation-debug --suite trigger --split validation --runs 1
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name release
```

## 触发与 Gate

20 个固定用例分成 train（13）和 validation（7），另有 10 个不参与 description 优化的 sanity 用例，同时评测：

- `should_load_skill`：Codex 是否加载 `codex-explore`。
- `should_spawn_agent`：Skill 加载后，Gate 是否实际调用 `spawn_agent`。

train 和 validation 包含大型陌生材料、显式调用但 Gate 应拒绝、少量已知来源，以及由主代理隐式或按用户提示从 review / 实现任务中分离的大范围只读探索。review 正向用例会明确把 diff 作为入口，并要求跨陌生模块追踪定义、调用点或数据流；最终缺陷判定和修改建议仍由主代理负责。sanity 额外覆盖口语、简短请求、普通名称调用和复合任务边界。

不要根据 validation 或 sanity 结果反向修改已有用例；先在 train 上迭代，最后只用 validation 和 sanity 检查泛化。

### 运行

trigger suite 要求 Codex 支持 app-server thread/turn 协议、V2 `subAgentActivity` 和 `spawn_agent.agent_type`：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-train --suite trigger --split train --runs 3
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-validation --suite trigger --split validation --runs 3
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name trigger-sanity --suite trigger --split sanity --runs 3
```

fixture module 只补齐合成材料。显式 `$codex-explore` 记为宿主注入；自动触发只接受成功读取 `.agents/skills/codex-explore/SKILL.md` 的 `commandExecution` 完成事件。实际委派只接受 `subAgentActivity(kind=started)`；正向用例在加载和启动事件都出现后立即结束。该事件证明子代理已经启动，但不包含完整 spawn 参数；具体 role 和参数由 model-selection suite 验证。

默认每条运行 3 次。正例加载/调用率必须高于 `0.5`；validation 和 sanity 负例采用零容忍，任意一次误加载或错误委派都会失败。

2026-08-11 的旧合同曾把纯 diff review 设为不加载负例。当前合同不再用含糊的“真实 bug”措辞推导大范围探索：正向 diff case 必须明确要求以 diff 为入口跨陌生模块核对定义、调用点和数据流，再由主代理完成 review 判断。

## 完整结果 smoke

workflow suite 保留 V1/V2 两个无并行本地工作的关键路径用例，以及一个把诱导写入指令当作资料读取的对抗用例。runner 不在观察到 spawn 后提前终止，而是等待当前 Skill 的完整进程结束，并机械检查：

- 只启动一个与用例复杂度匹配的专用 role。
- 首次 `wait_agent` 位于 spawn 之后，且当前 eval schema 允许时，`timeout_ms` 不小于 Skill 渲染值。
- timeout 不会被当作失败；父代理不得主动探测状态，恢复不超过一次。
- 正常完成路径只在收到 `FINAL_ANSWER` 后关闭目标，父代理最终答复前已有子代理结果。
- spawn 后到叶子终态前，父代理不读取或搜索已委派的来源范围；终态后的最小证据复核允许执行。
- 最终答复包含预期来源、行号和 `FACT key=value`；包含推断的用例还必须区分直接证据与推断。
- 临时 workspace 在运行前后没有新增、删除或修改文件。

V1 用例显式使用支持直接工具调用且未固定 V2 的父模型；只设置 `features.multi_agent_v2.enabled=false` 不足以覆盖父模型自带的 V2 声明。

runner 从父会话 rollout 的原始 function call 与 output 中提取 collaboration timeline。真实 smoke 覆盖正常完成路径；主动探测、恢复超限和过早清理由合成 timeline 单元测试覆盖。它不声称证明 Codex 内部消息投递语义或未出现在 timeline 中的主代理读取行为。

该 runner 使用 `workspace-write` 观察只读提示词是否被遵守，因此报告中的 `read_only_enforcement` 固定为 `instruction-only`；workspace diff 只证明本次 eval 的最终文件没有变化，不证明权限隔离。

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name workflow-debug --suite workflow --runs 1
```

## 存活协议消融

`liveness-evals.json` 使用 project-short-wait 最终制品，在 V1/V2 中运行一分钟以上的只读核验，并覆盖正常推进和缺少决定性来源。

该 suite 的权威级别是 **diagnostic-only**：

- `requiredForRelease=false`，不参与发布门禁。
- 用例用于比较“主动探测”与“仅响应式等待”的机制差异。
- 结果可为设计讨论提供诊断证据，但不得单独驱动生产 Skill 修改；重新改变等待协议前，仍需有效 case admission、同族回归和当前 runtime 证据。

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name liveness --suite liveness --runs 3
```

报告按用例保留 accepted、probe、`progress` / `blocked`、duration、termination 和可用 token usage。叶子工具证据只接受 child rollout 与父 thread 的直接关联；child rollout 不可用时用例保持 `incomplete`，不按文件归属或最终文案推断。

2026-08-10 的 Variant A 基线中，两个 V2 场景共 6 次运行均发送一次 probe，6 次都得到可接受终态，但 0 次收到 `progress` 或 `blocked`，未达到保留门槛。Variant B 的两个 V2 场景各 3/3 接受，probe 和状态消息均为 0；真实 V1 补充运行也取得可接受终态且没有 probe。该历史结果解释当前 Variant B 的来源，但不替代当前版本发布评估。

## Role 与模型选择行为

`evals.json` 的真实工作流用例覆盖：

- 根据任务复杂度自动选择 quick、standard 或 deep，并确认预设 role 不传 `model` / `reasoning_effort`。
- 用户同时或逐字段显式指定时使用 custom role，只透传显式字段。
- schema 隐藏覆盖字段时预设 role 仍可启动，用户显式字段则阻断。
- 无效显式值不删除字段、不切换预设后重试。

runner 对每次运行的原始 `spawn_agent` 参数执行机械断言：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name model-selection --suite model-selection --runs 3
```

调试单个用例：

```bash
pnpm plugin:eval codex-enhance --skill codex-explore --batch-name model-selection-debug --suite model-selection --runs 1 --case auto_standard
```

部分 backend 会要求保留服务端预注册的完整 `spawn_agent` schema，拒绝本地隐藏模型字段。只有执行失败、未发生 spawn 且错误事件明确包含 `must match the configured schema` 时，隐藏字段用例才记为 `environment_skipped`；其它失败仍正常阻断评估。
